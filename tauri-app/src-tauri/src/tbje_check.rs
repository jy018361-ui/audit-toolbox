//! TBJE 完整性核对：上传科目余额表与序时账之后，跑三条体检。
//!
//! 三条都**只提示不拦截**。实务里尾差、审计调整前后口径差异、序时账只覆盖部分
//! 期间都太常见，拦下来会挡住正常工作；这个工具的价值是把「映射反了、少传了
//! 一段期间、科目表不完整」这类问题在动手做底稿之前就摆到台面上。
//!
//! 1. **TB 发生额与余额勾稽**：期初 ＋ 借方发生 − 贷方发生 ＝ 期末，逐行验。
//!    本期发生与本年累计两组列都在时，按逐行通过率整表自动选用（[`arbitrate_movement_basis`]）；
//!    判定复用 [`fx::tb_self_rollforward`]，与汇兑损益上传时看到的是同一份结论。
//! 2. **TB 与 JE 发生额勾稽**：按主体＋科目编码汇总，**借贷两侧分开比**。
//!    只比净额会漏掉「借贷双方同时虚增」这种错。
//! 3. **BS 与 PL 勾稽**：全类别余额加总为零。
//!
//! 第 3 条为什么不写成「资产 ＝ 负债 ＋ 权益」——实测样例给了答案：某套账年末
//! 资产减负债减权益差 36,868,034.59，而它的损益类科目余额正好是 −36,868,034.59。
//! 年末 TB 里损益类还没结转到未分配利润，按「资产＝负债＋权益」判，这套平的账
//! 会被报成不平。**全类别加总为零**对年初、年末都成立，也不用管结转没结转。
//!
//! 三条都建立在「只算末级科目」之上。父子科目混排的余额表不做末级过滤，
//! 光第 3 条就能差出几亿——那纯粹是父行子行各加了一遍。

use regex::Regex;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook, Worksheet};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    fx::{self, FxTable, SourceSpec, load_fx_table},
    ledger_mapping::{self, AccountCategory, SignConvention},
    tabular::{self, PreparedDiskLedger},
};

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message.into(), false, detail)
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "tbje_check.run" => run(&params, &AtomicBool::new(false)),
        _ => Err(error("METHOD_NOT_FOUND", "未知方法。", Some(method.into()))),
    }
}

pub(crate) fn is_supported_job_method(method: &str) -> bool {
    matches!(
        method,
        "tbje_check.run" | "tbje_check.run_batch" | "tbje_check.export" | "tbje_check.export_batch"
    )
}

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

/// 走任务通道：序时账可能有几十万行，读取与汇总都得能给进度、能取消。
pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: Progress,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    match method {
        "tbje_check.run" => {
            progress("read", 1, 3, "正在读取科目余额表与序时账…");
            pause.wait()?;
            let result = run_with_progress(&params, &cancel, progress)?;
            progress("done", 3, 3, "核对完成。");
            Ok(result)
        }
        "tbje_check.run_batch" => run_batch(&params, progress, &cancel, pause),
        "tbje_check.export" => {
            progress("read", 1, 3, "正在读取科目余额表与序时账…");
            pause.wait()?;
            let prepared = prepare_with_control(&params, &cancel, progress)?;
            let result = evaluate(&prepared, &cancel, true)?;
            pause.wait()?;
            progress("write", 2, 3, "正在写出核对明细…");
            let path = export(&params, &result, &prepared)?;
            progress("done", 3, 3, "明细已导出。");
            Ok(json!({ "outputPath": path.to_string_lossy(), "result": result }))
        }
        "tbje_check.export_batch" => export_batch(&params, progress, &cancel, pause),
        _ => Err(error("METHOD_NOT_FOUND", "未知方法。", Some(method.into()))),
    }
}

// ────────────────────────────── 取数 ──────────────────────────────

