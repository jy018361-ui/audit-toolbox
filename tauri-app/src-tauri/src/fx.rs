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
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
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

fn cached_preview(token: &str) -> Option<Value> {
    FX_PREVIEW_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .as_ref()
                .filter(|(cached_token, _)| cached_token == token)
                .map(|(_, result)| result.clone())
        })
}

fn store_preview(token: String, result: Value) {
    if let Ok(mut cache) = FX_PREVIEW_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = Some((token, result));
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
struct RowRecord<'a> {
    source_row: usize,
    values: HashMap<&'a str, &'a str>,
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
    let mut book = open_workbook_auto(path).map_err(|e| {
        error(
            "SOURCE_READ_FAILED",
            "无法读取分类调整底稿。",
            Some(e.to_string()),
        )
    })?;
    let range = book.worksheet_range("分类调整").map_err(|e| {
        error(
            "SOURCE_READ_FAILED",
            "Excel中未找到“分类调整”页。",
            Some(e.to_string()),
        )
    })?;
    let mut rows = range.rows();
    let headers = rows
        .next()
        .map(|row| row.iter().map(data_text).collect::<Vec<_>>())
        .ok_or_else(|| error("SOURCE_READ_FAILED", "分类调整页为空。", None))?;
    let column = |name: &str| {
        headers
            .iter()
            .position(|header| header.trim() == name)
            .ok_or_else(|| {
                error(
                    "SOURCE_READ_FAILED",
                    format!("分类调整页缺少“{name}”列。"),
                    None,
                )
            })
    };
    let classification_column = column("用户调整分类")?;
    let voucher_ids_column = column("_凭证ID清单")?;
    let mut classifications = Map::new();
    for row in rows {
        let classification = row
            .get(classification_column)
            .map(data_text)
            .unwrap_or_default();
        if !matches!(
            classification.as_str(),
            "已实现汇兑损益" | "未实现汇兑损益" | "待确认"
        ) {
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
        ("foreignAmount", 2.0, "原币发生额"),
        ("functionalAmount", 2.0, "本位币发生额"),
    ] {
        if mapped(&je, role, 0.55) {
            je_score += weight;
            je_reasons.push(label);
        }
    }
    if header_has(&["document type", "凭证类型", "voucher type"]) {
        je_score += 1.0;
        je_reasons.push("凭证类型");
    }
    for (role, weight, label) in [
        ("accountCode", 2.0, "科目"),
        ("entity", 1.0, "公司"),
        ("currency", 1.0, "币种"),
        ("closingFunctionalAmount", 3.0, "期末/累计余额"),
        ("openingFunctionalAmount", 2.0, "期初余额"),
    ] {
        if mapped(&tb, role, 0.55) {
            tb_score += weight;
            tb_reasons.push(label);
        }
    }
    if header_has(&["ytd", "trial balance", "期末余额", "年末余额", "科目余额"]) {
        tb_score += 2.0;
        tb_reasons.push("余额表特征");
    }
    let (kind, confidence, reasons) = if je_score >= tb_score {
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
            detect_and_inject_sign_conventions(&mut params);
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
            let mut result = if supplied_token == expected_token {
                if let Some(result) = cached_preview(supplied_token) {
                    progress("reuse_preview", 3, 5, "正在复用已完成的测算预览结果…");
                    result
                } else {
                    progress(
                        "calculate",
                        1,
                        5,
                        "测算预览缓存已失效，正在重新执行汇兑损益测算…",
                    );
                    calculate(&export_params, progress, &cancel, pause)?
                }
            } else {
                progress(
                    "calculate",
                    1,
                    5,
                    "数据或参数已发生变化，正在重新执行汇兑损益测算…",
                );
                calculate(&export_params, progress, &cancel, pause)?
            };
            checkpoint(&cancel, pause)?;
            // 明细在测算阶段被跳过了（预览用不上），落表前补算。
            if result
                .get("jeDetail")
                .and_then(Value::as_array)
                .is_none_or(|all| all.is_empty())
            {
                progress("export", 3, 5, "正在整理JE完整明细…");
                let detail = build_je_detail(&export_params)?;
                if let Some(object) = result.as_object_mut() {
                    object.insert("jeDetail".into(), Value::Array(detail));
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
    pause.wait()
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
    mark_account_name_as_currency_text(&table, kind, &mut mapping);
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

fn xlsx_sample_rows(
    prefix: &str,
    shared: &[String],
    dimension_width: usize,
    date_styles: &HashSet<usize>,
    epoch_1904: bool,
) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for fragment in prefix.split("<row ").skip(1) {
        let Some((row_xml, _)) = fragment.split_once("</row>") else {
            break;
        };
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
        rows.push(row);
    }
    rows
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
    let mut best: Option<(String, Vec<Vec<String>>, usize, f64)> = None;
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
        let score = (0..rows.len().min(30))
            .map(|index| header_score(&rows, index))
            .fold(0.0_f64, f64::max);
        if best.as_ref().is_none_or(|current| score > current.3) {
            best = Some((name.clone(), rows, total_rows, score));
        }
    }
    let (sheet, all, total_rows, _) =
        best.ok_or_else(|| error("SOURCE_EMPTY", "工作簿中没有可读取的数据Sheet。", None))?;
    let mut scored = (0..all.len().min(30))
        .map(|index| (index + 1, header_score(&all, index)))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        scored.first().map(|value| value.0).unwrap_or(1)
    };
    let h = header_row.saturating_sub(1);
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let inferred_depth = if h + 1 < all.len()
        && combined_semantic_score(&all[h], &all[h + 1]) > semantic_hits(&all[h]) + 2
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
        .map(|row| pad(row, width))
        .collect::<Vec<_>>();
    let headers = merge_headers(&raw_headers, width);
    let rows = all[(h + depth).min(all.len())..]
        .iter()
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
        row_count: total_rows.saturating_sub(h + depth),
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
    if !large_xlsx {
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
    let table = load_large_xlsx_inspection(source, &path)?;
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
    let (sheet, sheets, all) = if matches!(ext.as_str(), "csv" | "txt" | "tsv") {
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
                    .map(|index| header_score(&values, index))
                    .fold(0.0_f64, f64::max);
                let populated = values
                    .iter()
                    .filter(|row| row.iter().filter(|value| !value.trim().is_empty()).count() >= 2)
                    .count();
                let score = header + (populated.min(1000) as f64 / 1000.0) * 0.08;
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
    let mut scored = (0..all.len().min(30))
        .map(|i| (i + 1, header_score(&all, i)))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        scored.first().map(|x| x.0).unwrap_or(1)
    };
    if header_row > all.len() {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let h = header_row - 1;
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let inferred_depth = if h + 1 < all.len()
        && combined_semantic_score(&all[h], &all[h + 1]) > semantic_hits(&all[h]) + 2
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
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
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
    let bytes = fs::read(path).map_err(|e| {
        error(
            "SOURCE_READ_FAILED",
            "无法读取文本文件。",
            Some(e.to_string()),
        )
    })?;
    let text = String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| encoding_rs::GBK.decode(&bytes).0.into_owned());
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let delimiter = [
        (b',', first.matches(',').count()),
        (b'\t', first.matches('\t').count()),
        (b';', first.matches(';').count()),
        (b'|', first.matches('|').count()),
    ]
    .into_iter()
    .max_by_key(|x| x.1)
    .map(|x| x.0)
    .unwrap_or(b',');
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(text.as_bytes());
    reader
        .records()
        .map(|r| {
            r.map(|v| v.iter().map(str::to_owned).collect())
                .map_err(|e| {
                    error(
                        "SOURCE_READ_FAILED",
                        "文本表格格式无效。",
                        Some(e.to_string()),
                    )
                })
        })
        .collect()
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

fn header_score(all: &[Vec<String>], i: usize) -> f64 {
    let row = &all[i];
    let n = row.len().max(1) as f64;
    let non = row.iter().filter(|v| !v.trim().is_empty()).count() as f64;
    let text = row
        .iter()
        .filter(|v| !v.trim().is_empty() && strict_number(v).is_err())
        .count() as f64;
    let unique = row
        .iter()
        .filter(|v| !v.trim().is_empty())
        .map(|v| normalize_header(v))
        .collect::<HashSet<_>>()
        .len() as f64;
    let hits = semantic_hits(row) as f64;
    let next = all
        .get(i + 1)
        .map(|r| {
            r.iter()
                .filter(|v| strict_number(v).ok().flatten().is_some() || parse_date(v).is_some())
                .count() as f64
                / r.len().max(1) as f64
        })
        .unwrap_or(0.0);
    (non / n) * 0.22
        + (text / non.max(1.0)) * 0.18
        + (unique / non.max(1.0)) * 0.12
        + (hits.min(8.0) / 8.0) * 0.36
        + next * 0.12
}

fn semantic_hits(row: &[String]) -> usize {
    let words = [
        "凭证",
        "日期",
        "科目",
        "公司",
        "主体",
        "币种",
        "原币",
        "外币",
        "本位币",
        "本币",
        "期初",
        "年初",
        "期末",
        "年末",
        "借方",
        "贷方",
        "余额",
        "金额",
        "摘要",
        "currency",
        "account",
        "entity",
        "date",
        "amount",
        "debit",
        "credit",
    ];
    row.iter()
        .map(|v| {
            let n = normalize_header(v);
            words.iter().filter(|w| n.contains(*w)).count()
        })
        .sum()
}

fn combined_semantic_score(a: &[String], b: &[String]) -> usize {
    let width = a.len().max(b.len());
    semantic_hits(
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

/// 角色表来自统一内核，另加汇兑损益的专属角色。
///
/// 与旧版的两处实质差别：
/// 1. **借贷方向只有一个 `direction`**，不再分原币/本位币——一条分录的借贷方向
///    对两个口径必然相同，不存在原币记借方、本位币记贷方的情况；
/// 2. TB 多了本年累计发生额与期初/期末方向列，覆盖实务里的六种余额表形态。
fn roles(kind: &str) -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    let mut out: Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> =
        ledger_mapping::roles(kind)
            .iter()
            .map(|role| (role.name, role.aliases.to_vec(), role.conflicts.to_vec()))
            .collect();
    // 辅助核算只进余额键，影响 TB↔JE 勾稽的粒度；重估本身按科目＋币种做，
    // 同一科目同一币种的余额拆成几个客户，乘的是同一个汇率，结果不变。
    out.push((
        "auxiliary",
        vec![
            "辅助核算",
            "辅助項",
            "辅助项",
            "往来单位",
            "往來單位",
            "客户",
            "客戶",
            "供应商",
            "供應商",
            "银行账号",
            "counterparty",
            "assignment",
            "profit center",
            "profitcenter",
        ],
        vec!["科目", "account", "金额", "amount"],
    ));
    out
}

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

/// 科目名称列同时就是币种线索列——两者可以重叠。
///
/// 很多余额表没有单独的文本列，账户币种就写在科目名称里（`银行存款-中行朝阳支行美元户`）。
/// 取数时本来就会「先看币种线索列，没有就看科目名称」，但映射面板上不显示这层关系，
/// 用户不知道币种是从哪认出来的。这里在科目名称**确实能抽出币种**时把它一并标上，
/// 让这条线索在界面上看得见。抽不出币种就不标，免得凭空多一个空映射。
fn mark_account_name_as_currency_text(
    table: &FxTable,
    kind: &str,
    mapping: &mut Map<String, Value>,
) {
    if kind != "tb" || mapping.contains_key("currencyText") {
        return;
    }
    let columns = mapped_cols(mapping, "accountName");
    let indexes: Vec<usize> = columns
        .iter()
        .filter_map(|c| table.headers.iter().position(|h| h == c))
        .collect();
    if indexes.is_empty() {
        return;
    }
    // 最明细的那一级科目名称最可能带账户币种，从后往前找第一个抽得出币种的列。
    for (column, index) in columns.iter().zip(indexes.iter()).rev() {
        let hit = table
            .rows
            .iter()
            .take(2000)
            .filter_map(|row| row.get(*index))
            .any(|text| currency_from_text(text).is_some());
        if hit {
            mapping.insert("currencyText".into(), Value::String(column.clone()));
            return;
        }
    }
}

fn suggest_mappings(table: &FxTable, kind: &str) -> BTreeMap<String, Vec<Candidate>> {
    let profiles = column_profiles(table);
    let mut out = BTreeMap::new();
    for (role, aliases, conflicts) in roles(kind) {
        let mut choices = table
            .headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let n = normalize_header(h);
                // 双语表头「科目描述 Description」整体不等于别名，但其中一段正好是，
                // 与完全相等同等看待——否则它只能拿到「包含」那一档的低分。
                let exact = aliases
                    .iter()
                    .filter(|a| n == normalize_header(a))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                // 双语表头「科目描述 Description」整体不等于别名，但其中一段正好是。
                // 比「表头包含别名」可信，又不该压过整体相等——否则
                // `Company Code Currency Key`（段含 currency）会抢走
                // `Document Currency Key`（整体就是这个别名）的位置。
                let segment = aliases
                    .iter()
                    .filter(|a| ledger_mapping::segment_exact(h, a))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let partial = aliases
                    .iter()
                    // A short header such as “原币” must not fan out to
                    // “原币借方/原币贷方”. Only let a real header contain a
                    // complete alias, never the other way around.
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let bad = conflicts
                    .iter()
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let mut score: f64 = if !exact.is_empty() {
                    0.94
                } else if !segment.is_empty() {
                    0.88
                } else if !partial.is_empty() {
                    0.72
                } else {
                    semantic_role_score(role, &n)
                };
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
                            if role == "functionalCurrency" {
                                score += 0.62;
                            } else {
                                score -= 0.6;
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

fn mapped_cols(mapping: &Map<String, Value>, role: &str) -> Vec<String> {
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
fn first_col(mapping: &Map<String, Value>, role: &str) -> Option<String> {
    mapped_cols(mapping, role).first().cloned()
}

fn fixed_entity(params: &Value) -> &str {
    params
        .get("fixedEntity")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

fn entity_for<'a>(row: &'a RowRecord, mapping: &Map<String, Value>, params: &'a Value) -> &'a str {
    let mapped = cell(row, mapping, "entity").trim();
    if mapped.is_empty() {
        fixed_entity(params)
    } else {
        mapped
    }
}

// 很多科目余额表不设币种列，币种写在科目名称或科目文本里
// （例如“银行存款-建行USD4150-4800”）。这里按词边界从自由文本抽取币种：
// 命中唯一币种才返回，命中多个视为歧义，宁可交回上游按映射列处理。
fn currency_text_aliases() -> &'static [(&'static str, &'static [&'static str])] {
    &[
        ("CNY", &["CNY", "RMB", "人民币"]),
        ("USD", &["USD", "美元", "美金"]),
        ("EUR", &["EUR", "欧元"]),
        ("JPY", &["JPY", "日元", "日圆"]),
        ("HKD", &["HKD", "港币", "港元"]),
        ("GBP", &["GBP", "英镑"]),
        ("AUD", &["AUD", "澳元", "澳大利亚元"]),
        ("NZD", &["NZD", "新西兰元"]),
        ("SGD", &["SGD", "新加坡元", "新币"]),
        ("CHF", &["CHF", "瑞士法郎"]),
        ("CAD", &["CAD", "加拿大元", "加元"]),
        ("MOP", &["MOP", "澳门元", "澳门币"]),
        ("MYR", &["MYR", "林吉特"]),
        ("RUB", &["RUB", "卢布"]),
        ("ZAR", &["ZAR", "兰特"]),
        ("KRW", &["KRW", "韩元"]),
        ("AED", &["AED", "迪拉姆"]),
        ("SAR", &["SAR", "里亚尔"]),
        ("HUF", &["HUF", "福林"]),
        ("PLN", &["PLN", "兹罗提"]),
        ("DKK", &["DKK", "丹麦克朗"]),
        ("SEK", &["SEK", "瑞典克朗"]),
        ("NOK", &["NOK", "挪威克朗"]),
        ("TRY", &["TRY", "土耳其里拉"]),
        ("MXN", &["MXN", "墨西哥比索"]),
        ("THB", &["THB", "泰铢"]),
    ]
}

fn currency_from_text(value: &str) -> Option<String> {
    let normalized = value.to_uppercase();
    let bytes = normalized.as_bytes();
    // 三字母代码必须独立成词，避免 “PLUSD”“USDT” 这类子串误命中。
    let hit = |alias: &str| {
        if !alias.is_ascii() {
            return normalized.contains(alias);
        }
        normalized.match_indices(alias).any(|(index, _)| {
            let before = index == 0 || !bytes[index - 1].is_ascii_alphabetic();
            let end = index + alias.len();
            let after = end >= bytes.len() || !bytes[end].is_ascii_alphabetic();
            before && after
        })
    };
    let mut found = currency_text_aliases()
        .iter()
        .filter(|(_, aliases)| aliases.iter().any(|alias| hit(alias)))
        .map(|(code, _)| (*code).to_owned())
        .collect::<Vec<_>>();
    found.dedup();
    (found.len() == 1).then(|| found.remove(0))
}

fn currency_text_hint(row: &RowRecord, mapping: &Map<String, Value>) -> Option<String> {
    let text = mapped_cols(mapping, "currencyText")
        .iter()
        .filter_map(|column| row.values.get(column.as_str()))
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
    // 每个科目记：各币种出现次数 ＋ 见过的最强一条依据。
    let mut tally: BTreeMap<String, (BTreeMap<String, usize>, u8)> = BTreeMap::new();
    for row in records(table) {
        let account = account_name(&row, mapping);
        if account.is_empty() || is_summary_account(&account) {
            continue;
        }
        let mapped = normalize_currency(cell(&row, mapping, "currency"));
        let (currency, rank) = if !mapped.is_empty() {
            (mapped, 3u8)
        } else if let Some(hint) =
            currency_text_hint(&row, mapping).or_else(|| currency_from_text(&account))
        {
            (hint, 2)
        } else {
            (
                normalize_currency(cell(&row, mapping, "functionalCurrency")),
                1,
            )
        };
        if currency.is_empty() {
            continue;
        }
        let entry = tally.entry(account).or_default();
        *entry.0.entry(currency).or_default() += 1;
        entry.1 = entry.1.max(rank);
    }
    tally
        .into_iter()
        .map(|(account, (counts, rank))| {
            // 一个科目下挂多种币种时取出现最多的那个当主币种；
            // 全部币种都放进 seen，界面把它们列进下拉框，用户不必凭记忆输。
            let detected = counts
                .iter()
                .max_by_key(|(_, count)| **count)
                .map(|(currency, _)| currency.clone())
                .unwrap_or_default();
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
                    // 只有退回本位币列的才是「没真识别出来」，这些要提示人确认。
                    "needsConfirmation": rank <= 1,
                }),
            )
        })
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
        let key = account_match_key(account);
        if let Some(code) = overrides
            .get(account)
            .and_then(Value::as_str)
            .or_else(|| {
                overrides.iter().find_map(|(candidate, value)| {
                    (account_match_key(candidate) == key)
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
    // 线索也没有，退回本位币列（整列同值的那一列），至少口径不会错。
    normalize_currency(cell(row, mapping, "functionalCurrency"))
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
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
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
    let roles = [("accountCode", "科目编码"), ("accountName", "科目名称")];
    let mut aligned = Vec::new();
    let mut broken = Vec::new();
    for (role, label) in roles {
        let je_role = role_values(&je_table, &je_mapping, role);
        let tb_role = role_values(&tb_table, &tb_mapping, role);
        match overlap_ratio(&je_role, &tb_role) {
            Some((overlap, ratio)) if overlap > 0 => {
                aligned.push(label);
                if ratio < 0.1 {
                    warnings.push(format!(
                        "JE与TB的{label}仅有 {overlap}/{} 项能对上，请复核两边映射是否同一口径。JE样例：{}；TB样例：{}。",
                        je_role.len(),
                        three_samples(&je_role),
                        three_samples(&tb_role)
                    ));
                }
            }
            _ => broken.push((role, label, je_role, tb_role)),
        }
    }
    // 币种口径也顺带核一下，但只提示不拦截：两张表的币种范围本来就可能不同。
    if let Some((overlap, _)) = overlap_ratio(
        &role_values(&je_table, &je_mapping, "currency"),
        &role_values(&tb_table, &tb_mapping, "currency"),
    ) {
        if overlap == 0 {
            warnings.push("JE与TB的币种没有任何交集，请确认两边映射的是同一种币种字段。".into());
        }
    }
    if broken.is_empty() {
        return Ok((errors, warnings, None));
    }
    // 有对不上的角色，就在两张表的低基数列之间自己找一组真正能对上的列。
    // 这一步要看全量数据，样本里科目出现得太少会找不出重合。
    let je_full = load_full_side(params, "jeSource")?.unwrap_or(je_table);
    let tb_full = load_full_side(params, "tbSource")?.unwrap_or(tb_table);
    let je_columns = low_cardinality_columns(&je_full);
    let tb_columns = low_cardinality_columns(&tb_full);
    let mut je_fix = Map::new();
    let mut tb_fix = Map::new();
    let mut unmatched = Vec::new();
    for (role, label, je_role, tb_role) in broken {
        match best_column_pair(&je_columns, &tb_columns, role == "accountCode") {
            Some((je_header, tb_header, overlap, _)) => {
                je_fix.insert(role.into(), json!(je_header));
                tb_fix.insert(role.into(), json!(tb_header));
                aligned.push(label);
                warnings.push(format!(
                    "JE与TB的{label}原映射对不上，已自动改用取值真正一致的列：JE“{je_header}”对 TB“{tb_header}”（{overlap} 项一致）。"
                ));
            }
            None => unmatched.push((label, je_role, tb_role)),
        }
    }
    // 科目编码和科目名称至少要有一个对得上；两个都对不上才是真的没法做。
    if aligned.is_empty() {
        let (_, je_role, tb_role) =
            unmatched
                .first()
                .cloned()
                .unwrap_or(("科目编码", Vec::new(), Vec::new()));
        errors.push(format!(
            "JE与TB的科目编码和科目名称都对不上，两张表里也找不到取值能对上的列。JE样例：{}；TB样例：{}。请手工确认两边映射到的是同一套科目。",
            three_samples(&je_role),
            three_samples(&tb_role)
        ));
    } else {
        for (label, _, _) in &unmatched {
            warnings.push(format!(
                "JE与TB的{label}对不上，也找不到可替代的列；已按{}继续匹配。",
                aligned.join("、")
            ));
        }
    }
    let fix = (!je_fix.is_empty() || !tb_fix.is_empty()).then(|| {
        json!({
            "jeMapping": Value::Object(je_fix),
            "tbMapping": Value::Object(tb_fix)
        })
    });
    Ok((errors, warnings, fix))
}

fn check_mapping_alignment(params: &Value) -> Result<Value, AppError> {
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
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, key);
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
                vec!["id", "date", "accountCode", "currency"]
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
            if kind == "TB" && mapped_cols(&mapping, "currency").is_empty() {
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
                    errors.push(
                        "TB 认不出任何外币科目：请映射含两种以上币种的交易币种列；若币种写在科目名称里，请把那一列映射为“科目名称”或“币种线索文本”。"
                            .to_string(),
                    );
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
                if mapped_cols(&mapping, "entity").is_empty() && fixed_entity(params).is_empty() {
                    errors.push("JE 缺少主体列时必须指定固定主体".to_string());
                }
                for (prefix, label) in [("foreign", "原币"), ("functional", "本位币")] {
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
                if mapped_cols(&mapping, "entity").is_empty() && fixed_entity(params).is_empty() {
                    errors.push("TB 缺少主体列时必须指定固定主体".to_string());
                }
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
                // 只提示不拦截：实务余额表常见尾差、审计调整前后口径差异都会造成
                // 个别行不平，单行交给用户判断。这条检查的价值在于把「期初/期末列
                // 映射反了、借贷列拿错」这类系统性错误在上传阶段就暴露出来——那类
                // 错误几乎会让所有行都差出同一个量级。金额沿用 signed_amount 的
                // 借正贷负规则，借贷方向列与借贷双栏两种记法都适用；原币、本位币
                // 两个口径各自独立验一遍，四样字段不齐的口径跳过。
                let row_records = records(&table);
                for (opening_prefix, closing_prefix, ytd_debit, ytd_credit, unit) in [
                    (
                        "openingFunctional",
                        "closingFunctional",
                        "ytdFunctionalDebit",
                        "ytdFunctionalCredit",
                        "本位币",
                    ),
                    (
                        "openingForeign",
                        "closingForeign",
                        "ytdForeignDebit",
                        "ytdForeignCredit",
                        "原币",
                    ),
                ] {
                    let (Some(debit_col), Some(credit_col)) = (
                        first_col(&mapping, ytd_debit),
                        first_col(&mapping, ytd_credit),
                    ) else {
                        continue;
                    };
                    if !amount_scheme_ok(&mapping, opening_prefix)
                        || !amount_scheme_ok(&mapping, closing_prefix)
                    {
                        continue;
                    }
                    let mut checked = 0usize;
                    let mut mismatched: Vec<(usize, String, f64)> = Vec::new();
                    for row in &row_records {
                        // 四个数里解析失败或借贷发生额缺失的行跳过——坏列由上面的
                        // 「有效数值比例低于99%」负责拦截，这里不重复报。
                        let (Ok(opening), Ok(closing), Ok(Some(debit)), Ok(Some(credit))) = (
                            signed_amount(&row, &mapping, opening_prefix),
                            signed_amount(&row, &mapping, closing_prefix),
                            strict_number(
                                row.values.get(debit_col.as_str()).copied().unwrap_or(""),
                            ),
                            strict_number(
                                row.values.get(credit_col.as_str()).copied().unwrap_or(""),
                            ),
                        ) else {
                            continue;
                        };
                        if opening == 0.0 && closing == 0.0 && debit == 0.0 && credit == 0.0 {
                            continue;
                        }
                        checked += 1;
                        let derived = opening + debit - credit;
                        let difference = derived - closing;
                        let tolerance = 0.01_f64
                            .max(opening.abs().max(closing.abs().max(derived.abs())) * 1e-8);
                        if difference.abs() > tolerance {
                            mismatched.push((
                                row.source_row,
                                account_name(&row, &mapping),
                                difference,
                            ));
                        }
                    }
                    if !mismatched.is_empty() {
                        let shown = mismatched
                            .iter()
                            .take(3)
                            .map(|(row, account, difference)| {
                                format!("第{row}行（{account}，差{difference:.2}）")
                            })
                            .collect::<Vec<_>>()
                            .join("、");
                        warnings.push(format!(
                            "TB 自身勾稽（{unit}口径）：{} / {}行不满足 期初＋本年累计借方−本年累计贷方＝期末，如{shown}。请检查期初/期末/借贷方向列是否映射正确或数据是否存在尾差；本提示不拦截测算。",
                            mismatched.len(),
                            checked
                        ));
                    }
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
    let legacy = format!("{prefix}Direction");
    first_col(mapping, &legacy).map(|_| legacy)
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
    let je_spec: SourceSpec = serde_json::from_value(je_source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let tb_table = load_fx_table(&tb_spec)?;
    let je_table = load_fx_table(&je_spec)?;
    let mut tb_mapping = mapping_obj(params, "tbMapping");
    let mut je_mapping = mapping_obj(params, "jeMapping");
    // 符号口径必须在这里也判一次。此前只有 `fx.preview` 入口注入了它，
    // 余额滚动校验是独立入口，拿到的映射没有口径标记，一律按「贷方记正数」折算——
    // 实测 4800 的序时账是「已带符号」（26314 张凭证投票，0 张反对），
    // 贷方行被再乘一次 −1，差异正好是贷方发生额的两倍。
    for (table, mapping, kind) in [
        (&tb_table, &mut tb_mapping, "tb"),
        (&je_table, &mut je_mapping, "je"),
    ] {
        if let Some(convention) = detect_sign_convention(table, mapping, kind) {
            mapping.insert(
                SIGN_CONVENTION_KEY.into(),
                Value::String(convention.as_str().to_owned()),
            );
        }
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
            let currency = currency_for(&row, &tb_mapping, &account, params);
            let auxiliary = auxiliary_value(&row, &tb_mapping);
            if currency.is_empty() || currency == functional_currency(&entity, params) {
                continue;
            }
            let key = balance_match_key(&entity, &account, &auxiliary, use_auxiliary);
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
            let currency = currency_for(&row, &je_mapping, &account, params);
            let auxiliary = auxiliary_value(&row, &je_mapping);
            let key = balance_match_key(&entity, &account, &auxiliary, use_auxiliary);
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
    let Some(source) = params.get("jeSource") else {
        return Ok(Vec::new());
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    Ok(records(&table)
        .into_iter()
        .map(|row| {
            let mut value = row
                .values
                .into_iter()
                .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
                .collect::<Map<_, _>>();
            value.insert("sourceRow".into(), json!(row.source_row));
            Value::Object(value)
        })
        .collect())
}

fn records(table: &FxTable) -> Vec<RowRecord<'_>> {
    table
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| RowRecord {
            source_row: table.header_row + table.header_depth + i,
            values: table
                .headers
                .iter()
                .map(String::as_str)
                .zip(row.iter().map(String::as_str))
                .collect(),
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
        .and_then(|c| row.values.get(c.as_str()))
        .copied()
        .unwrap_or("")
}

/// 检测两侧账表的符号口径，把结论写回参数里的映射。
///
/// 折算函数散在三十处调用点上，全都从 `params` 里取映射——在任务入口检测一次、
/// 写回参数，下游就无需逐个传参。检测本身走统一内核：JE 拿整张凭证配平投票，
/// TB 用勾稽等式投票，与看账、存款、借款判的是同一套。
///
/// 判不出来时不写，[`sign_convention_of`] 会按「贷方记正数」兜底，与历史行为一致。
fn detect_and_inject_sign_conventions(params: &mut Value) {
    for (source_key, mapping_key, kind) in [
        ("jeSource", "jeMapping", "je"),
        ("tbSource", "tbMapping", "tb"),
    ] {
        let Some(spec) = params.get(source_key).cloned() else {
            continue;
        };
        let Ok(spec) = serde_json::from_value::<SourceSpec>(spec) else {
            continue;
        };
        let Ok(table) = load_fx_table(&spec) else {
            continue;
        };
        let mapping = mapping_obj(params, mapping_key);
        let Some(convention) = detect_sign_convention(&table, &mapping, kind) else {
            continue;
        };
        if let Some(object) = params.get_mut(mapping_key).and_then(Value::as_object_mut) {
            object.insert(
                SIGN_CONVENTION_KEY.into(),
                Value::String(convention.as_str().to_owned()),
            );
        }
    }
}

/// 判定这份表的符号口径：**整个流程走统一内核**，这里只回答「角色对应哪一列」。
///
/// 上一轮我在这里另写了一份流程（取列、按凭证分组、按记法选投票函数），
/// 那是第五份重复实现——内核改了它不会跟着变，等于没统一。现已删除。
fn detect_sign_convention(
    table: &FxTable,
    mapping: &Map<String, Value>,
    kind: &str,
) -> Option<ledger_mapping::SignConvention> {
    let headers = table.headers.clone();
    let rows: Vec<Vec<String>> = table.rows.clone();
    let column_of = |role: &str| -> Vec<String> { mapped_cols(mapping, role) };
    let evidence = if kind == "tb" {
        ledger_mapping::detect_tb_sign_convention(&headers, &rows, &column_of)
    } else {
        ledger_mapping::detect_sign_convention(&headers, &rows, &column_of)
    };
    if !ledger_mapping::sign_is_trustworthy(&evidence) {
        return None;
    }
    evidence.convention
}

/// 映射里存放本表符号口径的键。
///
/// 折算函数散在三十处调用点上，每处都已经拿着 mapping——把口径塞进映射本身，
/// 就不必逐个改签名。键名带 `__` 前缀，与真实角色区分开。
const SIGN_CONVENTION_KEY: &str = "__signConvention";

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
fn signed_amount(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    prefix: &str,
) -> Result<f64, String> {
    // 借贷分列只在两列都映射时才成立——沿用本模块原有语义，
    // 只映射了一侧时按净额列处理，不要当成分列。
    let pair = match (
        first_col(mapping, &format!("{prefix}Debit")),
        first_col(mapping, &format!("{prefix}Credit")),
    ) {
        (Some(debit), Some(credit)) => Some((debit, credit)),
        _ => None,
    };
    let inputs = if let Some((debit, credit)) = pair {
        ledger_mapping::AmountInputs {
            debit: Some(
                strict_number(row.values.get(debit.as_str()).copied().unwrap_or(""))?
                    .unwrap_or(0.0),
            ),
            credit: Some(
                strict_number(row.values.get(credit.as_str()).copied().unwrap_or(""))?
                    .unwrap_or(0.0),
            ),
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
    };
    Ok(ledger_mapping::signed_amount(
        &inputs,
        sign_convention_of(mapping),
    ))
}

fn voucher_id(row: &RowRecord, mapping: &Map<String, Value>, params: &Value) -> String {
    let mut parts = vec![
        entity_for(row, mapping, params).to_owned(),
        parse_date(cell(row, mapping, "date"))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| cell(row, mapping, "date").trim().to_owned()),
    ];
    parts.extend(mapped_cols(mapping, "id").iter().map(|c| {
        row.values
            .get(c.as_str())
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
            row.values
                .get(column.as_str())
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
                if !name.is_empty() && !is_summary_account(&name) {
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

fn is_summary_account(account: &str) -> bool {
    !account.chars().any(|character| character.is_ascii_digit())
        && matches!(
            account.trim(),
            "合计" | "资产小计" | "负债小计" | "权益小计" | "成本小计" | "损益小计"
        )
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
    code.into_iter().chain(name).collect()
}

fn account_name(row: &RowRecord, mapping: &Map<String, Value>) -> String {
    account_columns(mapping)
        .iter()
        .filter_map(|c| row.values.get(c.as_str()))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn account_code_and_name(row: &RowRecord, mapping: &Map<String, Value>) -> (String, String) {
    let read = |columns: &[String]| {
        columns
            .iter()
            .filter_map(|column| row.values.get(column.as_str()))
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
                row.values
                    .get(column.as_str())
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
            lookup.entry(code.trim().to_uppercase()).or_insert(name);
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
    account
        .split_whitespace()
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(account.trim())
}

fn auxiliary_value(row: &RowRecord, mapping: &Map<String, Value>) -> String {
    mapped_cols(mapping, "auxiliary")
        .iter()
        .filter_map(|column| row.values.get(column.as_str()))
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
fn balance_match_key(entity: &str, account: &str, auxiliary: &str, use_auxiliary: bool) -> String {
    let base = format!(
        "{}\u{1f}{}",
        entity.trim(),
        account_match_key(account).trim().to_uppercase()
    );
    if use_auxiliary && !auxiliary.trim().is_empty() {
        format!("{base}\u{1f}{}", auxiliary.trim().to_uppercase())
    } else {
        base
    }
}

/// 未实现测算的余额键。**与 TB＋JE 对账用的是同一口径**：公司 ＋ 科目编码。
///
/// 曾经这里还拼上币种与辅助核算，结果两边天生对不上——TB 端点的币种是从科目
/// 文本里抽的（抽不出就退回本位币列），辅助核算 TB 根本没有这一列恒为空；
/// 而 JE 侧逐行读凭证货币、带着供应商与客户。四段里有两段对不上，
/// 实测 4800 有 286 个账户因此找不到 TB 期初余额端点，被判为「缺少余额基础」。
///
/// 重估仍然按币种做——币种保存在端点自身的字段里，不需要挤进匹配键。
fn monetary_balance_key(entity: &str, account: &str, currency: &str, auxiliary: &str) -> String {
    let _ = (currency, auxiliary);
    balance_match_key(entity, account, "", false)
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
    // 没有编码也没有强词时仍给出一个保守主类别；“待确认”只作为状态，
    // 不再成为会悄悄排除测算的第六种科目类别。
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
    ]) {
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
    let key = account_match_key(account).trim().to_uppercase();
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
    let key = account_match_key(account);
    if let Some(role) = roles.and_then(|values| {
        values.iter().find_map(|(candidate, role)| {
            (account_match_key(candidate) == key)
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
        .and_then(|names| names.get(&key.trim().to_uppercase()))
        .and_then(Value::as_str)
    {
        let suggested = suggest_account_role(&format!("{account} {name}"));
        if suggested != "unassigned" {
            return suggested;
        }
    }
    suggest_account_role(account)
}

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
        validate_tb_je_balance_rollforward(params)?
    } else {
        json!({"performed":false,"reason":"当前模式不包含未实现测算"})
    };
    checkpoint(cancel, pause)?;
    progress("rates", 1, 4, "正在锁定官方汇率快照…");
    let snapshot = obtain_rates(params)?;
    checkpoint(cancel, pause)?;
    progress("calculate", 2, 4, "正在执行汇兑损益测算与分类…");
    let mut realized = Vec::new();
    let mut unrealized = Vec::new();
    let mut classification = Vec::new();
    let mut quality = Vec::new();
    // JE 完整明细只有导出时写「JE完整明细」那张 Sheet 才用得上，测算预览会把它整个丢掉。
    // 36 万行 × 46 列转成 JSON 对象要几 GB 内存，还要跟着测算结果一起被克隆进预览缓存——
    // 白算一遍。改为导出前按需构造（[`build_je_detail`]）。
    let je_detail: Vec<Value> = Vec::new();
    if matches!(mode, "realized" | "combined") {
        let (calculation, classes, issues) = calculate_realized(params, &snapshot)?;
        realized = calculation;
        classification = classes;
        quality.extend(issues);
    }
    if matches!(mode, "unrealized" | "combined") {
        let (calculation, issues) = calculate_unrealized(params, &snapshot, &realized)?;
        unrealized = calculation;
        quality.extend(issues);
    }
    // 新已实现口径（记账日牌价−月初牌价）的前置假设体检：入账口径恒定性
    // 与每月重估存在性。只提示不阻断，缺 jeSource 时自动跳过。
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
    // 待确认项目只披露，不进入审计测算。已实现按结算事件测算；
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
        progress("translate_accounts", 2, 4, "正在翻译TB英文科目名称…");
    }
    let (account_translations, translation_enabled, translation_issue) =
        translate_tb_account_names(params);
    if let Some(detail) = translation_issue {
        quality.push(json!({
            "source":"LLM科目翻译", "type":"英文科目名称翻译未完全成功",
            "severity":"提示", "detail":detail
        }));
    }
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
    // “已覆盖账面金额”已经排除了待确认凭证。再扣除客户已入账未实现
    // 部分，得到与已实现审计测算同口径的账面已实现金额。
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
        "无外币敞口的评估调整科目",
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
            "detail": format!("已读取{}个凭证事件，但没有事件进入已实现或未实现测算；请检查科目角色、凭证类型、币种及金额映射。", classification.len())
        }));
    }
    progress("reconcile", 3, 4, "正在汇总并执行TB勾稽…");
    Ok(json!({
        "mode": mode,
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
            "coveredBookFxGainLoss": covered_book,
            "measurementDifference": automatic_total - covered_book,
            "auditFxGainLoss": provisional_total,
            "tbFxGainLoss": tb_fx,
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

/// 从汇兑损益科目的名称判断这张凭证属于已实现还是未实现。
///
/// 客户的科目表通常把两者分开设科目并写进名称——4800 就是
/// 「财务费用-汇兑收益-未实现」「财务费用-汇兑损失-已实现-银行存款\现金」这样。
/// 此前分类只认用户手工指定，没指定一律「待确认」，这些名称里写得明明白白的凭证
/// 也要人一张张点：实测 4800 有 7600 万的未实现评估调整凭证因此排除在测算之外，
/// 测算结果几乎为零，而 TB 上的汇兑损益有 385 万。
///
/// 只在**科目名称明确写了**的时候下结论；同一张凭证同时出现两种字样时
/// 保持「待确认」交给人判断，不猜。
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

/// 判断完整凭证是否具有客户月末外币重估（未实现汇兑损益）的**结构特征**：
/// 含汇兑损益科目，且所有货币性项目原币不动而本位币变化。
///
/// 结构满足即认定为重估凭证——该组合高度特异（结算凭证必有原币发生额，
/// 期间损益结转没有本位币变化）。凭证类型/摘要文字不再作硬门槛，只用于
/// 分层提示（见 `has_revaluation_text_evidence`），避免重估凭证因摘要
/// 五花八门漏进待确认。未实现审计金额按余额滚动独立测算，凭证金额仅作
/// 比较证据，放宽识别不影响测算数。
fn has_unrealized_voucher_structure(
    has_fx: bool,
    monetary_has_foreign_movement: bool,
    monetary_has_functional_movement: bool,
) -> bool {
    has_fx && !monetary_has_foreign_movement && monetary_has_functional_movement
}

/// 凭证类型或摘要中的重估**文字证据**。
///
/// 结构满足但文字证据缺失时，重估认定照常生效，另出非阻断「提示」
/// 供抽查（防差错更正凭证、原币列缺失的导出被误认成重估）。
fn has_revaluation_text_evidence(summary: &str, voucher_type: &str) -> bool {
    let summary = summary.to_lowercase();
    matches!(voucher_type, "FX" | "AB")
        || [
            "valuation",
            "revaluation",
            "translation",
            "重估",
            "评估",
            "冲回",
            "期末调汇",
            "月末调汇",
            "汇率调整",
            "外币折算",
            "汇兑损益结转",
            "汇兑结转",
        ]
        .iter()
        .any(|value| summary.contains(value))
}

fn manual_classification<'a>(params: &'a Value, voucher_id: &str) -> Option<&'a str> {
    params
        .get("manualClassifications")
        .and_then(Value::as_object)
        .and_then(|items| items.get(voucher_id))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "已实现汇兑损益" | "未实现汇兑损益" | "待确认"))
}

fn reconcile_fx_gain_loss(params: &Value) -> Result<Value, AppError> {
    let mut tb_rows = Vec::new();
    let mut tb_total = 0.0;
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
                    .and_then(|column| row.values.get(column.as_str()))
                    .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                    .transpose()
                    .ok()
                    .flatten();
                let credit = first_col(&mapping, "periodFunctionalCredit")
                    .and_then(|column| row.values.get(column.as_str()))
                    .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                    .transpose()
                    .ok()
                    .flatten();
                let closing = first_col(&mapping, "closingFunctionalAmount")
                    .and_then(|column| row.values.get(column.as_str()))
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
            tb_total += amount;
            tb_rows.push(json!({"account":account, "sourceRow":source_row, "amount":amount,
                "basis": basis,
                "scheme": if first_col(&mapping, "periodFunctionalDebit").is_some() && first_col(&mapping, "periodFunctionalCredit").is_some() {
                    "ERP借贷同额带符号时取单列，否则借方减贷方"
                } else { "TB未提供发生额时，取累计本位币金额" }}));
        }
    }
    let mut je_total = 0.0;
    let mut excluded = 0usize;
    if let Some(source) = params.get("jeSource") {
        let spec: SourceSpec = serde_json::from_value(source.clone())
            .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        let mapping = mapping_obj(params, "jeMapping");
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
    Ok(json!({"tbFxGainLoss":tb_total, "tbRows":tb_rows,
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
    let Some(source) = params.get("jeSource") else {
        return Ok(json!({
            "pendingReviews": [], "pendingReviewAmount": 0.0,
            "pendingUnclassifiedCount": 0, "pendingUnmeasurableCount": 0,
            "coveredBookFxGainLoss": 0.0, "jeFxGainLoss": null,
            "automaticCoveredVouchers": 0, "pendingReviewCount": 0,
            "classificationControls": []
        }));
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
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
    // 未覆盖的凭证要分两类计数，不能糊成一个数字：
    // 「待确认」是等人判断，「已分类但缺重算证据」是工具算不了。
    // 前者要人动手，后者要修工具或补资料——混在一起显示，用户会以为
    // 界面已经分好类的凭证还在等他确认，那是自相矛盾的。
    let mut unclassified_count = 0usize;
    let mut unmeasurable_count = 0usize;
    for (id, rows) in groups {
        let mut booked = 0.0;
        let mut fx_accounts = BTreeSet::new();
        let mut all_accounts = BTreeSet::new();
        let mut currencies = BTreeSet::new();
        let mut has_non_monetary = false;
        let mut has_fx = false;
        let mut monetary_has_foreign_movement = false;
        let mut monetary_has_functional_movement = false;
        // 结构判定所需证据：非现金货币性项目是否被终止确认（原币减少）、
        // 外币现金与本位币现金是否对转（外币兑换）。
        let mut noncash_monetary_decrease = false;
        let mut noncash_foreign_movement = false;
        let mut cash_foreign_movement = false;
        let mut cash_functional_movement = false;
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
                has_fx = true;
                fx_accounts.insert(account.clone());
                booked += functional;
            }
            if matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                let foreign = signed_amount(row, &mapping, "foreign").map_err(|detail| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "JE原币金额无法解析。",
                        Some(format!("第{}行：{detail}", row.source_row)),
                    )
                })?;
                monetary_has_foreign_movement |= foreign.abs() >= 0.01;
                monetary_has_functional_movement |= functional.abs() >= 0.01;
                let entity = entity_for(row, &mapping, params);
                let row_currency = normalize_currency(&currency_for(row, &mapping, &account, params));
                let entity_currency = normalize_currency(&functional_currency(entity, params));
                let is_cash_row = role == "cash" || is_cash_account(&account, params);
                if is_cash_row {
                    if row_currency.is_empty() || row_currency == entity_currency {
                        cash_functional_movement |= functional.abs() >= 0.01;
                    } else {
                        cash_foreign_movement |= foreign.abs() >= 0.01;
                    }
                } else {
                    noncash_foreign_movement |= foreign.abs() >= 0.01;
                    noncash_monetary_decrease |= (role == "monetary_asset" && foreign < -0.005)
                        || (role == "monetary_liability" && foreign > 0.005);
                }
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
        // 分类以凭证结构为准，与已实现/月度引擎同口径：
        // 非现金货币性项目原币减少（终止确认）或外币兑换 → 已实现；
        // 原币不动而本位币变动且带重估证据 → 未实现；其余待确认。
        // 科目名里的「已实现/未实现」是客户自己的口径，不再参与定性，
        // 只做交叉验证——与结构冲突时提示用户复核。
        let conversion_pattern = has_fx
            && cash_foreign_movement
            && cash_functional_movement
            && !noncash_foreign_movement;
        let structural_class = if !has_fx {
            None
        } else if noncash_monetary_decrease || conversion_pattern {
            Some("已实现汇兑损益")
        } else if has_unrealized_voucher_structure(
            has_fx,
            monetary_has_foreign_movement,
            monetary_has_functional_movement,
        ) {
            Some("未实现汇兑损益")
        } else {
            None
        };
        let name_class = classify_by_account_names(fx_accounts.iter().map(String::as_str));
        let classification_conflict = match name_class {
            Some(name) if Some(name) != structural_class => Some(format!(
                "科目名称指向「{name}」，但凭证结构判定为「{}」；以结构为准，请复核客户科目使用是否恰当",
                structural_class.unwrap_or("待确认")
            )),
            _ => None,
        };
        let selected = manual_classification(params, &display_id)
            .or(structural_class)
            .unwrap_or("待确认");
        let (category, reason) = if has_non_monetary {
            (
                "非货币性项目/异常复核",
                "对方科目为存货、固定资产等非货币性项目，不应直接归入已实现或未实现汇兑损益",
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
                } else if selected != "待确认" && !is_measured {
                    "用户已确认分类，但缺少执行相应重算所需的原币、账面价值或汇率证据；本凭证未进入测算结果"
                } else { reason },
                "classification": selected,
                "classificationConflict": classification_conflict,
                "measurementStatus": if is_client_revaluation {
                    "已识别为未实现汇兑损益类凭证；审计金额按账户余额测算"
                } else if is_realized_measured {"测算成功"} else if selected == "待确认" {"待确认"} else {"无法测算，未纳入结果"},
                "patternKey": pattern_key, "patternLabel": pattern_label,
                "debitAccounts": debit_accounts, "creditAccounts": credit_accounts,
                "summary": summary.clone()
            }));
        }
        if is_measured {
            continue;
        }
        pending_amount += booked;
        if selected == "待确认" {
            unclassified_count += 1;
        } else {
            unmeasurable_count += 1;
        }
        pending.push(json!({
            "voucherId": display_id,
            "date": rows.iter().find_map(|row| parse_date(cell(row, &mapping, "date"))),
            "voucherType": voucher_type, "classification": "待复核",
            // 该凭证当前的分类（含按科目名判出来的），供界面区分这两类未覆盖。
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
        "pendingUnclassifiedCount": unclassified_count,
        "pendingUnmeasurableCount": unmeasurable_count,
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
    let Some(source) = params.get("jeSource") else {
        return Ok(Vec::new());
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
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
        for (header, raw) in row.values {
            value
                .entry(format!("原始_{header}"))
                .or_insert(Value::String(raw.to_string()));
        }
        output.push(Value::Object(value));
    }
    Ok(output)
}

fn calculate_realized(
    params: &Value,
    snapshot: &RateSnapshot,
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
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
    for (id, rows) in groups {
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
        let manual_pending = manual == Some("待确认");
        let summary = rows
            .iter()
            .map(|r| cell(r, &mapping, "summary"))
            .collect::<Vec<_>>()
            .join(" ");
        let voucher_type_upper = rows
            .iter()
            .map(|r| cell(r, &mapping, "voucherType").trim())
            .find(|value| !value.is_empty())
            .unwrap_or("")
            .to_uppercase();
        let mut has_fx = false;
        let mut has_foreign_currency = false;
        let mut settlement_targets = Vec::new();
        // 外币兑换证据：外币现金行（结汇=减少、购汇=增加两个方向都收）、
        // 本位币现金腿合计金额。
        let mut cash_foreign_rows = Vec::new();
        let mut cash_functional_movement = false;
        // 本位币现金腿的合计金额：兑换凭证的金额配比判断要用（见下方
        // conversion_pairing_ok），只判真假不够。
        let mut cash_functional_total = 0.0_f64;
        let mut cash_foreign_movement = false;
        let mut noncash_foreign_movement = false;
        let mut monetary_has_foreign_movement = false;
        let mut monetary_has_functional_movement = false;
        let mut cash_settlements = HashMap::<String, (f64, f64)>::new();
        for row in &rows {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            has_fx |= role == "fx_gain_loss";
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
                let functional = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
                monetary_has_foreign_movement |= foreign.abs() >= 0.01;
                monetary_has_functional_movement |= functional.abs() >= 0.01;
                if is_cash && foreign.abs() >= 0.005 && functional.abs() >= 0.005 {
                    let currency =
                        normalize_currency(&currency_for(row, &mapping, &account, params));
                    let item = cash_settlements.entry(currency).or_default();
                    item.0 += foreign;
                    item.1 += functional;
                }
                let entity_currency = normalize_currency(&functional_currency(entity, params));
                if is_cash {
                    if currency.is_empty() || currency == entity_currency {
                        cash_functional_movement |= functional.abs() >= 0.01;
                        cash_functional_total += functional;
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
                                functional,
                            ));
                        }
                    }
                } else {
                    noncash_foreign_movement |= foreign.abs() >= 0.01;
                }
                let terminates_asset = !is_cash && role == "monetary_asset" && foreign < -0.005;
                let terminates_liability = role == "monetary_liability" && foreign > 0.005;
                if terminates_asset || terminates_liability {
                    settlement_targets.push((row, account, role, foreign, functional));
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
        // 自动识别重估看结构：含汇兑损益＋每一条货币性项目均无原币发生额
        // ＋存在本位币变动。重估类型/文字证据不再作门槛，只用于在缺失时
        // 出非阻断提示供抽查（差错更正凭证、原币列缺失的导出是主要风险源）。
        let summary_lower = summary.to_lowercase();
        let revaluation_text_evidence =
            has_revaluation_text_evidence(&summary, &voucher_type_upper);
        let automatic_revaluation = has_unrealized_voucher_structure(
            has_fx,
            monetary_has_foreign_movement,
            monetary_has_functional_movement,
        );
        let revaluation_signal =
            !manual_realized && !manual_pending && (manual_unrealized || automatic_revaluation);
        let text_settlement = [
            "结算",
            "收款",
            "付款",
            "核销",
            "抵销",
            "偿还",
            "结售汇",
            "settlement",
            "clearing",
            "payment",
            "receipt",
            "direct credit",
            "direct debit",
        ]
        .iter()
        .any(|value| summary_lower.contains(value));
        let type_settlement = matches!(voucher_type_upper.as_str(), "DZ" | "ZE");
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
                cash_settlements.iter().next().is_some_and(
                    |(currency, (foreign_sum, _))| {
                        rate(snapshot, date, currency, &functional_code).is_some_and(
                            |(official, _)| {
                                let expected = foreign_sum.abs() * official;
                                let actual = cash_functional_total.abs();
                                expected > 0.005
                                    && actual > 0.005
                                    && (actual - expected).abs()
                                        / expected.max(actual)
                                        <= 0.05
                            },
                        )
                    },
                )
            });
        // 外币兑换：外币货币资金与本位币货币资金对转、差额进汇兑损益，
        // 同样构成已实现结算证据；此时无终止确认行，以外币现金行为重算对象。
        let conversion_pattern = (has_fx || conversion_pairing_ok)
            && cash_foreign_movement
            && cash_functional_movement
            && !noncash_foreign_movement
            && settlement_targets.is_empty();
        // 结构判定取代此前「终止确认行恰好一条且对方货币性行恰好一条」的
        // 门槛：批量付款一张凭证结清多张发票是常态，应逐条终止确认行重算、
        // 有几条算几条，而不是整张放弃推进待复核。
        let structural_settlement = !settlement_targets.is_empty() || conversion_pattern;
        let has_settlement =
            manual_realized || text_settlement || type_settlement || structural_settlement;
        // A functional-currency-only voucher without an FX gain/loss account is
        // outside the FX audit population.  Do not present ordinary RMB JEs as
        // unresolved FX events merely because their text resembles settlement.
        if !has_fx && !has_foreign_currency {
            continue;
        }
        let realized_hard = !manual_pending
            // 兑换结构（外币现金↔本位币现金配比对转）本身即已实现证据，
            // 凭证里没有汇兑损益行同样要重算；终止确认路径仍要求 has_fx，
            // 保留「缺少历史账面价值证据」的保护。
            && (has_fx || conversion_pattern)
            && (manual_realized || (!manual_unrealized && structural_settlement));
        let unrealized_hard = !realized_hard
            && revaluation_signal
            && (manual_unrealized
                || (!monetary_has_foreign_movement && monetary_has_functional_movement));
        let realized_score: f64 = (if realized_hard { 0.75 } else { 0.0 })
            + (if has_fx { 0.15 } else { 0.0 })
            + (if has_settlement { 0.1 } else { 0.0 });
        let unrealized_score: f64 =
            (if unrealized_hard { 0.8 } else { 0.0 }) + (if has_fx { 0.1 } else { 0.0 });
        let class = if realized_hard {
            "已实现"
        } else if unrealized_hard {
            "未实现"
        } else if realized_score >= unrealized_score {
            "已实现候选"
        } else {
            "未实现候选"
        };
        let confidence = if realized_score.max(unrealized_score) >= 0.8 {
            "高"
        } else if realized_score.max(unrealized_score) >= 0.55 {
            "中"
        } else {
            "低"
        };
        classes.push(json!({
            "voucherId": display_id, "classification": class,
            "eventType": if has_settlement {"结算/终止确认"} else {"重估/待复核"},
            "realizedScore": realized_score, "unrealizedScore": unrealized_score,
            "matchedRules": [if manual_realized {
                "用户按同借贷科目凭证类型确认为已实现；重新执行结算测算"
            } else if manual_unrealized {
                "用户按同借贷科目凭证类型确认为未实现；重新执行重估测算"
            } else if realized_hard {
                if conversion_pattern {
                    "外币兑换：外币货币资金与本位币货币资金对转"
                } else {
                    "货币性项目原币减少（终止确认），逐条结算行独立重算"
                }
            } else if unrealized_hard {
                "本位币变化、原币净变动在容差内且无结算"
            } else {"证据评分"}],
            "counterEvidence": if !has_settlement {vec!["未识别到结算证据"]} else {vec![]},
            "confidence": confidence, "ruleConflict": realized_hard && unrealized_hard
        }));
        if unrealized_hard && !manual_unrealized && !revaluation_text_evidence {
            quality.push(json!({
                "source":"JE", "voucherId": display_voucher_id(&id),
                "type":"重估凭证无文字证据", "severity":"提示",
                "detail":"凭证结构符合月末重估（含汇兑损益科目、原币不动、本位币变化），但凭证类型与摘要均无重估字样；已按未实现重估处理，建议抽查是否为差错更正或原币列缺失。"
            }));
        }
        if !realized_hard && !unrealized_hard && !has_settlement && has_foreign_currency {
            candidate_vouchers.push(display_voucher_id(&id));
        }
        if manual_realized && settlement_targets.is_empty() && !conversion_pattern {
            quality.push(json!({
                "source":"JE", "voucherId":display_voucher_id(&id),
                "type":"用户确认已实现但无法重算", "severity":"待确认",
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
            for (row, account, role, foreign, functional) in targets {
                let entity = entity_for(row, &mapping, params);
                let currency = currency_for(row, &mapping, &account, params);
                let functional_code = functional_currency(entity, params);
                let day_rate = rate(snapshot, date, &currency, &functional_code);
                let opening = month_opening_rate(snapshot, date, &currency, &functional_code);
                let day_missing = day_rate.is_none();
                if let (Some((official_rate, published)), Some((opening_rate, opening_published, opening_fallback))) =
                    (day_rate, opening)
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
                        cash_settlements.iter().next().and_then(|(_, (foreign_sum, _))| {
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
                "共{}张外币凭证未识别到结算或兑换结构（如{}{}），其原币变动已按月纳入外币余额滚动，不属于已实现或未实现汇兑损益；若其中实际存在结汇/购汇业务，请核对两条现金腿金额是否在同一凭证内。",
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
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("tbSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "tbMapping");
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
            params, snapshot, start, end, &table, &mapping, realized,
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
            .filter_map(|c| row.values.get(c.as_str()))
            .map(|v| v.trim())
            .collect::<Vec<_>>()
            .join("|");
        // 去重键与匹配键同口径：同一公司同一科目下的多行（按币种或费用性质拆行）
        // 会各自重估后相加，这里只用来提示「同一余额键有多行」。
        let key = format!(
            "{}\u{1f}{currency}",
            balance_match_key(entity, &account, "", false)
        );
        // 同一余额键的多行按各自的余额独立重估，结果自然相加——
        // 旧版在这里直接 `continue` 丢掉后来的行，按费用性质拆行的 TB 会少算一大截。
        if !seen.insert(key.clone()) {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "同一余额键多行",
                "key": key, "severity": "合并",
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
            "openingRate": opening_rate, "openingPublishedDate": opening_published,
            "openingAuditFunctional": opening_audit, "openingDifference": opening_difference,
            "closingForeign": closing_foreign, "closingBookFunctional": closing_local,
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
            params, snapshot, start, end, &output, &mut quality, realized,
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
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let je_spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let je_table = load_fx_table(&je_spec)?;
    let je_mapping = mapping_obj(params, "jeMapping");
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
        let account_currency_key = balance_match_key(entity, &account, "", false);
        let functional_of_row = signed_amount(&row, &je_mapping, "functional").map_err(|detail| {
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
        let key = monetary_balance_key(entity, &account, &currency, &auxiliary);
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
        let account_currency_key = balance_match_key(entity, &account, "", false);
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
                        "该科目既持有{only}敞口，又沉淀了{:.2}的本位币余额；TB 只给到科目粒度的合计余额，无法拆出其中属于{only}的部分。请提供按币种拆分的科目余额表后重算。",
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
                        "该科目同时持有 {detail} 敞口，而 TB 只给到科目粒度的合计余额，无法拆出各币种分别是多少。请提供按币种拆分的科目余额表后重算。"
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
                // 名义上挂着外币凭证，但每一种的原币都是零——「外币评估调整」
                // 这类影子科目就是如此：它不持有外币，只承载本位币差额。
                // 审计上要看的是它对应的原科目，不是对它自己做重估。
                let detail = nominal
                    .map(|values| values.iter().cloned().collect::<Vec<_>>().join("、"))
                    .unwrap_or_default();
                quality.push(json!({
                    "source":"TB+JE", "row":row.source_row,
                    "type":"无外币敞口的评估调整科目", "account":account,
                    "currencies":nominal,
                    "severity":"隔离",
                    "detail":format!(
                        "该科目挂着 {detail} 的凭证但原币金额全部为零，说明它不持有外币，只承载客户记入的本位币评估调整。审计金额要看它对应的原科目——若原科目也因 TB 只给到科目粒度而无法测算，请更换为按币种拆分的科目余额表后重算。"
                    )
                }));
            }
            continue;
        };
        let key = monetary_balance_key(entity, &account, &currency, &auxiliary);
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
        params, snapshot, start, end, &endpoints, &mut quality, realized,
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
    let je_spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let je_table = load_fx_table(&je_spec)?;
    let je_mapping = mapping_obj(params, "jeMapping");
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
        let key = balance_match_key(entity, &account, "", false);
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
                let key = balance_match_key(entity, &account, "", false);
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
        let voucher_type = rows
            .iter()
            .map(|row| cell(row, &je_mapping, "voucherType"))
            .collect::<Vec<_>>()
            .join(" ");
        let summary_lower = summary.to_lowercase();
        let display_id = display_voucher_id(&id);
        let manual = manual_classification(params, &display_id);
        let manual_realized = manual == Some("已实现汇兑损益");
        let manual_pending = manual == Some("待确认");
        let revaluation_signal = !manual_realized
            && !manual_pending
            && (voucher_type
                .split_whitespace()
                .any(|value| value.eq_ignore_ascii_case("fx") || value.eq_ignore_ascii_case("ab"))
                || ["valuation", "revaluation", "translation", "重估", "评估"]
                    .iter()
                    .any(|value| summary_lower.contains(value)));
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
            let key = balance_match_key(&entity, &account, "", false);
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
                    let is_reversal =
                        summary_lower.contains("reversal") || summary_lower.contains("冲回");
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
                        "method": if is_reversal {
                            "客户重估冲回复核（TB无原币余额，暂按账面冲回金额）"
                        } else {
                            "客户月末重估凭证复核（TB无原币余额，暂按账面重估金额）"
                        },
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
) -> Result<Vec<Value>, AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
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
        let key = monetary_balance_key(entity, account, currency, auxiliary);
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
    let mut voucher_rows = BTreeMap::<String, Vec<&RowRecord>>::new();
    for row in &rows {
        let Some(date) = parse_date(cell(row, &mapping, "date")) else {
            continue;
        };
        if date < start || date > end {
            continue;
        }
        let id = display_voucher_id(&voucher_id(row, &mapping, params));
        voucher_rows.entry(id).or_default().push(row);
    }
    let mut revaluation_meta = HashMap::<String, Value>::new();
    for (id, voucher) in &voucher_rows {
        let manual = manual_classification(params, id);
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
        let mut has_fx = false;
        let mut monetary_has_foreign_movement = false;
        let mut monetary_has_functional_movement = false;
        let mut booked_fx = 0.0;
        for row in voucher {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            let functional = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
            if role == "fx_gain_loss" {
                has_fx = true;
                booked_fx += functional;
            }
            if matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                let foreign = signed_amount(row, &mapping, "foreign").unwrap_or(0.0);
                monetary_has_foreign_movement |= foreign.abs() >= 0.01;
                monetary_has_functional_movement |= functional.abs() >= 0.01;
            }
        }
        // 与界面分类、已实现引擎同口径：只认结构证据。科目名含「未实现」
        // 不再使凭证按重估处理——原币减少的凭证是结算/终止确认，其发生额
        // 必须留在正常业务余额滚动里；结构上原币不动而本位币变动的，作为
        // 客户重估凭证从正常发生额中剔除（文字证据只作提示分层，不作门槛）。
        let automatic_signal = has_unrealized_voucher_structure(
            has_fx,
            monetary_has_foreign_movement,
            monetary_has_functional_movement,
        );
        let is_revaluation = match manual {
            Some("未实现汇兑损益") => true,
            Some("已实现汇兑损益" | "待确认") => false,
            _ => automatic_signal,
        };
        if is_revaluation {
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
            let audit_functional = if signed < 0.0 {
                -carrying
            } else {
                carrying
            };
            realized_legs.insert(row, audit_functional);
        }
    }

    let mut output = Vec::new();
    let mut missing_balance_keys = BTreeSet::new();
    let mut previous = start - Duration::days(1);
    for month_end in date_points(start, end)
        .into_iter()
        .filter(|date| *date == end || (*date + Duration::days(1)).day() == 1)
    {
        let mut movement: HashMap<String, (f64, f64, f64, f64)> = HashMap::new();
        let mut revaluation_vouchers: HashMap<String, BTreeSet<String>> = HashMap::new();
        for row in &rows {
            let Some(date) = parse_date(cell(row, &mapping, "date")) else {
                continue;
            };
            if date <= previous || date > month_end {
                continue;
            }
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
            let key = monetary_balance_key(entity, &account, &currency, &auxiliary);
            if !state.contains_key(&key) {
                if missing_balance_keys.insert(key.clone()) {
                    quality.push(json!({
                        "source":"JE+TB", "type":"未实现测算缺少TB余额基础",
                        "severity":"隔离", "entity":entity, "account":account,
                        "auxiliary":auxiliary, "currency":normalize_currency(&currency),
                        "detail":"该外币货币性项目在JE中存在发生额，但未取得可唯一对应的TB余额端点；系统不会再假设零期初，也不将其计入未实现测算。"
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
            } else if let Some(audit_functional) =
                realized_legs.get(&(row.source_row as u64))
            {
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
            let (foreign_change, non_revaluation_change, client_revaluation, realized_basis_difference) =
                movement.get(&key).copied().unwrap_or((0.0, 0.0, 0.0, 0.0));
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
        previous = month_end;
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
    write_classification_adjustment_sheet(&mut workbook, result)?;
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
                "现金科目并非已实现的必要条件；系统按结算、抵销、币种转换或终止确认判断。",
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
        "异常与限制",
        "_rate_snapshot",
        "_source_trace",
        "JE完整明细",
        "事件分类",
        "已实现测算",
        "已实现汇总",
        "未实现凭证识别",
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
    let text_rows = [
        ("公司/核算主体", fixed_entity(params)),
        (
            "报告期间",
            &format!(
                "{} 至 {}",
                params
                    .get("reportStart")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                params
                    .get("reportEnd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
        ),
        (
            "测算范围",
            localized_scalar(result.get("mode").and_then(Value::as_str).unwrap_or("")),
        ),
    ];
    for (index, (label, value)) in text_rows.iter().enumerate() {
        sheet
            .write_string((index + 1) as u32, 0, *label)
            .map_err(xlsx_err)?;
        sheet
            .write_string((index + 1) as u32, 1, *value)
            .map_err(xlsx_err)?;
    }
    // 「外币余额滚动」页只在带 JE 的模式下生成；无 JE 时结论退回静态数，
    // 避免引用一个不存在的 Sheet 让 Excel 打开就报 #REF!。
    let has_rollforward_sheet = params.get("jeSource").is_some();
    let amount_rows = [
        ("已实现汇兑损益测算", "realizedGainLoss"),
        ("未实现汇兑损益测算", "unrealizedAdjustment"),
        ("自动测算合计", "automaticMeasuredFxGainLoss"),
        ("待复核项目（账面金额）", "pendingReviewAmount"),
        ("暂估审计汇兑损益", "auditFxGainLoss"),
        ("TB财务费用—汇兑损益", "tbFxGainLoss"),
        ("测算差异", "difference"),
    ];
    for (offset, (label, key)) in amount_rows.iter().enumerate() {
        let row = (offset + 4) as u32;
        sheet.write_string(row, 0, *label).map_err(xlsx_err)?;
        let cached = summary.get(*key).and_then(Value::as_f64).unwrap_or(0.0);
        let gain_loss_column = if summary
            .get("accountTranslationEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "Q"
        } else {
            "P"
        };
        let formula = match *key {
            "realizedGainLoss" => format!(
                "SUMIF('汇兑损益测算'!$C:$C,\"已实现\",'汇兑损益测算'!${0}:${0})",
                gain_loss_column
            ),
            // 未实现的逐月重估不落在「汇兑损益测算」页（那张表只有凭证级
            // 的已实现与待复核行），必须 SUM 滚动页的「月末重估损益」公式列，
            // 否则 Excel 打开重算时该公式取到 0，结论页金额全部归零。
            "unrealizedAdjustment" => {
                if has_rollforward_sheet {
                    "SUM('外币余额滚动'!$L:$L)".to_owned()
                } else {
                    String::new()
                }
            }
            "automaticMeasuredFxGainLoss" => "SUM(B5:B6)".to_owned(),
            "pendingReviewAmount" => format!(
                "SUMIF('汇兑损益测算'!$C:$C,\"待复核\",'汇兑损益测算'!${0}:${0})",
                gain_loss_column
            ),
            "auditFxGainLoss" => "B7".to_owned(),
            "difference" => "B9-B10".to_owned(),
            _ => String::new(),
        };
        if formula.is_empty() {
            sheet
                .write_number_with_format(row, 1, cached, &amount)
                .map_err(xlsx_err)?;
        } else {
            sheet
                .write_formula_with_format(
                    row,
                    1,
                    Formula::new(formula).set_result(cached.to_string()),
                    &amount,
                )
                .map_err(xlsx_err)?;
        }
    }
    sheet.write_string(11, 0, "差异率").map_err(xlsx_err)?;
    let ratio = summary
        .get("differenceRatio")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    sheet
        .write_formula_with_format(
            11,
            1,
            Formula::new("IFERROR(ABS(B11/B10),0)").set_result(ratio.to_string()),
            &percent,
        )
        .map_err(xlsx_err)?;
    sheet.write_string(12, 0, "勾稽结果").map_err(xlsx_err)?;
    let passed = summary
        .get("reconciliationPassed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // 与引擎判定一致：|TB|<0.01 无法计算差异率视为不通过；否则差异率<5% 通过。
    // 必须是活公式——此前写死「通过」，数字归零后出现“差异率 100% 仍显示通过”。
    sheet
        .write_formula_with_format(
            12,
            1,
            Formula::new(concat!(
                "IF(ABS(B10)<0.01,\"不通过\",",
                "IF(ABS(B11/B10)<0.05,\"通过\",\"不通过\"))"
            ))
            .set_result(if passed { "通过" } else { "不通过" }),
            if passed { &pass } else { &fail },
        )
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(14, 0, "测算类型", &header)
        .map_err(xlsx_err)?;
    sheet
        .write_string_with_format(14, 1, "测算方法、公式及数据来源", &header)
        .map_err(xlsx_err)?;
    let method_text = Format::new().set_text_wrap();
    let methods = [
        (
            "已实现",
            "已实现独立重算：已实现损益＝（实际成交价－月初牌价）×原币。成交价优于官方牌价的价差随兑换即已实现，属已实现损益的组成部分；成交价按凭证两条现金腿倒算（银行回单事实），取不到时以记账日官方牌价替代并提示。账面＝原币×月初牌价（上月末重估同一快照点），资产减少方向损益＝账面－成交折算，负债相反。官方牌价全程仅作对照披露。数据来源：完整JE凭证、官方汇率快照。",
        ),
        (
            "未实现",
            "未实现账户余额法：按公司＋科目＋币种＋辅助核算，以期初外币余额加正常业务JE原币发生额滚动至月末；客户已入账未实现汇兑损益及其冲回从正常发生额中剔除。月末审计余额＝月末原币余额×月末官方汇率；审计未实现损益与客户已入账金额单独比较。TB无原币余额时，以期初本位币÷期初官方汇率估算期初原币并标记为受限测算。",
        ),
        (
            "待确认",
            "待确认项目仅披露，不进入审计测算。用户确认为已实现后，工具执行结算事件独立重算；确认为未实现后，该凭证仅作为客户已入账未实现汇兑损益或冲回证据，从正常JE发生额中剔除并用于账户级比较，不采用该凭证金额作为审计测算结果。Excel中的调整需导回工具后重算。",
        ),
        (
            "TB对比",
            "优先取TB累计/YTD本位币净额；只有借方发生额和贷方发生额两列同时映射时才采用借方减贷方。单边MTD字段不得覆盖YTD累计字段。数据来源：TB财务费用—汇兑损益明细科目。",
        ),
    ];
    for (offset, (kind, detail)) in methods.iter().enumerate() {
        let row = (15 + offset) as u32;
        sheet.write_string(row, 0, *kind).map_err(xlsx_err)?;
        sheet
            .write_string_with_format(row, 1, *detail, &method_text)
            .map_err(xlsx_err)?;
        sheet.set_row_height(row, 54).map_err(xlsx_err)?;
    }
    sheet.set_column_width(0, 32).map_err(xlsx_err)?;
    sheet.set_column_width(1, 96).map_err(xlsx_err)?;
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
    setup(sheet, "分类调整")?;
    let headers = [
        "凭证类型（借贷科目组合）",
        "凭证数量",
        "示例凭证号",
        "导出时分类",
        "借方科目（代码/英文名/中文名）",
        "贷方科目（代码/英文名/中文名）",
        "凭证摘要",
        "用户调整分类",
        "重算状态",
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
        .cloned()
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
        .allow_list_strings(&["已实现汇兑损益", "未实现汇兑损益", "待确认"])
        .map_err(xlsx_err)?;
    for (index, (pattern_key, items)) in groups.iter().enumerate() {
        let row = (index + 1) as u32;
        let classifications = items
            .iter()
            .filter_map(|item| item.get("classification").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        let classification = if classifications.len() == 1 {
            classifications.iter().next().copied().unwrap_or("待确认")
        } else {
            "待确认"
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
        let statuses = items
            .iter()
            .filter_map(|item| item.get("measurementStatus").and_then(Value::as_str))
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
            (8, &statuses),
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
    sheet.set_column_hidden(11).map_err(xlsx_err)?;
    sheet.set_column_hidden(12).map_err(xlsx_err)?;
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
    // 单独输出到“外币余额滚动”和“客户重估比较”模块。
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
    setup(sheet, "汇兑损益测算")?;
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

/// 「外币余额滚动」专属导出器：固定列序并写入活公式，保证底稿可追溯——
/// 审计月末本位币余额 = 月末原币余额 × 月末官方中间价（J 列），
/// 月末重估损益 = 测算前本位币余额 − 审计月末本位币余额（L 列）。
/// 审计结论页的未实现公式直接 SUM 该 L 列，打开 Excel 重算仍能复现，
/// 任意一行都能用同行原币与汇率手工验算。此前用按键名排序的通用转储，
/// 结论页公式引用不到数据，重算后全部归零（曾显示为占位横线）。
/// 注意：S 列业务本位币发生额对已实现重算过的腿是审计口径
/// （原币×月初牌价），与客户账面之差在末列「已实现腿入账基础差异」披露，
/// 避免已实现损益在月末重估残差里被重复计算。
fn write_unrealized_rollforward_sheet(
    workbook: &mut Workbook,
    value: Option<&Value>,
) -> Result<(), AppError> {
    let rows = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let rate_format = Format::new().set_num_format("0.00000000");
    let wrap = Format::new().set_text_wrap();
    let sheet = workbook.add_worksheet();
    setup(sheet, "外币余额滚动")?;
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
        ("realizedLegBasisDifference", "已实现腿入账基础差异（账面−审计）"),
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
        for (column, key, format) in [
            (8u16, "officialRate", &rate_format),
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
            row.get("businessFunctionalMovement").and_then(Value::as_f64),
            row.get("preRevaluationFunctional").and_then(Value::as_f64),
        ) {
            (Some(_prior), Some(change), Some(pre)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        10,
                        Formula::new(format!("Q{excel_row}+S{excel_row}")).set_result(
                            pre.to_string(),
                        ),
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
                    Formula::new(format!("H{excel_row}*I{excel_row}")).set_result(
                        cached.to_string(),
                    ),
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
                    Formula::new(format!("K{excel_row}-J{excel_row}")).set_result(
                        (pre - audit).to_string(),
                    ),
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
            row.get("clientBookedUnrealizedGainLoss").and_then(Value::as_f64),
            row.get("suggestedAdjustment").and_then(Value::as_f64),
        ) {
            (Some(gain_loss), Some(booked), Some(suggested)) => {
                sheet
                    .write_formula_with_format(
                        output_row,
                        12,
                        Formula::new(format!("L{excel_row}-N{excel_row}")).set_result(
                            suggested.to_string(),
                        ),
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
                        Formula::new(format!("J{excel_row}-K{excel_row}")).set_result(
                            adjustment.to_string(),
                        ),
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
            row.get("tbReconciliationDifference").and_then(Value::as_f64),
        ) {
            (Some(audit), Some(tb), difference) => {
                let cached = difference.unwrap_or(audit - tb);
                sheet
                    .write_formula_with_format(
                        output_row,
                        22,
                        Formula::new(format!("J{excel_row}-V{excel_row}")).set_result(
                            cached.to_string(),
                        ),
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
        if !is_je_business_row(row, &mapping) || parse_date(cell(row, &mapping, "date")).is_none()
        {
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
        let mut summaries = BTreeSet::new();
        let mut voucher_type = String::new();
        let mut entities: BTreeSet<String> = BTreeSet::new();
        let mut has_fx = false;
        let mut fx_account_names: BTreeSet<String> = BTreeSet::new();
        let mut monetary_has_foreign_movement = false;
        let mut monetary_has_functional_movement = false;
        for row in voucher {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            let entity = entity_for(row, &mapping, params).to_owned();
            let functional = functional_currency(&entity, params);
            entities.insert(entity.clone());
            let summary = cell(row, &mapping, "summary").trim();
            if !summary.is_empty() {
                summaries.insert(summary.to_owned());
            }
            if voucher_type.is_empty() {
                let candidate = cell(row, &mapping, "voucherType").trim().to_uppercase();
                if !candidate.is_empty() {
                    voucher_type = candidate;
                }
            }
            // 金额解析失败不在本函数报错（约定是不阻断测算）：跳过该行金额信号，
            // 硬错误由主测算路径统一报告。
            let functional_amount = signed_amount(row, &mapping, "functional").ok();
            let foreign_amount = signed_amount(row, &mapping, "foreign").ok();
            if role == "fx_gain_loss" {
                has_fx = true;
                fx_account_names.insert(account.clone());
            }
            if !matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                continue;
            }
            if let (Some(foreign), Some(functional_value)) = (foreign_amount, functional_amount) {
                monetary_has_foreign_movement |= foreign.abs() >= 0.01;
                monetary_has_functional_movement |= functional_value.abs() >= 0.01;
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
        let summary = summaries.into_iter().collect::<Vec<_>>().join(" | ");
        // 与 calculate_monthly_unrealized 的 revaluation_meta 判定保持同一口径：
        // 人工分类优先；无人工分类时科目名写明「未实现」或完整凭证具备重估
        // 结构特征（原币不动、本位币变化）均可认领，文字证据不作门槛。
        let name_signal = classify_by_account_names(fx_account_names.iter().map(String::as_str))
            == Some("未实现汇兑损益");
        let automatic_signal = name_signal
            || has_unrealized_voucher_structure(
                has_fx,
                monetary_has_foreign_movement,
                monetary_has_functional_movement,
            );
        let is_revaluation = match manual_classification(params, &display_id) {
            Some("未实现汇兑损益") => true,
            Some("已实现汇兑损益" | "待确认") => false,
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
        assert!((opening - 7.1).abs() < 1e-9, "月初牌价应取1月31日点：{opening}");
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
        // RowRecord 借用原表数据，测试里的字面量都是 'static，显式标注让闭包能返回它。
        let row = |account: &'static str, amount: &'static str| RowRecord {
            source_row: 1,
            values: HashMap::from([
                ("科目".into(), account.into()),
                ("金额".into(), amount.into()),
            ]),
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
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot).unwrap();
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
        assert!(
            (calculation[0]["monthOpeningRate"].as_f64().unwrap() - 7.15).abs() < 0.0001
        );
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
        let (calculation, classes, _quality) = calculate_realized(&params, &snapshot).unwrap();
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
        let (calculation, classes, _quality) = calculate_realized(&params, &snapshot).unwrap();
        // 外币兑换：外币现金与本位币现金对转。统一公式下审计损益
        // ＝外币腿×(记账日7.2−月初7.15)＝100000×0.05＝5,000（负号＝收益）。
        // 客户按银行实际牌价收到 718,000 与账面 715,000 的差 −3,000，
        // 两口径之差（点差与月初基础差）自然落入审计与账面的比较披露。
        assert_eq!(calculation.len(), 1, "{calculation:#?}");
        assert_eq!(classes[0]["classification"], "已实现");
        assert_eq!(
            calculation[0]["calculationMethod"],
            "外币兑换：月初牌价与交易日官方牌价独立重算"
        );
        assert!(
            (calculation[0]["monthOpeningRate"].as_f64().unwrap() - 7.15).abs() < 0.0001
        );
        assert!((calculation[0]["auditGainLoss"].as_f64().unwrap() + 5000.0).abs() < 0.01);
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
        let conflict = settled["classificationConflict"].as_str().unwrap_or_default();
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
        )
        .unwrap();
        assert_eq!(rows.len(), 1, "quality={quality:#?}");
        let row = &rows[0];
        assert_eq!(row["businessForeignMovement"], json!(-100.0));
        assert_eq!(
            row["businessFunctionalMovement"], json!(-715.0),
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
        assert_eq!(row["clientRevaluationBalanceAdjustment"], json!(-20.0), "{row}");
        assert_eq!(row["clientBookedUnrealizedGainLoss"], json!(20.0), "{row}");
        let details = row["clientRevaluationDetails"].as_array().unwrap();
        assert_eq!(details.len(), 1, "{row}");
        assert_eq!(details[0]["voucherId"], json!("E-2025-01-31-V001"));
        assert_eq!(
            details[0]["identificationBasis"],
            json!("系统按完整凭证识别为未实现汇兑损益或其冲回凭证")
        );
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
    fn 月末重估识别_结构满足即成立_文字证据仅作分层() {
        // 结构满足（含汇兑科目、原币不动、本位币变化）即认定为重估，
        // 不再要求凭证类型或摘要里有重估字样。
        assert!(has_unrealized_voucher_structure(true, false, true));
        // 期间损益结转没有外币货币性项目本位币变化，不得误判为重估。
        assert!(!has_unrealized_voucher_structure(true, false, false));
        // 原币发生变化的是结算/正常业务，不属于未实现。
        assert!(!has_unrealized_voucher_structure(true, true, true));
        // 无汇兑损益科目不进汇兑人口。
        assert!(!has_unrealized_voucher_structure(false, false, true));
        // 文字证据分层：有则不提示，无则出非阻断提示供抽查。
        assert!(has_revaluation_text_evidence("OP-FO-2401汇兑损益结转", ""));
        assert!(has_revaluation_text_evidence("", "FX"));
        assert!(has_revaluation_text_evidence("", "AB"));
        assert!(!has_revaluation_text_evidence("调整", "记"));
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
        let (realized, classes, quality) = calculate_realized(&params, &snapshot).unwrap();
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
            result["clientRevaluationVouchers"]
                .as_array()
                .map(Vec::len),
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
        let row = RowRecord {
            source_row: 2,
            values: HashMap::from([
                ("公司".into(), "A".into()),
                ("日期".into(), "2025-01-02".into()),
                ("凭证".into(), "9".into()),
                ("类型".into(), "记".into()),
            ]),
        };
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
        assert_eq!(reader.sheet_names(), &["汇兑损益测算"]);
        let range = reader.worksheet_range("汇兑损益测算").unwrap();
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

    // 回归：Excel 打开时会全量重算（rust_xlsxwriter 默认 fullCalcOnLoad），
    // 结论页公式必须能在明细页里找到数据，否则写死的缓存值一打开就归零，
    // 出现「界面通过、Excel 里差异率 100%」的自相矛盾底稿。
    #[test]
    fn conclusion_formulas_recalculate_from_visible_sheets() {
        let path =
            std::env::temp_dir().join(format!("fx-traceable-conclusion-{}.xlsx", std::process::id()));
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
        assert!(names.contains(&"外币余额滚动".to_owned()), "{names:?}");
        assert!(names.contains(&"审计结论".to_owned()), "{names:?}");

        // 缓存值（给不重算的预览器用）与引擎一致。
        let conclusions = reader
            .worksheet_range("审计结论")
            .unwrap();
        assert!(
            (conclusions.get_value((5, 1)).and_then(Data::as_f64).unwrap_or(f64::NAN)
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
            texts.iter().any(|t| t.contains("$L:$L") && t.contains("外币余额滚动")),
            "未实现公式应引用外币余额滚动!$L:$L，实际 {texts:?}"
        );
        assert!(
            texts.iter().any(|t| t.contains("ABS(B11/B10)") && t.contains("<0.05")),
            "勾稽结果应为差异率<5% 的活公式，实际 {texts:?}"
        );

        // 滚动页逐行可手工验算：J=原币×中间价，L=测算前−审计折算。
        let rollforward_formulas = reader.worksheet_formula("外币余额滚动").unwrap();
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
        let row = RowRecord {
            source_row: 2,
            values: HashMap::from([
                ("科目代码".into(), "1002010017".into()),
                ("科目名称一级".into(), "货币资金".into()),
                ("科目名称二级".into(), "货币资金-银行存款".into()),
            ]),
        };
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
        let row = |code: &'static str, text: &'static str, currency: &'static str| RowRecord {
            source_row: 2,
            values: HashMap::from([
                ("公司代码".into(), "4800".into()),
                ("科目代码".into(), code.into()),
                ("科目名称二级".into(), "货币资金-银行存款".into()),
                ("货币".into(), "USD".into()),
                ("交易币种".into(), currency.into()),
                ("文本".into(), text.into()),
            ]),
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
        let tb_table = load_fx_table(
            &serde_json::from_value(params["tbSource"].clone()).unwrap(),
        )
        .unwrap();
        let tb_mapping = mapping_obj(&params, "tbMapping");
        let (_rows, quality) = calculate_inferred_opening_unrealized(
            &params,
            &snapshot,
            NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            NaiveDate::from_ymd_opt(2025, 12, 31).unwrap(),
            &tb_table,
            &tb_mapping,
            &[],
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
                    item["account"].as_str() == Some(account)
                        && item["type"].as_str() == Some(kind)
                })
                .cloned()
                .unwrap_or_else(|| panic!("{account} 应当留下「{kind}」记录：{quality:#?}"))
        };
        // 甲：日元原币恒为零，不该再被判成「多种外币」；真正的障碍是沉淀了本位币。
        let mixed = issue_of("2202010001", "科目余额混合本位币与外币");
        assert_eq!(mixed["currency"], "CNY");
        assert!(
            mixed["detail"].as_str().unwrap_or("").contains("按币种拆分"),
            "要告诉用户补什么资料：{mixed:#}"
        );
        assert!(
            !has_issue("2202010001", "同一科目存在多种外币敞口"),
            "原币为零的日元不构成敞口，不该报成多币种：{quality:#?}"
        );
        // 乙：影子科目所有币种原币都是零，归到「无外币敞口」。
        let shadow = issue_of("2202010002", "无外币敞口的评估调整科目");
        assert!(
            shadow["detail"].as_str().unwrap_or("").contains("原科目"),
            "要指引用户去看对应的原科目：{shadow:#}"
        );
        // 丙、丁：干净的港币户和纯本位币科目都不该被报成粒度问题。
        // 2202030101 的外币行一借一贷抵平（净额为零），它只是个本位币科目——
        // 按累计绝对值判敞口会把这类科目误报，实测 4800 有 5 个。
        for account in ["1002010021", "2202030101"] {
            for kind in [
                "科目余额混合本位币与外币",
                "同一科目存在多种外币敞口",
                "无外币敞口的评估调整科目",
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
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot).unwrap();
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
        let root = std::env::temp_dir().join(format!("fx-no-line-conversion-{}", std::process::id()));
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
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot).unwrap();
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
        assert_eq!(class_of("7"), "已实现候选", "并排结息不得被认领为兑换");
        assert_eq!(class_of("8"), "已实现候选", "投资款本位币腿非现金，不得认领");
        assert!(
            quality.iter().any(|item| item["type"]
                == "外币业务凭证不构成汇兑事项"),
            "剩余候选凭证应有聚合提示：{quality:#?}"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn 无重估文字证据但结构符合的凭证按未实现处理并提示() {
        // 凭证4：类型「记」、摘要「调整」，无任何重估字样；但结构上原币
        // 不动、本位币变化、含汇兑科目 → 直接按未实现识别，另出非阻断
        // 「重估凭证无文字证据」提示供抽查。
        // 凭证5：同样结构但类型是 FX → 同样按未实现识别，且不出提示。
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
        let (calculation, classes, quality) = calculate_realized(&params, &snapshot).unwrap();
        assert!(calculation.is_empty(), "未实现凭证不进已实现测算：{calculation:#?}");
        for class in &classes {
            assert_eq!(class["classification"], "未实现", "{class:#?}");
        }
        let no_text: Vec<&Value> = quality
            .iter()
            .filter(|q| q["type"] == "重估凭证无文字证据")
            .collect();
        assert_eq!(no_text.len(), 1, "只有凭证4出提示：{quality:#?}");
        assert_eq!(no_text[0]["severity"], json!("提示"));
        assert!(no_text[0]["voucherId"].as_str().unwrap().contains('4'));
        fs::remove_dir_all(root).unwrap();
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
