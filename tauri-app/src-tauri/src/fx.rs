//! Native FX gain/loss audit engine.
//!
//! Calculations, validation and rate normalization intentionally live here:
//! neither the UI nor the LLM is trusted for arithmetic or classification.
use crate::ledger_mapping;
use crate::{AppError, excel_merger::PauseCheckpoint, tabular};
use calamine::{Data, DataType, Reader, open_workbook_auto};
use chrono::{Datelike, Duration, NaiveDate, Utc};
use directories::ProjectDirs;
use reqwest::blocking::Client;
use rust_xlsxwriter::{
    DataValidation, Format, FormatAlign, Formula, Workbook, Worksheet, XlsxError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration as StdDuration,
};

const SAFE_URL: &str = "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do";
const RATE_SOURCE: &str = "国家外汇管理局人民币汇率中间价查询（数据由中国外汇交易中心公布）";
static FX_PREVIEW_CACHE: OnceLock<Mutex<Option<(String, Value)>>> = OnceLock::new();
static FX_TABLE_CACHE: OnceLock<Mutex<HashMap<String, Arc<FxTable>>>> = OnceLock::new();
static FX_INSPECTION_CACHE: OnceLock<Mutex<HashMap<String, Arc<FxTable>>>> = OnceLock::new();
static FX_RATE_INDEX: OnceLock<Mutex<Option<(String, HashMap<(String, String), RatePoint>)>>> =
    OnceLock::new();

thread_local! {
    /// A worker handles one FX job and exits. Keep derived tables only for that
    /// job so every calculation stage can share the same forward-filled JE,
    /// then release it before the process terminates. Synchronous inspect and
    /// validation calls in the long-lived app process never enter this cache.
    static FX_JOB_TABLE_CACHE: RefCell<Option<HashMap<String, Arc<FxTable>>>> = const {
        RefCell::new(None)
    };
}

struct FxJobTableCacheGuard;

impl FxJobTableCacheGuard {
    fn begin() -> Self {
        FX_JOB_TABLE_CACHE.with(|cache| *cache.borrow_mut() = Some(HashMap::new()));
        Self
    }
}

impl Drop for FxJobTableCacheGuard {
    fn drop(&mut self) {
        FX_JOB_TABLE_CACHE.with(|cache| *cache.borrow_mut() = None);
    }
}

fn cached_job_table(key: &str) -> Option<Arc<FxTable>> {
    FX_JOB_TABLE_CACHE.with(|cache| {
        cache
            .borrow()
            .as_ref()
            .and_then(|tables| tables.get(key).cloned())
    })
}

fn store_job_table(key: String, table: &Arc<FxTable>) {
    FX_JOB_TABLE_CACHE.with(|cache| {
        if let Some(tables) = cache.borrow_mut().as_mut() {
            tables.insert(key, Arc::clone(table));
        }
    });
}

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

fn preview_cache_key(params: &Value) -> String {
    let mut normalized = params.clone();
    if let Some(object) = normalized.as_object_mut() {
        // These fields are outputs or export-only destinations.  They do not
        // change the accounting calculation represented by a preview.
        for key in [
            "outputPath",
            "previewToken",
            "rateSnapshot",
            "accountTranslations",
        ] {
            object.remove(key);
        }
    }
    let bytes = serde_json::to_vec(&normalized).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

fn preview_cache_dir() -> Option<PathBuf> {
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")?;
    let path = dirs.cache_dir().join("fx_preview");
    fs::create_dir_all(&path).ok()?;
    Some(path)
}

fn preview_cache_file(token: &str) -> Option<PathBuf> {
    // token 只能来自本模块生成的 SHA-256，拒绝把外部字符串拼进路径。
    (token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| preview_cache_dir().map(|dir| dir.join(format!("{token}.json"))))
        .flatten()
}

fn cleanup_preview_cache(dir: &Path) {
    let stale_after = StdDuration::from_secs(24 * 60 * 60);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > stale_after);
        if stale {
            let _ = fs::remove_file(path);
        }
    }
}

fn cached_preview(token: &str) -> Option<Value> {
    let memory = FX_PREVIEW_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .as_ref()
                .filter(|(cached_token, _)| cached_token == token)
                .map(|(_, result)| result.clone())
        });
    if memory.is_some() {
        return memory;
    }
    // 预览和导出各自由一个独立 worker 进程执行，进程内静态缓存无法跨点击
    // 复用。把完整结果按输入指纹落到本机缓存，导出 worker 才能真正跳过重算。
    let bytes = fs::read(preview_cache_file(token)?).ok()?;
    let result = serde_json::from_slice::<Value>(&bytes).ok()?;
    if let Ok(mut cache) = FX_PREVIEW_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = Some((token.to_owned(), result.clone()));
    }
    Some(result)
}

fn store_preview(token: String, result: Value) {
    if let Ok(mut cache) = FX_PREVIEW_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = Some((token.clone(), result.clone()));
    }
    let Some(path) = preview_cache_file(&token) else {
        return;
    };
    if let Some(dir) = path.parent() {
        cleanup_preview_cache(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = fs::write(path, bytes);
    }
}

fn fx_table_cache_key(source: &SourceSpec, path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!(
        "{}|{}|{}|{}|{}|{}",
        path.to_string_lossy(),
        source.sheet,
        source.header_row,
        source.header_depth,
        metadata.len(),
        modified.as_nanos()
    ))
}

fn cached_fx_table(key: &str) -> Option<Arc<FxTable>> {
    FX_TABLE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(key).cloned())
}

fn store_fx_table(key: Option<String>, table: &Arc<FxTable>) {
    let Some(key) = key else { return };
    if let Ok(mut cache) = FX_TABLE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        if cache.len() >= 8 && !cache.contains_key(&key) {
            cache.clear();
        }
        cache.insert(key, Arc::clone(table));
    }
}

// SourceSpec/FxTable/load_fx_table/classify_source are shared with the deposit
// interest tool so both tools detect sheets, header rows and JE-vs-TB kind with
// exactly the same rules; only the role dictionaries differ per tool.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceSpec {
    pub(crate) input_path: String,
    #[serde(default)]
    pub(crate) sheet: String,
    #[serde(default)]
    pub(crate) header_row: usize,
    #[serde(default)]
    pub(crate) header_depth: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct FxTable {
    pub(crate) path: PathBuf,
    pub(crate) sheet: String,
    pub(crate) sheets: Vec<String>,
    pub(crate) header_row: usize,
    pub(crate) header_depth: usize,
    pub(crate) raw_headers: Vec<Vec<String>>,
    pub(crate) headers: Vec<String>,
    pub(crate) rows: Vec<Vec<String>>,
    pub(crate) row_count: usize,
    pub(crate) header_candidates: Vec<(usize, f64)>,
    /// 大文件只解析了开头若干行。基于样本的推断（例如取最大日期当资产负债表日）
    /// 在这种表上不成立，必须交给用户确认。
    pub(crate) sampled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RatePoint {
    requested_date: String,
    published_date: String,
    currency: String,
    cny_per_unit: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateSnapshot {
    source: String,
    source_url: String,
    fetched_at: String,
    response_hash: String,
    start_date: String,
    end_date: String,
    rates: Vec<RatePoint>,
    #[serde(default)]
    missing: Vec<String>,
}

#[derive(Clone, Debug)]
/// 一行序时账／余额表，**借用**原表的表头与单元格，不复制。
///
/// 36 万行 × 46 列的 SAP 序时账，逐行克隆成 `HashMap<String,String>` 要上千万次
/// 堆分配；而测算过程里 `records()` 会被反复调用好几遍。借用之后这部分开销归零。
pub(crate) struct RowRecord<'a> {
    source_row: usize,
    header_index: Rc<HashMap<&'a str, usize>>,
    row: &'a [String],
}

impl<'a> RowRecord<'a> {
    fn get(&self, header: &str) -> Option<&'a str> {
        self.header_index
            .get(header)
            .and_then(|index| self.row.get(*index))
            .map(String::as_str)
    }

    fn iter(&self) -> impl Iterator<Item = (&'a str, &'a str)> + '_ {
        self.header_index.iter().filter_map(|(header, index)| {
            self.row.get(*index).map(|value| (*header, value.as_str()))
        })
    }
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fx.classify_source" => classify_source(&params),
        "fx.inspect_je" => inspect(&params, "je"),
        "fx.inspect_tb" => inspect(&params, "tb"),
        "fx.validate_mapping" => validate_mapping(&params),
        "fx.check_mapping_alignment" => check_mapping_alignment(&params),
        "fx.account_roles" => account_roles(&params),
        "fx.entities" => entities(&params),
        "fx.rate_status" => rate_status(&params),
        "fx.import_classifications" => import_classifications(&params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到汇兑损益业务方法。",
            Some(method.into()),
        )),
    }
}

fn import_classifications(params: &Value) -> Result<Value, AppError> {
    let path = params
        .get("inputPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error("INVALID_PARAMS", "请选择包含分类调整页的Excel底稿。", None))?;
    let range = if crate::spreadsheet_input::is_text(Path::new(path)) {
        crate::spreadsheet_input::text_range(Path::new(path))?
    } else {
        let mut book = open_workbook_auto(path).map_err(|e| {
            error(
                "SOURCE_READ_FAILED",
                "无法读取分类调整底稿。",
                Some(e.to_string()),
            )
        })?;
        // 新版底稿将面向用户的页签改为“分类复核”；继续兼容历史底稿的
        // “分类调整”，避免用户以前导出的文件无法导回。
        let sheet_name = if book.sheet_names().iter().any(|name| name == "分类复核") {
            "分类复核"
        } else {
            "分类调整"
        };
        book.worksheet_range(sheet_name).map_err(|e| {
            error(
                "SOURCE_READ_FAILED",
                "Excel中未找到“分类复核”或历史“分类调整”页。",
                Some(e.to_string()),
            )
        })?
    };
    let mut rows = range.rows();
    let headers = rows
        .next()
        .map(|row| row.iter().map(data_text).collect::<Vec<_>>())
        .ok_or_else(|| error("SOURCE_READ_FAILED", "分类复核页为空。", None))?;
    let column = |name: &str| {
        headers
            .iter()
            .position(|header| header.trim() == name)
            .ok_or_else(|| {
                error(
                    "SOURCE_READ_FAILED",
                    format!("分类复核页缺少“{name}”列。"),
                    None,
                )
            })
    };
    let classification_column = headers
        .iter()
        .position(|header| header.trim() == "用户确认分类")
        .or_else(|| {
            headers
                .iter()
                .position(|header| header.trim() == "用户调整分类")
        })
        .ok_or_else(|| {
            error(
                "SOURCE_READ_FAILED",
                "分类复核页缺少“用户确认分类”列。",
                None,
            )
        })?;
    let voucher_ids_column = column("_凭证ID清单")?;
    let mut classifications = Map::new();
    for row in rows {
        let classification = row
            .get(classification_column)
            .map(data_text)
            .unwrap_or_default();
        if !matches!(classification.as_str(), "已实现汇兑损益" | "未实现汇兑损益") {
            // 「待确认」已废止：分类只有二元值，历史分类表里的「待确认」
            // 行导入时忽略，凭证由结构自动归类。
            continue;
        }
        let ids = row
            .get(voucher_ids_column)
            .map(data_text)
            .unwrap_or_default();
        for id in ids.lines().map(str::trim).filter(|id| !id.is_empty()) {
            classifications.insert(id.to_owned(), json!(classification));
        }
    }
    Ok(json!({
        "manualClassifications": classifications,
        "voucherCount": classifications.len()
    }))
}

pub(crate) fn classify_source(params: &Value) -> Result<Value, AppError> {
    let source: SourceSpec = serde_json::from_value(
        params
            .get("source")
            .cloned()
            .unwrap_or_else(|| params.clone()),
    )
    .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_fx_inspection_table(&source)?;
    let je = suggest_mappings(&table, "je");
    let tb = suggest_mappings(&table, "tb");
    let mapped = |candidates: &BTreeMap<String, Vec<Candidate>>, role: &str, threshold: f64| {
        candidates
            .get(role)
            .and_then(|values| values.first())
            .is_some_and(|value| value.1 >= threshold)
    };
    let mapped_any =
        |candidates: &BTreeMap<String, Vec<Candidate>>, roles: &[&str], threshold: f64| {
            roles.iter().any(|role| mapped(candidates, role, threshold))
        };
    let mapped_pair = |candidates: &BTreeMap<String, Vec<Candidate>>,
                       debit: &str,
                       credit: &str,
                       threshold: f64| {
        mapped(candidates, debit, threshold) && mapped(candidates, credit, threshold)
    };
    let normalized = table
        .headers
        .iter()
        .map(|value| normalize_header(value))
        .collect::<Vec<_>>();
    let header_has = |terms: &[&str]| {
        normalized.iter().any(|header| {
            terms
                .iter()
                .any(|term| header.contains(&normalize_header(term)))
        })
    };
    let mut je_score = 0.0;
    let mut tb_score = 0.0;
    let mut je_reasons = Vec::new();
    let mut tb_reasons = Vec::new();
    for (role, weight, label) in [
        ("id", 3.0, "凭证号"),
        ("date", 3.0, "记账日期"),
        ("accountCode", 2.0, "科目"),
    ] {
        if mapped(&je, role, 0.55) {
            je_score += weight;
            je_reasons.push(label);
        }
    }
    if mapped(&je, "foreignAmount", 0.55) || mapped_pair(&je, "foreignDebit", "foreignCredit", 0.55)
    {
        je_score += 2.0;
        je_reasons.push("原币发生额");
    }
    if mapped(&je, "functionalAmount", 0.55)
        || mapped_pair(&je, "functionalDebit", "functionalCredit", 0.55)
    {
        je_score += 2.0;
        je_reasons.push("本位币发生额");
    }
    if header_has(&["document type", "凭证类型", "voucher type"]) {
        je_score += 1.0;
        je_reasons.push("凭证类型");
    }
    for (role, weight, label) in [
        ("accountCode", 2.0, "科目"),
        ("entity", 1.0, "公司"),
        ("currency", 1.0, "币种"),
    ] {
        if mapped(&tb, role, 0.55) {
            tb_score += weight;
            tb_reasons.push(label);
        }
    }
    let closing_balance =
        mapped_any(
            &tb,
            &["closingFunctionalAmount", "closingForeignAmount"],
            0.55,
        ) || mapped_pair(
            &tb,
            "closingFunctionalDebit",
            "closingFunctionalCredit",
            0.55,
        ) || mapped_pair(&tb, "closingForeignDebit", "closingForeignCredit", 0.55);
    if closing_balance {
        tb_score += 3.0;
        tb_reasons.push("期末余额");
    }
    let opening_balance =
        mapped_any(
            &tb,
            &["openingFunctionalAmount", "openingForeignAmount"],
            0.55,
        ) || mapped_pair(
            &tb,
            "openingFunctionalDebit",
            "openingFunctionalCredit",
            0.55,
        ) || mapped_pair(&tb, "openingForeignDebit", "openingForeignCredit", 0.55);
    if opening_balance {
        tb_score += 2.0;
        tb_reasons.push("期初余额");
    }
    let balance_movement = mapped_pair(&tb, "ytdFunctionalDebit", "ytdFunctionalCredit", 0.55)
        || mapped_pair(&tb, "periodFunctionalDebit", "periodFunctionalCredit", 0.55);
    if balance_movement {
        tb_score += 2.0;
        tb_reasons.push("余额表发生额");
    }
    let tb_header_signature = header_has(&[
        "ytd",
        "trial balance",
        "期末余额",
        "期末借方",
        "期末贷方",
        "年末余额",
        "科目余额",
        "期初借方",
        "期初贷方",
    ]);
    if tb_header_signature {
        tb_score += 2.0;
        tb_reasons.push("余额表特征");
    }
    // 平分时不再无条件偏向 JE：只要存在期初/期末/累计发生额等余额表
    // 结构，就应归 TB；这正是存款利息过去把各种 TB 都吞进 JE 槽的根因。
    let prefer_tb = tb_score > je_score
        || (tb_score == je_score
            && (opening_balance || closing_balance || balance_movement || tb_header_signature));
    let (kind, confidence, reasons) = if !prefer_tb {
        (
            "je",
            if je_score == 0.0 {
                0.0
            } else {
                (je_score / 13.0_f64).min(1.0)
            },
            je_reasons,
        )
    } else {
        (
            "tb",
            if tb_score == 0.0 {
                0.0
            } else {
                (tb_score / 11.0_f64).min(1.0)
            },
            tb_reasons,
        )
    };
    let needs_llm = je_score.max(tb_score) < 5.0 || (je_score - tb_score).abs() < 2.0;
    Ok(json!({
        "kind": kind, "confidence": confidence, "needsLlm": needs_llm,
        "scores": {"je": je_score, "tb": tb_score}, "reasons": reasons,
        "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headerRow": table.header_row, "headerDepth": table.header_depth,
        "headers": table.headers, "preview": table.rows.iter().take(8).collect::<Vec<_>>()
    }))
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    // Preview/export call many helpers that historically re-created the same
    // cleaned JE. Scope this cache to the single worker request.
    let _table_cache = FxJobTableCacheGuard::begin();
    checkpoint(&cancel, pause)?;
    match method {
        "fx.fetch_rates" => {
            progress("rates", 0, 2, "正在从官方来源获取人民币汇率中间价…");
            let snapshot = obtain_rates(&params)?;
            progress("rates", 2, 2, "汇率快照已锁定。");
            Ok(json!({"rateSnapshot": snapshot, "missing": snapshot.missing}))
        }
        "fx.preview" => {
            let token = preview_cache_key(&params);
            let mut params = params;
            if prepare_large_je_table(&params, progress, &cancel, pause)? {
                params["__largeJeDiskMode"] = Value::Bool(true);
            }
            detect_and_inject_sign_conventions(&mut params)?;
            let mut result = calculate(&params, progress, &cancel, pause)?;
            if let Some(object) = result.as_object_mut() {
                object.insert("previewToken".into(), Value::String(token.clone()));
            }
            store_preview(token, result.clone());
            // The full source/classification arrays are retained in the native cache for
            // export. The preview UI consumes the compact controls and voucher detail, so
            // avoid serializing tens of thousands of unused rows across the Tauri bridge.
            if let Some(object) = result.as_object_mut() {
                object.remove("jeDetail");
                object.remove("classification");
                object.remove("voucherDetail");
                object.remove("realized");
                object.remove("unrealized");
                object.remove("unrealizedComparison");
                object.remove("pendingReview");
                object.remove("rateSnapshot");
                object.insert("previewDataOmitted".into(), Value::Bool(true));
            }
            Ok(result)
        }
        "fx.export" => {
            let mut export_params = params;
            if let Some(object) = export_params.as_object_mut() {
                object.insert("translateTbAccountNames".into(), Value::Bool(true));
            }
            let expected_token = preview_cache_key(&export_params);
            let supplied_token = export_params
                .get("previewToken")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let cached = (supplied_token == expected_token)
                .then(|| cached_preview(supplied_token))
                .flatten();
            let mut result = if let Some(result) = cached {
                // 缓存内已经包含符号口径检测后的完整测算结果。此处不再读取 JE
                // 或重复检测，否则用户点击导出仍要白等一次完整预处理。
                progress("reuse_preview", 3, 5, "正在复用已完成的测算预览结果…");
                result
            } else {
                progress(
                    "calculate",
                    1,
                    5,
                    if supplied_token == expected_token {
                        "测算预览缓存已失效，正在重新执行汇兑损益测算…"
                    } else {
                        "数据或参数已发生变化，正在重新执行汇兑损益测算…"
                    },
                );
                // 直接导出或缓存失效时仍须检测符号口径。「已带符号」账簿
                // 漏检会导致金额正负翻转。token 在注入前计算，保持缓存键稳定。
                if prepare_large_je_table(&export_params, progress, &cancel, pause)? {
                    export_params["__largeJeDiskMode"] = Value::Bool(true);
                }
                detect_and_inject_sign_conventions(&mut export_params)?;
                calculate(&export_params, progress, &cancel, pause)?
            };
            checkpoint(&cancel, pause)?;
            // 明细在测算阶段被跳过了（预览用不上），落表前补算。
            if result
                .get("jeDetail")
                .and_then(Value::as_array)
                .is_none_or(|all| all.is_empty())
            {
                if result
                    .get("largeJeDiskMode")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| je_uses_disk(&export_params))
                {
                    // 超大 JE 往往超过 Excel 单 Sheet 1048576 行上限；把整份原始
                    // JE 再塞进 JSON/工作簿会抵消磁盘模式并重新耗尽内存。底稿保留
                    // 来源指纹、测算结果和相关凭证明细，完整源文件仍作为审计证据。
                    progress(
                        "export",
                        3,
                        5,
                        "超大 JE 保留原文件引用，正在整理测算结果与相关凭证明细…",
                    );
                    if let Some(object) = result.as_object_mut() {
                        object.insert("jeDetail".into(), Value::Array(Vec::new()));
                        object.insert("jeDetailOmittedForLargeSource".into(), Value::Bool(true));
                        if let Some(items) = object
                            .entry("dataQuality")
                            .or_insert_with(|| Value::Array(Vec::new()))
                            .as_array_mut()
                        {
                            items.push(json!({
                                "source":"JE",
                                "type":"超大源文件未嵌入完整JE明细",
                                "severity":"提示",
                                "detail":"底稿保留测算结果、相关凭证明细和源文件引用；完整JE请以原始CSV作为审计证据。"
                            }));
                        }
                    }
                } else {
                    progress("export", 3, 5, "正在整理JE完整明细…");
                    let detail = build_je_detail(&export_params)?;
                    if let Some(object) = result.as_object_mut() {
                        object.insert("jeDetail".into(), Value::Array(detail));
                    }
                }
            }
            checkpoint(&cancel, pause)?;
            progress("export", 4, 5, "正在生成汇兑损益审计底稿…");
            let output = export_workbook(&export_params, &result)?;
            progress("export", 5, 5, "审计底稿已生成。");
            Ok(json!({
                "outputPaths": [output],
                "summary": result.get("summary"),
                "dataQuality": result.get("dataQuality"),
                "rateSnapshot": result.get("rateSnapshot")
            }))
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到汇兑损益任务方法。",
            Some(method.into()),
        )),
    }
}

fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()?;
    crate::resource_budget::check_available_if_managed()
}

fn inspect(params: &Value, kind: &str) -> Result<Value, AppError> {
    let source: SourceSpec = serde_json::from_value(
        params
            .get("source")
            .cloned()
            .unwrap_or_else(|| params.clone()),
    )
    .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_fx_inspection_table(&source)?;
    let normalized_headers = table
        .headers
        .iter()
        .map(|header| normalize_header(header))
        .collect::<Vec<_>>();
    let has = |words: &[&str]| {
        normalized_headers.iter().any(|header| {
            words
                .iter()
                .any(|word| header.contains(&normalize_header(word)))
        })
    };
    if kind == "je"
        && has(&["期初余额借方", "期末余额借方", "本期发生借方"])
        && !has(&["凭证号", "凭证号数", "凭证编号"])
    {
        return Err(error(
            "SOURCE_KIND_MISMATCH",
            "该文件更像TB科目余额表，请拖放到TB区域。",
            Some(table.path.display().to_string()),
        ));
    }
    if kind == "tb" && has(&["凭证号", "凭证号数", "摘要"]) && !has(&["期初余额", "期末余额"])
    {
        return Err(error(
            "SOURCE_KIND_MISMATCH",
            "该文件更像JE凭证明细，请拖放到JE区域。",
            Some(table.path.display().to_string()),
        ));
    }
    let candidates = suggest_mappings(&table, kind);
    let mapping = candidates
        .iter()
        .filter_map(|(role, values)| {
            // 可多列的角色（科目名称、凭证识别字段）收下所有高分列：
            // Oracle 的凭证键要 Batch＋JE Name 两列组合，少一列就串号。
            // auxiliary 同样多列——取数端 auxiliary_value 本来就按多列拼接，
            // SAP 导出常把供应商、客户分成两列，限单列会把另一列丢在映射面板外。
            // 它已收编进标准表并标为多列，不再需要在这里特判。
            if ledger_mapping::role_of(kind, role).is_some_and(|r| r.multi) {
                // 首选列按常规阈值收下——「凭证号码」这种靠包含命中的列
                // 达不到 0.85，但它往往是唯一的候选，漏了就没凭证键了。
                // 附加列才要求高置信度，避免把不相干的列一起卷进来。
                let columns = values
                    .iter()
                    .enumerate()
                    .filter(|(rank, candidate)| candidate.1 >= if *rank == 0 { 0.55 } else { 0.85 })
                    .map(|(_, candidate)| Value::String(candidate.0.clone()))
                    .collect::<Vec<_>>();
                (!columns.is_empty()).then(|| (role.clone(), Value::Array(columns)))
            } else {
                values
                    .first()
                    .filter(|candidate| candidate.1 >= 0.55)
                    .map(|candidate| (role.clone(), Value::String(candidate.0.clone())))
            }
        })
        .collect::<Map<_, _>>();
    // 币种列已经给出逐科目币种时，不需要再从文本里猜。
    let mut mapping = mapping;
    if kind == "tb" && mapping.contains_key("currency") {
        mapping.remove("currencyText");
    }
    refine_layout(&table, kind, &mut mapping);
    drop_column_conflicts(kind, &candidates, &mut mapping);
    fill_combined_account_column(kind, &table, &mut mapping);
    fill_account_name_from_code_alias(&table, &candidates, &mut mapping);
    pick_currency_text_column(&table, kind, &mut mapping);
    if kind == "tb" {
        promote_period_movement(&table, &mut mapping);
    }
    let foreign_currency_candidates = if kind == "tb" {
        foreign_currency_columns(&table)
            .into_iter()
            .map(|(column, currencies)| {
                let confidence = candidates
                    .get("currency")
                    .and_then(|values| values.iter().find(|candidate| candidate.0 == column))
                    .map(|candidate| candidate.1)
                    .unwrap_or(0.0);
                json!({
                    "column": column,
                    "confidence": confidence,
                    "foreignCurrencies": currencies.into_iter().collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let foreign_currency_needs_confirmation = foreign_currency_candidates.len() > 1;
    // 币种列整列同值，说明它登记的是主体本位币而不是逐科目的交易币种
    // （4800 的“货币”列整列 USD 就是这种）。把它回给前端当本位币预填值，
    // 否则用户按默认 CNY 跑下去，全表科目都会被当成外币。
    let uniform_currency = if kind == "tb" {
        first_col(&mapping, "functionalCurrency")
            .or_else(|| first_col(&mapping, "currency"))
            .and_then(|column| table.headers.iter().position(|header| header == &column))
            .and_then(|index| {
                let values = table
                    .rows
                    .iter()
                    .filter_map(|row| row.get(index))
                    .map(|value| normalize_currency(value))
                    .filter(|code| !code.is_empty())
                    .collect::<BTreeSet<_>>();
                (values.len() == 1)
                    .then(|| values.into_iter().next().unwrap_or_default())
                    .filter(|code| supported_currencies().contains(code.as_str()))
            })
    } else {
        None
    };
    let data_years = source_data_years(&table, kind, &mapping);
    let suggested_balance_sheet_date = if kind == "je" && !table.sampled {
        first_col(&mapping, "date")
            .and_then(|column| table.headers.iter().position(|header| header == &column))
            .and_then(|index| {
                table
                    .rows
                    .iter()
                    .filter_map(|row| row.get(index).and_then(|value| parse_date(value)))
                    .max()
            })
            .map(|date| date.format("%Y-%m-%d").to_string())
    } else {
        None
    };
    let close = table
        .header_candidates
        .get(1)
        .map(|x| table.header_candidates[0].1 - x.1 < 0.08)
        .unwrap_or(false);
    let accounts = distinct_for_role(&table, &candidates, "account")
        .into_iter()
        .filter(|account| !is_summary_account(account))
        .collect::<Vec<_>>();
    let account_role_suggestions = accounts
        .iter()
        .map(|account| (account.clone(), suggest_account_role(account)))
        .collect::<BTreeMap<_, _>>();
    let account_role_details = accounts
        .iter()
        .map(|account| {
            let suggestion = suggest_account_role_detail(account);
            (
                account.clone(),
                json!({
                    "role": suggestion.role,
                    "confidence": suggestion.confidence,
                    "needsConfirmation": suggestion.needs_confirmation,
                    "reason": suggestion.reason,
                    "subtype": suggestion.subtype,
                }),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let account_currency_details = detect_account_currencies(&table, &mapping);
    Ok(json!({
        "kind": kind, "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headerRow": table.header_row, "headerDepth": table.header_depth,
        "headerDetection": {
            "candidates": table.header_candidates.iter()
                .map(|x| json!({"row": x.0, "score": x.1})).collect::<Vec<_>>(),
            "needsConfirmation": close
        },
        "rawHeaders": table.raw_headers, "headers": table.headers,
        "preview": table.rows.iter().take(8).collect::<Vec<_>>(),
        "rowCount": table.row_count, "columnProfiles": column_profiles(&table),
        "mappingCandidates": candidate_json(&candidates), "suggestedMapping": mapping,
        // 当前形态（TB／JE）下引擎认识的全部角色名＋中文标签，与缺失必填提示
        // （MissingRole.label）同源，前端映射面板据此渲染角色清单与叫法。
        "roles": ledger_mapping::role_labels(kind)
            .into_iter()
            .map(|(name, label)| json!({"name": name, "label": label}))
            .collect::<Vec<_>>(),
        "formMatches": form_matches_json(kind, &mapping),
        "foreignCurrencyCandidates": foreign_currency_candidates,
        "foreignCurrencyNeedsConfirmation": foreign_currency_needs_confirmation,
        "uniformCurrency": uniform_currency,
        "sampledPreview": table.sampled,
        "entities": distinct_for_role(&table, &candidates, "entity"),
        "accounts": accounts,
        "accountRoleSuggestions": account_role_suggestions,
        "accountRoleDetails": account_role_details,
        "accountCurrencyDetails": account_currency_details,
        "currencies": distinct_for_role(&table, &candidates, "currency")
        ,"dataYears": data_years, "suggestedBalanceSheetDate": suggested_balance_sheet_date
    }))
}

/// 建议映射套进标准形态（TB 六型／JE 三型）的结果，按匹配度排序。
/// 放进 inspect 输出，让映射面板在测算之前就能看到"这张表结构完整吗、缺哪列"，
/// 不必等测算校验阶段才发现。
fn form_matches_json(kind: &str, mapping: &Map<String, Value>) -> Value {
    let mapped: HashSet<&str> = mapping
        .keys()
        .map(|key| ledger_mapping::migrate_role_name(kind, key))
        .filter(|role| !role.is_empty())
        .collect();
    json!(
        ledger_mapping::match_forms(kind, &mapped)
            .iter()
            .map(|m| {
                json!({
                    "form": m.form, "label": m.label, "complete": m.complete,
                    "missing": m.missing, "partialOptional": m.partial_optional,
                })
            })
            .collect::<Vec<_>>()
    )
}

fn source_data_years(table: &FxTable, kind: &str, mapping: &Map<String, Value>) -> Vec<i32> {
    let mut years = BTreeSet::new();
    if kind == "je" {
        if let Some(column) = first_col(mapping, "date") {
            if let Some(index) = table.headers.iter().position(|header| header == &column) {
                for row in &table.rows {
                    if let Some(date) = row.get(index).and_then(|value| parse_date(value)) {
                        years.insert(date.year());
                    }
                }
            }
        }
    } else {
        for (index, header) in table.headers.iter().enumerate() {
            if !normalize_header(header).contains("期间") {
                continue;
            }
            for value in table.rows.iter().filter_map(|row| row.get(index)) {
                for token in value.split(|c: char| !c.is_ascii_digit()) {
                    if token.len() == 4 {
                        if let Ok(year) = token.parse::<i32>() {
                            if (1900..=2200).contains(&year) {
                                years.insert(year);
                            }
                        }
                    }
                }
            }
        }
    }
    years.into_iter().collect()
}

fn xml_attribute(fragment: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    fragment
        .split_once(&marker)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(value, _)| xml_decode(value))
}

fn xml_decode(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn zip_text(path: &Path, entry: &str) -> Result<String, AppError> {
    let file = fs::File::open(path).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "无法打开工作簿。",
            Some(e.to_string()),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "工作簿压缩结构无效。",
            Some(e.to_string()),
        )
    })?;
    let mut item = archive.by_name(entry).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            format!("工作簿缺少 {entry}。"),
            Some(e.to_string()),
        )
    })?;
    let mut text = String::new();
    item.read_to_string(&mut text).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            format!("无法读取 {entry}。"),
            Some(e.to_string()),
        )
    })?;
    Ok(text)
}

fn xlsx_shared_strings(path: &Path) -> Vec<String> {
    let Ok(xml) = zip_text(path, "xl/sharedStrings.xml") else {
        return Vec::new();
    };
    xml.split("<si>")
        .skip(1)
        .filter_map(|entry| entry.split_once("</si>").map(|(value, _)| value))
        .map(|entry| {
            entry
                .split("<t")
                .skip(1)
                .filter_map(|run| run.split_once('>'))
                .filter_map(|(_, text)| text.split_once("</t>").map(|(value, _)| value))
                .map(xml_decode)
                .collect::<String>()
        })
        .collect()
}

// 大文件走的是自己拆 XML 的轻量识别路径，它不像 calamine 那样懂单元格格式，
// 于是真正的日期会以 45688 这样的序列号露出来，识别阶段既推不出资产负债表日，
// 也会让日期列的自动打分失准。这里补上样式表解析，把日期格式的数字还原成日期。
fn xlsx_builtin_format_is_date(id: usize) -> bool {
    matches!(id, 14..=22 | 27..=36 | 45..=47 | 50..=58)
}

fn xlsx_date_styles(path: &Path) -> HashSet<usize> {
    let Ok(xml) = zip_text(path, "xl/styles.xml") else {
        return HashSet::new();
    };
    let mut date_formats = HashSet::new();
    for fragment in xml.split("<numFmt ").skip(1) {
        let (Some(id), Some(code)) = (
            xml_attribute(fragment, "numFmtId").and_then(|value| value.parse::<usize>().ok()),
            xml_attribute(fragment, "formatCode"),
        ) else {
            continue;
        };
        // 去掉方括号里的区域/颜色声明，再看是否含年月日时分标记。
        let mut cleaned = String::new();
        let mut skipping = false;
        for character in xml_decode(&code).chars() {
            match character {
                '[' => skipping = true,
                ']' => skipping = false,
                value if !skipping => cleaned.push(value.to_ascii_lowercase()),
                _ => {}
            }
        }
        if cleaned.contains('y') || cleaned.contains('d') || cleaned.contains("mm") {
            date_formats.insert(id);
        }
    }
    let Some(section) = xml
        .split_once("<cellXfs")
        .and_then(|(_, rest)| rest.split_once("</cellXfs>"))
        .map(|(value, _)| value)
    else {
        return HashSet::new();
    };
    section
        .split("<xf ")
        .skip(1)
        .enumerate()
        .filter_map(|(index, fragment)| {
            let id = xml_attribute(fragment, "numFmtId")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            (xlsx_builtin_format_is_date(id) || date_formats.contains(&id)).then_some(index)
        })
        .collect()
}

fn xlsx_uses_1904_epoch(path: &Path) -> bool {
    zip_text(path, "xl/workbook.xml")
        .is_ok_and(|xml| xml.contains("date1904=\"1\"") || xml.contains("date1904=\"true\""))
}

fn excel_serial_to_text(serial: f64, epoch_1904: bool) -> Option<String> {
    let base = if epoch_1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30)?
    };
    let whole = serial.trunc();
    // 1900 日期系统把不存在的 1900-02-29 也算作一天，序列号 60 之前要补回来。
    let days = if !epoch_1904 && whole < 60.0 {
        whole as i64 + 1
    } else {
        whole as i64
    };
    let seconds = ((serial - whole) * 86400.0).round() as i64;
    base.checked_add_signed(Duration::days(days))?
        .and_hms_opt(0, 0, 0)?
        .checked_add_signed(Duration::seconds(seconds))
        .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
}

fn xlsx_sheet_entries(path: &Path) -> Result<Vec<(String, String)>, AppError> {
    let workbook = zip_text(path, "xl/workbook.xml")?;
    let rels = zip_text(path, "xl/_rels/workbook.xml.rels")?;
    let relationships = rels
        .split("<Relationship ")
        .skip(1)
        .filter_map(|fragment| {
            Some((
                xml_attribute(fragment, "Id")?,
                xml_attribute(fragment, "Target")?,
            ))
        })
        .collect::<HashMap<_, _>>();
    let sheets = workbook
        .split("<sheet ")
        .skip(1)
        .filter_map(|fragment| {
            let name = xml_attribute(fragment, "name")?;
            let relation = xml_attribute(fragment, "r:id")?;
            let target = relationships.get(&relation)?;
            let entry = if let Some(value) = target.strip_prefix("/xl/") {
                format!("xl/{value}")
            } else if target.starts_with("xl/") {
                target.clone()
            } else {
                format!("xl/{}", target.trim_start_matches('/'))
            };
            Some((name, entry))
        })
        .collect::<Vec<_>>();
    if sheets.is_empty() {
        return Err(error(
            "WORKBOOK_READ_FAILED",
            "工作簿中未找到可读取的Sheet。",
            None,
        ));
    }
    Ok(sheets)
}

fn xlsx_sheet_prefix(path: &Path, entry: &str, row_limit: usize) -> Result<String, AppError> {
    let file = fs::File::open(path).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "无法打开工作簿。",
            Some(e.to_string()),
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "工作簿压缩结构无效。",
            Some(e.to_string()),
        )
    })?;
    let mut item = archive.by_name(entry).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "无法读取工作表。",
            Some(e.to_string()),
        )
    })?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = item.read(&mut buffer).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作表数据。",
                Some(e.to_string()),
            )
        })?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(6).filter(|value| *value == b"</row>").count() >= row_limit {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn xlsx_column_index(reference: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut found = false;
    for character in reference
        .chars()
        .take_while(|value| value.is_ascii_alphabetic())
    {
        value = value * 26 + (character.to_ascii_uppercase() as usize - 'A' as usize + 1);
        found = true;
    }
    found.then_some(value - 1)
}

fn xlsx_dimension(prefix: &str) -> (usize, usize) {
    let Some(fragment) = prefix.split("<dimension ").nth(1) else {
        return (0, 0);
    };
    let Some(reference) = xml_attribute(fragment, "ref") else {
        return (0, 0);
    };
    let end = reference.split(':').next_back().unwrap_or(&reference);
    let column = xlsx_column_index(end).map(|value| value + 1).unwrap_or(0);
    let row = end
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse::<usize>()
        .unwrap_or(0);
    (row, column)
}

#[derive(Clone, Debug)]
struct XlsxSampleRow {
    /// Excel 工作表中的物理行号（1 基）。大文件轻量读取不能把缺失的空白
    /// `<row>` 压掉后再用 Vec 下标冒充行号，否则正式 Polars 读取会错一行。
    number: usize,
    cells: Vec<String>,
}

fn xlsx_sample_rows(
    prefix: &str,
    shared: &[String],
    dimension_width: usize,
    date_styles: &HashSet<usize>,
    epoch_1904: bool,
) -> Vec<XlsxSampleRow> {
    let mut rows = Vec::new();
    for fragment in prefix.split("<row ").skip(1) {
        let Some((row_xml, _)) = fragment.split_once("</row>") else {
            break;
        };
        let number = xml_attribute(fragment, "r")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| rows.last().map_or(1, |row: &XlsxSampleRow| row.number + 1));
        let mut cells = Vec::<(usize, String)>::new();
        for cell in row_xml.split("<c ").skip(1) {
            let Some((cell_xml, _)) = cell.split_once("</c>") else {
                continue;
            };
            let Some(reference) = xml_attribute(cell_xml, "r") else {
                continue;
            };
            let Some(index) = xlsx_column_index(&reference) else {
                continue;
            };
            let kind = xml_attribute(cell_xml, "t").unwrap_or_default();
            let raw = cell_xml
                .split_once("<v>")
                .and_then(|(_, value)| value.split_once("</v>"))
                .map(|(value, _)| value)
                .or_else(|| {
                    cell_xml
                        .split("<t")
                        .nth(1)
                        .and_then(|value| value.split_once('>'))
                        .and_then(|(_, value)| value.split_once("</t>"))
                        .map(|(value, _)| value)
                })
                .unwrap_or("");
            let styled_date = date_styles.contains(
                &xml_attribute(cell_xml, "s")
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(usize::MAX),
            );
            let value = if kind.is_empty() && styled_date {
                raw.parse::<f64>()
                    .ok()
                    .and_then(|serial| excel_serial_to_text(serial, epoch_1904))
                    .unwrap_or_else(|| xml_decode(raw))
            } else if kind == "s" {
                raw.parse::<usize>()
                    .ok()
                    .and_then(|value| shared.get(value))
                    .cloned()
                    .unwrap_or_default()
            } else {
                xml_decode(raw)
            };
            cells.push((index, value));
        }
        let width =
            dimension_width.max(cells.iter().map(|(index, _)| index + 1).max().unwrap_or(0));
        let mut row = vec![String::new(); width];
        for (index, value) in cells {
            row[index] = value;
        }
        rows.push(XlsxSampleRow { number, cells: row });
    }
    rows
}

/// 大文件预览直接在工作表物理行号上推断表头。
///
/// XLSX 可以完全省略整行空白的 `<row>` 节点。旧实现先把存在的节点压成 Vec，
/// 再把 Vec 下标当作 Excel 行号；第三组样例的第 5 行为空、第 6 行是表头，因而
/// 被错误回传为第 5 行。正式 Polars 读取按物理第 5 行取表头后只得到
/// `Column_1…Column_23`。这里保留稀疏行号，不靠“补空行”猜位置。
fn infer_xlsx_header_layout(all: &[XlsxSampleRow]) -> (usize, usize, Vec<(usize, f64)>) {
    let limit = all.len().min(30);
    let compact = all
        .iter()
        .take(limit)
        .map(|row| row.cells.clone())
        .collect::<Vec<_>>();
    let mut row_scores = (0..limit)
        .map(|index| {
            (
                all[index].number,
                ledger_mapping::header_row_score(&compact, index),
            )
        })
        .collect::<Vec<_>>();
    row_scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut best = row_scores
        .first()
        .map(|(row, score)| (*row, 1usize, *score))
        .unwrap_or((1, 1, 0.0));
    for index in 0..limit.saturating_sub(1) {
        // 双层表头必须是工作表中真正相邻的两行；中间缺失的空白行不能被压缩掉。
        if all[index + 1].number != all[index].number + 1 {
            continue;
        }
        let first_hits = ledger_mapping::header_semantic_hits(&compact[index]);
        let second_hits = ledger_mapping::header_semantic_hits(&compact[index + 1]);
        let combined_hits = combined_semantic_score(&compact[index], &compact[index + 1]);
        if second_hits == 0 || combined_hits <= first_hits + 2 {
            continue;
        }
        if compact[index]
            .iter()
            .filter(|cell| !cell.trim().is_empty())
            .count()
            < 2
        {
            continue;
        }
        let width = compact[index].len().max(compact[index + 1].len());
        let merged = merge_headers(&compact[index..=index + 1], width);
        let mut synthetic = vec![merged];
        if let Some(next) = compact.get(index + 2) {
            synthetic.push(next.clone());
        }
        let pair_score = ledger_mapping::header_row_score(&synthetic, 0)
            + (combined_hits.min(16) as f64 / 16.0) * 0.10;
        if pair_score > best.2 {
            best = (all[index].number, 2, pair_score);
        }
    }
    (best.0, best.1, row_scores)
}

/// 供看账等公共账表入口复用的 OOXML 轻量标题探测。
///
/// `calamine::worksheet_range` 会先物化整张工作表；对只想查看表头的调用者，
/// 直接从 zip 中流式解压到前若干个 `</row>`，可避免在正式读取前把大表完整
/// 解压一次。这里只返回标题行，正式读取仍由公共 Parquet 缓存入口完成。
pub(crate) fn lightweight_xlsx_header_row(
    path: &Path,
    requested_sheet: Option<&str>,
) -> Result<(String, usize), AppError> {
    let sheets = xlsx_sheet_entries(path)?;
    let shared = xlsx_shared_strings(path);
    let date_styles = xlsx_date_styles(path);
    let epoch_1904 = xlsx_uses_1904_epoch(path);
    let selected =
        requested_sheet.and_then(|requested| sheets.iter().find(|(name, _)| name == requested));
    let mut best: Option<(String, Vec<XlsxSampleRow>, f64)> = None;
    for (name, entry) in selected
        .into_iter()
        .chain(sheets.iter())
        .take(if selected.is_some() { 1 } else { sheets.len() })
    {
        let prefix = xlsx_sheet_prefix(path, entry, 32)?;
        let (total_rows, width) = xlsx_dimension(&prefix);
        let rows = xlsx_sample_rows(&prefix, &shared, width, &date_styles, epoch_1904);
        if rows.is_empty() {
            continue;
        }
        let compact = rows
            .iter()
            .take(30)
            .map(|row| row.cells.clone())
            .collect::<Vec<_>>();
        let header = (0..compact.len())
            .map(|index| ledger_mapping::header_row_score(&compact, index))
            .fold(0.0_f64, f64::max);
        let score = ledger_mapping::sheet_score(header, total_rows, name);
        if best.as_ref().is_none_or(|(_, _, current)| score > *current) {
            best = Some((name.clone(), rows, score));
        }
    }
    let (sheet, rows, _) =
        best.ok_or_else(|| error("WORKBOOK_EMPTY", "工作簿中没有可读取的数据Sheet。", None))?;
    Ok((sheet, infer_xlsx_header_layout(&rows).0))
}

fn load_large_xlsx_inspection(source: &SourceSpec, path: &Path) -> Result<Arc<FxTable>, AppError> {
    let sheets = xlsx_sheet_entries(path)?;
    let shared = xlsx_shared_strings(path);
    let date_styles = xlsx_date_styles(path);
    let epoch_1904 = xlsx_uses_1904_epoch(path);
    let selected = if source.sheet.trim().is_empty() {
        None
    } else {
        sheets.iter().find(|(name, _)| name == &source.sheet)
    };
    let mut best: Option<(String, Vec<XlsxSampleRow>, usize, f64)> = None;
    for (name, entry) in selected
        .into_iter()
        .chain(sheets.iter())
        .take(if selected.is_some() { 1 } else { sheets.len() })
    {
        let prefix = xlsx_sheet_prefix(path, entry, 256)?;
        let (total_rows, width) = xlsx_dimension(&prefix);
        let rows = xlsx_sample_rows(&prefix, &shared, width, &date_styles, epoch_1904);
        if rows.is_empty() {
            continue;
        }
        let compact = rows
            .iter()
            .take(30)
            .map(|row| row.cells.clone())
            .collect::<Vec<_>>();
        let header = (0..compact.len())
            .map(|index| ledger_mapping::header_row_score(&compact, index))
            .fold(0.0_f64, f64::max);
        let score = ledger_mapping::sheet_score(header, total_rows, name);
        if best.as_ref().is_none_or(|current| score > current.3) {
            best = Some((name.clone(), rows, total_rows, score));
        }
    }
    let (sheet, all, total_rows, _) =
        best.ok_or_else(|| error("SOURCE_EMPTY", "工作簿中没有可读取的数据Sheet。", None))?;
    let (auto_header_row, auto_header_depth, scored) = infer_xlsx_header_layout(&all);
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        auto_header_row
    };
    let width = all.iter().map(|row| row.cells.len()).max().unwrap_or(0);
    let inferred_depth = if source.header_row == 0 {
        auto_header_depth
    } else if all
        .iter()
        .find(|row| row.number == header_row)
        .zip(all.iter().find(|row| row.number == header_row + 1))
        .is_some_and(|(first, second)| {
            combined_semantic_score(&first.cells, &second.cells)
                > ledger_mapping::header_semantic_hits(&first.cells) + 2
        })
    {
        2
    } else {
        1
    };
    let depth = if source.header_depth == 0 {
        inferred_depth
    } else {
        source.header_depth.clamp(1, 2)
    };
    let raw_headers = (0..depth)
        .map(|offset| {
            all.iter()
                .find(|row| row.number == header_row + offset)
                .map(|row| pad(&row.cells, width))
                .unwrap_or_else(|| vec![String::new(); width])
        })
        .collect::<Vec<_>>();
    let headers = merge_headers(&raw_headers, width);
    let rows = all
        .iter()
        .filter(|row| row.number >= header_row + depth)
        .map(|row| &row.cells)
        .filter(|row| row.iter().any(|value| !value.trim().is_empty()))
        .map(|row| pad(row, width))
        .collect::<Vec<_>>();
    Ok(Arc::new(FxTable {
        path: path.to_path_buf(),
        sheet,
        sheets: sheets.into_iter().map(|(name, _)| name).collect(),
        header_row,
        header_depth: depth,
        raw_headers,
        headers,
        rows,
        row_count: total_rows.saturating_sub(header_row.saturating_sub(1) + depth),
        header_candidates: scored.into_iter().take(3).collect(),
        sampled: true,
    }))
}

fn load_fx_inspection_table(source: &SourceSpec) -> Result<Arc<FxTable>, AppError> {
    let path = PathBuf::from(&source.input_path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let large_xlsx = matches!(extension.as_str(), "xlsx" | "xlsm")
        && fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= 8 * 1024 * 1024);
    let large_text =
        crate::spreadsheet_input::is_text(&path) && tabular::disk_ledger_applies(&path);
    if !large_xlsx && !large_text {
        return load_fx_table(source);
    }
    let key = fx_table_cache_key(source, &path).map(|value| format!("inspection|{value}"));
    if let Some(table) = key.as_ref().and_then(|value| {
        FX_INSPECTION_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .ok()
            .and_then(|cache| cache.get(value).cloned())
    }) {
        return Ok(table);
    }
    let table = if large_text {
        load_large_text_inspection(source, &path)?
    } else {
        load_large_xlsx_inspection(source, &path)?
    };
    if let (Some(key), Ok(mut cache)) = (
        key,
        FX_INSPECTION_CACHE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock(),
    ) {
        if cache.len() >= 8 && !cache.contains_key(&key) {
            cache.clear();
        }
        cache.insert(key, Arc::clone(&table));
    }
    Ok(table)
}

/// 超大 CSV 的上传识别只看文件开头，不在界面第一步就把整份文件读入内存。
/// 正式测算会另行建立可恢复的磁盘缓存；此处只负责表头、映射和预览样本。
fn load_large_text_inspection(source: &SourceSpec, path: &Path) -> Result<Arc<FxTable>, AppError> {
    let all = crate::spreadsheet_input::read_rows_limited(path, 256)?;
    if all.is_empty() {
        return Err(error("SOURCE_EMPTY", "文件中没有可读取的数据。", None));
    }
    let (auto_header_row, auto_header_depth, scored) = infer_header_layout(&all);
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        auto_header_row
    };
    if header_row > all.len() {
        return Err(error(
            "HEADER_ROW_INVALID",
            "标题行超出预览样本范围。",
            None,
        ));
    }
    let header_index = header_row - 1;
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let inferred_depth = if source.header_row == 0 {
        auto_header_depth
    } else if header_index + 1 < all.len()
        && combined_semantic_score(&all[header_index], &all[header_index + 1])
            > ledger_mapping::header_semantic_hits(&all[header_index]) + 2
    {
        2
    } else {
        1
    };
    let depth = if source.header_depth == 0 {
        inferred_depth
    } else {
        source.header_depth.clamp(1, 2)
    };
    let raw_headers = all[header_index..(header_index + depth).min(all.len())]
        .iter()
        .map(|row| pad(row, width))
        .collect::<Vec<_>>();
    let headers = merge_headers(&raw_headers, width);
    let rows = all[(header_index + depth).min(all.len())..]
        .iter()
        .map(|row| pad(row, width))
        .collect::<Vec<_>>();
    Ok(Arc::new(FxTable {
        path: path.to_path_buf(),
        sheet: "CSV".into(),
        sheets: Vec::new(),
        header_row,
        header_depth: depth,
        raw_headers,
        headers,
        row_count: rows.len(),
        rows,
        header_candidates: scored.into_iter().take(3).collect(),
        sampled: true,
    }))
}

pub(crate) fn load_fx_table(source: &SourceSpec) -> Result<Arc<FxTable>, AppError> {
    let path = PathBuf::from(&source.input_path);
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(source.input_path.clone()),
        ));
    }
    let cache_key = fx_table_cache_key(source, &path);
    if let Some(table) = cache_key.as_deref().and_then(cached_fx_table) {
        return Ok(table);
    }
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    // 识别阶段仍需要自动表头与双层表头探测；用户确认到具体 Sheet/标题行后，
    // 正式计算统一进入 Polars + 稳定 Parquet 缓存。双层表头暂由下方公共
    // 识别路径合并，避免把第二层表头误当数据行。
    if source.header_row > 0 && source.header_depth <= 1 && ext != "parquet" {
        let selected = (!source.sheet.trim().is_empty()).then_some(source.sheet.as_str());
        let value =
            crate::tabular::fx_load_ledger_table_value_cached(&path, selected, source.header_row)?;
        let headers = strings(value.get("headers"));
        let rows = string_rows(value.get("rows"));
        let sheet = value
            .get("sheet")
            .and_then(Value::as_str)
            .unwrap_or("CSV")
            .to_owned();
        let sheets = strings(value.get("sheets"));
        let row_count = rows.len();
        let table = Arc::new(FxTable {
            path,
            sheet,
            sheets,
            header_row: source.header_row,
            header_depth: 1,
            raw_headers: vec![headers.clone()],
            headers,
            rows,
            row_count,
            header_candidates: vec![(source.header_row, 1.0)],
            sampled: false,
        });
        store_fx_table(cache_key, &table);
        return Ok(table);
    }
    if ext == "parquet" {
        let value = crate::tabular::fx_load_table_value(&path, None, 1)?;
        let headers = strings(value.get("headers"));
        let rows = string_rows(value.get("rows"));
        let row_count = rows.len();
        let table = Arc::new(FxTable {
            path,
            sheet: "Parquet".into(),
            sheets: vec![],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![headers.clone()],
            headers,
            rows,
            row_count,
            header_candidates: vec![(1, 1.0)],
            sampled: false,
        });
        store_fx_table(cache_key, &table);
        return Ok(table);
    }
    let (sheet, sheets, all) = if crate::spreadsheet_input::is_text(path.as_ref()) {
        ("CSV".to_string(), vec![], read_text_rows(&path)?)
    } else {
        let mut book = open_workbook_auto(&path).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作簿。",
                Some(e.to_string()),
            )
        })?;
        let sheets = book.sheet_names().to_vec();
        let (selected, all) = if !source.sheet.trim().is_empty() && sheets.contains(&source.sheet) {
            let range = book.worksheet_range(&source.sheet).map_err(|e| {
                error(
                    "WORKBOOK_READ_FAILED",
                    "无法读取指定 Sheet。",
                    Some(e.to_string()),
                )
            })?;
            (
                source.sheet.clone(),
                range
                    .rows()
                    .map(|r| r.iter().map(data_text).collect())
                    .collect(),
            )
        } else {
            let mut best: Option<(String, Vec<Vec<String>>, f64)> = None;
            for name in &sheets {
                let Ok(range) = book.worksheet_range(name) else {
                    continue;
                };
                let values = range
                    .rows()
                    .map(|r| r.iter().map(data_text).collect())
                    .collect::<Vec<Vec<String>>>();
                if values
                    .iter()
                    .all(|row| row.iter().all(|value| value.trim().is_empty()))
                {
                    continue;
                }
                let header = (0..values.len().min(30))
                    .map(|index| ledger_mapping::header_row_score(&values, index))
                    .fold(0.0_f64, f64::max);
                let populated = values
                    .iter()
                    .filter(|row| row.iter().filter(|value| !value.trim().is_empty()).count() >= 2)
                    .count();
                let score = ledger_mapping::sheet_score(header, populated, name);
                if best.as_ref().is_none_or(|current| score > current.2) {
                    best = Some((name.clone(), values, score));
                }
            }
            let (name, values, _) =
                best.ok_or_else(|| error("SOURCE_EMPTY", "工作簿中没有可读取的数据Sheet。", None))?;
            (name, values)
        };
        (selected, sheets, all)
    };
    if all.is_empty() {
        return Err(error("SOURCE_EMPTY", "文件中没有可读取的数据。", None));
    }
    let (auto_header_row, auto_header_depth, scored) = infer_header_layout(&all);
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        auto_header_row
    };
    if header_row > all.len() {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let h = header_row - 1;
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let inferred_depth = if source.header_row == 0 {
        auto_header_depth
    } else if h + 1 < all.len()
        && combined_semantic_score(&all[h], &all[h + 1])
            > ledger_mapping::header_semantic_hits(&all[h]) + 2
    {
        2
    } else {
        1
    };
    let depth = if source.header_depth == 0 {
        inferred_depth
    } else {
        source.header_depth.clamp(1, 2)
    };
    let raw_headers = all[h..(h + depth).min(all.len())]
        .iter()
        .map(|r| pad(r, width))
        .collect::<Vec<_>>();
    let headers = merge_headers(&raw_headers, width);
    let rows = all[(h + depth).min(all.len())..]
        .iter()
        // 整行空白是正文与表尾手工草稿的边界，必须保留给公共账表清洗器。
        .map(|r| pad(r, width))
        .collect::<Vec<_>>();
    let row_count = rows.len();
    let table = Arc::new(FxTable {
        path,
        sheet,
        sheets,
        header_row,
        header_depth: depth,
        raw_headers,
        headers,
        rows,
        row_count,
        header_candidates: scored.into_iter().take(3).collect(),
        sampled: false,
    });
    store_fx_table(cache_key, &table);
    Ok(table)
}

fn read_text_rows(path: &Path) -> Result<Vec<Vec<String>>, AppError> {
    crate::spreadsheet_input::read_rows(path)
}

fn data_text(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(v) => v.clone(),
        Data::Float(v) => {
            if v.fract() == 0.0 {
                format!("{v:.0}")
            } else {
                v.to_string()
            }
        }
        Data::Int(v) => v.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v
            .as_datetime()
            .map(|date| date.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| v.to_string()),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => format!("{v:?}"),
    }
}

fn pad(row: &[String], width: usize) -> Vec<String> {
    (0..width)
        .map(|i| row.get(i).cloned().unwrap_or_default())
        .collect()
}
fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}
fn string_rows(v: Option<&Value>) -> Vec<Vec<String>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|r| strings(Some(r))).collect())
        .unwrap_or_default()
}

pub(crate) fn normalize_header(v: &str) -> String {
    v.to_lowercase().replace(
        [
            ' ', '\n', '\r', '\t', '_', '-', '—', '/', '（', '）', '(', ')',
        ],
        "",
    )
}

/// 工作表选择与表头行打分（[`ledger_mapping::sheet_score`]、
/// [`ledger_mapping::header_row_score`]、[`ledger_mapping::header_semantic_hits`]）
/// 已收进公共账表引擎，本文件只保留消费它们的识别流程。

fn combined_semantic_score(a: &[String], b: &[String]) -> usize {
    let width = a.len().max(b.len());
    ledger_mapping::header_semantic_hits(
        &(0..width)
            .map(|i| {
                format!(
                    "{}{}",
                    a.get(i).map(String::as_str).unwrap_or(""),
                    b.get(i).map(String::as_str).unwrap_or("")
                )
            })
            .collect::<Vec<_>>(),
    )
}

/// Jointly infer the first header row and its depth. A two-row TB header must
/// compete as one candidate; otherwise its lower `借方/贷方` row can win alone.
fn infer_header_layout(all: &[Vec<String>]) -> (usize, usize, Vec<(usize, f64)>) {
    let limit = all.len().min(30);
    let mut row_scores = (0..limit)
        .map(|index| (index + 1, ledger_mapping::header_row_score(all, index)))
        .collect::<Vec<_>>();
    row_scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut best = row_scores
        .first()
        .map(|(row, score)| (*row, 1usize, *score))
        .unwrap_or((1, 1, 0.0));
    for index in 0..limit.saturating_sub(1) {
        let first_hits = ledger_mapping::header_semantic_hits(&all[index]);
        let second_hits = ledger_mapping::header_semantic_hits(&all[index + 1]);
        let combined_hits = combined_semantic_score(&all[index], &all[index + 1]);
        if second_hits == 0 || combined_hits <= first_hits + 2 {
            continue;
        }
        // 只有一格有字的上一行是**标题行**（「序时账」「XX公司科目余额表」），不是分组表头。
        // [`merge_headers`] 会把它顺延到每一列，于是每个列名都被冠上标题前缀
        // （「序时账-公司代码」），既污染映射标签，也与看账那侧的单行读取对不上。
        // 真正的两行表头（期初｜期末 覆在 借方｜贷方 上）上一行至少有两格有字。
        if all[index]
            .iter()
            .filter(|cell| !cell.trim().is_empty())
            .count()
            < 2
        {
            continue;
        }
        let width = all[index].len().max(all[index + 1].len());
        let merged = merge_headers(&all[index..=index + 1], width);
        let mut synthetic = vec![merged];
        if let Some(data) = all.get(index + 2) {
            synthetic.push(data.clone());
        }
        let pair_score = ledger_mapping::header_row_score(&synthetic, 0)
            + (combined_hits.min(16) as f64 / 16.0) * 0.10;
        if pair_score > best.2 {
            best = (index + 1, 2, pair_score);
        }
    }
    (best.0, best.1, row_scores)
}

fn merge_headers(raw: &[Vec<String>], width: usize) -> Vec<String> {
    let mut upper = raw.first().cloned().unwrap_or_default();
    let mut carry = String::new();
    for value in &mut upper {
        if value.trim().is_empty() {
            *value = carry.clone();
        } else {
            carry = value.trim().to_owned();
        }
    }
    let mut seen = HashMap::new();
    (0..width)
        .map(|i| {
            let a = upper.get(i).map(|x| x.trim()).unwrap_or("");
            let b = raw
                .get(1)
                .and_then(|r| r.get(i))
                .map(|x| x.trim())
                .unwrap_or("");
            let base = if b.is_empty() || normalize_header(a) == normalize_header(b) {
                a.to_owned()
            } else if a.is_empty() {
                b.to_owned()
            } else {
                format!("{a}-{b}")
            };
            let base = if base.is_empty() {
                format!("列{}", i + 1)
            } else {
                base.replace(['\n', '\r'], " ")
            };
            let count = seen.entry(base.clone()).or_insert(0usize);
            *count += 1;
            if *count > 1 {
                format!("{base}_{}", *count)
            } else {
                base
            }
        })
        .collect()
}

type Candidate = (String, f64, Vec<String>, Vec<String>);

/// 列名分不出「本年累计」与「本期发生」时，按金额量级重判：合计大的是本年累计。
/// 本工具的候选打分带列画像加权，映射不是内核直接产出的，所以在成型之后再过一道。
fn refine_layout(table: &FxTable, kind: &str, mapping: &mut Map<String, Value>) {
    let current: Vec<(String, String)> = mapping
        .iter()
        .filter_map(|(role, value)| {
            value
                .as_str()
                .map(|column| (role.clone(), column.to_string()))
        })
        .collect();
    for (role, column) in
        ledger_mapping::recheck_cumulative(kind, &table.headers, &table.rows, &current)
    {
        match column {
            Some(name) => {
                mapping.insert(role.to_string(), Value::String(name));
            }
            None => {
                mapping.remove(role);
            }
        }
    }
}

/// 一列只承载一个语义：同一列被多个角色选中时，分数高的留下。
///
/// 可多列的角色（科目名称、凭证识别字段）逐列参与——被挤掉时只丢那一列，
/// 丢光了才整个角色移除。
fn drop_column_conflicts(
    kind: &str,
    candidates: &BTreeMap<String, Vec<Candidate>>,
    mapping: &mut Map<String, Value>,
) {
    let score_of = |role: &str, column: &str| {
        candidates
            .get(role)
            .and_then(|all| all.iter().find(|c| c.0 == column))
            .map(|c| c.1)
            .unwrap_or(0.0)
    };
    let mut picks: Vec<(String, String, f64)> = Vec::new();
    for (role, value) in mapping.iter() {
        match value {
            Value::String(column) => {
                picks.push((role.clone(), column.clone(), score_of(role, column)))
            }
            Value::Array(columns) => {
                for column in columns.iter().filter_map(Value::as_str) {
                    picks.push((role.clone(), column.to_string(), score_of(role, column)));
                }
            }
            _ => {}
        }
    }
    for (role, column) in ledger_mapping::conflicting_roles(kind, &picks) {
        let drop_whole = match mapping.get_mut(&role) {
            Some(Value::Array(columns)) => {
                columns.retain(|x| x.as_str() != Some(column.as_str()));
                columns.is_empty()
            }
            _ => true,
        };
        if drop_whole {
            mapping.remove(&role);
        }
    }
}

/// 科目编码整个空缺时，找一列「编码+名称混写」的顶上。
///
/// 03 号样例非这条不可：它整张表只有一列科目（`1001010000:库存现金-人民币`），
/// 表头写作 `项目编码、文本/科目编码、文本`——里头既有「科目编码」又有「文本」，
/// 冲突词一票否决，按列名怎么判都落不到科目编码上。只能看数据。
///
/// 只在**空缺时**补：表里另有干净编码列的（08 号那种名称列里带编码的），
/// 编码角色早就有主了，这里不插手。币种线索文本占着的列可以抢——那是个弱角色，
/// 「文本」两个字谁都能命中，而且随后 [`pick_currency_text_column`] 会重挑。
/// 科目编码整个空缺时，找一列「编码+名称混写」的顶上。
///
/// 判定规则全在公共引擎 [`ledger_mapping::plan_combined_account_fill`]——挑哪一列、
/// 能不能从辅助核算手里抢、要不要同列兼挂科目名称，都由引擎说了算。这里只负责
/// 把结论套回映射表。存款利息共用同一份，不再各写一遍近似实现。
pub(crate) fn fill_combined_account_column(
    kind: &str,
    table: &FxTable,
    mapping: &mut Map<String, Value>,
) {
    let plan =
        ledger_mapping::plan_combined_account_fill(kind, &table.headers, &table.rows, &|role| {
            mapped_cols(mapping, role)
        });
    if let Some(header) = plan.code_column {
        mapping.insert("accountCode".into(), Value::String(header.clone()));
        // 让辅助核算出让该列：它原本就是靠「文本」两个字兜底占到的，
        // 留着会把整列科目全称当成银行账号参与分摊。
        if let Some(Value::Array(columns)) = mapping.get_mut("auxiliary") {
            columns.retain(|column| column.as_str() != Some(header.as_str()));
            if columns.is_empty() {
                mapping.remove("auxiliary");
            }
        }
    }
    if let Some(header) = plan.name_column {
        mapping.insert(
            "accountName".into(),
            Value::Array(vec![Value::String(header)]),
        );
    }
}

/// 科目名称整个空缺时，看 accountCode 的候选列里有没有「列名像科目、
/// 取值却是名称文本」的列顶上。
///
/// 03 号样例的 SAP 序时账：编码列叫「总账科目」（取值 1001010000），
/// 另有一列叫「会计科目」、取值是 `库存现金-人民币` 这种名称文本。
/// 「会计科目」在别名库里是 accountCode 的别名，按列名它只会去争编码；
/// 编码已有主列后它就被丢弃，科目名称两头落空。只能看数据说话：
/// 整列取值拆不出编码前缀、又大多是中文文本的，就是科目名称列。
fn fill_account_name_from_code_alias(
    table: &FxTable,
    candidates: &BTreeMap<String, Vec<Candidate>>,
    mapping: &mut Map<String, Value>,
) {
    if mapping.contains_key("accountName") {
        return;
    }
    // 已被任何角色占用的列都不看——编码列要排除，币种线索之类的弱角色也一样。
    let taken: Vec<String> = mapping
        .values()
        .flat_map(|value| match value {
            Value::String(one) => vec![one.clone()],
            Value::Array(all) => all
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => vec![],
        })
        .collect();
    let pick = candidates
        .get("accountCode")
        .into_iter()
        .flatten()
        // 分数太低的只是沾了点边，不算科目列。
        .filter(|candidate| candidate.1 >= 0.5 && !taken.contains(&candidate.0))
        .find(|candidate| {
            let Some(index) = table.headers.iter().position(|h| h == &candidate.0) else {
                return false;
            };
            let values = table
                .rows
                .iter()
                .take(2000)
                .filter_map(|row| row.get(index))
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            // 样本太少说明不了形态；名称文本列应是：拆不出「编码+分隔符」
            // 前缀，且大部分取值带中文（编码列是纯字母数字，「抵销科目」这类
            // 对手方编码列进不来）。
            let (mut text, mut unsplittable) = (0usize, 0usize);
            for value in &values {
                if ledger_mapping::split_code_and_name(value).is_none() {
                    unsplittable += 1;
                }
                if value
                    .chars()
                    .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
                {
                    text += 1;
                }
            }
            values.len() >= 4
                && text * 5 >= values.len() * 4
                && unsplittable * 4 >= values.len() * 3
        });
    if let Some(candidate) = pick {
        mapping.insert("accountName".into(), Value::String(candidate.0.clone()));
    }
}

/// 币种线索列**按取值内容挑，不按列名挑**。
///
/// 线索列的作用是「没有独立币种列时，去哪一格找账户币种」——那么判据只能是
/// 「这一列里真的抽得出币种」。按列名判会挑错：04／05 号样例的
/// `科目级别描述` 只含「描述」两个字就赢了，可它整列都是 `1002_银行存款`
/// 这种一级科目名，一行都抽不出币种；真正带 `美元户` 的明细科目名列因为
/// 角色已被占，再没有机会。线索列是单列角色，抢错一次就没有补救。
///
/// 一列都抽不出就**让它空着**——这比硬挑一列更诚实，下游会退回按科目名称找。
fn pick_currency_text_column(table: &FxTable, kind: &str, mapping: &mut Map<String, Value>) {
    if kind != "tb" {
        return;
    }
    // 按列名判出来的结果一律作废，改由数据说了算。
    mapping.remove("currencyText");
    // 已经认定为币种代码列的不参与：那两列整列都是 CNY／USD，命中率必然
    // 百分之百，一比就赢——可线索列的意义恰恰是「没有币种列时的退路」。
    let taken: Vec<&str> = ["currency", "functionalCurrency"]
        .iter()
        .filter_map(|role| mapping.get(*role).and_then(Value::as_str))
        .collect();
    let best = table
        .headers
        .iter()
        .enumerate()
        .filter(|(_, header)| !taken.contains(&header.as_str()))
        .map(|(index, header)| {
            let hits = table
                .rows
                .iter()
                .take(2000)
                .filter_map(|row| row.get(index))
                .filter(|text| currency_from_text(text).is_some())
                .count();
            (hits, index, header)
        })
        .filter(|(hits, _, _)| *hits > 0)
        // 命中最多的赢；平手时取靠后的列——余额表里越靠后的科目名称级次越明细，
        // 账户币种写在最明细那一级上。
        .max_by_key(|(hits, index, _)| (*hits, *index));
    if let Some((_, _, header)) = best {
        mapping.insert("currencyText".into(), Value::String(header.clone()));
    }
}

/// 逐角色给出候选列清单。**判定规则只有引擎一份**：命中与否、命中哪一档，
/// 全部由 [`ledger_mapping::alias_score`] 说了算；本函数只在其上叠加列画像
/// 加分（日期列的日期占比、金额列的数值占比、币种列的取值形态裁定），
/// 画像改变的是排序与置信度，不改变引擎的命中与排除结论。
fn suggest_mappings(table: &FxTable, kind: &str) -> BTreeMap<String, Vec<Candidate>> {
    let profiles = column_profiles(table);
    let mut out = BTreeMap::new();
    for definition in ledger_mapping::roles(kind) {
        let (role, aliases, conflicts) =
            (definition.name, definition.aliases, definition.conflicts);
        let mut choices = table
            .headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let n = normalize_header(h);
                // 命中的别名仍逐档列出来给面板解释理由（hitTerms／conflictTerms），
                // 但**判哪一档**不再本地定，统一以引擎 `alias_score` 的返回为准：
                // 它在同一张词表上做最长命中，并统一执行冲突词与集团货币排除。
                let exact = aliases
                    .iter()
                    .filter(|a| n == normalize_header(a))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let segment = aliases
                    .iter()
                    .filter(|a| ledger_mapping::segment_exact(h, a))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let partial = aliases
                    .iter()
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let bad = conflicts
                    .iter()
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                // 引擎档位折算成面板的置信度刻度：整体相等（≥2.0）0.94、
                // 分段相等（≥1.5）0.88、包含命中 0.72；引擎判不匹配时退回
                // 本工具的列名弱启发（只补期初/期末方向的近义写法，不带词表）。
                let mut score: f64 = match ledger_mapping::alias_score(definition, h) {
                    Some(engine_score) if engine_score >= 2.0 => 0.94,
                    Some(engine_score) if engine_score >= 1.5 => 0.88,
                    Some(_) => 0.72,
                    None => semantic_role_score(role, &n),
                };
                if role == "entity"
                    && ledger_mapping::entity_column_is_measurement_unit(
                        &table.headers,
                        &table.rows,
                        h,
                    )
                {
                    score = 0.0;
                }
                if role == "date" {
                    score += profiles[i]
                        .get("dateRatio")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        * 0.12;
                }
                // 币种角色的数据形态判定对两张表都适用：序时账里
                // 「本位币」这种列名既像本位币标识又像本位币金额，看取值就能分开。
                if matches!(role, "currency" | "functionalCurrency") {
                    // 币种列到底是原币列还是本位币列，交给统一内核判：
                    // **填满（没有空单元格）且只出现一种币种**才是本位币列，其余都是原币列。
                    // 「只标外币」的写法（空白代表本位币、填了的才是外币）实务里最常见——
                    // 9 份真实样例里有 4 份是这样，旧规则「只有一种币种就判本位币」会判反。
                    //
                    // 序时账上这条形态裁定要让位于**列名证据**（仅 exact/segment 级命中）：
                    // 整本账只有本币业务时，凭证货币列整列只剩一种代码是正常形态，
                    // 不是本位币列——按形态把它判给 functionalCurrency 会把 currency
                    // 挤空，必填校验从此一直拦着（04 PBC 的「货币」列整列 CNY 即如此），
                    // 复核提示词还会认可现状。凭证货币命名（货币／凭证货币／Document
                    // Currency）归 currency，本位币命名（本位币／公司代码货币／总账货币）
                    // 归 functionalCurrency。TB 维持形态裁定不变：它的「货币」列整列
                    // 同值登记的确实是主体本位币（4800「货币」列整列 USD 有回归测试）。
                    let functional_named = ledger_mapping::role_of(kind, "functionalCurrency")
                        .is_some_and(|def| {
                            def.aliases.iter().any(|alias| {
                                n == normalize_header(alias)
                                    || ledger_mapping::segment_exact(h, alias)
                            })
                        });
                    let named_for_role = !exact.is_empty() || !segment.is_empty();
                    let column = table
                        .rows
                        .iter()
                        .map(|row| row.get(i).map(String::as_str).unwrap_or(""));
                    match ledger_mapping::classify_currency_column(column) {
                        ledger_mapping::CurrencyColumn::Unusable { .. } => {
                            // 列名里带“货币”但一个币种代码都认不出（例如“期初金额-集团货币”）。
                            score -= 0.6;
                        }
                        ledger_mapping::CurrencyColumn::Foreign { .. } => {
                            if role == "currency" {
                                score += 0.45;
                            } else {
                                score -= 0.6;
                            }
                        }
                        ledger_mapping::CurrencyColumn::Functional { .. } => {
                            let je_name_priority = kind == "je";
                            if role == "currency" {
                                if !(je_name_priority && named_for_role && !functional_named) {
                                    score -= 0.6;
                                }
                            } else if !(je_name_priority && !functional_named) {
                                // 序时账里没有本位币命名的列，仅凭整列同值不该
                                // 抢走凭证货币列；
                                score += 0.62;
                            }
                        }
                    }
                }
                if role.to_lowercase().contains("amount")
                    || role.to_lowercase().contains("debit")
                    || role.to_lowercase().contains("credit")
                {
                    score += profiles[i]
                        .get("numberRatio")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        * 0.12;
                }
                // 冲突词是排除条件，不是扣分项——「期初余额(借)」含「借」，
                // 就不该再作为「期初净额」的候选，哪怕别名也命中了「期初余额」。
                if !bad.is_empty() {
                    score = 0.0;
                }
                (
                    h.clone(),
                    score.clamp(0.0, 1.0),
                    if !exact.is_empty() {
                        exact
                    } else if !segment.is_empty() {
                        segment
                    } else {
                        partial
                    },
                    bad,
                )
            })
            .filter(|x| x.1 > 0.15)
            .collect::<Vec<_>>();
        choices.sort_by(|a, b| b.1.total_cmp(&a.1));
        choices.truncate(if kind == "tb" && role == "currency" {
            8
        } else {
            3
        });
        out.insert(role.into(), choices);
    }
    out
}

fn semantic_role_score(role: &str, header: &str) -> f64 {
    let contains_any = |words: &[&str]| words.iter().any(|word| header.contains(word));
    let period_ok = if role.starts_with("opening") {
        contains_any(&["期初", "年初", "opening", "begin"])
    } else if role.starts_with("closing") {
        contains_any(&["期末", "年末", "closing", "ending"])
    } else {
        true
    };
    let currency_ok = if role.contains("Foreign") {
        contains_any(&["原币", "外币", "foreign", "transaction"])
    } else if role.contains("Functional") {
        contains_any(&["本位币", "本币", "functional", "local"])
    } else {
        true
    };
    let direction_ok = if role.ends_with("Debit") {
        contains_any(&["借方", "debit", "dr"])
    } else if role.ends_with("Credit") {
        contains_any(&["贷方", "credit", "cr"])
    } else {
        true
    };
    let value_ok = if role.contains("Amount") || role.contains("Debit") || role.contains("Credit") {
        contains_any(&["金额", "余额", "amount", "balance", "借方", "贷方"])
    } else {
        true
    };
    // 方向列必须真的写着方向，不能因为列名带“期初”就算数。
    let direction_role_ok = if role.ends_with("Direction") {
        contains_any(&["方向", "借贷", "借贷方向", "drcr", "dccr"])
    } else {
        true
    };
    if period_ok
        && currency_ok
        && direction_ok
        && value_ok
        && direction_role_ok
        && (role.starts_with("opening") || role.starts_with("closing"))
    {
        0.82
    } else {
        0.0
    }
}

fn candidate_json(v: &BTreeMap<String, Vec<Candidate>>) -> Value {
    json!(
        v.iter()
            .map(|(role, choices)| json!({
                "role": role,
                "candidates": choices.iter().map(|x| json!({
                    "column": x.0, "ruleScore": x.1, "sampleScore": x.1,
                    "confidence": x.1, "hitTerms": x.2, "conflictTerms": x.3
                })).collect::<Vec<_>>()
            }))
            .collect::<Vec<_>>()
    )
}

fn column_profiles(table: &FxTable) -> Vec<Value> {
    (0..table.headers.len())
        .map(|i| {
            let values = table
                .rows
                .iter()
                .take(200)
                .filter_map(|r| r.get(i))
                .filter(|v| !v.trim().is_empty())
                .collect::<Vec<_>>();
            let n = values.len().max(1) as f64;
            let numbers = values
                .iter()
                .filter(|v| strict_number(v).ok().flatten().is_some())
                .count() as f64;
            let dates = values.iter().filter(|v| parse_date(v).is_some()).count() as f64;
            json!({
                "column": table.headers[i], "nonEmpty": values.len(),
                "numberRatio": numbers / n, "dateRatio": dates / n,
                "samples": values.into_iter().take(5).collect::<Vec<_>>()
            })
        })
        .collect()
}

fn distinct_for_role(
    table: &FxTable,
    candidates: &BTreeMap<String, Vec<Candidate>>,
    role: &str,
) -> Vec<String> {
    if role == "account" {
        let best = |role: &str, limit: usize| {
            candidates
                .get(role)
                .into_iter()
                .flatten()
                .filter(|candidate| candidate.1 >= 0.85)
                .take(limit)
                .filter_map(|candidate| {
                    table
                        .headers
                        .iter()
                        .position(|header| header == &candidate.0)
                })
                .collect::<Vec<_>>()
        };
        let columns = best("accountCode", 1)
            .into_iter()
            .chain(best("accountName", usize::MAX))
            .collect::<Vec<_>>();
        if columns.is_empty() {
            return vec![];
        }
        let mut values = table
            .rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .filter_map(|index| row.get(*index))
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        values.truncate(200);
        return values;
    }
    let Some(col) = candidates.get(role).and_then(|x| x.first()).map(|x| &x.0) else {
        return vec![];
    };
    if candidates
        .get(role)
        .and_then(|values| values.first())
        .is_none_or(|candidate| candidate.1 < 0.55)
    {
        return vec![];
    }
    let Some(i) = table.headers.iter().position(|h| h == col) else {
        return vec![];
    };
    let mut values = table
        .rows
        .iter()
        .filter_map(|r| r.get(i))
        .map(|x| x.trim().to_owned())
        .filter(|x| !x.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.truncate(200);
    values
}

fn mapping_obj(params: &Value, key: &str) -> Map<String, Value> {
    params
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| params.get("mapping").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

pub(crate) fn mapped_cols(mapping: &Map<String, Value>, role: &str) -> Vec<String> {
    match mapping.get(role) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}

fn load_mapped_je_table(params: &Value) -> Result<(Arc<FxTable>, Map<String, Value>), AppError> {
    let spec: SourceSpec =
        serde_json::from_value(params.get("jeSource").cloned().unwrap_or_default())
            .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let mapping = mapping_obj(params, "jeMapping");
    let table = load_fx_table(&spec)?;
    Ok((forward_filled_je_table(&table, &mapping), mapping))
}

/// 大 CSV 先进入公共 SQLite 行缓存，再只把 FX 已映射列投影到计算表。
/// 这避免 46 列序时账在每个阶段都把无关列和字符串分配搬进内存；投影表按
/// 源文件指纹存进当前 worker 的表缓存，后续校验、测算、复核共用同一份。
fn prepare_large_je_table(
    params: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<bool, AppError> {
    let Some(source) = params.get("jeSource") else {
        return Ok(false);
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let path = PathBuf::from(&spec.input_path);
    if !tabular::disk_ledger_applies(&path) {
        return Ok(false);
    }
    if spec.header_depth > 1 {
        return Err(error(
            "LARGE_CSV_DOUBLE_HEADER",
            "超大 CSV 暂不支持双层标题，请先整理为单层标题后重试。",
            None,
        ));
    }
    let cache_key = fx_table_cache_key(&spec, &path);
    if cache_key.as_deref().and_then(cached_fx_table).is_some() {
        return Ok(true);
    }
    checkpoint(cancel, pause)?;
    progress(
        "disk_cache",
        0,
        0,
        "正在建立或复用 JE 磁盘缓存；首次读取时间较长，可暂停或最小化…",
    );
    let disk = tabular::open_disk_ledger(&path, spec.header_row.max(1), progress, cancel)?;
    let mapping = mapping_obj(params, "jeMapping");
    let requested = mapping
        .iter()
        .filter(|(role, _)| !role.starts_with("__"))
        .flat_map(|(role, _)| mapped_cols(&mapping, role))
        .collect::<BTreeSet<_>>();
    let selected = disk
        .headers()
        .iter()
        .enumerate()
        .filter(|(_, header)| requested.contains(*header))
        .map(|(index, header)| (index, header.clone()))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(error(
            "MAPPING_INVALID",
            "JE 已映射字段在文件中均不存在，请返回映射步骤重新确认。",
            None,
        ));
    }
    let headers = selected
        .iter()
        .map(|(_, header)| header.clone())
        .collect::<Vec<_>>();
    let mut rows = Vec::with_capacity(disk.row_count().min(500_000));
    let mut estimated_bytes = 0_u64;
    let safe_projection_bytes = crate::resource_budget::budget()?
        .worker_bytes
        .saturating_mul(55)
        / 100;
    disk.visit(cancel, |row, source_row| {
        if rows.len() % 10_000 == 0 {
            checkpoint(cancel, pause)?;
        }
        while spec.header_row + rows.len() + 1 < source_row {
            estimated_bytes = estimated_bytes
                .saturating_add(std::mem::size_of::<Vec<String>>() as u64);
            rows.push(vec![String::new(); selected.len()]);
        }
        let projected = selected
            .iter()
            .map(|(index, _)| row.get(*index).cloned().unwrap_or_default())
            .collect::<Vec<_>>();
        estimated_bytes = estimated_bytes
            .saturating_add(std::mem::size_of::<Vec<String>>() as u64)
            .saturating_add(
                projected
                    .iter()
                    .map(|value| std::mem::size_of::<String>() as u64 + value.capacity() as u64)
                    .sum::<u64>(),
            );
        if estimated_bytes > safe_projection_bytes {
            return Err(AppError::new(
                "FX_PROJECTED_MEMORY_BUDGET",
                "当前电脑内存不足以安全装入汇兑损益所需字段。任务已保留磁盘缓存，请释放内存后重试。",
                true,
                None,
            ));
        }
        rows.push(projected);
        if rows.len() % 50_000 == 0 {
            progress(
                "project_je",
                rows.len(),
                0,
                &format!("正在从磁盘缓存提取测算字段：已处理 {} 行…", rows.len()),
            );
        }
        Ok(())
    })?;
    let table = Arc::new(FxTable {
        path: path.clone(),
        sheet: "CSV".into(),
        sheets: Vec::new(),
        header_row: spec.header_row.max(1),
        header_depth: 1,
        raw_headers: vec![headers.clone()],
        headers,
        row_count: rows.len(),
        rows,
        header_candidates: vec![(spec.header_row.max(1), 1.0)],
        sampled: false,
    });
    store_fx_table(cache_key, &table);
    progress(
        "project_je",
        table.row_count,
        0,
        &format!("JE 磁盘缓存已就绪，已提取 {} 行测算字段。", table.row_count),
    );
    Ok(true)
}

fn is_je_forward_fill_role(role: &str) -> bool {
    // 仅填充 Excel 合并单元格常见的凭证级/身份字段。币种空白表示本位币，
    // 方向空白也有业务含义，绝不能继承上一行；否则一笔美元分录之后的库存
    // 现金等本位币科目会被整片误认成 USD。
    matches!(
        ledger_mapping::migrate_role_name("je", role),
        "date"
            | "id"
            | "voucherType"
            | "entity"
            | "accountCode"
            | "accountName"
            | "account"
            | "auxiliary"
            | "summary"
    )
}

/// 对已确认映射的 JE 非金额字段执行向下填充。没有可填空白时复用原 Arc；只有
/// 确实需要填充时才复制表，避免大文件在常规路径上无谓翻倍占用内存。
pub(crate) fn forward_filled_je_table(
    table: &Arc<FxTable>,
    mapping: &Map<String, Value>,
) -> Arc<FxTable> {
    let columns = mapping
        .iter()
        .filter(|(role, _)| is_je_forward_fill_role(role))
        .flat_map(|(role, _)| mapped_cols(mapping, role))
        .collect::<Vec<_>>();
    let mapping_fingerprint = serde_json::to_vec(mapping).unwrap_or_default();
    let cache_key = format!(
        "{:p}|{}",
        Arc::as_ptr(table),
        hex::encode(Sha256::digest(mapping_fingerprint))
    );
    if let Some(cached) = cached_job_table(&cache_key) {
        return cached;
    }
    let indexes = columns
        .iter()
        .filter_map(|column| ledger_mapping::header_index(&table.headers, column))
        .collect::<HashSet<_>>();
    let needs_fill = table.rows.iter().skip(1).any(|row| {
        indexes
            .iter()
            .any(|index| row.get(*index).is_none_or(|value| value.trim().is_empty()))
    });
    if !needs_fill {
        let unchanged = Arc::clone(table);
        store_job_table(cache_key, &unchanged);
        return unchanged;
    }
    let mut filled = (**table).clone();
    // 合计行/游离数字行不能参与填充：它们没有身份，一旦被填上一行的科目/凭证
    // 就会混进发生额（借款利息的序时账实测踩过这个坑）。行保留原位，只是不填。
    let junk = ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &|role| {
        mapped_cols(mapping, role)
    });
    if junk.iter().all(|kept| *kept) {
        ledger_mapping::forward_fill_columns(&filled.headers, &mut filled.rows, &columns);
    } else {
        ledger_mapping::forward_fill_columns_skipping(
            &filled.headers,
            &mut filled.rows,
            &columns,
            &junk,
        );
    }
    let filled = Arc::new(filled);
    store_job_table(cache_key, &filled);
    filled
}

fn first_col(mapping: &Map<String, Value>, role: &str) -> Option<String> {
    mapped_cols(mapping, role).first().cloned()
}

/// 表里没有主体列时，全表统一挂在这个名字下。
///
/// 主体是**选填**角色：没映射也没填名字时不拦，用这个默认名兜底即可。
/// 真正必填的是本位币——它按主体挂，所以主体至少要有个名字当挂载点。
pub(crate) const DEFAULT_ENTITY: &str = "默认主体";

fn fixed_entity(params: &Value) -> &str {
    let given = params
        .get("fixedEntity")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if given.is_empty() {
        DEFAULT_ENTITY
    } else {
        given
    }
}

fn entity_for<'a>(row: &'a RowRecord, mapping: &Map<String, Value>, params: &'a Value) -> &'a str {
    let mapped = cell(row, mapping, "entity").trim();
    if mapped.is_empty() {
        fixed_entity(params)
    } else {
        mapped
    }
}

/// 币种文本抽取统一放在公共引擎，识别与取值共用同一份词表——
/// 否则会出现「识别时认定这列有币种、取值时又抽不出来」的分裂。
fn currency_from_text(value: &str) -> Option<String> {
    ledger_mapping::currency_from_text(value)
}

fn currency_text_hint(row: &RowRecord, mapping: &Map<String, Value>) -> Option<String> {
    let text = mapped_cols(mapping, "currencyText")
        .iter()
        .filter_map(|column| row.get(column.as_str()))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty())
        .then(|| currency_from_text(&text))
        .flatten()
}

/// 逐科目检测账户币种，并记录**依据来自哪里**。
///
/// 与 `currency_for` 用同一套优先级，只是跳过用户覆盖——这里要的正是未覆盖的
/// 原始判断，好让界面能告诉用户：这个科目的币种是有凭据的，还是只是退回了本位币。
///
/// 退回本位币的那些正是需要人工指定的。TB 只有一列「货币」且整列同值时，
/// 它登记的是主体本位币而不是账户币种；科目文本里若又没写币种线索，
/// 工具就认不出这是外币账户。实测 4800 有 6 个应付／其他应付科目因此被当成
/// 本位币账户，而 JE 里明明有 HKD／JPY 的业务，测算时找不到余额基础只能隔离。
fn detect_account_currencies(
    table: &FxTable,
    mapping: &Map<String, Value>,
) -> BTreeMap<String, Value> {
    // 每个科目既保留旧的综合结论，也分别保存币种列、科目文本和本位币列证据。
    // 跨 TB／JE 合并时三类证据的优先级不同，若在这里提前压成一个 detected，
    // 前端就无法实现“TB 币种列＞科目名＞单一 JE 币种列”的业务规则。
    type CurrencyTally = (
        BTreeMap<String, usize>,
        u8,
        BTreeMap<String, usize>,
        BTreeMap<String, usize>,
        BTreeMap<String, usize>,
    );
    let mut tally: BTreeMap<String, CurrencyTally> = BTreeMap::new();
    for row in records(table) {
        let account = account_name(&row, mapping);
        if account.is_empty() || is_summary_account(&account) {
            continue;
        }
        let mapped = normalize_currency(cell(&row, mapping, "currency"));
        let text = currency_text_hint(&row, mapping).or_else(|| currency_from_text(&account));
        let functional = normalize_currency(cell(&row, mapping, "functionalCurrency"));
        let (currency, rank) = if !mapped.is_empty() {
            (mapped.clone(), 3u8)
        } else if let Some(hint) = &text {
            (hint.clone(), 2)
        } else {
            (functional.clone(), 1)
        };
        if currency.is_empty() {
            continue;
        }
        let entry = tally.entry(account).or_default();
        *entry.0.entry(currency).or_default() += 1;
        entry.1 = entry.1.max(rank);
        if !mapped.is_empty() {
            *entry.2.entry(mapped).or_default() += 1;
        }
        if let Some(text) = text.filter(|value| !value.is_empty()) {
            *entry.3.entry(text).or_default() += 1;
        }
        if !functional.is_empty() {
            *entry.4.entry(functional).or_default() += 1;
        }
    }
    let most_common = |counts: &BTreeMap<String, usize>| {
        counts
            .iter()
            .max_by_key(|(_, count)| **count)
            .map(|(currency, _)| currency.clone())
            .unwrap_or_default()
    };
    tally
        .into_iter()
        .map(
            |(account, (counts, rank, column_counts, text_counts, functional_counts))| {
                // 一个科目下挂多种币种时取出现最多的那个当主币种；
                // 全部币种都放进 seen，界面把它们列进下拉框，用户不必凭记忆输。
                let detected = most_common(&counts);
                (
                    account,
                    json!({
                        "detected": detected,
                        "source": match rank {
                            3 => "币种列",
                            2 => "科目文本",
                            _ => "本位币列",
                        },
                        "seen": counts.keys().cloned().collect::<Vec<_>>(),
                        "columnSeen": column_counts.keys().cloned().collect::<Vec<_>>(),
                        "columnDetected": most_common(&column_counts),
                        "textDetected": most_common(&text_counts),
                        "functionalDetected": most_common(&functional_counts),
                        // 只有退回本位币列的才是「没真识别出来」，这些要提示人确认。
                        "needsConfirmation": rank <= 1,
                    }),
                )
            },
        )
        .collect()
}

fn currency_for(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    account: &str,
    params: &Value,
) -> String {
    // 用户为单个科目指定的币种是显式覆盖，永远最优先。
    //
    // 先按完整科目名精确取，取不到再退到科目编码——TB 与 JE 的科目名拼法常常
    // 不同（TB 是「编码 一级名 二级名」，JE 是「编码 科目文本」），界面上勾的是
    // 两边科目的并集，只按全名匹配会让用户指定的币种只对一侧生效。
    // 这与 `role_for` 里科目角色的匹配方式保持一致。
    if let Some(overrides) = params.get("accountCurrencies").and_then(Value::as_object) {
        let key = normalized_account_match_key(account);
        if let Some(code) = overrides
            .get(account)
            .and_then(Value::as_str)
            .or_else(|| {
                overrides.iter().find_map(|(candidate, value)| {
                    (normalized_account_match_key(candidate) == key)
                        .then(|| value.as_str())
                        .flatten()
                })
            })
            .map(normalize_currency)
            .filter(|code| !code.is_empty())
        {
            return code;
        }
    }
    // 其次是币种列。映射阶段已经把“整列同值”的列排除在交易币种之外，
    // 所以这里映射上的币种列就是可信的逐科目币种。
    let mapped = normalize_currency(cell(row, mapping, "currency"));
    if !mapped.is_empty() {
        return mapped;
    }
    // 没有币种列时才看科目名称/科目文本里的币种线索。
    if let Some(hint) = currency_text_hint(row, mapping).or_else(|| currency_from_text(account)) {
        return hint;
    }
    // 线索也没有时，该行就是本位币业务。优先读取表内本位币列；没有这列
    // （用友 JE 很常见）则按该行所属主体的已确认本位币兜底。
    let mapped_functional = normalize_currency(cell(row, mapping, "functionalCurrency"));
    if !mapped_functional.is_empty() {
        mapped_functional
    } else {
        functional_currency(entity_for(row, mapping, params), params)
    }
}

// TB 与 JE 共有的字段必须落在同一口径上：科目编码对科目编码、科目名称对
// 科目名称。这里把两边映射列的实际取值收上来做交叉比对，专治“TB 的科目编码
// 其实映射到了科目名称列”这类脚本和 LLM 都可能犯的错。
fn source_spec(params: &Value, source_key: &str) -> Result<Option<SourceSpec>, AppError> {
    let Some(source) = params.get(source_key) else {
        return Ok(None);
    };
    serde_json::from_value(source.clone())
        .map(Some)
        .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))
}

fn je_uses_disk(params: &Value) -> bool {
    source_spec(params, "jeSource")
        .ok()
        .flatten()
        .is_some_and(|source| tabular::disk_ledger_applies(Path::new(&source.input_path)))
}

// 口径比对不需要全量数据：大文件先用识别用的样本表，比对不通过要去找替代列时
// 再读全量。否则每点一次“复核映射”都要把三十多万行的凭证明细整份读一遍。
fn load_side(
    params: &Value,
    mapping_key: &str,
    source_key: &str,
) -> Result<Option<(Arc<FxTable>, Map<String, Value>)>, AppError> {
    let Some(spec) = source_spec(params, source_key)? else {
        return Ok(None);
    };
    Ok(Some((
        load_fx_inspection_table(&spec)?,
        mapping_obj(params, mapping_key),
    )))
}

fn load_full_side(params: &Value, source_key: &str) -> Result<Option<Arc<FxTable>>, AppError> {
    let Some(spec) = source_spec(params, source_key)? else {
        return Ok(None);
    };
    load_fx_table(&spec).map(Some)
}

fn role_values(table: &FxTable, mapping: &Map<String, Value>, role: &str) -> Vec<String> {
    let indexes = mapped_cols(mapping, role)
        .iter()
        .filter_map(|column| table.headers.iter().position(|header| header == column))
        .collect::<Vec<_>>();
    if indexes.is_empty() {
        return Vec::new();
    }
    table
        .rows
        .iter()
        .take(100_000)
        .map(|row| {
            indexes
                .iter()
                .filter_map(|index| row.get(*index))
                .map(|value| normalized_account_role_value(value.trim(), role))
                .map(|value| {
                    if role == "accountCode" {
                        ledger_mapping::normalize_account_code(value)
                    } else {
                        value.trim().to_uppercase()
                    }
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 逐行取得公共匹配策略需要的（主体、编码、名称）。这里只读已确认映射列，
/// 不从别的文本列猜编码；混写列则由公共内核拆分。
fn account_identity_rows(
    table: &FxTable,
    mapping: &Map<String, Value>,
) -> Vec<(String, String, String)> {
    let code_indexes = mapped_cols(mapping, "accountCode")
        .iter()
        .filter_map(|column| ledger_mapping::header_index(&table.headers, column))
        .collect::<Vec<_>>();
    let name_indexes = mapped_cols(mapping, "accountName")
        .iter()
        .filter_map(|column| ledger_mapping::header_index(&table.headers, column))
        .collect::<Vec<_>>();
    table
        .rows
        .iter()
        .take(100_000)
        .map(|row| {
            let joined = |indexes: &[usize]| {
                indexes
                    .iter()
                    .filter_map(|index| row.get(*index))
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            let raw_code = joined(&code_indexes);
            let raw_name = joined(&name_indexes);
            let code = ledger_mapping::account_code_of(&raw_code);
            let name = if raw_name.is_empty() {
                ledger_mapping::account_name_of(&raw_code)
            } else {
                ledger_mapping::account_name_of(&raw_name)
            };
            // 字段口径核对只判断两列是不是同一种科目身份；主体列可能只在
            // 一侧存在，不能让它干扰科目列本身的判断。正式业务汇总仍按主体建键。
            (String::new(), code, name)
        })
        .filter(|(_, code, name)| !code.is_empty() || !name.is_empty())
        .collect()
}

/// 跨表匹配只关心**两侧都出现**的歧义编码的复合键。
///
/// 歧义集合按两侧并集统计（`AccountMatchPolicy::from_sides`），但一侧内部
/// 把某编码拆成多个名称（TB 按币种/辅助核算分行）而另一侧根本不用该编码时，
/// 这个歧义不影响两表按编码匹配——此前把它一并算进复合核对，JE 侧永远凑不出
/// 对应键，合法账套（仅未实现模式、本位币序时账）被整体拦下。
fn shared_ambiguous_account_keys(
    je: &[(String, String, String)],
    tb: &[(String, String, String)],
    policy: &ledger_mapping::AccountMatchPolicy,
) -> (HashSet<String>, HashSet<String>) {
    let normalized_codes = |rows: &[(String, String, String)]| {
        rows.iter()
            .map(|(entity, code, _)| {
                (
                    entity.trim().to_uppercase(),
                    ledger_mapping::normalize_account_code(&ledger_mapping::account_code_of(code)),
                )
            })
            .collect::<HashSet<_>>()
    };
    let je_side = normalized_codes(je);
    let tb_side = normalized_codes(tb);
    let shared = je_side
        .intersection(&tb_side)
        .cloned()
        .collect::<HashSet<_>>();
    let keys = |rows: &[(String, String, String)]| {
        rows.iter()
            .filter(|(entity, code, _)| {
                shared.contains(&(
                    entity.trim().to_uppercase(),
                    ledger_mapping::normalize_account_code(&ledger_mapping::account_code_of(code)),
                )) && policy.is_ambiguous(entity, code)
            })
            .map(|(entity, code, name)| policy.account_key(entity, code, name))
            .filter(|key| !key.is_empty())
            .collect::<HashSet<String>>()
    };
    (keys(je), keys(tb))
}

/// TB 常把“科目编码:科目名称”或“上级编码/名称”放在同一格。
/// 跨表口径复核要先拆分再与 JE 的独立编码/名称列比较。
fn normalized_account_role_value<'a>(value: &'a str, role: &str) -> &'a str {
    let Some((code, name)) = split_combined_account_value(value) else {
        return value;
    };
    match role {
        "accountCode" => code,
        "accountName" => name,
        _ => value,
    }
}

fn split_combined_account_value(value: &str) -> Option<(&str, &str)> {
    for delimiter in [':', '：', '/', '／', '|'] {
        let Some((left, right)) = value.split_once(delimiter) else {
            continue;
        };
        let code = left.trim();
        let name = right.trim();
        let code_like = code.len() >= 2
            && code.chars().any(|character| character.is_ascii_digit())
            && code.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            });
        if code_like && !name.is_empty() {
            return Some((code, name));
        }
    }
    None
}

/// 逐列收集去重取值。科目编码、科目名称都是“低基数”列（几十到几百个不同值），
/// 凭证号、金额、日期、摘要则是高基数，超过上限就直接弃掉——这一条就把
/// 需要两两比对的列压到个位数。
fn low_cardinality_columns(table: &FxTable) -> Vec<(String, HashSet<String>)> {
    const MAX_CARDINALITY: usize = 3000;
    const MIN_CARDINALITY: usize = 5;
    const MAX_ROWS: usize = 100_000;
    let mut sets = (0..table.headers.len())
        .map(|_| Some(HashSet::new()))
        .collect::<Vec<_>>();
    for row in table.rows.iter().take(MAX_ROWS) {
        for (index, slot) in sets.iter_mut().enumerate() {
            let Some(values) = slot.as_mut() else {
                continue;
            };
            let Some(raw) = row.get(index) else {
                continue;
            };
            let value = raw.trim();
            if value.is_empty() {
                continue;
            }
            values.insert(value.to_uppercase());
            if values.len() > MAX_CARDINALITY {
                *slot = None;
            }
        }
    }
    table
        .headers
        .iter()
        .zip(sets)
        .filter_map(|(header, values)| {
            values
                .filter(|set| set.len() >= MIN_CARDINALITY)
                .map(|set| (header.clone(), set))
        })
        .collect()
}

fn looks_like_account_code(values: &HashSet<String>) -> bool {
    let sample = values.iter().take(200).collect::<Vec<_>>();
    if sample.is_empty() {
        return false;
    }
    let coded = sample
        .iter()
        .filter(|value| {
            value.chars().count() >= 2
                && value.chars().count() <= 24
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
        .count();
    coded * 5 >= sample.len() * 4
}

/// 在两张表的低基数列之间找取值真正对得上的一对。want_code 决定找的是编码类
/// 还是名称类，两类分别找一次，就实现了“优先两个都对上，否则择一”。
fn best_column_pair(
    je: &[(String, HashSet<String>)],
    tb: &[(String, HashSet<String>)],
    want_code: bool,
) -> Option<(String, String, usize, f64)> {
    let mut best: Option<(String, String, usize, f64)> = None;
    for (je_header, je_values) in je {
        if looks_like_account_code(je_values) != want_code {
            continue;
        }
        for (tb_header, tb_values) in tb {
            if looks_like_account_code(tb_values) != want_code {
                continue;
            }
            let overlap = je_values.intersection(tb_values).count();
            if overlap < 5 {
                continue;
            }
            let ratio = overlap as f64 / je_values.len().min(tb_values.len()) as f64;
            if ratio < 0.6 {
                continue;
            }
            if best.as_ref().is_none_or(|current| {
                ratio > current.3 || (ratio == current.3 && overlap > current.2)
            }) {
                best = Some((je_header.clone(), tb_header.clone(), overlap, ratio));
            }
        }
    }
    best
}

fn overlap_ratio(je: &[String], tb: &[String]) -> Option<(usize, f64)> {
    if je.is_empty() || tb.is_empty() {
        return None;
    }
    let tb_set = tb
        .iter()
        .map(|value| value.trim().to_uppercase())
        .collect::<HashSet<_>>();
    let overlap = je
        .iter()
        .filter(|value| tb_set.contains(&value.trim().to_uppercase()))
        .count();
    Some((overlap, overlap as f64 / je.len() as f64))
}

// 抽首、中、末三个取值当证据，让用户一眼看出两边是不是同一种字段。
fn three_samples(values: &[String]) -> String {
    let last = values.len().saturating_sub(1);
    [0usize, values.len() / 2, last]
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|index| values.get(index).cloned())
        .collect::<Vec<_>>()
        .join("、")
}

// TB 与 JE 共有的字段必须落在同一口径上：科目编码对科目编码、科目名称对
// 科目名称。先按当前映射比对；对不上就在两张表的所有低基数列之间自己找一组
// 真正能对上的列，找到就作为修正建议回给前端直接套用。
fn cross_table_alignment(
    params: &Value,
) -> Result<(Vec<String>, Vec<String>, Option<Value>), AppError> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let (Some((je_table, je_mapping)), Some((tb_table, tb_mapping))) = (
        load_side(params, "jeMapping", "jeSource")?,
        load_side(params, "tbMapping", "tbSource")?,
    ) else {
        return Ok((errors, warnings, None));
    };
    // 币种口径也顺带核一下，但只提示不拦截：两张表的币种范围本来就可能不同。
    if let Some((overlap, _)) = overlap_ratio(
        &role_values(&je_table, &je_mapping, "currency"),
        &role_values(&tb_table, &tb_mapping, "currency"),
    ) {
        if overlap == 0 {
            warnings.push("JE与TB的币种没有任何交集，请确认两边映射的是同一种币种字段。".into());
        }
    }
    let je_codes = role_values(&je_table, &je_mapping, "accountCode");
    let tb_codes = role_values(&tb_table, &tb_mapping, "accountCode");
    if let Some((overlap, ratio)) = overlap_ratio(&je_codes, &tb_codes) {
        if overlap > 0 {
            if ratio < 0.1 {
                warnings.push(format!(
                    "JE与TB的科目编码仅有 {overlap}/{} 项能对上，请复核两边映射是否同一口径。JE样例：{}；TB样例：{}。",
                    je_codes.len().min(tb_codes.len()),
                    three_samples(&je_codes),
                    three_samples(&tb_codes)
                ));
            }
            let je_identities = account_identity_rows(&je_table, &je_mapping);
            let tb_identities = account_identity_rows(&tb_table, &tb_mapping);
            let policy =
                ledger_mapping::AccountMatchPolicy::from_sides(&tb_identities, &je_identities);
            if policy.ambiguous_count() == 0 {
                // 编码已经可靠且一一对应时，名称只是展示文本。TB 常用标准科目名，
                // JE 常用带账号的账户全称，强制名称相等只会制造无意义的纠偏提示。
                return Ok((errors, warnings, None));
            }
            let (je_keys, tb_keys) =
                shared_ambiguous_account_keys(&je_identities, &tb_identities, &policy);
            if je_keys.is_empty() && tb_keys.is_empty() {
                // 歧义编码只在单侧出现：另一侧不用它，按编码匹配不受影响。
                warnings.push(format!(
                    "检测到 {} 个科目编码在单侧对应多个名称（另一侧未使用该编码），不影响两表按科目编码匹配。",
                    policy.ambiguous_count()
                ));
                return Ok((errors, warnings, None));
            }
            let composite_overlap = je_keys.intersection(&tb_keys).count();
            let composite_base = je_keys.len().min(tb_keys.len());
            if composite_overlap > 0
                && composite_base > 0
                && composite_overlap * 5 >= composite_base * 3
            {
                warnings.push(format!(
                    "检测到 {} 个科目编码对应多个名称，公共引擎已按“科目编码＋科目名称”匹配（其中 {composite_overlap}/{composite_base} 个复合科目一致）。",
                    policy.ambiguous_count()
                ));
                return Ok((errors, warnings, None));
            }

            // 编码确有歧义但当前名称不足以消歧时，尝试从全表找到真正一致的名称列。
            let je_full = load_full_side(params, "jeSource")?.unwrap_or(je_table);
            let tb_full = load_full_side(params, "tbSource")?.unwrap_or(tb_table);
            let je_columns = low_cardinality_columns(&je_full);
            let tb_columns = low_cardinality_columns(&tb_full);
            if let Some((je_header, tb_header, name_overlap, _)) =
                best_column_pair(&je_columns, &tb_columns, false)
            {
                warnings.push(format!(
                    "科目编码存在一对多，当前名称无法消歧；已自动改用取值一致的名称列：JE“{je_header}”对 TB“{tb_header}”（{name_overlap} 项一致），后续按科目编码＋科目名称匹配。"
                ));
                return Ok((
                    errors,
                    warnings,
                    Some(json!({
                        "jeMapping": {"accountName": je_header},
                        "tbMapping": {"accountName": tb_header}
                    })),
                ));
            }
            errors.push(format!(
                "检测到同一科目编码对应多个名称，但JE与TB的科目名称无法形成可靠的复合匹配。编码样例：{}；请确认两边科目名称映射后重试。",
                three_samples(&je_codes)
            ));
            return Ok((errors, warnings, None));
        }
    }

    // 当前编码列对不上时，优先在全量数据中纠正编码映射；编码始终是第一选择。
    let je_full = load_full_side(params, "jeSource")?.unwrap_or(je_table);
    let tb_full = load_full_side(params, "tbSource")?.unwrap_or(tb_table);
    if let Some(aligned) = ledger_mapping::align_account_code_columns(
        &je_full.headers,
        &je_full.rows,
        &tb_full.headers,
        &tb_full.rows,
    ) {
        warnings.push(format!(
            "JE与TB的科目编码原映射对不上，已自动改用取值真正一致的列：JE“{}”对 TB“{}”（{} 项一致）。",
            aligned.je_column, aligned.tb_column, aligned.overlap
        ));
        return Ok((
            errors,
            warnings,
            Some(json!({
                "jeMapping": {"accountCode": aligned.je_column},
                "tbMapping": {"accountCode": aligned.tb_column}
            })),
        ));
    }

    // 没有可用编码时才退到名称；名称必须在两侧有真实取值交集。
    let je_names = role_values(&je_full, &je_mapping, "accountName");
    let tb_names = role_values(&tb_full, &tb_mapping, "accountName");
    if overlap_ratio(&je_names, &tb_names).is_some_and(|(overlap, _)| overlap > 0) {
        warnings.push("JE与TB没有可可靠对齐的科目编码，已按科目名称继续匹配。".into());
        return Ok((errors, warnings, None));
    }
    let je_columns = low_cardinality_columns(&je_full);
    let tb_columns = low_cardinality_columns(&tb_full);
    if let Some((je_header, tb_header, overlap, _)) =
        best_column_pair(&je_columns, &tb_columns, false)
    {
        warnings.push(format!(
            "JE与TB的科目名称原映射对不上，已自动改用取值真正一致的列：JE“{je_header}”对 TB“{tb_header}”（{overlap} 项一致）。"
        ));
        return Ok((
            errors,
            warnings,
            Some(json!({
                "jeMapping": {"accountName": je_header},
                "tbMapping": {"accountName": tb_header}
            })),
        ));
    }
    errors.push(format!(
        "JE与TB的科目编码和科目名称都对不上，两张表里也找不到取值能对上的列。JE编码样例：{}；TB编码样例：{}。请手工确认两边映射到的是同一套科目。",
        three_samples(&je_codes),
        three_samples(&tb_codes)
    ));
    Ok((errors, warnings, None))
}

pub(crate) fn check_mapping_alignment(params: &Value) -> Result<Value, AppError> {
    let (errors, warnings, fix) = cross_table_alignment(params)?;
    Ok(json!({
        "aligned": errors.is_empty(),
        "errors": errors,
        "warnings": warnings,
        "fix": fix
    }))
}

fn validate_mapping(params: &Value) -> Result<Value, AppError> {
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let report_year = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .map(|date| date.year());
    if matches!(mode, "realized" | "combined") && params.get("jeSource").is_none() {
        errors.push("已实现测算必须上传JE".to_string());
    }
    if matches!(mode, "unrealized" | "combined") && params.get("tbSource").is_none() {
        errors.push("未实现测算必须上传TB".to_string());
    }
    for (kind, key, source_key) in [
        ("JE", "jeMapping", "jeSource"),
        ("TB", "tbMapping", "tbSource"),
    ] {
        if let Some(src) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(src.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let mapping = mapping_obj(params, key);
            let raw_table = load_fx_table(&spec)?;
            // 校验和测算必须读同一份 JE：计算会向下填充合并单元格
            // 形态的凭证号、日期、科目等非金额字段，校验也应用这份清洗表。
            let table = if kind == "JE" {
                forward_filled_je_table(&raw_table, &mapping)
            } else {
                raw_table
            };
            let lower = if kind == "JE" { "je" } else { "tb" };
            let column_of = |role: &str| {
                mapping
                    .iter()
                    .filter(|(mapped_role, _)| {
                        ledger_mapping::migrate_role_name(lower, mapped_role) == role
                    })
                    .flat_map(|(mapped_role, _)| mapped_cols(&mapping, mapped_role))
                    .collect::<Vec<_>>()
            };
            let amount_issues = ledger_mapping::mapped_amount_parse_issues(
                lower,
                &table.headers,
                &table.rows,
                &column_of,
            );
            for issue in amount_issues.iter().take(5) {
                let source_row = table.header_row + table.header_depth + issue.row_index;
                errors.push(format!(
                    "{kind} 金额列“{}”（{}）第{source_row}行必须解析为数值，实际为“{}”。",
                    issue.column, issue.label, issue.value
                ));
            }
            if amount_issues.len() > 5 {
                errors.push(format!(
                    "{kind} 另有 {} 个金额单元格无法解析为数值。",
                    amount_issues.len() - 5
                ));
            }
            if kind == "JE" {
                if let Some(entity_column) = first_col(&mapping, "entity") {
                    if ledger_mapping::entity_column_is_measurement_unit(
                        &table.headers,
                        &table.rows,
                        &entity_column,
                    ) {
                        errors.push(format!(
                            "JE 主体字段“{entity_column}”的取值是 KG、EA、BOX 等计量单位，不能作为公司/核算主体；请清除或改正主体映射。"
                        ));
                    }
                }
            }
            let data_years =
                source_data_years(&table, if kind == "JE" { "je" } else { "tb" }, &mapping);
            if let Some(year) = report_year {
                if !data_years.is_empty() && !data_years.contains(&year) {
                    errors.push(format!(
                        "资产负债表日为{year}年，但{kind}数据期间为{}年",
                        data_years
                            .iter()
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join("、")
                    ));
                }
            }
            // `__` 开头的是内部键（符号口径等），不是角色，不该拿去表头里找列。
            for col in mapping
                .iter()
                .filter(|(role, _)| !role.starts_with("__"))
                .map(|(_, value)| value)
                .flat_map(|v| match v {
                    Value::String(s) => vec![s.clone()],
                    Value::Array(a) => a
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                    _ => vec![],
                })
            {
                if !table.headers.contains(&col) {
                    errors.push(format!("{kind} 映射列不存在：{col}"));
                }
            }
            let required = if kind == "JE" {
                // 仅未实现模式下 JE 只是月度重估的辅助线索，TB 才是测算主体；
                // 序时账没有外币列是常态（本位币记账的账套全是这种），此时
                // 外币行识别不出、月度路径自然跳过，原币币种不再必填。
                if mode == "unrealized" {
                    vec!["id", "date", "accountCode"]
                } else {
                    vec!["id", "date", "accountCode", "currency"]
                }
            } else {
                vec!["accountCode"]
            };
            for role in required {
                // 历史参数把科目编码和名称合并在 "account" 里，仍视为已映射。
                let unmapped = if role == "accountCode" {
                    account_columns(&mapping).is_empty()
                } else {
                    mapped_cols(&mapping, role).is_empty()
                };
                if unmapped {
                    errors.push(format!(
                        "{kind} 缺少必填字段：{}（{role}）",
                        chinese_header(role)
                    ));
                }
            }
            if kind == "TB" && mode != "realized" && mapped_cols(&mapping, "currency").is_empty() {
                // 没有交易币种列时，至少要能从科目名称或币种线索文本里认出
                // 一个非本位币的科目，否则这张 TB 根本没有可测算的外币。
                let readable = records(&table).iter().take(5000).any(|row| {
                    let functional = normalize_currency(&functional_currency(
                        entity_for(row, &mapping, params),
                        params,
                    ));
                    currency_text_hint(row, &mapping)
                        .or_else(|| currency_from_text(&account_name(row, &mapping)))
                        .is_some_and(|code| code != functional)
                });
                if !readable {
                    let message = "TB 认不出任何外币科目：请映射含两种以上币种的交易币种列；若币种写在科目名称里，请把那一列映射为“科目名称”或“币种线索文本”。";
                    // TB 无外币数据时未实现部分不可做；但 JE 有汇兑损益
                    // 科目时，组合模式仍有可独立执行的已实现范围。
                    if mode == "combined" && je_has_fx_gain_loss_account(params)? {
                        warnings.push(format!(
                            "{message}本次将只测算 JE 中的已实现汇兑损益，未实现部分不出具结论。"
                        ));
                    } else {
                        errors.push(message.to_string());
                    }
                }
            }
            // 套一遍标准形态：命中说明这张表的余额与发生额结构完整，
            // 没命中就指名道姓缺哪几列。先只提示不阻断——历史上能跑通的映射
            // 不该因为多了一层校验就突然打不开。
            {
                let lower = if kind == "JE" { "je" } else { "tb" };
                let mapped: HashSet<&str> = mapping
                    .iter()
                    .filter(|(_, v)| !matches!(v, Value::Null))
                    .map(|(k, _)| ledger_mapping::migrate_role_name(lower, k))
                    .filter(|role| !role.is_empty())
                    .collect();
                if let ledger_mapping::FormVerdict::Incomplete(m) =
                    ledger_mapping::resolve_form(lower, &mapped)
                {
                    warnings.push(format!(
                        "{kind} {}",
                        ledger_mapping::describe_incomplete(lower, &m)
                    ));
                }
            }
            if !mapped_cols(&mapping, "accountCode").is_empty()
                && mapped_cols(&mapping, "accountName").is_empty()
            {
                warnings.push(format!(
                    "{kind} 未映射科目名称：底稿只能显示科目编码，科目角色也只能靠编码推断。"
                ));
            }
            if kind == "JE" {
                for (prefix, label) in [("foreign", "原币"), ("functional", "本位币")] {
                    // 仅未实现模式下原币金额跟着原币币种走：币种整列映射不了
                    // （本位币记账的序时账）时外币行无从识别，不必硬凑原币记法；
                    // 币种已映射而金额记法不成立仍要拦——月度测算会把外币
                    // 变动当 0 期初直通期末，那是悄悄算错。
                    if mode == "unrealized"
                        && prefix == "foreign"
                        && mapped_cols(&mapping, "currency").is_empty()
                    {
                        continue;
                    }
                    if !amount_scheme_ok(&mapping, prefix) {
                        errors.push(format!(
                            "JE {label}金额记法不成立：三种记法任选其一——只给「{label}净额」（借正贷负），\
                             或「{label}借方」＋「{label}贷方」两列，或「{label}净额」＋「借贷方向」。\
                             同时映射净额与借贷分列也可以，会优先按借贷分列取数。"
                        ));
                    }
                }
                let id_columns = mapped_cols(&mapping, "id");
                let entity_column = first_col(&mapping, "entity");
                let date_column = first_col(&mapping, "date");
                let mut seen_rows = HashSet::new();
                for (index, row) in table.rows.iter().enumerate() {
                    let value = |column: &Option<String>| {
                        column
                            .as_ref()
                            .and_then(|c| table.headers.iter().position(|h| h == c))
                            .and_then(|i| row.get(i))
                            .map(|v| v.trim())
                            .unwrap_or("")
                    };
                    let entity = if entity_column.is_some() {
                        value(&entity_column)
                    } else {
                        fixed_entity(params)
                    };
                    let parts = std::iter::once(entity.to_owned())
                        .chain(std::iter::once(value(&date_column).to_owned()))
                        .chain(id_columns.iter().map(|c| {
                            table
                                .headers
                                .iter()
                                .position(|h| h == c)
                                .and_then(|i| row.get(i))
                                .map(|v| v.trim().to_owned())
                                .unwrap_or_default()
                        }))
                        .collect::<Vec<_>>();
                    if parts.iter().skip(1).all(|value| value.is_empty()) {
                        continue;
                    }
                    if parts.iter().any(|v| v.is_empty()) {
                        errors.push(format!(
                            "JE 第{}行匹配ID存在空值",
                            table.header_row + table.header_depth + index
                        ));
                        break;
                    }
                    let full_row = row.join("\u{1f}");
                    if !seen_rows.insert(full_row) {
                        errors.push(format!(
                            "JE 存在重复明细行（源文件第{}行）",
                            table.header_row + table.header_depth + index
                        ));
                        break;
                    }
                }
            } else {
                if foreign_currency_columns(&table).len() > 1
                    && !params
                        .get("tbForeignCurrencyConfirmed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                {
                    errors.push(
                        "TB检测到多个包含非本位币的列，请确认系统预选的外币币种列".to_string(),
                    );
                }
                let opening_foreign = amount_scheme_ok(&mapping, "openingForeign");
                let opening_functional = amount_scheme_ok(&mapping, "openingFunctional");
                let closing_foreign = amount_scheme_ok(&mapping, "closingForeign");
                let closing_functional = amount_scheme_ok(&mapping, "closingFunctional");
                if !opening_foreign && !opening_functional {
                    errors.push("TB 缺少期初余额：原币或本位币余额至少映射一组".to_string());
                }
                if !closing_foreign && !closing_functional {
                    errors.push("TB 缺少期末余额：原币或本位币余额至少映射一组".to_string());
                }
                if params.get("jeSource").is_some()
                    && !((opening_foreign && closing_foreign)
                        || (opening_functional && closing_functional))
                {
                    errors.push("TB与JE强勾稽要求期初、期末至少有一组同口径余额：原币对原币，或本位币对本位币".to_string());
                }
                if !opening_foreign || !closing_foreign {
                    warnings.push("TB缺少完整原币端点：官方汇率倒算值仅用于未实现测算，不参与TB与JE余额勾稽。".to_string());
                }
                for (a, b) in [
                    ("openingForeignAmount", "closingForeignAmount"),
                    ("openingFunctionalAmount", "closingFunctionalAmount"),
                ] {
                    if first_col(&mapping, a).is_some()
                        && first_col(&mapping, a) == first_col(&mapping, b)
                    {
                        errors.push(format!("TB {a} 与 {b} 不能使用同一列"));
                    }
                }
                for role in [
                    "openingForeignAmount",
                    "openingForeignDebit",
                    "openingForeignCredit",
                    "openingFunctionalAmount",
                    "openingFunctionalDebit",
                    "openingFunctionalCredit",
                    "closingForeignAmount",
                    "closingForeignDebit",
                    "closingForeignCredit",
                    "closingFunctionalAmount",
                    "closingFunctionalDebit",
                    "closingFunctionalCredit",
                ] {
                    if let Some(col) = first_col(&mapping, role) {
                        let idx = table.headers.iter().position(|h| h == &col).unwrap();
                        let non_empty = table
                            .rows
                            .iter()
                            .filter_map(|r| r.get(idx))
                            .filter(|v| !v.trim().is_empty() && !is_placeholder(v))
                            .collect::<Vec<_>>();
                        let bad = non_empty
                            .iter()
                            .filter(|v| strict_number(v).is_err())
                            .count();
                        if !non_empty.is_empty()
                            && ((non_empty.len() - bad) as f64 / non_empty.len() as f64) < 0.99
                        {
                            errors.push(format!("TB 关键余额列“{col}”有效数值比例低于99%"));
                        }
                    }
                }
                if let Some(currency_col) = first_col(&mapping, "currency") {
                    let index = table
                        .headers
                        .iter()
                        .position(|h| h == &currency_col)
                        .unwrap();
                    let supported = supported_currencies();
                    for (row_index, row) in table.rows.iter().enumerate() {
                        let raw = row.get(index).map(String::as_str).unwrap_or("");
                        let code = normalize_currency(raw);
                        if code.len() != 3 || !supported.contains(code.as_str()) {
                            errors.push(format!(
                                "TB 第{}行币种无法标准化或不在官方汇率覆盖范围：{}",
                                table.header_row + table.header_depth + row_index,
                                raw
                            ));
                            break;
                        }
                    }
                }
                let key_columns = ["entity", "currency"]
                    .into_iter()
                    .filter_map(|role| first_col(&mapping, role))
                    .chain(account_columns(&mapping))
                    .chain(mapped_cols(&mapping, "auxiliary"))
                    .collect::<Vec<_>>();
                let mut keys = HashSet::new();
                let mut duplicate_rows: Vec<usize> = Vec::new();
                for (row_index, row) in table.rows.iter().enumerate() {
                    let mut key = key_columns
                        .iter()
                        .map(|column| {
                            table
                                .headers
                                .iter()
                                .position(|h| h == column)
                                .and_then(|i| row.get(i))
                                .map(|v| v.trim())
                                .unwrap_or("")
                        })
                        .collect::<Vec<_>>()
                        .join("\u{1f}");
                    if key_columns.is_empty() || !mapped_cols(&mapping, "entity").is_empty() {
                        // already includes all mapped key dimensions
                    } else {
                        key = format!("{}\u{1f}{key}", fixed_entity(params));
                    }
                    if !keys.insert(key) {
                        duplicate_rows.push(table.header_row + table.header_depth + row_index);
                    }
                }
                // 同一余额键出现多行不是错误：客户常按费用性质、成本中心一类的核算
                // 维度把一个科目拆开（3300 那份 TB 的 245 行对应 206 个科目）。
                // 重估按科目＋币种做，这几行乘的是同一个汇率，合并求和与逐行重估
                // 再相加完全等价，所以直接合并，只说明不拦截。
                if !duplicate_rows.is_empty() {
                    let shown = duplicate_rows
                        .iter()
                        .take(3)
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("、");
                    warnings.push(format!(
                        "TB 有 {} 行与其他行的余额键相同（主体＋科目＋币种），已按同一余额键合并期初与期末余额；如第{shown}行。若这些行本应各自独立，请把区分它们的那一列映射为辅助核算。",
                        duplicate_rows.len()
                    ));
                }
                // ── TB 自身逐行勾稽：期初＋本年累计借方−本年累计贷方＝期末 ──
                //
                // 判定本身抽到了 [`tb_self_rollforward`]，TBJE 完整性核对要拿同一份
                // 结论出结构化明细；这里只负责把它写成给用户看的一句话。
                // 只提示不拦截：实务余额表常见尾差、审计调整前后口径差异都会造成
                // 个别行不平，单行交给用户判断。这条检查的价值在于把「期初/期末列
                // 映射反了、借贷列拿错」这类系统性错误在上传阶段就暴露出来。
                for unit in tb_self_rollforward(&table, &mapping) {
                    if unit.issues.is_empty() {
                        continue;
                    }
                    let shown = unit
                        .issues
                        .iter()
                        .take(3)
                        .map(|issue| {
                            format!(
                                "第{}行（{}，差{:.2}）",
                                issue.source_row, issue.account, issue.difference
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("、");
                    let label = unit.unit;
                    warnings.push(format!(
                        "TB 自身勾稽（{label}口径）：{} / {}行不满足 期初＋本年累计借方−本年累计贷方＝期末，如{shown}。请检查期初/期末/借贷方向列是否映射正确或数据是否存在尾差；本提示不拦截测算。",
                        unit.issues.len(),
                        unit.checked
                    ));
                }
            }
        }
    }
    let (cross_errors, cross_warnings, _) = cross_table_alignment(params)?;
    errors.extend(cross_errors);
    warnings.extend(cross_warnings);
    if mode == "unrealized" && params.get("jeSource").is_none() {
        warnings.push("未上传JE：仅执行年初、年末两时点检查；仅年末差异作为建议调整。".to_string());
    }
    Ok(json!({"valid": errors.is_empty(), "errors": errors, "warnings": warnings}))
}

/// 借贷方向现在是两个币种口径共用的一个角色。历史保存的映射里可能还是
/// `foreignDirection` / `functionalDirection`，两种都要能读出来。
fn direction_column(mapping: &Map<String, Value>, prefix: &str) -> Option<String> {
    if first_col(mapping, "direction").is_some() {
        return Some("direction".to_string());
    }
    // 金额前缀带着币种口径（`openingFunctional`／`closingForeign`），而方向角色
    // 只有 `openingDirection`／`closingDirection` 两个——原币与本位币共用一个
    // 方向列。不剥掉口径后缀就永远拼不出真实角色名：TB 的「净额＋方向」形态
    // （02／08／09 号样例）折算时方向列从来没生效过，负债和权益整片翻号，
    // 勾稽也跟着报出大批假不平。
    let base = prefix
        .strip_suffix("Functional")
        .or_else(|| prefix.strip_suffix("Foreign"))
        .unwrap_or(prefix);
    let role = format!("{base}Direction");
    if first_col(mapping, &role).is_some() {
        return Some(role);
    }
    let legacy = format!("{prefix}Direction");
    first_col(mapping, &legacy).map(|_| legacy)
}

/// TB 自身勾稽的一条不平记录。
pub(crate) struct RollforwardIssue {
    pub(crate) source_row: usize,
    pub(crate) account: String,
    pub(crate) opening: f64,
    pub(crate) debit: f64,
    pub(crate) credit: f64,
    pub(crate) closing: f64,
    pub(crate) difference: f64,
}

/// 一个币种口径下的勾稽结果。
pub(crate) struct RollforwardUnit {
    pub(crate) unit: &'static str,
    pub(crate) checked: usize,
    pub(crate) issues: Vec<RollforwardIssue>,
}

/// TB 自身逐行勾稽：**期初 ＋ 本年累计借方 − 本年累计贷方 ＝ 期末**。
///
/// 余额沿用 [`signed_amount`] 的借正贷负规则，发生额走 [`side_amounts`]，把
/// “贷方列为负数”的已带符号口径统一翻回贷方侧后再套等式；
/// 借贷方向列与借贷双栏两种记法都适用；
/// 原币、本位币两个口径各自独立验一遍，四样字段不齐的口径跳过。
///
/// 汇总行**不排除**——父科目行的期初＋发生额同样应当等于期末，它不平一样是问题。
/// 但没有身份的噪声行要剔掉：那种行只有一格金额、其余全空，算出来必然不平，
/// 报出来纯属噪音。
pub(crate) fn tb_self_rollforward(
    table: &FxTable,
    mapping: &Map<String, Value>,
) -> Vec<RollforwardUnit> {
    tb_self_rollforward_with_mask(table, mapping, None)
}

/// [`tb_self_rollforward`] 的本位币行范围入口。`functional_row_mask` 与数据行
/// 一一对应，`true` 才参与本位币勾稽；明确映射的原币金额仍核对全量行，
/// 二者都不改变源行号。
pub(crate) fn tb_self_rollforward_with_mask(
    table: &FxTable,
    mapping: &Map<String, Value>,
    functional_row_mask: Option<&[bool]>,
) -> Vec<RollforwardUnit> {
    let junk = ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &|role| {
        mapped_cols(mapping, role)
    });
    let row_records = records(table);
    let mut out = Vec::new();
    for (opening_prefix, closing_prefix, movement_prefix, ytd_debit, ytd_credit, unit) in [
        (
            "openingFunctional",
            "closingFunctional",
            "ytdFunctional",
            "ytdFunctionalDebit",
            "ytdFunctionalCredit",
            "本位币",
        ),
        (
            "openingForeign",
            "closingForeign",
            "ytdForeign",
            "ytdForeignDebit",
            "ytdForeignCredit",
            "原币",
        ),
    ] {
        if first_col(mapping, ytd_debit).is_none() || first_col(mapping, ytd_credit).is_none() {
            continue;
        }
        if !amount_scheme_ok(mapping, opening_prefix) || !amount_scheme_ok(mapping, closing_prefix)
        {
            continue;
        }
        let mut checked = 0usize;
        let mut issues = Vec::new();
        for (index, row) in row_records.iter().enumerate() {
            if unit == "本位币"
                && functional_row_mask
                    .is_some_and(|mask| !mask.get(index).copied().unwrap_or(false))
            {
                continue;
            }
            if !junk.get(index).copied().unwrap_or(true) {
                continue;
            }
            // 四个数里解析失败或借贷发生额缺失的行跳过——坏列由「有效数值比例
            // 低于99%」负责拦截，这里不重复报。
            let (Ok(opening), Ok(closing), Ok((debit, credit))) = (
                signed_amount(row, mapping, opening_prefix),
                signed_amount(row, mapping, closing_prefix),
                side_amounts(row, mapping, movement_prefix),
            ) else {
                continue;
            };
            if opening == 0.0 && closing == 0.0 && debit == 0.0 && credit == 0.0 {
                continue;
            }
            checked += 1;
            let derived = opening + debit - credit;
            let difference = derived - closing;
            let tolerance =
                0.01_f64.max(opening.abs().max(closing.abs().max(derived.abs())) * 1e-8);
            if difference.abs() > tolerance {
                issues.push(RollforwardIssue {
                    source_row: row.source_row,
                    account: account_name(row, mapping),
                    opening,
                    debit,
                    credit,
                    closing,
                    difference,
                });
            }
        }
        out.push(RollforwardUnit {
            unit,
            checked,
            issues,
        });
    }
    out
}

fn amount_scheme_ok(mapping: &Map<String, Value>, prefix: &str) -> bool {
    let amount = first_col(mapping, &format!("{prefix}Amount")).is_some();
    let direction = direction_column(mapping, prefix).is_some();
    let debit = first_col(mapping, &format!("{prefix}Debit")).is_some();
    let credit = first_col(mapping, &format!("{prefix}Credit")).is_some();
    (amount && !debit && !credit)
        || (debit && credit && !amount)
        || (amount && direction && !debit && !credit)
}

/// 只有「本期借／贷」而没有「本年累计借／贷」时，用 TB 自身勾稽
/// `期初 + 本期借 - 本期贷 = 期末` 验证这两列是否覆盖了期初到期末的
/// 全部发生额。通过后把它们提升到标准 YTD 角色，下游不再保留一套
/// 「本期也算完整」的例外。
///
/// 自动通过阈值：3–9 个有效区分行必须 100% 成立；10 行及以上成立率
/// 不低于 95%；少于 3 行不自动提升。贷方为零时无法区分加减口径，
/// 不计入有效行。
pub(crate) fn promote_period_movement(table: &FxTable, mapping: &mut Map<String, Value>) -> bool {
    promote_period_movement_rows(&table.headers, &table.rows, mapping)
}

/// [`promote_period_movement`] 的无表结构入口。借款工具使用自己的轻量
/// `Table`，但 TB 自动提升必须与其他工具共用同一份规则，不为转换结构
/// 克隆整张大表。
pub(crate) fn promote_period_movement_rows(
    headers: &[String],
    rows: &[Vec<String>],
    mapping: &mut Map<String, Value>,
) -> bool {
    if first_col(mapping, "ytdFunctionalDebit").is_some()
        || first_col(mapping, "ytdFunctionalCredit").is_some()
    {
        return false;
    }
    let (Some(debit_column), Some(credit_column)) = (
        first_col(mapping, "periodFunctionalDebit"),
        first_col(mapping, "periodFunctionalCredit"),
    ) else {
        return false;
    };
    if !amount_scheme_ok(mapping, "openingFunctional")
        || !amount_scheme_ok(mapping, "closingFunctional")
    {
        return false;
    }

    let column_of = |role: &str| mapped_cols(mapping, role);
    let index_of = |role: &str| {
        column_of(role)
            .into_iter()
            .find_map(|name| ledger_mapping::header_index(headers, &name))
    };
    let (Some(debit_index), Some(credit_index)) = (
        ledger_mapping::header_index(headers, &debit_column),
        ledger_mapping::header_index(headers, &credit_column),
    ) else {
        return false;
    };
    let opening_self_signed =
        ledger_mapping::balance_self_signed(headers, rows, &column_of, "openingFunctional");
    let closing_self_signed =
        ledger_mapping::balance_self_signed(headers, rows, &column_of, "closingFunctional");
    let balance_at = |row: &[String], prefix: &str, self_signed: bool| -> Result<f64, String> {
        if let (Some(debit), Some(credit)) = (
            index_of(&format!("{prefix}Debit")),
            index_of(&format!("{prefix}Credit")),
        ) {
            let debit =
                ledger_mapping::parse_amount(row.get(debit).map(String::as_str).unwrap_or(""))?
                    .unwrap_or(0.0);
            let credit =
                ledger_mapping::parse_amount(row.get(credit).map(String::as_str).unwrap_or(""))?
                    .unwrap_or(0.0);
            return Ok(debit - credit);
        }
        let Some(amount) = index_of(&format!("{prefix}Amount")) else {
            return Err("余额列未映射".into());
        };
        let amount =
            ledger_mapping::parse_amount(row.get(amount).map(String::as_str).unwrap_or(""))?
                .unwrap_or(0.0);
        let base = prefix
            .strip_suffix("Functional")
            .or_else(|| prefix.strip_suffix("Foreign"))
            .unwrap_or(prefix);
        let direction = index_of(&format!("{base}Direction"))
            .or_else(|| index_of("direction"))
            .and_then(|index| row.get(index))
            .map(String::as_str)
            .unwrap_or("");
        if self_signed || direction.trim().is_empty() {
            Ok(amount)
        } else if ledger_mapping::is_credit_direction(direction) {
            Ok(-amount)
        } else {
            Ok(amount)
        }
    };
    let junk = ledger_mapping::ledger_junk_mask(headers, rows, &column_of);
    let mut eligible = 0usize;
    let mut passed = 0usize;
    for (index, row) in rows.iter().enumerate() {
        if !junk.get(index).copied().unwrap_or(true) {
            continue;
        }
        let (Ok(opening), Ok(closing), Ok(Some(debit)), Ok(Some(credit))) = (
            balance_at(row, "openingFunctional", opening_self_signed),
            balance_at(row, "closingFunctional", closing_self_signed),
            ledger_mapping::parse_amount(row.get(debit_index).map(String::as_str).unwrap_or("")),
            ledger_mapping::parse_amount(row.get(credit_index).map(String::as_str).unwrap_or("")),
        ) else {
            continue;
        };
        if credit.abs() <= f64::EPSILON {
            continue;
        }
        eligible += 1;
        let derived = opening + debit - credit;
        let difference = derived - closing;
        let scale = opening
            .abs()
            .max(closing.abs())
            .max(debit.abs())
            .max(credit.abs())
            .max(derived.abs());
        let tolerance = 0.01_f64.max(scale * 1e-8);
        if difference.abs() <= tolerance {
            passed += 1;
        }
    }
    let accepted = match eligible {
        0..=2 => false,
        3..=9 => passed == eligible,
        _ => passed * 100 >= eligible * 95,
    };
    if !accepted {
        return false;
    }
    mapping.insert("ytdFunctionalDebit".into(), Value::String(debit_column));
    mapping.insert("ytdFunctionalCredit".into(), Value::String(credit_column));
    mapping.remove("periodFunctionalDebit");
    mapping.remove("periodFunctionalCredit");
    true
}

/// 调查测试入口：只读，看某份表被判成哪种符号口径。
pub(crate) fn sign_probe_for_test(params: &Value) -> Result<Value, AppError> {
    let spec: SourceSpec = serde_json::from_value(params["source"].clone())
        .map_err(|e| error("INVALID_PARAMS", "来源无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = params["mapping"].as_object().cloned().unwrap_or_default();
    let column_of = |role: &str| -> Vec<String> { mapped_cols(&mapping, role) };
    let evidence = ledger_mapping::detect_sign_convention(&table.headers, &table.rows, &column_of);
    Ok(json!({
        "convention": evidence.convention.map(|c| c.as_str()),
        "scheme": evidence.scheme,
        "signedVotes": evidence.signed_votes,
        "unsignedVotes": evidence.unsigned_votes,
        "unbalanced": evidence.unbalanced,
        "oneSided": evidence.one_sided,
        "totalVouchers": evidence.total_vouchers,
        "trustworthy": ledger_mapping::sign_is_trustworthy(&evidence),
        "note": evidence.note,
    }))
}

/// 调查测试入口：只读，拿真实样例定位余额滚动失配。
pub(crate) fn rollforward_check_for_test(params: &Value) -> Result<Value, AppError> {
    validate_tb_je_balance_rollforward(params)
}

fn validate_tb_je_balance_rollforward(params: &Value) -> Result<Value, AppError> {
    let (Some(tb_source), Some(je_source)) = (params.get("tbSource"), params.get("jeSource"))
    else {
        return Ok(json!({"performed":false,"reason":"未同时上传TB和JE"}));
    };
    let tb_spec: SourceSpec = serde_json::from_value(tb_source.clone())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let tb_table = load_fx_table(&tb_spec)?;
    let mut tb_mapping = mapping_obj(params, "tbMapping");
    let mut je_mapping = mapping_obj(params, "jeMapping");
    let je_spec: SourceSpec = serde_json::from_value(je_source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let je_table = forward_filled_je_table(&load_fx_table(&je_spec)?, &je_mapping);
    // 独立测试入口可能没有符号标记，因此这里仍需确保口径存在；正式测算入口已经
    // 注入过标记，`ensure_sign_convention` 会直接复用，避免再次扫描整张 TB/JE。
    for (table, mapping, kind) in [
        (&tb_table, &mut tb_mapping, "tb"),
        (&je_table, &mut je_mapping, "je"),
    ] {
        ensure_sign_convention(table, mapping, kind)
            .map_err(|message| error("SIGN_CONVENTION_UNCERTAIN", &message, None))?;
    }
    let (tb_mapping, je_mapping) = (tb_mapping, je_mapping);
    let use_foreign = amount_scheme_ok(&tb_mapping, "openingForeign")
        && amount_scheme_ok(&tb_mapping, "closingForeign");
    let unit = if use_foreign { "foreign" } else { "functional" };
    let opening_prefix = if use_foreign {
        "openingForeign"
    } else {
        "openingFunctional"
    };
    let closing_prefix = if use_foreign {
        "closingForeign"
    } else {
        "closingFunctional"
    };
    let report_start = params
        .get("reportStart")
        .and_then(Value::as_str)
        .and_then(parse_date);
    let report_end = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .and_then(parse_date);
    let tb_identities = account_identities_for_matching(&tb_table, &tb_mapping, params);
    let je_identities = account_identities_for_matching(&je_table, &je_mapping, params);
    let account_policy =
        ledger_mapping::AccountMatchPolicy::from_sides(&tb_identities, &je_identities);
    // 辅助核算是可选的细化维度：**两边都映射了才启用**。启用后如果匹配不上，
    // 下面会自动退回粗粒度重跑一次——宁可粗一点也不要因为两边写法或粒度不同
    // 而全盘失配（实测 4800：TB 无辅助核算列、JE 按供应商客户拆行，332 个键全丢）。
    let both_have_auxiliary = !mapped_cols(&tb_mapping, "auxiliary").is_empty()
        && !mapped_cols(&je_mapping, "auxiliary").is_empty();
    let mut use_auxiliary = both_have_auxiliary;
    let mut attempt = |use_auxiliary: bool| -> Result<RollforwardAttempt, AppError> {
        let mut tb_balances = BTreeMap::<String, (String, String, String, String, f64, f64)>::new();
        // TB 侧认定要校验的余额键。JE 侧照它收行，保证两边口径一致。
        let mut wanted = HashSet::<String>::new();
        for row in tb_leaf_records(&tb_table, &tb_mapping) {
            let account = account_name(&row, &tb_mapping);
            if !matches!(
                role_for(&account, params).as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                continue;
            }
            let entity = entity_for(&row, &tb_mapping, params).to_owned();
            let (account_code, account_only_name) = account_code_and_name(&row, &tb_mapping);
            let currency = currency_for(&row, &tb_mapping, &account, params);
            let auxiliary = auxiliary_value(&row, &tb_mapping);
            if currency.is_empty() || currency == functional_currency(&entity, params) {
                continue;
            }
            let key = balance_match_key_with_policy(
                &entity,
                &account_code,
                &account_only_name,
                &auxiliary,
                use_auxiliary,
                &account_policy,
            );
            // 记下这个键要校验，JE 侧据此决定收哪些行——两边必须按同一个口径取数。
            wanted.insert(key.clone());
            let opening = signed_amount(&row, &tb_mapping, opening_prefix).map_err(|detail| {
                error("NUMERIC_PARSE_FAILED", "TB期初余额无法解析。", Some(detail))
            })?;
            let closing = signed_amount(&row, &tb_mapping, closing_prefix).map_err(|detail| {
                error("NUMERIC_PARSE_FAILED", "TB期末余额无法解析。", Some(detail))
            })?;
            // 键的粒度比源表粗时，同一个键会收到多行——必须累加而不是覆盖，
            // 否则同一科目下的其余币种/明细余额会被后来的行吃掉。
            let slot = tb_balances.entry(key).or_insert_with(|| {
                (
                    entity.clone(),
                    account.clone(),
                    currency.clone(),
                    auxiliary.clone(),
                    0.0,
                    0.0,
                )
            });
            // 展示用的币种：同一键下出现第二种币种时标注出来，免得报告里只显示其中一种。
            if slot.2 != currency && !currency.is_empty() {
                slot.2 = "多币种".to_string();
            }
            slot.4 += opening;
            slot.5 += closing;
        }
        let mut movements = HashMap::<String, f64>::new();
        let mut je_keys = BTreeMap::<String, (String, String, String, String)>::new();
        for row in records(&je_table) {
            if !is_je_business_row(&row, &je_mapping) {
                continue;
            }
            let Some(date) = parse_date(cell(&row, &je_mapping, "date")) else {
                continue;
            };
            if report_start.is_some_and(|start| date < start)
                || report_end.is_some_and(|end| date > end)
            {
                continue;
            }
            let account = account_name(&row, &je_mapping);
            if !matches!(
                role_for(&account, params).as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                continue;
            }
            let entity = entity_for(&row, &je_mapping, params).to_owned();
            let (account_code, account_only_name) = account_code_and_name(&row, &je_mapping);
            let currency = currency_for(&row, &je_mapping, &account, params);
            let auxiliary = auxiliary_value(&row, &je_mapping);
            let key = balance_match_key_with_policy(
                &entity,
                &account_code,
                &account_only_name,
                &auxiliary,
                use_auxiliary,
                &account_policy,
            );
            // **不按行的币种过滤**。TB 那一行是这个科目的全额余额（科目文本抽不出
            // 币种时，整个科目退回按本位币列判一个币种），JE 若只收「非本位币」的行，
            // 两边就不是同一批数据。实测 4800 的 1002990001 过渡银行：TB 全年轧平为 0，
            // JE 四种货币合计也是 0，但只收非本位币行就剩 −75,938,346.45——
            // 报错里那个差异数正是被切掉的本币交易。
            //
            // 本位币口径下这本来也没有意义：本位币金额是所有交易的统一计量，不分币种。
            // 该不该校验这个账户，由 TB 侧判定并写进 `wanted`，JE 侧只管按科目收全。
            if !wanted.contains(&key) {
                continue;
            }
            *movements.entry(key.clone()).or_default() += signed_amount(&row, &je_mapping, unit)
                .map_err(|detail| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "JE余额滚动金额无法解析。",
                        Some(detail),
                    )
                })?;
            je_keys
                .entry(key)
                .or_insert((entity, account, currency, auxiliary));
        }
        let mut issues = Vec::new();
        for (key, (entity, account, currency, auxiliary, opening, closing)) in &tb_balances {
            let movement = movements.get(key).copied().unwrap_or(0.0);
            let derived = opening + movement;
            let difference = derived - closing;
            let tolerance =
                0.01_f64.max(opening.abs().max(closing.abs()).max(derived.abs()) * 1e-8);
            if difference.abs() > tolerance {
                issues.push(json!({
                    "entity":entity,"account":account,"currency":currency,"auxiliary":auxiliary,
                    "unit":if use_foreign {"原币"} else {"本位币"},
                    "opening":opening,"jeMovement":movement,"derivedClosing":derived,
                    "tbClosing":closing,"difference":difference,"tolerance":tolerance
                }));
            }
        }
        for (key, (entity, account, currency, auxiliary)) in je_keys {
            if !tb_balances.contains_key(&key) {
                issues.push(json!({
                "entity":entity,"account":account,"currency":currency,"auxiliary":auxiliary,
                "unit":if use_foreign {"原币"} else {"本位币"},
                "type":"JE余额键在TB中不存在","jeMovement":movements.get(&key).copied().unwrap_or(0.0)
            }));
            }
        }
        Ok(RollforwardAttempt {
            issues,
            checked: tb_balances.len(),
        })
    };

    let mut outcome = attempt(use_auxiliary)?;
    // 「能匹配上」才算数：带辅助核算反而对不上时，退回公司＋科目编码重来一次。
    if use_auxiliary && !outcome.issues.is_empty() {
        let coarse = attempt(false)?;
        if coarse.issues.len() < outcome.issues.len() {
            use_auxiliary = false;
            outcome = coarse;
        }
    }
    let checked_keys = outcome.checked;
    let issues = outcome.issues;
    if !issues.is_empty() {
        let first = &issues[0];
        let summary = format!(
            "{}个账户币种余额键未通过TB＋JE余额滚动校验。首项：{} / {} / {}，差异{}。请修正映射或源数据后重新测算。",
            issues.len(),
            first.get("entity").and_then(Value::as_str).unwrap_or(""),
            first.get("account").and_then(Value::as_str).unwrap_or(""),
            first.get("currency").and_then(Value::as_str).unwrap_or(""),
            first
                .get("difference")
                .and_then(Value::as_f64)
                .unwrap_or_else(|| first
                    .get("jeMovement")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0))
        );
        // **提示，不阻断。** TB 与 JE 对不上多半是账本身的问题（取数期间不一致、
        // 某笔计提只记在一边），不该让整个测算跑不出来。失配明细原样带出去，
        // 界面上逐条列给用户看。
        //
        // 只有**按月推算余额**真正依赖 JE 的完整性——那部分自己看 `passed`
        // 决定要不要标成受限结果，见 `unrealizedBalanceBasisComplete`。
        return Ok(json!({
            "performed":true,"unit":if use_foreign {"原币"} else {"本位币"},
            "checkedBalanceKeys":checked_keys,"passed":false,"auxiliaryInKey":use_auxiliary,
            "summary":summary,"issues":issues
        }));
    }
    Ok(json!({
        "performed":true,"unit":if use_foreign {"原币"} else {"本位币"},
        "checkedBalanceKeys":checked_keys,"passed":true,"auxiliaryInKey":use_auxiliary,
        "issues":[]
    }))
}

/// 取数用的严格数值解析，**能力走统一内核**。
/// 本工具的策略是读不出就报错中断——错误处理归自己，解析能力不再自带一份。
fn strict_number(raw: &str) -> Result<Option<f64>, String> {
    ledger_mapping::parse_amount(raw)
}

fn is_placeholder(s: &str) -> bool {
    matches!(s.trim(), "-" | "—" | "–" | "N/A" | "n/a" | "NA" | "无")
}

/// 日期解析，**走统一内核**。内核那份合并了本工具与借款利息两边的覆盖面：
/// 多了英文月份缩写 `10-Jan-2023`，也会先切掉 `2023-01-10 00:00:00` 的时间段。
pub(crate) fn parse_date(s: &str) -> Option<NaiveDate> {
    ledger_mapping::parse_date(s)
}

/// 把序时账原样转成 JSON 行，供导出时写「JE完整明细」。
///
/// 单独成函数是因为它很贵：一份 36 万行、46 列的 SAP 序时账会产出上千万个
/// JSON 字符串。只有真的要写进底稿时才调用。
fn build_je_detail(params: &Value) -> Result<Vec<Value>, AppError> {
    let Some(_) = params.get("jeSource") else {
        return Ok(Vec::new());
    };
    let (table, _) = load_mapped_je_table(params)?;
    Ok(records(&table)
        .into_iter()
        .map(|row| {
            let mut value = row
                .iter()
                .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
                .collect::<Map<_, _>>();
            value.insert("sourceRow".into(), json!(row.source_row));
            Value::Object(value)
        })
        .collect())
}

pub(crate) fn records(table: &FxTable) -> Vec<RowRecord<'_>> {
    let header_index = Rc::new(
        table
            .headers
            .iter()
            .enumerate()
            .map(|(index, header)| (header.as_str(), index))
            .collect::<HashMap<_, _>>(),
    );
    table
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| RowRecord {
            source_row: table.header_row + table.header_depth + i,
            header_index: Rc::clone(&header_index),
            row,
        })
        .collect()
}

/// TB 业务计算统一只读取末级明细科目；层级判断由公共账表引擎负责。
fn tb_leaf_records<'a>(table: &'a FxTable, mapping: &Map<String, Value>) -> Vec<RowRecord<'a>> {
    let mask = ledger_mapping::tb_leaf_mask(&table.headers, &table.rows, &|role| {
        mapped_cols(mapping, role)
    });
    records(table)
        .into_iter()
        .zip(mask)
        .filter_map(|(row, leaf)| leaf.then_some(row))
        .collect()
}

fn cell<'a>(row: &'a RowRecord, mapping: &Map<String, Value>, role: &str) -> &'a str {
    first_col(mapping, role)
        .and_then(|c| row.get(c.as_str()))
        .unwrap_or("")
}

/// 检测两侧账表的符号口径，把结论写回参数里的映射。
///
/// 折算函数散在三十处调用点上，全都从 `params` 里取映射——在任务入口检测一次、
/// 写回参数，下游就无需逐个传参。检测本身走统一内核：JE 拿整张凭证配平投票，
/// TB 用勾稽等式投票，与看账、存款、借款判的是同一套。
///
/// 判不出来时必须中断并要求复核，不能静默套用「贷方记正数」。
fn detect_and_inject_sign_conventions(params: &mut Value) -> Result<(), AppError> {
    for (source_key, mapping_key, kind) in [
        ("jeSource", "jeMapping", "je"),
        ("tbSource", "tbMapping", "tb"),
    ] {
        let Some(spec) = params.get(source_key).cloned() else {
            continue;
        };
        let spec = serde_json::from_value::<SourceSpec>(spec)
            .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        let mut mapping = mapping_obj(params, mapping_key);
        ensure_sign_convention(&table, &mut mapping, kind)
            .map_err(|message| error("SIGN_CONVENTION_UNCERTAIN", &message, None))?;
        if let Some(object) = params.get_mut(mapping_key).and_then(Value::as_object_mut) {
            *object = mapping;
        }
    }
    Ok(())
}

/// 判定这份表的符号口径：**整个流程走统一内核**，这里只回答「角色对应哪一列」。
///
/// 上一轮我在这里另写了一份流程（取列、按凭证分组、按记法选投票函数），
/// 那是第五份重复实现——内核改了它不会跟着变，等于没统一。现已删除。
fn detect_sign_convention(
    table: &FxTable,
    mapping: &Map<String, Value>,
    kind: &str,
) -> Result<ledger_mapping::SignConvention, String> {
    let column_of = |role: &str| -> Vec<String> { mapped_cols(mapping, role) };
    let evidence = if kind == "tb" {
        ledger_mapping::detect_tb_sign_convention(&table.headers, &table.rows, &column_of)
    } else {
        ledger_mapping::detect_sign_convention(&table.headers, &table.rows, &column_of)
    };
    let direction_votes = evidence.signed_votes + evidence.unsigned_votes;
    let je_direction_is_trustworthy = if direction_votes == 0 {
        ledger_mapping::sign_is_trustworthy(&evidence)
    } else {
        let winner = evidence.signed_votes.max(evidence.unsigned_votes) as f64;
        let all_vouchers = direction_votes + evidence.unbalanced;
        // 不平凭证可能来自取数范围（例如只导出部分行），它们不能参与“哪种符号
        // 口径胜出”的分母。只要至少半数凭证能配平，且配平票对一种口径形成
        // 95% 以上的一致意见，就足以判断方向；否则仍然明确报错。
        winner / direction_votes as f64 >= ledger_mapping::SIGN_CONFIDENCE_FLOOR
            && direction_votes as f64 / all_vouchers.max(1) as f64 >= 0.50
    };
    let trustworthy = if kind == "je" {
        je_direction_is_trustworthy
    } else {
        ledger_mapping::sign_is_trustworthy(&evidence)
    };
    if !trustworthy {
        return Err(format!(
            "{}借贷方向无法可靠判断：凭证配平证据不足（已带符号 {} 票、借贷均为正 {} 票、未配平 {} 张）。请复核主体、日期、凭证号、方向及金额映射。{}",
            if kind == "je" { "JE" } else { "TB" },
            evidence.signed_votes,
            evidence.unsigned_votes,
            evidence.unbalanced,
            evidence
                .note
                .as_deref()
                .map(|note| format!(" {note}"))
                .unwrap_or_default()
        ));
    }
    evidence.convention.ok_or_else(|| {
        format!(
            "{}借贷方向无法可靠判断：{}请复核方向及金额映射。",
            if kind == "je" { "JE" } else { "TB" },
            evidence
                .note
                .as_deref()
                .map(|note| format!("{note}；"))
                .unwrap_or_default()
        )
    })
}

/// 映射里存放本表符号口径的键。
///
/// 折算函数散在三十处调用点上，每处都已经拿着 mapping——把口径塞进映射本身，
/// 就不必逐个改签名。键名带 `__` 前缀，与真实角色区分开。
const SIGN_CONVENTION_KEY: &str = "__signConvention";

/// 判定本表的符号口径并写进映射，供所有折算调用点共用。
///
/// **别的模块必须走这里**，不要自己再判一次：折算函数一律从映射里读这个键，
/// 读不到就按「贷方记正数」处理。余额本身已带符号的余额表（贷方是负数、
/// 旁边还冗余一个方向列）若被判成「贷方记正数」，负债和权益会被再乘一次 −1，
/// 整张表的会计恒等式差出两倍资产——实测样例上就是这么露出来的。
pub(crate) fn ensure_sign_convention(
    table: &FxTable,
    mapping: &mut Map<String, Value>,
    kind: &str,
) -> Result<(), String> {
    if mapping.contains_key(SIGN_CONVENTION_KEY) {
        if kind == "tb" {
            ensure_balance_sign_mode(table, mapping);
        }
        return Ok(());
    }
    let convention = match detect_sign_convention(table, mapping, kind) {
        Ok(convention) => convention,
        Err(_) if kind == "tb" => ledger_mapping::SignConvention::Unsigned,
        Err(message) => return Err(message),
    };
    mapping.insert(
        SIGN_CONVENTION_KEY.into(),
        Value::String(convention.as_str().to_owned()),
    );
    if kind == "tb" {
        ensure_balance_sign_mode(table, mapping);
    }
    Ok(())
}

/// 各账表工具共用的金额值门禁：已映射金额列的非空业务单元格必须能解析为数字。
pub(crate) fn validate_mapped_amount_values(
    table: &FxTable,
    mapping: &Map<String, Value>,
    kind: &str,
    label: &str,
    keep: Option<&[bool]>,
) -> Result<(), AppError> {
    let issues =
        ledger_mapping::mapped_amount_parse_issues(kind, &table.headers, &table.rows, &|role| {
            mapped_cols(mapping, role)
        })
        .into_iter()
        .filter(|issue| keep.is_none_or(|mask| mask.get(issue.row_index).copied().unwrap_or(false)))
        .collect::<Vec<_>>();
    if issues.is_empty() {
        return Ok(());
    }
    let detail = issues
        .iter()
        .take(20)
        .map(|issue| {
            format!(
                "{}（{}）第{}行=“{}”",
                issue.column,
                issue.label,
                table.header_row + table.header_depth + issue.row_index,
                issue.value
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    // 首处位置折进主文案：job 失败事件只回传 user_message，留在 detail 里
    // 用户看不到（与看账内存/磁盘路径同款措辞）。
    let first = &issues[0];
    Err(error(
        "AMOUNT_VALUE_INVALID",
        &format!(
            "{label}金额列「{}」第{}行的值“{}”无法解析为数值，请修正后重试。",
            first.column,
            table.header_row + table.header_depth + first.row_index,
            first.value.chars().take(80).collect::<String>()
        ),
        Some(if issues.len() > 20 {
            format!("{detail}；另有{}处未列出。", issues.len() - 20)
        } else {
            detail
        }),
    ))
}

/// 读取映射里的符号口径。与 [`ensure_sign_convention`] 配套。
pub(crate) fn sign_convention(mapping: &Map<String, Value>) -> ledger_mapping::SignConvention {
    sign_convention_of(mapping)
}

/// 读取本表的符号口径。没检测过时按「贷方记正数」处理，与历史行为一致。
fn sign_convention_of(mapping: &Map<String, Value>) -> ledger_mapping::SignConvention {
    match mapping.get(SIGN_CONVENTION_KEY).and_then(Value::as_str) {
        Some("signed") => ledger_mapping::SignConvention::Signed,
        _ => ledger_mapping::SignConvention::Unsigned,
    }
}

/// 折算成有符号净额（借正贷负），**走统一内核**。
///
/// 此前这里是本模块自己的一份实现，硬编码「贷方取负绝对值」且不判符号口径。
/// 红字冲销的贷方行本身记负数，取负绝对值会让冲销凭证永远抵不平；
/// 方向列的取值判定也只认 `CR` 和「贷」两种写法，认不出「Credit」「贷方」等。
pub(crate) fn signed_amount(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    prefix: &str,
) -> Result<f64, String> {
    let inputs = amount_inputs_of(row, mapping, prefix)?;
    // 余额列走 `signed_balance`：整列自带符号时方向列是冗余标注，不再翻号。
    // 发生额与凭证金额仍走 `signed_amount`，那里红字冲销必须靠方向翻正。
    let convention = sign_convention_of(mapping);
    Ok(
        if prefix.starts_with("opening") || prefix.starts_with("closing") {
            ledger_mapping::signed_balance(
                &inputs,
                convention,
                balance_self_signed(mapping, prefix),
            )
        } else {
            ledger_mapping::signed_amount(&inputs, convention)
        },
    )
}

/// 从映射与行取值构造 [`ledger_mapping::AmountInputs`]。
///
/// 借贷分列只在两列都映射时才成立——沿用本模块原有语义，
/// 只映射了一侧时按净额列处理，不要当成分列。
fn amount_inputs_of(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    prefix: &str,
) -> Result<ledger_mapping::AmountInputs, String> {
    let pair = match (
        first_col(mapping, &format!("{prefix}Debit")),
        first_col(mapping, &format!("{prefix}Credit")),
    ) {
        (Some(debit), Some(credit)) => Some((debit, credit)),
        _ => None,
    };
    Ok(if let Some((debit, credit)) = pair {
        ledger_mapping::AmountInputs {
            debit: Some(strict_number(row.get(debit.as_str()).unwrap_or(""))?.unwrap_or(0.0)),
            credit: Some(strict_number(row.get(credit.as_str()).unwrap_or(""))?.unwrap_or(0.0)),
            ..Default::default()
        }
    } else {
        ledger_mapping::AmountInputs {
            amount: Some(
                strict_number(cell(row, mapping, &format!("{prefix}Amount")))?.unwrap_or(0.0),
            ),
            direction: direction_column(mapping, prefix)
                .map(|role| cell(row, mapping, &role).to_owned()),
            ..Default::default()
        }
    })
}

/// 借贷**两侧分开**取数 `(借方, 贷方)`，各自保留正负号。
///
/// [`signed_amount`] 折成净额会丢掉「这笔落在哪一侧」：红字冲销的贷方行记
/// −467.02，净额 +467.02 按符号归侧就翻进了借方，借贷两侧同时虚增——
/// 08 号样例上 TBJE 核对就是这么报出 467.02×2 假差异的。与余额表**列合计**
/// 对数的场景必须走这里：借还是贷由列（或方向列）决定，正负留在本侧冲减。
pub(crate) fn side_amounts(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    prefix: &str,
) -> Result<(f64, f64), String> {
    let inputs = amount_inputs_of(row, mapping, prefix)?;
    Ok(ledger_mapping::side_amounts(
        &inputs,
        sign_convention_of(mapping),
    ))
}

/// 余额列自带符号的标记键。按期初／期末分开存——两列的写法可以不一致。
fn balance_sign_key(prefix: &str) -> String {
    let base = prefix
        .strip_suffix("Functional")
        .or_else(|| prefix.strip_suffix("Foreign"))
        .unwrap_or(prefix);
    format!("__balanceSelfSigned_{base}")
}

fn balance_self_signed(mapping: &Map<String, Value>, prefix: &str) -> bool {
    mapping
        .get(&balance_sign_key(prefix))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 判定余额列是不是整列自带符号，把结论写进映射。判定本身在公共引擎里，
/// 这里只负责缓存——四个读 TB 的工具共用同一份判据。
pub(crate) fn ensure_balance_sign_mode(table: &FxTable, mapping: &mut Map<String, Value>) {
    for prefix in [
        "openingFunctional",
        "closingFunctional",
        "openingForeign",
        "closingForeign",
    ] {
        let key = balance_sign_key(prefix);
        if mapping.contains_key(&key) {
            continue;
        }
        let self_signed = ledger_mapping::balance_self_signed(
            &table.headers,
            &table.rows,
            &|role| mapped_cols(mapping, role),
            prefix,
        );
        mapping.insert(key, Value::Bool(self_signed));
    }
}

fn voucher_id(row: &RowRecord, mapping: &Map<String, Value>, params: &Value) -> String {
    let mut parts = vec![
        entity_for(row, mapping, params).to_owned(),
        parse_date(cell(row, mapping, "date"))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| cell(row, mapping, "date").trim().to_owned()),
    ];
    parts.extend(mapped_cols(mapping, "id").iter().map(|c| {
        row.get(c.as_str())
            .map(|v| v.trim().to_owned())
            .unwrap_or_default()
    }));
    parts.join("\u{1f}")
}
fn display_voucher_id(id: &str) -> String {
    id.split('\u{1f}').collect::<Vec<_>>().join("-")
}

fn is_je_business_row(row: &RowRecord, mapping: &Map<String, Value>) -> bool {
    !cell(row, mapping, "date").trim().is_empty()
        || mapped_cols(mapping, "id").iter().any(|column| {
            row.get(column.as_str())
                .is_some_and(|value| !value.trim().is_empty())
        })
}

fn entities(params: &Value) -> Result<Value, AppError> {
    let mut output = BTreeSet::new();
    for (source_key, map_key) in [("jeSource", "jeMapping"), ("tbSource", "tbMapping")] {
        if let Some(source) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(source.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, map_key);
            for row in records(&table) {
                let value = cell(&row, &mapping, "entity").trim();
                if !value.is_empty() {
                    output.insert(value.to_owned());
                }
            }
        }
    }
    Ok(json!({"entities": output}))
}

fn account_roles(params: &Value) -> Result<Value, AppError> {
    let mut output = BTreeMap::new();
    for (source_key, map_key) in [("jeSource", "jeMapping"), ("tbSource", "tbMapping")] {
        if let Some(source) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(source.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, map_key);
            for row in records(&table) {
                let name = account_name(&row, &mapping);
                if !name.is_empty()
                    && !is_summary_account(&name)
                    && !ledger_mapping::is_report_footer_value(&name)
                {
                    output.entry(name.clone()).or_insert_with(|| {
                        let suggestion = suggest_account_role_detail(&name);
                        json!({
                            "suggestedRole": suggestion.role,
                            "confidence": suggestion.confidence,
                            "needsConfirmation": suggestion.needs_confirmation,
                            "reason": suggestion.reason,
                            "subtype": suggestion.subtype,
                        })
                    });
                }
            }
        }
    }
    Ok(json!({
        "accounts": output.into_iter().map(|(account, detail)|
            json!({"account": account, "suggestedRole": detail["suggestedRole"],
                "confidence": detail["confidence"], "needsConfirmation": detail["needsConfirmation"],
                "reason": detail["reason"], "subtype": detail["subtype"]})
        ).collect::<Vec<_>>()
    }))
}

/// 汇总科目行的判定走公共引擎 [`ledger_mapping::is_rollup_label`]——
/// 词表收编后兼认繁体写法、`本期合计`／`累计`、`交易性金融资产-小计` 这类
/// 带前缀的小计行与行尾冒号，不再只认六个简体标签。
fn is_summary_account(account: &str) -> bool {
    ledger_mapping::is_rollup_label(account)
}

// 科目编码与科目名称是两个彼此独立的映射角色。旧版本把它们并进同一个
// "account" 数组，这里仍然读得动历史参数，但新参数一律按编码在前、
// 名称在后的顺序组合，保证 TB 与 JE 的科目口径完全一致。
fn account_columns(mapping: &Map<String, Value>) -> Vec<String> {
    let code = mapped_cols(mapping, "accountCode");
    let name = mapped_cols(mapping, "accountName");
    if code.is_empty() && name.is_empty() {
        return mapped_cols(mapping, "account");
    }
    // 编码与名称可以合法地落在同一列（混写列同时映射两个角色）——
    // 去重后再拼，否则那一列的取值会在科目文本里出现两遍。
    code.into_iter()
        .chain(name)
        .fold(Vec::new(), |mut all, column| {
            if !all.contains(&column) {
                all.push(column);
            }
            all
        })
}

fn account_name(row: &RowRecord, mapping: &Map<String, Value>) -> String {
    account_columns(mapping)
        .iter()
        .filter_map(|c| row.get(c.as_str()))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn account_code_and_name(row: &RowRecord, mapping: &Map<String, Value>) -> (String, String) {
    let read = |columns: &[String]| {
        columns
            .iter()
            .filter_map(|column| row.get(column.as_str()))
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let explicit_code = read(&mapped_cols(mapping, "accountCode"));
    let explicit_name = read(&mapped_cols(mapping, "accountName"));
    if !explicit_code.is_empty() || !explicit_name.is_empty() {
        return (explicit_code, explicit_name);
    }
    let columns = mapped_cols(mapping, "account");
    let values = columns
        .iter()
        .map(|column| {
            (
                column.as_str(),
                row.get(column.as_str())
                    .map(|value| value.trim())
                    .unwrap_or(""),
            )
        })
        .filter(|(_, value)| !value.is_empty())
        .collect::<Vec<_>>();
    let is_name = |column: &str| {
        let value = normalize_header(column);
        [
            "科目名称",
            "账户名称",
            "accountname",
            "accountdescription",
            "gldescription",
            "gltext",
            "description",
        ]
        .iter()
        .any(|token| value.contains(token))
    };
    let is_code = |column: &str| {
        let value = normalize_header(column);
        [
            "科目编码",
            "科目代码",
            "账户编码",
            "accountnumber",
            "glaccount",
            "g/laccount",
            "saknr",
        ]
        .iter()
        .any(|token| value.contains(token))
    };
    let name = values
        .iter()
        .find(|(column, _)| is_name(column))
        .map(|(_, value)| (*value).to_owned())
        .or_else(|| (values.len() > 1).then(|| values[1].1.to_owned()))
        .unwrap_or_default();
    let code = values
        .iter()
        .find(|(column, _)| is_code(column) && !is_name(column))
        .map(|(_, value)| (*value).to_owned())
        .or_else(|| values.first().map(|(_, value)| (*value).to_owned()))
        .unwrap_or_default();
    (code, name)
}

fn account_identities_for_matching(
    table: &FxTable,
    mapping: &Map<String, Value>,
    params: &Value,
) -> Vec<(String, String, String)> {
    records(table)
        .into_iter()
        .map(|row| {
            let entity = entity_for(&row, mapping, params).to_owned();
            let (code, name) = account_code_and_name(&row, mapping);
            (entity, code, name)
        })
        .filter(|(_, code, name)| !code.trim().is_empty() || !name.trim().is_empty())
        .collect()
}

fn account_match_policy(params: &Value) -> Result<ledger_mapping::AccountMatchPolicy, AppError> {
    let Some(tb_source) = params.get("tbSource") else {
        return Ok(ledger_mapping::AccountMatchPolicy::default());
    };
    let Some(je_source) = params.get("jeSource") else {
        return Ok(ledger_mapping::AccountMatchPolicy::default());
    };
    let tb_spec: SourceSpec = serde_json::from_value(tb_source.clone())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let je_spec: SourceSpec = serde_json::from_value(je_source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let tb_table = load_fx_table(&tb_spec)?;
    let je_mapping = mapping_obj(params, "jeMapping");
    let je_table = forward_filled_je_table(&load_fx_table(&je_spec)?, &je_mapping);
    let tb_rows =
        account_identities_for_matching(&tb_table, &mapping_obj(params, "tbMapping"), params);
    let je_rows = account_identities_for_matching(&je_table, &je_mapping, params);
    Ok(ledger_mapping::AccountMatchPolicy::from_sides(
        &tb_rows, &je_rows,
    ))
}

fn account_code_name_from_display(account: &str) -> (String, String) {
    if let Some((code, name)) = ledger_mapping::split_code_and_name(account) {
        return (code, name);
    }
    let trimmed = account.trim();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let first = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("").trim();
    if ledger_mapping::looks_like_account_code(first) {
        (first.to_owned(), rest.to_owned())
    } else {
        (String::new(), trimmed.to_owned())
    }
}

fn tb_account_name_lookup(params: &Value) -> Result<HashMap<String, String>, AppError> {
    let Some(source) = params.get("tbSource") else {
        return Ok(HashMap::new());
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "tbMapping");
    let mut lookup = HashMap::new();
    for row in records(&table) {
        let (code, name) = account_code_and_name(&row, &mapping);
        if !code.is_empty() && !name.is_empty() {
            // 键口径与 `is_cash_account` / `role_for` 的查找侧一致：去前导零，
            // 否则 TB 不补零、JE 补零时（或反过来）名称补全永远查不中。
            lookup
                .entry(ledger_mapping::normalize_account_code(&code))
                .or_insert(name);
        }
    }
    Ok(lookup)
}

fn with_tb_account_names(params: &Value) -> Result<Value, AppError> {
    let mut enriched = params.clone();
    if let Some(object) = enriched.as_object_mut() {
        object.insert(
            "__tbAccountNames".into(),
            json!(tb_account_name_lookup(params)?),
        );
    }
    Ok(enriched)
}

fn is_english_account_name(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        && !value
            .chars()
            .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
}

fn translate_tb_account_names(params: &Value) -> (HashMap<String, String>, bool, Option<String>) {
    let message = |error: &AppError| {
        serde_json::to_value(error)
            .ok()
            .and_then(|value| {
                value
                    .get("userMessage")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "LLM科目翻译失败".to_owned())
    };
    let requested = params
        .get("translateTbAccountNames")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if let Some(cached) = params.get("accountTranslations").and_then(Value::as_object) {
        let translations = cached
            .iter()
            .filter_map(|(code, name)| {
                name.as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| (code.to_owned(), value.to_owned()))
            })
            .collect::<HashMap<_, _>>();
        if !translations.is_empty() {
            return (translations, true, None);
        }
    }
    let settings = params.get("__settings").unwrap_or(&Value::Null);
    let llm_enabled = settings
        .pointer("/llm/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !requested || !llm_enabled {
        return (HashMap::new(), false, None);
    }
    let original = match tb_account_name_lookup(params) {
        Ok(value) => value,
        Err(error) => return (HashMap::new(), false, Some(message(&error))),
    };
    let candidates = original
        .into_iter()
        .filter(|(_, name)| is_english_account_name(name))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return (HashMap::new(), false, None);
    }
    let mut translations = HashMap::new();
    let mut failures = Vec::new();
    for chunk in candidates.chunks(80) {
        match crate::audipick::fx_account_translation_llm_call(chunk, settings) {
            Ok(values) => translations.extend(values),
            Err(error) => failures.push(message(&error)),
        }
    }
    let enabled = !translations.is_empty();
    let issue = (!failures.is_empty()).then(|| {
        format!(
            "部分或全部英文科目名称未能完成LLM翻译：{}；底稿仍保留原始科目名称。",
            failures.join("；")
        )
    });
    (translations, enabled, issue)
}

fn account_match_key(account: &str) -> &str {
    let first = account
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(account.trim());
    // 编码与名称混写在一格（`1001010000:库存现金-人民币`）时只取编码段——
    // 03 号样例的 TB 只有这一列科目，整串进键就永远对不上 JE 的纯编码列。
    ledger_mapping::split_code_and_name_ref(first)
        .map(|(code, _)| code)
        .unwrap_or(first)
}

/// 匹配键口径的科目编码：在 [`account_match_key`] 取编码段的基础上再去前导零。
///
/// 同一套账的两边经常一边补零、一边不补（序时账 `0000943100`、余额表 `943100`），
/// 不归一化同一个科目会被判成两个，凭空多出一批「只在序时账出现的科目」。
/// 语义完全沿用 [`ledger_mapping::normalize_account_code`]：只去前导零，
/// 分段编码（`1002.01`）与字母编码（`A1001`）原样保留，全零（`0000`）保留原样。
///
/// **只建匹配键，不进展示**——界面和报告里仍显示账里原本的写法。
fn normalized_account_match_key(account: &str) -> String {
    ledger_mapping::normalize_account_code(account_match_key(account))
}

fn auxiliary_value(row: &RowRecord, mapping: &Map<String, Value>) -> String {
    mapped_cols(mapping, "auxiliary")
        .iter()
        .filter_map(|column| row.get(column.as_str()))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("|")
}

/// 一次余额滚动比对的结果。辅助核算粒度要试两次，用它承载每次的产出。
struct RollforwardAttempt {
    issues: Vec<Value>,
    checked: usize,
}

/// TB 与 JE 对账用的余额键：**公司 ＋ 科目编码**必填，**辅助核算可选**。
///
/// 三个字段的定位不同，不能一股脑拼进键：
///
/// - **科目编码**是这套账里科目的唯一标识，两边必然一致，是匹配的锚点；
/// - **科目名称**同一编码在两边写法经常不同——实测 4800 的编码 `1002010017`，
///   TB 记作「货币资金-银行存款-建设银行」（标准科目表名称），
///   JE 记作「银行存款-建行RMB3250-4800」（带账号的账户全称）。
///   把它拼进键，同一个科目会被判成两个，一条都匹配不上。
///   因此名称只在**编码缺失时**兜底当标识用；
/// - **辅助核算是可选的细化维度**：只有两边都映射了才启用，启用后若匹配不上
///   还会自动退回粗粒度（见 [`validate_tb_je_balance_rollforward`]）。TB 常常
///   根本没有这一列而 JE 按供应商、客户拆行，硬进键会让所有余额键失配——
///   实测 4800 就是这么丢掉 332 个键的；
/// - **币种不进键**：两边来源不同（TB 从科目文本抽、JE 读凭证货币列），
///   同一个账户算出的币种字符串对不上。
/// - **科目编码去前导零**（[`normalized_account_match_key`]）：序时账补零到定长
///   （`0000943100`）而余额表不补（`943100`）时，不去零同一个科目会被判成两个。
fn balance_match_key(entity: &str, account: &str, auxiliary: &str, use_auxiliary: bool) -> String {
    let base = format!(
        "{}\u{1f}{}",
        entity.trim(),
        normalized_account_match_key(account)
    );
    if use_auxiliary && !auxiliary.trim().is_empty() {
        format!("{base}\u{1f}{}", auxiliary.trim().to_uppercase())
    } else {
        base
    }
}

fn balance_match_key_with_policy(
    entity: &str,
    code: &str,
    name: &str,
    auxiliary: &str,
    use_auxiliary: bool,
    policy: &ledger_mapping::AccountMatchPolicy,
) -> String {
    let base = format!(
        "{}\u{1f}{}",
        entity.trim(),
        policy.account_key(entity, code, name)
    );
    if use_auxiliary && !auxiliary.trim().is_empty() {
        format!("{base}\u{1f}{}", auxiliary.trim().to_uppercase())
    } else {
        base
    }
}

fn balance_match_key_for_account(
    entity: &str,
    account: &str,
    auxiliary: &str,
    use_auxiliary: bool,
    policy: &ledger_mapping::AccountMatchPolicy,
) -> String {
    let (code, name) = account_code_name_from_display(account);
    balance_match_key_with_policy(entity, &code, &name, auxiliary, use_auxiliary, policy)
}

/// 科目角色分类：先看名称关键词，认不出再按科目编码兜底。
///
/// 名称优先是因为客户常把账户币种、用途写在名称里（`银行存款-中行朝阳支行美元户`），
/// 比编码信息量大；编码兜底是因为《企业会计准则——会计科目和主要账务处理》
/// 规定了前四位，客户自定义的明细挂在后面，前四位基本不动。
///
/// 只靠关键词时，实测 206 个科目有 112 个落到「未分配」——使用权资产、长期待摊费用、
/// 长期股权投资、合同负债、应交税费全都认不出，其中「其他货币资金-保证金」
/// 本该算现金却漏掉了，会直接少算一块外币重估。
#[derive(Clone, Copy, Debug, PartialEq)]
struct AccountRoleSuggestion {
    role: &'static str,
    confidence: f64,
    needs_confirmation: bool,
    reason: &'static str,
    subtype: Option<&'static str>,
}

fn role_suggestion(
    role: &'static str,
    confidence: f64,
    reason: &'static str,
) -> AccountRoleSuggestion {
    AccountRoleSuggestion {
        role,
        confidence,
        needs_confirmation: confidence < 0.80,
        reason,
        subtype: None,
    }
}

fn cash_suggestion(confidence: f64, reason: &'static str) -> AccountRoleSuggestion {
    AccountRoleSuggestion {
        role: "monetary_asset",
        confidence,
        needs_confirmation: confidence < 0.80,
        reason,
        subtype: Some("cash"),
    }
}

fn suggest_account_role(value: &str) -> String {
    suggest_account_role_detail(value).role.into()
}

fn suggest_account_role_detail(value: &str) -> AccountRoleSuggestion {
    if let Some(suggestion) = role_by_keyword(value) {
        return suggestion;
    }
    if let Some(suggestion) = role_by_account_code(value) {
        return suggestion;
    }
    // 没有编码也没有强词时仍给出一个保守主类别；分类状态里已无
    // 「待确认」，科目类别也不再设第六种。
    role_suggestion(
        "non_monetary",
        0.45,
        "未命中词典或科目编码，保守归为非货币性项目",
    )
}

fn role_by_keyword(value: &str) -> Option<AccountRoleSuggestion> {
    let normalized = value.to_lowercase();
    let hit = |words: &[&str]| words.iter().any(|x| normalized.contains(x));
    // 汇兑损益要放在最前面：「汇兑损益」这类科目名里常带「财务费用」，
    // 而财务费用本身是损益类，判成非货币就丢了勾稽基准。
    // 汇兑损益要放在最前面：「汇兑损益」这类科目名里常带「财务费用」，
    // 而财务费用本身是损益类，判成非货币就丢了勾稽基准。
    //
    // 这里用「汇兑」这个**词根**而不是逐个列全称。此前列的是
    // 「汇兑损益／汇兑收益／汇兑差额」，唯独漏了同样常见的**汇兑损失**——
    // 「汇兑损失」不含「汇兑损益」（第四字不同），于是掉到按科目代码判，
    // 6701 落进 5001..=6999 的损益类，被判成**非货币性项目**。后果是整张凭证
    // 被打上「非货币性项目/异常复核」而无法自动测算，且账面金额只累加了
    // 汇兑收益那一侧。实测某公司 359 张凭证、385 万账面汇兑损益全部因此落空。
    //
    // 但词根只对**损益语境**生效：资产负债编码（首位 1/2）下的「xx-汇兑损益」
    // 是挂在外币往来科目下的汇兑调整子目（05 号样例：1122010900 应收账款-
    // 汇兑损益、2202190000 应付账款-汇兑损益）。它们不是账面汇兑损益本体——
    // 认进来会把勾稽基准撑大，还会让这几户跳过货币性重估。让它们继续走
    // 后面的往来词表，归回货币性资产/负债。编码缺失或字母开头（自定义/SAP）
    // 时没有这层证据，维持词根优先的原行为。
    let fx_digits: String = value
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let fx_hit_balance_sheet_code = fx_digits.len() >= 4
        && matches!(fx_digits.as_bytes()[0], b'1' | b'2')
        && !(fx_digits.len() == 6);
    if hit(&[
        "汇兑",
        "汇率损益",
        "汇率差异",
        "exchange gain",
        "exchange loss",
        "exchange difference",
        "exchange diff",
        "fx gain",
        "fx loss",
        "fx difference",
        "cur remeasur g/l",
        "currency remeasur",
        "foreign exch",
        "forex g/l",
    ]) && !fx_hit_balance_sheet_code
    {
        return Some(role_suggestion(
            "fx_gain_loss",
            0.99,
            "命中汇兑损益专用词根",
        ));
    }
    let leading_digits = value
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if leading_digits.len() >= 4
        && leading_digits[..4]
            .parse::<u32>()
            .is_ok_and(|head| (5001..=6999).contains(&head))
    {
        return Some(role_suggestion(
            "other_pnl",
            0.97,
            "命中中国科目表成本/损益编码，优先于名称中的资产对象",
        ));
    }
    if hit(&[
        "坏账准备",
        "rsv bad debt",
        "reserve for bad debt",
        "bad debt allowance",
        "bd db",
    ]) {
        return Some(role_suggestion(
            "monetary_asset",
            0.94,
            "命中应收款坏账准备/抵减项词典",
        ));
    }
    // 损益词必须先于“应收/应付”等资产负债词。否则“信用减值损失-应收账款”
    // 会因为包含“应收账款”而被误判为货币性资产。
    if hit(&[
        "信用减值损失",
        "资产减值损失",
        "营业收入",
        "营业成本",
        "销售费用",
        "管理费用",
        "研发费用",
        "财务费用",
        "税金及附加",
        "其他收益",
        "投资收益",
        "公允价值变动",
        "资产处置收益",
        "营业外收入",
        "营业外支出",
        "所得税费用",
        "revenue",
        "sales",
        "cost of sales",
        "cost of goods",
        "operating expense",
        "selling expense",
        "administrative expense",
        "finance expense",
        "interest expense",
        "impairment loss",
        "other income",
        "income tax expense",
        "bad debt",
        "bank service charge",
    ]) {
        return Some(role_suggestion(
            "other_pnl",
            0.96,
            "命中非汇兑损益/成本科目词典",
        ));
    }
    if hit(&["应收利息", "interest receivable", "interest rec"]) {
        return Some(role_suggestion("monetary_asset", 0.96, "命中应收利息词典"));
    }
    if hit(&[
        "银行存款",
        "库存现金",
        "其他货币资金",
        "存放中央银行",
        "存放同业",
        "货币资金",
        "cash",
        "bank",
        "bnk",
        "boc",
        "boa",
        "hsbc",
        "cmb",
        "petty cash",
    ]) {
        return Some(cash_suggestion(0.98, "命中现金及银行类词典"));
    }
    // 预付/预收通常代表取得或交付商品、服务的权利义务，默认是非货币性项目。
    // 名称明确写明“可退/退款/返还现金”的例外才是货币性项目。
    if hit(&[
        "预付",
        "预收",
        "合同资产",
        "合同负债",
        "待摊费用",
        "预付费用",
        "prepaid",
        "advance from customer",
        "contract asset",
        "contract liability",
    ]) {
        if hit(&[
            "可退",
            "退款",
            "返还",
            "退回现金",
            "refundable",
            "cash refund",
        ]) {
            return Some(role_suggestion(
                "monetary_asset",
                0.72,
                "预付/预收名称含现金退还信号",
            ));
        }
        return Some(role_suggestion(
            "non_monetary",
            0.92,
            "预付/预收及合同余额默认以商品或服务结算",
        ));
    }
    if hit(&[
        "专项应付款",
        "项目资金",
        "递延所得税",
        "递延税",
        "def inc tax",
        "df ic tx",
        "deferred tax",
        "ppd exp",
        "rou asset",
        "inv adj",
        "质量保证金",
    ]) {
        return Some(role_suggestion(
            "non_monetary",
            0.90,
            "命中专项、递延或非货币性资产负债词典",
        ));
    }
    if hit(&[
        "应付",
        "其他应付",
        "流动负债",
        "应付票据",
        "应付职工薪酬",
        "应交税费",
        "借款",
        "应付债券",
        "长期应付",
        "租赁负债",
        "一年内到期",
        "payable",
        "accts pay",
        "acct pay",
        "a/p",
        "ap-",
        "ap trade",
        "ap other",
        "ap-trade",
        "loan",
        "borrowing",
        "lease liab",
        "interco vend",
        "gr/ir",
        "gds rcd/inv rcd",
        "frt pay",
        "accrued",
        "accr ",
        "paybl",
        "taxes wh",
        "vat pay",
    ]) {
        return Some(role_suggestion(
            "monetary_liability",
            0.95,
            "命中现金偿付义务类词典",
        ));
    }
    if hit(&[
        "应收",
        "其他应收",
        "应收票据",
        "押金",
        "保证金",
        "备用金",
        "债权投资",
        "其他债权投资",
        "定期存款",
        "结构性存款",
        "receivable",
        "l/t rec",
        "accts rec",
        "acct rec",
        "a/r",
        "ar-trade",
        "interco cust",
        "deposit",
        "debt investment",
        "term deposit",
    ]) {
        return Some(role_suggestion(
            "monetary_asset",
            0.95,
            "命中收款权利或债权类词典",
        ));
    }
    if hit(&[
        "存货",
        "库存商品",
        "原材料",
        "在产品",
        "半成品",
        "半产品",
        "发出商品",
        "周转材料",
        "委托加工",
        "固定资产",
        "在建工程",
        "使用权资产",
        "无形资产",
        "长期待摊",
        "累计折旧",
        "累计摊销",
        "股权投资",
        "权益工具投资",
        "投资性房地产",
        "商誉",
        "递延所得税",
        "递延收益",
        "实收资本",
        "资本公积",
        "盈余公积",
        "未分配利润",
        "inventory",
        "inven-",
        "inv-fp",
        "property, plant",
        "fixed asset",
        "intangible",
        "right-of-use",
        "goodwill",
        "prepaid expense",
        "accum depr",
        "accum amort",
    ]) {
        return Some(role_suggestion(
            "non_monetary",
            0.95,
            "命中非货币性资产、权益或递延项目词典",
        ));
    }
    None
}

/// 按《企业会计准则》的科目编码前四位归类。
///
/// 取值里第一段连续数字就是科目编码——`1002030029 银行存款-招行RMB0702` 取 `1002`。
/// 客户自定义的明细挂在四位之后，不影响判断。
fn role_by_account_code(value: &str) -> Option<AccountRoleSuggestion> {
    let digits: String = value
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.len() < 4 {
        return None;
    }
    if digits.len() == 6 && matches!(digits.as_bytes()[0], b'5' | b'6' | b'7' | b'8' | b'9') {
        return Some(role_suggestion(
            "other_pnl",
            0.84,
            "命中国际ERP六位损益科目编码族",
        ));
    }
    let head: u32 = digits[..4].parse().ok()?;
    Some(match head {
        // 货币资金：库存现金、银行存款、存放中央银行、存放同业、其他货币资金
        1001 | 1002 | 1003 | 1011 | 1012 => cash_suggestion(0.96, "命中现金及银行科目编码"),
        // 应收款项与其他货币性资产（含坏账准备、应收利息股利）
        1121 | 1122 | 1131 | 1132 | 1221 | 1231 | 1501 | 1502 | 1503 | 1504 => {
            role_suggestion("monetary_asset", 0.90, "命中应收或债权类科目编码")
        }
        // 预付账款默认以商品或服务结算。
        1123 => role_suggestion("non_monetary", 0.88, "命中预付账款科目编码"),
        // 交易性金融资产可能含债券或权益工具，仅靠编码不能进一步区分。
        1101 => role_suggestion(
            "non_monetary",
            0.68,
            "交易性金融资产需结合明细判断，暂按非货币性项目",
        ),
        // 长期股权投资、投资性房地产、其他权益工具投资
        1511 | 1521 | 1523 | 1524 => {
            role_suggestion("non_monetary", 0.92, "命中权益或非货币性投资科目编码")
        }
        // 存货类（1401–1471，含跌价准备）
        1401..=1471 => role_suggestion("non_monetary", 0.94, "命中存货类科目编码"),
        // 固定资产、在建工程、使用权资产、无形资产、长期待摊、递延所得税资产
        1601..=1605 | 1701 | 1702 | 1711 | 1801 | 1811 => {
            role_suggestion("non_monetary", 0.94, "命中长期非货币性资产科目编码")
        }
        // 其他非流动资产的“押金”等强名称已在词典中识别；仅凭编码不能假设可收回现金。
        1812 => role_suggestion(
            "non_monetary",
            0.58,
            "其他非流动资产未写明现金收回权，保守按非货币性项目",
        ),
        // 借款与应付款项
        // 2251 一年内到期的非流动负债、2602 租赁负债：新租赁准则下外币租赁负债
        // 同样要按期末汇率重估，归货币性负债。
        2001 | 2201 | 2202 | 2211 | 2221 | 2231 | 2232 | 2241 | 2251 | 2501 | 2502 | 2602
        | 2701 => role_suggestion(
            "monetary_liability",
            0.92,
            "命中借款、应付或租赁负债科目编码",
        ),
        // 预收账款与合同负债默认以商品或服务结算。
        2203 | 2205 | 2206 => role_suggestion("non_monetary", 0.88, "命中预收或合同负债科目编码"),
        // 预计负债、递延收益、权益类
        2711 | 2801 | 2901 | 3001..=4999 => {
            role_suggestion("non_monetary", 0.88, "命中专项、预计、递延或权益类科目编码")
        }
        // 成本与损益类单独列示，不参与外币货币性项目重估。
        5001..=6999 => role_suggestion("other_pnl", 0.90, "命中成本或损益类科目编码"),
        // 资产类未知编码保守按非货币性；负债类未知编码通常需要以现金偿付。
        1000..=1999 => role_suggestion(
            "non_monetary",
            0.58,
            "未识别的资产类编码，保守归为非货币性项目",
        ),
        2000..=2999 => role_suggestion(
            "monetary_liability",
            0.62,
            "未识别的负债类编码，暂按现金偿付义务",
        ),
        _ => return None,
    })
}

fn is_cash_account(account: &str, params: &Value) -> bool {
    if suggest_account_role_detail(account).subtype == Some("cash") {
        return true;
    }
    let key = normalized_account_match_key(account);
    params
        .get("__tbAccountNames")
        .and_then(Value::as_object)
        .and_then(|names| names.get(&key))
        .and_then(Value::as_str)
        .is_some_and(|name| {
            suggest_account_role_detail(&format!("{account} {name}")).subtype == Some("cash")
        })
}

fn role_for(account: &str, params: &Value) -> String {
    let roles = params.get("accountRoles").and_then(Value::as_object);
    if let Some(role) = roles.and_then(|m| m.get(account)).and_then(Value::as_str) {
        if role != "unassigned" {
            return role.to_owned();
        }
    }
    let key = normalized_account_match_key(account);
    if let Some(role) = roles.and_then(|values| {
        values.iter().find_map(|(candidate, role)| {
            (normalized_account_match_key(candidate) == key)
                .then(|| role.as_str())
                .flatten()
                .filter(|value| *value != "unassigned")
        })
    }) {
        return role.to_owned();
    }
    if let Some(name) = params
        .get("__tbAccountNames")
        .and_then(Value::as_object)
        .and_then(|names| names.get(&key))
        .and_then(Value::as_str)
    {
        let detail = suggest_account_role_detail(&format!("{account} {name}"));
        // 名称补全后仍只有低置信兜底时，先继承上级科目的手工分类：界面
        // 科目清单包含非末级汇总行而测算只读末级，在汇总行上的指定要靠
        // 编码前缀继承才能落到末级行上（与存款利息同一口径）。自动识别
        // 给出过实质结论的科目不受影响。
        if detail.confidence < ROLE_INHERIT_MAX_CONFIDENCE {
            // 父子两侧都先经 `normalized_account_match_key` 去前导零再比前缀：
            // 汇总行写 `9431000` 而末级行写 `00009431001` 这类混用补零的账，
            // 只归一化一侧会让前缀判断从「能继承」变「不能」。归一化后的
            // 编码已是纯编码串，key_of 传恒等即可。
            let parents = roles
                .into_iter()
                .flat_map(|values| values.iter())
                .filter_map(|(candidate, role)| {
                    let parent = normalized_account_match_key(candidate);
                    role.as_str().map(|value| (parent, value))
                })
                .collect::<Vec<_>>();
            if let Some(role) = ledger_mapping::inherited_role_by_code_prefix(
                &key,
                parents.iter().map(|(code, role)| (code.as_str(), *role)),
                |code: &str| code,
            ) {
                return role;
            }
        }
        return detail.role.to_owned();
    }
    suggest_account_role(account)
}

fn je_has_fx_gain_loss_account(params: &Value) -> Result<bool, AppError> {
    let Some(_) = params.get("jeSource") else {
        return Ok(false);
    };
    let (table, mapping) = load_mapped_je_table(params)?;
    Ok(records(&table).iter().any(|row| {
        let account = account_name(row, &mapping);
        !account.is_empty() && role_for(&account, params) == "fx_gain_loss"
    }))
}

/// 自动识别只剩低置信兜底（词典与科目编码都没给出实质结论）时，才允许
/// 继承上级科目的手工分类。0.65 低于任何词典或编码命中的置信度，
/// 只放行「未识别资产/负债，保守按……」这类兜底档。
const ROLE_INHERIT_MAX_CONFIDENCE: f64 = 0.65;

fn rate_status(params: &Value) -> Result<Value, AppError> {
    let start = params
        .get("reportStart")
        .and_then(Value::as_str)
        .unwrap_or("");
    let end = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .unwrap_or("");
    let path = rate_cache_dir()?.join(format!("{}.json", rate_cache_key(start, end)));
    Ok(json!({
        "cached": path.is_file(), "path": path,
        "source": RATE_SOURCE, "sourceUrl": SAFE_URL
    }))
}

fn rate_cache_dir() -> Result<PathBuf, AppError> {
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .ok_or_else(|| error("DATA_DIR_UNAVAILABLE", "无法确定汇率缓存目录。", None))?;
    let path = dirs.cache_dir().join("fx_rates");
    fs::create_dir_all(&path).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法创建汇率缓存目录。",
            Some(e.to_string()),
        )
    })?;
    Ok(path)
}
fn rate_cache_key(start: &str, end: &str) -> String {
    let mut hash = Sha256::new();
    // safe-v2：快照的牌价点从「报告期逐日」扩为「报告期前推35天起逐日」，
    // 已实现测算的月初牌价（上月末重估点）必须能精确命中，旧缓存里没有这些点。
    hash.update(format!("safe-v2|{start}|{end}"));
    hex::encode(hash.finalize())[..20].to_owned()
}

fn obtain_rates(params: &Value) -> Result<RateSnapshot, AppError> {
    if let Some(value) = params.get("rateSnapshot") {
        if !value.is_null() {
            return serde_json::from_value(value.clone()).map_err(|e| {
                error(
                    "RATE_SNAPSHOT_INVALID",
                    "汇率快照格式无效。",
                    Some(e.to_string()),
                )
            });
        }
    }
    let start = params
        .get("reportStart")
        .and_then(Value::as_str)
        .ok_or_else(|| error("REPORT_DATE_REQUIRED", "请填写报告期开始日。", None))?;
    let end = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .ok_or_else(|| error("REPORT_DATE_REQUIRED", "请填写报告期结束日。", None))?;
    let path = rate_cache_dir()?.join(format!("{}.json", rate_cache_key(start, end)));
    if path.is_file() {
        return serde_json::from_slice(&fs::read(&path).map_err(|e| {
            error(
                "CACHE_READ_FAILED",
                "无法读取汇率缓存。",
                Some(e.to_string()),
            )
        })?)
        .map_err(|e| error("CACHE_READ_FAILED", "汇率缓存已损坏。", Some(e.to_string())));
    }
    let snapshot = fetch_safe_rates(start, end)?;
    let bytes = serde_json::to_vec_pretty(&snapshot).unwrap_or_default();
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法写入汇率缓存。",
            Some(e.to_string()),
        )
    })?;
    fs::rename(temp, path).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法锁定汇率缓存。",
            Some(e.to_string()),
        )
    })?;
    Ok(snapshot)
}

fn fetch_safe_rates(start: &str, end: &str) -> Result<RateSnapshot, AppError> {
    let start_date = parse_date(start)
        .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期开始日格式无效。", None))?;
    let end_date = parse_date(end)
        .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期结束日格式无效。", None))?;
    if end_date > Utc::now().date_naive() {
        return Err(error(
            "FUTURE_RATE_DENIED",
            "报告期结束日晚于当前日期，系统不允许使用未来汇率。",
            None,
        ));
    }
    if end_date < start_date || end_date - start_date > Duration::days(366) {
        return Err(error(
            "REPORT_RANGE_INVALID",
            "汇率查询区间必须在366天内。",
            None,
        ));
    }
    // Include a 35-day lookback so holidays at the period start can safely use
    // the nearest prior publication without ever using a future rate, and so
    // the previous month-end rate (the month-opening basis for realized FX
    // measurement) is available even when the report period starts mid-month.
    let client = Client::builder()
        .timeout(StdDuration::from_secs(45))
        .build()
        .map_err(|e| {
            error(
                "RATE_FETCH_FAILED",
                "无法创建汇率请求。",
                Some(e.to_string()),
            )
        })?;
    let fetch = |from: NaiveDate, to: NaiveDate| -> Result<Vec<u8>, AppError> {
        client
            .post(SAFE_URL)
            .form(&[
                ("startDate", from.format("%Y-%m-%d").to_string()),
                ("endDate", to.format("%Y-%m-%d").to_string()),
                ("queryYN", "true".into()),
            ])
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                error(
                    "RATE_FETCH_FAILED",
                    "无法从官方来源获取汇率。",
                    Some(e.to_string()),
                )
            })?
            .bytes()
            .map(|v| v.to_vec())
            .map_err(|e| {
                error(
                    "RATE_FETCH_FAILED",
                    "无法读取官方汇率响应。",
                    Some(e.to_string()),
                )
            })
    };
    let lookback = fetch(start_date - Duration::days(35), start_date)?;
    let period = fetch(start_date, end_date)?;
    let mut digest = Sha256::new();
    digest.update(&lookback);
    digest.update(&period);
    let response_hash = hex::encode(digest.finalize());
    let mut raw = parse_safe_html(&String::from_utf8_lossy(&lookback));
    raw.extend(parse_safe_html(&String::from_utf8_lossy(&period)));
    raw.sort_by_key(|x| x.0);
    raw.dedup_by_key(|x| x.0);
    if raw.is_empty() {
        return Err(error(
            "RATE_PARSE_FAILED",
            "官方汇率响应中没有可识别的数据。",
            None,
        ));
    }
    let currencies = [
        "USD", "EUR", "JPY", "HKD", "GBP", "AUD", "NZD", "SGD", "CHF", "CAD", "MOP", "MYR", "RUB",
        "ZAR", "KRW", "AED", "SAR", "HUF", "PLN", "DKK", "SEK", "NOK", "TRY", "MXN", "THB",
    ];
    let mut rates = Vec::new();
    // 牌价点从报告期前推35天开始逐日生成：报告期从月中开始时，上月末
    // （月初牌价的取数点）也必须是一个可精确命中的 requested 点。
    for requested in date_points(start_date - Duration::days(35), end_date) {
        for (i, currency) in currencies.iter().enumerate() {
            if let Some((published, values)) = raw
                .iter()
                .filter(|(date, _)| *date <= requested)
                .max_by_key(|x| x.0)
            {
                if let Some(Some(value)) = values.get(i) {
                    // First ten SAFE columns are CNY per 100 foreign units.
                    // Remaining columns are foreign units per 100 CNY.
                    let cny_per_unit = if i < 10 {
                        *value / 100.0
                    } else {
                        100.0 / *value
                    };
                    rates.push(RatePoint {
                        requested_date: requested.format("%Y-%m-%d").to_string(),
                        published_date: published.format("%Y-%m-%d").to_string(),
                        currency: (*currency).into(),
                        cny_per_unit,
                    });
                }
            }
        }
        rates.push(RatePoint {
            requested_date: requested.format("%Y-%m-%d").to_string(),
            published_date: requested.format("%Y-%m-%d").to_string(),
            currency: "CNY".into(),
            cny_per_unit: 1.0,
        });
    }
    Ok(RateSnapshot {
        source: RATE_SOURCE.into(),
        source_url: SAFE_URL.into(),
        fetched_at: Utc::now().to_rfc3339(),
        response_hash,
        start_date: start.into(),
        end_date: end.into(),
        rates,
        missing: vec![],
    })
}

fn date_points(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    // A full daily normalized snapshot makes the run reproducible for both
    // voucher dates and month ends. Non-publication days still resolve only to
    // a prior publication in fetch_safe_rates().
    let mut output = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        output.push(cursor);
        cursor += Duration::days(1);
    }
    output
}

fn parse_safe_html(html: &str) -> Vec<(NaiveDate, Vec<Option<f64>>)> {
    html.split("<tr class=\"first\"")
        .skip(1)
        .filter_map(|chunk| {
            let mut cells = Vec::new();
            let mut rest = chunk;
            while let Some(index) = rest.find("<td") {
                rest = &rest[index + 3..];
                let end = rest.find('>')?;
                rest = &rest[end + 1..];
                let close = rest.find("</td>")?;
                cells.push(strip_tags(&rest[..close]));
                rest = &rest[close + 5..];
            }
            let date = parse_date(cells.first()?.trim())?;
            let values = cells
                .iter()
                .skip(1)
                .take(25)
                .map(|v| strict_number(v).ok().flatten())
                .collect::<Vec<_>>();
            Some((date, values))
        })
        .collect()
}

fn strip_tags(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in value.chars() {
        if character == '<' {
            in_tag = true;
        } else if character == '>' {
            in_tag = false;
        } else if !in_tag {
            output.push(character);
        }
    }
    output.replace("&nbsp;", "").trim().to_owned()
}

/// 币种归一化，**走统一内核**。
///
/// 此前这里是本模块自己的一张表，只认九种简体写法：繁体的「港幣」「歐元」「日圓」、
/// 以及 `¥` `€` 这类符号一律认不出来，繁体账的币种会原样落到下游当成不同的币种。
/// 内核那张表覆盖二十余种并含繁体与符号，与看账、存款、借款共用。
///
/// 认不出时沿用原有行为：返回去空格转大写后的原文，让下游按未知币种处理。
fn normalize_currency(value: &str) -> String {
    ledger_mapping::normalize_currency_code(value)
        .map(str::to_owned)
        .unwrap_or_else(|| value.trim().to_uppercase())
}

fn supported_currencies() -> HashSet<&'static str> {
    [
        "CNY", "USD", "EUR", "JPY", "HKD", "GBP", "AUD", "NZD", "SGD", "CHF", "CAD", "MOP", "MYR",
        "RUB", "ZAR", "KRW", "AED", "SAR", "HUF", "PLN", "DKK", "SEK", "NOK", "TRY", "MXN", "THB",
    ]
    .into_iter()
    .collect()
}

fn foreign_currency_columns(table: &FxTable) -> Vec<(String, BTreeSet<String>)> {
    let supported = supported_currencies();
    table
        .headers
        .iter()
        .enumerate()
        .filter_map(|(index, header)| {
            let currencies = table
                .rows
                .iter()
                .filter_map(|row| row.get(index))
                .map(|value| normalize_currency(value))
                .filter(|code| code != "CNY" && supported.contains(code.as_str()))
                .collect::<BTreeSet<_>>();
            (!currencies.is_empty()).then(|| (header.clone(), currencies))
        })
        .collect()
}

fn functional_currency(entity: &str, params: &Value) -> String {
    params
        .get("entityCurrencies")
        .and_then(Value::as_object)
        .and_then(|m| m.get(entity))
        .and_then(Value::as_str)
        .unwrap_or("CNY")
        .to_owned()
}

fn rate(
    snapshot: &RateSnapshot,
    date: NaiveDate,
    currency: &str,
    functional: &str,
) -> Option<(f64, String)> {
    let requested = date.format("%Y-%m-%d").to_string();
    let foreign_code = normalize_currency(currency);
    let functional_code = normalize_currency(functional);
    let mut cache = FX_RATE_INDEX.get_or_init(|| Mutex::new(None)).lock().ok()?;
    let rebuild = cache
        .as_ref()
        .is_none_or(|(hash, _)| hash != &snapshot.response_hash);
    if rebuild {
        let index = snapshot
            .rates
            .iter()
            .cloned()
            .map(|point| {
                (
                    (point.requested_date.clone(), point.currency.clone()),
                    point,
                )
            })
            .collect();
        *cache = Some((snapshot.response_hash.clone(), index));
    }
    let index = &cache.as_ref()?.1;
    let foreign = index.get(&(requested.clone(), foreign_code))?;
    let functional_rate = index.get(&(requested, functional_code))?;
    Some((
        foreign.cny_per_unit / functional_rate.cny_per_unit,
        foreign.published_date.clone(),
    ))
}

/// 月初牌价：已实现汇兑损益 = (记账日官方牌价 − 月初牌价) × 终止确认原币。
/// 月初牌价必须与上月末重估同一快照点——取凭证所在月第一天的前一天
/// （上月最后一日）。该日期往前 7 天内最近的可命中牌价点即为结果
/// （月末日通常直接命中；个别币种缺发布时退到最近的前一个发布点）。
/// 若之前完全无数据（报告期数据缺口），退回当月内最早的牌价点并标记
/// `is_fallback = true` 供测算结果披露口径差异；两者皆无 → None（隔离该腿）。
fn month_opening_rate(
    snapshot: &RateSnapshot,
    within_date: NaiveDate,
    currency: &str,
    functional: &str,
) -> Option<(f64, String, bool)> {
    let first_of_month = NaiveDate::from_ymd_opt(within_date.year(), within_date.month(), 1)?;
    let mut probe = first_of_month - Duration::days(1);
    for _ in 0..7 {
        if let Some((value, published)) = rate(snapshot, probe, currency, functional) {
            return Some((value, published, false));
        }
        probe -= Duration::days(1);
    }
    let mut probe = first_of_month;
    while probe < within_date {
        if let Some((value, published)) = rate(snapshot, probe, currency, functional) {
            return Some((value, published, true));
        }
        probe += Duration::days(1);
    }
    None
}

fn calculate(
    params: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    const TOTAL_STAGES: usize = 10;
    progress("validate", 0, TOTAL_STAGES, "正在校验账表映射与金额数据…");
    let validation = validate_mapping(params)?;
    if !validation
        .get("valid")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(error(
            "MAPPING_INVALID",
            "字段映射或数据质量校验未通过。",
            Some(validation.to_string()),
        ));
    }
    checkpoint(cancel, pause)?;
    progress(
        "account_names",
        1,
        TOTAL_STAGES,
        "正在复用已读取数据建立科目名称与编码索引…",
    );
    let enriched_params = with_tb_account_names(params)?;
    let params = &enriched_params;
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let balance_rollforward_validation = if matches!(mode, "unrealized" | "combined") {
        // 校验本身出错（读不出表、解析不了金额）仍然要中断；
        // 只有「对不上」不再中断——结论与逐条明细挂在 `balanceRollforwardValidation`
        // 上带给前端展示。
        checkpoint(cancel, pause)?;
        progress(
            "rollforward",
            2,
            TOTAL_STAGES,
            "正在执行TB与JE余额滚动校验…",
        );
        validate_tb_je_balance_rollforward(params)?
    } else {
        json!({"performed":false,"reason":"当前模式不包含未实现测算"})
    };
    checkpoint(cancel, pause)?;
    progress("rates", 3, TOTAL_STAGES, "正在锁定官方汇率快照…");
    let snapshot = obtain_rates(params)?;
    checkpoint(cancel, pause)?;
    progress("calculate", 4, TOTAL_STAGES, "正在执行汇兑损益测算与分类…");
    let mut realized = Vec::new();
    let mut unrealized = Vec::new();
    let mut classification = Vec::new();
    let mut quality = Vec::new();
    // JE 完整明细只有导出时写「JE完整明细」那张 Sheet 才用得上，测算预览会把它整个丢掉。
    // 36 万行 × 46 列转成 JSON 对象要几 GB 内存，还要跟着测算结果一起被克隆进预览缓存——
    // 白算一遍。改为导出前按需构造（[`build_je_detail`]）。
    let je_detail: Vec<Value> = Vec::new();
    if matches!(mode, "realized" | "combined") {
        progress("realized", 4, TOTAL_STAGES, "正在识别并测算已实现汇兑事项…");
        let (calculation, classes, issues) = calculate_realized(
            params,
            &snapshot,
            Some(FxProgressControl {
                progress,
                cancel,
                pause,
            }),
        )?;
        realized = calculation;
        classification = classes;
        quality.extend(issues);
    }
    checkpoint(cancel, pause)?;
    if matches!(mode, "unrealized" | "combined") {
        progress(
            "unrealized",
            5,
            TOTAL_STAGES,
            "正在测算外币货币性项目期末重估…",
        );
        let (calculation, issues) =
            calculate_unrealized(params, &snapshot, &realized, &classification)?;
        unrealized = calculation;
        quality.extend(issues);
    }
    // 新已实现口径（记账日牌价−月初牌价）的前置假设体检：入账口径恒定性
    // 与每月重估存在性。只提示不阻断，缺 jeSource 时自动跳过。
    checkpoint(cancel, pause)?;
    progress(
        "assumption_checks",
        6,
        TOTAL_STAGES,
        "正在检查月初汇率与客户重估口径…",
    );
    quality.extend(month_start_rate_assumption_checks(params, &snapshot));
    let realized_total = realized
        .iter()
        .filter_map(|v| v.get("auditGainLoss").and_then(Value::as_f64))
        .sum::<f64>();
    let unrealized_total = unrealized
        .iter()
        .filter_map(|v| {
            v.get("unrealizedGainLoss")
                .or_else(|| v.get("suggestedAdjustment"))
                .and_then(Value::as_f64)
        })
        .sum::<f64>();
    let automatic_total = realized_total + unrealized_total;
    checkpoint(cancel, pause)?;
    progress("review", 7, TOTAL_STAGES, "正在建立分类复核与账面覆盖关系…");
    let bridge = build_review_bridge(params, &realized, &unrealized)?;
    let classification_controls = bridge
        .get("classificationControls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pending_review = bridge
        .get("pendingReviews")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pending_review_amount = bridge
        .get("pendingReviewAmount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let covered_book = bridge
        .get("coveredBookFxGainLoss")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    // 不构成汇兑事项的项目只披露，不进入审计测算。已实现按结算事件测算；
    // 未实现按外币货币性项目余额测算，客户重估凭证只作为比较证据。
    let provisional_total = automatic_total;
    if params
        .get("translateTbAccountNames")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && params
            .pointer("/__settings/llm/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        progress(
            "translate_accounts",
            8,
            TOTAL_STAGES,
            "正在翻译TB英文科目名称…",
        );
    }
    let (account_translations, translation_enabled, translation_issue) =
        translate_tb_account_names(params);
    if let Some(detail) = translation_issue {
        quality.push(json!({
            "source":"LLM科目翻译", "type":"英文科目名称翻译未完全成功",
            "severity":"提示", "detail":detail
        }));
    }
    checkpoint(cancel, pause)?;
    progress(
        "voucher_detail",
        8,
        TOTAL_STAGES,
        "正在从已读取数据整理相关凭证明细…",
    );
    let voucher_detail = build_relevant_voucher_detail(
        params,
        &realized,
        &unrealized,
        &pending_review,
        &account_translations,
        translation_enabled,
    )?;
    let mut account_name_catalog = BTreeMap::<String, Value>::new();
    for item in &voucher_detail {
        let code = item
            .get("accountCode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_uppercase();
        if code.is_empty() {
            continue;
        }
        account_name_catalog.entry(code.clone()).or_insert_with(|| {
            json!({
                "accountCode": code,
                "accountNameOriginal": item.get("accountNameOriginal").cloned().unwrap_or(Value::Null),
                "accountNameChinese": item.get("accountNameChinese").cloned().unwrap_or(Value::Null)
            })
        });
    }
    let mut client_revaluation_map = BTreeMap::<String, Value>::new();
    for detail in unrealized
        .iter()
        .filter_map(|item| {
            item.get("clientRevaluationDetails")
                .and_then(Value::as_array)
        })
        .flatten()
    {
        if let Some(id) = detail.get("voucherId").and_then(Value::as_str) {
            client_revaluation_map
                .entry(id.to_owned())
                .or_insert_with(|| detail.clone());
        }
    }
    let client_revaluation_vouchers = client_revaluation_map.into_values().collect::<Vec<_>>();
    for item in &pending_review {
        classification.push(json!({
            "voucherId": item.get("voucherId"), "classification":"待复核",
            "eventType": item.get("voucherType"), "realizedScore":0.0, "unrealizedScore":0.0,
            "matchedRules":[item.get("pendingCategory")],
            "counterEvidence":[item.get("reviewReason")], "confidence":"待复核", "ruleConflict":false
        }));
    }
    let mut reconciliation = reconcile_fx_gain_loss(params)?;
    if let Some(object) = reconciliation.as_object_mut() {
        object.insert("coveredBookFxGainLoss".into(), json!(covered_book));
        object.insert("pendingReviewAmount".into(), json!(pending_review_amount));
        object.insert(
            "pendingReviewCount".into(),
            bridge
                .get("pendingReviewCount")
                .cloned()
                .unwrap_or(json!(0)),
        );
        object.insert(
            "coverageDifference".into(),
            bridge
                .get("coverageDifference")
                .cloned()
                .unwrap_or(json!(0.0)),
        );
    }
    let tb_fx = reconciliation.get("tbFxGainLoss").and_then(Value::as_f64);
    let client_booked_unrealized = unrealized
        .iter()
        .filter_map(|item| {
            item.get("clientBookedUnrealizedGainLoss")
                .and_then(Value::as_f64)
        })
        .sum::<f64>();
    // “已覆盖账面金额”已经排除了不构成汇兑事项的凭证。再扣除客户已入账
    // 未实现部分，得到与已实现审计测算同口径的账面已实现金额。
    let covered_book_realized = covered_book - client_booked_unrealized;
    let realized_difference = realized_total - covered_book_realized;
    let unrealized_difference = unrealized_total - client_booked_unrealized;
    let difference = tb_fx.map(|value| provisional_total - value);
    let difference_ratio = tb_fx.and_then(|value| {
        if value.abs() < 0.01 {
            None
        } else {
            Some((provisional_total - value).abs() / value.abs())
        }
    });
    let no_calculation_rows = realized.is_empty() && unrealized.is_empty();
    let unrealized_missing_balance_keys = quality
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("未实现测算缺少TB余额基础"))
        .count();
    // TB 只给到「科目」粒度，而外币敞口是「科目×币种」粒度的。下面这几类隔离
    // 全都源自这一点，用户能做的动作是同一个：换一份按币种拆分的科目余额表。
    // 汇总成清单交给界面显著提示——只写进底稿，用户根本看不见，就会误以为
    // 是工具算不出来。
    const GRANULARITY_TYPES: &[&str] = &[
        "科目余额混合本位币与外币",
        "同一科目存在多种外币敞口",
        "外币凭证原币金额全为零",
        "同一余额键存在多个外币",
    ];
    let tb_granularity_blocked = quality
        .iter()
        .filter(|item| {
            item.get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| GRANULARITY_TYPES.contains(&kind))
        })
        .map(|item| {
            json!({
                "account": item.get("account").cloned().unwrap_or(Value::Null),
                "type": item.get("type").cloned().unwrap_or(Value::Null),
                "currencies": item.get("currencies").or_else(|| item.get("currency")).cloned().unwrap_or(Value::Null),
                "detail": item.get("detail").cloned().unwrap_or(Value::Null),
                "sourceRow": item.get("row").cloned().unwrap_or(Value::Null)
            })
        })
        .collect::<Vec<_>>();
    if no_calculation_rows && !classification.is_empty() {
        quality.push(json!({
            "source":"系统诊断", "type":"外币数据未形成测算结果", "severity":"待复核",
            "detail": format!("已读取{}个凭证事件，但没有事件进入已实现或未实现测算；请检查科目角色、币种及金额映射。", classification.len())
        }));
    }
    checkpoint(cancel, pause)?;
    progress("reconcile", 9, TOTAL_STAGES, "正在汇总并执行TB勾稽…");
    Ok(json!({
        "mode": mode,
        "largeJeDiskMode": params
            .get("__largeJeDiskMode")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| je_uses_disk(params)),
        "summary": {
            "realizedGainLoss": realized_total,
            "unrealizedAdjustment": unrealized_total,
            "clientBookedUnrealizedGainLoss": client_booked_unrealized,
            "coveredBookRealizedGainLoss": covered_book_realized,
            "realizedMeasurementDifference": realized_difference,
            "unrealizedMeasurementDifference": unrealized_difference,
            "coveredMeasurementDifference": automatic_total - covered_book,
            "uncoveredTbFxGainLoss": pending_review_amount,
            "automaticMeasuredFxGainLoss": automatic_total,
            "pendingReviewAmount": pending_review_amount,
            "pendingReviewCount": pending_review.len(),
            "pendingUnclassifiedCount": bridge.get("pendingUnclassifiedCount").cloned().unwrap_or(json!(0)),
            "pendingUnmeasurableCount": bridge.get("pendingUnmeasurableCount").cloned().unwrap_or(json!(0)),
            "notFxEventCount": bridge.get("notFxEventCount").cloned().unwrap_or(json!(0)),
            "notFxEventAmount": bridge
                .get("notFxEventAmount")
                .cloned()
                .unwrap_or(json!(0.0)),
            "coveredBookFxGainLoss": covered_book,
            "measurementDifference": automatic_total - covered_book,
            "auditFxGainLoss": provisional_total,
            "tbFxGainLoss": tb_fx,
            "tbFxGainLossPresentation": reconciliation.get("tbFxGainLossPresentation").cloned().unwrap_or(json!("combined")),
            "tbRealizedGainLoss": reconciliation.get("tbRealizedGainLoss").cloned().unwrap_or(Value::Null),
            "tbUnrealizedGainLoss": reconciliation.get("tbUnrealizedGainLoss").cloned().unwrap_or(Value::Null),
            "difference": difference,
            "differenceRatio": difference_ratio,
            "reconciliationPassed": difference_ratio.map(|value| value < 0.05),
            "realizedEvents": realized.len(),
            "unrealizedRows": unrealized.len(),
            "unrealizedMissingBalanceKeys": unrealized_missing_balance_keys,
            "tbGranularityBlockedCount": tb_granularity_blocked.len(),
            "unrealizedBalanceBasisComplete": unrealized_missing_balance_keys == 0,
            // 按月推算余额依赖 JE 的完整性：TB＋JE 对不上时，未实现那部分是受限结果。
            // 已实现汇兑损益按逐笔结算算，不受影响，所以只标未实现。
            "rollforwardPassed": balance_rollforward_validation
                .get("passed")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "rollforwardIssueCount": balance_rollforward_validation
                .get("issues")
                .and_then(Value::as_array)
                .map(|all| all.len())
                .unwrap_or(0),
            "translatedAccountNames": account_translations.len(),
            "accountTranslationEnabled": translation_enabled,
            "lowConfidenceEvents": classification.iter().filter(|v|
                v.get("confidence").and_then(Value::as_str) == Some("低")
            ).count(),
            "needsZeroResultReview": no_calculation_rows && !classification.is_empty()
        },
        "realized": realized, "classification": classification, "jeDetail": je_detail,
        "voucherDetail": voucher_detail, "classificationControls": classification_controls,
        "accountNameCatalog": account_name_catalog.into_values().collect::<Vec<_>>(),
        "accountTranslations": account_translations,
        "unrealized": unrealized,
        "unrealizedBalanceRollforward": unrealized,
        "unrealizedComparison": unrealized,
        "clientRevaluationVouchers": client_revaluation_vouchers,
        "pendingReview": pending_review,
        "tbGranularityBlocked": tb_granularity_blocked,
        "dataQuality": quality, "reconciliation": reconciliation,
        "balanceRollforwardValidation": balance_rollforward_validation,
        "validation": validation, "rateSnapshot": snapshot
    }))
}

/// 从汇兑损益科目名称提取已实现/未实现字样，供结构结论交叉验证。
///
/// 客户的科目表通常把两者分开设科目并写进名称——4800 就是
/// 「财务费用-汇兑收益-未实现」「财务费用-汇兑损失-已实现-银行存款\现金」这样。
/// 此前分类只认用户手工指定，这些名称里写得明明白白的凭证也要人一张张点：
/// 实测 4800 有 7600 万的未实现评估调整凭证因此排除在测算之外，
/// 测算结果几乎为零，而 TB 上的汇兑损益有 385 万。
///
/// 注意：这只作**交叉验证**（与结构判定冲突时提示复核），不参与定性；
/// 同一张凭证同时出现两种字样时不下结论。
fn classify_by_account_names<'a, I>(accounts: I) -> Option<&'static str>
where
    I: IntoIterator<Item = &'a str>,
{
    let mut unrealized = false;
    let mut realized = false;
    for account in accounts {
        // 「未实现」要先判：「已实现」是它的子串反过来不成立，
        // 但两个词都可能出现在同一个科目全名里（如「汇兑损益-未实现」）。
        if account.contains("未实现") || account.contains("未實現") {
            unrealized = true;
        } else if account.contains("已实现") || account.contains("已實現") {
            realized = true;
        }
    }
    match (unrealized, realized) {
        (true, false) => Some("未实现汇兑损益"),
        (false, true) => Some("已实现汇兑损益"),
        // 都没写，或者两种都出现——交给人判断。
        _ => None,
    }
}

#[derive(Default)]
struct VoucherFxStructure {
    /// 单张凭证内至少一组货币资金净额非零，且另一组货币性项目净额非零、
    /// 借贷方向相反；至少一组币种不是公司本位币。
    realized: bool,
    /// 不满足上述资金结构时，存在外币货币性项目原币净额为零、
    /// 本位币净额非零的分组。
    unrealized: bool,
}

#[derive(Default)]
struct VoucherMonetaryGroup {
    is_cash: bool,
    is_foreign: bool,
    foreign_net: f64,
    functional_net: f64,
}

/// 按单张凭证、公司＋币种＋货币性科目聚合后作结构分类。
///
/// 客户/供应商、银行账号、清账项不进入强制键；需要时可在上游把它们并入
/// 科目标识。财务费用/汇兑损益科目、摘要和凭证类型均不参与定性。
fn voucher_fx_structure<'row, 'data, I>(
    rows: I,
    mapping: &Map<String, Value>,
    params: &Value,
) -> Result<VoucherFxStructure, AppError>
where
    I: IntoIterator<Item = &'row RowRecord<'data>>,
    'data: 'row,
{
    let mut groups = BTreeMap::<String, VoucherMonetaryGroup>::new();
    for row in rows {
        let account = account_name(row, mapping);
        let role = role_for(&account, params);
        let is_cash = role == "cash" || is_cash_account(&account, params);
        if !is_cash && !matches!(role.as_str(), "monetary_asset" | "monetary_liability") {
            continue;
        }
        let entity = entity_for(row, mapping, params);
        let currency = normalize_currency(&currency_for(row, mapping, &account, params));
        let functional_currency = normalize_currency(&functional_currency(entity, params));
        let foreign = signed_amount(row, mapping, "foreign").map_err(|detail| {
            error(
                "NUMERIC_PARSE_FAILED",
                "JE原币金额无法解析。",
                Some(format!("第{}行：{detail}", row.source_row)),
            )
        })?;
        let functional = signed_amount(row, mapping, "functional").map_err(|detail| {
            error(
                "NUMERIC_PARSE_FAILED",
                "JE本位币金额无法解析。",
                Some(format!("第{}行：{detail}", row.source_row)),
            )
        })?;
        let key = format!(
            "{}\u{1f}{}\u{1f}{}",
            entity.trim().to_uppercase(),
            currency,
            account_match_key(&account)
        );
        let group = groups.entry(key).or_default();
        group.is_cash |= is_cash;
        group.is_foreign |= !currency.is_empty()
            && !functional_currency.is_empty()
            && currency != functional_currency;
        group.foreign_net += foreign;
        group.functional_net += functional;
    }

    let groups = groups.into_values().collect::<Vec<_>>();
    let mut realized = false;
    for (cash_index, cash) in groups.iter().enumerate() {
        // 外币组看原币净额；本位币组的原币列在很多 SAP 导出中固定为 0，
        // 因此改看本位币净额。两边各自在自己的币种口径上判断是否有净变化。
        let cash_net = if cash.is_foreign {
            cash.foreign_net
        } else {
            cash.functional_net
        };
        if !cash.is_cash || cash_net.abs() < 0.005 {
            continue;
        }
        realized |= groups.iter().enumerate().any(|(other_index, other)| {
            let other_net = if other.is_foreign {
                other.foreign_net
            } else {
                other.functional_net
            };
            other_index != cash_index
                && other_net.abs() >= 0.005
                && cash_net * other_net < 0.0
                && (cash.is_foreign || other.is_foreign)
        });
        if realized {
            break;
        }
    }
    let unrealized = !realized
        && groups.iter().any(|group| {
            group.is_foreign
                && group.foreign_net.abs() < 0.005
                && group.functional_net.abs() >= 0.01
        });
    Ok(VoucherFxStructure {
        realized,
        unrealized,
    })
}

/// 凭证类型或摘要不再参与任何分类认定（用户拍板：摘要文字不可靠——
/// 4800 实测中摘要写「同户名划款，结汇」的凭证两条腿其实都是美元）。
/// 已实现/未实现只看凭证结构与数字证据。

fn manual_classification<'a>(params: &'a Value, voucher_id: &str) -> Option<&'a str> {
    params
        .get("manualClassifications")
        .and_then(Value::as_object)
        .and_then(|items| items.get(voucher_id))
        .and_then(Value::as_str)
        // 「待确认」已废止：手工指定只接受二元值，其余（含历史存量的
        // 「待确认」）一律忽略、交给结构自动归类。
        .filter(|value| matches!(*value, "已实现汇兑损益" | "未实现汇兑损益"))
}

fn reconcile_fx_gain_loss(params: &Value) -> Result<Value, AppError> {
    let mut tb_rows = Vec::new();
    let mut tb_total = 0.0;
    let mut tb_realized_total = 0.0;
    let mut tb_unrealized_total = 0.0;
    let mut tb_classification_complete = true;
    if let Some(source) = params.get("tbSource") {
        let spec: SourceSpec = serde_json::from_value(source.clone())
            .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        let mapping = mapping_obj(params, "tbMapping");
        let candidates = tb_leaf_records(&table, &mapping)
            .into_iter()
            .filter_map(|row| {
                let account = account_name(&row, &mapping);
                if role_for(&account, params) != "fx_gain_loss" {
                    return None;
                }
                let debit = first_col(&mapping, "periodFunctionalDebit")
                    .and_then(|column| row.get(column.as_str()))
                    .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                    .transpose()
                    .ok()
                    .flatten();
                let credit = first_col(&mapping, "periodFunctionalCredit")
                    .and_then(|column| row.get(column.as_str()))
                    .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                    .transpose()
                    .ok()
                    .flatten();
                let closing = first_col(&mapping, "closingFunctionalAmount")
                    .and_then(|column| row.get(column.as_str()))
                    .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                    .transpose()
                    .ok()
                    .flatten();
                Some((account, row.source_row, closing, debit, credit))
            })
            .collect::<Vec<_>>();
        // **整表统一口径**：要么所有科目都取期末余额，要么都取借贷发生额。
        //
        // 逐科目各判各的（这个有余额就取余额、那个余额为零就取发生额）会让一张表
        // 里混着两种口径，各科目的数不可比，加总也没有会计意义。
        //
        // 选法：损益科目期末结转到未分配利润后余额归零，这时整表余额都是 0，
        // 只能走发生额；余额不为零说明未结转，余额本身就是本期累计发生额，
        // 比发生额列更可靠——发生额列可能是 MTD（本月）而不是 YTD（本年累计）。
        //
        // 发生额借、贷方案只有两列同时映射才成立：单边的 LLM 建议不能覆盖净额列。
        let split_period_scheme = first_col(&mapping, "periodFunctionalDebit").is_some()
            && first_col(&mapping, "periodFunctionalCredit").is_some();
        let any_closing = candidates
            .iter()
            .any(|(_, _, closing, _, _)| closing.is_some_and(|value| value.abs() >= 0.01));
        let basis = if any_closing {
            "期末余额"
        } else if split_period_scheme {
            "本期借贷发生额"
        } else {
            "期末余额"
        };
        let movement_of = |debit: Option<f64>, credit: Option<f64>| match (debit, credit) {
            // 借贷两列填了同一个数且同号，是「本期发生额」单列被拆着填，取其一即可。
            (Some(d), Some(c)) if (d - c).abs() < 0.01 && d.signum() == c.signum() => d,
            (Some(d), Some(c)) => d - c,
            (Some(d), None) => d,
            (None, Some(c)) => -c,
            (None, None) => 0.0,
        };
        let mut candidates = candidates
            .into_iter()
            .map(|(account, source_row, closing, debit, credit)| {
                let amount = if basis == "期末余额" {
                    closing.unwrap_or_else(|| movement_of(debit, credit))
                } else {
                    movement_of(debit, credit)
                };
                (account, source_row, amount)
            })
            .collect::<Vec<_>>();
        // Prefer detail accounts so a parent financial-expense row does not duplicate its child.
        candidates.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        for (account, source_row, amount) in candidates {
            if tb_rows.iter().any(|value: &Value| {
                let selected = value.get("account").and_then(Value::as_str).unwrap_or("");
                selected != account && selected.starts_with(&account)
            }) {
                continue;
            }
            let account_classification =
                classify_by_account_names(std::iter::once(account.as_str()));
            match account_classification {
                Some("已实现汇兑损益") => tb_realized_total += amount,
                Some("未实现汇兑损益") => tb_unrealized_total += amount,
                _ => tb_classification_complete = false,
            }
            tb_total += amount;
            tb_rows.push(json!({"account":account, "sourceRow":source_row, "amount":amount,
                "classification": account_classification.unwrap_or("无法区分"),
                "basis": basis,
                "scheme": if first_col(&mapping, "periodFunctionalDebit").is_some() && first_col(&mapping, "periodFunctionalCredit").is_some() {
                    "ERP借贷同额带符号时取单列，否则借方减贷方"
                } else { "TB未提供发生额时，取累计本位币金额" }}));
        }
    }
    let mut je_total = 0.0;
    let mut excluded = 0usize;
    if params.get("jeSource").is_some() {
        let (table, mapping) = load_mapped_je_table(params)?;
        let id_indexes = std::iter::once(first_col(&mapping, "date"))
            .flatten()
            .chain(mapped_cols(&mapping, "id"))
            .filter_map(|name| table.headers.iter().position(|header| header == &name))
            .collect::<Vec<_>>();
        let account_indexes = account_columns(&mapping)
            .iter()
            .filter_map(|name| table.headers.iter().position(|header| header == name))
            .collect::<Vec<_>>();
        let loss_keys =
            tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
        for (row, raw) in records(&table).into_iter().zip(table.rows.iter()) {
            if role_for(&account_name(&row, &mapping), params) != "fx_gain_loss" {
                continue;
            }
            if loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)) {
                excluded += 1;
                continue;
            }
            je_total += signed_amount(&row, &mapping, "functional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE汇兑损益金额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
        }
    }
    // 只要有一个损益明细科目无法从名称明确区分，就整体合并展示；不做部分
    // 拆分，避免“已拆分金额＋未分类余额”让使用者误以为已完整识别。
    let tb_presentation = if !tb_rows.is_empty() && tb_classification_complete {
        "split"
    } else {
        "combined"
    };
    Ok(json!({"tbFxGainLoss":tb_total, "tbRows":tb_rows,
        "tbFxGainLossPresentation": tb_presentation,
        "tbRealizedGainLoss": if tb_presentation == "split" { json!(tb_realized_total) } else { Value::Null },
        "tbUnrealizedGainLoss": if tb_presentation == "split" { json!(tb_unrealized_total) } else { Value::Null },
        "jeFxGainLossAfterTransferExclusion":je_total, "excludedTransferRows":excluded,
        "jeTbDifference":je_total-tb_total}))
}

fn voucher_account_pattern(
    rows: &[RowRecord],
    mapping: &Map<String, Value>,
) -> (String, String, Vec<String>, Vec<String>) {
    let mut debit = BTreeSet::new();
    let mut credit = BTreeSet::new();
    for row in rows {
        let amount = signed_amount(row, mapping, "functional").unwrap_or(0.0);
        if amount.abs() < 0.005 {
            continue;
        }
        let (code, name) = account_code_and_name(row, mapping);
        let raw_code = code.trim();
        let leading_code = raw_code
            .split_whitespace()
            .next()
            .filter(|value| value.chars().any(|character| character.is_ascii_digit()));
        let account = if let Some(value) = leading_code {
            value.to_uppercase()
        } else if raw_code.is_empty() {
            name.trim().to_owned()
        } else {
            raw_code.to_uppercase()
        };
        if account.is_empty() {
            continue;
        }
        if amount > 0.0 {
            debit.insert(account);
        } else {
            credit.insert(account);
        }
    }
    let debit = debit.into_iter().collect::<Vec<_>>();
    let credit = credit.into_iter().collect::<Vec<_>>();
    let key = format!("D:{}|C:{}", debit.join("+"), credit.join("+"));
    let debit_label = if debit.is_empty() {
        "—".into()
    } else {
        debit.join("、")
    };
    let credit_label = if credit.is_empty() {
        "—".into()
    } else {
        credit.join("、")
    };
    let label = format!("借：{debit_label}；贷：{credit_label}");
    (key, label, debit, credit)
}

fn build_review_bridge(
    params: &Value,
    realized: &[Value],
    unrealized: &[Value],
) -> Result<Value, AppError> {
    let Some(_) = params.get("jeSource") else {
        return Ok(json!({
            "pendingReviews": [], "pendingReviewAmount": 0.0,
            "pendingUnclassifiedCount": 0, "pendingUnmeasurableCount": 0,
            "notFxEventCount": 0, "notFxEventAmount": 0.0,
            "coveredBookFxGainLoss": 0.0, "jeFxGainLoss": null,
            "automaticCoveredVouchers": 0, "pendingReviewCount": 0,
            "classificationControls": []
        }));
    };
    let (table, mapping) = load_mapped_je_table(params)?;
    let realized_measured = realized
        .iter()
        .filter_map(|item| item.get("voucherId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let mut client_revaluation_recognized = HashSet::new();
    for item in unrealized {
        for id in item
            .get("clientRevaluationVoucherIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            client_revaluation_recognized.insert(id.to_owned());
        }
    }
    let id_indexes = std::iter::once(first_col(&mapping, "date"))
        .flatten()
        .chain(mapped_cols(&mapping, "id"))
        .filter_map(|name| table.headers.iter().position(|header| header == &name))
        .collect::<Vec<_>>();
    let account_indexes = account_columns(&mapping)
        .iter()
        .filter_map(|name| table.headers.iter().position(|header| header == name))
        .collect::<Vec<_>>();
    let loss_keys = tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
    let mut groups = BTreeMap::<String, Vec<RowRecord>>::new();
    for (row, raw) in records(&table).into_iter().zip(table.rows.iter()) {
        if !is_je_business_row(&row, &mapping)
            || loss_keys.contains(&tabular::voucher_key(raw, &id_indexes))
        {
            continue;
        }
        groups
            .entry(voucher_id(&row, &mapping, params))
            .or_default()
            .push(row);
    }
    let mut pending = Vec::new();
    let mut controls = Vec::new();
    let mut pending_amount = 0.0;
    let mut covered_book = 0.0;
    let mut je_total = 0.0;
    let mut covered_count = 0usize;
    // 未覆盖的凭证分两类计数（「待确认」已废止，分类必落二元或「不构成」）：
    // 「不构成汇兑事项」是结构与口径结论，披露即可；「已分类但缺重算证据」
    // 是工具算不了——两者混在一起显示会让用户误以为前者也在等确认。
    let mut not_fx_count = 0usize;
    let mut not_fx_amount = 0.0_f64;
    let mut unmeasurable_count = 0usize;
    for (id, rows) in groups {
        let mut booked = 0.0;
        let mut fx_accounts = BTreeSet::new();
        let mut all_accounts = BTreeSet::new();
        let mut currencies = BTreeSet::new();
        let mut has_non_monetary = false;
        for row in &rows {
            let account = account_name(row, &mapping);
            if !account.trim().is_empty() {
                all_accounts.insert(account.clone());
            }
            let currency = normalize_currency(cell(row, &mapping, "currency"));
            if !currency.is_empty() {
                currencies.insert(currency);
            }
            let role = role_for(&account, params);
            has_non_monetary |= role == "non_monetary";
            let functional = signed_amount(row, &mapping, "functional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE本位币金额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
            if role == "fx_gain_loss" {
                fx_accounts.insert(account.clone());
                booked += functional;
            }
        }
        if booked.abs() < 0.005 {
            continue;
        }
        je_total += booked;
        let display_id = display_voucher_id(&id);
        let is_realized_measured = realized_measured.contains(&display_id);
        let is_client_revaluation = client_revaluation_recognized.contains(&display_id);
        let is_measured = is_realized_measured || is_client_revaluation;
        if is_measured {
            covered_book += booked;
            covered_count += 1;
        }
        let voucher_type = rows
            .iter()
            .map(|row| cell(row, &mapping, "voucherType"))
            .find(|value| !value.trim().is_empty())
            .unwrap_or_default()
            .trim()
            .to_uppercase();
        let mut seen_summaries = HashSet::new();
        let summary = rows
            .iter()
            .map(|row| cell(row, &mapping, "summary").trim().to_owned())
            .filter(|value| !value.is_empty() && seen_summaries.insert(value.clone()))
            .collect::<Vec<_>>()
            .join(" | ");
        // 复核区与测算引擎共用同一套单凭证结构规则；汇兑损益科目只用于
        // 提取账面金额与名称冲突提示，不参与已实现/未实现定性。
        let structure = voucher_fx_structure(rows.iter(), &mapping, params)?;
        let structural_class = if structure.realized {
            Some("已实现汇兑损益")
        } else if structure.unrealized {
            Some("未实现汇兑损益")
        } else {
            Some("不构成汇兑事项")
        };
        let name_class = classify_by_account_names(fx_accounts.iter().map(String::as_str));
        let classification_conflict = match name_class {
            Some(name) if Some(name) != structural_class => Some(format!(
                "科目名称指向「{name}」，但凭证结构判定为「{}」；以结构为准，请复核客户科目使用是否恰当",
                structural_class.unwrap_or("不构成汇兑事项")
            )),
            _ => None,
        };
        let selected = manual_classification(params, &display_id)
            .or(structural_class)
            .unwrap_or("不构成汇兑事项");
        let (category, reason) = if has_non_monetary {
            (
                "非货币性项目/异常复核",
                "对方科目为预付款、存货、固定资产等非货币性项目，不产生外币汇兑损益；账面汇差建议重分类复核",
            )
        } else if selected == "不构成汇兑事项" {
            (
                "不构成汇兑事项",
                "凭证未同时满足净额非零的货币资金与对方货币性项目，也不满足原币净额为零、本位币净额非零的未实现结构；账面汇差已从测算总体剔除",
            )
        } else {
            match voucher_type.as_str() {
                "AB" => (
                    "手工调整/多行净额",
                    "手工调整、重分类或多行净额凭证，暂不执行复杂分摊",
                ),
                "FX" => (
                    "重估证据不足",
                    "重估影子科目、底层科目角色不明确或属于非货币性项目",
                ),
                "DZ" | "ZE" => (
                    "多对多结算",
                    "收付款结构包含多个货币性项目，无法可靠一对一匹配",
                ),
                _ => ("结算或重估证据不足", "结算或重估证据不足，无法可靠自动重算"),
            }
        };
        let (pattern_key, pattern_label, debit_accounts, credit_accounts) =
            voucher_account_pattern(&rows, &mapping);
        if !is_measured || manual_classification(params, &display_id).is_some() {
            controls.push(json!({
                "voucherId": display_id.clone(),
                "date": rows.iter().find_map(|row| parse_date(cell(row, &mapping, "date"))),
                "voucherType": voucher_type.clone(),
                "systemCategory": category,
                "bookedFxGainLoss": booked,
                "reviewReason": if is_client_revaluation {
                    "该凭证属于客户已入账未实现汇兑损益或其冲回，仅作为比较证据；审计金额来自外币货币性项目余额滚动，不采用本凭证金额作为测算结果"
                } else if selected == "不构成汇兑事项" {
                    reason
                } else if !is_measured {
                    "用户已确认分类，但缺少执行相应重算所需的原币、账面价值或汇率证据；本凭证未进入测算结果"
                } else { reason },
                "classification": selected,
                "classificationConflict": classification_conflict,
                "measurementStatus": if is_client_revaluation {
                    "已识别为未实现汇兑损益类凭证；审计金额按账户余额测算"
                } else if is_realized_measured {"测算成功"} else if selected == "不构成汇兑事项" {"不构成汇兑事项，账面汇差已剔除"} else {"无法测算，未纳入结果"},
                "patternKey": pattern_key, "patternLabel": pattern_label,
                "debitAccounts": debit_accounts, "creditAccounts": credit_accounts,
                "summary": summary.clone()
            }));
        }
        if is_measured {
            continue;
        }
        pending_amount += booked;
        // 「待确认」已废止：二元分类下凭证必落已实现/未实现/不构成之一。
        // 不构成汇兑事项的凭证既非待人也非算不出，单独计数披露。
        if selected == "不构成汇兑事项" {
            not_fx_count += 1;
            not_fx_amount += booked;
        } else {
            unmeasurable_count += 1;
        }
        pending.push(json!({
            "voucherId": display_id,
            "date": rows.iter().find_map(|row| parse_date(cell(row, &mapping, "date"))),
            "voucherType": voucher_type, "classification": selected,
            "selectedClassification": selected,
            "pendingCategory": category,
            "bookedFxGainLoss": booked, "reviewReason": reason,
            "fxAccounts": fx_accounts.into_iter().collect::<Vec<_>>(),
            "accounts": all_accounts.into_iter().collect::<Vec<_>>(),
            "currencies": currencies.into_iter().collect::<Vec<_>>(),
            "evidence": summary
        }));
    }
    let mut pattern_counts = HashMap::<String, usize>::new();
    for item in &controls {
        if let Some(key) = item.get("patternKey").and_then(Value::as_str) {
            *pattern_counts.entry(key.to_owned()).or_default() += 1;
        }
    }
    for item in &mut controls {
        if let Some(object) = item.as_object_mut() {
            let count = object
                .get("patternKey")
                .and_then(Value::as_str)
                .and_then(|key| pattern_counts.get(key))
                .copied()
                .unwrap_or(1);
            object.insert("patternVoucherCount".into(), json!(count));
        }
    }
    let pending_count = pending.len();
    Ok(json!({
        "pendingReviews": pending, "pendingReviewAmount": pending_amount,
        "coveredBookFxGainLoss": covered_book, "jeFxGainLoss": je_total,
        "automaticCoveredVouchers": covered_count,
        "pendingReviewCount": pending_count,
        "pendingUnclassifiedCount": 0,
        "pendingUnmeasurableCount": unmeasurable_count,
        "notFxEventCount": not_fx_count,
        "notFxEventAmount": not_fx_amount,
        "coverageDifference": je_total - covered_book - pending_amount,
        "classificationControls": controls
    }))
}

fn build_relevant_voucher_detail(
    params: &Value,
    realized: &[Value],
    unrealized: &[Value],
    pending: &[Value],
    account_translations: &HashMap<String, String>,
    translation_enabled: bool,
) -> Result<Vec<Value>, AppError> {
    let Some(_) = params.get("jeSource") else {
        return Ok(Vec::new());
    };
    let (table, mapping) = load_mapped_je_table(params)?;
    let tb_names = tb_account_name_lookup(params)?;
    let mut classes = HashMap::<String, (&str, String, String)>::new();
    for item in realized {
        if let Some(id) = item.get("voucherId").and_then(Value::as_str) {
            classes.insert(id.to_owned(), ("已实现", String::new(), String::new()));
        }
    }
    for item in unrealized {
        if let Some(id) = item.get("voucherId").and_then(Value::as_str) {
            classes
                .entry(id.to_owned())
                .or_insert(("未实现", String::new(), String::new()));
        }
        for id in item
            .get("clientRevaluationVoucherIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            classes
                .entry(id.to_owned())
                .or_insert(("未实现", String::new(), String::new()));
        }
    }
    for item in pending {
        if let Some(id) = item.get("voucherId").and_then(Value::as_str) {
            classes.insert(
                id.to_owned(),
                (
                    "待复核",
                    item.get("pendingCategory")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    item.get("reviewReason")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                ),
            );
        }
    }
    let mut output = Vec::new();
    for row in tb_leaf_records(&table, &mapping) {
        if !is_je_business_row(&row, &mapping) {
            continue;
        }
        let id = display_voucher_id(&voucher_id(&row, &mapping, params));
        let Some((classification, category, reason)) = classes.get(&id) else {
            continue;
        };
        let (account_code, je_account_name) = account_code_and_name(&row, &mapping);
        let account_name = if je_account_name.is_empty() {
            tb_names
                .get(&account_code.trim().to_uppercase())
                .cloned()
                .unwrap_or_default()
        } else {
            je_account_name
        };
        let foreign = signed_amount(&row, &mapping, "foreign").ok();
        let functional = signed_amount(&row, &mapping, "functional").ok();
        let mut value = Map::new();
        value.insert("voucherId".into(), json!(id));
        value.insert("classification".into(), json!(classification));
        value.insert("pendingCategory".into(), json!(category));
        value.insert("reviewReason".into(), json!(reason));
        value.insert("sourceRow".into(), json!(row.source_row));
        value.insert("date".into(), json!(cell(&row, &mapping, "date")));
        value.insert("entity".into(), json!(entity_for(&row, &mapping, params)));
        value.insert(
            "voucherType".into(),
            json!(cell(&row, &mapping, "voucherType")),
        );
        value.insert("summary".into(), json!(cell(&row, &mapping, "summary")));
        value.insert("accountCode".into(), json!(account_code));
        value.insert("accountNameOriginal".into(), json!(account_name));
        if translation_enabled {
            let chinese = if is_english_account_name(&account_name) {
                account_translations
                    .get(&account_code.trim().to_uppercase())
                    .cloned()
                    .unwrap_or_default()
            } else {
                account_name.clone()
            };
            value.insert("accountNameChinese".into(), json!(chinese));
        }
        value.insert("currency".into(), json!(cell(&row, &mapping, "currency")));
        value.insert(
            "foreignAmount".into(),
            foreign.map(Value::from).unwrap_or(Value::Null),
        );
        value.insert(
            "functionalAmount".into(),
            functional.map(Value::from).unwrap_or(Value::Null),
        );
        for (header, raw) in row.iter() {
            value
                .entry(format!("原始_{header}"))
                .or_insert(Value::String(raw.to_string()));
        }
        output.push(Value::Object(value));
    }
    Ok(output)
}

#[derive(Clone, Copy)]
struct FxProgressControl<'a> {
    progress: &'a dyn Fn(&str, usize, usize, &str),
    cancel: &'a AtomicBool,
    pause: &'a PauseCheckpoint,
}

fn calculate_realized(
    params: &Value,
    snapshot: &RateSnapshot,
    control: Option<FxProgressControl<'_>>,
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>), AppError> {
    let (table, mapping) = load_mapped_je_table(params)?;
    let id_indexes = std::iter::once(first_col(&mapping, "date"))
        .flatten()
        .chain(mapped_cols(&mapping, "id"))
        .filter_map(|name| table.headers.iter().position(|header| header == &name))
        .collect::<Vec<_>>();
    let account_indexes = account_columns(&mapping)
        .iter()
        .filter_map(|name| table.headers.iter().position(|header| header == name))
        .collect::<Vec<_>>();
    let loss_keys = tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
    let loss_ids = records(&table)
        .into_iter()
        .zip(table.rows.iter())
        .filter(|(_, raw)| loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)))
        .map(|(row, _)| voucher_id(&row, &mapping, params))
        .collect::<HashSet<_>>();
    let mut groups: BTreeMap<String, Vec<RowRecord>> = BTreeMap::new();
    let mut quality = Vec::new();
    for row in records(&table)
        .into_iter()
        .filter(|row| is_je_business_row(row, &mapping))
    {
        let id = voucher_id(&row, &mapping, params);
        if id.split('\u{1f}').any(|x| x.trim().is_empty()) {
            quality.push(json!({
                "source": "JE", "row": row.source_row,
                "type": "空匹配ID", "severity": "阻断"
            }));
        }
        groups.entry(id).or_default().push(row);
    }
    let mut calculation = Vec::new();
    let mut classes = Vec::new();
    // 仅剩候选证据的外币业务凭证（投资款、外币收息等）：不构成汇兑事项、
    // 原币已进余额滚动，但此前完全不可见——聚合一条提示让复核看得到。
    let mut candidate_vouchers: Vec<String> = Vec::new();
    let group_count = groups.len();
    for (group_index, (id, rows)) in groups.into_iter().enumerate() {
        if group_index % 500 == 0 {
            if let Some(control) = control {
                checkpoint(control.cancel, control.pause)?;
                (control.progress)(
                    "realized",
                    4,
                    10,
                    &format!(
                        "正在识别并测算已实现汇兑事项：已处理 {group_index}/{group_count} 张凭证…"
                    ),
                );
            }
        }
        if loss_ids.contains(&id) {
            classes.push(json!({
                "voucherId": display_voucher_id(&id),
                "classification": "损益结转剔除",
                "eventType": "期间损益结转",
                "realizedScore": 0.0,
                "unrealizedScore": 0.0,
                "matchedRules": ["复用kanzhang：完整凭证含本年利润或未分配利润"],
                "counterEvidence": [],
                "confidence": "高",
                "ruleConflict": false
            }));
            continue;
        }
        let Some(date) = rows
            .iter()
            .find_map(|r| parse_date(cell(r, &mapping, "date")))
        else {
            continue;
        };
        let display_id = display_voucher_id(&id);
        let manual = manual_classification(params, &display_id);
        let manual_realized = manual == Some("已实现汇兑损益");
        let manual_unrealized = manual == Some("未实现汇兑损益");
        let mut has_fx = false;
        let mut has_foreign_currency = false;
        let mut settlement_targets = Vec::new();
        // 外币货币性行本身（行币种≠本位币且原币有发生）：外币账户间划转
        // （无兑换配比、无终止确认对手）时按腿逐条输出客户账面认可行。
        let mut foreign_monetary_rows: Vec<(&RowRecord, String, String, String, f64, f64)> =
            Vec::new();
        // 外币兑换证据：外币现金行（结汇=减少、购汇=增加两个方向都收）、
        // 本位币现金腿合计金额。
        let mut cash_foreign_rows = Vec::new();
        let mut cash_functional_movement = false;
        // 本位币现金腿的合计金额：兑换凭证的金额配比判断要用（见下方
        // conversion_pairing_ok），只判真假不够。
        let mut cash_functional_total = 0.0_f64;
        let mut cash_foreign_movement = false;
        let mut noncash_foreign_movement = false;
        let mut cash_settlements = HashMap::<String, (f64, f64)>::new();
        // 客户账面汇差合计（汇兑损益行的本位币净额）与首行定位，兜底
        // 「外币账户间划转」按客户账面认可时使用。
        let mut fx_booked_total = 0.0_f64;
        for row in &rows {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            has_fx |= role == "fx_gain_loss";
            if role == "fx_gain_loss" {
                if let Ok(value) = signed_amount(row, &mapping, "functional") {
                    fx_booked_total += value;
                }
            }
            let is_cash = role == "cash" || is_cash_account(&account, params);
            let entity = entity_for(row, &mapping, params);
            let currency = normalize_currency(&currency_for(row, &mapping, &account, params));
            let functional = normalize_currency(&functional_currency(entity, params));
            has_foreign_currency |=
                !currency.is_empty() && !functional.is_empty() && currency != functional;
            if matches!(
                role.as_str(),
                "monetary_asset" | "monetary_liability" | "cash"
            ) {
                let foreign = signed_amount(row, &mapping, "foreign").map_err(|e| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "JE关键金额存在无法解析的非空值。",
                        Some(format!("第{}行：{e}", row.source_row)),
                    )
                })?;
                let functional_amount = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
                if !currency.is_empty() && currency != functional {
                    if foreign.abs() >= 0.005 {
                        foreign_monetary_rows.push((
                            row,
                            account.clone(),
                            role.clone(),
                            currency.clone(),
                            foreign,
                            functional_amount,
                        ));
                    }
                }
                if is_cash && foreign.abs() >= 0.005 && functional_amount.abs() >= 0.005 {
                    let currency =
                        normalize_currency(&currency_for(row, &mapping, &account, params));
                    let item = cash_settlements.entry(currency).or_default();
                    item.0 += foreign;
                    item.1 += functional_amount;
                }
                let entity_currency = normalize_currency(&functional_currency(entity, params));
                if is_cash {
                    if currency.is_empty() || currency == entity_currency {
                        cash_functional_movement |= functional_amount.abs() >= 0.01;
                        cash_functional_total += functional_amount;
                    } else {
                        cash_foreign_movement |= foreign.abs() >= 0.01;
                        // 外币现金行不论方向都收集：结汇（减少）与购汇（增加）
                        // 都属外币兑换，统一按月初牌价与交易日官方牌价测算；
                        // 方向差异由下方符号约定吸收，客户实际成交价差则
                        // 落入「审计 vs 账面」比较披露，不进损益公式。
                        if foreign.abs() >= 0.005 {
                            cash_foreign_rows.push((
                                row,
                                account.clone(),
                                role.clone(),
                                foreign,
                                functional_amount,
                            ));
                        }
                    }
                } else {
                    noncash_foreign_movement |= foreign.abs() >= 0.01;
                }
                let terminates_asset = !is_cash && role == "monetary_asset" && foreign < -0.005;
                let terminates_liability = role == "monetary_liability" && foreign > 0.005;
                if terminates_asset || terminates_liability {
                    settlement_targets.push((row, account, role, foreign, functional_amount));
                }
            }
        }
        // Some ERP exports use a credit-positive convention for both the cash
        // and receivable/payable rows.  When a monetary row and a cash row in
        // the same currency have opposite original-currency signs and closely
        // matching amounts, the cash leg itself proves settlement direction.
        // This avoids leaving clear customer receipts in manual review merely
        // because the export sign convention differs from debit-positive JE.
        for row in &rows {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            if !matches!(role.as_str(), "monetary_asset" | "monetary_liability")
                || is_cash_account(&account, params)
                || settlement_targets
                    .iter()
                    .any(|(candidate, ..)| candidate.source_row == row.source_row)
            {
                continue;
            }
            let foreign = signed_amount(row, &mapping, "foreign").map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE关键金额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })?;
            let functional = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
            let currency = normalize_currency(&currency_for(row, &mapping, &account, params));
            let cash_foreign = cash_settlements
                .get(&currency)
                .map(|(cash_foreign, _)| *cash_foreign)
                .unwrap_or(0.0);
            let comparable = foreign.abs().min(cash_foreign.abs())
                / foreign.abs().max(cash_foreign.abs()).max(0.005);
            if foreign * cash_foreign < 0.0 && comparable >= 0.5 {
                settlement_targets.push((row, account, role, foreign, functional));
            }
        }
        // 定性只看单张凭证内按公司＋币种＋货币性科目汇总后的净额：
        // 资金净额非零且对方货币性项目净额非零 → 已实现；否则外币原币
        // 净额为零、本位币净额非零 → 未实现。汇兑损益科目不参与定性。
        let structure = voucher_fx_structure(rows.iter(), &mapping, params)?;
        let automatic_revaluation = structure.unrealized;
        let revaluation_signal = !manual_realized && (manual_unrealized || automatic_revaluation);
        // 无汇兑损益科目行的兑换凭证：客户把价差埋在成交价里、凭证里没有
        // 损益行（用友结汇常见），这恰是审计必须独立重算的对象——此前被
        // has_fx 门槛静默放过（2024 用友真实样例：50 万美元结汇零测算）。
        // 放开门槛但要求两条现金腿金额配比：本位币现金腿 ≈ 外币现金腿 ×
        // 记账日官方牌价（5% 容差）。配比是把「外币收息＋本币收息」这类
        // 同凭证并排业务排除在外的关键——外币腿折算值与本币腿金额差着
        // 两个数量级，不可能配对成功。
        let conversion_pairing_ok = !has_fx
            && cash_foreign_movement
            && cash_functional_movement
            && !noncash_foreign_movement
            && settlement_targets.is_empty()
            && cash_settlements.len() == 1
            && cash_foreign_rows.first().is_some_and(|(row, ..)| {
                let entity = entity_for(row, &mapping, params);
                let functional_code = functional_currency(&entity, params);
                cash_settlements
                    .iter()
                    .next()
                    .is_some_and(|(currency, (foreign_sum, _))| {
                        rate(snapshot, date, currency, &functional_code).is_some_and(
                            |(official, _)| {
                                let expected = foreign_sum.abs() * official;
                                let actual = cash_functional_total.abs();
                                expected > 0.005
                                    && actual > 0.005
                                    && (actual - expected).abs() / expected.max(actual) <= 0.05
                            },
                        )
                    })
            });
        // 外币兑换：外币货币资金与本位币货币资金对转、差额进汇兑损益，
        // 同样构成已实现结算证据；此时无终止确认行，以外币现金行为重算对象。
        let conversion_pattern = (has_fx || conversion_pairing_ok)
            && cash_foreign_movement
            && cash_functional_movement
            && !noncash_foreign_movement
            && settlement_targets.is_empty();
        // A functional-currency-only voucher without an FX gain/loss account is
        // outside the FX audit population.  Do not present ordinary RMB JEs as
        // unresolved FX events merely because their text resembles settlement.
        if !has_fx && !has_foreign_currency {
            continue;
        }
        // 手工指定仍优先；自动定性不依赖汇兑损益科目、凭证类型或摘要。
        let realized_hard = manual_realized || (!manual_unrealized && structure.realized);
        let unrealized_hard =
            !realized_hard && (manual_unrealized || (revaluation_signal && structure.unrealized));
        let class = if realized_hard {
            "已实现"
        } else if unrealized_hard {
            "未实现"
        } else {
            "不构成汇兑事项"
        };
        let confidence = if manual_realized || manual_unrealized {
            "高（用户指定）"
        } else if realized_hard || unrealized_hard {
            "高"
        } else {
            "高（结构判定）"
        };
        classes.push(json!({
            "voucherId": display_id, "classification": class,
            "eventType": if realized_hard {"货币资金结构"} else if unrealized_hard {"重估"} else {"非汇兑事项"},
            "matchedRules": [if manual_realized {
                "用户按同借贷科目凭证类型确认为已实现；重新执行结算测算"
            } else if manual_unrealized {
                "用户按同借贷科目凭证类型确认为未实现；重新执行重估测算"
            } else if realized_hard {
                "单张凭证内货币资金净额非零，且对方货币性项目净额非零"
            } else if unrealized_hard {
                "按公司＋币种＋货币性科目汇总后，原币净额为零且本位币净额非零"
            } else {
                "货币性腿全为本位币或对手为非货币性项目：不构成外币汇兑事项"
            }],
            "confidence": confidence, "ruleConflict": realized_hard && unrealized_hard
        }));
        if !realized_hard && !unrealized_hard && (has_fx || has_foreign_currency) {
            // 客户把汇差挂进了汇兑损益科目，但凭证结构不含外币货币性项目
            // （或对手全为非货币性项目）——账面汇差不构成汇兑损益，剔除并
            // 披露计数与金额，供与 TB 勾稽时解释。
            candidate_vouchers.push(display_voucher_id(&id));
        }
        if manual_realized && settlement_targets.is_empty() && !conversion_pattern {
            quality.push(json!({
                "source":"JE", "voucherId":display_voucher_id(&id),
                "type":"用户确认已实现但无法重算", "severity":"提示",
                "detail":"完整凭证中未识别到可终止确认的外币货币性项目及其历史账面价值；未采用账面汇兑损益替代测算。"
            }));
        }
        if realized_hard && !has_fx && !conversion_pattern {
            quality.push(json!({
                "source": "JE", "voucherId": display_voucher_id(&id),
                "type": "已实现候选缺少历史账面价值证据", "severity": "待复核",
                "detail": "交易行本位币金额是结算金额，不能直接替代终止确认项目的历史账面价值；本凭证不计入自动测算总额。"
            }));
        }
        if realized_hard {
            let mut targets = settlement_targets.clone();
            if conversion_pattern {
                targets.extend(cash_foreign_rows.clone());
            }
            // 兜底分支（外币账户间划转）要看 targets 是否为空，先记下来
            // 再把 targets 按值交给下方循环。
            let no_targets = targets.is_empty();
            for (row, account, role, foreign, functional) in targets {
                let entity = entity_for(row, &mapping, params);
                let currency = currency_for(row, &mapping, &account, params);
                let functional_code = functional_currency(entity, params);
                let day_rate = rate(snapshot, date, &currency, &functional_code);
                let opening = month_opening_rate(snapshot, date, &currency, &functional_code);
                let day_missing = day_rate.is_none();
                if let (
                    Some((official_rate, published)),
                    Some((opening_rate, opening_published, opening_fallback)),
                ) = (day_rate, opening)
                {
                    let settlement = foreign.abs();
                    let normalized_currency = normalize_currency(&currency);
                    let cash_pair = cash_settlements.get(&normalized_currency).copied();
                    let cash_implied_rate =
                        cash_pair.and_then(|(cash_foreign, cash_functional)| {
                            if cash_foreign.abs() < 0.005 || cash_functional.abs() < 0.005 {
                                None
                            } else {
                                let value = cash_functional.abs() / cash_foreign.abs();
                                value.is_finite().then_some(value)
                            }
                        });
                    // 已实现公式分两类（用户拍板：成交价差属已实现汇兑损益）：
                    // ①外币兑换——真实银行成交价存在，已实现＝（成交价−月初
                    // 牌价）×原币，成交价按本位币现金腿合计÷外币现金腿倒算
                    // 全口径实付（含损益行，SAP 分离入账也能还原 7.23 这类
                    // 全成本价）；②终止确认（应收/应付核销，无货币兑换）——
                    // 没有成交价，维持官方牌价独立重算，客户入账价不得反向
                    // 污染审计口径。官方牌价在兑换路径只作对照披露。
                    let conversion_deal_rate = if conversion_pattern {
                        cash_settlements
                            .iter()
                            .next()
                            .and_then(|(_, (foreign_sum, _))| {
                                if foreign_sum.abs() >= 0.005
                                    && cash_functional_total.abs() >= 0.005
                                {
                                    let rate = cash_functional_total.abs() / foreign_sum.abs();
                                    rate.is_finite().then_some(rate)
                                } else {
                                    None
                                }
                            })
                    } else {
                        None
                    };
                    let (applied_rate, applied_basis) = match conversion_deal_rate {
                        Some(rate) => (rate, "实际成交价"),
                        None => (official_rate, "记账日官方牌价"),
                    };
                    let carrying = settlement * opening_rate;
                    let translated = settlement * applied_rate;
                    // The sign of the derecognized foreign-currency row captures
                    // the export's debit/credit convention.  A positive target
                    // (liability decrease) uses translated minus carrying; a
                    // negative target (asset decrease) uses the inverse.  The
                    // result keeps the FX-account debit-positive sign convention
                    // while also supporting credit-positive SAP exports.
                    let gain_loss = if foreign > 0.0 {
                        translated - carrying
                    } else {
                        carrying - translated
                    };
                    if conversion_pattern && conversion_deal_rate.is_none() {
                        quality.push(json!({
                            "source": "JE", "voucherId": display_voucher_id(&id),
                            "row": row.source_row, "type": "兑换成交价不可倒算",
                            "currency": currency, "severity": "提示",
                            "detail": "凭证被识别为外币兑换但现金腿金额不完整，无法倒算实际成交价，本次以记账日官方牌价测算；请结合银行回单复核。"
                        }));
                    }
                    calculation.push(json!({
                        "voucherId": display_voucher_id(&id), "date": date,
                        "entity": entity, "account": account, "role": role,
                        "currency": currency, "functionalCurrency": functional_code,
                        "settlementForeign": settlement, "officialRate": official_rate,
                        "targetForeignSigned": foreign,
                        "customerAppliedRate": cash_implied_rate,
                        "appliedRate": applied_rate, "rateBasis": applied_basis,
                        "rateSource": RATE_SOURCE,
                        "calculationMethod": if conversion_pattern {
                            "外币兑换：月初牌价与实际成交价重算（官方牌价对照）"
                        } else {
                            "终止确认：月初牌价与交易日官方牌价独立重算"
                        },
                        "publishedDate": published,
                        "monthOpeningRate": opening_rate,
                        "monthOpeningRateDate": opening_published,
                        "monthOpeningRateFallback": opening_fallback,
                        "carryingFunctional": carrying,
                        "carryingBookFunctional": functional.abs(),
                        "translatedFunctional": translated, "auditGainLoss": gain_loss,
                        "carryingBasisDifference": carrying - functional.abs(),
                        "cashRequired": false, "sourceRow": row.source_row
                    }));
                    if opening_fallback {
                        quality.push(json!({
                            "source": "JE", "voucherId": display_voucher_id(&id),
                            "row": row.source_row, "type": "月初牌价口径回退",
                            "currency": currency, "severity": "提示",
                            "detail": "上月末未取到该币种牌价，月初牌价回退为当月最早牌价，与月末重估口径不完全一致；请复核数据来源。"
                        }));
                    }
                } else {
                    quality.push(json!({
                        "source": "JE", "row": row.source_row,
                        "type": if day_missing { "汇率缺失" } else { "月初牌价缺失" },
                        "currency": currency, "severity": "隔离",
                        "detail": if day_missing {
                            Value::Null
                        } else {
                            json!("无法取得该币种月初（上月末）牌价，本腿不计入自动测算。")
                        }
                    }));
                }
            }
            // 外币账户间划转（同币种外币账户互转、资金池内部结算）：有外币
            // 原币变动但既非兑换配比、也无终止确认对手，凭证内没有可独立
            // 重算的历史账面价值与成交价——汇兑损益按客户账面认可（金额
            // 记入首条腿，合计口径与其余已实现一致），各腿按月初牌价折算
            // 入余额滚动（经 sourceRow 索引，与终止确认同一机制，避免已
            // 实现在月末重估残差里重复计），并披露待资金池/银行对账单验证。
            if no_targets {
                for (index, (row, account, role, currency, foreign, functional)) in
                    foreign_monetary_rows.iter().enumerate()
                {
                    let entity = entity_for(row, &mapping, params);
                    let functional_code = functional_currency(entity, params);
                    if let Some((opening_rate, opening_published, opening_fallback)) =
                        month_opening_rate(snapshot, date, currency, &functional_code)
                    {
                        let settlement = foreign.abs();
                        let carrying = settlement * opening_rate;
                        calculation.push(json!({
                            "voucherId": display_voucher_id(&id), "date": date,
                            "entity": entity, "account": account, "role": role,
                            "currency": currency, "functionalCurrency": functional_code,
                            "settlementForeign": settlement,
                            "targetForeignSigned": foreign,
                            "appliedRate": opening_rate, "rateBasis": "月初牌价（入账基础）",
                            "rateSource": RATE_SOURCE,
                            "calculationMethod": "外币账户间划转：无独立重算证据，汇兑损益按客户账面认可，待资金池/银行对账单验证",
                            "monthOpeningRate": opening_rate,
                            "monthOpeningRateDate": opening_published,
                            "monthOpeningRateFallback": opening_fallback,
                            "carryingFunctional": carrying,
                            "carryingBookFunctional": functional.abs(),
                            "translatedFunctional": carrying,
                            "auditGainLoss": if index == 0 { fx_booked_total } else { 0.0 },
                            "carryingBasisDifference": carrying - functional.abs(),
                            "cashRequired": false, "sourceRow": row.source_row
                        }));
                    } else {
                        quality.push(json!({
                            "source": "JE", "voucherId": display_voucher_id(&id),
                            "row": row.source_row, "type": "月初牌价缺失", "severity": "隔离",
                            "detail": "外币账户间划转腿无法取得月初牌价入账基础，本腿不计入自动测算。"
                        }));
                    }
                }
            }
        }
    }
    if !candidate_vouchers.is_empty() {
        let shown = candidate_vouchers
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("、");
        let hidden = candidate_vouchers.len().saturating_sub(5);
        quality.push(json!({
            "source": "JE",
            "type": "外币业务凭证不构成汇兑事项",
            "severity": "提示",
            "detail": format!(
                "共{}张外币凭证未同时识别到净额非零的货币资金和对方货币性项目，也不满足原币净额为零、本位币净额非零的未实现结构（如{}{}）；其原币变动已按月纳入外币余额滚动。请核对货币资金及对方清算科目的角色映射是否完整。",
                candidate_vouchers.len(),
                shown,
                if hidden > 0 { format!(" 等，另{}张", hidden) } else { String::new() }
            )
        }));
    }
    Ok((calculation, classes, quality))
}

fn calculate_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    realized: &[Value],
    classification: &[Value],
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("tbSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "tbMapping");
    let account_policy = account_match_policy(params)?;
    let start = parse_date(
        params
            .get("reportStart")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期开始日无效。", None))?;
    let end = parse_date(
        params
            .get("reportEnd")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期结束日无效。", None))?;
    let has_je = params.get("jeSource").is_some();
    let has_foreign_balances = amount_scheme_ok(&mapping, "openingForeign")
        && amount_scheme_ok(&mapping, "closingForeign");
    if has_je && !has_foreign_balances {
        return calculate_inferred_opening_unrealized(
            params,
            snapshot,
            start,
            end,
            &table,
            &mapping,
            realized,
            classification,
            &account_policy,
        );
    }
    let mut output = Vec::new();
    let mut quality = Vec::new();
    let mut seen = HashSet::new();
    for row in records(&table) {
        let entity = entity_for(&row, &mapping, params);
        let account = account_name(&row, &mapping);
        let currency = currency_for(&row, &mapping, &account, params);
        let auxiliary = mapped_cols(&mapping, "auxiliary")
            .iter()
            .filter_map(|c| row.get(c.as_str()))
            .map(|v| v.trim())
            .collect::<Vec<_>>()
            .join("|");
        // 去重键与匹配键同口径：同一公司同一科目下的多行（按币种或费用性质拆行）
        // 会各自重估后相加，这里只用来提示「同一余额键有多行」。
        let key = format!(
            "{}\u{1f}{currency}",
            balance_match_key_for_account(entity, &account, "", false, &account_policy)
        );
        // 同一余额键的多行按各自的余额独立重估，结果自然相加——
        // 旧版在这里直接 `continue` 丢掉后来的行，按费用性质拆行的 TB 会少算一大截。
        if !seen.insert(key.clone()) {
            // 提示里的键展示账里原本的编码写法，不用去零后的匹配键。
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "同一余额键多行",
                "key": format!(
                    "{}\u{1f}{}\u{1f}{currency}",
                    entity.trim(),
                    account_match_key(&account).trim().to_uppercase()
                ),
                "severity": "合并",
                "detail": "该行与前面某行的主体＋科目＋币种相同，已各自重估后合并计入。"
            }));
        }
        let role = role_for(&account, params);
        if matches!(
            role.as_str(),
            "non_monetary" | "fx_gain_loss" | "other_pnl" | "excluded" | "review" | "unassigned"
        ) {
            continue;
        }
        let parse = |prefix: &str| {
            signed_amount(&row, &mapping, prefix).map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "TB关键余额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })
        };
        let opening_foreign = parse("openingForeign")?;
        let opening_local = parse("openingFunctional")?;
        let closing_foreign = parse("closingForeign")?;
        let closing_local = parse("closingFunctional")?;
        let functional_code = functional_currency(entity, params);
        let Some((opening_rate, opening_published)) =
            rate(snapshot, start, &currency, &functional_code)
        else {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "汇率缺失",
                "currency": currency, "severity": "隔离"
            }));
            continue;
        };
        let Some((closing_rate, closing_published)) =
            rate(snapshot, end, &currency, &functional_code)
        else {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "汇率缺失",
                "currency": currency, "severity": "隔离"
            }));
            continue;
        };
        let opening_audit = opening_foreign * opening_rate;
        let closing_audit = closing_foreign * closing_rate;
        let opening_difference = opening_audit - opening_local;
        let closing_difference = closing_audit - closing_local;
        output.push(json!({
            "entity": entity, "account": account, "auxiliary": auxiliary,
            "currency": currency, "functionalCurrency": functional_code,
            "openingForeign": opening_foreign, "openingBookFunctional": opening_local,
            "openingRateDate": start.format("%Y-%m-%d").to_string(),
            "openingRate": opening_rate, "openingPublishedDate": opening_published,
            "openingAuditFunctional": opening_audit, "openingDifference": opening_difference,
            "closingForeign": closing_foreign, "closingBookFunctional": closing_local,
            "closingRateDate": end.format("%Y-%m-%d").to_string(),
            "closingRate": closing_rate, "closingPublishedDate": closing_published,
            "closingAuditFunctional": closing_audit, "closingDifference": closing_difference,
            "twoPointChange": closing_difference - opening_difference,
            "suggestedAdjustment": closing_difference,
            "method": if has_je {
                "月度滚动（TB端点勾稽）"
            } else {
                "年初/年末两时点检查"
            },
            "sourceRow": row.source_row
        }));
    }
    if has_je {
        let monthly = calculate_monthly_unrealized(
            params,
            snapshot,
            start,
            end,
            &output,
            &mut quality,
            realized,
            classification,
        )?;
        Ok((monthly, quality))
    } else {
        Ok((output, quality))
    }
}

fn calculate_inferred_opening_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    start: NaiveDate,
    end: NaiveDate,
    tb_table: &FxTable,
    tb_mapping: &Map<String, Value>,
    realized: &[Value],
    classification: &[Value],
    account_policy: &ledger_mapping::AccountMatchPolicy,
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let (je_table, je_mapping) = load_mapped_je_table(params)?;
    let has_opening_local = amount_scheme_ok(tb_mapping, "openingFunctional");
    let mut je_functional_movements = HashMap::<String, f64>::new();
    let mut je_foreign_movements = HashMap::<String, f64>::new();
    let mut account_currencies = HashMap::<String, BTreeSet<String>>::new();
    // 一个科目「有几种外币」不能按凭证货币的种类数数：客户把外币评估调整
    // 记在影子科目上时，凭证货币写的是被调整的那种外币，但原币金额恒为零
    // ——它不持有任何该币种，只承载本位币差额。实测 4800：应付账款-关联方
    // 因为 51 行原币为零的日元记录被判成「两种外币」而整体隔离，5.4 亿人民币
    // 敞口随之作废。所以真正的敞口判据是**累计原币金额是否非零**。
    let mut account_foreign_net = HashMap::<String, f64>::new();
    // 本位币凭证行的净额：科目余额里沉淀了多少本位币。TB 只给到科目粒度，
    // 若同一科目既沉淀本位币又持有外币，科目级余额就无法整体归给那种外币
    // （4800 的应付账款-关联方沉淀了 4,799 万美元，另有 5.4 亿人民币敞口，
    // TB 上却只有一行合计）——这种情况必须隔离，不能拿合计余额乘汇率。
    let mut account_functional_net = HashMap::<String, f64>::new();
    for row in records(&je_table) {
        if !is_je_business_row(&row, &je_mapping) {
            continue;
        }
        let account = account_name(&row, &je_mapping);
        if !matches!(
            role_for(&account, params).as_str(),
            "cash" | "monetary_asset" | "monetary_liability"
        ) {
            continue;
        }
        let entity = entity_for(&row, &je_mapping, params);
        let currency = currency_for(&row, &je_mapping, &account, params);
        let auxiliary = auxiliary_value(&row, &je_mapping);
        if currency.is_empty() {
            continue;
        }
        // 走统一匹配键：辅助核算不进键——TB 常常没有这一列而 JE 按往来单位
        // 拆行，手工拼进去会让两边全盘失配。
        let account_currency_key =
            balance_match_key_for_account(entity, &account, "", false, account_policy);
        let functional_of_row =
            signed_amount(&row, &je_mapping, "functional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE本位币金额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
        if currency == functional_currency(entity, params) {
            *account_functional_net
                .entry(account_currency_key)
                .or_default() += functional_of_row;
            continue;
        }
        let code = normalize_currency(&currency);
        let foreign_of_row = signed_amount(&row, &je_mapping, "foreign").map_err(|detail| {
            error(
                "NUMERIC_PARSE_FAILED",
                "JE原币金额无法解析。",
                Some(format!("第{}行：{detail}", row.source_row)),
            )
        })?;
        // 用净额而不是累计绝对值。实测 4800：银行存款-建行、应收账款-关联方
        // 这些**纯本位币科目**上也挂着几行外币凭证货币的评估调整，一借一贷
        // 抵平——按累计绝对值会把它们判成「持有外币」，再靠后面的混合检查
        // 兜底，判据链条就乱了。净额为零就是没敞口，直接、准确。
        *account_foreign_net
            .entry(format!("{account_currency_key}\u{1f}{code}"))
            .or_default() += foreign_of_row;
        account_currencies
            .entry(account_currency_key)
            .or_default()
            .insert(code);
        let key =
            balance_match_key_for_account(entity, &account, &auxiliary, false, account_policy);
        *je_functional_movements.entry(key.clone()).or_default() += functional_of_row;
        *je_foreign_movements.entry(key).or_default() += foreign_of_row;
    }
    // 名义币种里剔掉原币恒为零的，剩下的才是真外币敞口。
    let account_nominal_currencies = account_currencies.clone();
    for (account_key, currencies) in account_currencies.iter_mut() {
        currencies.retain(|code| {
            account_foreign_net
                .get(&format!("{account_key}\u{1f}{code}"))
                .copied()
                .unwrap_or(0.0)
                .abs()
                >= 0.01
        });
    }

    let mut endpoints = Vec::new();
    let mut quality = vec![json!({
        "source":"TB+JE", "type":"期初原币余额估算", "severity":"重要提示",
        "detail":"TB未提供原币余额；系统以期初本位币余额÷期初官方汇率估算期初原币，再用JE原币发生额滚动。该结果属于受限测算，底稿单独披露，不以客户已入账未实现汇兑损益凭证倒算审计金额。未实现测算的精度直接依赖该估算值（已实现测算不受影响），建议以银行对账单或函证确认年初外币余额后重算。"
    })];
    for row in tb_leaf_records(tb_table, tb_mapping) {
        let account = account_name(&row, tb_mapping);
        if !matches!(
            role_for(&account, params).as_str(),
            "cash" | "monetary_asset" | "monetary_liability"
        ) {
            continue;
        }
        let entity = entity_for(&row, tb_mapping, params);
        let mapped_currency = currency_for(&row, tb_mapping, &account, params);
        let auxiliary = auxiliary_value(&row, tb_mapping);
        let functional = functional_currency(entity, params);
        // 走统一匹配键：辅助核算不进键——TB 常常没有这一列而 JE 按往来单位
        // 拆行，手工拼进去会让两边全盘失配。
        let account_currency_key =
            balance_match_key_for_account(entity, &account, "", false, account_policy);
        let inferred_currencies = account_currencies.get(&account_currency_key);
        // TB 只给到「科目」粒度，而外币敞口是「科目×币种」粒度的。能不能把
        // 科目级余额整体归给某一种外币，取决于三件事，缺一不可：
        //   1. 只有一种真外币敞口（原币非零）；
        //   2. 该科目没有沉淀本位币余额（否则合计余额里混了两部分）；
        //   3. 币种取得到汇率。
        // 任何一条不成立都隔离——宁可算不出来，也不能拿混合余额乘汇率造假数。
        let functional_residue = account_functional_net
            .get(&account_currency_key)
            .copied()
            .unwrap_or(0.0);
        let currency = if !mapped_currency.is_empty() && mapped_currency != functional {
            normalize_currency(&mapped_currency)
        } else if let Some(values) = inferred_currencies.filter(|values| values.len() == 1) {
            let only = values.iter().next().cloned().unwrap_or_default();
            // 本位币沉淀相对科目余额可忽略时才算「纯外币科目」；结算过账带来的
            // 零头不该误伤，所以同时看绝对额与占科目余额的比重。
            let closing_reference = signed_amount(&row, tb_mapping, "closingFunctional")
                .unwrap_or(0.0)
                .abs();
            // 阈值放到 5%：外币账户偶尔有本位币过账是正常的，只有本位币
            // 沉淀到「已经改变余额构成」的程度，科目级合计余额才不可归属。
            let mixed = functional_residue.abs() > 1.0
                && functional_residue.abs() > closing_reference * 0.05;
            if mixed {
                quality.push(json!({
                    "source":"TB+JE", "row":row.source_row,
                    "type":"科目余额混合本位币与外币", "account":account,
                    "currency":only, "functionalResidue":functional_residue,
                    "severity":"隔离",
                    "detail":format!(
                        "该科目既有{only}余额，又沉淀了{:.2}的本位币；TB 只有科目合计，拆不出其中属于{only}的部分。请提供按币种拆分的科目余额表后重算。",
                        functional_residue
                    )
                }));
                continue;
            }
            only
        } else {
            let nominal = account_nominal_currencies.get(&account_currency_key);
            if inferred_currencies.is_some_and(|values| values.len() > 1) {
                let detail = inferred_currencies
                    .map(|values| values.iter().cloned().collect::<Vec<_>>().join("、"))
                    .unwrap_or_default();
                quality.push(json!({
                    "source":"TB+JE", "row":row.source_row,
                    "type":"同一科目存在多种外币敞口", "account":account,
                    "currencies":inferred_currencies,
                    "severity":"隔离",
                    "detail":format!(
                        "该科目同时有 {detail} 多种外币余额，TB 只有科目合计，拆不出各币种分别是多少。请提供按币种拆分的科目余额表后重算。"
                    )
                }));
            } else if inferred_currencies.is_some_and(|values| values.is_empty())
                && nominal.is_some_and(|values| !values.is_empty())
                // 本位币科目上挂几行外币凭证货币的调整记录很常见（4800 有 5 个），
                // 那只是本位币科目，不该当成问题报给用户；真正要提醒的是
                // 「没有本位币业务、余额却全由评估调整堆出来」的影子科目。
                && functional_residue.abs() <= 1.0
                && signed_amount(&row, tb_mapping, "closingFunctional")
                    .unwrap_or(0.0)
                    .abs()
                    > 0.01
            {
                // 这类形态多半是客户的评估调整科目，但原币为零也可能只是
                // 序时账没填原币金额——文案只陈述事实，不下「评估调整」的判语。
                let detail = nominal
                    .map(|values| values.iter().cloned().collect::<Vec<_>>().join("、"))
                    .unwrap_or_default();
                quality.push(json!({
                    "source":"TB+JE", "row":row.source_row,
                    "type":"外币凭证原币金额全为零", "account":account,
                    "currencies":nominal,
                    "severity":"隔离",
                    "detail":format!(
                        "该科目挂着 {detail} 的凭证，但原币金额全部为 0，没有可测算的外币余额。若序时账本身未填原币金额，请核对数据后重算。"
                    )
                }));
            }
            continue;
        };
        let key =
            balance_match_key_for_account(entity, &account, &auxiliary, false, account_policy);
        let closing_local =
            signed_amount(&row, tb_mapping, "closingFunctional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "TB期末本位币余额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
        let opening_local = if has_opening_local {
            signed_amount(&row, tb_mapping, "openingFunctional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "TB期初本位币余额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?
        } else {
            closing_local - je_functional_movements.get(&key).copied().unwrap_or(0.0)
        };
        let Some((opening_rate, opening_published)) = rate(snapshot, start, &currency, &functional)
        else {
            quality.push(json!({
                "source":"TB", "row":row.source_row, "type":"期初汇率缺失",
                "currency":currency, "severity":"隔离"
            }));
            continue;
        };
        if opening_rate.abs() < f64::EPSILON {
            continue;
        }
        let has_closing_foreign = amount_scheme_ok(tb_mapping, "closingForeign");
        let (inferred_opening_foreign, opening_foreign_source) = if has_closing_foreign {
            let closing_foreign =
                signed_amount(&row, tb_mapping, "closingForeign").map_err(|detail| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "TB期末原币余额无法解析。",
                        Some(format!("第{}行：{detail}", row.source_row)),
                    )
                })?;
            (
                closing_foreign - je_foreign_movements.get(&key).copied().unwrap_or(0.0),
                "TB期末原币余额－本期JE原币净变动倒推",
            )
        } else {
            (
                opening_local / opening_rate,
                "期初本位币余额÷期初官方汇率估算",
            )
        };
        let opening_audit_functional = inferred_opening_foreign * opening_rate;
        endpoints.push(json!({
            "entity":entity, "account":account, "auxiliary":auxiliary,
            "currency":currency, "functionalCurrency":functional,
            "openingForeign":inferred_opening_foreign,
            "openingBookFunctional":opening_local,
            "openingRate":opening_rate, "openingPublishedDate":opening_published,
            "openingAuditFunctional":opening_audit_functional,
            "closingBookFunctional":closing_local,
            "openingForeignSource":opening_foreign_source,
            "sourceRow":row.source_row
        }));
    }
    let monthly = calculate_monthly_unrealized(
        params,
        snapshot,
        start,
        end,
        &endpoints,
        &mut quality,
        realized,
        classification,
    )?;
    Ok((monthly, quality))
}

fn calculate_back_calculated_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    start: NaiveDate,
    end: NaiveDate,
    tb_table: &FxTable,
    tb_mapping: &Map<String, Value>,
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let (je_table, je_mapping) = load_mapped_je_table(params)?;
    let account_policy = account_match_policy(params)?;
    let derive_opening = !amount_scheme_ok(tb_mapping, "openingFunctional");
    let mut balances = HashMap::<String, f64>::new();
    let mut closing_balances = HashMap::<String, f64>::new();
    for row in tb_leaf_records(tb_table, tb_mapping) {
        let account = account_name(&row, tb_mapping);
        let currency = currency_for(&row, tb_mapping, &account, params);
        if currency.is_empty()
            || !matches!(
                role_for(&account, params).as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            )
        {
            continue;
        }
        let entity = entity_for(&row, tb_mapping, params);
        // 走统一匹配键：币种在两边来源不同（TB 从科目文本抽、JE 读凭证货币列），
        // 进键会让同一账户被判成两个。重估仍按币种做，币种在端点字段里。
        let key = balance_match_key_for_account(entity, &account, "", false, &account_policy);
        if derive_opening {
            let closing =
                signed_amount(&row, tb_mapping, "closingFunctional").map_err(|detail| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "TB期末本位币余额无法解析。",
                        Some(format!("第{}行：{detail}", row.source_row)),
                    )
                })?;
            closing_balances.insert(key, closing);
        } else {
            let opening =
                signed_amount(&row, tb_mapping, "openingFunctional").map_err(|detail| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "TB期初本位币余额无法解析。",
                        Some(format!("第{}行：{detail}", row.source_row)),
                    )
                })?;
            balances.insert(key, opening);
        }
    }

    let id_indexes = std::iter::once(first_col(&je_mapping, "date"))
        .flatten()
        .chain(mapped_cols(&je_mapping, "id"))
        .filter_map(|name| je_table.headers.iter().position(|header| header == &name))
        .collect::<Vec<_>>();
    let account_indexes = account_columns(&je_mapping)
        .iter()
        .filter_map(|name| je_table.headers.iter().position(|header| header == name))
        .collect::<Vec<_>>();
    let loss_keys =
        tabular::detect_loss_transfer_ids(&je_table.rows, &id_indexes, &account_indexes);
    let mut groups = BTreeMap::<(NaiveDate, String), Vec<RowRecord>>::new();
    for (row, raw) in records(&je_table).into_iter().zip(je_table.rows.iter()) {
        if !is_je_business_row(&row, &je_mapping) {
            continue;
        }
        let Some(date) = parse_date(cell(&row, &je_mapping, "date")) else {
            continue;
        };
        let id = voucher_id(&row, &je_mapping, params);
        if !loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)) {
            groups.entry((date, id)).or_default().push(row);
        }
    }
    if derive_opening {
        let mut movements = HashMap::<String, f64>::new();
        for rows in groups.values() {
            for row in rows {
                let account = account_name(row, &je_mapping);
                let role = role_for(&account, params);
                if !matches!(
                    role.as_str(),
                    "cash" | "monetary_asset" | "monetary_liability"
                ) {
                    continue;
                }
                let entity = entity_for(row, &je_mapping, params);
                let currency = currency_for(row, &je_mapping, &account, params);
                if currency.is_empty() || currency == functional_currency(entity, params) {
                    continue;
                }
                // 走统一匹配键：币种在两边来源不同（TB 从科目文本抽、JE 读凭证货币列），
                // 进键会让同一账户被判成两个。重估仍按币种做，币种在端点字段里。
                let key =
                    balance_match_key_for_account(entity, &account, "", false, &account_policy);
                *movements.entry(key).or_default() += signed_amount(row, &je_mapping, "functional")
                    .map_err(|detail| {
                        error(
                            "NUMERIC_PARSE_FAILED",
                            "JE本位币金额无法解析。",
                            Some(format!("第{}行：{detail}", row.source_row)),
                        )
                    })?;
            }
        }
        for (key, closing) in closing_balances {
            balances.insert(
                key.clone(),
                closing - movements.get(&key).copied().unwrap_or(0.0),
            );
        }
    }
    let mut output = Vec::new();
    let mut quality = vec![json!({
        "source": "TB+JE", "type": "原币余额倒算",
        "severity": "提示",
        "detail": "TB无原币余额；仅对科目名称/JE币种识别出的外币货币性项目，以月末官方汇率倒算原币，并用完整凭证识别客户重估。"
    })];
    for ((date, id), rows) in groups {
        if date < start || date > end {
            continue;
        }
        let summary = rows
            .iter()
            .map(|row| cell(row, &je_mapping, "summary"))
            .collect::<Vec<_>>()
            .join(" ");
        let display_id = display_voucher_id(&id);
        let manual = manual_classification(params, &display_id);
        let manual_realized = manual == Some("已实现汇兑损益");
        // 重估识别只看结构（外币货币性项目原币不动而本位币变动），
        // 凭证类型与摘要文字不参与认定。
        let revaluation_signal = !manual_realized;
        let mut movements = BTreeMap::<String, (String, String, String, String, f64, f64)>::new();
        for row in &rows {
            let account = account_name(row, &je_mapping);
            let role = role_for(&account, params);
            let standard_monetary = matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            );
            if !standard_monetary {
                continue;
            }
            let entity = entity_for(row, &je_mapping, params).to_owned();
            let currency = currency_for(row, &je_mapping, &account, params);
            if currency.is_empty() || currency == functional_currency(&entity, params) {
                continue;
            }
            let foreign = signed_amount(row, &je_mapping, "foreign").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE原币金额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
            let functional = signed_amount(row, &je_mapping, "functional").map_err(|detail| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE本位币金额无法解析。",
                    Some(format!("第{}行：{detail}", row.source_row)),
                )
            })?;
            // 走统一匹配键：币种在两边来源不同（TB 从科目文本抽、JE 读凭证货币列），
            // 进键会让同一账户被判成两个。重估仍按币种做，币种在端点字段里。
            let key = balance_match_key_for_account(&entity, &account, "", false, &account_policy);
            let item = movements
                .entry(key)
                .or_insert((entity, account, role, currency, 0.0, 0.0));
            item.4 += foreign;
            item.5 += functional;
        }
        for (key, (entity, account, role, currency, foreign_movement, functional_movement)) in
            movements
        {
            let before = balances.get(&key).copied().unwrap_or(0.0);
            let after = before + functional_movement;
            let is_revaluation = revaluation_signal
                && foreign_movement.abs() < 0.01
                && functional_movement.abs() >= 0.01;
            if is_revaluation {
                if let Some((official_rate, published_date)) = rate(
                    snapshot,
                    date,
                    &currency,
                    &functional_currency(&entity, params),
                ) {
                    let inferred_foreign = after / official_rate;
                    let audit_closing = inferred_foreign * official_rate;
                    let pnl = -(audit_closing - before);
                    output.push(json!({
                        "monthEnd": date, "voucherId": display_id.clone(),
                        "entity": entity, "account": account, "role": role,
                        "currency": currency, "functionalCurrency": functional_currency(&entity, params),
                        "preRevaluationFunctional": before,
                        "clientRevaluationExcluded": functional_movement,
                        "postRevaluationFunctional": after,
                        "officialRate": official_rate, "publishedDate": published_date,
                        "inferredForeign": inferred_foreign,
                        "auditClosingFunctional": audit_closing,
                        "unrealizedGainLoss": pnl, "suggestedAdjustment": pnl,
                        "method": "客户月末重估凭证复核（TB无原币余额，暂按账面重估金额）",
                        "rateSource": "央行中间价（仅用于倒算原币展示）",
                        "evidence": summary
                    }));
                } else {
                    quality.push(json!({"source":"JE", "type":"汇率缺失", "voucherId":display_voucher_id(&id), "currency":currency, "severity":"隔离"}));
                }
            }
            balances.insert(key, after);
        }
    }
    Ok((output, quality))
}

fn calculate_monthly_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    start: NaiveDate,
    end: NaiveDate,
    endpoints: &[Value],
    quality: &mut Vec<Value>,
    realized: &[Value],
    classification: &[Value],
) -> Result<Vec<Value>, AppError> {
    let (table, mapping) = load_mapped_je_table(params)?;
    let account_policy = account_match_policy(params)?;
    let rows = records(&table);
    let mut state: BTreeMap<String, (String, String, String, String, f64, f64)> = BTreeMap::new();
    let mut closing_book = HashMap::new();
    for endpoint in endpoints {
        let entity = endpoint.get("entity").and_then(Value::as_str).unwrap_or("");
        let account = endpoint
            .get("account")
            .and_then(Value::as_str)
            .unwrap_or("");
        let currency = endpoint
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("");
        let auxiliary = endpoint
            .get("auxiliary")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = balance_match_key_for_account(entity, account, auxiliary, false, &account_policy);
        state.insert(
            key.clone(),
            (
                entity.into(),
                account.into(),
                auxiliary.into(),
                currency.into(),
                endpoint
                    .get("openingForeign")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                endpoint
                    .get("openingAuditFunctional")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            ),
        );
        closing_book.insert(
            key,
            endpoint
                .get("closingBookFunctional")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
    }

    // 客户重估凭证只是比较证据，不是审计测算对象。先按完整凭证识别，
    // 后续将其全部行从正常业务发生额中剔除；货币性项目行的本位币变化
    // 仅作为客户已入账重估金额保留。
    // 组合模式的上一阶段已经按完整凭证完成了结构分类。直接复用其中的
    // 「未实现」凭证集合，避免紧接着再对整张 JE 重复解析科目、币种和金额。
    // 单独运行未实现模式时没有这份分类结果，仍走原有的独立结构判定。
    let classified_revaluation_ids = (!classification.is_empty()).then(|| {
        let mut ids = classification
            .iter()
            .filter(|item| item.get("classification").and_then(Value::as_str) == Some("未实现"))
            .filter_map(|item| item.get("voucherId").and_then(Value::as_str))
            .map(str::to_owned)
            .collect::<HashSet<_>>();
        if let Some(manual) = params
            .get("manualClassifications")
            .and_then(Value::as_object)
        {
            ids.extend(manual.iter().filter_map(|(id, value)| {
                (value.as_str() == Some("未实现汇兑损益")).then(|| id.clone())
            }));
        }
        ids
    });
    let mut voucher_rows = BTreeMap::<String, Vec<&RowRecord>>::new();
    // 后面的月度滚动原先对每个月都重新扫描整张 JE：23 万行、12 个月就是
    // 约 280 万次日期/科目/币种解析。首次分组凭证时顺手按年月分桶，后面每月
    // 只访问当月行；桶里仅保存引用，不复制单元格。
    let mut rows_by_month = BTreeMap::<(i32, u32), Vec<&RowRecord>>::new();
    for row in &rows {
        let Some(date) = parse_date(cell(row, &mapping, "date")) else {
            continue;
        };
        if date < start || date > end {
            continue;
        }
        let id = display_voucher_id(&voucher_id(row, &mapping, params));
        if classified_revaluation_ids
            .as_ref()
            .is_none_or(|ids| ids.contains(&id))
        {
            voucher_rows.entry(id).or_default().push(row);
        }
        rows_by_month
            .entry((date.year(), date.month()))
            .or_default()
            .push(row);
    }
    let mut revaluation_meta = HashMap::<String, Value>::new();
    for (id, voucher) in &voucher_rows {
        let manual = manual_classification(params, id);
        let automatic_signal = if let Some(ids) = &classified_revaluation_ids {
            ids.contains(id)
        } else {
            voucher_fx_structure(voucher.iter().copied(), &mapping, params)?.unrealized
        };
        let is_revaluation = match manual {
            Some("未实现汇兑损益") => true,
            Some("已实现汇兑损益") => false,
            _ => automatic_signal,
        };
        if !is_revaluation {
            continue;
        }
        let summary = voucher
            .iter()
            .map(|row| cell(row, &mapping, "summary"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        let voucher_type = voucher
            .iter()
            .map(|row| cell(row, &mapping, "voucherType").trim().to_uppercase())
            .find(|value| !value.is_empty())
            .unwrap_or_default();
        let mut booked_fx = 0.0;
        for row in voucher {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            let functional = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
            if role == "fx_gain_loss" {
                booked_fx += functional;
            }
        }
        // 与界面分类、已实现引擎同口径：单凭证内没有满足资金已实现结构，
        // 且外币货币性分组原币净额为零、本位币净额非零，才认作重估。
        let date = voucher
            .iter()
            .find_map(|row| parse_date(cell(row, &mapping, "date")));
        revaluation_meta.insert(
            id.clone(),
            json!({
                "voucherId": id, "date": date, "voucherType": voucher_type,
                "summary": summary, "bookedFxGainLoss": booked_fx,
                "identificationBasis": if manual == Some("未实现汇兑损益") {
                    "用户按借贷科目组合确认为未实现汇兑损益类凭证"
                } else {"系统按完整凭证识别为未实现汇兑损益或其冲回凭证"}
            }),
        );
    }

    // 已实现重算过的腿（按源文件行号索引）：滚动里的本位币发生额必须改用
    // 审计口径（原币×月初牌价），否则已实现损益先在重算里计一次、又混进
    // 月末重估残差里计第二次（2024 用友真实样例实测：50 万美元结汇的
    // 17,350 重复计、36,650 价差被错穿「未实现」外衣）。客户账面与审计
    // 口径的差额单独披露为「已实现腿入账基础差异」。
    let mut realized_legs = HashMap::<u64, f64>::new();
    for item in realized {
        if let (Some(row), Some(signed), Some(carrying)) = (
            item.get("sourceRow").and_then(Value::as_u64),
            item.get("targetForeignSigned").and_then(Value::as_f64),
            item.get("carryingFunctional").and_then(Value::as_f64),
        ) {
            let audit_functional = if signed < 0.0 { -carrying } else { carrying };
            realized_legs.insert(row, audit_functional);
        }
    }

    let mut output = Vec::new();
    let mut missing_balance_keys = BTreeSet::new();
    for month_end in date_points(start, end)
        .into_iter()
        .filter(|date| *date == end || (*date + Duration::days(1)).day() == 1)
    {
        let mut movement: HashMap<String, (f64, f64, f64, f64)> = HashMap::new();
        let mut revaluation_vouchers: HashMap<String, BTreeSet<String>> = HashMap::new();
        let month_rows = rows_by_month
            .get(&(month_end.year(), month_end.month()))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for row in month_rows {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            let display_id = display_voucher_id(&voucher_id(row, &mapping, params));
            let standard_monetary = matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            );
            if !standard_monetary {
                continue;
            }
            let entity = entity_for(row, &mapping, params);
            let currency = currency_for(row, &mapping, &account, params);
            let auxiliary = auxiliary_value(row, &mapping);
            if currency.is_empty() || currency == functional_currency(entity, params) {
                continue;
            }
            let key =
                balance_match_key_for_account(entity, &account, &auxiliary, false, &account_policy);
            if !state.contains_key(&key) {
                if missing_balance_keys.insert(key.clone()) {
                    quality.push(json!({
                        "source":"JE+TB", "type":"未实现测算缺少TB余额基础",
                        "severity":"隔离", "entity":entity, "account":account,
                        "auxiliary":auxiliary, "currency":normalize_currency(&currency),
                        "detail":"该「科目＋币种」在序时账里有发生额，但 TB 里找不到一一对应的余额行；为保证数字可靠，未将其计入未实现测算。"
                    }));
                }
                continue;
            }
            let foreign = signed_amount(row, &mapping, "foreign").map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE关键金额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })?;
            let functional = signed_amount(row, &mapping, "functional").map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE关键金额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })?;
            let item = movement.entry(key.clone()).or_insert((0.0, 0.0, 0.0, 0.0));
            if revaluation_meta.contains_key(&display_id) {
                item.2 += functional;
                revaluation_vouchers
                    .entry(key.clone())
                    .or_default()
                    .insert(display_id);
            } else if let Some(audit_functional) = realized_legs.get(&(row.source_row as u64)) {
                item.0 += foreign;
                item.1 += *audit_functional;
                item.3 += functional - *audit_functional;
            } else {
                item.0 += foreign;
                item.1 += functional;
            }
        }
        for (key, (entity, account, auxiliary, currency, foreign_balance, prior_audit)) in
            state.clone()
        {
            let (
                foreign_change,
                non_revaluation_change,
                client_revaluation,
                realized_basis_difference,
            ) = movement.get(&key).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));
            let closing_foreign = foreign_balance + foreign_change;
            let functional = functional_currency(&entity, params);
            let Some((official_rate, published_date)) =
                rate(snapshot, month_end, &currency, &functional)
            else {
                quality.push(json!({
                    "source": "JE", "type": "月末汇率缺失", "currency": currency,
                    "monthEnd": month_end, "severity": "隔离"
                }));
                continue;
            };
            let pre_revaluation = prior_audit + non_revaluation_change;
            let audit_closing = closing_foreign * official_rate;
            let audit_balance_adjustment = audit_closing - pre_revaluation;
            let audit_unrealized_pnl = -audit_balance_adjustment;
            let client_booked_unrealized_pnl = -client_revaluation;
            let measurement_difference = audit_unrealized_pnl - client_booked_unrealized_pnl;
            let tb_closing = if month_end == end {
                closing_book.get(&key).copied()
            } else {
                None
            };
            let voucher_ids = revaluation_vouchers
                .get(&key)
                .map(|ids| ids.iter().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let voucher_details = voucher_ids
                .iter()
                .filter_map(|id| revaluation_meta.get(id).cloned())
                .collect::<Vec<_>>();
            output.push(json!({
                "monthEnd": month_end, "entity": entity, "account": account,
                "auxiliary": auxiliary, "currency": currency, "functionalCurrency": functional,
                "openingForeign": foreign_balance, "openingAuditFunctional": prior_audit,
                "businessForeignMovement": foreign_change, "closingForeign": closing_foreign,
                "businessFunctionalMovement": non_revaluation_change,
                "realizedLegBasisDifference": realized_basis_difference,
                "preRevaluationFunctional": pre_revaluation,
                "officialRate": official_rate, "publishedDate": published_date,
                "auditClosingFunctional": audit_closing,
                "auditBalanceAdjustment": audit_balance_adjustment,
                "unrealizedGainLoss": audit_unrealized_pnl,
                "clientRevaluationBalanceAdjustment": client_revaluation,
                "clientBookedUnrealizedGainLoss": client_booked_unrealized_pnl,
                "suggestedAdjustment": measurement_difference,
                "tbClosingFunctional": tb_closing,
                "tbReconciliationDifference": tb_closing.map(|value| audit_closing - value),
                "method": "外币货币性项目月度余额滚动及月末官方汇率重估",
                "clientRevaluationVoucherIds": voucher_ids,
                "clientRevaluationDetails": voucher_details
            }));
            state.insert(
                key,
                (
                    entity,
                    account,
                    auxiliary,
                    currency,
                    closing_foreign,
                    audit_closing,
                ),
            );
        }
    }
    Ok(output)
}

fn export_workbook(params: &Value, result: &Value) -> Result<String, AppError> {
    let output = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let source = params
                .get("tbSource")
                .or_else(|| params.get("jeSource"))
                .and_then(|v| v.get("inputPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            source.parent().unwrap_or(Path::new(".")).join(format!(
                "汇兑损益测算_{}.xlsx",
                Utc::now().format("%Y%m%d_%H%M%S")
            ))
        });
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            error(
                "OUTPUT_WRITE_FAILED",
                "无法创建输出目录。",
                Some(e.to_string()),
            )
        })?;
    }
    let partial = output.with_extension("partial.xlsx");
    let mut workbook = Workbook::new();
    let mode = result.get("mode").and_then(Value::as_str).unwrap_or("");
    write_user_conclusion_sheet(&mut workbook, params, result)?;
    write_user_calculation_sheet(&mut workbook, result)?;
    write_kv_sheet(
        &mut workbook,
        "使用说明",
        &[
            (
                "底稿用途",
                "汇兑损益审计重算；结果需结合业务资料与审计判断复核。",
            ),
            ("测算模式", mode),
            ("汇率口径", RATE_SOURCE),
            (
                "重要说明",
                "已实现仅按单张凭证内的资金结构识别：货币资金净额非零，且对方货币性项目净额非零；未实现按外币原币净额为零、本位币净额非零识别。汇兑损益科目、凭证类型和摘要不参与定性。",
            ),
        ],
    )?;
    write_json_object_sheet(
        &mut workbook,
        "执行摘要",
        result.get("summary").unwrap_or(&Value::Null),
    )?;
    write_kv_sheet(
        &mut workbook,
        "参数与口径",
        &[
            (
                "报告期开始",
                params
                    .get("reportStart")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "报告期结束",
                params
                    .get("reportEnd")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            ("测算模式", mode),
        ],
    )?;
    write_mapping_sheet(&mut workbook, "JE字段映射", params.get("jeMapping"))?;
    write_mapping_sheet(&mut workbook, "TB字段映射", params.get("tbMapping"))?;
    write_value_array_sheet(&mut workbook, "数据质量", result.get("dataQuality"))?;
    write_value_array_sheet(&mut workbook, "待复核项目", result.get("pendingReview"))?;
    write_mapping_sheet(&mut workbook, "科目角色", params.get("accountRoles"))?;
    write_value_array_sheet(
        &mut workbook,
        "央行汇率",
        result.pointer("/rateSnapshot/rates"),
    )?;
    // 「汇率表」是全簿官方牌价的单一来源：行=日期、列=币种，数值就是
    // 引擎测算实际采用的逐日牌价（非公布日沿用最近公布日，与测算同口径）。
    // 各表的汇率单元格用 INDEX/MATCH 链接过来，改一处汇率全簿联动重算。
    let rate_index = write_rate_matrix_sheet(&mut workbook, result)?;
    write_value_array_sheet(&mut workbook, "异常与限制", result.get("dataQuality"))?;
    write_json_object_sheet(
        &mut workbook,
        "_rate_snapshot",
        result.get("rateSnapshot").unwrap_or(&Value::Null),
    )?;
    write_kv_sheet(
        &mut workbook,
        "_source_trace",
        &[
            (
                "JE来源",
                params
                    .pointer("/jeSource/inputPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "TB来源",
                params
                    .pointer("/tbSource/inputPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "汇率响应哈希",
                result
                    .pointer("/rateSnapshot/responseHash")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
        ],
    )?;
    if matches!(mode, "realized" | "combined") {
        write_value_array_sheet(&mut workbook, "JE完整明细", result.get("jeDetail"))?;
        write_value_array_sheet(&mut workbook, "事件分类", result.get("classification"))?;
        write_value_array_sheet(&mut workbook, "已实现测算", result.get("realized"))?;
        let summary_row = Value::Array(vec![result.get("summary").cloned().unwrap_or(Value::Null)]);
        write_value_array_sheet(&mut workbook, "已实现汇总", Some(&summary_row))?;
    }
    if matches!(mode, "unrealized" | "combined") {
        if params.get("jeSource").is_some() {
            write_value_array_sheet(
                &mut workbook,
                "未实现凭证识别",
                result.get("clientRevaluationVouchers"),
            )?;
            write_unrealized_rollforward_sheet(
                &mut workbook,
                result.get("unrealizedBalanceRollforward"),
                &rate_index,
            )?;
            write_value_array_sheet(
                &mut workbook,
                "客户未实现损益比较",
                result.get("unrealizedComparison"),
            )?;
            write_value_array_sheet(&mut workbook, "月度测算", result.get("unrealized"))?;
            let summary_row =
                Value::Array(vec![result.get("summary").cloned().unwrap_or(Value::Null)]);
            write_value_array_sheet(&mut workbook, "全年汇总", Some(&summary_row))?;
            let reconciliation_row = Value::Array(vec![
                result.get("reconciliation").cloned().unwrap_or(Value::Null),
            ]);
            write_value_array_sheet(&mut workbook, "TB勾稽", Some(&reconciliation_row))?;
        } else {
            // 无 JE 时也输出可追踪的两时点公式底稿，不能退回纯数值 JSON 表。
            write_two_point_unrealized_sheet(&mut workbook, result.get("unrealized"), &rate_index)?;
            write_value_array_sheet(&mut workbook, "TB余额明细", result.get("unrealized"))?;
            write_filtered_sheet(
                &mut workbook,
                "年初重估",
                result.get("unrealized"),
                "opening",
            )?;
            write_filtered_sheet(
                &mut workbook,
                "年末重估",
                result.get("unrealized"),
                "closing",
            )?;
            write_value_array_sheet(&mut workbook, "两时点分析", result.get("unrealized"))?;
        }
    }
    // 面向用户的复核页放在测算页之后；技术证据页仍保留但统一隐藏。
    write_classification_adjustment_sheet(&mut workbook, result)?;
    write_not_fx_event_sheet(&mut workbook, result)?;
    for name in [
        "使用说明",
        "执行摘要",
        "参数与口径",
        "JE字段映射",
        "TB字段映射",
        "数据质量",
        "待复核项目",
        "科目角色",
        "央行汇率",
        "汇率表",
        "异常与限制",
        "_rate_snapshot",
        "_source_trace",
        "JE完整明细",
        "事件分类",
        "已实现测算",
        "已实现汇总",
        "未实现凭证识别",
        "客户未实现损益比较",
        "月度测算",
        "全年汇总",
        "TB勾稽",
        "TB余额明细",
        "年初重估",
        "年末重估",
        "两时点分析",
    ] {
        if let Ok(sheet) = workbook.worksheet_from_name(name) {
            sheet.set_hidden(true);
        }
    }
    workbook
        .worksheet_from_name("审计结论")
        .map_err(xlsx_err)?
        .set_active(true);
    workbook.save(&partial).map_err(xlsx_err)?;
    fs::rename(&partial, &output).map_err(|e| {
        error(
            "OUTPUT_WRITE_FAILED",
            "无法保存审计底稿，文件可能正在被占用。",
            Some(e.to_string()),
        )
    })?;
    Ok(output.to_string_lossy().into_owned())
}

fn write_user_conclusion_sheet(
    workbook: &mut Workbook,
    params: &Value,
    result: &Value,
) -> Result<(), AppError> {
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.00%");
    let pass = Format::new()
        .set_bold()
        .set_font_color("#1B5E20")
        .set_background_color("#E8F5E9");
    let fail = Format::new()
        .set_bold()
        .set_font_color("#B71C1C")
        .set_background_color("#FDECEA");
    let sheet = workbook.add_worksheet();
    setup(sheet, "审计结论")?;
    sheet
        .write_string_with_format(0, 0, "项目", &header)
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(0, 1, "结果", &header)
        .map_err(xlsx_err)?;
    let summary = result.get("summary").unwrap_or(&Value::Null);
    let period = format!(
        "{} 至 {}",
        params
            .get("reportStart")
            .and_then(Value::as_str)
            .unwrap_or(""),
        params
            .get("reportEnd")
            .and_then(Value::as_str)
            .unwrap_or("")
    );
    let range = localized_scalar(result.get("mode").and_then(Value::as_str).unwrap_or(""));
    for (row, (label, value)) in [
        ("公司/核算主体", fixed_entity(params)),
        ("报告期间", period.as_str()),
        ("测算范围", range),
    ]
    .iter()
    .enumerate()
    {
        sheet
            .write_string((row + 1) as u32, 0, *label)
            .map_err(xlsx_err)?;
        sheet
            .write_string((row + 1) as u32, 1, *value)
            .map_err(xlsx_err)?;
    }

    let mode = result.get("mode").and_then(Value::as_str).unwrap_or("");
    let has_unrealized_sheet = matches!(mode, "unrealized" | "combined");
    let gain_loss_column = if summary
        .get("accountTranslationEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "Q"
    } else {
        "P"
    };
    let number = |key: &str| summary.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let split_tb = summary
        .get("tbFxGainLossPresentation")
        .and_then(Value::as_str)
        == Some("split");
    let mut next_row = 4u32;
    let mut write_amount =
        |label: &str, cached: f64, formula: Option<String>| -> Result<u32, AppError> {
            let row = next_row;
            sheet.write_string(row, 0, label).map_err(xlsx_err)?;
            if let Some(formula) = formula {
                sheet
                    .write_formula_with_format(
                        row,
                        1,
                        Formula::new(formula).set_result(cached.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            } else {
                sheet
                    .write_number_with_format(row, 1, cached, &amount)
                    .map_err(xlsx_err)?;
            }
            next_row += 1;
            Ok(row + 1)
        };

    let realized_excel_row = write_amount(
        "已实现汇兑损益测算",
        number("realizedGainLoss"),
        Some(format!(
            "SUMIF('汇兑损益测算明细'!$C:$C,\"已实现\",'汇兑损益测算明细'!${0}:${0})",
            gain_loss_column
        )),
    )?;
    let unrealized_formula = has_unrealized_sheet.then(|| {
        if params.get("jeSource").is_some() {
            "SUM('未实现汇兑损益测算'!$L:$L)".to_owned()
        } else {
            "SUM('未实现汇兑损益测算'!$Q:$Q)".to_owned()
        }
    });
    let unrealized_excel_row = write_amount(
        "未实现汇兑损益测算",
        number("unrealizedAdjustment"),
        unrealized_formula,
    )?;
    let audit_total_excel_row = write_amount(
        "审计测算合计",
        number("auditFxGainLoss"),
        Some(format!(
            "SUM(B{realized_excel_row}:B{unrealized_excel_row})"
        )),
    )?;

    let tb_total_excel_row = if split_tb {
        let tb_realized_excel_row =
            write_amount("TB已实现汇兑损益", number("tbRealizedGainLoss"), None)?;
        let tb_unrealized_excel_row =
            write_amount("TB未实现汇兑损益", number("tbUnrealizedGainLoss"), None)?;
        write_amount(
            "TB汇兑损益合计",
            number("tbFxGainLoss"),
            Some(format!(
                "SUM(B{tb_realized_excel_row}:B{tb_unrealized_excel_row})"
            )),
        )?
    } else {
        write_amount(
            "TB汇兑损益（损益科目未区分已实现/未实现）",
            number("tbFxGainLoss"),
            None,
        )?
    };
    let difference_excel_row = write_amount(
        "测算与TB差异",
        number("difference"),
        Some(format!("B{audit_total_excel_row}-B{tb_total_excel_row}")),
    )?;
    let pending_amount_excel_row = write_amount(
        "待复核项目（账面金额）",
        number("pendingReviewAmount"),
        Some(format!(
            "SUMIF('汇兑损益测算明细'!$C:$C,\"待复核\",'汇兑损益测算明细'!${0}:${0})",
            gain_loss_column
        )),
    )?;
    drop(write_amount);

    let ratio = summary
        .get("differenceRatio")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    sheet
        .write_string(next_row, 0, "差异率")
        .map_err(xlsx_err)?;
    sheet
        .write_formula_with_format(
            next_row,
            1,
            Formula::new(format!(
                "IFERROR(ABS(B{difference_excel_row}/B{tb_total_excel_row}),0)"
            ))
            .set_result(ratio.to_string()),
            &percent,
        )
        .map_err(xlsx_err)?;
    let ratio_excel_row = next_row + 1;
    next_row += 1;

    let passed = summary.get("reconciliationPassed").and_then(Value::as_bool);
    let conclusion = match passed {
        Some(true) => "通过",
        Some(false) => "不通过",
        None => "无法判断",
    };
    sheet
        .write_string(next_row, 0, "审计结论")
        .map_err(xlsx_err)?;
    sheet
        .write_formula_with_format(
            next_row,
            1,
            Formula::new(format!(
                "IF(ABS(B{tb_total_excel_row})<0.01,\"无法判断\",IF(B{ratio_excel_row}<0.05,\"通过\",\"不通过\"))"
            ))
            .set_result(conclusion),
            if passed == Some(true) { &pass } else { &fail },
        )
        .map_err(xlsx_err)?;
    next_row += 1;

    let pending_count = summary
        .get("pendingReviewCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rollforward_passed = summary
        .get("rollforwardPassed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let not_fx_count = summary
        .get("notFxEventCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let not_fx_amount = summary
        .get("notFxEventAmount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let not_fx_note = if not_fx_count > 0 {
        format!(
            "其中不构成汇兑事项 {not_fx_count} 张、账面汇差 {not_fx_amount:.2}（结构上不含外币货币性项目，详见「不构成汇兑事项」页，属科目使用问题，建议重分类复核）；"
        )
    } else {
        String::new()
    };
    let limitation = if pending_count > 0 {
        format!(
            "尚有{pending_count}张凭证待复核，{not_fx_note}账面金额见B{pending_amount_excel_row}；详见“分类复核”。"
        )
    } else if !rollforward_passed {
        "TB＋JE余额滚动未完全勾稽，未实现测算属于受限结果。".to_owned()
    } else {
        "未发现需要单独披露的受限事项。".to_owned()
    };
    sheet
        .write_string(next_row, 0, "限制与提示")
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(next_row, 1, limitation, &Format::new().set_text_wrap())
        .map_err(xlsx_err)?;
    sheet.set_row_height(next_row, 36).map_err(xlsx_err)?;
    sheet.set_column_width(0, 42).map_err(xlsx_err)?;
    sheet.set_column_width(1, 62).map_err(xlsx_err)?;
    Ok(())
}

/// 「不构成汇兑事项」明细页：账面挂在汇兑损益科目、但结构上不含外币
/// 货币性项目（资金池本位币账户互转）或对手为非货币性项目（预付款等）
/// 的凭证。这些金额已从测算总体剔除，单独成页供 TB 勾稽时作「其中」
/// 披露与重分类建议。
fn write_not_fx_event_sheet(workbook: &mut Workbook, result: &Value) -> Result<(), AppError> {
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let wrap = Format::new().set_text_wrap();
    let items: Vec<&Value> = result
        .get("classificationControls")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .filter(|item| {
                    item.get("classification").and_then(Value::as_str) == Some("不构成汇兑事项")
                })
                .collect()
        })
        .unwrap_or_default();
    let sheet = workbook.add_worksheet();
    setup(sheet, "不构成汇兑事项")?;
    let headers = [
        "日期",
        "凭证号",
        "凭证类型",
        "借贷科目组合",
        "账面汇兑损益",
        "系统归类",
        "剔除理由",
        "凭证摘要",
    ];
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header)
            .map_err(xlsx_err)?;
    }
    let mut total = 0.0_f64;
    for (index, item) in items.iter().enumerate() {
        let row = (index + 1) as u32;
        sheet
            .write_string(
                row,
                0,
                item.get("date").and_then(Value::as_str).unwrap_or(""),
            )
            .map_err(xlsx_err)?;
        sheet
            .write_string(
                row,
                1,
                item.get("voucherId").and_then(Value::as_str).unwrap_or(""),
            )
            .map_err(xlsx_err)?;
        sheet
            .write_string(
                row,
                2,
                item.get("voucherType")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(
                row,
                3,
                item.get("patternLabel")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                &wrap,
            )
            .map_err(xlsx_err)?;
        let booked = item
            .get("bookedFxGainLoss")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        total += booked;
        sheet
            .write_number_with_format(row, 4, booked, &amount)
            .map_err(xlsx_err)?;
        sheet
            .write_string(
                row,
                5,
                item.get("systemCategory")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(
                row,
                6,
                item.get("reviewReason")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                &wrap,
            )
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(
                row,
                7,
                item.get("summary").and_then(Value::as_str).unwrap_or(""),
                &wrap,
            )
            .map_err(xlsx_err)?;
    }
    let total_row = (items.len() + 1) as u32;
    sheet
        .write_string_with_format(total_row, 0, &format!("合计 {} 张", items.len()), &header)
        .map_err(xlsx_err)?;
    sheet
        .write_number_with_format(total_row, 4, total, &amount)
        .map_err(xlsx_err)?;
    sheet.set_column_width(1, 30).map_err(xlsx_err)?;
    sheet.set_column_width(3, 44).map_err(xlsx_err)?;
    sheet.set_column_width(6, 44).map_err(xlsx_err)?;
    sheet.set_column_width(7, 40).map_err(xlsx_err)?;
    sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn write_classification_adjustment_sheet(
    workbook: &mut Workbook,
    result: &Value,
) -> Result<(), AppError> {
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let input = Format::new()
        .set_font_color("#0000FF")
        .set_background_color("#FFF2CC");
    let wrap = Format::new().set_text_wrap();
    let sheet = workbook.add_worksheet();
    setup(sheet, "分类复核")?;
    let headers = [
        "凭证类型（借贷科目组合）",
        "凭证数量",
        "示例凭证号",
        "系统分类",
        "借方科目（代码/英文名/中文名）",
        "贷方科目（代码/英文名/中文名）",
        "凭证摘要",
        "用户确认分类",
        "待复核原因",
        "账面汇兑损益（仅供参考）",
        "使用说明",
        "_凭证ID清单",
        "_类型键",
    ];
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header)
            .map_err(xlsx_err)?;
    }
    let controls = result
        .get("classificationControls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("classification").and_then(Value::as_str) == Some("不构成汇兑事项")
                        || item
                            .get("classificationConflict")
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.trim().is_empty())
                        || item
                            .get("measurementStatus")
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                value.starts_with("无法测算")
                                    || value == "不构成汇兑事项，账面汇差已剔除"
                            })
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut account_names = HashMap::<String, BTreeSet<String>>::new();
    for detail in result
        .get("voucherDetail")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let code = detail
            .get("accountCode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_uppercase();
        if code.is_empty() {
            continue;
        }
        let names = account_names.entry(code).or_default();
        for key in ["accountNameOriginal", "accountNameChinese"] {
            if let Some(name) = detail.get(key).and_then(Value::as_str) {
                if !name.trim().is_empty() {
                    names.insert(name.trim().to_owned());
                }
            }
        }
    }
    let render_accounts = |codes: &[String]| {
        codes
            .iter()
            .map(|code| {
                let names = account_names
                    .get(&code.trim().to_uppercase())
                    .map(|items| items.iter().cloned().collect::<Vec<_>>().join(" / "))
                    .unwrap_or_default();
                if names.is_empty() {
                    code.clone()
                } else {
                    format!("{code} / {names}")
                }
            })
            .collect::<Vec<_>>()
            .join("；")
    };
    let mut groups = BTreeMap::<String, Vec<&Value>>::new();
    for item in &controls {
        let key = item
            .get("patternKey")
            .and_then(Value::as_str)
            .unwrap_or_else(|| item.get("voucherId").and_then(Value::as_str).unwrap_or(""));
        groups.entry(key.to_owned()).or_default().push(item);
    }
    let validation = DataValidation::new()
        .allow_list_strings(&["已实现汇兑损益", "未实现汇兑损益"])
        .map_err(xlsx_err)?;
    for (index, (pattern_key, items)) in groups.iter().enumerate() {
        let row = (index + 1) as u32;
        let classifications = items
            .iter()
            .filter_map(|item| item.get("classification").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        let classification = if classifications.len() == 1 {
            classifications
                .iter()
                .next()
                .copied()
                .unwrap_or("不构成汇兑事项")
        } else {
            "不构成汇兑事项"
        };
        let voucher_ids = items
            .iter()
            .filter_map(|item| item.get("voucherId").and_then(Value::as_str))
            .collect::<Vec<_>>();
        let summaries = items
            .iter()
            .filter_map(|item| item.get("summary").and_then(Value::as_str))
            .filter(|value| !value.trim().is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(5)
            .collect::<Vec<_>>()
            .join("；");
        let first = items[0];
        let debit = first
            .get("debitAccounts")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let credit = first
            .get("creditAccounts")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let review_reasons = items
            .iter()
            .flat_map(|item| {
                [
                    "classificationConflict",
                    "reviewReason",
                    "measurementStatus",
                ]
                .into_iter()
                .filter_map(|key| item.get(key).and_then(Value::as_str))
            })
            .filter(|value| !value.trim().is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join("；");
        let booked = items
            .iter()
            .filter_map(|item| item.get("bookedFxGainLoss").and_then(Value::as_f64))
            .sum::<f64>();
        for (column, value) in [
            (
                0,
                first
                    .get("patternLabel")
                    .and_then(Value::as_str)
                    .unwrap_or(pattern_key),
            ),
            (
                2,
                &voucher_ids
                    .iter()
                    .take(5)
                    .copied()
                    .collect::<Vec<_>>()
                    .join("、"),
            ),
            (3, classification),
            (4, &render_accounts(&debit)),
            (5, &render_accounts(&credit)),
            (6, &summaries),
            (8, &review_reasons),
            (
                10,
                "在本页修改后，回到工具点击“导入Excel分类并重算”；Excel不使用账面汇兑损益替代审计测算。",
            ),
            (11, &voucher_ids.join("\n")),
            (12, pattern_key),
        ] {
            sheet
                .write_string_with_format(row, column, value, &wrap)
                .map_err(xlsx_err)?;
        }
        sheet
            .write_number(row, 1, items.len() as f64)
            .map_err(xlsx_err)?;
        sheet
            .write_string_with_format(row, 7, classification, &input)
            .map_err(xlsx_err)?;
        sheet
            .add_data_validation(row, 7, row, 7, &validation)
            .map_err(xlsx_err)?;
        sheet
            .write_number_with_format(row, 9, booked, &amount)
            .map_err(xlsx_err)?;
    }
    if groups.is_empty() {
        sheet
            .write_string(1, 0, "本次无待复核或分类冲突项目。")
            .map_err(xlsx_err)?;
    }
    for (column, width) in [
        (0, 42),
        (1, 12),
        (2, 34),
        (3, 18),
        (4, 48),
        (5, 48),
        (6, 56),
        (7, 20),
        (8, 24),
        (9, 22),
        (10, 56),
    ] {
        sheet.set_column_width(column, width).map_err(xlsx_err)?;
    }
    // 使用说明和内部导回键只为程序追踪保留，默认不展示给用户。
    for column in [10, 11, 12] {
        sheet.set_column_hidden(column).map_err(xlsx_err)?;
    }
    Ok(())
}

fn write_user_calculation_sheet(workbook: &mut Workbook, result: &Value) -> Result<(), AppError> {
    let details = result
        .get("voucherDetail")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let account_names = details
        .iter()
        .filter_map(|row| {
            Some((
                row.get("accountCode")?.as_str()?.trim().to_uppercase(),
                row.get("accountNameOriginal")?.as_str()?.trim().to_owned(),
            ))
        })
        .filter(|(code, name)| !code.is_empty() && !name.is_empty())
        .collect::<HashMap<_, _>>();
    let account_parts = |value: &Value| {
        let accounts = value
            .as_array()
            .map(|items| items.iter().collect::<Vec<_>>())
            .unwrap_or_else(|| vec![value]);
        let mut codes = Vec::new();
        let mut names = Vec::new();
        for account in accounts {
            let text = localized_text("account", account);
            let mut parts = text.splitn(2, char::is_whitespace);
            let code = parts.next().unwrap_or("").trim().to_owned();
            let inline_name = parts.next().unwrap_or("").trim().to_owned();
            let name = if inline_name.is_empty() {
                account_names
                    .get(&code.to_uppercase())
                    .cloned()
                    .unwrap_or_default()
            } else {
                inline_name
            };
            if !code.is_empty() {
                codes.push(code);
            }
            if !name.is_empty() {
                names.push(name);
            }
        }
        (codes.join(" / "), names.join(" / "))
    };
    let mut measurements = Vec::new();
    for item in result
        .get("realized")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (account_code, account_name) =
            account_parts(item.get("account").unwrap_or(&Value::Null));
        measurements.push(json!({
            "date": item.get("date"), "voucherId": item.get("voucherId"), "calculationType": "已实现",
            "accountCode": account_code, "accountNameOriginal": account_name, "currency": item.get("currency"),
            "foreignAmount": item.get("settlementForeign"),
            "appliedRate": item
                .get("appliedRate")
                .or_else(|| item.get("settlementRate"))
                .or_else(|| item.get("officialRate")),
            "bookAmount": item.get("carryingFunctional"), "auditAmount": item.get("translatedFunctional"),
            "gainLoss": item.get("auditGainLoss"), "formulaDirection": if item.get("targetForeignSigned").and_then(Value::as_f64).unwrap_or(-1.0)>0.0 {"审计金额－账面金额"} else {"账面金额－审计金额"},
            "sourceRow": item.get("sourceRow"),
            "note": format!("{}；汇率来源：{}；央行交易日中间价：{:.6}",
                item.get("calculationMethod").and_then(Value::as_str).unwrap_or("结算事件测算"),
                item.get("rateSource").and_then(Value::as_str).unwrap_or(RATE_SOURCE),
                item.get("officialRate").and_then(Value::as_f64).unwrap_or(0.0))
        }));
    }
    // 未实现损益的测算对象是账户月末余额，不是某一张客户重估凭证。
    // 因此不再把账户级月度重估结果硬塞进“完整凭证+测算”表；相关过程
    // 单独输出到“未实现汇兑损益测算”模块。
    for item in result
        .get("pendingReview")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (account_code, account_name) =
            account_parts(item.get("fxAccounts").unwrap_or(&Value::Null));
        measurements.push(json!({
            "date": item.get("date"), "voucherId": item.get("voucherId"), "calculationType": "待复核",
            "pendingCategory":item.get("pendingCategory"), "accountCode": account_code,
            "accountNameOriginal": account_name, "currency": item.get("currencies"),
            "foreignAmount": 0.0, "appliedRate": 0.0,
            "bookAmount": item.get("bookedFxGainLoss"), "auditAmount": null,
            "gainLoss": item.get("bookedFxGainLoss"), "formulaDirection": "账面金额仅供参考，不纳入审计测算",
            "note": item.get("reviewReason"), "pending": true
        }));
    }
    let mut assigned = HashSet::new();
    let mut rows = Vec::new();
    for detail in details {
        let voucher = detail
            .get("voucherId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let source_row = detail.get("sourceRow").and_then(Value::as_u64);
        let account = detail
            .get("accountCode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let matched = measurements
            .iter()
            .enumerate()
            .find(|(index, item)| {
                !assigned.contains(index)
                    && item.get("voucherId").and_then(Value::as_str) == Some(voucher)
                    && source_row.is_some()
                    && item.get("sourceRow").and_then(Value::as_u64) == source_row
            })
            .or_else(|| {
                measurements.iter().enumerate().find(|(index, item)| {
                    !assigned.contains(index)
                        && item.get("voucherId").and_then(Value::as_str) == Some(voucher)
                        && item
                            .get("accountCode")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.split(" / ").any(|code| code == account))
                })
            })
            .or_else(|| {
                measurements.iter().enumerate().find(|(index, item)| {
                    !assigned.contains(index)
                        && item.get("voucherId").and_then(Value::as_str) == Some(voucher)
                })
            });
        let measurement = matched.map(|(index, item)| {
            assigned.insert(index);
            item.clone()
        });
        rows.push((detail, measurement));
    }
    for (index, measurement) in measurements.into_iter().enumerate() {
        if !assigned.contains(&index) {
            rows.push((Value::Object(Map::new()), Some(measurement)));
        }
    }
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let rate = Format::new().set_num_format("0.000000");
    let sheet = workbook.add_worksheet();
    setup(sheet, "汇兑损益测算明细")?;
    let translated = result
        .pointer("/summary/accountTranslationEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let raw_headers = rows
        .iter()
        .flat_map(|(detail, _)| {
            detail
                .as_object()
                .into_iter()
                .flat_map(|object| object.keys())
        })
        .filter(|key| key.starts_with("原始_"))
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut headers = [
        "日期",
        "凭证匹配ID",
        "测算类型",
        "待复核分路",
        "摘要",
        "科目代码",
        "原始科目名称",
    ]
    .iter()
    .map(|value| (*value).to_owned())
    .collect::<Vec<_>>();
    if translated {
        headers.push("中文科目名称（LLM翻译）".into());
    }
    headers.extend(
        [
            "币种",
            "JE原币金额",
            "JE本位币金额",
            "是否测算行",
            "测算原币金额",
            "测算采用汇率",
            "测算前账面金额",
            "审计测算金额",
            "测算/待复核金额",
            "计算逻辑",
            "测算方法与数据来源",
            "JE源文件行号",
        ]
        .iter()
        .map(|value| (*value).to_owned()),
    );
    headers.extend(
        raw_headers
            .iter()
            .map(|value| value.trim_start_matches("原始_").to_owned()),
    );
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, title, &header)
            .map_err(xlsx_err)?;
        sheet
            .set_column_width(
                column as u16,
                if matches!(
                    title.as_str(),
                    "摘要"
                        | "原始科目名称"
                        | "中文科目名称（LLM翻译）"
                        | "计算逻辑"
                        | "测算方法与数据来源"
                ) {
                    36
                } else {
                    18
                },
            )
            .map_err(xlsx_err)?;
    }
    for (index, (detail, measurement)) in rows.iter().enumerate() {
        let excel_row = index + 2;
        let output_row = (index + 1) as u32;
        let from_detail = |key: &str| detail.get(key).unwrap_or(&Value::Null);
        let source_or_measurement = |key: &str| {
            detail
                .get(key)
                .filter(|value| !value.is_null())
                .or_else(|| measurement.as_ref().and_then(|row| row.get(key)))
                .unwrap_or(&Value::Null)
        };
        let calculation_type = measurement
            .as_ref()
            .and_then(|row| row.get("calculationType"))
            .or_else(|| detail.get("classification"))
            .unwrap_or(&Value::Null);
        for (column, value) in [
            source_or_measurement("date"),
            source_or_measurement("voucherId"),
            calculation_type,
            source_or_measurement("pendingCategory"),
            from_detail("summary"),
            source_or_measurement("accountCode"),
            source_or_measurement("accountNameOriginal"),
        ]
        .iter()
        .enumerate()
        {
            sheet
                .write_string(output_row, column as u16, localized_text("", value))
                .map_err(xlsx_err)?;
        }
        let offset = u16::from(translated);
        if translated {
            sheet
                .write_string(
                    output_row,
                    7,
                    localized_text(
                        "accountNameChinese",
                        detail.get("accountNameChinese").unwrap_or(&Value::Null),
                    ),
                )
                .map_err(xlsx_err)?;
        }
        sheet
            .write_string(
                output_row,
                7 + offset,
                localized_text("currency", source_or_measurement("currency")),
            )
            .map_err(xlsx_err)?;
        for (column, key) in [
            (8 + offset, "foreignAmount"),
            (9 + offset, "functionalAmount"),
        ] {
            if let Some(value) = detail.get(key).and_then(Value::as_f64) {
                sheet
                    .write_number_with_format(output_row, column, value, &amount)
                    .map_err(xlsx_err)?;
            } else {
                sheet
                    .write_blank(output_row, column, &amount)
                    .map_err(xlsx_err)?;
            }
        }
        sheet
            .write_string(
                output_row,
                10 + offset,
                if measurement.is_some() { "是" } else { "否" },
            )
            .map_err(xlsx_err)?;
        if let Some(row) = measurement {
            let foreign = row
                .get("foreignAmount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let applied_rate = row
                .get("appliedRate")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let book = row.get("bookAmount").and_then(Value::as_f64).unwrap_or(0.0);
            let audit = row
                .get("auditAmount")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let gain_loss = row.get("gainLoss").and_then(Value::as_f64).unwrap_or(0.0);
            sheet
                .write_number_with_format(output_row, 11 + offset, foreign, &amount)
                .map_err(xlsx_err)?;
            sheet
                .write_number_with_format(output_row, 12 + offset, applied_rate, &rate)
                .map_err(xlsx_err)?;
            sheet
                .write_number_with_format(output_row, 13 + offset, book, &amount)
                .map_err(xlsx_err)?;
            let direction = row
                .get("formulaDirection")
                .and_then(Value::as_str)
                .unwrap_or("审计金额－账面金额");
            let pending = row.get("pending").and_then(Value::as_bool).unwrap_or(false);
            if pending {
                sheet
                    .write_blank(output_row, 14 + offset, &amount)
                    .map_err(xlsx_err)?;
            } else {
                sheet
                    .write_formula_with_format(
                        output_row,
                        14 + offset,
                        Formula::new(if translated {
                            format!("M{excel_row}*N{excel_row}")
                        } else {
                            format!("L{excel_row}*M{excel_row}")
                        })
                        .set_result(audit.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            let formula = if pending {
                if translated {
                    format!("O{excel_row}")
                } else {
                    format!("N{excel_row}")
                }
            } else if direction.starts_with("账面") {
                if translated {
                    format!("O{excel_row}-P{excel_row}")
                } else {
                    format!("N{excel_row}-O{excel_row}")
                }
            } else {
                if translated {
                    format!("P{excel_row}-O{excel_row}")
                } else {
                    format!("O{excel_row}-N{excel_row}")
                }
            };
            sheet
                .write_formula_with_format(
                    output_row,
                    15 + offset,
                    Formula::new(formula).set_result(gain_loss.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
            sheet
                .write_string(output_row, 16 + offset, direction)
                .map_err(xlsx_err)?;
            sheet
                .write_string(
                    output_row,
                    17 + offset,
                    localized_text("note", row.get("note").unwrap_or(&Value::Null)),
                )
                .map_err(xlsx_err)?;
        } else {
            for column in (11 + offset)..=(15 + offset) {
                sheet
                    .write_blank(output_row, column, &amount)
                    .map_err(xlsx_err)?;
            }
        }
        if let Some(value) = detail.get("sourceRow").and_then(Value::as_u64) {
            sheet
                .write_number(output_row, 18 + offset, value as f64)
                .map_err(xlsx_err)?;
        }
        let mut next_column = 19u16 + offset;
        for key in &raw_headers {
            sheet
                .write_string(
                    output_row,
                    next_column,
                    localized_text(key, detail.get(key).unwrap_or(&Value::Null)),
                )
                .map_err(xlsx_err)?;
            next_column += 1;
        }
    }
    // 保留完整追溯字段，但默认只展示审计人员日常复核所需的输入、公式和结果。
    // 用户取消隐藏后仍可查看待复核分路、源行及 JE 原始字段。
    for column in [
        3,
        10 + u16::from(translated),
        17 + u16::from(translated),
        18 + u16::from(translated),
    ] {
        sheet.set_column_hidden(column).map_err(xlsx_err)?;
    }
    for column in (19 + u16::from(translated))..(headers.len() as u16) {
        sheet.set_column_hidden(column).map_err(xlsx_err)?;
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn formats() -> (Format, Format) {
    (
        Format::new()
            .set_bold()
            .set_font_color("#FFFFFF")
            .set_background_color("#245A57")
            .set_align(FormatAlign::Center),
        Format::new().set_background_color("#EAF3F1"),
    )
}

fn setup(worksheet: &mut Worksheet, name: &str) -> Result<(), AppError> {
    worksheet.set_name(name).map_err(xlsx_err)?;
    worksheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn write_kv_sheet(
    workbook: &mut Workbook,
    name: &str,
    rows: &[(&str, &str)],
) -> Result<(), AppError> {
    let (header, _) = formats();
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    worksheet
        .write_string_with_format(0, 0, "项目", &header)
        .map_err(xlsx_err)?;
    worksheet
        .write_string_with_format(0, 1, "内容", &header)
        .map_err(xlsx_err)?;
    for (index, (key, value)) in rows.iter().enumerate() {
        worksheet
            .write_string((index + 1) as u32, 0, *key)
            .map_err(xlsx_err)?;
        worksheet
            .write_string((index + 1) as u32, 1, localized_scalar(value))
            .map_err(xlsx_err)?;
    }
    worksheet.set_column_width(0, 22).map_err(xlsx_err)?;
    worksheet.set_column_width(1, 80).map_err(xlsx_err)?;
    Ok(())
}

fn write_json_object_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: &Value,
) -> Result<(), AppError> {
    let (header, _) = formats();
    let number_format = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent_format = Format::new().set_num_format("0.00%");
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    worksheet
        .write_string_with_format(0, 0, "项目", &header)
        .map_err(xlsx_err)?;
    worksheet
        .write_string_with_format(0, 1, "内容", &header)
        .map_err(xlsx_err)?;
    for (index, (key, value)) in value.as_object().into_iter().flatten().enumerate() {
        worksheet
            .write_string((index + 1) as u32, 0, chinese_header(key))
            .map_err(xlsx_err)?;
        match value {
            Value::Number(value) => worksheet
                .write_number_with_format(
                    (index + 1) as u32,
                    1,
                    value.as_f64().unwrap_or(0.0),
                    if key.to_lowercase().contains("ratio") {
                        &percent_format
                    } else {
                        &number_format
                    },
                )
                .map_err(xlsx_err)?,
            Value::Bool(value) => worksheet
                .write_string((index + 1) as u32, 1, if *value { "是" } else { "否" })
                .map_err(xlsx_err)?,
            _ => worksheet
                .write_string((index + 1) as u32, 1, localized_text(key, value))
                .map_err(xlsx_err)?,
        };
    }
    worksheet.set_column_width(0, 28).map_err(xlsx_err)?;
    worksheet.set_column_width(1, 38).map_err(xlsx_err)?;
    Ok(())
}

fn write_mapping_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
) -> Result<(), AppError> {
    let rows = value
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(key, value)| {
                    json!({
                        "字段角色": chinese_header(key), "最终映射": value,
                        "识别方式": "硬编码 + LLM复核 + 用户确认",
                        "校验结果": "后端再次验证"
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    write_value_array_sheet(workbook, name, Some(&Value::Array(rows)))
}

fn write_value_array_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
) -> Result<(), AppError> {
    let rows = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let mut keys = BTreeSet::new();
    for row in &rows {
        if let Some(object) = row.as_object() {
            keys.extend(object.keys().cloned());
        }
    }
    let keys = keys.into_iter().collect::<Vec<_>>();
    let (header, _) = formats();
    let number_format = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent_format = Format::new().set_num_format("0.00%");
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    for (column, key) in keys.iter().enumerate() {
        worksheet
            .write_string_with_format(0, column as u16, chinese_header(key), &header)
            .map_err(xlsx_err)?;
        worksheet
            .set_column_width(
                column as u16,
                match key.as_str() {
                    "account" => 38,
                    "evidence" | "detail" | "matchedRules" | "counterEvidence" | "tbRows" => 50,
                    "method" | "summary" | "scheme" => 36,
                    _ => 24,
                },
            )
            .map_err(xlsx_err)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        for (column, key) in keys.iter().enumerate() {
            if let Some(value) = row.get(key) {
                match value {
                    Value::Number(number) => {
                        worksheet
                            .write_number_with_format(
                                (row_index + 1) as u32,
                                column as u16,
                                number.as_f64().unwrap_or(0.0),
                                if key.to_lowercase().contains("ratio") {
                                    &percent_format
                                } else {
                                    &number_format
                                },
                            )
                            .map_err(xlsx_err)?;
                    }
                    _ => {
                        worksheet
                            .write_string(
                                (row_index + 1) as u32,
                                column as u16,
                                localized_text(key, value),
                            )
                            .map_err(xlsx_err)?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// 「未实现汇兑损益测算」专属导出器：固定列序并写入活公式，保证底稿可追溯——
/// 审计月末本位币余额 = 月末原币余额 × 月末官方中间价（J 列），
/// 月末重估损益 = 测算前本位币余额 − 审计月末本位币余额（L 列）。
/// 审计结论页的未实现公式直接 SUM 该 L 列，打开 Excel 重算仍能复现，
/// 任意一行都能用同行原币与汇率手工验算。此前用按键名排序的通用转储，
/// 结论页公式引用不到数据，重算后全部归零（曾显示为占位横线）。
/// 注意：S 列业务本位币发生额对已实现重算过的腿是审计口径
/// （原币×月初牌价），与客户账面之差在末列「已实现腿入账基础差异」披露，
/// 避免已实现损益在月末重估残差里被重复计算。
/// 写「汇率表」矩阵（行=请求日期，列=币种），返回可用的 (日期, 币种) 索引，
/// 供其他 Sheet 判断能否用公式链接（不在矩阵里的组合回退静态值，不留 #N/A）。
fn write_rate_matrix_sheet(
    workbook: &mut Workbook,
    result: &Value,
) -> Result<std::collections::HashSet<(String, String)>, AppError> {
    let (header, _) = formats();
    let rate_format = Format::new().set_num_format("0.00000000");
    let mut index = std::collections::HashSet::new();
    let mut matrix: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    for point in result
        .pointer("/rateSnapshot/rates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let (Some(date), Some(currency), Some(rate)) = (
            point.get("requestedDate").and_then(Value::as_str),
            point.get("currency").and_then(Value::as_str),
            point.get("cnyPerUnit").and_then(Value::as_f64),
        ) else {
            continue;
        };
        matrix
            .entry(date.to_owned())
            .or_default()
            .insert(currency.to_owned(), rate);
    }
    let currencies = matrix
        .values()
        .flat_map(|row| row.keys().cloned())
        .collect::<BTreeSet<_>>();
    let sheet = workbook.add_worksheet();
    setup(sheet, "汇率表")?;
    sheet
        .write_string_with_format(0, 0, "日期", &header)
        .map_err(xlsx_err)?;
    for (column, currency) in currencies.iter().enumerate() {
        sheet
            .write_string_with_format(0, (column + 1) as u16, currency, &header)
            .map_err(xlsx_err)?;
    }
    for (row_index, (date, row)) in matrix.iter().enumerate() {
        let excel_row = (row_index + 1) as u32;
        sheet.write_string(excel_row, 0, date).map_err(xlsx_err)?;
        for (column, currency) in currencies.iter().enumerate() {
            if let Some(rate) = row.get(currency) {
                sheet
                    .write_number_with_format(excel_row, (column + 1) as u16, *rate, &rate_format)
                    .map_err(xlsx_err)?;
                index.insert((date.clone(), currency.clone()));
            }
        }
    }
    sheet.set_column_width(0, 14).map_err(xlsx_err)?;
    for column in 0..currencies.len() {
        sheet
            .set_column_width((column + 1) as u16, 12)
            .map_err(xlsx_err)?;
    }
    Ok(index)
}

fn write_two_point_unrealized_sheet(
    workbook: &mut Workbook,
    value: Option<&Value>,
    rate_index: &std::collections::HashSet<(String, String)>,
) -> Result<(), AppError> {
    let rows = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let rate_format = Format::new().set_num_format("0.00000000");
    let sheet = workbook.add_worksheet();
    setup(sheet, "未实现汇兑损益测算")?;
    const COLUMNS: &[(&str, &str)] = &[
        ("entity", "主体"),
        ("account", "科目"),
        ("auxiliary", "辅助核算"),
        ("currency", "币种"),
        ("functionalCurrency", "本位币"),
        ("openingForeign", "期初原币余额"),
        ("openingRate", "期初官方中间价"),
        ("openingBookFunctional", "期初账面本位币余额"),
        ("openingAuditFunctional", "期初审计本位币余额"),
        ("openingDifference", "期初重估差异"),
        ("closingForeign", "期末原币余额"),
        ("closingRate", "期末官方中间价"),
        ("closingBookFunctional", "期末账面本位币余额"),
        ("closingAuditFunctional", "期末审计本位币余额"),
        ("closingDifference", "期末重估差异"),
        ("twoPointChange", "两时点差异变动"),
        ("suggestedAdjustment", "建议调整"),
        ("method", "测算方法"),
        ("sourceRow", "源文件行"),
    ];
    for (column, (_, title)) in COLUMNS.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header)
            .map_err(xlsx_err)?;
        sheet
            .set_column_width(column as u16, if *title == "科目" { 42 } else { 22 })
            .map_err(xlsx_err)?;
    }
    let write_rate = |sheet: &mut Worksheet,
                      output_row: u32,
                      column: u16,
                      excel_row: usize,
                      date: &str,
                      currency: &str,
                      cached: f64|
     -> Result<(), AppError> {
        if !date.is_empty()
            && !currency.is_empty()
            && rate_index.contains(&(date.to_owned(), currency.to_owned()))
        {
            sheet
                .write_formula_with_format(
                    output_row,
                    column,
                    Formula::new(format!(
                        "INDEX('汇率表'!$A:$XFD,MATCH({date_column}{excel_row},'汇率表'!$A:$A,0),MATCH(D{excel_row},'汇率表'!$1:$1,0))",
                        date_column = if column == 6 { "T" } else { "U" }
                    ))
                    .set_result(cached.to_string()),
                    &rate_format,
                )
                .map_err(xlsx_err)?;
        } else {
            sheet
                .write_number_with_format(output_row, column, cached, &rate_format)
                .map_err(xlsx_err)?;
        }
        Ok(())
    };
    // 两个日期放在隐藏追溯列，汇率公式据此链接统一的「汇率表」。
    sheet
        .write_string_with_format(0, 19, "期初汇率日期", &header)
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(0, 20, "期末汇率日期", &header)
        .map_err(xlsx_err)?;
    for (index, row) in rows.iter().enumerate() {
        let output_row = (index + 1) as u32;
        let excel_row = index + 2;
        let number = |key: &str| row.get(key).and_then(Value::as_f64);
        for (column, key) in [
            (0u16, "entity"),
            (1, "account"),
            (2, "auxiliary"),
            (3, "currency"),
            (4, "functionalCurrency"),
            (17, "method"),
        ] {
            if let Some(value) = row.get(key) {
                let text = localized_text(key, value);
                if !text.is_empty() {
                    sheet
                        .write_string(output_row, column, text)
                        .map_err(xlsx_err)?;
                }
            }
        }
        if let Some(source_row) = row.get("sourceRow").and_then(Value::as_u64) {
            sheet
                .write_number(output_row, 18, source_row as f64)
                .map_err(xlsx_err)?;
        }
        let opening_date = row
            .get("openingRateDate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let closing_date = row
            .get("closingRateDate")
            .and_then(Value::as_str)
            .unwrap_or("");
        let currency = row.get("currency").and_then(Value::as_str).unwrap_or("");
        sheet
            .write_string(output_row, 19, opening_date)
            .map_err(xlsx_err)?;
        sheet
            .write_string(output_row, 20, closing_date)
            .map_err(xlsx_err)?;
        for (column, key) in [
            (5u16, "openingForeign"),
            (7, "openingBookFunctional"),
            (10, "closingForeign"),
            (12, "closingBookFunctional"),
        ] {
            if let Some(value) = number(key) {
                sheet
                    .write_number_with_format(output_row, column, value, &amount)
                    .map_err(xlsx_err)?;
            }
        }
        if let Some(value) = number("openingRate") {
            write_rate(
                sheet,
                output_row,
                6,
                excel_row,
                opening_date,
                currency,
                value,
            )?;
        }
        if let Some(value) = number("closingRate") {
            write_rate(
                sheet,
                output_row,
                11,
                excel_row,
                closing_date,
                currency,
                value,
            )?;
        }
        if let (Some(foreign), Some(rate)) = (number("openingForeign"), number("openingRate")) {
            let cached = number("openingAuditFunctional").unwrap_or(foreign * rate);
            sheet
                .write_formula_with_format(
                    output_row,
                    8,
                    Formula::new(format!("F{excel_row}*G{excel_row}"))
                        .set_result(cached.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        }
        if let (Some(book), Some(audit)) = (
            number("openingBookFunctional"),
            number("openingAuditFunctional"),
        ) {
            sheet
                .write_formula_with_format(
                    output_row,
                    9,
                    Formula::new(format!("I{excel_row}-H{excel_row}"))
                        .set_result((audit - book).to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        }
        if let (Some(foreign), Some(rate)) = (number("closingForeign"), number("closingRate")) {
            let cached = number("closingAuditFunctional").unwrap_or(foreign * rate);
            sheet
                .write_formula_with_format(
                    output_row,
                    13,
                    Formula::new(format!("K{excel_row}*L{excel_row}"))
                        .set_result(cached.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        }
        if let (Some(book), Some(audit)) = (
            number("closingBookFunctional"),
            number("closingAuditFunctional"),
        ) {
            let difference = number("closingDifference").unwrap_or(audit - book);
            sheet
                .write_formula_with_format(
                    output_row,
                    14,
                    Formula::new(format!("N{excel_row}-M{excel_row}"))
                        .set_result(difference.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
            let opening_difference = number("openingDifference").unwrap_or(0.0);
            let change = number("twoPointChange").unwrap_or(difference - opening_difference);
            sheet
                .write_formula_with_format(
                    output_row,
                    15,
                    Formula::new(format!("O{excel_row}-J{excel_row}"))
                        .set_result(change.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
            let suggested = number("suggestedAdjustment").unwrap_or(difference);
            sheet
                .write_formula_with_format(
                    output_row,
                    16,
                    Formula::new(format!("O{excel_row}")).set_result(suggested.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        }
    }
    sheet.set_column_hidden(19).map_err(xlsx_err)?;
    sheet.set_column_hidden(20).map_err(xlsx_err)?;
    sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn write_unrealized_rollforward_sheet(
    workbook: &mut Workbook,
    value: Option<&Value>,
    rate_index: &std::collections::HashSet<(String, String)>,
) -> Result<(), AppError> {
    let rows = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let rate_format = Format::new().set_num_format("0.00000000");
    let wrap = Format::new().set_text_wrap();
    let sheet = workbook.add_worksheet();
    setup(sheet, "未实现汇兑损益测算")?;
    // (key, 中文表头, 数字格式)
    const COLUMNS: &[(&str, &str)] = &[
        ("entity", "主体"),
        ("account", "科目"),
        ("auxiliary", "辅助核算"),
        ("currency", "币种"),
        ("functionalCurrency", "本位币"),
        ("monthEnd", "月末测算日期"),
        ("publishedDate", "汇率公布日"),
        ("closingForeign", "月末原币余额"),
        ("officialRate", "月末官方中间价"),
        ("auditClosingFunctional", "审计月末本位币余额"),
        ("preRevaluationFunctional", "测算前本位币余额"),
        ("unrealizedGainLoss", "月末重估损益"),
        ("suggestedAdjustment", "建议调整"),
        ("clientBookedUnrealizedGainLoss", "客户已入账未实现损益"),
        ("clientRevaluationVouchers", "客户重估凭证"),
        ("openingForeign", "期初原币余额"),
        ("openingAuditFunctional", "年初审计本位币余额"),
        ("businessForeignMovement", "正常业务原币发生额"),
        ("businessFunctionalMovement", "正常业务本位币发生额"),
        (
            "clientRevaluationBalanceAdjustment",
            "客户凭证对货币性项目余额的调整",
        ),
        ("auditBalanceAdjustment", "审计期末折算余额调整"),
        ("tbClosingFunctional", "TB年末本位币余额"),
        ("tbReconciliationDifference", "TB勾稽差异"),
        (
            "realizedLegBasisDifference",
            "已实现腿入账基础差异（账面−审计）",
        ),
    ];
    for (column, (_, title)) in COLUMNS.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *title, &header)
            .map_err(xlsx_err)?;
        sheet
            .set_column_width(
                column as u16,
                match *title {
                    "科目" => 38,
                    "客户重估凭证" => 46,
                    _ => 24,
                },
            )
            .map_err(xlsx_err)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let output_row = (index + 1) as u32;
        let excel_row = index + 2;
        let number = |key: &str| row.get(key).and_then(Value::as_f64);
        // 文本列：主体、辅助核算、币种、本位币、两个日期。
        for (column, key) in [
            (0u16, "entity"),
            (2, "auxiliary"),
            (3, "currency"),
            (4, "functionalCurrency"),
            (5, "monthEnd"),
            (6, "publishedDate"),
        ] {
            let text = row
                .get(key)
                .map(|value| localized_text(key, value))
                .unwrap_or_default();
            if !text.is_empty() {
                sheet
                    .write_string(output_row, column, text)
                    .map_err(xlsx_err)?;
            }
        }
        // 科目单独走宽度友好的通用本地化。
        if let Some(value) = row.get("account") {
            sheet
                .write_string(output_row, 1, localized_text("account", value))
                .map_err(xlsx_err)?;
        }
        // 数值输入列（来自 TB/JE 的原始事实，表内无法推导）：保持静态。
        // 其余全部按引擎同款算式写成行内公式，打开即可验算：
        //   H 月末原币余额   = P期初原币 + R业务原币发生
        //   K 测算前本位币   = Q期初审计折算 + S业务本位币发生
        //   J 审计折算余额   = H原币 × I月末中间价
        //   L 月末重估损益   = K测算前 − J审计折算
        //   M 建议调整       = L重估损益 − N客户已入账未实现
        //   U 审计折算调整   = J审计折算 − K测算前
        //   W TB勾稽差异     = J审计折算 − V年末本位币（仅年末行有 V）
        //   X 已实现腿入账基础差异 = 静态披露列（客户账面−审计口径）
        //   I 月末官方中间价   = 链接「汇率表」单一来源（INDEX/MATCH）
        for (column, key, format) in [
            (13, "clientBookedUnrealizedGainLoss", &amount),
            (15, "openingForeign", &amount),
            (16, "openingAuditFunctional", &amount),
            (17, "businessForeignMovement", &amount),
            (18, "businessFunctionalMovement", &amount),
            (19, "clientRevaluationBalanceAdjustment", &amount),
            (21, "tbClosingFunctional", &amount),
            (23, "realizedLegBasisDifference", &amount),
        ] {
            if let Some(value) = number(key) {
                sheet
                    .write_number_with_format(output_row, column, value, format)
                    .map_err(xlsx_err)?;
            }
        }
        // I 列月末官方中间价链接「汇率表」（行=日期、列=币种）：复核只需
        // 核一张牌价表，改一处汇率全簿联动重算；矩阵缺该组合时回退静态。
        if let Some(rate) = number("officialRate") {
            let date = row.get("monthEnd").and_then(Value::as_str).unwrap_or("");
            let currency = row.get("currency").and_then(Value::as_str).unwrap_or("");
            if !date.is_empty()
                && !currency.is_empty()
                && rate_index.contains(&(date.to_owned(), currency.to_owned()))
            {
                sheet
                    .write_formula_with_format(
                        output_row,
                        8,
                        Formula::new(format!(
                            "INDEX('汇率表'!$A:$XFD,MATCH(F{excel_row},'汇率表'!$A:$A,0),\
                             MATCH(D{excel_row},'汇率表'!$1:$1,0))"
                        ))
                        .set_result(rate.to_string()),
                        &rate_format,
                    )
                    .map_err(xlsx_err)?;
            } else {
                sheet
                    .write_number_with_format(output_row, 8, rate, &rate_format)
                    .map_err(xlsx_err)?;
            }
        }
        // 公式写入约定：算式的两个输入都在才写公式（缓存值仍取引擎结果，
        // 保证预览器与重算一致）；任一缺失则回退静态值或留空，避免留下
        // 看似可信的错误数字。

        // H = P + R（月末原币余额 = 期初原币 + 业务原币发生）
        match (
            number("openingForeign"),
            number("businessForeignMovement"),
            number("closingForeign"),
        ) {
            (Some(_opening), Some(movement), Some(closing)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        7,
                        Formula::new(format!("P{excel_row}+R{excel_row}"))
                            .set_result(closing.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            (_, _, Some(closing)) => {
                sheet
                    .write_number_with_format(output_row, 7, closing, &amount)
                    .map_err(xlsx_err)?;
            }
            _ => {}
        }
        // I 官方中间价已在上方静态列写出。

        // K = Q + S
        match (
            row.get("openingAuditFunctional").and_then(Value::as_f64),
            row.get("businessFunctionalMovement")
                .and_then(Value::as_f64),
            row.get("preRevaluationFunctional").and_then(Value::as_f64),
        ) {
            (Some(_prior), Some(change), Some(pre)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        10,
                        Formula::new(format!("Q{excel_row}+S{excel_row}"))
                            .set_result(pre.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            (_, _, Some(pre)) => {
                sheet
                    .write_number_with_format(output_row, 10, pre, &amount)
                    .map_err(xlsx_err)?;
            }
            _ => {}
        }

        // J = H × I
        if let (Some(closing), Some(rate)) = (number("closingForeign"), number("officialRate")) {
            let cached = row
                .get("auditClosingFunctional")
                .and_then(Value::as_f64)
                .unwrap_or(closing * rate);
            sheet
                .write_formula_with_format(
                    output_row,
                    9,
                    Formula::new(format!("H{excel_row}*I{excel_row}"))
                        .set_result(cached.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        } else if let Some(cached) = number("auditClosingFunctional") {
            sheet
                .write_number_with_format(output_row, 9, cached, &amount)
                .map_err(xlsx_err)?;
        }

        // L = K − J
        if let (Some(pre), Some(audit)) = (
            row.get("preRevaluationFunctional").and_then(Value::as_f64),
            row.get("auditClosingFunctional").and_then(Value::as_f64),
        ) {
            sheet
                .write_formula_with_format(
                    output_row,
                    11,
                    Formula::new(format!("K{excel_row}-J{excel_row}"))
                        .set_result((pre - audit).to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        } else if let Some(gain_loss) = number("unrealizedGainLoss") {
            sheet
                .write_number_with_format(output_row, 11, gain_loss, &amount)
                .map_err(xlsx_err)?;
        }

        // M = L − N（audit 未实现损益 − 客户已入账，即建议调整分录方向）
        match (
            row.get("unrealizedGainLoss").and_then(Value::as_f64),
            row.get("clientBookedUnrealizedGainLoss")
                .and_then(Value::as_f64),
            row.get("suggestedAdjustment").and_then(Value::as_f64),
        ) {
            (Some(gain_loss), Some(booked), Some(suggested)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        12,
                        Formula::new(format!("L{excel_row}-N{excel_row}"))
                            .set_result(suggested.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            (_, _, Some(suggested)) => {
                sheet
                    .write_number_with_format(output_row, 12, suggested, &amount)
                    .map_err(xlsx_err)?;
            }
            _ => {}
        }

        // U = J − K（审计折算后账面需要补记的调整额；L 是它的相反数）
        match (
            row.get("auditClosingFunctional").and_then(Value::as_f64),
            row.get("preRevaluationFunctional").and_then(Value::as_f64),
            row.get("auditBalanceAdjustment").and_then(Value::as_f64),
        ) {
            (Some(audit), Some(pre), Some(adjustment)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        20,
                        Formula::new(format!("J{excel_row}-K{excel_row}"))
                            .set_result(adjustment.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            (_, _, Some(adjustment)) => {
                sheet
                    .write_number_with_format(output_row, 20, adjustment, &amount)
                    .map_err(xlsx_err)?;
            }
            _ => {}
        }

        // W = J − V，仅年末行有 TB 期末数可比；其余月份该列为空。
        match (
            row.get("auditClosingFunctional").and_then(Value::as_f64),
            row.get("tbClosingFunctional").and_then(Value::as_f64),
            row.get("tbReconciliationDifference")
                .and_then(Value::as_f64),
        ) {
            (Some(audit), Some(tb), difference) => {
                let cached = difference.unwrap_or(audit - tb);
                sheet
                    .write_formula_with_format(
                        output_row,
                        22,
                        Formula::new(format!("J{excel_row}-V{excel_row}"))
                            .set_result(cached.to_string()),
                        &amount,
                    )
                    .map_err(xlsx_err)?;
            }
            (_, None, Some(difference)) => {
                sheet
                    .write_number_with_format(output_row, 22, difference, &amount)
                    .map_err(xlsx_err)?;
            }
            _ => {}
        }
        // 客户重估凭证：凭证号＋摘要合并为一段可读文本。
        let mut vouchers = Vec::new();
        for voucher in row
            .get("clientRevaluationVoucherIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            vouchers.push(voucher.as_str().unwrap_or_default().to_owned());
        }
        for detail in row
            .get("clientRevaluationDetails")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let summary = detail.get("summary").and_then(Value::as_str).unwrap_or("");
            let booked = detail.get("bookedFxGainLoss").and_then(Value::as_f64);
            if !summary.is_empty() {
                vouchers.push(if let Some(booked) = booked {
                    format!("{}（{:.2}）", summary, booked)
                } else {
                    summary.to_owned()
                });
            }
        }
        if !vouchers.is_empty() {
            sheet
                .write_string_with_format(output_row, 14, vouchers.join("；"), &wrap)
                .map_err(xlsx_err)?;
        }
    }
    // 中间桥接列和技术校验列仍保留在底稿内，但默认隐藏，避免主视图横向过宽。
    for column in [4, 6, 16, 18, 19, 20, 23] {
        sheet.set_column_hidden(column).map_err(xlsx_err)?;
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn write_filtered_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
    prefix: &str,
) -> Result<(), AppError> {
    let rows = value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|row| {
                    let mut output = Map::new();
                    if let Some(object) = row.as_object() {
                        for (key, value) in object {
                            if [
                                "entity",
                                "account",
                                "currency",
                                "functionalCurrency",
                                "sourceRow",
                            ]
                            .contains(&key.as_str())
                                || key.starts_with(prefix)
                            {
                                output.insert(key.clone(), value.clone());
                            }
                        }
                    }
                    Value::Object(output)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    write_value_array_sheet(workbook, name, Some(&Value::Array(rows)))
}

fn json_text(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    };
    if text.chars().count() > 32_000 {
        let mut shortened = text.chars().take(31_950).collect::<String>();
        shortened.push_str("…[内容超出Excel单元格上限，完整明细见对应明细页]");
        shortened
    } else {
        text
    }
}

/// 新已实现测算体系入账假设的前置验证：只输出数据质量提示，**不阻断测算**。
///
/// 新已实现口径是「每条终止确认腿 × (记账日官方牌价 − 当月月初牌价)」，
/// 前提是客户账套「按当月月初汇率入账 + 每月月末重估」。本函数对 JE 数据做两组检查：
///
/// 1. **入账口径恒定性**：对货币性项目角色且原币发生额 |≥0.01、币种≠本位币的行，
///    按「公司+币种+月份」分组倒算入账汇率（|本位币金额|÷|原币金额|）。组内不恒定
///    （极差≥0.005）→「待复核」；恒定但与当月月初牌价偏离>0.01 →「提示」。
///    每组最多一条，不逐行刷屏；非 CNY 本位币经 `month_opening_rate` 同日交叉折算
///    后同样参与对比。
/// 2. **每月重估存在性**：某公司某月有外币货币性项目发生额、却未识别到任何客户
///    月末重估凭证 →「提示」，跨月结算项目的账面汇率可能不等于当月月初牌价。
///    每公司每月最多一条。
///
/// 重估凭证识别与 `calculate_monthly_unrealized` 的 revaluation_meta 判定同一口径
/// （manual_classification 优先，科目名/摘要/凭证类型信号兜底），直接复用现有函数，
/// 不另起第二套。参数或读表失败时静默返回空列表——本检查是提示性质，硬错误由
/// 主测算路径统一报告。
pub(crate) fn month_start_rate_assumption_checks(
    params: &Value,
    snapshot: &RateSnapshot,
) -> Vec<Value> {
    let mut output = Vec::new();
    let Some(spec) = params
        .get("jeSource")
        .and_then(|source| serde_json::from_value::<SourceSpec>(source.clone()).ok())
    else {
        return output;
    };
    let Ok(table) = load_fx_table(&spec) else {
        return output;
    };
    let mapping = mapping_obj(params, "jeMapping");
    let rows = records(&table);

    // 按完整凭证分组（与 build_review_bridge / calculate_monthly_unrealized 同一口径）：
    // 重估证据要看整张凭证的科目组合，单行看不出来。
    let mut voucher_rows: BTreeMap<String, Vec<&RowRecord>> = BTreeMap::new();
    for row in &rows {
        if !is_je_business_row(row, &mapping) || parse_date(cell(row, &mapping, "date")).is_none() {
            continue;
        }
        voucher_rows
            .entry(voucher_id(row, &mapping, params))
            .or_default()
            .push(row);
    }

    // (公司, 币种, 年月) → 组内各行倒算出的入账汇率
    let mut implied_rates: BTreeMap<(String, String, (i32, u32)), Vec<f64>> = BTreeMap::new();
    // 存在外币货币性项目发生额的（公司, 年月）
    let mut activity_months: BTreeSet<(String, (i32, u32))> = BTreeSet::new();
    // 已被识别为客户月末重估凭证覆盖的（公司, 年月）
    let mut revaluation_months: BTreeSet<(String, (i32, u32))> = BTreeSet::new();

    for (raw_id, voucher) in &voucher_rows {
        let display_id = display_voucher_id(raw_id);
        let mut entities: BTreeSet<String> = BTreeSet::new();
        for row in voucher {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            let entity = entity_for(row, &mapping, params).to_owned();
            let functional = functional_currency(&entity, params);
            entities.insert(entity.clone());
            // 金额解析失败不在本函数报错（约定是不阻断测算）：跳过该行金额信号，
            // 硬错误由主测算路径统一报告。
            let functional_amount = signed_amount(row, &mapping, "functional").ok();
            let foreign_amount = signed_amount(row, &mapping, "foreign").ok();
            if !matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                continue;
            }
            let currency = currency_for(row, &mapping, &account, params);
            if currency.is_empty() || currency == functional {
                continue;
            }
            let Some(foreign) = foreign_amount else {
                continue;
            };
            if foreign.abs() < 0.01 {
                continue;
            }
            let Some(date) = parse_date(cell(row, &mapping, "date")) else {
                continue;
            };
            let month = (date.year(), date.month());
            activity_months.insert((entity.clone(), month));
            // 本位币金额接近零的行除不出有效汇率，只制造假「不恒定」噪声，跳过。
            if let Some(functional_value) = functional_amount {
                if functional_value.abs() >= 0.005 {
                    implied_rates
                        .entry((entity, normalize_currency(&currency), month))
                        .or_default()
                        .push(functional_value.abs() / foreign.abs());
                }
            }
        }
        // 与 calculate_monthly_unrealized 的 revaluation_meta 判定保持同一口径：
        // 人工分类优先；自动分类只看完整凭证的净额结构。
        let automatic_signal = voucher_fx_structure(voucher.iter().copied(), &mapping, params)
            .map(|structure| structure.unrealized)
            .unwrap_or(false);
        let is_revaluation = match manual_classification(params, &display_id) {
            Some("未实现汇兑损益") => true,
            Some("已实现汇兑损益") => false,
            _ => automatic_signal,
        };
        if is_revaluation {
            if let Some(date) = voucher
                .iter()
                .find_map(|row| parse_date(cell(row, &mapping, "date")))
            {
                let month = (date.year(), date.month());
                for entity in &entities {
                    revaluation_months.insert((entity.clone(), month));
                }
            }
        }
    }

    // —— 检查一：入账口径恒定性与月初牌价对比（每「公司+币种+月份」最多一条）——
    for ((entity, currency, (year, month)), rates) in &implied_rates {
        let month_text = format!("{year:04}-{month:02}");
        let mut min_rate = f64::INFINITY;
        let mut max_rate = f64::NEG_INFINITY;
        for rate in rates {
            min_rate = min_rate.min(*rate);
            max_rate = max_rate.max(*rate);
        }
        if max_rate - min_rate >= 0.005 {
            output.push(json!({
                "source": "JE", "type": "当月入账汇率不恒定",
                "severity": "待复核", "entity": entity, "currency": currency,
                "month": month_text, "minImpliedRate": min_rate, "maxImpliedRate": max_rate,
                "detail": format!(
                    "{entity} {currency} 币种 {month_text} 的JE倒算入账汇率组内不一致\
                     （最低 {min_rate:.4}、最高 {max_rate:.4}，极差 {:.4}），\
                     可能按交易日即期汇率逐笔入账，「按当月月初汇率入账」的假设不成立，\
                     新已实现测算体系对当月 {currency} 项目将产生相应系统性差异。",
                    max_rate - min_rate
                )
            }));
            continue;
        }
        let representative = min_rate;
        let Some(month_first_day) = NaiveDate::from_ymd_opt(*year, *month, 1) else {
            continue;
        };
        let functional = functional_currency(entity, params);
        match month_opening_rate(snapshot, month_first_day, currency, &functional) {
            None => {
                output.push(json!({
                    "source": "JE+汇率快照", "type": "当月月初牌价缺失",
                    "severity": "提示", "entity": entity, "currency": currency,
                    "month": month_text, "impliedRate": representative,
                    "detail": format!(
                        "{entity} {currency} 币种 {month_text} 的入账汇率恒定为 {representative:.4}，\
                         但汇率快照既无上月末牌价、也无当月最早牌价，\
                         无法验证「按当月月初汇率入账」的假设，请补充汇率区间后复核。"
                    )
                }));
            }
            Some((opening_rate, published, is_fallback)) => {
                let deviation = (representative - opening_rate).abs();
                if deviation > 0.01 {
                    let fallback_note = if is_fallback {
                        "，快照无上月末牌价，回退取当月最早"
                    } else {
                        ""
                    };
                    output.push(json!({
                        "source": "JE+汇率快照", "type": "入账汇率偏离当月月初牌价",
                        "severity": "提示", "entity": entity, "currency": currency,
                        "month": month_text, "impliedRate": representative,
                        "monthOpeningRate": opening_rate,
                        "monthOpeningRateDate": published,
                        "monthOpeningRateFallback": is_fallback,
                        "detail": format!(
                            "{entity} {currency} 币种 {month_text} 的入账汇率恒定为 {representative:.4}，\
                             与当月月初基准牌价 {opening_rate:.4}（{published} 公布{fallback_note}）偏离 {deviation:.4}；\
                             新已实现测算体系以「记账日官方牌价−当月月初牌价」为基准，\
                             该假设下会产生相应系统性差异。"
                        )
                    }));
                }
                // 偏离 ≤ 0.01：该月假设成立，不出条目。
            }
        }
    }

    // —— 检查二：每月重估存在性（每公司每月最多一条）——
    for (entity, year_month) in &activity_months {
        if revaluation_months.contains(&(entity.clone(), *year_month)) {
            continue;
        }
        let month_text = format!("{:04}-{:02}", year_month.0, year_month.1);
        output.push(json!({
            "source": "JE", "type": "当月未见月末重估凭证",
            "severity": "提示", "entity": entity, "month": month_text,
            "detail": format!(
                "{entity} 在 {month_text} 存在外币货币性项目发生额，\
                 但未识别到当月客户月末重估（未实现汇兑损益）凭证；\
                 若客户并非每月重估，跨月结算项目的账面汇率可能不等于当月月初牌价，\
                 读取新已实现测算结果时请注意该口径。"
            )
        }));
    }
    output
}

fn chinese_header(key: &str) -> &str {
    match key {
        "account" => "科目",
        "accountCode" => "科目编码",
        "accountName" => "科目名称",
        "currencyText" => "币种线索文本",
        "accountNameOriginal" => "原始科目名称",
        "accountNameChinese" => "中文科目名称（LLM翻译）",
        "accountRoles" => "科目角色",
        "amount" => "金额",
        "automaticMeasuredFxGainLoss" => "自动测算合计",
        "auditClosingFunctional" => "审计月末本位币余额",
        "auditFxGainLoss" => "审计测算汇兑损益",
        "auditGainLoss" => "审计已实现汇兑损益",
        "auxiliary" => "辅助核算",
        "bookedFxGainLoss" => "账面汇兑损益",
        "businessForeignMovement" => "正常业务原币发生额",
        "businessFunctionalMovement" => "正常业务本位币发生额",
        "carryingFunctional" => "月初牌价重置账面本位币价值",
        "carryingBookFunctional" => "客户JE终止确认本位币账面（仅比对）",
        "carryingBasisDifference" => "账面基础差异（月初牌价－客户JE）",
        "monthOpeningRate" => "月初牌价（上月末）",
        "monthOpeningRateDate" => "月初牌价发布日期",
        "monthOpeningRateFallback" => "月初牌价是否口径回退",
        "cashRequired" => "现金是否为必要条件",
        "classification" => "分类",
        "clientRevaluationExcluded" => "客户已入账未实现汇兑损益",
        "clientRevaluationBalanceAdjustment" => "客户未实现类凭证对货币性项目余额的调整",
        "clientBookedUnrealizedGainLoss" => "客户已入账未实现汇兑损益",
        "coveredBookRealizedGainLoss" => "已覆盖账面已实现汇兑损益",
        "realizedMeasurementDifference" => "已实现测算差异",
        "unrealizedMeasurementDifference" => "未实现测算差异",
        "coveredMeasurementDifference" => "已覆盖项目测算差异",
        "uncoveredTbFxGainLoss" => "未覆盖账面金额",
        "clientRevaluationVoucherIds" => "未实现汇兑损益/冲回凭证号",
        "clientRevaluationDetails" => "未实现汇兑损益类凭证信息",
        "closingAuditFunctional" => "年末审计本位币余额",
        "closingBookFunctional" => "年末账面本位币余额",
        "closingDifference" => "年末折算差异",
        "closingForeign" => "年末原币余额",
        "closingRate" => "年末汇率",
        "confidence" => "置信度",
        "counterEvidence" => "反向证据",
        "coverageDifference" => "覆盖勾稽差异",
        "coveredBookFxGainLoss" => "自动测算覆盖的账面汇兑损益",
        "currency" => "币种",
        "date" => "日期",
        "detail" => "说明",
        "difference" => "测算与TB差异",
        "differenceRatio" => "差异率",
        "entity" => "公司/核算主体",
        "eventType" => "事件类型",
        "evidence" => "识别证据",
        "excludedTransferRows" => "剔除损益结转行数",
        "foreignMovement" => "原币变动",
        "functionalCurrency" => "本位币",
        "identificationBasis" => "识别依据",
        "inferredForeign" => "倒算原币余额",
        "impliedRate" => "JE倒算入账汇率",
        "minImpliedRate" => "组内最低倒算入账汇率",
        "maxImpliedRate" => "组内最高倒算入账汇率",
        "jeFxGainLossAfterTransferExclusion" => "JE剔除损益结转后汇兑损益",
        "jeTbDifference" => "JE与TB差异",
        "lowConfidenceEvents" => "低置信度事件数",
        "matchedRules" => "命中规则",
        "measurementDifference" => "自动测算金额差异",
        "method" => "测算方法",
        "mode" => "测算模式",
        "needsZeroResultReview" => "零结果是否需要复核",
        "month" => "月份",
        "monthEnd" => "月末测算日期",
        "nonRevaluationFunctionalMovement" => "正常业务本位币变动（剔除未实现类凭证）",
        "officialRate" => "官方汇率",
        "customerAppliedRate" => "客户JE倒算汇率（仅供比较）",
        "openingAuditFunctional" => "年初审计本位币余额",
        "openingBookFunctional" => "年初账面本位币余额",
        "openingDifference" => "年初折算差异",
        "openingForeign" => "年初原币余额",
        "openingRate" => "年初汇率",
        "accountTranslationEnabled" => "是否启用科目名称翻译",
        "translatedAccountNames" => "已翻译英文科目数",
        "pendingCategory" => "待复核分路",
        "pendingReviewAmount" => "待复核项目账面金额",
        "pendingReviewCount" => "待复核项目数",
        "postRevaluationFunctional" => "计入客户未实现类凭证后本位币余额",
        "preRevaluationFunctional" => "未实现损益测算前本位币余额",
        "publishedDate" => "汇率公布日期",
        "realizedEvents" => "已实现测算事件数",
        "realizedLegBasisDifference" => "已实现腿入账基础差异（账面−审计）",
        "realizedGainLoss" => "已实现汇兑损益",
        "realizedScore" => "已实现得分",
        "reconciliationPassed" => "勾稽是否通过",
        "requestedDate" => "请求日期",
        "responseHash" => "汇率响应哈希",
        "reviewReason" => "待复核原因",
        "role" => "科目角色",
        "ruleConflict" => "规则冲突",
        "scheme" => "金额口径",
        "settlementForeign" => "结算原币金额",
        "severity" => "严重程度",
        "source" => "来源/识别方式",
        "sourceRow" => "源文件行号",
        "suggestedAdjustment" => "建议调整",
        "auditBalanceAdjustment" => "审计期末折算余额调整",
        "summary" => "摘要",
        "tbClosingFunctional" => "TB年末本位币余额",
        "tbFxGainLoss" => "TB汇兑损益发生额",
        "tbReconciliationDifference" => "TB勾稽差异",
        "tbRows" => "TB汇兑损益取数明细",
        "translatedFunctional" => "按成交价折算本位币",
        "appliedRate" => "测算采用成交价",
        "rateBasis" => "汇率口径",
        "twoPointChange" => "两时点差异变化",
        "type" => "异常/检查类型",
        "unrealizedAdjustment" => "未实现汇兑损益",
        "unrealizedGainLoss" => "未实现汇兑损益",
        "unrealizedRows" => "未实现测算行数",
        "unrealizedScore" => "未实现得分",
        "voucherId" => "凭证匹配ID",
        "openingPublishedDate" => "年初汇率公布日期",
        "fxAccounts" => "汇兑损益科目",
        "currencies" => "涉及币种",
        "calculationType" => "测算类型",
        "classificationConflict" => "分类冲突提示",
        "selectedClassification" => "当前分类（结构判定）",
        "bookAmount" => "测算前账面金额",
        "auditAmount" => "审计测算金额",
        "gainLoss" => "汇兑损益",
        "included" => "是否纳入汇总",
        "note" => "备注",
        "closingPublishedDate" => "年末汇率公布日期",
        "fetchedAt" => "汇率抓取时间",
        "sourceUrl" => "汇率来源网址",
        "startDate" => "汇率快照开始日",
        "endDate" => "汇率快照结束日",
        "rates" => "汇率明细",
        "missing" => "缺失币种/日期",
        "cnyPerUnit" => "每单位外币折合人民币",
        "functionalAmount" => "本位币净额",
        "foreignAmount" => "原币净额",
        "foreignDirection" => "原币借贷方向",
        "id" => "凭证识别字段",
        "voucherType" => "凭证类型",
        "date" => "记账日期",
        "account" => "科目编码/名称",
        "currency" => "交易币种",
        "openingFunctionalDebit" => "年初本位币借方余额",
        "openingFunctionalCredit" => "年初本位币贷方余额",
        "closingFunctionalDebit" => "年末本位币借方余额",
        "closingFunctionalCredit" => "年末本位币贷方余额",
        "periodFunctionalDebit" => "本期本位币借方发生额",
        "periodFunctionalCredit" => "本期本位币贷方发生额",
        _ => key,
    }
}

fn localized_text(_key: &str, value: &Value) -> String {
    fn localize(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (chinese_header(key).to_owned(), localize(value)))
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.iter().map(localize).collect()),
            Value::String(text) => Value::String(localized_scalar(text).to_owned()),
            Value::Bool(value) => Value::String(if *value { "是" } else { "否" }.to_owned()),
            _ => value.clone(),
        }
    }
    match value {
        Value::String(text) => localized_scalar(text).to_owned(),
        _ => json_text(&localize(value)),
    }
}

fn localized_scalar(value: &str) -> &str {
    match value {
        "realized" => "仅已实现",
        "unrealized" => "仅未实现",
        "combined" => "已实现＋未实现",
        "cash" => "外币现金及银行",
        "monetary_asset" => "货币性资产",
        "monetary_liability" => "货币性负债",
        "fx_gain_loss" => "汇兑损益",
        "other_pnl" => "其他损益/成本科目",
        "non_monetary" => "非货币性项目",
        "excluded" => "排除项目",
        "review" => "待确认",
        "unassigned" => "未分配",
        "true" => "是",
        "false" => "否",
        _ => value,
    }
}

fn xlsx_err(value: XlsxError) -> AppError {
    error(
        "OUTPUT_WRITE_FAILED",
        "无法写入审计底稿。",
        Some(value.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_row_record(pairs: &[(&str, &str)]) -> RowRecord<'static> {
        let headers = Box::leak(
            pairs
                .iter()
                .map(|(header, _)| (*header).to_owned())
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let row = Box::leak(
            pairs
                .iter()
                .map(|(_, value)| (*value).to_owned())
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let header_index = Rc::new(
            headers
                .iter()
                .enumerate()
                .map(|(index, header)| (header.as_str(), index))
                .collect(),
        );
        RowRecord {
            source_row: 1,
            header_index,
            row,
        }
    }

    #[test]
    fn 大文件轻量预览保留被省略空白行后的物理表头行号() {
        let xml = r#"<worksheet><dimension ref="A1:E7"/><sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>总账科目</t></is></c></row>
            <row r="2"><c r="A2" t="inlineStr"><is><t>公司代码</t></is></c></row>
            <row r="3"><c r="A3" t="inlineStr"><is><t>分类账</t></is></c></row>
            <row r="4"><c r="A4" t="inlineStr"><is><t></t></is></c></row>
            <row r="6">
              <c r="A6" t="inlineStr"><is><t>凭证编号</t></is></c>
              <c r="B6" t="inlineStr"><is><t>凭证日期</t></is></c>
              <c r="C6" t="inlineStr"><is><t>本币金额</t></is></c>
              <c r="D6" t="inlineStr"><is><t>总账科目</t></is></c>
              <c r="E6" t="inlineStr"><is><t>会计科目</t></is></c>
            </row>
            <row r="7"><c r="A7" t="inlineStr"><is><t>6000000028</t></is></c></row>
          </sheetData></worksheet>"#;
        let rows = xlsx_sample_rows(xml, &[], 5, &HashSet::new(), false);
        assert_eq!(
            rows.iter().map(|row| row.number).collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 6, 7]
        );
        let (header_row, depth, _) = infer_xlsx_header_layout(&rows);
        assert_eq!(header_row, 6);
        assert_eq!(depth, 1);
    }

    fn period_promotion_table(rows: usize, broken: Option<usize>) -> FxTable {
        let headers = vec![
            "科目编码".into(),
            "期初余额".into(),
            "本期借方".into(),
            "本期贷方".into(),
            "期末余额".into(),
        ];
        let values = (0..rows)
            .map(|index| {
                let opening = 100.0 + index as f64;
                let debit = 10.0;
                let credit = 5.0;
                let closing = if broken == Some(index) {
                    opening + debit - credit + 1.0
                } else {
                    opening + debit - credit
                };
                vec![
                    format!("1001{index:02}"),
                    opening.to_string(),
                    debit.to_string(),
                    credit.to_string(),
                    closing.to_string(),
                ]
            })
            .collect::<Vec<_>>();
        FxTable {
            path: PathBuf::new(),
            sheet: "TB".into(),
            sheets: vec!["TB".into()],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![headers.clone()],
            headers,
            row_count: values.len(),
            rows: values,
            header_candidates: vec![],
            sampled: false,
        }
    }

    fn period_promotion_mapping() -> Map<String, Value> {
        json!({
            "accountCode": "科目编码",
            "openingFunctionalAmount": "期初余额",
            "periodFunctionalDebit": "本期借方",
            "periodFunctionalCredit": "本期贷方",
            "closingFunctionalAmount": "期末余额"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn 本期发生额在二十行中百分之九十五勾稽成立时自动提升() {
        let table = period_promotion_table(20, Some(0));
        let mut mapping = period_promotion_mapping();
        assert!(promote_period_movement(&table, &mut mapping));
        assert_eq!(mapping["ytdFunctionalDebit"], "本期借方");
        assert_eq!(mapping["ytdFunctionalCredit"], "本期贷方");
        assert!(!mapping.contains_key("periodFunctionalDebit"));
        assert!(!mapping.contains_key("periodFunctionalCredit"));
    }

    #[test]
    fn 本期发生额少于十行时必须全部勾稽成立() {
        let table = period_promotion_table(9, Some(0));
        let mut mapping = period_promotion_mapping();
        assert!(!promote_period_movement(&table, &mut mapping));
        assert!(!mapping.contains_key("ytdFunctionalDebit"));
        assert_eq!(mapping["periodFunctionalDebit"], "本期借方");
    }

    #[test]
    fn 混写科目单元格按角色拆出编码和名称() {
        assert_eq!(
            normalized_account_role_value("1001010000:库存现金-人民币", "accountCode"),
            "1001010000"
        );
        assert_eq!(
            normalized_account_role_value("1001010000:库存现金-人民币", "accountName"),
            "库存现金-人民币"
        );
        assert_eq!(
            normalized_account_role_value("1001/库存现金", "accountCode"),
            "1001"
        );
        assert_eq!(
            normalized_account_role_value("库存现金", "accountCode"),
            "库存现金"
        );
    }

    #[test]
    fn je向下填充不复制金额列() {
        let table = Arc::new(FxTable {
            path: PathBuf::new(),
            sheet: "JE".into(),
            sheets: vec!["JE".into()],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![vec!["凭证号".into(), "科目".into(), "金额".into()]],
            headers: vec!["凭证号".into(), "科目".into(), "金额".into()],
            rows: vec![
                vec!["JE-1".into(), "银行存款".into(), "100".into()],
                vec!["".into(), "应收账款".into(), "".into()],
                vec!["".into(), "".into(), "-100".into()],
            ],
            row_count: 3,
            header_candidates: vec![],
            sampled: false,
        });
        let mapping = json!({
            "id": "凭证号",
            "accountName": "科目",
            "functionalAmount": "金额"
        })
        .as_object()
        .unwrap()
        .clone();
        let filled = forward_filled_je_table(&table, &mapping);
        assert_eq!(filled.rows[1], vec!["JE-1", "应收账款", ""]);
        // 第三行没有身份只有金额（合计行形态）：不接收填充，保持原样——
        // 填上一行的凭证号/科目它会变成真分录混进发生额。
        assert_eq!(filled.rows[2], vec!["", "", "-100"]);
    }

    #[test]
    fn 同一汇兑任务复用向下填充后的je() {
        let table = Arc::new(FxTable {
            path: PathBuf::new(),
            sheet: "JE".into(),
            sheets: vec!["JE".into()],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![vec!["凭证号".into(), "科目".into(), "金额".into()]],
            headers: vec!["凭证号".into(), "科目".into(), "金额".into()],
            rows: vec![
                vec!["JE-1".into(), "银行存款".into(), "100".into()],
                vec!["".into(), "应收账款".into(), "-100".into()],
            ],
            row_count: 2,
            header_candidates: vec![],
            sampled: false,
        });
        let mapping = json!({
            "id": "凭证号",
            "accountName": "科目",
            "functionalAmount": "金额"
        })
        .as_object()
        .unwrap()
        .clone();

        let _cache = FxJobTableCacheGuard::begin();
        let first = forward_filled_je_table(&table, &mapping);
        let second = forward_filled_je_table(&table, &mapping);
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&table, &first), "有空身份字段时应生成清洗表");
        assert_eq!(second.rows[1][0], "JE-1");
    }

    #[test]
    fn je空币种和方向不继承上一行() {
        let table = Arc::new(FxTable {
            path: PathBuf::new(),
            sheet: "JE".into(),
            sheets: vec!["JE".into()],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![vec![
                "凭证号".into(),
                "科目".into(),
                "币种".into(),
                "方向".into(),
                "原币".into(),
                "本位币".into(),
            ]],
            headers: vec![
                "凭证号".into(),
                "科目".into(),
                "币种".into(),
                "方向".into(),
                "原币".into(),
                "本位币".into(),
            ],
            rows: vec![
                vec![
                    "JE-1".into(),
                    "美元户".into(),
                    "美元".into(),
                    "借".into(),
                    "100".into(),
                    "720".into(),
                ],
                vec![
                    "".into(),
                    "库存现金".into(),
                    "".into(),
                    "".into(),
                    "".into(),
                    "50".into(),
                ],
            ],
            row_count: 2,
            header_candidates: vec![],
            sampled: false,
        });
        let mapping = json!({
            "id": "凭证号", "accountName": "科目", "currency": "币种",
            "direction": "方向", "foreignAmount": "原币", "functionalAmount": "本位币"
        })
        .as_object()
        .unwrap()
        .clone();
        let filled = forward_filled_je_table(&table, &mapping);
        assert_eq!(filled.rows[1][0], "JE-1", "合并的凭证号仍应向下填充");
        assert_eq!(filled.rows[1][2], "", "空币种表示本位币，不能继承美元");
        assert_eq!(filled.rows[1][3], "", "空方向不能继承上一行");
        let row = records(&filled)[1].clone();
        let params = json!({
            "fixedEntity": DEFAULT_ENTITY,
            "entityCurrencies": {DEFAULT_ENTITY: "CNY"}
        });
        assert_eq!(
            currency_for(&row, &mapping, "库存现金", &params),
            "CNY",
            "JE 币种空白必须按主体本位币处理"
        );
    }

    #[test]
    fn 噪声行不参与向下填充() {
        // 借款利息踩过的坑在汇兑同样存在：合计行本无身份，照常向下填充会
        // 继承上一行的科目/凭证混进发生额；它自己写在摘要列的「合计」也
        // 不能传播给下一个空行。有凭证号的合并单元格行照常填充。
        let table = Arc::new(FxTable {
            path: PathBuf::new(),
            sheet: "JE".into(),
            sheets: vec!["JE".into()],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![vec![
                "凭证号".into(),
                "科目".into(),
                "摘要".into(),
                "金额".into(),
            ]],
            headers: vec!["凭证号".into(), "科目".into(), "摘要".into(), "金额".into()],
            rows: vec![
                vec![
                    "JE-1".into(),
                    "银行存款".into(),
                    "提现".into(),
                    "100".into(),
                ],
                vec!["JE-1".into(), "".into(), "".into(), "200".into()],
                vec!["".into(), "".into(), "".into(), "300".into()],
                vec!["".into(), "".into(), "合计".into(), "400".into()],
                vec!["JE-2".into(), "".into(), "".into(), "50".into()],
            ],
            row_count: 5,
            header_candidates: vec![],
            sampled: false,
        });
        let mapping = json!({
            "id": "凭证号",
            "accountName": "科目",
            "summary": "摘要",
            "functionalAmount": "金额"
        })
        .as_object()
        .unwrap()
        .clone();
        let filled = forward_filled_je_table(&table, &mapping);
        // 合并单元格形态：有凭证号即有身份，照常填。
        assert_eq!(filled.rows[1], vec!["JE-1", "银行存款", "提现", "200"]);
        // 两行合计形态：不接收填充，原样保留。
        assert_eq!(filled.rows[2], vec!["", "", "", "300"]);
        assert_eq!(filled.rows[3], vec!["", "", "合计", "400"]);
        // 合计行之后的新分录照常填，且摘要来自 JE-1 行的「提现」，
        // 不是上一行合计行写在摘要里的「合计」——噪声行不向外传播。
        assert_eq!(filled.rows[4], vec!["JE-2", "银行存款", "提现", "50"]);
    }

    #[test]
    fn 正表规模压过审计人自建的透视副本() {
        // 02 号样例：25 万行的序时账正表，同一文件里还有一张 384 行的
        // `透视check`——它右半边整块粘着科目余额表副本，表头就是标准 TB
        // 表头，分数比 SAP 那 68 列的正表还高。规模必须能翻盘。
        let 正表 = ledger_mapping::sheet_score(0.72, 251_600, "Sheet1");
        let 透视 = ledger_mapping::sheet_score(0.86, 384, "透视check");
        assert!(正表 > 透视, "正表 {正表} 应当压过透视副本 {透视}");
        // 04 号样例的透视表就叫 `Sheet2`，名字上看不出来，只能靠规模翻盘：
        // 两个数量级的行数差要压得住 0.14 的表头分劣势。
        assert!(
            ledger_mapping::sheet_score(0.72, 164_421, "Sheet1")
                > ledger_mapping::sheet_score(0.86, 582, "Sheet2")
        );
        // 10 号样例反过来：`EY 修改` 与正表行数只差一行，这时靠表名降权分开。
        assert!(
            ledger_mapping::sheet_score(0.80, 539, "Sheet1")
                > ledger_mapping::sheet_score(0.80, 540, "EY 修改")
        );
    }

    #[test]
    fn detects_grouped_tb_header_as_two_rows() {
        let rows = vec![
            vec!["科目余额表".into()],
            vec![
                "科目编码".into(),
                "科目名称".into(),
                "期初余额".into(),
                "".into(),
                "本期发生".into(),
                "".into(),
                "期末余额".into(),
                "".into(),
            ],
            vec![
                "".into(),
                "".into(),
                "借方".into(),
                "贷方".into(),
                "借方".into(),
                "贷方".into(),
                "借方".into(),
                "贷方".into(),
            ],
            vec![
                "1002".into(),
                "银行存款".into(),
                "100".into(),
                "".into(),
                "10".into(),
                "2".into(),
                "108".into(),
                "".into(),
            ],
        ];
        let (row, depth, _) = infer_header_layout(&rows);
        assert_eq!((row, depth), (2, 2));
        let headers = merge_headers(&rows[1..=2], 8);
        assert_eq!(headers[2], "期初余额-借方");
        assert_eq!(headers[7], "期末余额-贷方");
    }

    /// 只有一格有字的上一行是标题行，不是分组表头：合并它会把标题冠到每一列头上
    /// （「序时账-公司代码」），既污染映射标签，也和看账那侧的单行读取对不上。
    #[test]
    fn title_line_above_headers_is_not_merged_into_them() {
        let rows = vec![
            vec!["序时账".into()],
            vec![
                "公司代码".into(),
                "记账日期".into(),
                "凭证号".into(),
                "科目编码".into(),
                "科目名称".into(),
                "本位币金额".into(),
            ],
            vec![
                "A".into(),
                "2025-01-01".into(),
                "001".into(),
                "1601".into(),
                "固定资产".into(),
                "100".into(),
            ],
        ];
        let (row, depth, _) = infer_header_layout(&rows);
        assert_eq!((row, depth), (2, 1));
    }

    /// `rate()` 用 `response_hash` 作键缓存汇率索引（全局，跨用例存活）。
    /// 测试快照若共用同一个哈希——比如都留空字符串——先跑的用例就会把自己的
    /// 汇率表留给后跑的用例：既会让本该查到汇率的用例报「汇率缺失」，
    /// 也会让本该报缺失的用例静悄悄通过。每份测试快照都要有自己的哈希。
    fn test_snapshot_hash(case: &str) -> String {
        format!("test-snapshot-{case}")
    }

    #[test]
    fn month_opening_rate_matches_month_end_revaluation_point() {
        // 已实现的月初牌价与未实现的月末重估必须取同一个牌价点：
        // 2月凭证的月初牌价 = 1月31日点 = 1月月末重估牌价。
        // 跨口径不一致会让「已实现＋各月未实现」的年度勾稽天然对不上。
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("month_opening_consistency"),
            start_date: "2025-01-01".into(),
            end_date: "2025-02-28".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-30".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-02-14".into(),
                    published_date: "2025-02-14".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.25,
                },
                RatePoint {
                    requested_date: "2025-02-14".into(),
                    published_date: "2025-02-14".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let feb_voucher = NaiveDate::from_ymd_opt(2025, 2, 14).unwrap();
        let (opening, published, fallback) =
            month_opening_rate(&snapshot, feb_voucher, "USD", "CNY").unwrap();
        assert!(
            (opening - 7.1).abs() < 1e-9,
            "月初牌价应取1月31日点：{opening}"
        );
        assert_eq!(published, "2025-01-30");
        assert!(!fallback);
        let month_end = NaiveDate::from_ymd_opt(2025, 1, 31).unwrap();
        let (reval, _) = rate(&snapshot, month_end, "USD", "CNY").unwrap();
        assert!(
            (opening - reval).abs() < 1e-12,
            "月初牌价({opening})与上月末重估牌价({reval})必须同点"
        );
    }

    #[test]
    fn month_opening_rate_falls_back_to_earliest_in_month_with_disclosure() {
        // 上月末与月内更早日期都没有牌价点时，回退当月最早牌价并标记，
        // 供测算结果披露口径差异；当月内完全没有点则返回 None 隔离。
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("month_opening_fallback"),
            start_date: "2025-01-01".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2025-01-05".into(),
                    published_date: "2025-01-05".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.05,
                },
                RatePoint {
                    requested_date: "2025-01-05".into(),
                    published_date: "2025-01-05".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let voucher_date = NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        let (opening, _, fallback) =
            month_opening_rate(&snapshot, voucher_date, "USD", "CNY").unwrap();
        assert!((opening - 7.05).abs() < 1e-9);
        assert!(fallback, "当月最早牌价回退必须带标记");
        // CNY 之外没有牌价点的币种（EUR）→ None，由调用方隔离该腿。
        assert!(month_opening_rate(&snapshot, voucher_date, "EUR", "CNY").is_none());
    }

    #[test]
    fn voucher_pattern_groups_identical_debit_and_credit_accounts() {
        let mapping = json!({"account":["科目"],"functionalAmount":"金额"})
            .as_object()
            .unwrap()
            .clone();
        let row = |account: &'static str, amount: &'static str| {
            test_row_record(&[("科目", account), ("金额", amount)])
        };
        let first = vec![row("1001 银行存款", "100"), row("1122 应收账款", "-100")];
        let second = vec![row("1122 应收账款", "-80"), row("1001 银行存款", "80")];
        let a = voucher_account_pattern(&first, &mapping);
        let b = voucher_account_pattern(&second, &mapping);
        assert_eq!(a.0, b.0);
        assert_eq!(a.2, vec!["1001"]);
        assert_eq!(a.3, vec!["1122"]);
        assert_eq!(
            manual_classification(
                &json!({"manualClassifications":{"V1":"已实现汇兑损益"}}),
                "V1"
            ),
            Some("已实现汇兑损益")
        );
    }

    #[test]
    fn manual_realized_classification_reruns_settlement_measurement() {
        let root = std::env::temp_dir().join(format!("fx-manual-realized-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-02,1,AB,1122,核销应收款,USD,-100,-710\n\
E,2025-01-02,1,AB,1002,收到银行款,USD,100,700\n\
E,2025-01-02,1,AB,6603,账面汇兑损益,CNY,0,999\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E",
            "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1122":"monetary_asset","1002":"cash","6603":"fx_gain_loss"},
            "manualClassifications":{"E-2025-01-02-1":"已实现汇兑损益"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash(
                "manual_realized_classification_reruns_settlement_measurement",
            ),
            start_date: "2025-01-02".into(),
            end_date: "2025-01-02".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.15,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot, None).unwrap();
        assert_eq!(calculation.len(), 1, "quality={quality:#?}");
        assert_eq!(classes[0]["classification"], "已实现");
        assert_eq!(
            calculation[0]["calculationMethod"],
            "终止确认：月初牌价与交易日官方牌价独立重算"
        );
        assert!((calculation[0]["officialRate"].as_f64().unwrap() - 7.2).abs() < 0.0001);
        assert!((calculation[0]["customerAppliedRate"].as_f64().unwrap() - 7.0).abs() < 0.0001);
        // 账面＝100×月初牌价7.15＝715；折算＝100×记账日牌价7.2＝720；
        // 资产减少方向 → 损益 = 715 − 720 = −5，完全独立于客户JE本位币710。
        assert!((calculation[0]["monthOpeningRate"].as_f64().unwrap() - 7.15).abs() < 0.0001);
        assert!((calculation[0]["auditGainLoss"].as_f64().unwrap() + 5.0).abs() < 0.01);
        assert_ne!(
            calculation[0]["auditGainLoss"].as_f64().unwrap(),
            999.0,
            "人工分类不得把账面汇兑损益直接当作审计测算结果"
        );
        let mut repeated_params = params.clone();
        repeated_params["mode"] = json!("realized");
        repeated_params["reportStart"] = json!("2025-01-01");
        repeated_params["reportEnd"] = json!("2025-01-02");
        repeated_params["rateSnapshot"] = json!(snapshot);
        repeated_params["translateTbAccountNames"] = json!(true);
        let cancel = AtomicBool::new(false);
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let first = calculate(&repeated_params, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        let second = calculate(&repeated_params, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        assert_eq!(first["summary"], second["summary"]);
        assert!(
            second["summary"]["auditFxGainLoss"].as_f64().unwrap().abs() > 0.005,
            "连续第二次测算不得异常归零：{:#}",
            second["summary"]
        );

        let preview = run_job(
            "fx.preview",
            repeated_params.clone(),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &pause,
        )
        .unwrap();
        let token = preview["previewToken"].as_str().unwrap().to_owned();
        let output = root.join("cached-export.xlsx");
        let mut export_params = repeated_params.clone();
        export_params["previewToken"] = json!(token);
        export_params["outputPath"] = json!(output);
        let export_messages = Arc::new(Mutex::new(Vec::<String>::new()));
        let captured = Arc::clone(&export_messages);
        run_job(
            "fx.export",
            export_params,
            &move |_, _, _, message| captured.lock().unwrap().push(message.to_owned()),
            Arc::new(AtomicBool::new(false)),
            &pause,
        )
        .unwrap();
        assert!(output.is_file());
        assert!(
            export_messages
                .lock()
                .unwrap()
                .iter()
                .any(|message| message.contains("复用已完成的测算预览结果")),
            "生成底稿应复用仍有效的预览结果"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_payment_with_multiple_settlement_targets_measures_each_row() {
        let root = std::env::temp_dir().join(format!("fx-batch-payment-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-02,1,DZ,2202,批量付款,USD,10000,71000\n\
E,2025-01-02,1,DZ,2202,批量付款,USD,20000,143000\n\
E,2025-01-02,1,DZ,2202,批量付款,USD,5000,36250\n\
E,2025-01-02,1,DZ,1002,银行付款,USD,-35000,-251300\n\
E,2025-01-02,1,DZ,6603,汇兑损失,CNY,0,1050\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E",
            "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"2202":"monetary_liability","1002":"cash","6603":"fx_gain_loss"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("batch_payment_measures_each_row"),
            start_date: "2025-01-02".into(),
            end_date: "2025-01-02".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, _quality) =
            calculate_realized(&params, &snapshot, None).unwrap();
        // 一张凭证结清三张发票：逐条终止确认行重算，有几条算几条，
        // 不再因「终止确认行不恰好一条」整张推进待复核。
        assert_eq!(
            calculation.len(),
            3,
            "应逐条重算三条终止确认行：{calculation:#?}"
        );
        assert_eq!(classes[0]["classification"], "已实现");
        let total: f64 = calculation
            .iter()
            .map(|row| row["auditGainLoss"].as_f64().unwrap())
            .sum();
        // 负债减少方向：各腿损益＝原币×(记账日7.2−月初7.1)＝0.1×原币，
        // 10000→1000、20000→2000、5000→500，合计 3500；
        // 客户三条腿各自隐含的入账汇率（7.10/7.15/7.25）不参与测算。
        assert!(
            (total - 3500.0).abs() < 0.01,
            "审计合计应为 1000+2000+500=3500，实际 {total}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn currency_conversion_between_cash_legs_is_realized_and_measured() {
        let root = std::env::temp_dir().join(format!("fx-conversion-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-02,2,AB,1002,结汇,USD,-100000,-715000\n\
E,2025-01-02,2,AB,1002,结汇,CNY,0,718000\n\
E,2025-01-02,2,AB,6603,汇兑收益,CNY,0,-3000\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E",
            "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","6603":"fx_gain_loss"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("currency_conversion_measured"),
            start_date: "2025-01-02".into(),
            end_date: "2025-01-02".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.15,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-02".into(),
                    published_date: "2025-01-02".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, _quality) =
            calculate_realized(&params, &snapshot, None).unwrap();
        // 外币兑换：外币现金与本位币现金对转。成交价口径（用户拍板成交价差
        // 属已实现损益）：成交价＝本位币现金腿÷外币现金腿＝718000÷100000
        // ＝7.18；账面＝100000×月初牌价7.15＝715000；资产减少方向损益＝
        // 715000−718000＝−3,000——与客户按实际牌价入账的汇兑收益一致。
        // 官方牌价 7.2 仅作对照（若按官方口径会算出 −5,000）。
        assert_eq!(calculation.len(), 1, "{calculation:#?}");
        assert_eq!(classes[0]["classification"], "已实现");
        assert_eq!(
            calculation[0]["calculationMethod"],
            "外币兑换：月初牌价与实际成交价重算（官方牌价对照）"
        );
        assert!((calculation[0]["monthOpeningRate"].as_f64().unwrap() - 7.15).abs() < 0.0001);
        assert!((calculation[0]["appliedRate"].as_f64().unwrap() - 7.18).abs() < 0.0001);
        assert!((calculation[0]["officialRate"].as_f64().unwrap() - 7.2).abs() < 0.0001);
        assert!((calculation[0]["auditGainLoss"].as_f64().unwrap() + 3000.0).abs() < 0.01);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structural_classification_overrides_account_names_with_conflict_notice() {
        let root = std::env::temp_dir().join(format!("fx-conflict-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-02,3,FX,2202-应付账款,期末调汇,USD,0,500\n\
E,2025-01-02,3,FX,6701-汇兑收益-已实现,期末调汇,USD,0,-500\n\
E,2025-01-02,4,DZ,1122-应收账款,收款核销,USD,-100,-710\n\
E,2025-01-02,4,DZ,1002-银行存款,收款核销,USD,100,715\n\
E,2025-01-02,4,DZ,6702-汇兑损失-未实现,收款核销,CNY,0,5\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E",
            "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            }
        });
        let bridge = build_review_bridge(&params, &[], &[]).unwrap();
        let controls = bridge["classificationControls"].as_array().unwrap();
        let find = |voucher: &str| {
            controls
                .iter()
                .find(|item| item["voucherId"] == json!(voucher))
                .unwrap_or_else(|| panic!("缺少凭证 {voucher}：{controls:#?}"))
                .clone()
        };
        // 科目名写「已实现」但结构是原币不动、本位币变动的重估 → 判未实现并提示冲突。
        let reval = find("E-2025-01-02-3");
        assert_eq!(reval["classification"], "未实现汇兑损益");
        let conflict = reval["classificationConflict"].as_str().unwrap_or_default();
        assert!(
            conflict.contains("科目名称指向「已实现汇兑损益」"),
            "应提示科目名与结构冲突：{conflict}"
        );
        // 科目名写「未实现」但结构是应收账款原币减少（收款核销）→ 判已实现并提示冲突。
        let settled = find("E-2025-01-02-4");
        assert_eq!(settled["classification"], "已实现汇兑损益");
        let conflict = settled["classificationConflict"]
            .as_str()
            .unwrap_or_default();
        assert!(
            conflict.contains("科目名称指向「未实现汇兑损益」"),
            "应提示科目名与结构冲突：{conflict}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_unrealized_voucher_is_comparison_evidence_not_measurement_object() {
        let root = std::env::temp_dir().join(format!("fx-unrealized-roll-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-15,N,SA,1122,新增应收,USD,10,71\n\
E,2025-01-31,R,AB,1122,月末重估,USD,0,5\n\
E,2025-01-31,R,AB,6603,月末重估,CNY,0,-5\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1122":"monetary_asset","6603":"fx_gain_loss"},
            "manualClassifications":{"E-2025-01-31-R":"未实现汇兑损益"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash(
                "manual_unrealized_voucher_is_comparison_evidence_not_measurement_object",
            ),
            start_date: "2025-01-01".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let endpoints = vec![json!({
            "entity":"E", "account":"1122 应收账款", "auxiliary":"", "currency":"USD",
            "openingForeign":100.0, "openingAuditFunctional":700.0,
            "closingBookFunctional":776.0
        })];
        let mut quality = Vec::new();
        let rows = calculate_monthly_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            &endpoints,
            &mut quality,
            &[],
            &[json!({
                "voucherId":"E-2025-01-15-N",
                "classification":"已实现"
            })],
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "quality={quality:#?}");
        let row = &rows[0];
        assert_eq!(row["openingForeign"], json!(100.0));
        assert_eq!(row["businessForeignMovement"], json!(10.0));
        assert_eq!(row["closingForeign"], json!(110.0));
        assert_eq!(row["businessFunctionalMovement"], json!(71.0));
        assert_eq!(row["clientRevaluationBalanceAdjustment"], json!(5.0));
        assert_eq!(row["preRevaluationFunctional"], json!(771.0));
        assert_eq!(row["auditClosingFunctional"], json!(792.0));
        assert_eq!(row["unrealizedGainLoss"], json!(-21.0));
        assert_eq!(row["clientBookedUnrealizedGainLoss"], json!(-5.0));
        assert_eq!(row["suggestedAdjustment"], json!(-16.0));
        assert_eq!(
            row["clientRevaluationVoucherIds"],
            json!(["E-2025-01-31-R"])
        );
        assert!(
            row.get("voucherId").is_none(),
            "账户级测算不得伪装成凭证级测算"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 已实现腿在余额滚动中按月初牌价入账并披露基础差异() {
        // 结汇 100 美元：客户按成交价 7.1907 入账 −719.07；审计口径出账
        // = 100×月初牌价 7.15 = −715。滚动发生额取审计口径，月末重估 =
        // (7150−715) − 900×7.10 = 6435−6390 = +45（客户账面口径会算出
        // 6430.93−6390 = 40.93，把已实现与价差混进未实现残差）。
        // 账面−审计的 −4.07 单独披露在「已实现腿入账基础差异」。
        let root = std::env::temp_dir().join(format!("fx-audit-basis-roll-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-10,1,记,1002,结汇,USD,-100,-719.07\n\
E,2025-01-10,1,记,1001,结汇,CNY,0,719.07\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","1001":"cash"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("已实现腿在余额滚动中按月初牌价入账并披露基础差异"),
            start_date: "2024-12-31".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.15,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.10,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let endpoints = vec![json!({
            "entity":"E", "account":"1002 银行存款-美元户", "auxiliary":"", "currency":"USD",
            "openingForeign":1000.0, "openingAuditFunctional":7150.0,
            "closingBookFunctional":6430.93
        })];
        let realized = vec![json!({
            "voucherId":"E-2025-01-10-1", "sourceRow":2,
            "targetForeignSigned":-100.0, "carryingFunctional":715.0
        })];
        let mut quality = Vec::new();
        let rows = calculate_monthly_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            &endpoints,
            &mut quality,
            &realized,
            &[],
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "quality={quality:#?}");
        let row = &rows[0];
        assert_eq!(row["businessForeignMovement"], json!(-100.0));
        assert_eq!(
            row["businessFunctionalMovement"],
            json!(-715.0),
            "已实现腿的本位币发生额必须按月初牌价入账，不得用客户成交价账面数"
        );
        assert!(
            (row["realizedLegBasisDifference"].as_f64().unwrap() + 4.07).abs() < 0.001,
            "入账基础差异 = 账面(−719.07) − 审计(−715) = −4.07，实际 {:?}",
            row["realizedLegBasisDifference"]
        );
        assert_eq!(row["preRevaluationFunctional"], json!(6435.0));
        assert_eq!(row["auditClosingFunctional"], json!(6390.0));
        assert_eq!(row["unrealizedGainLoss"], json!(45.0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 结构满足即认领未实现_科目名一致时不提示冲突() {
        // 口径沿革（三次演进，都有用户实测背景）：
        // 1) 最初界面认科目名、引擎只认摘要/类型，两边口径打架——同一张凭证
        //    界面显示「未实现」、却被计入「待确认或无法测算」；
        // 2) 于是改成两边都认科目名；
        // 3) 用户复核后拍板：科目名是客户自己的口径，不能当审计定性依据，
        //    降级为交叉验证；未实现定性只看结构证据。此后再放宽一步：
        //    结构=原币不动+本位币变动即定性为重估，重估类型/文字证据
        //    不再是门槛，只在质量提示里提醒抽查（另有专项测试覆盖）。
        // 本测试刻意**不设** accountRoles 与 manualClassifications：
        // 前者仍隐式验证「汇兑损失」能靠关键词判成 fx_gain_loss，
        // 后者验证摘要不写重估、类型也不是 FX/AB 时，结构满足即认领，
        // 科目名与结构方向一致时不再提示冲突。
        let root = std::env::temp_dir().join(format!("fx-name-signal-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-31,V001,SA,2202 应付账款-关联方-集团内-外币评估调整,INV-20250131,USD,0,-20\n\
E,2025-01-31,V001,SA,6701120001 财务费用-汇兑损失-未实现,INV-20250131,CNY,0,20\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            }
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("结构满足即认领未实现_科目名一致时不提示冲突"),
            start_date: "2025-01-01".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let endpoints = vec![json!({
            "entity":"E", "account":"2202 应付账款-关联方-集团内-外币评估调整",
            "auxiliary":"", "currency":"USD",
            "openingForeign":-100.0, "openingAuditFunctional":-700.0,
            "closingBookFunctional":-720.0
        })];
        let mut quality = Vec::new();
        let rows = calculate_monthly_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            &endpoints,
            &mut quality,
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "quality={quality:#?}");
        let row = &rows[0];
        // 结构满足（原币不动+本位币变动），即使摘要不写重估、类型是 SA，
        // 也认领为客户重估凭证：本位币变动从正常业务发生额转入重估调整。
        assert_eq!(
            row["clientRevaluationVoucherIds"],
            json!(["E-2025-01-31-V001"]),
            "{row}"
        );
        assert_eq!(row["businessFunctionalMovement"], json!(0.0), "{row}");
        assert_eq!(
            row["clientRevaluationBalanceAdjustment"],
            json!(-20.0),
            "{row}"
        );
        assert_eq!(row["clientBookedUnrealizedGainLoss"], json!(20.0), "{row}");
        let details = row["clientRevaluationDetails"].as_array().unwrap();
        assert_eq!(details.len(), 1, "{row}");
        assert_eq!(details[0]["voucherId"], json!("E-2025-01-31-V001"));
        assert_eq!(
            details[0]["identificationBasis"],
            json!("系统按完整凭证识别为未实现汇兑损益或其冲回凭证")
        );
        let mut reused_quality = Vec::new();
        let reused = calculate_monthly_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            &endpoints,
            &mut reused_quality,
            &[],
            &[json!({
                "voucherId":"E-2025-01-31-V001",
                "classification":"未实现"
            })],
        )
        .unwrap();
        assert_eq!(reused, rows, "复用上一阶段分类不得改变未实现测算结果");
        // 界面侧同口径：结构满足即判未实现；科目名方向一致，不再提示冲突。
        let bridge = build_review_bridge(&params, &[], &[]).unwrap();
        let controls = bridge["classificationControls"].as_array().unwrap();
        let item = controls
            .iter()
            .find(|item| item["voucherId"] == json!("E-2025-01-31-V001"))
            .unwrap_or_else(|| panic!("缺少凭证：{controls:#?}"));
        assert_eq!(item["classification"], "未实现汇兑损益");
        assert!(
            item["classificationConflict"].is_null(),
            "名称与结构方向一致时不应提示冲突：{item}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 损益类科目整表用同一个取数口径() {
        // 逐科目各判各的会让一张表里混着两种口径，各科目的数不可比。
        // 规则：整表有余额就都取余额；余额全为零（已结转）才都走发生额。
        let root = std::env::temp_dir().join(format!("fx-basis-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();

        // 甲：未结转，余额非零——两个科目都该取余额，不许其中一个改走发生额。
        let tb1 = root.join("tb1.csv");
        fs::write(
            &tb1,
            "公司,科目,币种,期末本位币,本期借方,本期贷方
             E,6701090001 财务费用-汇兑收益-未实现,USD,3882018.16,76071645.13,72189626.97
             E,6701120001 财务费用-汇兑损失-未实现,USD,-31169.71,920973.76,952143.47
",
        )
        .unwrap();
        let mapping = json!({
            "entity":"公司","account":["科目"],"currency":"币种",
            "closingFunctionalAmount":"期末本位币",
            "periodFunctionalDebit":"本期借方","periodFunctionalCredit":"本期贷方"
        });
        let params = json!({
            "tbSource":{"inputPath":tb1,"sheet":"","headerRow":1,"headerDepth":1},
            "tbMapping":mapping,
            "accountRoles":{"6701090001 财务费用-汇兑收益-未实现":"fx_gain_loss",
                            "6701120001 财务费用-汇兑损失-未实现":"fx_gain_loss"}
        });
        let out = reconcile_fx_gain_loss(&params).expect("应当能取数");
        let rows = out["tbRows"].as_array().expect("有明细行");
        assert!(
            rows.iter().all(|r| r["basis"] == json!("期末余额")),
            "{rows:?}"
        );
        // 3882018.16 + (−31169.71) = 3850848.45
        assert!(
            (out["tbFxGainLoss"].as_f64().unwrap_or(0.0) - 3850848.45).abs() < 0.01,
            "{out}"
        );

        // 乙：已结转，余额全为零——整表都该退到发生额。
        let tb2 = root.join("tb2.csv");
        fs::write(
            &tb2,
            "公司,科目,币种,期末本位币,本期借方,本期贷方
             E,6701090001 财务费用-汇兑收益-未实现,USD,0,76071645.13,72189626.97
             E,6701120001 财务费用-汇兑损失-未实现,USD,0,920973.76,952143.47
",
        )
        .unwrap();
        let params2 = json!({
            "tbSource":{"inputPath":tb2,"sheet":"","headerRow":1,"headerDepth":1},
            "tbMapping":mapping,
            "accountRoles":{"6701090001 财务费用-汇兑收益-未实现":"fx_gain_loss",
                            "6701120001 财务费用-汇兑损失-未实现":"fx_gain_loss"}
        });
        let out2 = reconcile_fx_gain_loss(&params2).expect("应当能取数");
        let rows2 = out2["tbRows"].as_array().expect("有明细行");
        assert!(
            rows2.iter().all(|r| r["basis"] == json!("本期借贷发生额")),
            "{rows2:?}"
        );
        assert!(
            (out2["tbFxGainLoss"].as_f64().unwrap_or(0.0) - 3850848.45).abs() < 0.01,
            "{out2}"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 汇兑损失科目必须判成汇兑损益而不是非货币性项目() {
        // 实测踩坑：关键词表里只有「汇兑损益／汇兑收益／汇兑差额」，漏了同样常见的
        // **汇兑损失**。「汇兑损失」不含「汇兑损益」（第四字不同），于是掉到按科目
        // 代码判，6701 落进 5001..=6999 的损益类 → 判成非货币性项目。
        //
        // 后果不是少认一个科目那么轻：`has_non_monetary` 被置真，整张凭证被打上
        // 「非货币性项目/异常复核」而无法自动测算；同时 `booked` 只累加了汇兑收益
        // 那一侧，账面金额也算少。某公司实测 359 张凭证、385 万账面汇兑损益全部落空，
        // 差异率 123.68%。
        for name in [
            "6701090001 财务费用-汇兑收益-未实现",
            "6701120001 财务费用-汇兑损失-未实现",
            "6701120002 财务费用-汇兑损失-已实现",
            "财务费用-汇兑损益",
            "财务费用-汇兑差额",
            "财务费用-汇兑差异",
            "财务费用-汇兑净损失",
            "财务费用-汇兑净收益",
            "Financial expense - Exchange difference",
        ] {
            assert_eq!(suggest_account_role(name), "fx_gain_loss", "{name}");
        }
        // 外币评估调整这类过渡科目仍按其本身的货币性判定，不受词根影响。
        assert_eq!(
            suggest_account_role("2241170003 其他应付款-第三方-外币评估调整"),
            "monetary_liability"
        );
        assert_eq!(
            suggest_account_role("2202010002 应付账款-关联方-集团内-外币评估调整"),
            "monetary_liability"
        );
        // 词根不能宽到把普通财务费用也吃进来。
        assert_ne!(
            suggest_account_role("6701010001 财务费用-利息支出"),
            "fx_gain_loss"
        );
        // 资产负债编码下的「xx-汇兑损益」是挂在外币往来科目上的汇兑调整子目
        // （05 号 TBJEPBC 样例），不是账面汇兑损益本体：认进来既撑大勾稽基准，
        // 又让这几户跳过货币性重估。它们应归回往来科目的货币性类别。
        assert_eq!(
            suggest_account_role("1122010900 应收账款-一般应收账款-汇兑损益"),
            "monetary_asset"
        );
        assert_eq!(
            suggest_account_role("2202190000 应付账款-汇兑损益"),
            "monetary_liability"
        );
        assert_eq!(
            suggest_account_role("1123090900 预付账款-其他-汇兑损益"),
            "non_monetary"
        );
        // 编码缺失或字母开头（自定义/SAP）时没有资产负债证据，词根优先保持不变。
        assert_eq!(suggest_account_role("FX 汇兑损益"), "fx_gain_loss");
    }

    /// 与存款利息同一口径的回归：界面科目清单包含非末级汇总行而测算只读
    /// 末级。自动识别只剩低置信兜底（词典与编码都没实质命中）时，末级
    /// 继承用户在上级科目上的手工分类；有实质结论的科目不被上级覆盖。
    #[test]
    fn 上级科目的手工分类由末级在自动识别拿不准时继承() {
        let loose = json!({
            "accountRoles": {"1901 某往来": "monetary_asset"},
            // __tbAccountNames 按 TB 行建立编码→名称，汇总行与末级行都在。
            "__tbAccountNames": {"1901": "某往来", "19010999": "某往来"}
        });
        // 1901 落在「未识别的资产类编码，保守归为非货币性」（0.58 兜底），
        // 用户在汇总行 1901 上指定的角色应落到末级 19010999。
        assert_eq!(role_for("19010999 某往来-明细", &loose), "monetary_asset");
        // 同码不同拼法（编码回退此前已有，顺带锁住不回退）。
        assert_eq!(role_for("19010999 另一种拼法", &loose), "monetary_asset");
        // 自动识别给出过实质结论的科目不被上级指定覆盖：
        // 1401..=1471 命中存货编码（0.94 non_monetary）。
        let strict = json!({
            "accountRoles": {"1405 某存货": "monetary_asset"},
            "__tbAccountNames": {"1405": "某存货"}
        });
        assert_eq!(role_for("140501 某存货-明细", &strict), "non_monetary");
        // 上级键与末级编码没有前缀关系时不继承（1901 不是 140501 的前缀）。
        assert_eq!(role_for("140501 某存货-明细", &loose), "non_monetary");
    }

    #[test]
    fn 科目词典归入五个主类别且待确认只是状态() {
        let cases = [
            ("1003010003 货币资金-其他货币资金-美元", "monetary_asset"),
            ("1123010001 预付账款-供应商", "non_monetary"),
            ("2203010001 预收账款-客户", "non_monetary"),
            (
                "2602030002 租赁负债-未确认融资费用-外币",
                "monetary_liability",
            ),
            ("6703010001 信用减值损失-应收账款", "other_pnl"),
            ("6701070001 财务费用-汇兑收益-已实现", "fx_gain_loss"),
            ("6701100001 财务费用-汇兑损失-已实现", "fx_gain_loss"),
            // 用户实测误判项：营业成本明细不得因旧分类缓存落入汇兑损益。
            ("6401011101 营业成本-芯片-发票校验与收货差异", "other_pnl"),
            ("6401010001 营业成本-产品质量保证金", "other_pnl"),
            ("2241120001 其他应付款-销售保证金", "monetary_liability"),
            ("2252010001 其他流动负债-质量保证金", "non_monetary"),
            ("152300 L/T Rec.-Other", "monetary_asset"),
            ("709001 Bad Debts", "other_pnl"),
            ("709002 Bank Service Charges", "other_pnl"),
            ("601999 FX Transl COGS", "other_pnl"),
            ("261000 Def Inc Taxes - For", "non_monetary"),
            ("5301000141 无形资产摊销-研发软件", "other_pnl"),
        ];
        for (account, expected) in cases {
            assert_eq!(suggest_account_role(account), expected, "{account}");
        }
        assert_eq!(
            suggest_account_role_detail("1003010003 其他货币资金").subtype,
            Some("cash")
        );
        let ambiguous = suggest_account_role_detail("1101000001 交易性金融资产");
        assert_eq!(ambiguous.role, "non_monetary");
        assert!(ambiguous.needs_confirmation);
        assert_ne!(ambiguous.role, "review");
        assert_ne!(ambiguous.role, "unassigned");
        assert!(is_summary_account("资产小计"));
        assert!(!is_summary_account("1001 库存现金"));
    }

    #[test]
    fn 科目名称写明已实现未实现时不再要人逐张点() {
        // 全部取自 4800 的真实科目名。此前这些凭证一律落到「待确认」，
        // 7600 万的未实现评估调整因此排除在测算之外。
        assert_eq!(
            classify_by_account_names(["财务费用-汇兑收益-未实现", "财务费用-汇兑损失-未实现"]),
            Some("未实现汇兑损益")
        );
        assert_eq!(
            classify_by_account_names(["财务费用-汇兑收益-已实现-其他"]),
            Some("已实现汇兑损益")
        );
        assert_eq!(
            classify_by_account_names([r"财务费用-汇兑损失-已实现-银行存款\现金"]),
            Some("已实现汇兑损益")
        );
        // 繁体同样认。
        assert_eq!(
            classify_by_account_names(["財務費用-匯兌收益-未實現"]),
            Some("未实现汇兑损益")
        );
        // 名称里没写的，保持「待确认」交给人判断，不猜。
        assert_eq!(classify_by_account_names(["财务费用-汇兑损益"]), None);
        assert_eq!(classify_by_account_names([]), None);
        // 一张凭证里两种字样都出现时也不猜。
        assert_eq!(
            classify_by_account_names([
                "财务费用-汇兑收益-未实现",
                "财务费用-汇兑损失-已实现-其他"
            ]),
            None
        );
    }

    #[test]
    fn 单凭证资金净额对货币性项目判已实现_其余净零差额判未实现() {
        let root =
            std::env::temp_dir().join(format!("fx-voucher-structure-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,原币,本位币\n\
E,2025-01-15,R1,1002,USD,100,710\n\
E,2025-01-15,R1,1122,USD,-100,-700\n\
E,2025-01-16,R2,1002-USD,USD,100,710\n\
E,2025-01-16,R2,1002-CNY,CNY,0,-710\n\
E,2025-01-17,U1,1122,USD,100,700\n\
E,2025-01-17,U1,1122,USD,-100,-720\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],
                "account":["科目"],"currency":"币种","foreignAmount":"原币",
                "functionalAmount":"本位币"},
            "accountRoles":{"1002":"cash","1002-USD":"cash","1002-CNY":"cash",
                "1122":"monetary_asset"}
        });
        let (table, mapping) = load_mapped_je_table(&params).unwrap();
        let mut groups = BTreeMap::<String, Vec<RowRecord>>::new();
        for row in records(&table) {
            groups
                .entry(voucher_id(&row, &mapping, &params))
                .or_default()
                .push(row);
        }

        let r1 = groups
            .values()
            .find(|rows| cell(&rows[0], &mapping, "id") == "R1")
            .unwrap();
        let r1_structure = voucher_fx_structure(r1.iter(), &mapping, &params).unwrap();
        assert!(r1_structure.realized);
        assert!(!r1_structure.unrealized);

        let r2 = groups
            .values()
            .find(|rows| cell(&rows[0], &mapping, "id") == "R2")
            .unwrap();
        let r2_structure = voucher_fx_structure(r2.iter(), &mapping, &params).unwrap();
        assert!(r2_structure.realized, "CNY购入USD也按已实现资金结构处理");

        let u1 = groups
            .values()
            .find(|rows| cell(&rows[0], &mapping, "id") == "U1")
            .unwrap();
        let u1_structure = voucher_fx_structure(u1.iter(), &mapping, &params).unwrap();
        assert!(!u1_structure.realized, "没有货币资金不能判已实现");
        assert!(
            u1_structure.unrealized,
            "原币net为0、本位币net非0应判未实现"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 余额滚动校验必须自己判符号口径() {
        // 实测 4800 踩到的坑：符号口径检测判得对（26314 张凭证投「已带符号」），
        // 但结论只注入了 fx.preview 入口，余额滚动校验是独立入口拿不到，
        // 于是把已经带负号的贷方又乘一次 −1，差异正好是贷方发生额的两倍。
        let root = std::env::temp_dir().join(format!("fx-sign-roll-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        // 本位币金额已带符号（借正贷负），方向列用 SAP 的 S／H 写法。
        // 每张凭证自身净额为 0，是「已带符号」的铁证。
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,借贷,原币,本位币
             E,2025-01-15,J1,1122,USD,S,100,700
             E,2025-01-15,J1,2202,USD,H,-100,-700
             E,2025-02-15,J2,1122,USD,H,-20,-140
             E,2025-02-15,J2,2202,USD,S,20,140
",
        )
        .unwrap();
        // 1122 全年净增 700 − 140 = 560。
        fs::write(
            &tb,
            "公司,科目,币种,期初本位币,期末本位币
E,1122,USD,1000,1560
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","direction":"借贷","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset","2202":"monetary_liability"}
        });
        let ok =
            validate_tb_je_balance_rollforward(&params).expect("已带符号的账不该被再乘一次 −1");
        assert_eq!(ok["performed"], json!(true), "{ok}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 辅助核算两边都映射且对得上时进入匹配键() {
        // TB 与 JE 都按往来单位拆行、且取值一致：细粒度成立，用它匹配更准。
        let root = std::env::temp_dir().join(format!("fx-aux-fine-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,往来单位,原币,本位币
             E,2025-01-15,J1,1122,USD,甲,10,50
             E,2025-02-15,J2,1122,USD,乙,6,30
",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司,科目,币种,往来单位,期初本位币,期末本位币
             E,1122,USD,甲,400,450
E,1122,USD,乙,300,330
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","auxiliary":["往来单位"],"foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","auxiliary":["往来单位"],"openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset"}
        });
        let ok = validate_tb_je_balance_rollforward(&params).expect("细粒度应当勾稽得上");
        assert_eq!(
            ok["auxiliaryInKey"],
            json!(true),
            "两边都有且对得上，应进入键"
        );
        assert_eq!(
            ok["checkedBalanceKeys"],
            json!(2),
            "应按两个往来单位分别校验"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 辅助核算对不上时自动退回公司加科目() {
        // JE 按往来单位拆行，TB 也有这一列但写法不同（甲 ／ 供应商甲）。
        // 细粒度会全盘失配，必须退回粗粒度——这正是「能匹配上才算数」。
        let root = std::env::temp_dir().join(format!("fx-aux-fallback-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,往来单位,原币,本位币
             E,2025-01-15,J1,1122,USD,甲,10,50
             E,2025-02-15,J2,1122,USD,乙,6,30
",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司,科目,币种,往来单位,期初本位币,期末本位币
             E,1122,USD,供应商甲,400,450
E,1122,USD,供应商乙,300,330
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","auxiliary":["往来单位"],"foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","auxiliary":["往来单位"],"openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset"}
        });
        let ok = validate_tb_je_balance_rollforward(&params).expect("退回粗粒度后应当勾稽得上");
        assert_eq!(ok["auxiliaryInKey"], json!(false), "对不上就该退回");
        assert_eq!(ok["checkedBalanceKeys"], json!(1), "退回后合并为一个科目键");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 匹配键只认公司与科目编码() {
        // TB 与 JE 同一编码的科目名称写法常常不同——实测 4800 的 1002010017：
        // TB 记「货币资金-银行存款-建设银行」，JE 记「银行存款-建行RMB3250-4800」。
        // 名称拼进键会把同一个科目判成两个，所以以编码为锚点。
        let tb = balance_match_key("4800", "1002010017 货币资金-银行存款-建设银行", "", false);
        let je = balance_match_key("4800", "1002010017 银行存款-建行RMB3250-4800", "", false);
        assert_eq!(tb, je, "同一编码不同名称必须匹配得上");
        // 公司不同不匹配。
        assert_ne!(
            tb,
            balance_match_key("3300", "1002010017 货币资金-银行存款-建设银行", "", false)
        );
        // 编码不同不匹配。
        assert_ne!(
            tb,
            balance_match_key("4800", "1002010018 货币资金-银行存款-建设银行", "", false)
        );
        // 没有编码列时退回用名称当标识，只有名称的账也能对账。
        let only_name = balance_match_key("4800", "银行存款-建设银行", "", false);
        assert_eq!(
            only_name,
            balance_match_key("4800", "银行存款-建设银行", "", false)
        );
        assert_ne!(
            only_name,
            balance_match_key("4800", "银行存款-浦发银行", "", false)
        );
    }

    #[test]
    fn 匹配键归一化科目编码前导零() {
        // 05 号样例的真实场景：同一套账，序时账把科目补零到定长（`0000943100`），
        // 余额表导出时不补（`943100`）。键不去前导零时同一科目被判成两个，
        // 凭空多出一批「只在序时账出现的科目」。
        let tb = balance_match_key("4800", "943100", "", false);
        let je = balance_match_key("4800", "0000943100 银行存款-建行", "", false);
        assert_eq!(tb, je, "补零与不补零的同一编码必须匹配得上");
        // 编码后面带不带名称、两侧空格多不多，都不影响键。
        assert_eq!(tb, balance_match_key("4800", "  943100  ", "", false));
        assert_eq!(tb, balance_match_key("4800", "0000943100", "", false));
        // 全零编码不塌成空段：normalize_account_code 整串皆零时保留原样。
        assert_eq!(normalized_account_match_key("0000"), "0000");
        assert_eq!(
            balance_match_key("4800", "0000", "", false),
            "4800\u{1f}0000"
        );
        // 非补零场景不回归：分段编码、字母编码原样保留；大小写归一照旧。
        assert_eq!(
            balance_match_key("4800", "1002.01", "", false),
            balance_match_key("4800", "1002.01 存放同业", "", false)
        );
        assert_eq!(
            balance_match_key("4800", "A1001", "", false),
            balance_match_key("4800", "a1001", "", false)
        );
        assert_ne!(
            balance_match_key("4800", "1002010017", "", false),
            balance_match_key("4800", "1002010018", "", false)
        );
    }

    #[test]
    fn 序时账补零科目与余额表不补零科目对账() {
        // 键级测试的端到端版本：TB 写 `943100`、JE 写 `0000943100`。
        // 角色覆盖 `accountRoles` 用 TB 的不补零写法登记——归一化后 JE 侧
        // 也能命中同一角色，否则这些行会被货币性项目过滤提前丢掉，
        // 校验空转照样「通过」，测不出匹配修复。
        let root = std::env::temp_dir().join(format!("fx-key-zero-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        // JE 同一科目两行，本位币发生额合计 80。
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,原币,本位币
E,2025-01-15,J1,0000943100,USD,10,50
E,2025-02-15,J2,0000943100,USD,6,30
",
        )
        .unwrap();
        // TB 一行：期初 700 ＋ 发生 80 ＝ 期末 780，应当勾稽通过。
        fs::write(
            &tb,
            "公司,科目,币种,期初本位币,期末本位币
E,943100,USD,700,780
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"943100":"monetary_asset"}
        });
        let ok = validate_tb_je_balance_rollforward(&params)
            .expect("补零与不补零是同一科目，应当勾稽得上");
        assert_eq!(ok["performed"], json!(true), "{ok}");
        assert_eq!(ok["passed"], json!(true), "{ok}");
        assert_eq!(
            ok["checkedBalanceKeys"],
            json!(1),
            "同一科目只应形成一个余额键：{ok}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 辅助核算与币种不参与tbje匹配键() {
        // 复现 4800 的真实场景：TB 没有辅助核算列，JE 按供应商/客户拆成多行。
        // 键里带辅助核算时，TB 的每个余额键都找不到对应的 JE 发生额，
        // 332 个键全部失配、差异等于全年发生额。
        let root = std::env::temp_dir().join(format!("fx-key-aux-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        // 同一科目同一币种，JE 按两个往来单位拆行；合计发生额 80。
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,往来单位,原币,本位币
             E,2025-01-15,J1,1122,USD,供应商甲,10,50
             E,2025-02-15,J2,1122,USD,客户乙,6,30
",
        )
        .unwrap();
        // TB 只有一行，没有往来单位列：期初 700 ＋ 发生 80 ＝ 期末 780，应当勾稽通过。
        fs::write(
            &tb,
            "公司,科目,币种,期初本位币,期末本位币
E,1122,USD,700,780
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","auxiliary":["往来单位"],"foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset"}
        });
        let ok = validate_tb_je_balance_rollforward(&params)
            .expect("辅助核算不进匹配键，两边应当勾稽得上");
        assert_eq!(ok["performed"], json!(true), "{ok}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 本位币口径下多币种余额按科目合并匹配() {
        // 4800 的另一半：TB 把「货币」列判成本位币币种、账户币种要从文本列抽，
        // 而 JE 直接读凭证货币列，同一账户两边算出的币种字符串对不上。
        // 本位币口径下各币种金额都是记账本位币，按科目合并相加即可对上。
        let root = std::env::temp_dir().join(format!("fx-key-ccy-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        // JE：同一科目下 USD 与 EUR 两个币种，本位币发生额合计 80。
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,原币,本位币
             E,2025-01-15,J1,1122,USD,10,50
             E,2025-02-15,J2,1122,EUR,4,30
",
        )
        .unwrap();
        // TB：同一科目两行，期初合计 700、期末合计 780。
        fs::write(
            &tb,
            "公司,科目,币种,期初本位币,期末本位币
             E,1122,USD,500,550
E,1122,EUR,200,230
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset"}
        });
        let ok = validate_tb_je_balance_rollforward(&params)
            .expect("本位币口径下按科目合并应当勾稽得上");
        assert_eq!(ok["performed"], json!(true), "{ok}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tb_je_rollforward_reports_mismatch_without_blocking() {
        let root =
            std::env::temp_dir().join(format!("fx-rollforward-check-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,原币,本位币\nE,2025-01-15,J1,1122,USD,10,71\n",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司,科目,币种,期初本位币,期末本位币\nE,1122,USD,700,780\n",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "fixedEntity":"E","entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],"currency":"币种","openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"1122":"monetary_asset"}
        });
        // 对不上**提示但不阻断**：校验照常返回，差异挂在结论里交给界面展示。
        // 期初 700 ＋ JE 发生 71 ＝ 771，TB 期末写的是 780，差 −9。
        let outcome = validate_tb_je_balance_rollforward(&params).expect("不该中断测算");
        assert_eq!(outcome["passed"], json!(false), "{outcome}");
        assert!(
            outcome["summary"].as_str().unwrap_or("").contains("差异-9"),
            "{outcome}"
        );
        let issues = outcome["issues"].as_array().expect("要带上逐条明细");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["difference"], json!(-9.0));
        assert_eq!(issues[0]["tbClosing"], json!(780.0));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_currency_receipt_with_zero_voucher_net_foreign_is_not_unrealized() {
        let root = std::env::temp_dir().join(format!("fx-dz-receipt-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-15,DZ1,DZ,1002,DIRECT CREDIT,USD,100,710\n\
E,2025-01-15,DZ1,DZ,1122,DIRECT CREDIT,USD,-100,-700\n\
E,2025-01-15,DZ1,DZ,6603,DIRECT CREDIT,CNY,0,-10\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","1122":"monetary_asset","6603":"fx_gain_loss"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash(
                "same_currency_receipt_with_zero_voucher_net_foreign_is_not_unrealized",
            ),
            start_date: "2025-01-01".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-15".into(),
                    published_date: "2025-01-15".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-15".into(),
                    published_date: "2025-01-15".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (realized, classes, quality) = calculate_realized(&params, &snapshot, None).unwrap();
        assert_eq!(realized.len(), 1, "quality={quality:#?}");
        assert_eq!(classes[0]["classification"], "已实现");
        // 资产减少：损益＝原币×(月初7.1−记账日7.2)＝100×(−0.1)＝−10（收益）。
        assert!((realized[0]["auditGainLoss"].as_f64().unwrap() + 10.0).abs() < 0.01);

        let endpoints = vec![
            json!({"entity":"E","account":"1002","auxiliary":"","currency":"USD","openingForeign":0.0,"openingAuditFunctional":0.0,"closingBookFunctional":710.0}),
            json!({"entity":"E","account":"1122","auxiliary":"","currency":"USD","openingForeign":100.0,"openingAuditFunctional":700.0,"closingBookFunctional":0.0}),
        ];
        let mut monthly_quality = Vec::new();
        let monthly = calculate_monthly_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 31).unwrap(),
            &endpoints,
            &mut monthly_quality,
            &realized,
            &[],
        )
        .unwrap();
        assert!(
            monthly
                .iter()
                .all(|row| row["clientRevaluationVoucherIds"] == json!([])),
            "同币种收款原币净额虽为零，也不得识别成未实现汇兑损益类凭证：{monthly:#?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn real_sample_params(output_path: Option<&Path>) -> Value {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let mut params = json!({
            "mode": "combined",
            "reportStart": "2024-01-01",
            "reportEnd": "2024-12-31",
            "fixedEntity": "真实样例公司",
            "entityCurrencies": {"真实样例公司": "CNY"},
            "jeSource": {"inputPath": root.join("序时账-1.xlsx"), "sheet":"UFPrn20250110180715", "headerRow":1, "headerDepth":1},
            "tbSource": {"inputPath": root.join("科目余额表.xls"), "sheet":"UFPrn20250110184259", "headerRow":1, "headerDepth":1},
            "jeMapping": {
                "id":["凭证号数"], "date":"日期", "account":["科目编码","科目名称"],
                "currency":"币种", "summary":"摘要", "foreignAmount":"原币",
                "foreignDirection":"方向", "functionalAmount":"借正贷负"
            },
            "tbMapping": {
                "account":["科目编码","科目名称"],
                "openingFunctionalDebit":"期初余额借方", "openingFunctionalCredit":"期初余额贷方",
                "closingFunctionalDebit":"期末余额借方", "closingFunctionalCredit":"期末余额贷方",
                "periodFunctionalDebit":"本期发生借方", "periodFunctionalCredit":"本期发生贷方"
            }
        });
        if let Some(path) = output_path {
            params["outputPath"] = json!(path);
        }
        params
    }

    #[test]
    #[ignore = "uses the user's immutable 科目余额表/序时账-1 samples"]
    fn real_sample_month_end_fx_transfer_is_auto_classified_and_measured() {
        let mut params = real_sample_params(None);
        let start = NaiveDate::from_ymd_opt(2024, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2024, 12, 31).unwrap();
        let mut rates = Vec::new();
        let mut date = start;
        while date <= end {
            let requested = date.format("%Y-%m-%d").to_string();
            rates.push(RatePoint {
                requested_date: requested.clone(),
                published_date: requested.clone(),
                currency: "CNY".into(),
                cny_per_unit: 1.0,
            });
            rates.push(RatePoint {
                requested_date: requested.clone(),
                published_date: requested,
                currency: "USD".into(),
                cny_per_unit: 7.0 + f64::from(date.ordinal()) / 10_000.0,
            });
            date += Duration::days(1);
        }
        params["rateSnapshot"] = json!(RateSnapshot {
            source: "测试固定汇率".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("real-sample-month-end-fx-transfer"),
            start_date: "2024-01-01".into(),
            end_date: "2024-12-31".into(),
            rates,
            missing: Vec::new(),
        });
        let cancel = AtomicBool::new(false);
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let result = calculate(&params, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        assert_eq!(
            result.pointer("/summary/pendingUnclassifiedCount"),
            Some(&json!(0)),
            "摘要明确为汇兑损益结转的月末重估不应留在待确认：{}",
            result["classificationControls"]
        );
        assert_eq!(
            result["clientRevaluationVouchers"].as_array().map(Vec::len),
            Some(12),
            "全年12个月末重估凭证均应被识别"
        );
        assert!(
            result["summary"]["unrealizedAdjustment"]
                .as_f64()
                .is_some_and(|value| value.abs() >= 0.01),
            "识别客户重估后，审计未实现测算不得继续机械归零：{}",
            result["summary"]
        );
        let blocked = result["tbGranularityBlocked"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        assert!(
            blocked
                .iter()
                .all(|item| { !item["account"].as_str().unwrap_or("").starts_with("1001 ") }),
            "库存现金的 JE 币种为空，应按 CNY 处理，不能继承 USD：{blocked:#?}"
        );
    }

    fn candidate_has(value: &Value, role: &str, column: &str) -> bool {
        value["mappingCandidates"].as_array().is_some_and(|roles| {
            roles.iter().any(|item| {
                item["role"] == role
                    && item["candidates"].as_array().is_some_and(|items| {
                        items.iter().any(|candidate| candidate["column"] == column)
                    })
            })
        })
    }

    #[test]
    fn strict_numeric_never_turns_invalid_into_zero() {
        assert_eq!(strict_number("(1,234.50)").unwrap(), Some(-1234.5));
        assert_eq!(strict_number("123-").unwrap(), Some(-123.0));
        assert!(strict_number("12x").is_err());
        assert_eq!(strict_number("—").unwrap(), None);
    }

    #[test]
    fn preview_cache_key_tracks_inputs_but_ignores_export_outputs() {
        let base = json!({
            "mode":"combined", "reportEnd":"2025-12-31",
            "manualClassifications":{"E-1":"已实现汇兑损益"}
        });
        let mut export = base.clone();
        export["outputPath"] = json!("C:/tmp/workpaper.xlsx");
        export["previewToken"] = json!("old-token");
        export["rateSnapshot"] = json!({"rates":[]});
        export["accountTranslations"] = json!({"1002":"银行存款"});
        assert_eq!(preview_cache_key(&base), preview_cache_key(&export));

        let mut changed = base.clone();
        changed["manualClassifications"]["E-1"] = json!("未实现汇兑损益");
        assert_ne!(preview_cache_key(&base), preview_cache_key(&changed));
    }

    #[test]
    fn preview_cache_survives_worker_process_boundary() {
        let token = preview_cache_key(&json!({
            "test": "跨 worker 预览缓存",
            "process": std::process::id()
        }));
        let path = preview_cache_file(&token).unwrap();
        let _ = fs::remove_file(&path);
        let expected = json!({"previewToken": token, "summary": {"auditFxGainLoss": 12.34}});
        store_preview(token.clone(), expected.clone());
        // 模拟预览 worker 退出：清掉进程内缓存，只允许从磁盘恢复。
        *FX_PREVIEW_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap() = None;
        assert_eq!(cached_preview(&token), Some(expected));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn two_level_headers_are_combined() {
        let raw = vec![
            vec!["期初余额".into(), "".into(), "期末余额".into(), "".into()],
            vec![
                "原币".into(),
                "本位币".into(),
                "原币".into(),
                "本位币".into(),
            ],
        ];
        assert_eq!(
            merge_headers(&raw, 4),
            vec![
                "期初余额-原币",
                "期初余额-本位币",
                "期末余额-原币",
                "期末余额-本位币"
            ]
        );
    }

    #[test]
    fn voucher_key_uses_entity_date_and_all_ids() {
        let mut row = test_row_record(&[
            ("公司", "A"),
            ("日期", "2025-01-02"),
            ("凭证", "9"),
            ("类型", "记"),
        ]);
        row.source_row = 2;
        let mapping = Map::from_iter([
            ("entity".into(), json!("公司")),
            ("date".into(), json!("日期")),
            ("id".into(), json!(["类型", "凭证"])),
        ]);
        assert_eq!(
            display_voucher_id(&voucher_id(&row, &mapping, &json!({"fixedEntity": "E"}))),
            "A-2025-01-02-记-9"
        );
    }

    #[test]
    fn safe_html_rates_are_parsed() {
        let html = r#"<tr class="first"><td>2025-12-31</td><td>702.88</td><td>-</td></tr>"#;
        let rows = parse_safe_html(html);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1[0], Some(702.88));
        assert_eq!(rows[0].1[1], None);
    }

    #[test]
    fn amount_schemes_are_mutually_complete() {
        let mapping = Map::from_iter([
            ("foreignDebit".into(), json!("借")),
            ("foreignCredit".into(), json!("贷")),
        ]);
        assert!(amount_scheme_ok(&mapping, "foreign"));
        let bad = Map::from_iter([
            ("foreignAmount".into(), json!("金额")),
            ("foreignDebit".into(), json!("借")),
            ("foreignCredit".into(), json!("贷")),
        ]);
        assert!(!amount_scheme_ok(&bad, "foreign"));
    }

    #[test]
    fn account_code_inherits_non_unassigned_role_from_tb_description() {
        let params = json!({"accountRoles":{
            "707000":"unassigned",
            "707000 Cur Remeasur G/L-Sys":"fx_gain_loss",
            "111201 FX Val-A/R Trade":"monetary_asset"
        }});
        assert_eq!(role_for("707000", &params), "fx_gain_loss");
        assert_eq!(role_for("111201", &params), "monetary_asset");
        assert_eq!(
            suggest_account_role("200011 FX Val-A/P Trade"),
            "monetary_liability"
        );
    }

    #[test]
    fn relevant_voucher_detail_keeps_all_lines_and_fills_name_from_tb() {
        let root = std::env::temp_dir().join(format!("fx-voucher-detail-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        let tb = root.join("tb.csv");
        fs::write(&je, "公司,日期,凭证号,科目编码,摘要,币种,原币,本位币\nE,2025-01-02,1,1001,银行行,USD,100,700\nE,2025-01-02,1,6603,汇兑损益,CNY,0,-700\nE,2025-01-03,2,9999,无关凭证,CNY,0,1\n").unwrap();
        fs::write(
            &tb,
            "科目编码,科目名称\n1001,银行存款\n6603,财务费用-汇兑损益\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E",
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目编码"],"summary":"摘要","currency":"币种","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"account":["科目编码","科目名称"]}
        });
        let detail = build_relevant_voucher_detail(
            &params,
            &[json!({"voucherId":"E-2025-01-02-1"})],
            &[],
            &[],
            &HashMap::new(),
            false,
        )
        .unwrap();
        assert_eq!(detail.len(), 2, "相关凭证必须保留借贷双方全部行");
        assert_eq!(detail[0]["accountNameOriginal"], "银行存款");
        assert_eq!(detail[1]["accountNameOriginal"], "财务费用-汇兑损益");
        assert!(
            detail[0].get("accountNameChinese").is_none(),
            "未启用LLM时不应生成翻译列"
        );
        assert!(
            detail
                .iter()
                .all(|row| row["voucherId"] == "E-2025-01-02-1")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn english_account_name_detection_does_not_translate_existing_chinese() {
        assert!(is_english_account_name("FX Gain or Loss"));
        assert!(!is_english_account_name("财务费用-FX损益"));
        assert!(!is_english_account_name("财务费用-汇兑损益"));
    }

    #[test]
    fn je_account_code_uses_tb_name_for_role_inference() {
        let params = json!({
            "accountRoles": {},
            "__tbAccountNames": {
                "100485": "USD BOA CPCSC Cash",
                "111200": "AR-Trade (sys)",
                "200010": "AP-Trade (sys)",
                "122001": "Inven-Fin Prod (Man)",
                "122052": "Shdw 122001 Inv-FP"
            }
        });
        assert_eq!(role_for("100485", &params), "monetary_asset");
        assert_eq!(role_for("111200", &params), "monetary_asset");
        assert_eq!(role_for("200010", &params), "monetary_liability");
        assert_eq!(role_for("122001", &params), "non_monetary");
        assert_eq!(role_for("122052", &params), "non_monetary");
    }

    #[test]
    fn calculation_sheet_contains_full_voucher_and_measurement_in_one_table() {
        let path =
            std::env::temp_dir().join(format!("fx-combined-detail-{}.xlsx", std::process::id()));
        let result = json!({
            "summary":{"accountTranslationEnabled":true},
            "voucherDetail":[
                {"voucherId":"E-2025-01-02-1","classification":"已实现","sourceRow":2,"date":"2025-01-02","summary":"收款","accountCode":"1001","accountNameOriginal":"Bank","accountNameChinese":"银行存款","currency":"USD","foreignAmount":100.0,"functionalAmount":700.0,"原始_借方":"700"},
                {"voucherId":"E-2025-01-02-1","classification":"已实现","sourceRow":3,"date":"2025-01-02","summary":"收款","accountCode":"6603","accountNameOriginal":"FX Gain","accountNameChinese":"汇兑损益","currency":"CNY","foreignAmount":0.0,"functionalAmount":-700.0,"原始_贷方":"700"}
            ],
            "realized":[{"voucherId":"E-2025-01-02-1","date":"2025-01-02","sourceRow":2,"account":"9999","currency":"USD","settlementForeign":100.0,"settlementRate":7.0,"officialRate":7.0,"carryingFunctional":710.0,"translatedFunctional":700.0,"auditGainLoss":10.0,"calculationMethod":"实际结算汇率法","rateSource":"测试"}],
            "unrealized":[],"pendingReview":[]
        });
        let mut workbook = Workbook::new();
        write_user_calculation_sheet(&mut workbook, &result).unwrap();
        workbook.save(&path).unwrap();
        let mut reader = open_workbook_auto(&path).unwrap();
        assert_eq!(reader.sheet_names(), &["汇兑损益测算明细"]);
        let range = reader.worksheet_range("汇兑损益测算明细").unwrap();
        let rows = range.rows().collect::<Vec<_>>();
        let headers = rows[0].iter().map(ToString::to_string).collect::<Vec<_>>();
        assert!(headers.contains(&"原始科目名称".to_owned()));
        assert!(headers.contains(&"中文科目名称（LLM翻译）".to_owned()));
        let original_name = headers
            .iter()
            .position(|header| header == "原始科目名称")
            .unwrap();
        let chinese_name = headers
            .iter()
            .position(|header| header == "中文科目名称（LLM翻译）")
            .unwrap();
        assert_eq!(chinese_name, original_name + 1, "中英文科目名称必须相邻");
        assert_eq!(rows.len(), 3, "同一表内应保留完整凭证的两条分录");
        assert_eq!(rows[1][5].to_string(), "1001", "测算字段不得覆盖JE原始科目");
        assert_eq!(rows[1][11].to_string(), "是");
        assert_eq!(rows[2][11].to_string(), "否");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn exported_headers_and_roles_are_chinese() {
        assert_eq!(chinese_header("auditFxGainLoss"), "审计测算汇兑损益");
        assert_eq!(
            chinese_header("periodFunctionalDebit"),
            "本期本位币借方发生额"
        );
        assert_eq!(localized_scalar("fx_gain_loss"), "汇兑损益");
        assert_eq!(localized_scalar("combined"), "已实现＋未实现");
    }

    #[test]
    fn conclusion_splits_tb_gain_loss_only_when_all_accounts_are_identified() {
        let params = json!({
            "reportStart": "2025-01-01",
            "reportEnd": "2025-12-31",
            "entity": "3300"
        });
        for (presentation, expected, unexpected) in [
            (
                "split",
                vec!["TB已实现汇兑损益", "TB未实现汇兑损益", "TB汇兑损益合计"],
                "TB汇兑损益（损益科目未区分已实现/未实现）",
            ),
            (
                "combined",
                vec!["TB汇兑损益（损益科目未区分已实现/未实现）"],
                "TB已实现汇兑损益",
            ),
        ] {
            let path = std::env::temp_dir().join(format!(
                "fx-tb-presentation-{presentation}-{}.xlsx",
                std::process::id()
            ));
            let result = json!({
                "mode": "combined",
                "summary": {
                    "tbFxGainLossPresentation": presentation,
                    "realizedGainLoss": 10.0,
                    "unrealizedAdjustment": 20.0,
                    "auditFxGainLoss": 30.0,
                    "tbRealizedGainLoss": 11.0,
                    "tbUnrealizedGainLoss": 19.0,
                    "tbFxGainLoss": 30.0,
                    "difference": 0.0,
                    "differenceRatio": 0.0,
                    "reconciliationPassed": true
                }
            });
            let mut workbook = Workbook::new();
            write_user_conclusion_sheet(&mut workbook, &params, &result).unwrap();
            workbook.save(&path).unwrap();
            let mut reader = open_workbook_auto(&path).unwrap();
            let range = reader.worksheet_range("审计结论").unwrap();
            let labels = range
                .rows()
                .filter_map(|row| row.first())
                .map(ToString::to_string)
                .collect::<Vec<_>>();
            for label in expected {
                assert!(labels.iter().any(|value| value == label), "{labels:?}");
            }
            assert!(
                !labels.iter().any(|value| value == unexpected),
                "{labels:?}"
            );
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn tb_only_workpaper_contains_traceable_two_point_formulas() {
        let path =
            std::env::temp_dir().join(format!("fx-tb-only-formulas-{}.xlsx", std::process::id()));
        let result = json!({
            "mode": "unrealized",
            "summary": {
                "realizedGainLoss": 0.0,
                "unrealizedAdjustment": 26.0,
                "auditFxGainLoss": 26.0,
                "tbFxGainLoss": 26.0,
                "difference": 0.0,
                "differenceRatio": 0.0,
                "reconciliationPassed": true,
                "pendingReviewAmount": 0.0
            },
            "voucherDetail": [], "pendingReview": [], "dataQuality": [],
            "unrealized": [{
                "entity": "E", "account": "1002 美元户", "currency": "USD",
                "functionalCurrency": "CNY", "openingForeign": 10.0,
                "openingRateDate": "2025-01-01", "openingRate": 7.1,
                "openingPublishedDate": "2024-12-31", "openingBookFunctional": 70.0,
                "openingAuditFunctional": 71.0, "openingDifference": 1.0,
                "closingForeign": 20.0, "closingRateDate": "2025-12-31",
                "closingRate": 7.2, "closingPublishedDate": "2025-12-31",
                "closingBookFunctional": 118.0, "closingAuditFunctional": 144.0,
                "closingDifference": 26.0, "twoPointChange": 25.0,
                "suggestedAdjustment": 26.0, "method": "年初/年末两时点检查",
                "sourceRow": 2
            }],
            "rateSnapshot": {"responseHash":"test", "rates": [
                {"requestedDate":"2025-01-01", "publishedDate":"2024-12-31", "currency":"USD", "cnyPerUnit":7.1},
                {"requestedDate":"2025-12-31", "publishedDate":"2025-12-31", "currency":"USD", "cnyPerUnit":7.2}
            ]}
        });
        let params = json!({
            "reportStart":"2025-01-01", "reportEnd":"2025-12-31",
            "fixedEntity":"E", "outputPath":path.to_string_lossy(),
            "tbSource":{"inputPath":"tb.xlsx"}
        });
        export_workbook(&params, &result).unwrap();
        let mut reader = open_workbook_auto(&path).unwrap();
        let formulas = reader
            .worksheet_formula("未实现汇兑损益测算")
            .unwrap()
            .cells()
            .map(|(_, _, formula)| formula.clone())
            .collect::<Vec<_>>();
        for expected in ["F2*G2", "I2-H2", "K2*L2", "N2-M2", "O2-J2", "O2"] {
            assert!(
                formulas.iter().any(|formula| formula == expected),
                "缺少公式 {expected}：{formulas:?}"
            );
        }
        assert!(
            formulas
                .iter()
                .any(|formula| formula.contains("汇率表") && formula.contains("MATCH")),
            "两时点汇率必须链接统一汇率表：{formulas:?}"
        );
        let conclusion = reader
            .worksheet_formula("审计结论")
            .unwrap()
            .cells()
            .map(|(_, _, formula)| formula.clone())
            .collect::<Vec<_>>();
        assert!(
            conclusion.iter().any(|formula| formula.contains("$Q:$Q")),
            "TB-only 结论页应汇总两时点建议调整公式列：{conclusion:?}"
        );
        fs::remove_file(path).unwrap();
    }

    // 回归：Excel 打开时会全量重算（rust_xlsxwriter 默认 fullCalcOnLoad），
    // 结论页公式必须能在明细页里找到数据，否则写死的缓存值一打开就归零，
    // 出现「界面通过、Excel 里差异率 100%」的自相矛盾底稿。
    #[test]
    fn conclusion_formulas_recalculate_from_visible_sheets() {
        let path = std::env::temp_dir().join(format!(
            "fx-traceable-conclusion-{}.xlsx",
            std::process::id()
        ));
        let closing_foreign = -1168109.2415139726;
        let official_rate = 0.12754982741342835;
        let audit_closing = -148992.1321551379;
        let pre_revaluation = -152737.3524326747;
        let unrealized = pre_revaluation - audit_closing;
        let result = json!({
            "mode": "combined",
            "summary": {
                "accountTranslationEnabled": false,
                "realizedGainLoss": 0.0,
                "unrealizedAdjustment": unrealized,
                "automaticMeasuredFxGainLoss": unrealized,
                "pendingReviewAmount": 0.0,
                "auditFxGainLoss": unrealized,
                "tbFxGainLoss": unrealized * 40.0,
                "differenceRatio": 0.02,
                "reconciliationPassed": true
            },
            "voucherDetail": [], "classification": [],
            "realized": [], "unrealized": [], "pendingReview": [],
            "clientRevaluationVouchers": [],
            "rateSnapshot": {"rates": [
                {"requestedDate": "2025-05-31", "publishedDate": "2025-05-30",
                 "currency": "HKD", "cnyPerUnit": 0.12754982741342835},
                {"requestedDate": "2025-12-31", "publishedDate": "2025-12-31",
                 "currency": "USD", "cnyPerUnit": 0.9},
                {"requestedDate": "2025-12-31", "publishedDate": "2025-12-31",
                 "currency": "CNY", "cnyPerUnit": 1.0}
            ]},
            "unrealizedBalanceRollforward": [
                {
                    "entity": "4800", "account": "2211020001 应付职工薪酬",
                    "currency": "HKD", "functionalCurrency": "USD",
                    "monthEnd": "2025-05-31", "publishedDate": "2025-05-30",
                    "closingForeign": closing_foreign, "officialRate": official_rate,
                    "auditClosingFunctional": audit_closing,
                    "preRevaluationFunctional": pre_revaluation,
                    "unrealizedGainLoss": unrealized,
                    "suggestedAdjustment": -3745.27,
                    "clientBookedUnrealizedGainLoss": 0.05,
                    "clientRevaluationVoucherIds": ["E-V001"],
                    "clientRevaluationDetails": [
                        {"voucherId": "E-V001", "summary": "调整汇差", "bookedFxGainLoss": 0.05}
                    ]
                },
                {
                    "entity": "4800", "account": "10020002 招商银行-美元资本金",
                    "currency": "USD", "functionalCurrency": "CNY",
                    "monthEnd": "2025-12-31", "publishedDate": "2025-12-31",
                    "openingForeign": 80.0, "businessForeignMovement": -10.0,
                    "closingForeign": 70.0, "officialRate": 0.9,
                    "openingAuditFunctional": 500.0, "businessFunctionalMovement": 229.99,
                    "preRevaluationFunctional": 729.99,
                    "auditClosingFunctional": 63.0,
                    "unrealizedGainLoss": 666.99,
                    "clientBookedUnrealizedGainLoss": 600.0,
                    "suggestedAdjustment": 66.99,
                    "auditBalanceAdjustment": -666.99,
                    "tbClosingFunctional": 60.5
                }
            ]
        });
        let params = json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-05-31",
            "jeSource": {"inputPath": "je.xlsx"}, "tbSource": {"inputPath": "tb.xlsx"},
            "outputPath": path.to_string_lossy()
        });
        export_workbook(&params, &result).unwrap();

        let mut reader = open_workbook_auto(&path).unwrap();
        let names = reader.sheet_names().clone();
        assert!(
            names.contains(&"未实现汇兑损益测算".to_owned()),
            "{names:?}"
        );
        assert!(names.contains(&"审计结论".to_owned()), "{names:?}");
        assert!(names.contains(&"汇率表".to_owned()), "{names:?}");
        // 「不构成汇兑事项」独立披露页：无该类凭证时也生成（合计 0 张），
        // 保证勾稽「其中」披露的落点页始终存在。
        assert!(names.contains(&"不构成汇兑事项".to_owned()), "{names:?}");
        let not_fx = reader.worksheet_range("不构成汇兑事项").unwrap();
        let not_fx_total = not_fx
            .get_value((1, 4))
            .and_then(Data::as_f64)
            .unwrap_or(f64::NAN);
        assert!(
            not_fx_total.abs() < 1e-9,
            "无该类凭证时合计金额应为 0，实际 {not_fx_total}"
        );
        assert_eq!(
            not_fx.get_value((1, 0)).and_then(Data::as_string),
            Some("合计 0 张".to_owned())
        );

        // 缓存值（给不重算的预览器用）与引擎一致。
        let conclusions = reader.worksheet_range("审计结论").unwrap();
        assert!(
            (conclusions
                .get_value((5, 1))
                .and_then(Data::as_f64)
                .unwrap_or(f64::NAN)
                - unrealized)
                .abs()
                < 1e-6,
            "结论页未实现缓存值应为 {unrealized}，实际 {:?}",
            conclusions.get_value((5, 1))
        );

        // 结论页公式：未实现 SUM 滚动页 L 列；勾稽结果是按差异率判定的活公式。
        let conclusion_formulas = reader.worksheet_formula("审计结论").unwrap();
        let texts = conclusion_formulas
            .cells()
            .map(|(_, _, text)| text.clone())
            .collect::<Vec<_>>();
        assert!(
            texts
                .iter()
                .any(|t| t.contains("$L:$L") && t.contains("未实现汇兑损益测算")),
            "未实现公式应引用未实现汇兑损益测算!$L:$L，实际 {texts:?}"
        );
        assert!(
            texts.iter().any(|t| t.contains("ABS(B9/B8)"))
                && texts.iter().any(|t| t.contains("B11<0.05")),
            "差异率及5%结论应分别由活公式计算，实际 {texts:?}"
        );

        // 滚动页逐行可手工验算：J=原币×中间价，L=测算前−审计折算。
        let rollforward_formulas = reader.worksheet_formula("未实现汇兑损益测算").unwrap();
        let rolls = rollforward_formulas
            .cells()
            .map(|(_, _, text)| text.clone())
            .collect::<Vec<_>>();
        assert!(
            rolls.iter().any(|t| t.contains("H2*I2")),
            "审计折算余额列应为 H×I 公式，实际 {rolls:?}"
        );
        assert!(
            rolls.iter().any(|t| t.contains("K2-J2")),
            "月末重估损益列应为 K−J 公式，实际 {rolls:?}"
        );
        // 月末官方中间价必须链接「汇率表」单一来源，不得写死。
        assert!(
            rolls
                .iter()
                .any(|t| t.contains("汇率表") && t.contains("INDEX") && t.contains("MATCH")),
            "月末官方中间价应链接汇率表（INDEX/MATCH），实际 {rolls:?}"
        );
        // 汇率表本身：日期×币种矩阵含滚动页用到的组合。
        let rate_range = reader.worksheet_range("汇率表").unwrap();
        let rate_headers = rate_range.rows().next().unwrap().to_owned();
        assert!(
            rate_headers.contains(&Data::String("日期".into())),
            "{rate_headers:?}"
        );
        assert!(
            rate_headers.contains(&Data::String("HKD".into())),
            "{rate_headers:?}"
        );
        // 第二行（带 TB 年末数的示例）：全部行内算式均可验算。
        for (needle, what) in [
            ("P3+R3", "月末原币余额=期初+业务发生"),
            ("Q3+S3", "测算前本位币=期初审计折算+业务本位币发生"),
            ("L3-N3", "建议调整=重估损益−客户已入账"),
            ("J3-K3", "审计折算调整=审计折算−测算前"),
            ("J3-V3", "TB勾稽差异=审计折算−TB年末本位币"),
        ] {
            assert!(
                rolls.iter().any(|t| t.contains(needle)),
                "滚动页缺少公式 {what}（{needle}），实际 {rolls:?}"
            );
        }

        fs::remove_file(path).unwrap();
    }

    #[test]
    #[ignore = "uses the user's immutable real JE/TB sample and official rate service"]
    fn real_sample_runs_through_fx_tool_and_exports_reconciled_workpaper() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        assert!(root.join("序时账-1.xlsx").is_file());
        assert!(root.join("科目余额表.xls").is_file());
        let source_hash = |path: &Path| hex::encode(Sha256::digest(fs::read(path).unwrap()));
        let je_hash = source_hash(&root.join("序时账-1.xlsx"));
        let tb_hash = source_hash(&root.join("科目余额表.xls"));

        let je = inspect(
            &json!({"source": real_sample_params(None)["jeSource"]}),
            "je",
        )
        .unwrap();
        let tb = inspect(
            &json!({"source": real_sample_params(None)["tbSource"]}),
            "tb",
        )
        .unwrap();
        assert_eq!(je["headerRow"], 1);
        assert_eq!(tb["headerRow"], 1);
        assert_eq!(je["dataYears"], json!([2024]));
        assert_eq!(tb["dataYears"], json!([2024]));
        assert!(candidate_has(&je, "foreignAmount", "原币"));
        assert!(candidate_has(&je, "functionalAmount", "借正贷负"));
        assert!(candidate_has(&tb, "periodFunctionalDebit", "本期发生借方"));
        let suggested_je = je["suggestedMapping"].as_object().unwrap();
        assert_eq!(suggested_je.get("id"), Some(&json!("凭证号数")));
        assert_eq!(suggested_je.get("date"), Some(&json!("日期")));
        assert_eq!(suggested_je.get("currency"), Some(&json!("币种")));
        assert_eq!(suggested_je.get("foreignAmount"), Some(&json!("原币")));
        assert_eq!(
            suggested_je.get("functionalAmount"),
            Some(&json!("借正贷负"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/openingFunctionalDebit"),
            Some(&json!("期初余额借方"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/openingFunctionalCredit"),
            Some(&json!("期初余额贷方"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/closingFunctionalDebit"),
            Some(&json!("期末余额借方"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/closingFunctionalCredit"),
            Some(&json!("期末余额贷方"))
        );
        let mut auto_params = real_sample_params(None);
        auto_params["jeMapping"] = je["suggestedMapping"].clone();
        auto_params["tbMapping"] = tb["suggestedMapping"].clone();
        let auto_validation = validate_mapping(&auto_params).unwrap();
        // 这份 TB 没有币种列，但科目名称里写着“招商银行-美元资本金”“交通银行-美元
        // 资本金”。既然能认出外币科目，就不该再把整张表拦下。
        assert_eq!(
            auto_validation["valid"], true,
            "科目名称里认得出美元科目时应放行：{auto_validation:#}"
        );
        let usd_accounts = records(
            &load_fx_table(&serde_json::from_value(auto_params["tbSource"].clone()).unwrap())
                .unwrap(),
        )
        .iter()
        .filter(|row| {
            currency_from_text(&account_name(row, &mapping_obj(&auto_params, "tbMapping")))
                .is_some_and(|code| code == "USD")
        })
        .count();
        assert_eq!(usd_accounts, 2, "样例里正好两个美元科目");
        assert_eq!(source_hash(&root.join("序时账-1.xlsx")), je_hash);
        assert_eq!(source_hash(&root.join("科目余额表.xls")), tb_hash);
    }

    #[test]
    #[ignore = "uses the user's immutable SAP JE/TB customer samples"]
    fn sap_customer_samples_auto_select_sheet_and_map_required_fields() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let je = inspect(&json!({"source": {
            "inputPath": root.join("JE+YTD+OCT.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}), "je").unwrap();
        let je_class = classify_source(&json!({"source": {
            "inputPath": root.join("JE+YTD+OCT.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}))
        .unwrap();
        assert_eq!(je_class["kind"], "je");
        assert_eq!(je_class["needsLlm"], false);
        assert_eq!(je["sheet"], "Sheet1 (2)");
        assert_eq!(je["headerRow"], 1);
        assert_eq!(je["sampledPreview"], true, "8MB 以上的工作簿走样本识别");
        assert!(
            parse_date(je["preview"][0][6].as_str().unwrap_or("")).is_some(),
            "日期格式的单元格必须还原成日期而不是 Excel 序列号：{}",
            je["preview"][0][6]
        );
        assert_eq!(
            je["suggestedBalanceSheetDate"],
            Value::Null,
            "只读了开头若干行，样本里的最大日期不能当资产负债表日"
        );
        assert_eq!(je["dataYears"], json!([2025]));
        assert!(
            je.pointer("/suggestedMapping/entity").is_none(),
            "币值金额列不能误识别为公司字段"
        );
        assert_eq!(
            je.pointer("/suggestedMapping/id"),
            Some(&json!("Document Number"))
        );
        assert_eq!(
            je.pointer("/suggestedMapping/date"),
            Some(&json!("Posting Date"))
        );
        assert_eq!(
            je.pointer("/suggestedMapping/accountCode"),
            Some(&json!("G/L Account"))
        );
        assert_eq!(
            je.pointer("/suggestedMapping/currency"),
            Some(&json!("Document Currency Key"))
        );
        assert_eq!(
            je.pointer("/suggestedMapping/foreignAmount"),
            Some(&json!("Document Currency Value"))
        );
        assert_eq!(
            je.pointer("/suggestedMapping/functionalAmount"),
            Some(&json!("Company Code Currency Value"))
        );

        let tb = inspect(&json!({"source": {
            "inputPath": root.join("Oct+BS+PL+TB.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}), "tb").unwrap();
        let tb_class = classify_source(&json!({"source": {
            "inputPath": root.join("Oct+BS+PL+TB.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}))
        .unwrap();
        assert_eq!(tb_class["kind"], "tb");
        assert_eq!(tb_class["needsLlm"], false);
        assert_eq!(tb["sheet"], "TB");
        assert_eq!(tb["headerRow"], 13);
        assert_eq!(
            tb.pointer("/suggestedMapping/entity"),
            Some(&json!("Company Code"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/accountCode"),
            Some(&json!("GL Account"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/accountName"),
            Some(&json!(["GL Description"]))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/closingFunctionalAmount"),
            Some(&json!("YTD Act (Local Curr)"))
        );
        assert_eq!(tb["foreignCurrencyNeedsConfirmation"], true);
        assert!(
            tb["foreignCurrencyCandidates"]
                .as_array()
                .is_some_and(|items| items.len() >= 2),
            "多个含USD的Currency列应先自动预选并提示确认：{tb:#}"
        );
        let mut account_roles = Map::new();
        for account in je["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(tb["accounts"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
        {
            account_roles.insert(account.to_owned(), json!(suggest_account_role(account)));
        }
        let output = root.join("汇兑损益SAP客户样例_根因修复验证.xlsx");
        let mut params = json!({
            "mode":"combined", "reportStart":"2025-01-01", "reportEnd":"2025-10-31",
            "fixedEntity":"KL", "entityCurrencies":{"KL":"CNY"},
            "jeSource":{"inputPath":root.join("JE+YTD+OCT.xlsx"),"sheet":je["sheet"],"headerRow":je["headerRow"],"headerDepth":je["headerDepth"]},
            "tbSource":{"inputPath":root.join("Oct+BS+PL+TB.xlsx"),"sheet":tb["sheet"],"headerRow":tb["headerRow"],"headerDepth":tb["headerDepth"]},
            "jeMapping":je["suggestedMapping"], "tbMapping":tb["suggestedMapping"],
            "accountRoles": account_roles, "outputPath": output
        });
        // 模拟LLM把SAP单月MTD误放入一个单边发生额字段。后端仍必须优先
        // 使用已成立的YTD累计净额方案，不能让单边建议改写TB对比口径。
        params["tbMapping"]["periodFunctionalDebit"] = json!("MTD Local Curr");
        let validation = validate_mapping(&params).unwrap();
        assert_eq!(
            validation["valid"], false,
            "样例TB没有期初余额，按固定必填规则必须阻止测算：{validation:#}"
        );
        assert!(
            validation["errors"].as_array().is_some_and(|errors| errors
                .iter()
                .any(|item| item.as_str().is_some_and(|text| text.contains("期初余额")))),
            "{validation:#}"
        );
    }

    #[test]
    fn account_code_and_name_stay_separate_roles() {
        let mut row = test_row_record(&[
            ("科目代码", "1002010017"),
            ("科目名称一级", "货币资金"),
            ("科目名称二级", "货币资金-银行存款"),
        ]);
        row.source_row = 2;
        let mapping = Map::from_iter([
            ("accountCode".into(), json!("科目代码")),
            (
                "accountName".into(),
                json!(["科目名称一级", "科目名称二级"]),
            ),
        ]);
        let (code, name) = account_code_and_name(&row, &mapping);
        assert_eq!(code, "1002010017");
        assert_eq!(name, "货币资金 货币资金-银行存款");
        assert_eq!(
            account_name(&row, &mapping),
            "1002010017 货币资金 货币资金-银行存款",
            "显示键必须编码在前、名称在后"
        );

        // 历史参数把两者合并在 account 数组里，仍需正确拆分。
        let legacy = Map::from_iter([(
            "account".into(),
            json!(["科目名称一级", "科目名称二级", "科目代码"]),
        )]);
        let (legacy_code, legacy_name) = account_code_and_name(&row, &legacy);
        assert_eq!(legacy_code, "1002010017");
        assert_eq!(legacy_name, "货币资金");
    }

    #[test]
    fn currency_column_wins_and_account_text_only_fills_in_when_there_is_none() {
        // 4800 这类 SAP 导出：“货币”列整列登记的是主体本位币 USD，映射阶段
        // 会把它归到本位币而不是交易币种，账户币种改从科目文本里取
        // （建行RMB3250 / 建行USD4150）。
        let text_mapping = Map::from_iter([
            ("entity".into(), json!("公司代码")),
            ("accountCode".into(), json!("科目代码")),
            ("accountName".into(), json!("科目名称二级")),
            ("functionalCurrency".into(), json!("货币")),
            ("currencyText".into(), json!("文本")),
        ]);
        let params = json!({"entityCurrencies": {"4800": "USD"}});
        let row = |code: &'static str, text: &'static str, currency: &'static str| {
            test_row_record(&[
                ("公司代码", "4800"),
                ("科目代码", code),
                ("科目名称二级", "货币资金-银行存款"),
                ("货币", "USD"),
                ("交易币种", currency),
                ("文本", text),
            ])
        };
        let currency = |mapping: &Map<String, Value>,
                        code: &'static str,
                        text: &'static str,
                        column: &'static str| {
            let record = row(code, text, column);
            let account = account_name(&record, mapping);
            currency_for(&record, mapping, &account, &params)
        };
        assert_eq!(
            currency(&text_mapping, "1002010017", "银行存款-建行RMB3250-4800", ""),
            "CNY"
        );
        assert_eq!(
            currency(&text_mapping, "1002010018", "银行存款-建行USD4150-4800", ""),
            "USD"
        );
        assert_eq!(
            currency(&text_mapping, "1002010021", "银行存款-建行HKD5050-4800", ""),
            "HKD"
        );
        assert_eq!(
            currency(
                &text_mapping,
                "1002990001",
                "货币资金-银行存款-过渡银行",
                ""
            ),
            "USD",
            "文本里没有币种线索时退回本位币列"
        );

        // 真正的多币种列存在时，它说了算，不再去看科目文本。
        let mut column_mapping = text_mapping.clone();
        column_mapping.insert("currency".into(), json!("交易币种"));
        assert_eq!(
            currency(
                &column_mapping,
                "1002010017",
                "银行存款-建行RMB3250-4800",
                "EUR"
            ),
            "EUR",
            "币种列优先于科目文本线索"
        );
        assert_eq!(
            currency(
                &column_mapping,
                "1002010017",
                "银行存款-建行RMB3250-4800",
                ""
            ),
            "CNY",
            "币种列该行为空时才回落到文本线索"
        );
    }

    #[test]
    fn currency_text_extraction_requires_word_boundary_and_single_hit() {
        assert_eq!(
            currency_from_text("银行存款-建行USD4150"),
            Some("USD".into())
        );
        assert_eq!(currency_from_text("应收账款-美元"), Some("USD".into()));
        assert_eq!(currency_from_text("其他应收-人民币"), Some("CNY".into()));
        assert_eq!(currency_from_text("PLUSDATA 科目"), None, "子串不算命中");
        assert_eq!(
            currency_from_text("USD/HKD 双币账户"),
            None,
            "命中多个币种视为歧义，交回映射列判断"
        );
        assert_eq!(currency_from_text("银行存款-建行"), None);
    }

    #[test]
    fn account_code_mismatch_falls_back_to_account_name_and_only_blocks_when_both_fail() {
        let dir = std::env::temp_dir().join(format!("fx-cross-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        let tb = dir.join("tb.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,会计科目,科目文本,凭证货币,凭证金额,本位币金额\n4800,2025-01-02,1,1002010017,银行存款,USD,100,700\n4800,2025-01-03,2,6603000001,汇兑损益,CNY,0,-700\n",
        )
        .unwrap();
        // TB 的科目编码被错误映射到了科目名称列：编码对不上，但名称还对得上。
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,货币,期初金额,期末金额\n4800,货币资金,银行存款,USD,100,200\n4800,财务费用,汇兑损益,USD,0,50\n",
        )
        .unwrap();
        let mut params = json!({
            "mode":"combined", "reportEnd":"2025-12-31", "fixedEntity":"4800",
            "jeSource":{"inputPath":je, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],
                "accountCode":"会计科目","accountName":"科目文本",
                "currency":"凭证货币","foreignAmount":"凭证金额","functionalAmount":"本位币金额"},
            "tbMapping":{"entity":"公司代码","accountCode":"科目代码","accountName":"科目名称",
                "currency":"货币","openingFunctionalAmount":"期初金额",
                "closingFunctionalAmount":"期末金额"}
        });
        let by_name = check_mapping_alignment(&params).unwrap();
        assert_eq!(
            by_name["errors"].as_array().map(Vec::len),
            Some(0),
            "科目名称还能对上就不该拦下测算：{by_name:#}"
        );
        assert!(
            by_name["warnings"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("已按科目名称继续匹配")))),
            "要说明改用了哪个口径：{by_name:#}"
        );

        // 名称也换成完全对不上的，这时才是真的没法做。
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,货币,期初金额,期末金额\n4800,货币资金,现金及等价物,USD,100,200\n4800,财务费用,财务性支出,USD,0,50\n",
        )
        .unwrap();
        params["tbSource"]["headerRow"] = json!(1);
        let both_failed = check_mapping_alignment(&params).unwrap();
        assert!(
            both_failed["errors"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item.as_str().is_some_and(
                    |text| text.contains("科目编码和科目名称都对不上")
                        && text.contains("1002010017")
                        && text.contains("货币资金")
                ))),
            "两个口径都失败时必须带样例拦下：{both_failed:#}"
        );
        fs::remove_file(&je).unwrap();
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    fn je_document_currency_column_keeps_currency_role_even_when_uniform() {
        // 04 PBC 的形态：整本序时账都是本币业务，「货币」列整列 CNY。按取值
        // 形态（填满＋单一代码→本位币列）会把「货币」判给 functionalCurrency、
        // currency 被挤空，「凭证货币金额」又没有别名通路，必填校验从此一直
        // 拦着，复核还报告「当前映射无需调整」。凭证货币命名的列必须归 currency，
        // 整列同码只是「没有外币业务」的正常形态。
        let dir = std::env::temp_dir().join(format!("fx-uniform-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        fs::write(
            &je,
            concat!(
                "凭证编号,凭证类型,凭证日期,借贷标志,货币,凭证货币金额,本位币金额,总账货币,总帐科目,科目名称,公司代码\n",
                "1100000000,SA,2025-01-13,S,CNY,18000000,18000000,CNY,1002200089,银行存款-民生,1627\n",
                "1100000001,SA,2025-01-14,H,CNY,1200,1200,CNY,1002200090,银行存款-建行,1627\n",
            ),
        )
        .unwrap();
        let inspection = inspect(
            &json!({"source": {
                "inputPath": je, "sheet":"", "headerRow":1, "headerDepth":1
            }}),
            "je",
        )
        .unwrap();
        let mapping = &inspection["suggestedMapping"];
        assert_eq!(
            mapping.get("currency"),
            Some(&json!("货币")),
            "凭证货币命名的列即使整列同码也归原币币种：{mapping:#?}"
        );
        assert_eq!(
            mapping.get("foreignAmount"),
            Some(&json!("凭证货币金额")),
            "「凭证货币金额」就是原币净额，「凭证金额」并不是它的子串：{mapping:#?}"
        );
        assert_eq!(mapping.get("functionalAmount"), Some(&json!("本位币金额")));
        assert_eq!(
            mapping.get("functionalCurrency"),
            Some(&json!("总账货币")),
            "本位币币种认总账货币，不许抢走凭证货币列：{mapping:#?}"
        );
        assert_eq!(
            mapping.get("accountCode"),
            Some(&json!("总帐科目")),
            "「帐」是「账」的旧异体字，总帐科目必须能当科目编码识别：{mapping:#?}"
        );
        fs::remove_file(&je).unwrap();
    }

    #[test]
    fn sap03_je_gl_account_column_and_account_name_text_column() {
        // 03 号样例的 SAP 序时账（表头在第 6 行，这里直接从第 1 行起测映射）：
        // 编码列叫「总账科目」取值 1001010000；另有一列「会计科目」取值是
        // 库存现金-人民币 这种名称文本。此前「会计科目」按列名只能去争编码、
        // 争输被丢，科目名称两头落空。现在按取值补判它为科目名称列。
        // 「本币」列（整列 CNY）必须归本位币币种，不许被 LLM 复核指给原币币种；
        // 「过账代码」（取值 40/50）是统驭过账码，不是借贷方向。
        let dir = std::env::temp_dir().join(format!("fx-sap03-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("sap03_je.csv");
        let mut csv = String::from(
            "凭证编号,凭证类型,凭证日期,过账代码,本币,税码,文本,抵销科目,成本中心,年度/月份,本币金额,总账科目,过账日期,过账期间,会计科目,销售/管理费用\n",
        );
        for (voucher, posting, text, offset, amount, account, name) in [
            (
                "6000000028",
                "50",
                "1.22现金发放正式员工工资",
                "2211010100",
                "-60500",
                "1001010000",
                "库存现金-人民币",
            ),
            (
                "6000000029",
                "50",
                "1.22现金发放派遣员工工资",
                "2211010200",
                "-14500",
                "1001010000",
                "库存现金-人民币",
            ),
            (
                "6000000037",
                "40",
                "1.14浦发银行新乡支行取现",
                "1002105003",
                "74500",
                "1001010000",
                "库存现金-人民币",
            ),
            (
                "6000000040",
                "40",
                "1.31工行新乡分行付款",
                "1002101001",
                "3200",
                "1002200089",
                "银行存款-工行新乡",
            ),
            (
                "6000000041",
                "50",
                "1.31结转本月水电费",
                "6602010000",
                "-880",
                "1002200089",
                "银行存款-工行新乡",
            ),
        ] {
            csv.push_str(&format!(
                "{voucher},SA,2025-01-31,{posting},CNY,,{text},{offset},,2025/01,{amount},{account},2025-01-31,1,{name},\n"
            ));
        }
        fs::write(&je, csv).unwrap();
        let inspection = inspect(
            &json!({"source": {
                "inputPath": je, "sheet":"", "headerRow":1, "headerDepth":1
            }}),
            "je",
        )
        .unwrap();
        let mapping = &inspection["suggestedMapping"];
        assert_eq!(
            mapping.get("accountCode"),
            Some(&json!("总账科目")),
            "取值是纯编码的「总账科目」归科目编码：{mapping:#?}"
        );
        assert_eq!(
            mapping.get("accountName"),
            Some(&json!("会计科目")),
            "取值是名称文本的「会计科目」应按数据补判为科目名称：{mapping:#?}"
        );
        assert_eq!(
            mapping.get("functionalCurrency"),
            Some(&json!("本币")),
            "SAP 的本位币列就叫「本币」，必须归本位币币种：{mapping:#?}"
        );
        assert_ne!(
            mapping.get("currency"),
            Some(&json!("本币")),
            "整列同码的「本币」列绝不能指给原币币种：{mapping:#?}"
        );
        assert_ne!(
            mapping.get("direction"),
            Some(&json!("过账代码")),
            "过账代码（40/50）是统驭过账码，没有借贷含义：{mapping:#?}"
        );
        assert_eq!(mapping.get("functionalAmount"), Some(&json!("本币金额")));
        fs::remove_file(&je).unwrap();
    }

    #[test]
    fn sap03_tb_combined_column_carries_code_and_name() {
        // 03 号样例的科目余额表：科目编码与名称混写在一格
        // （1001010000:库存现金-人民币、1001/库存现金），且整表只有这一列科目。
        // 自动映射必须把这一列同时挂到科目编码与科目名称两个角色上——
        // 只挂编码会让面板一边提示「科目名称未映射」。
        let dir = std::env::temp_dir().join(format!("fx-sap03tb-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("sap03_tb.csv");
        fs::write(
            &tb,
            concat!(
                "级次,项目编码、文本/科目编码、文本,货币,本年金额-期初,本年金额-借方发生,本年金额-贷方发生,期末余额\n",
                "1,1001/库存现金,CNY,984.3,76361.92,-77346.22,-984.3\n",
                "2,1001010000:库存现金-人民币,CNY,984.3,76361.92,-77346.22,-984.3\n",
                "1,1002/银行存款,CNY,22222745.07,2441878816.3,-2450603520.07,-8724703.77\n",
                "2,1002101001:银行存款-建行新乡,CNY,14075.88,493160280.87,-493132095.14,28185.73\n",
                "2,1002101002:银行存款-中行朝阳,CNY,9478413.62,17630658.25,-27108671.29,-9478013.04\n",
            ),
        )
        .unwrap();
        let inspection = inspect(
            &json!({"source": {
                "inputPath": tb, "sheet":"", "headerRow":1, "headerDepth":1
            }}),
            "tb",
        )
        .unwrap();
        let mapping = &inspection["suggestedMapping"];
        let combined = "项目编码、文本/科目编码、文本";
        assert_eq!(
            mapping.get("accountCode"),
            Some(&json!(combined)),
            "混写列归科目编码：{mapping:#?}"
        );
        assert_eq!(
            mapping.get("accountName"),
            Some(&json!([combined])),
            "编码与名称就在同一格里，科目名称必须同时映射到这一列：{mapping:#?}"
        );
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    #[ignore = "依赖本机样例目录，用 LEDGER_SAMPLES=<TBJEPBC路径> 显式运行"]
    fn 真实03样例表头映射() {
        let Some(root) = std::env::var_os("LEDGER_SAMPLES")
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
        else {
            panic!("未设置 LEDGER_SAMPLES，跳过");
        };
        let je = inspect(
            &json!({"source": {
                "inputPath": root.join("03序时账 (2).xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
            }}),
            "je",
        )
        .unwrap();
        let je_mapping = &je["suggestedMapping"];
        println!("03 JE 表头行 {} 映射：{je_mapping:#}", je["headerRow"]);
        assert_eq!(je["headerRow"], json!(6));
        assert_eq!(je_mapping.get("accountCode"), Some(&json!("总账科目")));
        assert_eq!(je_mapping.get("accountName"), Some(&json!("会计科目")));
        assert_eq!(je_mapping.get("functionalCurrency"), Some(&json!("本币")));
        assert_ne!(je_mapping.get("currency"), Some(&json!("本币")));
        assert_ne!(je_mapping.get("direction"), Some(&json!("过账代码")));

        let tb = inspect(
            &json!({"source": {
                "inputPath": root.join("03科目余额表.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
            }}),
            "tb",
        )
        .unwrap();
        let tb_mapping = &tb["suggestedMapping"];
        println!("03 TB 表头行 {} 映射：{tb_mapping:#}", tb["headerRow"]);
        let code = tb_mapping
            .get("accountCode")
            .and_then(Value::as_str)
            .unwrap_or("");
        let name = tb_mapping.get("accountName").and_then(Value::as_array);
        assert!(
            code.contains("科目编码") || code.contains("项目编码"),
            "混写列应归科目编码：{tb_mapping:#}"
        );
        assert!(
            name.is_some_and(|items| items.iter().filter_map(Value::as_str).any(|c| c == code)),
            "混写列必须同时挂科目名称：{tb_mapping:#}"
        );
    }

    #[test]
    fn mismatched_account_mapping_is_realigned_to_columns_that_actually_match() {
        let dir = std::env::temp_dir().join(format!("fx-realign-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        let tb = dir.join("tb.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,会计科目,科目文本,凭证货币,凭证金额,本位币金额\n4800,2025-01-01,1,1002010010,银行存款0,USD,100,700\n4800,2025-01-02,2,1002010011,银行存款1,USD,100,700\n4800,2025-01-03,3,1002010012,银行存款2,USD,100,700\n4800,2025-01-04,4,1002010013,银行存款3,USD,100,700\n4800,2025-01-05,5,1002010014,银行存款4,USD,100,700\n4800,2025-01-06,6,1002010015,银行存款5,USD,100,700\n4800,2025-01-07,7,1002010016,银行存款6,USD,100,700\n4800,2025-01-08,8,1002010017,银行存款7,USD,100,700\n4800,2025-01-09,9,1002010018,银行存款8,USD,100,700\n4800,2025-01-10,10,1002010019,银行存款9,USD,100,700\n4800,2025-01-11,11,1002010020,银行存款10,USD,100,700\n4800,2025-01-12,12,1002010021,银行存款11,USD,100,700\n",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,文本,期初金额,期末金额\n4800,1002010010,银行存款0,银行存款-建行USD4100,100,200\n4800,1002010011,银行存款1,银行存款-建行USD4101,100,200\n4800,1002010012,银行存款2,银行存款-建行USD4102,100,200\n4800,1002010013,银行存款3,银行存款-建行USD4103,100,200\n4800,1002010014,银行存款4,银行存款-建行USD4104,100,200\n4800,1002010015,银行存款5,银行存款-建行USD4105,100,200\n4800,1002010016,银行存款6,银行存款-建行USD4106,100,200\n4800,1002010017,银行存款7,银行存款-建行USD4107,100,200\n4800,1002010018,银行存款8,银行存款-建行USD4108,100,200\n4800,1002010019,银行存款9,银行存款-建行USD4109,100,200\n4800,1002010020,银行存款10,银行存款-建行USD4110,100,200\n4800,1002010021,银行存款11,银行存款-建行USD4111,100,200\n",
        )
        .unwrap();
        // TB 的科目编码被错误地映射到了科目名称列。
        let params = json!({
            "mode":"combined", "reportEnd":"2025-12-31", "fixedEntity":"4800",
            "jeSource":{"inputPath":je, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],
                "accountCode":"会计科目","accountName":"科目文本",
                "currency":"凭证货币","foreignAmount":"凭证金额","functionalAmount":"本位币金额"},
            "tbMapping":{"entity":"公司代码","accountCode":"科目名称","accountName":"科目名称",
                "currencyText":"文本","openingFunctionalAmount":"期初金额",
                "closingFunctionalAmount":"期末金额"}
        });
        let result = check_mapping_alignment(&params).unwrap();
        assert_eq!(
            result.pointer("/fix/tbMapping/accountCode"),
            Some(&json!("科目代码")),
            "应当自己找到取值真正对得上的编码列：{result:#}"
        );
        assert_eq!(
            result["errors"].as_array().map(Vec::len),
            Some(0),
            "找到了可用口径就不该再报错：{result:#}"
        );
        assert!(
            result["warnings"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("已自动改用")))),
            "要告诉用户改用了哪一列：{result:#}"
        );
        fs::remove_file(&je).unwrap();
        fs::remove_file(&tb).unwrap();
    }

    /// 对真实样例跑一遍末级科目与噪声行判定，把剔除结果打印出来供人工验收。
    ///
    /// 与 `tests/mapping_survey.rs` 同属**调查用**测试，默认不跑：
    ///
    /// ```text
    /// LEDGER_SAMPLES=<目录> cargo test --manifest-path src-tauri/Cargo.toml --lib 真实样例的末级科目 -- --ignored --nocapture
    /// ```
    ///
    /// 映射调查只看得到表头落到哪个角色，看不见「哪些行被算进来」——
    /// 而后者才是会静默算错数的那一半。
    #[test]
    #[ignore = "依赖本机样例目录"]
    fn 真实样例的末级科目与噪声行剔除情况() {
        let Ok(dirs) = std::env::var("LEDGER_SAMPLES") else {
            println!("未设置 LEDGER_SAMPLES，跳过");
            return;
        };
        for dir in dirs.split(';') {
            let Ok(entries) = fs::read_dir(dir) else {
                continue;
            };
            let mut files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| matches!(x.to_ascii_lowercase().as_str(), "xlsx" | "xls"))
                })
                .filter(|p| {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    !name.starts_with("~$")
                        && (name.to_lowercase().contains("tb") || name.contains("科目余额"))
                })
                .collect();
            files.sort();
            for path in files {
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let source = SourceSpec {
                    input_path: path.to_string_lossy().into_owned(),
                    sheet: String::new(),
                    header_row: 0,
                    header_depth: 0,
                };
                let Ok(table) = load_fx_table(&source) else {
                    println!("\n══════ {name}：读取失败");
                    continue;
                };
                // 映射走生产入口，保证这里看到的口径和用户看到的一致。
                let Ok(inspected) = crate::engine_call_for_test(
                    "fx.inspect_tb",
                    json!({"source": {"inputPath": path.to_string_lossy()}}),
                ) else {
                    println!("  识别失败");
                    continue;
                };
                let mapping = inspected["suggestedMapping"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                let column_of = |role: &str| mapped_cols(&mapping, role);
                let leaf = ledger_mapping::tb_leaf_mask(&table.headers, &table.rows, &column_of);
                let junk =
                    ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &column_of);
                let total = table.rows.len();
                let kept = leaf.iter().filter(|v| **v).count();
                let junked = junk.iter().filter(|v| !**v).count();
                println!(
                    "\n══════ {name}\n  总行 {total}｜计入 {kept}｜剔除 {}（其中无身份噪声行 {junked}）",
                    total - kept
                );
                // 抽几行被剔除的看看剔得对不对。
                let code = column_of("accountCode")
                    .first()
                    .and_then(|c| table.headers.iter().position(|h| h == c));
                let name_index = column_of("accountName")
                    .first()
                    .and_then(|c| table.headers.iter().position(|h| h == c));
                let cell = |row: &[String], index: Option<usize>| {
                    index
                        .and_then(|i| row.get(i))
                        .map(|v| v.trim().to_owned())
                        .unwrap_or_default()
                };
                for (index, row) in table
                    .rows
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !leaf[*i])
                    .take(6)
                {
                    println!(
                        "    剔除 第{}行  编码={:<14} 名称={}",
                        table.header_row + index + 2,
                        cell(row, code),
                        cell(row, name_index)
                    );
                }
            }
        }
    }

    #[test]
    fn 币种线索列按取值挑而不是按列名挑() {
        // 04／05 号样例：`科目级别描述` 只含「描述」两个字就能命中线索列的
        // 别名，可整列都是 `1002_银行存款` 这种一级科目名，一行都抽不出币种；
        // 真正带「美元户」的是 `科目描述`。线索列是单列角色，按列名挑就抢错了。
        let dir = std::env::temp_dir().join(format!("fx-cuetext-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        fs::write(
            &tb,
            "科目级别,科目级别描述,科目,科目描述,期初余额,期末余额\n\
             1002,1002_银行存款,1002200769,银行存款-中行凉城支行-活期,100,200\n\
             1002,1002_银行存款,1002200770,银行存款-工行外滩支行美元户,300,400\n\
             1002,1002_银行存款,1002200771,银行存款-建行漕河泾支行欧元户,500,600\n",
        )
        .unwrap();
        let inspection = inspect(
            &json!({"source": {"inputPath": tb, "sheet":"", "headerRow":0, "headerDepth":0}}),
            "tb",
        )
        .unwrap();
        assert_eq!(
            inspection.pointer("/suggestedMapping/currencyText"),
            Some(&json!("科目描述")),
            "线索列必须落在真能抽出币种的那一列：{inspection:#}"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tb_currency_may_come_from_account_text_instead_of_a_currency_column() {
        let dir = std::env::temp_dir().join(format!("fx-tbcur-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,文本,期初金额,期末金额\n4800,1002010018,银行存款-建行4150,银行存款-建行USD4150-4800,100,200\n",
        )
        .unwrap();
        let base = json!({
            "mode":"unrealized", "reportEnd":"2025-12-31", "fixedEntity":"4800",
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbMapping":{"entity":"公司代码","accountCode":"科目代码","accountName":"科目名称",
                "openingFunctionalAmount":"期初金额","closingFunctionalAmount":"期末金额"}
        });
        let without_currency = validate_mapping(&base).unwrap();
        assert!(
            without_currency["errors"]
                .as_array()
                .is_some_and(|errors| errors.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("认不出任何外币科目")))),
            "科目名称里没有币种、也没有币种线索列时必须拦下：{without_currency:#}"
        );

        let mut with_text = base.clone();
        with_text["tbMapping"]["currencyText"] = json!("文本");
        let validated = validate_mapping(&with_text).unwrap();
        assert!(
            validated["errors"]
                .as_array()
                .is_some_and(|errors| !errors.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("认不出任何外币科目")))),
            "指定币种线索文本列后应放行：{validated:#}"
        );
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    fn tb无外币但je有汇兑损益时组合模式保留已实现范围() {
        let dir = std::env::temp_dir().join(format!("fx-realized-only-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        let tb = dir.join("tb.csv");
        fs::write(
            &je,
            "公司,凭证号,日期,科目编码,科目名称,本币金额\nE,1,2025-01-31,6603,汇兑损益,10\n",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司,科目编码,科目名称,期初余额,期末余额\nE,1001,库存现金,100,100\n",
        )
        .unwrap();
        let validated = validate_mapping(&json!({
            "mode":"combined", "reportEnd":"2025-12-31", "fixedEntity":"E",
            "jeSource":{"inputPath":je, "sheet":"", "headerRow":1, "headerDepth":1},
            "jeMapping":{"entity":"公司", "id":"凭证号", "date":"日期",
                "accountCode":"科目编码", "accountName":"科目名称", "functionalAmount":"本币金额"},
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbMapping":{"entity":"公司", "accountCode":"科目编码", "accountName":"科目名称",
                "openingFunctionalAmount":"期初余额", "closingFunctionalAmount":"期末余额"}
        }))
        .unwrap();
        assert!(
            !validated["errors"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("TB 认不出任何外币科目")))),
            "JE 的已实现范围不应被无外币 TB 一并拦下：{validated:#}"
        );
        assert!(
            validated["warnings"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("只测算 JE 中的已实现")))),
            "应明确提示未实现范围不出具结论：{validated:#}"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn 仅未实现模式下je没有外币列时不再拦原币必填() {
        // 用户场景：TB 里有外币信息，序时账是本位币记账、没有原币币种和
        // 原币金额列。仅未实现模式下 JE 只是月度重估的辅助，外币行识别
        // 不出会自然跳过；原币两件套不再必填。已实现／组合模式仍要拦。
        let dir = std::env::temp_dir().join(format!("fx-jeonly-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        fs::write(
            &je,
            concat!(
                "公司,凭证号,日期,科目编码,科目名称,摘要,本币金额\n",
                "E,1,2025-03-01,1002,银行存款,收款,700\n",
                "E,2,2025-03-02,1002,银行存款,付款,-200\n",
                "E,3,2025-03-03,1002,银行存款,手续费,-12\n",
                "E,4,2025-03-04,1002,银行存款,利息,3\n",
            ),
        )
        .unwrap();
        let tb = dir.join("tb.csv");
        fs::write(
            &tb,
            concat!(
                "公司代码,科目代码,科目名称,币种,期初余额,期末余额\n",
                "E,1002,银行存款,USD,100,200\n",
                "E,1002,银行存款,CNY,300,400\n",
                "E,100201,银行存款-美元户,USD,100,200\n",
                "E,100201,银行存款-人民币户,CNY,300,400\n",
            ),
        )
        .unwrap();
        let params = |mode: &str| {
            json!({
                "mode":mode, "reportEnd":"2025-12-31", "fixedEntity":"E",
                "jeSource":{"inputPath":je, "sheet":"", "headerRow":1, "headerDepth":1},
                "jeMapping":{"entity":"公司","id":"凭证号","date":"日期",
                    "accountCode":"科目编码","accountName":"科目名称","summary":"摘要",
                    "functionalAmount":"本币金额"},
                "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
                "tbMapping":{"entity":"公司代码","accountCode":"科目代码","accountName":"科目名称",
                    "currency":"币种","openingFunctionalAmount":"期初余额","closingFunctionalAmount":"期末余额"}
            })
        };
        let unrealized = validate_mapping(&params("unrealized")).unwrap();
        assert_eq!(
            unrealized["valid"], true,
            "仅未实现模式下无外币列的 JE 不再拦原币必填：{unrealized:#}"
        );
        assert!(
            !unrealized["errors"].as_array().is_some_and(|errors| errors
                .iter()
                .any(|item| item.as_str().is_some_and(|text| text.contains("原币")))),
            "{unrealized:#}"
        );
        let combined = validate_mapping(&params("combined")).unwrap();
        assert!(
            combined["errors"].as_array().is_some_and(|errors| errors
                .iter()
                .any(|item| item.as_str().is_some_and(|text| text.contains("原币")))),
            "已实现／组合模式口径不变，原币币种仍必填：{combined:#}"
        );
        // 反向防线：仅未实现模式下 JE 若映射了币种、原币金额记法不成立，
        // 仍然要拦——月度测算会把外币变动当 0。
        let mut with_currency = params("unrealized");
        with_currency["jeMapping"]["currency"] = json!("本币金额");
        let blocked = validate_mapping(&with_currency).unwrap();
        assert!(
            blocked["errors"]
                .as_array()
                .is_some_and(|errors| errors.iter().any(|item| item
                    .as_str()
                    .is_some_and(|text| text.contains("原币金额记法不成立")))),
            "币种已映射时原币金额记法仍须成立：{blocked:#}"
        );
        fs::remove_file(&je).unwrap();
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    fn tb_self_rollforward_is_a_warning_never_a_block() {
        let dir = std::env::temp_dir().join(format!("fx-tbselftie-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        // 第2行平衡；第3行是借贷方向记法的负债科目（带符号 期初-100＋借0−贷50＝期末-150，
        // 也平衡）；第4行故意不平——期初＋借−贷＝120，期末却写着60，模拟期初/期末列拿反。
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,币种,方向,期初余额,本年累计借方,本年累计贷方,期末余额\n\
             E,1002,银行存款,USD,借,100,50,20,130\n\
             E,2202,应付账款,USD,贷,100,0,50,150\n\
             E,1122,应收账款,USD,借,100,30,10,60\n",
        )
        .unwrap();
        let params = json!({
            "mode":"unrealized", "reportEnd":"2025-12-31", "fixedEntity":"E",
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbMapping":{
                "entity":"公司代码","accountCode":"科目代码","accountName":"科目名称",
                "currency":"币种","direction":"方向",
                "openingFunctionalAmount":"期初余额",
                "ytdFunctionalDebit":"本年累计借方",
                "ytdFunctionalCredit":"本年累计贷方",
                "closingFunctionalAmount":"期末余额"
            }
        });
        let result = validate_mapping(&params).unwrap();
        let warnings: Vec<&str> = result["warnings"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let tie_out = warnings
            .iter()
            .find(|text| text.contains("TB 自身勾稽"))
            .expect("不平的行必须产生提示");
        assert!(
            tie_out.contains("1 / 3行")
                && tie_out.contains("第4行")
                && tie_out.contains("1122 应收账款"),
            "只报不平的那一行，带行号与科目：{tie_out}"
        );
        assert!(
            !tie_out.contains("第2行") && !tie_out.contains("第3行"),
            "平衡行与借贷方向记法不得误报：{tie_out}"
        );
        assert_eq!(
            result["valid"],
            json!(true),
            "自勾稽只提示不拦截：{result:#}"
        );
        assert!(
            result["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .all(|text| !text.contains("TB 自身勾稽")),
            "提示不得混进错误清单：{result:#}"
        );
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    fn tb_self_rollforward_reuses_signed_side_amounts_and_honours_row_mask() {
        let dir = std::env::temp_dir().join(format!("fx-tbselfsign-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        fs::write(
            &tb,
            "科目编码,科目名称,期初借方,期初贷方,本年借方,本年贷方,期末借方,期末贷方,原币期初借方,原币期初贷方,原币本年借方,原币本年贷方,原币期末借方,原币期末贷方\n\
             1001,库存现金,984.30,0,76361.92,-77346.22,0,0,10,0,5,-2,13,0\n\
             1002,银行存款,100,0,20,-30,80,0,20,0,1,-1,20,0\n",
        )
        .unwrap();
        let source: SourceSpec = serde_json::from_value(json!({
            "inputPath": tb,
            "sheet": "",
            "headerRow": 1,
            "headerDepth": 1
        }))
        .unwrap();
        let table = load_fx_table(&source).unwrap();
        let mapping = json!({
            "accountCode":"科目编码",
            "accountName":"科目名称",
            "openingFunctionalDebit":"期初借方",
            "openingFunctionalCredit":"期初贷方",
            "ytdFunctionalDebit":"本年借方",
            "ytdFunctionalCredit":"本年贷方",
            "closingFunctionalDebit":"期末借方",
            "closingFunctionalCredit":"期末贷方",
            "openingForeignDebit":"原币期初借方",
            "openingForeignCredit":"原币期初贷方",
            "ytdForeignDebit":"原币本年借方",
            "ytdForeignCredit":"原币本年贷方",
            "closingForeignDebit":"原币期末借方",
            "closingForeignCredit":"原币期末贷方",
            "__signConvention":"signed"
        })
        .as_object()
        .unwrap()
        .clone();

        let all = tb_self_rollforward(&table, &mapping);
        assert_eq!(all[0].checked, 2);
        assert_eq!(all[0].issues.len(), 1);
        assert_eq!(all[0].issues[0].source_row, 3);
        assert_eq!(all[0].issues[0].credit, 30.0);

        let filtered = tb_self_rollforward_with_mask(&table, &mapping, Some(&[true, false]));
        assert_eq!(filtered[0].checked, 1);
        assert!(filtered[0].issues.is_empty());
        assert_eq!(filtered[1].unit, "原币");
        assert_eq!(filtered[1].checked, 2, "本位币 mask 不得过滤原币勾稽");
        assert!(filtered[1].issues.is_empty());
        fs::remove_file(&tb).unwrap();
    }

    /// 外币敞口按「有没有原币」判，不按凭证货币的种类数数。
    ///
    /// 取自 4800 真实数据的三种形态：
    ///   甲 原币恒为零的币种混进来（应付账款-关联方：5.4 亿人民币敞口 ＋ 51 行
    ///      原币为零的日元记录）——日元不算敞口，但该科目沉淀了本位币，仍要隔离；
    ///   乙 影子科目（外币评估调整）：所有币种原币都是零，不持有外币；
    ///   丙 干净的单外币科目：照常测算。
    #[test]
    fn 外币敞口只认有原币的币种且混合本位币的科目必须隔离() {
        let dir = std::env::temp_dir().join(format!("fx-exposure-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let je = dir.join("je.csv");
        let tb = dir.join("tb.csv");
        // 本位币 USD。三个科目：
        //   2202010001 人民币敞口 ＋ 原币为零的日元 ＋ 沉淀的美元本位币
        //   2202010002 影子科目：人民币、日元凭证，原币全为零
        //   1002010021 干净的港币户
        //   2202030101 纯本位币科目，外币行一借一贷抵平（净额为零）
        fs::write(
            &je,
            "公司,日期,凭证号,科目,币种,原币,本位币
             4800,2025-01-05,1,2202010001,CNY,540285789.31,75759407.33
             4800,2025-02-05,2,2202010001,JPY,0,-4136.15
             4800,2025-03-05,3,2202010001,USD,-47993736.67,-47993736.67
             4800,2025-01-06,4,2202010002,CNY,0,-3848968.73
             4800,2025-02-06,5,2202010002,JPY,0,4136.14
             4800,2025-01-07,6,1002010021,HKD,121826.91,15580.51
             4800,2025-01-08,7,2202030101,USD,-1719949.22,-1719949.22
             4800,2025-02-08,8,2202030101,CNY,5000,700
             4800,2025-03-08,9,2202030101,CNY,-5000,-700
",
        )
        .unwrap();
        fs::write(
            &tb,
            "公司,科目,期初本位币,期末本位币
             4800,2202010001,-100000000,-189839178.25
             4800,2202010002,0,3621343.35
             4800,1002010021,0,15580.51
             4800,2202030101,0,-4500535.87
",
        )
        .unwrap();
        let params = json!({
            "reportStart":"2025-01-01", "reportEnd":"2025-12-31",
            "fixedEntity":"4800", "entityCurrencies":{"4800":"USD"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "tbSource":{"inputPath":tb,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"公司","date":"日期","id":["凭证号"],"account":["科目"],
                "currency":"币种","foreignAmount":"原币","functionalAmount":"本位币"},
            "tbMapping":{"entity":"公司","account":["科目"],
                "openingFunctionalAmount":"期初本位币","closingFunctionalAmount":"期末本位币"},
            "accountRoles":{"2202010001":"monetary_liability",
                "2202010002":"monetary_liability","1002010021":"cash",
                "2202030101":"monetary_liability"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("外币敞口只认有原币的币种"),
            start_date: "2025-01-01".into(),
            end_date: "2025-12-31".into(),
            rates: ["2025-01-01", "2025-12-31"]
                .iter()
                .flat_map(|date| {
                    [("USD", 7.2), ("CNY", 1.0), ("HKD", 0.92), ("JPY", 0.048)]
                        .into_iter()
                        .map(move |(code, rate)| RatePoint {
                            requested_date: (*date).into(),
                            published_date: (*date).into(),
                            currency: code.into(),
                            cny_per_unit: rate,
                        })
                })
                .collect(),
            missing: Vec::new(),
        };
        let tb_table =
            load_fx_table(&serde_json::from_value(params["tbSource"].clone()).unwrap()).unwrap();
        let tb_mapping = mapping_obj(&params, "tbMapping");
        let (_rows, quality) = calculate_inferred_opening_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
            &tb_table,
            &tb_mapping,
            &[],
            &[],
            &account_match_policy(&params).unwrap(),
        )
        .unwrap();
        // 按「科目＋问题类型」精确查，不能只按科目——同一个科目在后续的月度
        // 测算里还会留下别的记录，只看第一条会张冠李戴。
        let has_issue = |account: &str, kind: &str| {
            quality.iter().any(|item| {
                item["account"].as_str() == Some(account) && item["type"].as_str() == Some(kind)
            })
        };
        let issue_of = |account: &str, kind: &str| -> Value {
            quality
                .iter()
                .find(|item| {
                    item["account"].as_str() == Some(account) && item["type"].as_str() == Some(kind)
                })
                .cloned()
                .unwrap_or_else(|| panic!("{account} 应当留下「{kind}」记录：{quality:#?}"))
        };
        // 甲：日元原币恒为零，不该再被判成「多种外币」；真正的障碍是沉淀了本位币。
        let mixed = issue_of("2202010001", "科目余额混合本位币与外币");
        assert_eq!(mixed["currency"], "CNY");
        assert!(
            mixed["detail"]
                .as_str()
                .unwrap_or("")
                .contains("按币种拆分"),
            "要告诉用户补什么资料：{mixed:#}"
        );
        assert!(
            !has_issue("2202010001", "同一科目存在多种外币敞口"),
            "原币为零的日元不构成敞口，不该报成多币种：{quality:#?}"
        );
        // 乙：影子科目所有币种原币都是零，归到「原币金额全为零」。
        let shadow = issue_of("2202010002", "外币凭证原币金额全为零");
        assert!(
            shadow["detail"]
                .as_str()
                .unwrap_or("")
                .contains("原币金额全部为 0"),
            "文案只陈述原币为零的事实，不下评估调整的判语：{shadow:#}"
        );
        // 丙、丁：干净的港币户和纯本位币科目都不该被报成粒度问题。
        // 2202030101 的外币行一借一贷抵平（净额为零），它只是个本位币科目——
        // 按累计绝对值判敞口会把这类科目误报，实测 4800 有 5 个。
        for account in ["1002010021", "2202030101"] {
            for kind in [
                "科目余额混合本位币与外币",
                "同一科目存在多种外币敞口",
                "外币凭证原币金额全为零",
            ] {
                assert!(
                    !has_issue(account, kind),
                    "{account} 不该被报成「{kind}」：{quality:#?}"
                );
            }
        }
        fs::remove_file(&je).unwrap();
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    fn tb_self_rollforward_skips_incomplete_schemes() {
        let dir = std::env::temp_dir().join(format!("fx-tbselftie2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        // 没映射本年累计借贷列，或只有单边借方——四样不齐就不做自勾稽，
        // 否则会把“期初=期末”当成勾稽失败大面积误报。
        fs::write(
            &tb,
            "公司代码,科目代码,科目名称,币种,期初余额,期末金额,本年累计借方\n\
             E,1002,银行存款,USD,100,60,30\n",
        )
        .unwrap();
        let params = json!({
            "mode":"unrealized", "reportEnd":"2025-12-31", "fixedEntity":"E",
            "tbSource":{"inputPath":tb, "sheet":"", "headerRow":1, "headerDepth":1},
            "tbMapping":{
                "entity":"公司代码","accountCode":"科目代码","accountName":"科目名称",
                "currency":"币种",
                "openingFunctionalAmount":"期初余额",
                "closingFunctionalAmount":"期末金额",
                "ytdFunctionalDebit":"本年累计借方"
            }
        });
        let result = validate_mapping(&params).unwrap();
        assert!(
            !result["warnings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|text| text.contains("TB 自身勾稽")),
            "借贷发生额缺一边时必须跳过自勾稽：{result:#}"
        );
        fs::remove_file(&tb).unwrap();
    }

    #[test]
    #[ignore = "uses the user's immutable 4800 JE/TB customer samples"]
    fn real_4800_je_and_tb_line_up_on_account_code_without_any_fix() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let je_source = json!({
            "inputPath": root.join("4800_JE_2025.01-12.xlsx"),
            "sheet":"", "headerRow":0, "headerDepth":0
        });
        let tb_source = json!({
            "inputPath": root.join("TB-4800.xlsx"),
            "sheet":"", "headerRow":0, "headerDepth":0
        });
        let je = inspect(&json!({"source": je_source}), "je").unwrap();
        let tb = inspect(&json!({"source": tb_source}), "tb").unwrap();
        let params = json!({
            "jeSource": je_source, "jeMapping": je["suggestedMapping"],
            "tbSource": tb_source, "tbMapping": tb["suggestedMapping"]
        });
        let result = check_mapping_alignment(&params).unwrap();
        assert_eq!(
            result["errors"],
            json!([]),
            "脚本自动映射出来的科目编码本来就是同一套：{result:#}"
        );
        assert_eq!(
            result.pointer("/fix/jeMapping/accountCode"),
            None,
            "科目编码本来就对得上，不该被改动：{result:#}"
        );
        // TB 的“科目名称一级/二级”是分类层级，和 JE 的科目文本不是一套东西；
        // 真正同口径的是 TB 的“文本”列，工具应当自己发现并改过去。
        assert_eq!(
            result.pointer("/fix/tbMapping/accountName"),
            Some(&json!("文本")),
            "{result:#}"
        );
        assert_eq!(
            result.pointer("/fix/jeMapping/accountName"),
            Some(&json!("科目文本")),
            "{result:#}"
        );
    }

    #[test]
    fn huge_csv_inspection_reads_only_a_bounded_sample() {
        let root =
            std::env::temp_dir().join(format!("fx-huge-csv-inspection-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("je.csv");
        let mut text = String::from("日期,凭证号,科目编码,科目名称,币种,原币,本位币\n");
        for index in 0..300 {
            text.push_str(&format!("2025-01-01,{index},1002,银行存款,USD,1,7.2\n"));
        }
        fs::write(&path, text).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(2 * 1024 * 1024 * 1024)
            .unwrap();
        let table = load_fx_inspection_table(&SourceSpec {
            input_path: path.to_string_lossy().into_owned(),
            sheet: String::new(),
            header_row: 1,
            header_depth: 1,
        })
        .unwrap();
        assert!(table.sampled);
        assert_eq!(table.rows.len(), 255);
        assert_eq!(table.headers[0], "日期");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "uses the user's immutable 4800 large JE customer sample"]
    fn large_4800_je_uses_lightweight_inspection_and_customer_aliases() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let source = json!({"source": {
            "inputPath": root.join("4800_JE_2025.01-12.xlsx"),
            "sheet":"", "headerRow":0, "headerDepth":0
        }});
        let started = std::time::Instant::now();
        let classification = classify_source(&source).unwrap();
        let inspection = inspect(&source, "je").unwrap();
        assert_eq!(classification["kind"], "je");
        assert_eq!(inspection["rowCount"], 368676);
        assert_eq!(
            inspection.pointer("/suggestedMapping/accountCode"),
            Some(&json!("会计科目"))
        );
        assert_eq!(
            inspection.pointer("/suggestedMapping/accountName"),
            Some(&json!(["科目文本"]))
        );
        assert_eq!(
            inspection.pointer("/suggestedMapping/currency"),
            Some(&json!("凭证货币"))
        );
        assert_eq!(
            inspection.pointer("/suggestedMapping/foreignAmount"),
            Some(&json!("凭证金额"))
        );
        assert_eq!(
            inspection.pointer("/suggestedMapping/foreignDirection"),
            Some(&json!("借贷"))
        );
        let tb = inspect(
            &json!({"source": {
                "inputPath": root.join("TB-4800.xlsx"),
                "sheet":"", "headerRow":0, "headerDepth":0
            }}),
            "tb",
        )
        .unwrap();
        assert_eq!(
            tb.pointer("/suggestedMapping/accountCode"),
            Some(&json!("科目代码"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/accountName"),
            Some(&json!(["科目名称一级", "科目名称二级"]))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/currency"),
            None,
            "“货币”列整列 USD，不是逐科目的交易币种，不能占用币种列"
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/functionalCurrency"),
            Some(&json!("货币")),
            "整列同值的币种列就是主体本位币"
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/currencyText"),
            Some(&json!("文本")),
            "4800 的账户币种写在“文本”列里，必须自动指向币种线索列"
        );
        assert_eq!(
            tb.pointer("/uniformCurrency"),
            Some(&json!("USD")),
            "“货币”列整列 USD，应作为主体本位币回给前端预填"
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/openingFunctionalAmount"),
            Some(&json!("期初金额-本位币"))
        );
        assert_eq!(
            tb.pointer("/suggestedMapping/closingFunctionalAmount"),
            Some(&json!("期末金额-本位币"))
        );
        assert!(
            started.elapsed() < StdDuration::from_secs(10),
            "大文件识别不应再全量解压工作表：{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn 月初牌价假设检查_恒定且每月重估时不出提示() {
        // 前置假设成立的干净账：同月两笔美元业务都按当月月初牌价 7.2 入账，
        // 月末有一张 FX 重估凭证（外币不动、只调本位币、对方是汇兑损益科目）。
        // 两组检查都应当安静通过——不出任何条目。
        let root = std::env::temp_dir().join(format!("fx-assume-ok-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-10,B1,SA,1002 银行存款-美元户,收美元货款,USD,100,720\n\
E,2025-01-20,B2,SA,1122 应收账款-美元户,确认美元应收,USD,50,360\n\
E,2025-01-31,R1,FX,1002 银行存款-美元户,月末重估,USD,0,5\n\
E,2025-01-31,R1,FX,6603 财务费用-汇兑损失,月末重估,CNY,0,-5\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{
                "1002 银行存款-美元户":"cash", "1122 应收账款-美元户":"monetary_asset",
                "6603 财务费用-汇兑损失":"fx_gain_loss"
            }
        });
        // 月初牌价优先取上月末牌价点（2024-12-31），1 月两笔业务都按它入账。
        // month_opening_rate 走 rate() 交叉折算，快照必须同时有 CNY 点。
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("月初牌价假设检查_恒定且每月重估时不出提示"),
            start_date: "2024-12-31".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let items = month_start_rate_assumption_checks(&params, &snapshot);
        assert!(items.is_empty(), "假设成立时不应有任何提示：{items:#?}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 月初牌价假设检查_组内入账汇率不恒定出待复核() {
        // 同月两笔美元业务：一笔按月初牌价 7.2、一笔按当日即期 7.0 入账，
        // 极差 0.2 ≥ 0.005 → 整组一条「待复核」，不能逐行刷屏。
        // 月末重估凭证照常存在，检查二不应出条目——两条断言互不干扰。
        let root = std::env::temp_dir().join(format!("fx-assume-mixed-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-10,B1,SA,1002 银行存款-美元户,收美元货款,USD,100,720\n\
E,2025-01-20,B2,SA,1002 银行存款-美元户,收美元货款,USD,100,700\n\
E,2025-01-31,R1,FX,1002 银行存款-美元户,月末重估,USD,0,5\n\
E,2025-01-31,R1,FX,6603 财务费用-汇兑损失,月末重估,CNY,0,-5\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{
                "1002 银行存款-美元户":"cash",
                "6603 财务费用-汇兑损失":"fx_gain_loss"
            }
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("月初牌价假设检查_组内入账汇率不恒定出待复核"),
            start_date: "2024-12-31".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let items = month_start_rate_assumption_checks(&params, &snapshot);
        assert_eq!(items.len(), 1, "每组「公司+币种+月份」最多一条：{items:#?}");
        assert_eq!(items[0]["severity"], json!("待复核"));
        assert_eq!(items[0]["type"], json!("当月入账汇率不恒定"));
        assert_eq!(items[0]["entity"], json!("E"));
        assert_eq!(items[0]["currency"], json!("USD"));
        assert_eq!(items[0]["month"], json!("2025-01"));
        assert!((items[0]["minImpliedRate"].as_f64().unwrap() - 7.0).abs() < 1e-9);
        assert!((items[0]["maxImpliedRate"].as_f64().unwrap() - 7.2).abs() < 1e-9);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 月初牌价假设检查_缺当月重估凭证时按月出提示() {
        // 一、二月都有外币发生额、都没有月末重估凭证 → 每公司每月一条「提示」。
        // 入账汇率分别等于各月月初牌价，检查一保持安静，断言只针对重估缺失。
        let root = std::env::temp_dir().join(format!("fx-assume-noreval-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-10,B1,SA,1002 银行存款-美元户,收美元货款,USD,100,720\n\
E,2025-02-10,B2,SA,1002 银行存款-美元户,收美元货款,USD,50,355\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002 银行存款-美元户":"cash"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("月初牌价假设检查_缺当月重估凭证时按月出提示"),
            start_date: "2024-12-31".into(),
            end_date: "2025-02-28".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let items = month_start_rate_assumption_checks(&params, &snapshot);
        assert_eq!(items.len(), 2, "每公司每月最多一条：{items:#?}");
        assert_eq!(items[0]["month"], json!("2025-01"));
        assert_eq!(items[1]["month"], json!("2025-02"));
        for item in &items {
            assert_eq!(item["severity"], json!("提示"));
            assert_eq!(item["type"], json!("当月未见月末重估凭证"));
            assert_eq!(item["entity"], json!("E"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 购汇与结汇统一按月初牌价与实际成交价测算() {
        // 借：美元户 10000（客户按 7.20 折算 72000）
        // 借：汇兑损失 300（银行卖出价 7.23 与记账汇率 7.20 的价差）
        // 贷：人民币户 72300
        // 统一口径（与结汇方向完全一致，用户拍板成交价差属已实现损益）：
        // 账面＝买入原币×月初牌价 7.15＝71500；成交价＝本位币现金腿合计
        // ÷外币现金腿＝72300÷10000＝7.23（全口径实付，含损益行）；折算＝
        // 10000×7.23＝72300，已实现损失＝72300−71500＝+800（借方为正）。
        // 客户账面确认 300，审计与账面之差 500 经比较列披露；官方牌价 7.20
        // 仅作对照，不进损益公式。
        let root = std::env::temp_dir().join(format!("fx-purchase-unified-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-10,3,AB,1002,购汇,USD,10000,72000\n\
E,2025-01-10,3,AB,1002,购汇,CNY,0,-72300\n\
E,2025-01-10,3,AB,6603,汇兑损失,CNY,0,300\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","6603":"fx_gain_loss"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("购汇与结汇统一按月初牌价与交易日官方牌价测算"),
            start_date: "2024-12-31".into(),
            end_date: "2025-01-10".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.15,
                },
                RatePoint {
                    requested_date: "2024-12-31".into(),
                    published_date: "2024-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2025-01-10".into(),
                    published_date: "2025-01-10".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.2,
                },
                RatePoint {
                    requested_date: "2025-01-10".into(),
                    published_date: "2025-01-10".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot, None).unwrap();
        assert_eq!(classes[0]["classification"], "已实现");
        assert_eq!(calculation.len(), 1, "quality={quality:#?}");
        let row = &calculation[0];
        assert_eq!(
            row["calculationMethod"],
            "外币兑换：月初牌价与实际成交价重算（官方牌价对照）"
        );
        assert!((row["monthOpeningRate"].as_f64().unwrap() - 7.15).abs() < 0.0001);
        assert!((row["officialRate"].as_f64().unwrap() - 7.2).abs() < 0.0001);
        assert!((row["appliedRate"].as_f64().unwrap() - 7.23).abs() < 0.0001);
        assert_eq!(row["rateBasis"], "实际成交价");
        assert!((row["carryingFunctional"].as_f64().unwrap() - 71500.0).abs() < 0.01);
        assert!((row["translatedFunctional"].as_f64().unwrap() - 72300.0).abs() < 0.01);
        assert!((row["auditGainLoss"].as_f64().unwrap() - 800.0).abs() < 0.01);
        assert!((row["customerAppliedRate"].as_f64().unwrap() - 7.2).abs() < 0.0001);
        assert!((row["carryingBasisDifference"].as_f64().unwrap() + 500.0).abs() < 0.01);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 无汇兑损益行的结汇凭证按金额配比认领为已实现() {
        // 用友真实形态：结汇凭证四行全现金、没有汇兑损益科目行，价差埋在
        // 成交价里（2024 真实样例：卖 50 万美元按 7.1907，官方中间价
        // 7.1174，月初牌价 7.0827）。放开 has_fx 门槛后按配比认领：
        // 账面＝500000×7.0827＝3541350；成交价＝3595350÷500000＝7.1907；
        // 折算＝500000×7.1907＝3595350，资产减少方向 gain_loss＝carrying−
        // translated＝−54000＝−(17350官方牌价口径＋36650成交价差)。
        // 同凭证并排的外币收息（外币腿折算 230 vs 本币腿 46445）配比失败，
        // 不认领；投资款本位币腿是非现金权益科目，同样不认领。
        let root =
            std::env::temp_dir().join(format!("fx-no-line-conversion-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2024-01-18,6,记,1002,结汇01.18(USD/CNY7.1907),USD,-500000,-3595350\n\
E,2024-01-18,6,记,1001,结汇01.18(USD/CNY7.1907),CNY,0,3595350\n\
E,2024-03-21,7,记,1002,招行美元户结息,USD,32.42,229.99\n\
E,2024-03-21,7,记,1001,招行基本户结息,CNY,0,46445.85\n\
E,2024-05-09,8,记,1002,收到股东投资款,USD,1000,7100\n\
E,2024-05-09,8,记,4001,收到股东投资款,CNY,0,-7100\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","1001":"cash","4001":"non_monetary"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("无汇兑损益行的结汇凭证按金额配比认领为已实现"),
            start_date: "2023-12-31".into(),
            end_date: "2024-05-09".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2023-12-31".into(),
                    published_date: "2023-12-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.0827,
                },
                RatePoint {
                    requested_date: "2023-12-31".into(),
                    published_date: "2023-12-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
                RatePoint {
                    requested_date: "2024-01-18".into(),
                    published_date: "2024-01-18".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1174,
                },
                RatePoint {
                    requested_date: "2024-01-18".into(),
                    published_date: "2024-01-18".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot, None).unwrap();
        assert_eq!(calculation.len(), 1, "只应认领结汇凭证：{calculation:#?}");
        let row = &calculation[0];
        assert_eq!(
            row["calculationMethod"],
            "外币兑换：月初牌价与实际成交价重算（官方牌价对照）"
        );
        assert!((row["officialRate"].as_f64().unwrap() - 7.1174).abs() < 0.0001);
        assert!((row["monthOpeningRate"].as_f64().unwrap() - 7.0827).abs() < 0.0001);
        assert!((row["appliedRate"].as_f64().unwrap() - 7.1907).abs() < 0.0001);
        assert!((row["carryingFunctional"].as_f64().unwrap() - 3541350.0).abs() < 1.0);
        assert!((row["translatedFunctional"].as_f64().unwrap() - 3595350.0).abs() < 1.0);
        assert!((row["auditGainLoss"].as_f64().unwrap() + 54000.0).abs() < 1.0);
        assert!((row["customerAppliedRate"].as_f64().unwrap() - 7.1907).abs() < 0.0001);
        let class_of = |voucher: &str| {
            classes
                .iter()
                .find(|item| {
                    item["voucherId"]
                        .as_str()
                        .is_some_and(|id| id.ends_with(voucher))
                })
                .and_then(|item| item["classification"].as_str())
                .unwrap_or("?")
        };
        assert_eq!(class_of("6"), "已实现");
        assert_eq!(class_of("7"), "不构成汇兑事项", "并排结息不得被认领为兑换");
        assert_eq!(
            class_of("8"),
            "不构成汇兑事项",
            "投资款本位币腿非现金，不得认领"
        );
        assert!(
            quality
                .iter()
                .any(|item| item["type"] == "外币业务凭证不构成汇兑事项"),
            "剩余候选凭证应有聚合提示：{quality:#?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 无重估文字证据但结构符合的凭证按未实现处理() {
        // 凭证4：类型「记」、摘要「调整」，无任何重估字样；但结构上原币
        // 不动、本位币变化、含汇兑科目 → 直接按未实现识别。摘要与凭证
        // 类型已全部退出认定，「重估凭证无文字证据」提示随之废止。
        // 凭证5：同样结构但类型是 FX → 同样按未实现识别。
        let root = std::env::temp_dir().join(format!("fx-no-text-reval-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let je = root.join("je.csv");
        fs::write(
            &je,
            "公司,日期,凭证号,凭证类型,科目,摘要,币种,原币,本位币\n\
E,2025-01-31,4,记,1002,调整,USD,0,-500\n\
E,2025-01-31,4,记,6603,调整,CNY,0,-500\n\
E,2025-01-31,5,FX,1002,期末重估,USD,0,-300\n\
E,2025-01-31,5,FX,6603,期末重估,CNY,0,-300\n",
        )
        .unwrap();
        let params = json!({
            "fixedEntity":"E", "entityCurrencies":{"E":"CNY"},
            "jeSource":{"inputPath":je,"sheet":"","headerRow":1,"headerDepth":1},
            "jeMapping":{
                "entity":"公司","date":"日期","id":["凭证号"],"voucherType":"凭证类型",
                "account":["科目"],"summary":"摘要","currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币"
            },
            "accountRoles":{"1002":"cash","6603":"fx_gain_loss"}
        });
        let snapshot = RateSnapshot {
            source: "测试".into(),
            source_url: String::new(),
            fetched_at: String::new(),
            response_hash: test_snapshot_hash("无重估文字证据但结构符合的凭证按未实现处理并提示"),
            start_date: "2025-01-31".into(),
            end_date: "2025-01-31".into(),
            rates: vec![
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "USD".into(),
                    cny_per_unit: 7.1,
                },
                RatePoint {
                    requested_date: "2025-01-31".into(),
                    published_date: "2025-01-31".into(),
                    currency: "CNY".into(),
                    cny_per_unit: 1.0,
                },
            ],
            missing: Vec::new(),
        };
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot, None).unwrap();
        assert!(
            calculation.is_empty(),
            "未实现凭证不进已实现测算：{calculation:#?}"
        );
        for class in &classes {
            assert_eq!(class["classification"], "未实现", "{class:#?}");
        }
        assert!(
            !quality.iter().any(|q| q["type"] == "重估凭证无文字证据"),
            "摘要文字提示已废止：{quality:#?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// 调查测试：逐份跑本机 `Downloads\TBJEPBC` 样例 TB，dump 存款利息、
    /// 汇兑损益、看账三套口径的科目识别建议与映射，供补匹配词表时对照。
    ///
    /// ```text
    /// cargo test --manifest-path src-tauri/Cargo.toml pbc_tb_role_audit -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "读取本机 Downloads\\TBJEPBC 样例，仅调查用"]
    fn pbc_tb_role_audit() {
        let base = r"C:\Users\lenovo\Downloads\TBJEPBC";
        let files = [
            "01科目余额表（TB）.xls",
            "02科目余额表.xlsx",
            "03科目余额表.xlsx",
            "04TB.XLSX",
            "05科目余额表.XLSX",
            "06科目余额表_2024.1-3.xlsx",
            "06科目余额表_2024.4-12.xlsx",
            "07科目余额表.xls",
            "08TB.xlsx",
            "09科目余额表-2025.xls",
            "10科目余额表.xlsx",
        ];
        let mut report = serde_json::Map::new();
        for name in files {
            let path = format!(r"{base}\{name}");
            let src = serde_json::json!({"inputPath": path});
            let mut entry = serde_json::Map::new();
            match crate::deposit_interest::call(
                "deposit.inspect_tb",
                serde_json::json!({"source": src}),
            ) {
                Ok(v) => {
                    entry.insert(
                        "deposit".into(),
                        serde_json::json!({
                            "sheet": v["sheet"].clone(),
                            "headerRow": v["headerRow"].clone(),
                            "headers": v["headers"].clone(),
                            "mapping": v["suggestedMapping"].clone(),
                            "accounts": v["accounts"].clone(),
                            "roles": v["suggestedAccountRoles"].clone(),
                            "tiers": v["suggestedAccountTiers"].clone(),
                        }),
                    );
                }
                Err(e) => {
                    entry.insert(
                        "deposit".into(),
                        serde_json::json!({"error": format!("{e:?}")}),
                    );
                }
            }
            match call("fx.inspect_tb", serde_json::json!({"source": src})) {
                Ok(ins) => {
                    let mapping = ins["suggestedMapping"].clone();
                    let roles = call(
                        "fx.account_roles",
                        serde_json::json!({"tbSource": src, "tbMapping": mapping}),
                    )
                    .map(|r| r["accounts"].clone())
                    .unwrap_or_else(|e| serde_json::json!({"error": format!("{e:?}")}));
                    entry.insert(
                        "fx".into(),
                        serde_json::json!({"mapping": mapping, "roles": roles}),
                    );
                }
                Err(e) => {
                    entry.insert("fx".into(), serde_json::json!({"error": format!("{e:?}")}));
                }
            }
            // 看账改走标题行自动探测（0）：真实路径里前端默认也传 0。
            match crate::tabular::call(
                "kanzhang.accounts",
                serde_json::json!({
                    "inputPath": path,
                    "all": true,
                    "headerRow": 0,
                }),
            ) {
                Ok(v) => {
                    entry.insert(
                        "kanzhang".into(),
                        serde_json::json!({
                            "values": v["values"].clone(),
                            "codes": v["codes"].clone(),
                        }),
                    );
                }
                Err(e) => {
                    entry.insert(
                        "kanzhang".into(),
                        serde_json::json!({"error": format!("{e:?}")}),
                    );
                }
            }
            report.insert(name.into(), serde_json::Value::Object(entry));
        }
        let out = std::env::temp_dir().join("pbc_tb_audit.json");
        std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!("report -> {}", out.display());
    }
}

#[cfg(test)]
mod bench_load {
    use super::*;
    use std::time::Instant;

    /// 量一下 36 万行序时账各阶段的耗时，决定读表层要不要跟看账一样上 Parquet 缓存。
    ///
    /// ```text
    /// cargo test --release --lib bench_load -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "依赖本机大样例，性能调查用"]
    fn 大序时账各阶段耗时() {
        // 样例目录用 LEDGER_SAMPLES 覆盖，默认取仓库同级的汇兑损益测试资料。
        let dir = std::env::var("LEDGER_SAMPLES").unwrap_or_else(|_| {
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            format!("{home}/Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料")
        });
        let path = std::path::PathBuf::from(dir).join("4800_JE_2025.01-12.xlsx");
        if !path.is_file() {
            println!("BENCH 找不到样例");
            return;
        }
        let spec = SourceSpec {
            input_path: path.to_string_lossy().to_string(),
            sheet: String::new(),
            header_row: 0,
            header_depth: 0,
        };
        let t = Instant::now();
        let table = load_fx_table(&spec).expect("读表应当成功");
        println!(
            "BENCH 解析Excel(calamine): {:?}   {} 行 × {} 列",
            t.elapsed(),
            table.rows.len(),
            table.headers.len()
        );
        let t = Instant::now();
        let rows = records(&table);
        println!(
            "BENCH 建行记录(records): {:?}   {} 条",
            t.elapsed(),
            rows.len()
        );
        let mapping = json!({"date":"记帐日期","id":"凭证号码","accountCode":"会计科目"})
            .as_object()
            .unwrap()
            .clone();
        let t = Instant::now();
        let mut n = 0usize;
        for row in &rows {
            if !cell(row, &mapping, "date").is_empty() {
                n += 1;
            }
            let _ = cell(row, &mapping, "accountCode");
            let _ = voucher_id(row, &mapping, &Value::Null);
        }
        println!("BENCH 逐行取值×3: {:?}   有效 {n} 行", t.elapsed());
    }
}