fn mapping_of(params: &Value, key: &str) -> Map<String, Value> {
    params
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn columns(map: &Map<String, Value>, role: &str) -> Vec<String> {
    match map.get(role) {
        Some(Value::String(one)) if !one.trim().is_empty() => vec![one.clone()],
        Some(Value::Array(all)) => all
            .iter()
            .filter_map(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}

fn indexes(table: &FxTable, map: &Map<String, Value>, role: &str) -> Vec<usize> {
    columns(map, role)
        .iter()
        .filter_map(|name| ledger_mapping::header_index(&table.headers, name))
        .collect()
}

fn text(table: &FxTable, row: &[String], map: &Map<String, Value>, role: &str) -> String {
    indexes(table, map, role)
        .first()
        .and_then(|index| row.get(*index))
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn joined(table: &FxTable, row: &[String], map: &Map<String, Value>, role: &str) -> String {
    indexes(table, map, role)
        .iter()
        .filter_map(|index| row.get(*index))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 科目身份原料：主体、归一化编码、名称。编码与名称混写在一格时先拆开。
fn identity_parts(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
) -> (String, String, String) {
    let entity = text(table, row, map, "entity");
    let entity = if entity.is_empty() {
        fixed.to_owned()
    } else {
        entity
    };
    let raw = text(table, row, map, "accountCode");
    let code = ledger_mapping::account_code_of(&raw);
    let name = display_name(table, row, map);
    (entity, ledger_mapping::normalize_account_code(&code), name)
}

/// 不需要跨表消歧的分类、展示路径仍取主体＋编码。
fn identity(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
) -> (String, String) {
    let (entity, code, _) = identity_parts(table, row, map, fixed);
    (entity, code)
}

fn matched_identity(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
    policy: &ledger_mapping::AccountMatchPolicy,
) -> (String, String) {
    let (entity, code, name) = identity_parts(table, row, map, fixed);
    let account = policy.account_key(&entity, &code, &name);
    (entity, account)
}

fn scoped_identity_parts(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
    side: ledger_mapping::EntitySide,
    scope: &ledger_mapping::EntityScope,
) -> (String, String, String) {
    let (entity, code, name) = identity_parts(table, row, map, fixed);
    (
        ledger_mapping::apply_entity_scope(side, &entity, scope),
        code,
        name,
    )
}

fn scoped_matched_identity(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
    side: ledger_mapping::EntitySide,
    scope: &ledger_mapping::EntityScope,
    policy: &ledger_mapping::AccountMatchPolicy,
) -> (String, String) {
    let (entity, code, name) = scoped_identity_parts(table, row, map, fixed, side, scope);
    let account = policy.account_key(&entity, &code, &name);
    (entity, account)
}

fn display_name(table: &FxTable, row: &[String], map: &Map<String, Value>) -> String {
    let name = joined(table, row, map, "accountName");
    if name.is_empty() {
        ledger_mapping::account_name_of(&text(table, row, map, "accountCode"))
    } else {
        ledger_mapping::account_name_of(&name)
    }
}

/// TB 行自身标注的币种。不同币种拆成多行时必须把每一行的币种证据保留下来；
/// 同一行另有原币、本位币金额列时，金额选择仍由映射角色决定，不在这里混算。
fn tb_row_currency(table: &FxTable, row: &[String], map: &Map<String, Value>) -> String {
    for role in ["currency", "functionalCurrency"] {
        let value = text(table, row, map, role);
        if let Some(code) = ledger_mapping::normalize_currency_code(&value) {
            return code.to_owned();
        }
    }
    let hint = text(table, row, map, "currencyText");
    ledger_mapping::currency_from_text(&hint).unwrap_or_default()
}

fn load(
    params: &Value,
    key: &str,
    label: &str,
) -> Result<Option<std::sync::Arc<FxTable>>, AppError> {
    let Some(source) = params.get(key) else {
        return Ok(None);
    };
    let spec: SourceSpec = serde_json::from_value(source.clone()).map_err(|e| {
        error(
            "INVALID_PARAMS",
            &format!("{label}参数无效。"),
            Some(e.to_string()),
        )
    })?;
    load_fx_table(&spec).map(Some)
}

struct PreparedCheck {
    tb: Arc<FxTable>,
    je: Option<PreparedJe>,
    tb_map: Map<String, Value>,
    je_map: Map<String, Value>,
    tb_fixed: String,
    je_fixed: String,
    mapping_warnings: Vec<String>,
    /// 发生额口径仲裁触发时给导出说明用的一句话；未触发（单组或打平）为空。
    movement_note: Option<String>,
    /// TBJE 公共核对永远保留全部非空行。币种只用于判断列语义，不能成为行过滤条件。
    tb_rows: Vec<bool>,
    je_rows: Option<Vec<bool>>,
    entity_scope: ledger_mapping::EntityScope,
    /// 映射阶段已验证的辅助列计划需用原始来源与映射重算指纹。
    auxiliary_plan_params: Option<Value>,
}

/// Small ledgers retain the existing in-memory table. Large CSV ledgers keep
/// only a bounded inspection sample in `table`; their rows remain in SQLite.
struct PreparedJe {
    table: Arc<FxTable>,
    disk: Option<PreparedDiskLedger>,
}

impl PreparedJe {
    fn memory(table: Arc<FxTable>) -> Self {
        Self { table, disk: None }
    }
}

fn all_nonblank_rows(table: &FxTable) -> Vec<bool> {
    table
        .rows
        .iter()
        .map(|row| row.iter().any(|value| !value.trim().is_empty()))
        .collect()
}

fn tb_period_warning(table: &FxTable) -> Option<String> {
    static PERIOD: OnceLock<Regex> = OnceLock::new();
    let pattern = PERIOD.get_or_init(|| {
        Regex::new(
            r"(?x)
            (?P<year>20\d{2})\s*(?:年|[./_-])\s*
            (?P<start>\d{1,2})\s*月?\s*(?:-|—|–|~|至|到)\s*
            (?:(?P<end_year>20\d{2})\s*(?:年|[./_-])\s*)?
            (?P<end>\d{1,2})\s*月?",
        )
        .expect("TB period regex")
    });
    let mut evidence = vec![
        table
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_owned(),
        table.sheet.clone(),
    ];
    evidence.extend(table.raw_headers.iter().flatten().cloned());
    for text in evidence {
        let Some(found) = pattern.captures(&text) else {
            continue;
        };
        let year = found.name("year")?.as_str().parse::<u16>().ok()?;
        let start = found.name("start")?.as_str().parse::<u8>().ok()?;
        let end = found.name("end")?.as_str().parse::<u8>().ok()?;
        let end_year = found
            .name("end_year")
            .and_then(|value| value.as_str().parse::<u16>().ok())
            .unwrap_or(year);
        if !(1..=12).contains(&start) || !(1..=12).contains(&end) {
            continue;
        }
        if year == end_year && start == 1 && end == 12 {
            return None;
        }
        let shown = if year == end_year {
            format!("{year}.{start}-{end}")
        } else {
            format!("{year}.{start}-{end_year}.{end}")
        };
        return Some(format!(
            "TB期间为 {shown}，不是完整自然年；发生额口径已按「期初＋发生＝期末」的逐行通过率在本期与本年累计之间自动选用，请以核对说明标注的口径为准。"
        ));
    }
    None
}

/// 以指定的一对借贷发生额列试跑 TB 逐行勾稽，返回 (有效行数, 通过行数)。
/// 判定与「TB 发生额与余额勾稽」完全同款：同一垃圾行掩码、同一符号口径、
/// 同一容差、同一全零行跳过规则，保证预检通过率就是正式核对的结果。
fn movement_pass_score(
    tb: &FxTable,
    map: &Map<String, Value>,
    debit: &str,
    credit: &str,
) -> (usize, usize) {
    let mut candidate = map.clone();
    candidate.insert("ytdFunctionalDebit".into(), Value::String(debit.to_owned()));
    candidate.insert(
        "ytdFunctionalCredit".into(),
        Value::String(credit.to_owned()),
    );
    let junk =
        ledger_mapping::ledger_junk_mask(&tb.headers, &tb.rows, &|role| columns(&candidate, role));
    let records = fx::records(tb);
    let mut eligible = 0usize;
    let mut passed = 0usize;
    for (index, row) in tb.rows.iter().enumerate() {
        if !junk.get(index).copied().unwrap_or(true) {
            continue;
        }
        let Some(record) = records.get(index) else {
            continue;
        };
        let (Ok(open), Ok(close), Ok((debit_amount, credit_amount))) = (
            fx::signed_amount(record, &candidate, "openingFunctional"),
            fx::signed_amount(record, &candidate, "closingFunctional"),
            fx::side_amounts(record, &candidate, "ytdFunctional"),
        ) else {
            continue;
        };
        if open == 0.0 && close == 0.0 && debit_amount == 0.0 && credit_amount == 0.0 {
            continue;
        }
        eligible += 1;
        let derived = open + debit_amount - credit_amount;
        if !beyond(
            derived - close,
            open.abs().max(close.abs().max(derived.abs())),
        ) {
            passed += 1;
        }
    }
    (eligible, passed)
}

/// 本期发生与本年累计两组借贷列同时映射时的口径仲裁：各自试跑逐行勾稽，
/// 谁通过的行多，整张表统一用谁；打平维持本年累计（全年表两者等价，与
/// 历史行为一致）。切换方式与 [`fx::promote_period_movement`] 同款——把
/// 本期列写进本位币发生额角色，下游三条核对与导出无需再分叉。
///
/// 勾稽等式「期初＋借方发生－贷方发生＝期末」里的发生额必须覆盖期初→期末
/// 这一段：中期表（如 2024.4-12）只有本期发生满足等式，本年累计会把一季度
/// 发生额错算成差异。判定只看数据本身，不依赖表头有没有写期间文字。
/// 切换成功时返回给用户的说明，未切换时返回 `None`。
fn arbitrate_movement_basis(tb: &FxTable, tb_map: &mut Map<String, Value>) -> Option<String> {
    let Some(ytd_debit) = columns(tb_map, "ytdFunctionalDebit").first().cloned() else {
        return None;
    };
    let Some(ytd_credit) = columns(tb_map, "ytdFunctionalCredit").first().cloned() else {
        return None;
    };
    let Some(period_debit) = columns(tb_map, "periodFunctionalDebit").first().cloned() else {
        return None;
    };
    let Some(period_credit) = columns(tb_map, "periodFunctionalCredit").first().cloned() else {
        return None;
    };
    let (ytd_eligible, ytd_passed) = movement_pass_score(tb, tb_map, &ytd_debit, &ytd_credit);
    let (period_eligible, period_passed) =
        movement_pass_score(tb, tb_map, &period_debit, &period_credit);
    if period_passed <= ytd_passed {
        return None;
    }
    tb_map.insert("ytdFunctionalDebit".into(), Value::String(period_debit));
    tb_map.insert("ytdFunctionalCredit".into(), Value::String(period_credit));
    tb_map.remove("periodFunctionalDebit");
    tb_map.remove("periodFunctionalCredit");
    Some(format!(
        "发生额口径：TB 同时映射了本期发生与本年累计，逐行勾稽预检本期发生通过 {period_passed}/{period_eligible} 行、本年累计通过 {ytd_passed}/{ytd_eligible} 行，已整表统一采用「本期发生」核对。"
    ))
}

fn align_account_mappings(
    tb: &FxTable,
    tb_map: &mut Map<String, Value>,
    je: &FxTable,
    je_map: &mut Map<String, Value>,
) -> Result<Vec<String>, AppError> {
    let Some(tb_column) = columns(tb_map, "accountCode").first().cloned() else {
        return Ok(Vec::new());
    };
    let Some(je_column) = columns(je_map, "accountCode").first().cloned() else {
        return Ok(Vec::new());
    };
    let (overlap, je_count, tb_count) = ledger_mapping::mapped_account_overlap(
        &je.headers,
        &je.rows,
        &je_column,
        &tb.headers,
        &tb.rows,
        &tb_column,
    );
    if overlap > 0 {
        let mut warnings = Vec::new();
        if je_count >= 10 && overlap * 10 < je_count.min(tb_count) {
            warnings.push(format!(
                "TB与JE当前科目编码仅有 {overlap}/{} 项交集，请结合账套范围复核。",
                je_count.min(tb_count)
            ));
        }
        return Ok(warnings);
    }

    Err(error(
        "TBJE_ACCOUNT_MAPPING_MISMATCH",
        "TB与JE的科目编码完全对不上。请使用 LLM 复核或在映射面板人工确认两边的科目编码列，系统不会自动替换。",
        Some(format!(
            "JE列“{je_column}”有 {je_count} 个编码，TB列“{tb_column}”有 {tb_count} 个编码，交集为0。"
        )),
    ))
}

fn prepare(params: &Value) -> Result<PreparedCheck, AppError> {
    prepare_with_control(params, &AtomicBool::new(false), &|_, _, _, _| {})
}

fn prepared_disk_je(
    spec: &SourceSpec,
    je_map: &Map<String, Value>,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<PreparedJe, AppError> {
    let disk = tabular::open_prepared_disk_ledger(
        &PathBuf::from(&spec.input_path),
        spec.header_row,
        spec.header_depth.max(1),
        je_map,
        progress,
        cancel,
    )?;
    let mut sample_rows = Vec::new();
    disk.visit_limit(false, 10_000, cancel, |row| {
        sample_rows.push(row.values);
        Ok(())
    })?;
    let headers = disk.headers().to_vec();
    let width = headers.len();
    let table = Arc::new(FxTable {
        path: PathBuf::from(&spec.input_path),
        sheet: if spec.sheet.trim().is_empty() {
            "CSV".to_owned()
        } else {
            spec.sheet.clone()
        },
        sheets: Vec::new(),
        header_row: spec.header_row,
        header_depth: spec.header_depth.max(1),
        raw_headers: vec![headers.clone()],
        headers,
        rows: sample_rows
            .into_iter()
            .map(|mut row| {
                row.resize(width, String::new());
                row
            })
            .collect(),
        row_count: disk.row_count(),
        header_candidates: Vec::new(),
        sampled: true,
    });
    Ok(PreparedJe {
        table,
        disk: Some(disk),
    })
}

fn prepare_with_control(
    params: &Value,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<PreparedCheck, AppError> {
    let tb = load(params, "tbSource", "TB")?.ok_or_else(|| {
        error(
            "TBJE_CHECK_NO_TB",
            "请先上传科目余额表——三条核对都以它为准。",
            None,
        )
    })?;
    let mut tb_map = mapping_of(params, "tbMapping");
    let mut je_map = mapping_of(params, "jeMapping");
    let je_spec = params
        .get("jeSource")
        .map(|source| {
            serde_json::from_value::<SourceSpec>(source.clone())
                .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))
        })
        .transpose()?;
    let mut je = match je_spec.as_ref() {
        Some(spec)
            if tabular::disk_ledger_applies(&PathBuf::from(&spec.input_path))
                || (cfg!(test)
                    && params
                        .get("__testForceDiskLedger")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)) =>
        {
            Some(prepared_disk_je(spec, &je_map, progress, cancel)?)
        }
        Some(spec) => Some(PreparedJe::memory(load_fx_table(spec)?)),
        None => None,
    };
    let mut tb_fixed = params
        .get("tbFixedEntity")
        .and_then(Value::as_str)
        .unwrap_or(ledger_mapping::DEFAULT_ENTITY)
        .trim()
        .to_owned();
    let mut je_fixed = params
        .get("jeFixedEntity")
        .and_then(Value::as_str)
        .unwrap_or(ledger_mapping::DEFAULT_ENTITY)
        .trim()
        .to_owned();
    if tb_fixed.is_empty() {
        tb_fixed = ledger_mapping::DEFAULT_ENTITY.to_owned();
    }
    if je_fixed.is_empty() {
        je_fixed = ledger_mapping::DEFAULT_ENTITY.to_owned();
    }
    let entity_scope = params
        .get("entityScope")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| error("INVALID_PARAMS", "主体口径参数无效。", Some(e.to_string())))?
        .unwrap_or_default();

    let je_map_before_alignment = je_map.clone();
    let mut mapping_warnings = if let Some(je) = je.as_ref() {
        align_account_mappings(&tb, &mut tb_map, &je.table, &mut je_map)?
    } else {
        Vec::new()
    };

    // 磁盘规范化缓存的正文判定、账户键和向下填充都依赖映射。若跨表校验纠正了
    // JE 映射，必须用纠正后的映射重开缓存；只改 je_map 会让后续汇总继续读取按
    // 错误科目列建成的 prepared 数据，极端情况下会静默漏行。
    if je_map != je_map_before_alignment && je.as_ref().is_some_and(|value| value.disk.is_some()) {
        if let Some(spec) = je_spec.as_ref() {
            je = Some(prepared_disk_je(spec, &je_map, progress, cancel)?);
        }
    }

    // 流水级导出没有汇总行，末级判定的金额勾稽折叠在该类表上已跳过（公共引擎
    // 统一行为）。核对口径变了必须让用户知道，否则与旧结果对不上时无从解释。
    if ledger_mapping::tb_is_posting_level_export(&tb.headers, &tb.rows, &|role| {
        columns(&tb_map, role)
    }) {
        mapping_warnings.push(
            "余额表识别为流水级导出（带凭证/期间列与多辅助维度，逐笔列示、无汇总行），已跳过“汇总行金额勾稽”剔除，全部数据行参与核对。"
                .to_owned(),
        );
    }

    if let Some(je) = je.as_ref() {
        let je = &*je.table;
        if columns(&je_map, "entity").iter().any(|column| {
            ledger_mapping::entity_column_is_measurement_unit(&je.headers, &je.rows, column)
        }) {
            je_map.remove("entity");
            mapping_warnings.push(
                "JE原主体映射实际为KG、EA、BOX等计量单位，已从主体键中移除，避免拆碎凭证分组。"
                    .to_owned(),
            );
        }
        let tb_has_entity = !columns(&tb_map, "entity").is_empty();
        let je_has_entity = !columns(&je_map, "entity").is_empty();
        let entity_key_enabled = ledger_mapping::entity_key_enabled(tb_has_entity, je_has_entity);
        if !entity_key_enabled && (tb_has_entity || je_has_entity) {
            let (table, label) = if tb_has_entity {
                (&*tb, "TB")
            } else {
                (je, "JE")
            };
            let source_mapping = if tb_has_entity { &tb_map } else { &je_map };
            let entities = indexes(table, source_mapping, "entity")
                .first()
                .map(|index| {
                    table
                        .rows
                        .iter()
                        .filter_map(|row| row.get(*index))
                        .map(|value| value.trim())
                        .filter(|value| !value.is_empty())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();
            // 只有双侧都有主体字段时才启用主体维度。单侧主体不是筛选条件，
            // 双方统一退回默认主体，避免一侧拆分、另一侧汇总后完全对不上。
            tb_map.remove("entity");
            je_map.remove("entity");
            tb_fixed = ledger_mapping::DEFAULT_ENTITY.to_owned();
            je_fixed = ledger_mapping::DEFAULT_ENTITY.to_owned();
            mapping_warnings.push(format!(
                "{label}识别到{}个主体，而另一侧没有可用主体字段；双方已统一按“默认主体”匹配，不把单边主体值作为拆分键。",
                entities.len()
            ));
        }
    }
    let mut je_rows = if let Some(je) = je.as_ref() {
        let je = &*je.table;
        let analysis = ledger_mapping::analyze_ledger_rows(&je.headers, &je.rows, &|role| {
            columns(&je_map, role)
        });
        if !analysis.invalid_account_code_rows.is_empty() {
            let rows = analysis
                .invalid_account_code_rows
                .iter()
                .take(20)
                .map(|(index, value)| {
                    format!(
                        "{}（{}）",
                        je.header_row + je.header_depth + index + 1,
                        value
                    )
                })
                .collect::<Vec<_>>()
                .join("、");
            mapping_warnings.push(format!(
                "JE存在不符合科目编码格式的行，已排除且未猜测继承编码：工作表“{}”，源表行 {rows}。",
                je.sheet
            ));
        }
        Some(analysis.keep)
    } else {
        None
    };
    let tb_analysis =
        ledger_mapping::analyze_ledger_rows(&tb.headers, &tb.rows, &|role| columns(&tb_map, role));
    if !tb_analysis.invalid_account_code_rows.is_empty() {
        let rows = tb_analysis
            .invalid_account_code_rows
            .iter()
            .take(20)
            .map(|(index, value)| {
                format!(
                    "{}（{}）",
                    tb.header_row + tb.header_depth + index + 1,
                    value
                )
            })
            .collect::<Vec<_>>()
            .join("、");
        mapping_warnings.push(format!(
            "TB存在不符合科目编码格式的行，已排除且未猜测继承编码：工作表“{}”，源表行 {rows}。",
            tb.sheet
        ));
    }
    let tb_rows_to_validate =
        ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| columns(&tb_map, role));
    validate_amount_columns("TB", "tb", &tb, &tb_map, Some(&tb_rows_to_validate))?;
    if let Some(je) = je.as_ref().filter(|je| je.disk.is_none()) {
        validate_amount_columns("JE", "je", &je.table, &je_map, je_rows.as_deref())?;
    }
    if let Some(memory_je) = je.as_mut().filter(|value| value.disk.is_none()) {
        memory_je.table = fx::forward_filled_je_table(&memory_je.table, &je_map);
        // 填充后按「合计屏障」重判行集：合并单元格补齐身份的真分录、名称
        // 整列空白的 SAP 导出照常进入；合计行之后未通过重开门槛的表尾草稿
        // （10 号样例 2556.54 错位进科目列，实测差出 5.5 亿）不再整表放行。
        je_rows = Some(ledger_mapping::ledger_post_fill_body_mask(
            &memory_je.table.headers,
            &memory_je.table.rows,
            &|role| columns(&je_map, role),
        ));
    }
    fx::ensure_sign_convention(&tb, &mut tb_map, "tb")
        .map_err(|message| error("SIGN_CONVENTION_UNCERTAIN", message, None))?;
    if let Some(je) = je.as_ref().filter(|je| je.disk.is_none()) {
        fx::ensure_sign_convention(&je.table, &mut je_map, "je")
            .map_err(|message| error("SIGN_CONVENTION_UNCERTAIN", message, None))?;
    }
    let tb_rows = all_nonblank_rows(&tb);
    let movement_note = arbitrate_movement_basis(&tb, &mut tb_map);
    if let Some(note) = &movement_note {
        mapping_warnings.push(note.clone());
    }
    if let Some(warning) = tb_period_warning(&tb) {
        mapping_warnings.push(warning);
    }
    Ok(PreparedCheck {
        tb,
        je,
        tb_map,
        je_map,
        tb_fixed,
        je_fixed,
        mapping_warnings,
        movement_note,
        tb_rows,
        je_rows,
        entity_scope,
        auxiliary_plan_params: params.get("auxiliaryPlan").map(|_| params.clone()),
    })
}

fn validate_amount_columns(
    label: &str,
    kind: &str,
    table: &FxTable,
    mapping: &Map<String, Value>,
    keep: Option<&[bool]>,
) -> Result<(), AppError> {
    let issues =
        ledger_mapping::mapped_amount_parse_issues(kind, &table.headers, &table.rows, &|role| {
            columns(mapping, role)
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
            let source_row = table.header_row + table.header_depth + issue.row_index;
            format!(
                "{}（{}）第{}行=“{}”",
                issue.column, issue.label, source_row, issue.value
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    // 首处位置折进主文案：job 失败事件只回传 user_message，留在 detail 里
    // 用户看不到（与看账内存/磁盘路径同款措辞）。
    let first = &issues[0];
    Err(error(
        "AMOUNT_VALUE_INVALID",
        format!(
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

// ────────────────────────────── 三条核对 ──────────────────────────────

const TOLERANCE: f64 = 0.01;

/// 差异是否超出容差。账面金额都是两位小数，一分钱以内当尾差。
fn beyond(difference: f64, scale: f64) -> bool {
    difference.abs() > TOLERANCE.max(scale.abs() * 1e-8)
}

pub(crate) fn run(params: &Value, cancel: &AtomicBool) -> Result<Value, AppError> {
    run_with_progress(params, cancel, &|_, _, _, _| {})
}

fn run_with_progress(
    params: &Value,
    cancel: &AtomicBool,
    progress: Progress<'_>,
) -> Result<Value, AppError> {
    let prepared = prepare_with_control(params, cancel, progress)?;
    evaluate(&prepared, cancel, false)
}

fn evaluate(
    prepared: &PreparedCheck,
    cancel: &AtomicBool,
    include_all_accounts: bool,
) -> Result<Value, AppError> {
    let tb_has_entity = !columns(&prepared.tb_map, "entity").is_empty();
    let je_has_entity = prepared.je.is_some() && !columns(&prepared.je_map, "entity").is_empty();
    let entity_key_enabled = ledger_mapping::entity_key_enabled(tb_has_entity, je_has_entity);
    // 符号口径在 `prepare` 中判一次并写进映射，三条核对与正式导出共用。
    let rollforward = check_rollforward(&prepared.tb, &prepared.tb_map);
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let equation = check_equation(
        &prepared.tb,
        &prepared.tb_map,
        &prepared.tb_fixed,
        &prepared.tb_rows,
    );
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let tb_vs_je = match prepared.je.as_ref() {
        Some(je) => check_tb_vs_je(
            &prepared.tb,
            &prepared.tb_map,
            &prepared.tb_fixed,
            je,
            &prepared.je_map,
            &prepared.je_fixed,
            cancel,
            include_all_accounts,
            &prepared.tb_rows,
            prepared.je_rows.as_deref().unwrap_or(&[]),
            &prepared.entity_scope,
            prepared.auxiliary_plan_params.as_ref(),
        )?,
        None => json!({
            "performed": false,
            "reason": "未上传序时账，跳过发生额核对。"
        }),
    };

    // 辅助核算联动的降级提示并进 mappingWarnings，与既有警告同一展示通道。
    let mut mapping_warnings = prepared.mapping_warnings.clone();
    if let Some(warnings) = tb_vs_je.get("auxiliaryWarnings").and_then(Value::as_array) {
        mapping_warnings.extend(warnings.iter().filter_map(Value::as_str).map(str::to_owned));
    }

    Ok(json!({
        "rollforward": rollforward,
        "tbVsJe": tb_vs_je,
        "equation": equation,
        "mappingWarnings": mapping_warnings,
        "entityScope": {
            "mode": if entity_key_enabled { "entity" } else { "defaultEntity" },
            "defaultEntity": ledger_mapping::DEFAULT_ENTITY,
            "description": if entity_key_enabled {
                "TB 与 JE 双侧均映射主体，主体作为匹配、汇总与测算键。"
            } else {
                "TB 与 JE 未同时映射主体，双方统一按“默认主体”处理。"
            },
            "selection": prepared.entity_scope,
        },
        "currencyScope": {
            "functionalCurrency": Value::Null,
            "mode": "allRows",
            "description": "币种只用于判断列语义；TBJE 核对不按币种过滤行。",
            "includedRows": prepared.tb_rows.iter().filter(|included| **included).count(),
            "excludedForeignRows": 0,
            "functionalRowsExcludedForOtherChecks": 0,
        },
    }))
}

/// 一次核对多组账。
///
/// 每组一份余额表配一份序时账。**一组跑完再跑下一组**——序时账动辄几十万行，
/// 并行跑十组会把内存顶穿；串行还能逐组报进度，用户看得见跑到哪了。
///
/// 单组失败不打断整批：把错误记在那一组上继续往下跑。十组里有一组文件损坏，
/// 不该让另外九组的结论一起丢掉。
fn run_batch(
    params: &Value,
    progress: Progress,
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let groups = params
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| error("INVALID_PARAMS", "缺少要核对的分组。", None))?;
    let total = groups.len().max(1);
    let mut results = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        pause.wait()?;
        let label = group
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        progress(
            "check",
            index + 1,
            total,
            &format!(
                "正在核对第 {} / {total} 组{}…",
                index + 1,
                if label.is_empty() {
                    String::new()
                } else {
                    format!("（{label}）")
                }
            ),
        );
        match run_with_progress(group, cancel, progress) {
            Ok(result) => results.push(json!({ "label": label, "ok": true, "result": result })),
            // 取消要中断整批，别的错误只记在这一组上。
            Err(e) if e.code == "JOB_CANCELLED" => return Err(e),
            Err(e) => results.push(json!({
                "label": label,
                "ok": false,
                "error": e.user_message,
            })),
        }
    }
    progress("done", total, total, "全部核对完成。");
    Ok(json!({ "groups": results }))
}

/// 一键导出全部已完成分组。
///
/// 每组仍保留一份独立的三页工作簿，避免十组的同名核对页混在一个文件里难以定位；
/// 前端只需选择一次目录。单组失败不会抹掉已经成功写出的其他组。
fn export_batch(
    params: &Value,
    progress: Progress,
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let groups = params
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| error("INVALID_PARAMS", "缺少要导出的分组。", None))?;
    if groups.is_empty() {
        return Err(error("INVALID_PARAMS", "没有可导出的核对结果。", None));
    }
    let raw_dir = params
        .get("outputDirectory")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw_dir.is_empty() {
        return Err(error(
            "OUTPUT_REQUIRED",
            "请选择全部结果的输出文件夹。",
            None,
        ));
    }
    let output_directory = PathBuf::from(raw_dir);
    std::fs::create_dir_all(&output_directory)
        .map_err(|e| error("IO_ERROR", "无法创建输出目录。", Some(e.to_string())))?;

    let total = groups.len();
    let mut output_paths = Vec::new();
    let mut results = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        pause.wait()?;
        if cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        let label = group
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let display_label = if label.is_empty() {
            (index + 1).to_string()
        } else {
            label.to_owned()
        };
        progress(
            "export",
            index + 1,
            total,
            &format!("正在导出第 {display_label} 组（{} / {total}）…", index + 1),
        );

        let safe_label: String = display_label
            .chars()
            .map(|ch| {
                if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                    '_'
                } else {
                    ch
                }
            })
            .collect();
        let output_path = output_directory.join(format!("第{safe_label}组_完整性核对.xlsx"));
        let mut export_params = group.clone();
        export_params["outputPath"] = json!(output_path.to_string_lossy());

        let exported =
            prepare_with_control(&export_params, cancel, progress).and_then(|prepared| {
                let result = evaluate(&prepared, cancel, true)?;
                let path = export(&export_params, &result, &prepared)?;
                Ok(path)
            });
        match exported {
            Ok(path) => {
                output_paths.push(path.to_string_lossy().into_owned());
                results.push(json!({ "label": display_label, "ok": true, "outputPath": path.to_string_lossy() }));
            }
            Err(e) if e.code == "JOB_CANCELLED" => return Err(e),
            Err(e) => results.push(json!({
                "label": display_label,
                "ok": false,
                "error": e.user_message,
            })),
        }
    }
    progress("done", total, total, "全部核对结果已导出。");
    Ok(json!({
        "outputDirectory": output_directory.to_string_lossy(),
        "outputPaths": output_paths,
        "exports": results,
    }))
}

// ────────────────────────────── 导出明细 ──────────────────────────────

fn output_path(params: &Value) -> Result<PathBuf, AppError> {
    let raw = params
        .get("outputPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw.is_empty() {
        return Err(error("OUTPUT_REQUIRED", "请选择 Excel 输出路径。", None));
    }
    let mut path = PathBuf::from(raw);
    if path.extension().is_none() {
        path.set_extension("xlsx");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| error("IO_ERROR", "无法创建输出目录。", Some(e.to_string())))?;
    }
    Ok(path)
}

fn xlsx(e: rust_xlsxwriter::XlsxError) -> AppError {
    error("EXPORT_FAILED", "写出核对明细失败。", Some(e.to_string()))
}

const EXPORT_HEADER_ROW: u32 = 5;
const EXPORT_DATA_ROW: u32 = 6;

fn title_format() -> Format {
    Format::new()
        .set_font_name("Arial")
        .set_font_size(15)
        .set_bold()
        .set_font_color("#1E2A32")
        .set_background_color("#FFE600")
}

fn header_format() -> Format {
    Format::new()
        .set_font_name("Arial")
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_font_color("#FFFFFF")
        .set_background_color("#126E72")
        .set_border(FormatBorder::Thin)
}

fn input_text_format() -> Format {
    Format::new()
        .set_font_name("Arial")
        .set_font_color("#0000FF")
}

fn input_money_format() -> Format {
    input_text_format().set_num_format("#,##0.00;[Red](#,##0.00);-")
}

fn formula_money_format() -> Format {
    Format::new()
        .set_font_name("Arial")
        .set_num_format("#,##0.00;[Red](#,##0.00);-")
}

fn formula_text_format() -> Format {
    Format::new().set_font_name("Arial")
}

fn write_intro(
    sheet: &mut Worksheet,
    title: &str,
    note: &str,
    source: &str,
    last_column: u16,
) -> Result<(), AppError> {
    sheet
        .merge_range(0, 0, 0, last_column, title, &title_format())
        .map_err(xlsx)?;
    sheet.write_string(1, 0, "核对说明").map_err(xlsx)?;
    sheet.write_string(1, 1, note).map_err(xlsx)?;
    sheet.write_string(2, 0, "容差").map_err(xlsx)?;
    sheet
        .write_number_with_format(
            2,
            1,
            TOLERANCE,
            &Format::new()
                .set_font_name("Arial")
                .set_background_color("#FFF9D6")
                .set_num_format("0.00"),
        )
        .map_err(xlsx)?;
    sheet.write_string(3, 0, "数据来源").map_err(xlsx)?;
    sheet.write_string(3, 1, source).map_err(xlsx)?;
    Ok(())
}

fn finish_sheet(sheet: &mut Worksheet, widths: &[f64], last_row: u32) -> Result<(), AppError> {
    for (column, width) in widths.iter().enumerate() {
        sheet
            .set_column_width(column as u16, *width)
            .map_err(xlsx)?;
    }
    sheet
        .set_landscape()
        .set_paper_size(9)
        .set_print_fit_to_pages(1, 0)
        .set_margins(0.25, 0.25, 0.35, 0.35, 0.2, 0.2);
    sheet.set_freeze_panes(EXPORT_DATA_ROW, 0).map_err(xlsx)?;
    if last_row >= EXPORT_HEADER_ROW {
        sheet
            .autofilter(
                EXPORT_HEADER_ROW,
                0,
                last_row.max(EXPORT_DATA_ROW),
                widths.len() as u16 - 1,
            )
            .map_err(xlsx)?;
    }
    Ok(())
}

fn has_balance_scheme(map: &Map<String, Value>, prefix: &str) -> bool {
    !columns(map, &format!("{prefix}Amount")).is_empty()
        || (!columns(map, &format!("{prefix}Debit")).is_empty()
            && !columns(map, &format!("{prefix}Credit")).is_empty())
}

/// 0 基列号转 Excel 列字母（A、B、…、Z、AA…）。主体列有无会让整表公式平移，
/// 公式里的列引用必须按实际列号生成，不能写死字母。
fn column_letter(mut index: u16) -> String {
    let mut text = String::new();
    loop {
        text.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    text
}

fn write_rollforward_sheet(
    workbook: &mut Workbook,
    prepared: &PreparedCheck,
) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("TB发生额与余额勾稽").map_err(xlsx)?;
    // 主体列只在用户映射了 TB 主体时输出，与「TB与JE发生额勾稽」表同置首列；
    // 未映射时整表布局与旧版一致。合并余额表逐行勾稽时靠它分清行属于哪个主体。
    let has_entity = !columns(&prepared.tb_map, "entity").is_empty();
    let mut headers: Vec<&str> = vec![
        "TB纳入币种",
        "源表行号",
        "科目编码",
        "科目名称",
        "期初余额",
        "TB借方发生额",
        "TB贷方发生额",
        "公式期末",
        "TB期末余额",
        "差异",
        "结论",
    ];
    if has_entity {
        headers.insert(0, "主体");
    }
    let mut description =
        "按TB每个币种行分别验证：期初余额＋借方发生额－贷方发生额＝期末余额；同一行另有原币金额列时只核对本位币金额列。"
            .to_owned();
    if let Some(note) = &prepared.movement_note {
        description.push_str(note);
    }
    write_intro(
        sheet,
        "TB 发生额与余额勾稽",
        &description,
        &prepared.tb.path.to_string_lossy(),
        headers.len() as u16 - 1,
    )?;
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(EXPORT_HEADER_ROW, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }

    let junk = ledger_mapping::ledger_junk_mask(&prepared.tb.headers, &prepared.tb.rows, &|role| {
        columns(&prepared.tb_map, role)
    });
    let records = fx::records(&prepared.tb);
    let mut output_row = EXPORT_DATA_ROW;
    for (opening, closing, debit_role, credit_role) in [(
        "openingFunctional",
        "closingFunctional",
        "ytdFunctionalDebit",
        "ytdFunctionalCredit",
    )] {
        if !has_balance_scheme(&prepared.tb_map, opening)
            || !has_balance_scheme(&prepared.tb_map, closing)
            || columns(&prepared.tb_map, debit_role).is_empty()
            || columns(&prepared.tb_map, credit_role).is_empty()
        {
            continue;
        }
        for (index, row) in prepared.tb.rows.iter().enumerate() {
            if !junk.get(index).copied().unwrap_or(true) {
                continue;
            }
            let Some(record) = records.get(index) else {
                continue;
            };
            let (Ok(open), Ok(close), Ok((debit, credit))) = (
                fx::signed_amount(record, &prepared.tb_map, opening),
                fx::signed_amount(record, &prepared.tb_map, closing),
                fx::side_amounts(record, &prepared.tb_map, "ytdFunctional"),
            ) else {
                continue;
            };
            if open == 0.0 && close == 0.0 && debit == 0.0 && credit == 0.0 {
                continue;
            }
            let (entity, code) = identity(&prepared.tb, row, &prepared.tb_map, &prepared.tb_fixed);
            let name = display_name(&prepared.tb, row, &prepared.tb_map);
            let currency = match tb_row_currency(&prepared.tb, row, &prepared.tb_map) {
                value if value.is_empty() => "未标明".to_owned(),
                value => value,
            };
            let source_row = prepared.tb.header_row + prepared.tb.header_depth + index + 1;
            let excel_row = output_row + 1;
            let derived = open + debit - credit;
            let difference = derived - close;
            let verdict = if beyond(difference, open.abs().max(close.abs().max(derived.abs()))) {
                "差异"
            } else {
                "通过"
            };
            let mut column = 0u16;
            if has_entity {
                sheet
                    .write_string_with_format(output_row, column, &entity, &input_text_format())
                    .map_err(xlsx)?;
                column += 1;
            }
            sheet
                .write_string_with_format(output_row, column, &currency, &input_text_format())
                .map_err(xlsx)?;
            column += 1;
            sheet
                .write_number_with_format(
                    output_row,
                    column,
                    source_row as f64,
                    &input_text_format(),
                )
                .map_err(xlsx)?;
            column += 1;
            sheet
                .write_string_with_format(output_row, column, &code, &input_text_format())
                .map_err(xlsx)?;
            column += 1;
            sheet
                .write_string_with_format(output_row, column, &name, &input_text_format())
                .map_err(xlsx)?;
            let open_col = column + 1;
            let debit_col = open_col + 1;
            let credit_col = open_col + 2;
            let derived_col = open_col + 3;
            let close_col = open_col + 4;
            let diff_col = open_col + 5;
            for (column, value) in [
                (open_col, open),
                (debit_col, debit),
                (credit_col, credit),
                (close_col, close),
            ] {
                sheet
                    .write_number_with_format(output_row, column, value, &input_money_format())
                    .map_err(xlsx)?;
            }
            let (open_l, debit_l, credit_l, derived_l, close_l, diff_l) = (
                column_letter(open_col),
                column_letter(debit_col),
                column_letter(credit_col),
                column_letter(derived_col),
                column_letter(close_col),
                column_letter(diff_col),
            );
            sheet
                .write_formula_with_format(
                    output_row,
                    derived_col,
                    Formula::new(format!(
                        "{open_l}{excel_row}+{debit_l}{excel_row}-{credit_l}{excel_row}"
                    ))
                    .set_result(derived.to_string()),
                    &formula_money_format(),
                )
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    output_row,
                    diff_col,
                    Formula::new(format!("{derived_l}{excel_row}-{close_l}{excel_row}"))
                        .set_result(difference.to_string()),
                    &formula_money_format(),
                )
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    output_row,
                    diff_col + 1,
                    Formula::new(format!(
                        "IF(ABS({diff_l}{excel_row})<=MAX($B$3,MAX(ABS({open_l}{excel_row}),ABS({derived_l}{excel_row}),ABS({close_l}{excel_row}))*1E-8)),\"通过\",\"差异\")"
                    ))
                    .set_result(verdict),
                    &formula_text_format(),
                )
                .map_err(xlsx)?;
            output_row += 1;
        }
    }
    let mut widths: Vec<f64> = vec![
        10.0, 12.0, 16.0, 28.0, 16.0, 17.0, 17.0, 16.0, 16.0, 15.0, 10.0,
    ];
    if has_entity {
        widths.insert(0, 18.0);
    }
    finish_sheet(sheet, &widths, output_row.saturating_sub(1))
}

fn write_tbje_sheet(
    workbook: &mut Workbook,
    result: &Value,
    prepared: &PreparedCheck,
) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("TB与JE发生额勾稽").map_err(xlsx)?;
    let headers = [
        "主体",
        "科目编码",
        "科目名称",
        "出现在",
        "TB纳入币种",
        "TB借方",
        "JE借方",
        "借方差异",
        "TB贷方",
        "JE贷方（已统一方向）",
        "贷方差异",
        "TB净额",
        "JE净额",
        "净额差异",
        "净额结论",
        "综合结论",
    ];
    let mut tbje_description =
        "借、贷两侧分别对比；JE 贷方统一为正常贷方为正、红字冲销为负。".to_owned();
    if let Some(note) = &prepared.movement_note {
        tbje_description.push_str(note);
    }
    write_intro(
        sheet,
        "TB 与 JE 发生额勾稽",
        &tbje_description,
        prepared
            .je
            .as_ref()
            .map(|je| je.table.path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未提供序时账".to_owned())
            .as_str(),
        headers.len() as u16 - 1,
    )?;
    for (column, title) in headers.iter().enumerate() {
        sheet
            .write_string_with_format(EXPORT_HEADER_ROW, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }
    let items = result
        .pointer("/tbVsJe/items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    for (index, item) in items.iter().enumerate() {
        let output_row = EXPORT_DATA_ROW + index as u32;
        let excel_row = output_row + 1;
        let presence = match item["presence"].as_str() {
            Some("tbOnly") => "仅余额表有",
            Some("jeOnly") => "仅序时账有",
            _ => "两边都有",
        };
        let tb_scope = match item["tbIncludedRows"].as_u64().unwrap_or(0) {
            0 => String::new(),
            rows => {
                let currencies = item["tbIncludedCurrencies"]
                    .as_str()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("未标明");
                format!("{currencies}（{rows}行）")
            }
        };
        for (column, value) in [
            item["entity"].as_str().unwrap_or(""),
            item["code"].as_str().unwrap_or(""),
            item["name"].as_str().unwrap_or(""),
            presence,
            tb_scope.as_str(),
        ]
        .iter()
        .enumerate()
        {
            sheet
                .write_string_with_format(output_row, column as u16, *value, &input_text_format())
                .map_err(xlsx)?;
        }
        let tb_debit = item["tbDebit"].as_f64().unwrap_or(0.0);
        let je_debit = item["jeDebit"].as_f64().unwrap_or(0.0);
        let tb_credit = item["tbCredit"].as_f64().unwrap_or(0.0);
        let je_credit = item["jeCredit"].as_f64().unwrap_or(0.0);
        for (column, value) in [(5, tb_debit), (6, je_debit), (8, tb_credit), (9, je_credit)] {
            sheet
                .write_number_with_format(output_row, column, value, &input_money_format())
                .map_err(xlsx)?;
        }
        let debit_difference = tb_debit - je_debit;
        let credit_difference = tb_credit - je_credit;
        let tb_net = tb_debit - tb_credit;
        let je_net = je_debit - je_credit;
        let net_difference = tb_net - je_net;
        let off = beyond(debit_difference, tb_debit.max(je_debit))
            || beyond(credit_difference, tb_credit.max(je_credit));
        let net_off = beyond(net_difference, tb_net.abs().max(je_net.abs()));
        sheet
            .write_formula_with_format(
                output_row,
                7,
                Formula::new(format!("F{excel_row}-G{excel_row}"))
                    .set_result(debit_difference.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                10,
                Formula::new(format!("I{excel_row}-J{excel_row}"))
                    .set_result(credit_difference.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                11,
                Formula::new(format!("F{excel_row}-I{excel_row}")).set_result(tb_net.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                12,
                Formula::new(format!("G{excel_row}-J{excel_row}")).set_result(je_net.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                13,
                Formula::new(format!("L{excel_row}-M{excel_row}"))
                    .set_result(net_difference.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                14,
                Formula::new(format!(
                    "IF(ABS(N{excel_row})<=MAX($B$3,MAX(ABS(L{excel_row}),ABS(M{excel_row}))*1E-8),\"通过\",\"不通过\")"
                ))
                .set_result(if net_off { "不通过" } else { "通过" }),
                &formula_text_format(),
            )
            .map_err(xlsx)?;
        let overall = if net_off {
            "不通过"
        } else if off {
            "净额通过，单边发生额有差异"
        } else {
            "通过"
        };
        sheet
            .write_formula_with_format(
                output_row,
                15,
                Formula::new(format!(
                    "IF(O{excel_row}=\"不通过\",\"不通过\",IF(OR(ABS(H{excel_row})>MAX($B$3,MAX(ABS(F{excel_row}),ABS(G{excel_row}))*1E-8),ABS(K{excel_row})>MAX($B$3,MAX(ABS(I{excel_row}),ABS(J{excel_row}))*1E-8)),\"净额通过，单边发生额有差异\",\"通过\"))"
                ))
                .set_result(overall),
                &formula_text_format(),
            )
            .map_err(xlsx)?;
    }
    finish_sheet(
        sheet,
        &[
            18.0, 16.0, 28.0, 15.0, 22.0, 16.0, 16.0, 15.0, 16.0, 23.0, 15.0, 16.0, 16.0, 15.0,
            12.0, 30.0,
        ],
        EXPORT_DATA_ROW + items.len().saturating_sub(1) as u32,
    )
}

struct EquationDetail {
    period: &'static str,
    source_row: usize,
    code: String,
    name: String,
    category: String,
    amount: f64,
    included: bool,
}

fn equation_details(prepared: &PreparedCheck) -> Vec<EquationDetail> {
    let records = fx::records(&prepared.tb);
    let leaf = ledger_mapping::tb_leaf_mask(&prepared.tb.headers, &prepared.tb.rows, &|role| {
        columns(&prepared.tb_map, role)
    });
    let mut details = Vec::new();
    let convention = fx::sign_convention_of(&prepared.tb_map);
    let opening_basis = ledger_mapping::balance_sign_basis_by_row(
        &prepared.tb.headers,
        &prepared.tb.rows,
        &|role| columns(&prepared.tb_map, role),
        "openingFunctional",
        convention,
    );
    let closing_basis = ledger_mapping::balance_sign_basis_by_row(
        &prepared.tb.headers,
        &prepared.tb.rows,
        &|role| columns(&prepared.tb_map, role),
        "closingFunctional",
        convention,
    );
    for (index, row) in prepared.tb.rows.iter().enumerate() {
        if !prepared.tb_rows.get(index).copied().unwrap_or(true) {
            continue;
        }
        if !leaf.get(index).copied().unwrap_or(true) {
            continue;
        }
        let (_, code) = identity(&prepared.tb, row, &prepared.tb_map, &prepared.tb_fixed);
        if code.is_empty() {
            continue;
        }
        let Some(record) = records.get(index) else {
            continue;
        };
        let category = ledger_mapping::account_category(&code);
        let name = display_name(&prepared.tb, row, &prepared.tb_map);
        let source_row = prepared.tb.header_row + prepared.tb.header_depth + index + 1;
        for (period, prefix, basis) in [
            ("年初", "openingFunctional", &opening_basis),
            ("年末", "closingFunctional", &closing_basis),
        ] {
            details.push(EquationDetail {
                period,
                source_row,
                code: code.clone(),
                name: name.clone(),
                category: category
                    .map(AccountCategory::label)
                    .unwrap_or("未分类")
                    .to_owned(),
                amount: fx::signed_amount(record, &prepared.tb_map, prefix).unwrap_or(0.0),
                included: basis
                    .get(index)
                    .copied()
                    .is_some_and(ledger_mapping::BalanceSignBasis::is_reliable),
            });
        }
    }
    details
}

fn write_equation_sheet(workbook: &mut Workbook, prepared: &PreparedCheck) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("BS与PL勾稽").map_err(xlsx)?;
    let categories = [
        "资产",
        "负债",
        "共同",
        "所有者权益",
        "成本",
        "损益",
        "未分类",
    ];
    let summary_headers = [
        "时点",
        "会计要素",
        "带符号金额",
        "金额结论",
        "分类结论",
        "说明",
        "",
    ];
    write_intro(
        sheet,
        "BS 与 PL 勾稽",
        "按会计要素汇总带符号余额；金额是否为 0 与科目是否全部完成分类分别给结论。",
        &prepared.tb.path.to_string_lossy(),
        summary_headers.len() as u16 - 1,
    )?;
    for (column, title) in summary_headers.iter().enumerate() {
        sheet
            .write_string_with_format(EXPORT_HEADER_ROW, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }

    let details = equation_details(prepared);
    // 每个期间包含全部分类行和一行合计；额外留一行空白后再写明细表头。
    let detail_header_row = EXPORT_DATA_ROW + ((categories.len() + 1) * 2) as u32 + 1;
    let detail_data_row = detail_header_row + 1;
    let detail_last_row = detail_data_row + details.len().saturating_sub(1) as u32;
    let mut summary_row = EXPORT_DATA_ROW;
    for period in ["年初", "年末"] {
        let period_first_row = summary_row;
        for category in categories {
            let excel_row = summary_row + 1;
            let first_detail = detail_data_row + 1;
            let last_detail = detail_last_row.max(detail_data_row) + 1;
            let amount: f64 = details
                .iter()
                .filter(|item| item.period == period && item.category == category && item.included)
                .map(|item| item.amount)
                .sum();
            sheet
                .write_string_with_format(summary_row, 0, period, &input_text_format())
                .map_err(xlsx)?;
            sheet
                .write_string_with_format(summary_row, 1, category, &input_text_format())
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    summary_row,
                    2,
                    Formula::new(format!(
                        "SUMIFS($F${first_detail}:$F${last_detail},$A${first_detail}:$A${last_detail},A{excel_row},$E${first_detail}:$E${last_detail},B{excel_row},$G${first_detail}:$G${last_detail},\"是\")"
                    ))
                    .set_result(amount.to_string()),
                    &formula_money_format(),
                )
                .map_err(xlsx)?;
            summary_row += 1;
        }
        let excel_row = summary_row + 1;
        let first_excel = period_first_row + 1;
        let last_excel = summary_row;
        let total: f64 = details
            .iter()
            .filter(|item| item.period == period && item.included)
            .map(|item| item.amount)
            .sum();
        let unclassified = details
            .iter()
            .any(|item| item.period == period && item.category == "未分类");
        let coverage_complete = details
            .iter()
            .filter(|item| item.period == period)
            .all(|item| item.included);
        let first_detail = detail_data_row + 1;
        let last_detail = detail_last_row.max(detail_data_row) + 1;
        sheet
            .write_string_with_format(summary_row, 0, period, &header_format())
            .map_err(xlsx)?;
        sheet
            .write_string_with_format(summary_row, 1, "合计（应为 0）", &header_format())
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                summary_row,
                2,
                Formula::new(format!("SUM(C{first_excel}:C{last_excel})"))
                    .set_result(total.to_string()),
                &formula_money_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                summary_row,
                3,
                Formula::new(format!(
                    "IF(COUNTIFS($A${first_detail}:$A${last_detail},A{excel_row},$G${first_detail}:$G${last_detail},\"否\")>0,\"无法完整执行\",IF(ABS(C{excel_row})<=MAX($B$3,ABS(C{excel_row})*1E-8),\"通过\",\"差异\"))"
                ))
                .set_result(if !coverage_complete {
                    "无法完整执行"
                } else if beyond(total, total) {
                    "差异"
                } else {
                    "通过"
                }),
                &formula_text_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                summary_row,
                4,
                Formula::new(format!(
                    "IF(COUNTIFS($A${first_detail}:$A${last_detail},A{excel_row},$E${first_detail}:$E${last_detail},\"未分类\")=0,\"完整\",\"待确认\")"
                ))
                .set_result(if unclassified { "待确认" } else { "完整" }),
                &formula_text_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        sheet
            .write_string_with_format(
                summary_row,
                5,
                if coverage_complete {
                    "全部方向可靠的末级科目均已纳入；金额平衡与分类完整性分开判断"
                } else {
                    "部分非零余额方向不可靠，只显示已覆盖小计，不下金额结论"
                },
                &formula_text_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        summary_row += 1;
    }

    let detail_headers = [
        "时点",
        "源表行号",
        "科目编码",
        "科目名称",
        "会计要素",
        "带符号余额",
        "是否纳入勾稽",
        "分类说明",
    ];
    for (column, title) in detail_headers.iter().enumerate() {
        sheet
            .write_string_with_format(detail_header_row, column as u16, *title, &header_format())
            .map_err(xlsx)?;
    }
    for (index, item) in details.iter().enumerate() {
        let row = detail_data_row + index as u32;
        for (column, value) in [
            item.period,
            "",
            item.code.as_str(),
            item.name.as_str(),
            item.category.as_str(),
        ]
        .iter()
        .enumerate()
        {
            if column == 1 {
                sheet
                    .write_number_with_format(row, 1, item.source_row as f64, &input_text_format())
                    .map_err(xlsx)?;
            } else {
                sheet
                    .write_string_with_format(row, column as u16, *value, &input_text_format())
                    .map_err(xlsx)?;
            }
        }
        sheet
            .write_number_with_format(row, 5, item.amount, &input_money_format())
            .map_err(xlsx)?;
        sheet
            .write_string_with_format(
                row,
                6,
                if item.included { "是" } else { "否" },
                &input_text_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_string_with_format(
                row,
                7,
                match (item.category.as_str(), item.included) {
                    ("未分类", true) => "编码无法归类，但方向可靠，已纳入金额勾稽",
                    ("未分类", false) => "编码无法归类，且余额方向无法可靠判断",
                    (_, true) => "按科目编码首位识别，方向可靠",
                    (_, false) => "已识别会计要素，但余额方向无法可靠判断",
                },
                &input_text_format(),
            )
            .map_err(xlsx)?;
    }
    for (column, width) in [18.0, 13.0, 17.0, 28.0, 16.0, 17.0, 17.0, 34.0]
        .iter()
        .enumerate()
    {
        sheet
            .set_column_width(column as u16, *width)
            .map_err(xlsx)?;
    }
    sheet
        .set_landscape()
        .set_paper_size(9)
        .set_print_fit_to_pages(1, 0)
        .set_margins(0.25, 0.25, 0.35, 0.35, 0.2, 0.2);
    sheet.set_freeze_panes(EXPORT_DATA_ROW, 0).map_err(xlsx)?;
    sheet
        .autofilter(
            detail_header_row,
            0,
            detail_last_row.max(detail_data_row),
            detail_headers.len() as u16 - 1,
        )
        .map_err(xlsx)?;
    Ok(())
}

/// 正式工作底稿固定为三页：每页保留全量取数证据，并用 Excel 公式重算差异与结论。
fn export(params: &Value, result: &Value, prepared: &PreparedCheck) -> Result<PathBuf, AppError> {
    let path = output_path(params)?;
    let mut workbook = Workbook::new();
    write_rollforward_sheet(&mut workbook, prepared)?;
    write_tbje_sheet(&mut workbook, result, prepared)?;
    write_equation_sheet(&mut workbook, prepared)?;
    workbook.save(&path).map_err(xlsx)?;
    Ok(path)
}

/// TB 发生额与余额勾稽。
fn check_rollforward(tb: &FxTable, map: &Map<String, Value>) -> Value {
    // TB 按币种拆成多行时，每行都要独立验证，不能只留下推断出的本位币行。
    // 若同一行映射了原币和本位币两套金额列，本工具只核对本位币金额角色。
    let units = fx::tb_self_rollforward_with_mask(tb, map, None)
        .into_iter()
        .filter(|unit| unit.unit == "本位币")
        .collect::<Vec<_>>();
    if units.is_empty() {
        return json!({
            "performed": false,
            "reason": "余额表缺少期初、期末或借贷发生额，无法勾稽。"
        });
    }
    let rows = units
        .iter()
        .map(|unit| {
            json!({
                "unit": "TB逐行币种",
                "checked": unit.checked,
                "mismatched": unit.issues.len(),
                "items": unit
                    .issues
                    .iter()
                    .map(|issue| {
                        let index = issue
                            .source_row
                            .saturating_sub(tb.header_row + tb.header_depth);
                        let currency = tb
                            .rows
                            .get(index)
                            .map(|row| tb_row_currency(tb, row, map))
                            .unwrap_or_default();
                        json!({
                            "sourceRow": issue.source_row,
                            "account": issue.account,
                            "currency": currency,
                            "opening": issue.opening,
                            "debit": issue.debit,
                            "credit": issue.credit,
                            "closing": issue.closing,
                            "derived": issue.opening + issue.debit - issue.credit,
                            "difference": issue.difference,
                        })
                    })
                    .collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>();
    let mismatched: usize = units.iter().map(|unit| unit.issues.len()).sum();
    let checked: usize = units.iter().map(|unit| unit.checked).sum();
    json!({
        "performed": true,
        "passed": mismatched == 0,
        "checked": checked,
        "mismatched": mismatched,
        "units": rows,
    })
}

/// BS 与 PL 勾稽：全类别余额加总为零。
fn check_equation(
    tb: &FxTable,
    map: &Map<String, Value>,
    fixed: &str,
    functional_rows: &[bool],
) -> Value {
    if columns(map, "accountCode").is_empty() {
        return json!({
            "performed": false,
            "reason": "未映射科目编码，无法判断会计要素类别。"
        });
    }
    let has_opening = !columns(map, "openingFunctionalAmount").is_empty()
        || (!columns(map, "openingFunctionalDebit").is_empty()
            && !columns(map, "openingFunctionalCredit").is_empty());
    let has_closing = !columns(map, "closingFunctionalAmount").is_empty()
        || (!columns(map, "closingFunctionalDebit").is_empty()
            && !columns(map, "closingFunctionalCredit").is_empty());
    if !has_opening && !has_closing {
        return json!({
            "performed": false,
            "reason": "余额表没有期初也没有期末余额，无法验证会计恒等式。"
        });
    }
    // 折算走 fx 的行级入口，与①勾稽、与汇兑损益是同一份实现。
    // 自己按角色名取方向列再折算过一版，04 号样例上两边取到的方向列不一致，
    // 负债和权益整片翻号、合计差出两倍资产——「业务模块不得各自实现一份」。
    let records = fx::records(tb);
    // 只算末级：父子科目混排时不过滤，父行子行各加一遍，能差出几个亿。
    let leaf = ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| columns(map, role));

    let mut opening = BTreeMap::<AccountCategory, f64>::new();
    let mut closing = BTreeMap::<AccountCategory, f64>::new();
    let mut unclassified: Vec<Value> = Vec::new();
    let mut unclassified_amount = 0.0_f64;
    let opening_basis = ledger_mapping::balance_sign_basis_by_row(
        &tb.headers,
        &tb.rows,
        &|role| columns(map, role),
        "openingFunctional",
        fx::sign_convention_of(map),
    );
    let closing_basis = ledger_mapping::balance_sign_basis_by_row(
        &tb.headers,
        &tb.rows,
        &|role| columns(map, role),
        "closingFunctional",
        fx::sign_convention_of(map),
    );
    let mut opening_total = 0.0_f64;
    let mut closing_total = 0.0_f64;
    let mut opening_included = 0usize;
    let mut closing_included = 0usize;
    let mut opening_ambiguous = 0usize;
    let mut closing_ambiguous = 0usize;
    let mut ambiguous: Vec<Value> = Vec::new();
    let mut ambiguous_count = 0usize;
    let mut counted = 0usize;
    let mut classified_count = 0usize;
    let mut unclassified_count = 0usize;
    for (index, row) in tb.rows.iter().enumerate() {
        if !functional_rows.get(index).copied().unwrap_or(true) {
            continue;
        }
        if !leaf.get(index).copied().unwrap_or(true) {
            continue;
        }
        let (_, code) = identity(tb, row, map, fixed);
        if code.is_empty() {
            continue;
        }
        let Some(record) = records.get(index) else {
            continue;
        };
        counted += 1;
        let open = fx::signed_amount(record, map, "openingFunctional").unwrap_or(0.0);
        let close = fx::signed_amount(record, map, "closingFunctional").unwrap_or(0.0);
        let open_basis = opening_basis
            .get(index)
            .copied()
            .unwrap_or(ledger_mapping::BalanceSignBasis::Ambiguous);
        let close_basis = closing_basis
            .get(index)
            .copied()
            .unwrap_or(ledger_mapping::BalanceSignBasis::Ambiguous);
        let open_reliable = !has_opening || open_basis.is_reliable();
        let close_reliable = !has_closing || close_basis.is_reliable();
        if has_opening {
            if open_reliable {
                opening_total += open;
                opening_included += 1;
            } else {
                opening_ambiguous += 1;
            }
        }
        if has_closing {
            if close_reliable {
                closing_total += close;
                closing_included += 1;
            } else {
                closing_ambiguous += 1;
            }
        }
        let category = ledger_mapping::account_category(&code);
        if let Some(category) = category {
            classified_count += 1;
            if has_opening && open_reliable {
                *opening.entry(category).or_default() += open;
            }
            if has_closing && close_reliable {
                *closing.entry(category).or_default() += close;
            }
        } else {
            unclassified_count += 1;
            unclassified_amount += close.abs().max(open.abs());
            if unclassified.len() < 50 {
                unclassified.push(json!({
                    "sourceRow": tb.header_row + index + 2,
                    "code": code,
                    "name": display_name(tb, row, map),
                    "opening": open,
                    "closing": close,
                    "openingIncluded": has_opening && open_reliable,
                    "closingIncluded": has_closing && close_reliable,
                }));
            }
        }
        if (has_opening && !open_reliable) || (has_closing && !close_reliable) {
            ambiguous_count += 1;
            if ambiguous.len() < 50 {
                ambiguous.push(json!({
                    "sourceRow": tb.header_row + index + 2,
                    "code": code,
                    "name": display_name(tb, row, map),
                    "opening": open,
                    "closing": close,
                    "openingReliable": open_reliable,
                    "closingReliable": close_reliable,
                    "openingBasis": open_basis.as_str(),
                    "closingBasis": close_basis.as_str(),
                }));
            }
        }
    }
    if counted == 0 {
        return json!({
            "performed": false,
            "reason": "没有可参与勾稽的有效末级科目，本条跳过。",
            "unclassified": unclassified,
        });
    }
    let summarize = |totals: &BTreeMap<AccountCategory, f64>,
                     total: f64,
                     included: usize,
                     ambiguous: usize,
                     enabled: bool| {
        if !enabled {
            return Value::Null;
        }
        let coverage_complete = ambiguous == 0;
        json!({
            "byCategory": totals
                .iter()
                .map(|(category, amount)| json!({
                    "category": category.label(),
                    "amount": amount,
                }))
                .collect::<Vec<_>>(),
            "total": total,
            "balanced": coverage_complete.then(|| !beyond(total, total)),
            "coverageComplete": coverage_complete,
            "includedAccounts": included,
            "ambiguousAccounts": ambiguous,
        })
    };
    let opening_value = summarize(
        &opening,
        opening_total,
        opening_included,
        opening_ambiguous,
        has_opening,
    );
    let closing_value = summarize(
        &closing,
        closing_total,
        closing_included,
        closing_ambiguous,
        has_closing,
    );
    let coverage_complete = opening_ambiguous == 0 && closing_ambiguous == 0;
    let balanced = coverage_complete
        && [&opening_value, &closing_value].iter().all(|value| {
            value
                .get("balanced")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        });
    json!({
        "performed": true,
        // 覆盖不完整时不能把可靠行小计宣称为“通过”或“不平”。`null` 是有意的
        // 第三种结论，前端应显示“无法完整执行”，而不是把它降级成 false。
        "passed": coverage_complete.then_some(balanced),
        "balancePassed": coverage_complete.then_some(balanced),
        "coverageComplete": coverage_complete,
        "conclusive": coverage_complete,
        "reason": (!coverage_complete).then_some(
            "部分非零余额既没有可靠的自带符号证据，也缺少逐行借贷方向，无法完整执行金额勾稽。"
        ),
        // 分类只负责解释，不再决定余额是否参加总额。方向可靠的未分类科目
        // 已计入 opening/closing.total，同时继续单列供用户补充分类。
        "classificationComplete": unclassified_count == 0,
        // 余额是「借正贷负已带符号」还是「借贷都记正数」，结论完全相反，
        // 把判定结果一并回给用户——算错时这是第一个要看的东西。
        "signConvention": match fx::sign_convention(map) {
            SignConvention::Signed => "signed",
            SignConvention::Unsigned => "unsigned",
        },
        "accounts": counted,
        "classifiedAccounts": classified_count,
        "unclassifiedAccounts": unclassified_count,
        "includedAccounts": counted.saturating_sub(ambiguous_count),
        "ambiguousAccounts": ambiguous_count,
        "opening": opening_value,
        "closing": closing_value,
        // 认不出类别的科目不猜类别，但方向可靠时照常计入总额。
        "unclassified": unclassified,
        "unclassifiedAmount": unclassified_amount,
        "ambiguous": ambiguous,
    })
}

fn header_position(headers: &[String], name: &str) -> Option<usize> {
    headers.iter().position(|header| header == name)
}

/// 单列的锚点集合：保留行非空单元格的归一化值。用于多列辅助
/// （编码＋名称双列）时挑与 JE 认定列重叠最多的一列做键。
fn column_anchor_set(rows: &[Vec<String>], keep: &[bool], column: usize) -> HashSet<String> {
    let mut set = HashSet::new();
    for (index, row) in rows.iter().enumerate() {
        if !keep.get(index).copied().unwrap_or(true) {
            continue;
        }
        if let Some(value) = row.get(column) {
            let normalized = ledger_mapping::anchor_norm(value);
            if !normalized.is_empty() {
                set.insert(normalized);
            }
        }
    }
    set
}

/// TB 与 JE 发生额勾稽：TB 发生额（口径经 [`arbitrate_movement_basis`] 仲裁）
/// ↔ JE 按科目汇总的借贷合计。
/// 科目键之上叠一层辅助维度（公共锚点反查认定成功时），JE 辅助为空的
/// 分录归“未分维度”桶，不猜维度归属。
#[allow(clippy::too_many_arguments)]
fn check_tb_vs_je(
    tb: &FxTable,
    tb_map: &Map<String, Value>,
    tb_fixed: &str,
    je: &PreparedJe,
    je_map: &Map<String, Value>,
    je_fixed: &str,
    cancel: &AtomicBool,
    include_all_accounts: bool,
    functional_rows: &[bool],
    je_rows: &[bool],
    entity_scope: &ledger_mapping::EntityScope,
    auxiliary_plan_params: Option<&Value>,
) -> Result<Value, AppError> {
    let je_table = &*je.table;
    let tb_debit = columns(tb_map, "ytdFunctionalDebit");
    let tb_credit = columns(tb_map, "ytdFunctionalCredit");
    if tb_debit.is_empty() || tb_credit.is_empty() {
        return Ok(json!({
            "performed": false,
            "reason": "余额表没有映射借方与贷方发生额（本期或本年累计其一），无法与序时账比对。"
        }));
    }
    let tb_has_code = !columns(tb_map, "accountCode").is_empty();
    let je_has_code = !columns(je_map, "accountCode").is_empty();
    let tb_has_name = !columns(tb_map, "accountName").is_empty();
    let je_has_name = !columns(je_map, "accountName").is_empty();
    if (!tb_has_code || !je_has_code) && (!tb_has_name || !je_has_name) {
        return Ok(json!({
            "performed": false,
            "reason": "余额表或序时账未映射科目编码，且两侧没有完整的科目名称可供严格验证，无法按科目对齐。"
        }));
    }

    #[derive(Default, Clone, Copy)]
    struct Side {
        debit: f64,
        credit: f64,
    }
    // 键＝（主体，科目键，辅助维度）。辅助维度只在公共锚点反查认定成功时
    // 才有值，其余场景恒为空串——分组与旧口径完全一致。
    let mut tb_totals = BTreeMap::<(String, String, String), Side>::new();
    let mut names = BTreeMap::<(String, String, String), String>::new();
    let mut aux_display = BTreeMap::<String, String>::new();
    let mut tb_currencies = BTreeMap::<(String, String, String), BTreeSet<String>>::new();
    let mut tb_row_counts = BTreeMap::<(String, String, String), usize>::new();

    // TB 侧：只收末级行，汇总行的发生额是下级之和，收进来就翻倍。
    let leaf = ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| columns(tb_map, role));
    let tb_identities = tb
        .rows
        .iter()
        .enumerate()
        .filter(|(index, _)| functional_rows.get(*index).copied().unwrap_or(true))
        .filter(|(index, _)| leaf.get(*index).copied().unwrap_or(true))
        .map(|(_, row)| {
            scoped_identity_parts(
                tb,
                row,
                tb_map,
                tb_fixed,
                ledger_mapping::EntitySide::Tb,
                entity_scope,
            )
        })
        .filter(|(_, code, name)| !code.is_empty() || !name.is_empty())
        .collect::<Vec<_>>();
    let je_identities = if let Some(disk) = je.disk.as_ref() {
        let mut distinct = BTreeSet::new();
        disk.visit(false, cancel, |row| {
            let identity = scoped_identity_parts(
                je_table,
                &row.values,
                je_map,
                je_fixed,
                ledger_mapping::EntitySide::Je,
                entity_scope,
            );
            if !identity.1.is_empty() || !identity.2.is_empty() {
                distinct.insert(identity);
            }
            Ok(())
        })?;
        distinct.into_iter().collect::<Vec<_>>()
    } else {
        je_table
            .rows
            .iter()
            .enumerate()
            .filter(|(index, _)| je_rows.get(*index).copied().unwrap_or(true))
            .map(|(_, row)| {
                scoped_identity_parts(
                    je_table,
                    row,
                    je_map,
                    je_fixed,
                    ledger_mapping::EntitySide::Je,
                    entity_scope,
                )
            })
            .filter(|(_, code, name)| !code.is_empty() || !name.is_empty())
            .collect::<Vec<_>>()
    };
    let account_policy =
        ledger_mapping::AccountMatchPolicy::from_sides(&tb_identities, &je_identities);
    let unverified_name_keys = tb_identities
        .iter()
        .chain(&je_identities)
        .filter(|(_, code, _)| code.is_empty())
        .filter(|(entity, _, name)| !account_policy.is_validated_name(entity, name))
        .map(|(entity, _, name)| (entity.clone(), ledger_mapping::normalize_name(name)))
        .collect::<BTreeSet<_>>();
    if (!tb_has_code || !je_has_code)
        && (account_policy.name_fallback_count() == 0 || !unverified_name_keys.is_empty())
    {
        return Ok(json!({
            "performed": false,
            "reason": format!(
                "科目编码缺失，且同主体下有 {} 个科目名称未通过 TB/JE 双侧唯一对应验证，无法安全按科目名称回退匹配。",
                unverified_name_keys.len().max(1)
            )
        }));
    }

    // 辅助核算联动验证（公共锚点反查）：TB 映射了辅助列时认定 JE 的对应列，
    // 认定成功才把维度并入勾稽键；对不上按主体＋科目静默降级，附提示。
    let tb_aux_mapped = !ledger_mapping::mapped_column_names(tb_map, "auxiliary").is_empty();
    let je_preferred = ledger_mapping::mapped_column_names(je_map, "auxiliary");
    let mut je_unassigned_rows = 0usize;
    // 验证严格隔离到（有效主体，科目）。空编码的 SAP 辅助明细
    // 继承最近的同主体科目；只在当前核对行集中提锚点，不看报告期间。
    let mut tb_anchor_row_groups = vec![None; tb.rows.len()];
    let mut last_tb_account = BTreeMap::<String, (String, String)>::new();
    let anchor_groups = ledger_mapping::tb_auxiliary_anchor_groups(
        &tb.headers,
        &tb.rows,
        tb_map,
        "auxiliary",
        |index, row| {
            if !functional_rows.get(index).copied().unwrap_or(true) {
                return None;
            }
            let (entity, own_code, own_name) = scoped_identity_parts(
                tb,
                row,
                tb_map,
                tb_fixed,
                ledger_mapping::EntitySide::Tb,
                entity_scope,
            );
            if !own_code.is_empty() {
                last_tb_account.insert(entity.clone(), (own_code.clone(), own_name.clone()));
            }
            let (code, name) = if own_code.is_empty() {
                last_tb_account.get(&entity).cloned().unwrap_or_default()
            } else {
                (own_code, own_name)
            };
            let account = account_policy.account_key(&entity, &code, &name);
            if account.is_empty() {
                return None;
            }
            let group = (entity, account);
            tb_anchor_row_groups[index] = Some(group.clone());
            Some(group)
        },
    );
    let mut tb_scan_accumulator =
        ledger_mapping::GroupedAnchorColumnAccumulator::new(tb.headers.len());
    for (index, row) in tb.rows.iter().enumerate() {
        let Some(group) = tb_anchor_row_groups.get(index).and_then(Clone::clone) else {
            continue;
        };
        if let Some(anchors) = anchor_groups.get(&group) {
            tb_scan_accumulator.feed(group, row, anchors);
        }
    }
    let tb_group_scans = tb_scan_accumulator.finish(&tb.headers);
    let planned_columns = auxiliary_plan_params.and_then(|params| {
        fx::verified_auxiliary_columns_from_plan_headers(
            params,
            &tb.headers,
            &je_table.headers,
            &account_policy,
        )
    });
    let (group_verdicts, verified_groups) = if let Some(columns) = planned_columns {
        // 页面在映射阶段已完整扫过 JE；指纹、映射和科目消歧均
        // 通过上方复核后，直接沿用组级认定列，省掉一次整本 JE 扫描。
        let verdicts = auxiliary_plan_params
            .and_then(|params| params.get("auxiliaryPlan"))
            .and_then(|plan| plan.get("groups"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|group| {
                let entity = group.get("entity")?.as_str()?.to_owned();
                let account = group.get("account")?.as_str()?.to_owned();
                let column = group.get("jeColumn")?.as_str()?.to_owned();
                let anchor_total = group
                    .get("anchorTotal")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let anchor_hits = group
                    .get("anchorHits")
                    .and_then(Value::as_u64)
                    .unwrap_or(anchor_total as u64) as usize;
                Some(ledger_mapping::AuxiliaryLinkGroupVerdict {
                    entity,
                    account,
                    verdict: ledger_mapping::AuxiliaryLinkVerdict {
                        column: Some(column),
                        status: "verified",
                        anchor_total,
                        anchor_hits,
                        nonempty_rows: anchor_hits,
                        total_rows: anchor_hits,
                        competing_columns: Vec::new(),
                    },
                })
            })
            .collect::<Vec<_>>();
        (verdicts, columns)
    } else {
        let mut je_scan_accumulator =
            ledger_mapping::GroupedAnchorColumnAccumulator::new(je_table.headers.len());
        let mut je_group_totals = BTreeMap::<ledger_mapping::AuxiliaryGroupKey, usize>::new();
        let mut scan_je_row = |row: &[String]| {
            let group = scoped_matched_identity(
                je_table,
                row,
                je_map,
                je_fixed,
                ledger_mapping::EntitySide::Je,
                entity_scope,
                &account_policy,
            );
            let Some(anchors) = anchor_groups.get(&group) else {
                return;
            };
            *je_group_totals.entry(group.clone()).or_default() += 1;
            je_scan_accumulator.feed(group, row, anchors);
        };
        if let Some(disk) = je.disk.as_ref() {
            disk.visit(false, cancel, |row| {
                scan_je_row(&row.values);
                Ok(())
            })?;
        } else {
            for (index, row) in je_table.rows.iter().enumerate() {
                if je_rows.get(index).copied().unwrap_or(true) {
                    scan_je_row(row);
                }
            }
        }
        drop(scan_je_row);
        let je_group_scans = je_scan_accumulator.finish(&je_table.headers);
        let verdicts = ledger_mapping::auxiliary_link_group_verdicts_by_tb_columns(
            &anchor_groups,
            &tb_group_scans,
            &je_group_scans,
            &je_group_totals,
            tb_map,
            "auxiliary",
            &je_preferred,
        );
        let columns = ledger_mapping::auxiliary_verified_columns(
            &verdicts,
            &tb_group_scans,
            &je_group_scans,
            &tb.headers,
            &je_table.headers,
            tb_map,
            "auxiliary",
        );
        (verdicts, columns)
    };
    let aux_refined = !verified_groups.is_empty();
    let dimension_views = verified_groups
        .values()
        .map(|(tb_index, _)| *tb_index)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|tb_index| {
            (
                tb_index,
                ledger_mapping::tb_dimension_rows(
                    &tb.headers,
                    &tb.rows,
                    tb_map,
                    "auxiliary",
                    Some(tb_index),
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    fn remember_display(map: &mut BTreeMap<String, String>, raw: &str) -> String {
        let normalized = ledger_mapping::anchor_norm(raw);
        if normalized.is_empty() {
            return String::new();
        }
        let display = raw.trim();
        map.entry(normalized.clone())
            .or_insert_with(|| display.to_owned());
        normalized
    }
    let tb_records = fx::records(tb);
    for (tb_column, view) in &dimension_views {
        for dimension in view {
            let Some(row) = tb.rows.get(dimension.index) else {
                continue;
            };
            let entity = scoped_identity_parts(
                tb,
                row,
                tb_map,
                tb_fixed,
                ledger_mapping::EntitySide::Tb,
                entity_scope,
            )
            .0;
            let account = account_policy.account_key(&entity, &dimension.code, &dimension.name);
            if account.is_empty()
                || verified_groups
                    .get(&(entity.clone(), account.clone()))
                    .is_none_or(|(selected, _)| selected != tb_column)
                || !functional_rows
                    .get(dimension.index)
                    .copied()
                    .unwrap_or(true)
            {
                continue;
            }
            let Some(record) = tb_records.get(dimension.index) else {
                continue;
            };
            let (debit, credit) =
                fx::side_amounts(record, tb_map, "ytdFunctional").unwrap_or((0.0, 0.0));
            if !dimension.aux.is_empty() {
                aux_display
                    .entry(dimension.aux.clone())
                    .or_insert_with(|| dimension.aux_display.clone());
            }
            let key = (entity, account, dimension.aux.clone());
            let entry = tb_totals.entry(key.clone()).or_default();
            entry.debit += debit;
            entry.credit += credit;
            *tb_row_counts.entry(key.clone()).or_default() += 1;
            let currency = tb_row_currency(tb, row, tb_map);
            if !currency.is_empty() {
                tb_currencies
                    .entry(key.clone())
                    .or_default()
                    .insert(currency);
            }
            names.entry(key).or_insert_with(|| dimension.name.clone());
        }
    }
    {
        for (index, row) in tb.rows.iter().enumerate() {
            if !functional_rows.get(index).copied().unwrap_or(true) {
                continue;
            }
            if !leaf.get(index).copied().unwrap_or(true) {
                continue;
            }
            let key = scoped_matched_identity(
                tb,
                row,
                tb_map,
                tb_fixed,
                ledger_mapping::EntitySide::Tb,
                entity_scope,
                &account_policy,
            );
            if key.1.is_empty() {
                continue;
            }
            if verified_groups.contains_key(&key) {
                continue;
            }
            let Some(record) = tb_records.get(index) else {
                continue;
            };
            let (debit, credit) =
                fx::side_amounts(record, tb_map, "ytdFunctional").unwrap_or((0.0, 0.0));
            let key = (key.0, key.1, String::new());
            let entry = tb_totals.entry(key.clone()).or_default();
            entry.debit += debit;
            entry.credit += credit;
            *tb_row_counts.entry(key.clone()).or_default() += 1;
            let currency = tb_row_currency(tb, row, tb_map);
            if !currency.is_empty() {
                tb_currencies
                    .entry(key.clone())
                    .or_default()
                    .insert(currency);
            }
            names
                .entry(key)
                .or_insert_with(|| display_name(tb, row, tb_map));
        }
    }

    // JE 侧：剔掉合计行与游离数字行，其余按科目累加借贷。
    let mut je_totals = BTreeMap::<(String, String, String), Side>::new();
    if let Some(disk) = je.disk.as_ref() {
        disk.visit(false, cancel, |row| {
            let key = scoped_matched_identity(
                je_table,
                &row.values,
                je_map,
                je_fixed,
                ledger_mapping::EntitySide::Je,
                entity_scope,
                &account_policy,
            );
            if key.1.is_empty() {
                return Ok(());
            }
            let aux = match verified_groups
                .get(&key)
                .and_then(|(_, column)| row.values.get(*column))
            {
                Some(value) if !value.trim().is_empty() => {
                    remember_display(&mut aux_display, value)
                }
                Some(_) => {
                    je_unassigned_rows += 1;
                    String::new()
                }
                None => String::new(),
            };
            let key = (key.0, key.1, aux);
            let entry = je_totals.entry(key.clone()).or_default();
            // The common disk row has already normalized both evidence sides
            // with the final sign convention. A red entry therefore stays on
            // its original side and reduces that side's total.
            entry.debit += row.debit;
            entry.credit += row.credit;
            names
                .entry(key)
                .or_insert_with(|| display_name(je_table, &row.values, je_map));
            Ok(())
        })?;
    } else {
        let je_records = fx::records(je_table);
        for (index, row) in je_table.rows.iter().enumerate() {
            if index % 8192 == 0 && cancel.load(Ordering::Relaxed) {
                return Err(error("JOB_CANCELLED", "任务已取消。", None));
            }
            if !je_rows.get(index).copied().unwrap_or(true) {
                continue;
            }
            let key = scoped_matched_identity(
                je_table,
                row,
                je_map,
                je_fixed,
                ledger_mapping::EntitySide::Je,
                entity_scope,
                &account_policy,
            );
            if key.1.is_empty() {
                continue;
            }
            let aux = match verified_groups
                .get(&key)
                .and_then(|(_, column)| row.get(*column))
            {
                Some(value) if !value.trim().is_empty() => {
                    remember_display(&mut aux_display, value)
                }
                Some(_) => {
                    je_unassigned_rows += 1;
                    String::new()
                }
                None => String::new(),
            };
            let key = (key.0, key.1, aux);
            let Some(record) = je_records.get(index) else {
                continue;
            };
            let entry = je_totals.entry(key.clone()).or_default();
            // 借还是贷由列（或方向列）决定，正负留在本侧冲减——按净额符号归侧会把
            // 红字冲销翻到对面：贷方记 −467.02 折成 +467.02 进了借方，借贷两侧同时
            // 虚增（08 号样例实测差 467.02×2）。余额表的列合计就是这么按列直加的，
            // 两侧口径必须一致。
            let (debit, credit) =
                fx::side_amounts(record, je_map, "functional").unwrap_or((0.0, 0.0));
            entry.debit += debit;
            entry.credit += credit;
            names
                .entry(key)
                .or_insert_with(|| display_name(je_table, row, je_map));
        }
    }

    let mut items = Vec::new();
    let mut mismatched = 0usize;
    let mut net_mismatched = 0usize;
    let mut keys = tb_totals.keys().cloned().collect::<Vec<_>>();
    keys.extend(je_totals.keys().cloned());
    keys.sort();
    keys.dedup();
    let total_keys = keys.len();
    for key in keys {
        let tb_side = tb_totals.get(&key).copied();
        let je_side = je_totals.get(&key).copied();
        let t = tb_side.unwrap_or_default();
        let j = je_side.unwrap_or_default();
        let debit_diff = t.debit - j.debit;
        let credit_diff = t.credit - j.credit;
        let tb_net = t.debit - t.credit;
        let je_net = j.debit - j.credit;
        let net_diff = tb_net - je_net;
        let included_currencies = tb_currencies
            .get(&key)
            .map(|values| values.iter().cloned().collect::<Vec<_>>().join("、"))
            .unwrap_or_default();
        let included_rows = tb_row_counts.get(&key).copied().unwrap_or(0);
        let off =
            beyond(debit_diff, t.debit.max(j.debit)) || beyond(credit_diff, t.credit.max(j.credit));
        let net_off = beyond(net_diff, tb_net.abs().max(je_net.abs()));
        if off {
            mismatched += 1;
        }
        if net_off {
            net_mismatched += 1;
        }
        if (include_all_accounts || off) && (include_all_accounts || items.len() < 500) {
            items.push(json!({
                "entity": key.0,
                "code": ledger_mapping::account_code_from_match_key(&key.1),
                "name": names.get(&key).cloned().unwrap_or_default(),
                // 辅助维度（认定成功时才有值；空串＝未分维度桶）。
                "auxiliary": aux_display.get(&key.2).cloned().unwrap_or_default(),
                "presence": match (tb_side.is_some(), je_side.is_some()) {
                    (true, true) => "both",
                    (true, false) => "tbOnly",
                    (false, true) => "jeOnly",
                    _ => "none",
                },
                "tbDebit": t.debit, "jeDebit": j.debit, "debitDifference": debit_diff,
                "tbCredit": t.credit, "jeCredit": j.credit, "creditDifference": credit_diff,
                "tbIncludedCurrencies": included_currencies,
                "tbIncludedRows": included_rows,
                "tbNet": tb_net, "jeNet": je_net, "netDifference": net_diff,
                "netPassed": !net_off,
                "overallVerdict": if net_off {
                    "不通过"
                } else if off {
                    "净额通过，单边发生额有差异"
                } else {
                    "通过"
                },
            }));
        }
    }
    // 这里只能客观判断差异覆盖面，不能仅凭“80% 科目不一致”推断期间不匹配。
    // 期间结论必须有日期/会计期间字段的直接证据，避免掩盖映射或口径问题。
    let widespread = total_keys >= 5 && mismatched * 10 >= total_keys * 8;
    // 辅助核算联动验证的结论与提示：降级一律静默放行＋说明，不拦结果。
    let mut auxiliary_warnings = Vec::new();
    if tb_aux_mapped {
        if group_verdicts.is_empty() {
            auxiliary_warnings
                .push("已选范围内没有可验证的非零发生额辅助值，按主体＋科目勾稽。".to_owned());
        }
        for group in &group_verdicts {
            let aux_verdict = &group.verdict;
            let prefix = format!(
                "主体「{}」科目「{}」：",
                group.entity,
                group
                    .account
                    .split('\u{1f}')
                    .next()
                    .unwrap_or(&group.account)
            );
            let start = auxiliary_warnings.len();
            match aux_verdict.status {
            "noMatch" => auxiliary_warnings.push(
                "TB 已映射辅助核算，但 JE 无对应列，已按主体＋科目勾稽。".to_owned(),
            ),
            "ambiguous" => auxiliary_warnings.push(format!(
                "JE 中有多列包含辅助核算值（{}），无法唯一认定，已按主体＋科目勾稽；可在映射中手动指定其一。",
                aux_verdict.competing_columns.join("、")
            )),
            "noAnchors" => auxiliary_warnings.push(
                "TB 辅助核算列没有可验证的当期发生额行，按主体＋科目勾稽。".to_owned(),
            ),
            "partialCoverage" => auxiliary_warnings.push(format!(
                "JE 辅助列「{}」覆盖不全（{}/{} 个维度命中），整科目按主体＋科目勾稽。",
                aux_verdict.column.clone().unwrap_or_default(),
                aux_verdict.anchor_hits,
                aux_verdict.anchor_total
            )),
            _ => {}
        }
            for warning in &mut auxiliary_warnings[start..] {
                *warning = format!("{prefix}{warning}");
            }
        }
        if aux_refined && je_unassigned_rows > 0 {
            auxiliary_warnings.push(format!(
                "JE 有 {je_unassigned_rows} 行分录辅助列为空，已归入未分维度行与 TB 对平。"
            ));
        }
    }
    let auxiliary_match = tb_aux_mapped.then(|| {
        let group_json = group_verdicts.iter().map(|group| {
            let verdict = &group.verdict;
            json!({"entity": group.entity, "account": group.account,
                "status": verdict.status, "column": verdict.column,
                "anchorHits": verdict.anchor_hits, "anchorTotal": verdict.anchor_total,
                "competingColumns": verdict.competing_columns})
        }).collect::<Vec<_>>();
        let status = if group_verdicts.is_empty() { "noAnchors" }
            else if group_verdicts.iter().all(|group| group.verdict.dimension_keys()) { "verified" }
            else if group_verdicts.iter().all(|group| group.verdict.status == "noMatch") { "noMatch" }
            else if group_verdicts.iter().any(|group| group.verdict.status == "ambiguous") { "ambiguous" }
            else { "partialCoverage" };
        let anchor_hits = group_verdicts.iter().map(|group| group.verdict.anchor_hits).sum::<usize>();
        let anchor_total = group_verdicts.iter().map(|group| group.verdict.anchor_total).sum::<usize>();
        json!({
            "status": status,
            "column": group_verdicts.first().and_then(|group| group.verdict.column.clone()),
            "anchorHits": anchor_hits,
            "anchorTotal": anchor_total,
            "coverage": if anchor_total > 0 { anchor_hits as f64 / anchor_total as f64 } else { 0.0 },
            "competingColumns": group_verdicts.iter().flat_map(|group| group.verdict.competing_columns.clone()).collect::<BTreeSet<_>>(),
            "groups": group_json,
        })
    });
    Ok(json!({
        "performed": true,
        "passed": mismatched == 0,
        "sidePassed": mismatched == 0,
        "netPassed": net_mismatched == 0,
        "accounts": total_keys,
        "mismatched": mismatched,
        "netMismatched": net_mismatched,
        "widespread": widespread,
        "currencyScope": "allRows",
        "currencyScopeNote": "币种只用于判断列语义；TBJE 核对不按币种过滤行。",
        "accountMatchMode": if account_policy.name_fallback_count() > 0 {
            "validatedNameFallback"
        } else if account_policy.ambiguous_count() > 0 {
            "codeAndNameWhenAmbiguous"
        } else {
            "code"
        },
        "ambiguousAccountCodes": account_policy.ambiguous_count(),
        "validatedNameFallbackAccounts": account_policy.name_fallback_count(),
        // 只有各主体＋科目的 verified 组细分；其余组整体回退。
        "auxiliaryRefined": aux_refined,
        "auxiliaryMatch": auxiliary_match,
        "auxiliaryWarnings": auxiliary_warnings,
        "items": items,
    }))
}

#[cfg(test)]
#[path = "tbje_check_tests.rs"]
mod tests;
