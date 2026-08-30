//! TBJE 完整性核对：上传科目余额表与序时账之后，跑三条体检。
//!
//! 三条都**只提示不拦截**。实务里尾差、审计调整前后口径差异、序时账只覆盖部分
//! 期间都太常见，拦下来会挡住正常工作；这个工具的价值是把「映射反了、少传了
//! 一段期间、科目表不完整」这类问题在动手做底稿之前就摆到台面上。
//!
//! 1. **TB 发生额与余额勾稽**：期初 ＋ 本年累计借方 − 本年累计贷方 ＝ 期末，逐行验。
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

use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook, Worksheet};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    fx::{self, FxTable, SourceSpec, load_fx_table},
    ledger_mapping::{self, AccountCategory, SignConvention},
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
        "tbje_check.run" | "tbje_check.run_batch" | "tbje_check.export"
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
            let result = run(&params, &cancel)?;
            progress("done", 3, 3, "核对完成。");
            Ok(result)
        }
        "tbje_check.run_batch" => run_batch(&params, progress, &cancel, pause),
        "tbje_check.export" => {
            progress("read", 1, 3, "正在读取科目余额表与序时账…");
            pause.wait()?;
            let prepared = prepare(&params)?;
            let result = evaluate(&prepared, &cancel, true)?;
            pause.wait()?;
            progress("write", 2, 3, "正在写出核对明细…");
            let path = export(&params, &result, &prepared)?;
            progress("done", 3, 3, "明细已导出。");
            Ok(json!({ "outputPath": path.to_string_lossy(), "result": result }))
        }
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

fn number(table: &FxTable, row: &[String], map: &Map<String, Value>, role: &str) -> Option<f64> {
    ledger_mapping::parse_amount(&text(table, row, map, role))
        .ok()
        .flatten()
}

/// 科目身份：主体 ＋ 归一化编码。编码与名称混写在一格时先拆开。
fn identity(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    fixed: &str,
) -> (String, String) {
    let entity = text(table, row, map, "entity");
    let entity = if entity.is_empty() {
        fixed.to_owned()
    } else {
        entity
    };
    let raw = text(table, row, map, "accountCode");
    let code = ledger_mapping::account_code_of(&raw);
    (entity, ledger_mapping::normalize_account_code(&code))
}

fn display_name(table: &FxTable, row: &[String], map: &Map<String, Value>) -> String {
    let name = joined(table, row, map, "accountName");
    if name.is_empty() {
        ledger_mapping::account_name_of(&text(table, row, map, "accountCode"))
    } else {
        ledger_mapping::account_name_of(&name)
    }
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
    je: Option<Arc<FxTable>>,
    tb_map: Map<String, Value>,
    je_map: Map<String, Value>,
    tb_fixed: String,
    je_fixed: String,
}

fn prepare(params: &Value) -> Result<PreparedCheck, AppError> {
    let tb = load(params, "tbSource", "TB")?.ok_or_else(|| {
        error(
            "TBJE_CHECK_NO_TB",
            "请先上传科目余额表——三条核对都以它为准。",
            None,
        )
    })?;
    let je = load(params, "jeSource", "JE")?;
    let mut tb_map = mapping_of(params, "tbMapping");
    let mut je_map = mapping_of(params, "jeMapping");
    let tb_fixed = params
        .get("tbFixedEntity")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let je_fixed = params
        .get("jeFixedEntity")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();

    fx::ensure_sign_convention(&tb, &mut tb_map, "tb");
    if let Some(je) = je.as_deref() {
        fx::ensure_sign_convention(je, &mut je_map, "je");
    }
    Ok(PreparedCheck {
        tb,
        je,
        tb_map,
        je_map,
        tb_fixed,
        je_fixed,
    })
}

// ────────────────────────────── 三条核对 ──────────────────────────────

const TOLERANCE: f64 = 0.01;

/// 差异是否超出容差。账面金额都是两位小数，一分钱以内当尾差。
fn beyond(difference: f64, scale: f64) -> bool {
    difference.abs() > TOLERANCE.max(scale.abs() * 1e-8)
}

pub(crate) fn run(params: &Value, cancel: &AtomicBool) -> Result<Value, AppError> {
    let prepared = prepare(params)?;
    evaluate(&prepared, cancel, false)
}

fn evaluate(
    prepared: &PreparedCheck,
    cancel: &AtomicBool,
    include_all_accounts: bool,
) -> Result<Value, AppError> {
    // 符号口径在 `prepare` 中判一次并写进映射，三条核对与正式导出共用。
    let rollforward = check_rollforward(&prepared.tb, &prepared.tb_map);
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let equation = check_equation(&prepared.tb, &prepared.tb_map, &prepared.tb_fixed);
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let tb_vs_je = match prepared.je.as_deref() {
        Some(je) => check_tb_vs_je(
            &prepared.tb,
            &prepared.tb_map,
            &prepared.tb_fixed,
            je,
            &prepared.je_map,
            &prepared.je_fixed,
            cancel,
            include_all_accounts,
        )?,
        None => json!({
            "performed": false,
            "reason": "未上传序时账，跳过发生额核对。"
        }),
    };

    Ok(json!({
        "rollforward": rollforward,
        "tbVsJe": tb_vs_je,
        "equation": equation,
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
        match run(group, cancel) {
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

fn write_rollforward_sheet(
    workbook: &mut Workbook,
    prepared: &PreparedCheck,
) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("TB发生额与余额勾稽").map_err(xlsx)?;
    let headers = [
        "口径",
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
    write_intro(
        sheet,
        "TB 发生额与余额勾稽",
        "逐科目验证：期初余额＋借方发生额－贷方发生额＝期末余额。",
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
    for (opening, closing, debit_role, credit_role, unit) in [
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
            let (Ok(open), Ok(close), Some(debit), Some(credit)) = (
                fx::signed_amount(record, &prepared.tb_map, opening),
                fx::signed_amount(record, &prepared.tb_map, closing),
                number(&prepared.tb, row, &prepared.tb_map, debit_role),
                number(&prepared.tb, row, &prepared.tb_map, credit_role),
            ) else {
                continue;
            };
            if open == 0.0 && close == 0.0 && debit == 0.0 && credit == 0.0 {
                continue;
            }
            let (_, code) = identity(&prepared.tb, row, &prepared.tb_map, &prepared.tb_fixed);
            let name = display_name(&prepared.tb, row, &prepared.tb_map);
            let source_row = prepared.tb.header_row + prepared.tb.header_depth + index + 1;
            let excel_row = output_row + 1;
            let derived = open + debit - credit;
            let difference = derived - close;
            let verdict = if beyond(difference, open.abs().max(close.abs().max(derived.abs()))) {
                "差异"
            } else {
                "通过"
            };
            for (column, value) in [unit, "", &code, &name].iter().enumerate() {
                if column == 1 {
                    sheet
                        .write_number_with_format(
                            output_row,
                            1,
                            source_row as f64,
                            &input_text_format(),
                        )
                        .map_err(xlsx)?;
                } else {
                    sheet
                        .write_string_with_format(
                            output_row,
                            column as u16,
                            *value,
                            &input_text_format(),
                        )
                        .map_err(xlsx)?;
                }
            }
            for (column, value) in [(4, open), (5, debit), (6, credit), (8, close)] {
                sheet
                    .write_number_with_format(output_row, column, value, &input_money_format())
                    .map_err(xlsx)?;
            }
            sheet
                .write_formula_with_format(
                    output_row,
                    7,
                    Formula::new(format!("E{excel_row}+F{excel_row}-G{excel_row}"))
                        .set_result(derived.to_string()),
                    &formula_money_format(),
                )
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    output_row,
                    9,
                    Formula::new(format!("H{excel_row}-I{excel_row}"))
                        .set_result(difference.to_string()),
                    &formula_money_format(),
                )
                .map_err(xlsx)?;
            sheet
                .write_formula_with_format(
                    output_row,
                    10,
                    Formula::new(format!(
                        "IF(ABS(J{excel_row})<=MAX($B$3,MAX(ABS(E{excel_row}),ABS(H{excel_row}),ABS(I{excel_row}))*1E-8),\"通过\",\"差异\")"
                    ))
                    .set_result(verdict),
                    &formula_text_format(),
                )
                .map_err(xlsx)?;
            output_row += 1;
        }
    }
    finish_sheet(
        sheet,
        &[
            10.0, 12.0, 16.0, 28.0, 16.0, 17.0, 17.0, 16.0, 16.0, 15.0, 10.0,
        ],
        output_row.saturating_sub(1),
    )
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
        "TB借方",
        "JE借方",
        "借方差异",
        "TB贷方",
        "JE贷方（已统一方向）",
        "贷方差异",
        "结论",
    ];
    write_intro(
        sheet,
        "TB 与 JE 发生额勾稽",
        "借、贷两侧分别对比；JE 贷方统一为正常贷方为正、红字冲销为负。",
        prepared
            .je
            .as_ref()
            .map(|je| je.path.to_string_lossy().into_owned())
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
        for (column, value) in [
            item["entity"].as_str().unwrap_or(""),
            item["code"].as_str().unwrap_or(""),
            item["name"].as_str().unwrap_or(""),
            presence,
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
        for (column, value) in [(4, tb_debit), (5, je_debit), (7, tb_credit), (8, je_credit)] {
            sheet
                .write_number_with_format(output_row, column, value, &input_money_format())
                .map_err(xlsx)?;
        }
        let debit_difference = tb_debit - je_debit;
        let credit_difference = tb_credit - je_credit;
        let off = beyond(debit_difference, tb_debit.max(je_debit))
            || beyond(credit_difference, tb_credit.max(je_credit));
        sheet
            .write_formula_with_format(
                output_row,
                6,
                Formula::new(format!("E{excel_row}-F{excel_row}"))
                    .set_result(debit_difference.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                9,
                Formula::new(format!("H{excel_row}-I{excel_row}"))
                    .set_result(credit_difference.to_string()),
                &formula_money_format(),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                output_row,
                10,
                Formula::new(format!(
                    "IF(OR(ABS(G{excel_row})>MAX($B$3,MAX(ABS(E{excel_row}),ABS(F{excel_row}))*1E-8),ABS(J{excel_row})>MAX($B$3,MAX(ABS(H{excel_row}),ABS(I{excel_row}))*1E-8)),\"差异\",\"通过\")"
                ))
                .set_result(if off { "差异" } else { "通过" }),
                &formula_text_format(),
            )
            .map_err(xlsx)?;
    }
    finish_sheet(
        sheet,
        &[
            18.0, 16.0, 28.0, 15.0, 16.0, 16.0, 15.0, 16.0, 23.0, 15.0, 10.0,
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
    for (index, row) in prepared.tb.rows.iter().enumerate() {
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
        for (period, prefix) in [("年初", "openingFunctional"), ("年末", "closingFunctional")] {
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
                included: category.is_some(),
            });
        }
    }
    details
}

fn write_equation_sheet(workbook: &mut Workbook, prepared: &PreparedCheck) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name("BS与PL勾稽").map_err(xlsx)?;
    let summary_headers = [
        "时点",
        "会计要素",
        "归类金额",
        "平衡差异",
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
    let detail_header_row = EXPORT_DATA_ROW + 15;
    let detail_data_row = detail_header_row + 1;
    let detail_last_row = detail_data_row + details.len().saturating_sub(1) as u32;
    let categories = ["资产", "负债", "共同", "所有者权益", "成本", "损益"];
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
        let unclassified = details.iter().any(|item| !item.included);
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
                Formula::new(format!("C{excel_row}")).set_result(total.to_string()),
                &formula_money_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        sheet
            .write_formula_with_format(
                summary_row,
                4,
                Formula::new(format!(
                    "IF(ABS(D{excel_row})<=MAX($B$3,ABS(C{excel_row})*1E-8),\"通过\",\"差异\")"
                ))
                .set_result(if beyond(total, total) {
                    "差异"
                } else {
                    "通过"
                }),
                &formula_text_format()
                    .set_bold()
                    .set_background_color("#E7F2F1"),
            )
            .map_err(xlsx)?;
        let first_detail = detail_data_row + 1;
        let last_detail = detail_last_row.max(detail_data_row) + 1;
        sheet
            .write_formula_with_format(
                summary_row,
                5,
                Formula::new(format!(
                    "IF(COUNTIF($G${first_detail}:$G${last_detail},\"否\")=0,\"完整\",\"待确认\")"
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
                6,
                "金额平衡与分类完整性分开判断",
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
                if item.included {
                    "按科目编码首位识别"
                } else {
                    "编码无法自动归入会计要素"
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
    let units = fx::tb_self_rollforward(tb, map);
    if units.is_empty() {
        return json!({
            "performed": false,
            "reason": "余额表缺少期初、期末或本年累计借贷发生额，无法勾稽。"
        });
    }
    let rows = units
        .iter()
        .map(|unit| {
            json!({
                "unit": unit.unit,
                "checked": unit.checked,
                "mismatched": unit.issues.len(),
                "items": unit
                    .issues
                    .iter()
                    .map(|issue| json!({
                        "sourceRow": issue.source_row,
                        "account": issue.account,
                        "opening": issue.opening,
                        "debit": issue.debit,
                        "credit": issue.credit,
                        "closing": issue.closing,
                        "derived": issue.opening + issue.debit - issue.credit,
                        "difference": issue.difference,
                    }))
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
fn check_equation(tb: &FxTable, map: &Map<String, Value>, fixed: &str) -> Value {
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
    let mut counted = 0usize;
    for (index, row) in tb.rows.iter().enumerate() {
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
        let open = fx::signed_amount(record, map, "openingFunctional").unwrap_or(0.0);
        let close = fx::signed_amount(record, map, "closingFunctional").unwrap_or(0.0);
        match ledger_mapping::account_category(&code) {
            Some(category) => {
                counted += 1;
                *opening.entry(category).or_default() += open;
                *closing.entry(category).or_default() += close;
            }
            None => {
                unclassified_amount += close.abs().max(open.abs());
                if unclassified.len() < 50 {
                    unclassified.push(json!({
                        "sourceRow": tb.header_row + index + 2,
                        "code": code,
                        "name": display_name(tb, row, map),
                        "opening": open,
                        "closing": close,
                    }));
                }
            }
        }
    }
    if counted == 0 {
        return json!({
            "performed": false,
            "reason": "没有一个科目的编码能判出会计要素类别（编码首位应为 1～6），本条跳过。",
            "unclassified": unclassified,
        });
    }
    let summarize = |totals: &BTreeMap<AccountCategory, f64>, enabled: bool| {
        if !enabled {
            return Value::Null;
        }
        let total: f64 = totals.values().sum();
        json!({
            "byCategory": totals
                .iter()
                .map(|(category, amount)| json!({
                    "category": category.label(),
                    "amount": amount,
                }))
                .collect::<Vec<_>>(),
            "total": total,
            "balanced": !beyond(total, total),
        })
    };
    let opening_value = summarize(&opening, has_opening);
    let closing_value = summarize(&closing, has_closing);
    let balanced = [&opening_value, &closing_value].iter().all(|value| {
        value
            .get("balanced")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    json!({
        "performed": true,
        "passed": balanced && unclassified.is_empty(),
        // 金额是否平衡与科目是否完整归类是两个结论。前端分开呈现，避免
        // “合计 0.00”旁边仍只写“有差异”，让人误以为金额判定自相矛盾。
        "balancePassed": balanced,
        "classificationComplete": unclassified.is_empty(),
        // 余额是「借正贷负已带符号」还是「借贷都记正数」，结论完全相反，
        // 把判定结果一并回给用户——算错时这是第一个要看的东西。
        "signConvention": match fx::sign_convention(map) {
            SignConvention::Signed => "signed",
            SignConvention::Unsigned => "unsigned",
        },
        "accounts": counted,
        "opening": opening_value,
        "closing": closing_value,
        // 认不出类别的科目单独列出来，不并进任何一类——宁可说「有科目没算进去」，
        // 也不能猜一个类别把等式凑平。
        "unclassified": unclassified,
        "unclassifiedAmount": unclassified_amount,
    })
}

/// TB 与 JE 发生额勾稽：TB 本年累计发生额 ↔ JE 按科目汇总的借贷合计。
#[allow(clippy::too_many_arguments)]
fn check_tb_vs_je(
    tb: &FxTable,
    tb_map: &Map<String, Value>,
    tb_fixed: &str,
    je: &FxTable,
    je_map: &Map<String, Value>,
    je_fixed: &str,
    cancel: &AtomicBool,
    include_all_accounts: bool,
) -> Result<Value, AppError> {
    let tb_debit = columns(tb_map, "ytdFunctionalDebit");
    let tb_credit = columns(tb_map, "ytdFunctionalCredit");
    if tb_debit.is_empty() || tb_credit.is_empty() {
        return Ok(json!({
            "performed": false,
            "reason": "余额表没有映射本年累计借方与贷方发生额，无法与序时账比对。"
        }));
    }
    if columns(tb_map, "accountCode").is_empty() || columns(je_map, "accountCode").is_empty() {
        return Ok(json!({
            "performed": false,
            "reason": "余额表或序时账未映射科目编码，两侧无法按科目对齐。"
        }));
    }

    #[derive(Default, Clone, Copy)]
    struct Side {
        debit: f64,
        credit: f64,
    }
    let mut tb_totals = BTreeMap::<(String, String), Side>::new();
    let mut names = BTreeMap::<(String, String), String>::new();

    // TB 侧：只收末级行，汇总行的发生额是下级之和，收进来就翻倍。
    let leaf = ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| columns(tb_map, role));
    for (index, row) in tb.rows.iter().enumerate() {
        if !leaf.get(index).copied().unwrap_or(true) {
            continue;
        }
        let key = identity(tb, row, tb_map, tb_fixed);
        if key.1.is_empty() {
            continue;
        }
        let entry = tb_totals.entry(key.clone()).or_default();
        entry.debit += number(tb, row, tb_map, "ytdFunctionalDebit").unwrap_or(0.0);
        entry.credit += number(tb, row, tb_map, "ytdFunctionalCredit").unwrap_or(0.0);
        names
            .entry(key)
            .or_insert_with(|| display_name(tb, row, tb_map));
    }

    // JE 侧：剔掉合计行与游离数字行，其余按科目累加借贷。
    let junk =
        ledger_mapping::ledger_junk_mask(&je.headers, &je.rows, &|role| columns(je_map, role));
    let je_records = fx::records(je);
    let mut je_totals = BTreeMap::<(String, String), Side>::new();
    for (index, row) in je.rows.iter().enumerate() {
        if index % 8192 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        if !junk.get(index).copied().unwrap_or(true) {
            continue;
        }
        let key = identity(je, row, je_map, je_fixed);
        if key.1.is_empty() {
            continue;
        }
        let Some(record) = je_records.get(index) else {
            continue;
        };
        let entry = je_totals.entry(key.clone()).or_default();
        // 借还是贷由列（或方向列）决定，正负留在本侧冲减——按净额符号归侧会把
        // 红字冲销翻到对面：贷方记 −467.02 折成 +467.02 进了借方，借贷两侧同时
        // 虚增（08 号样例实测差 467.02×2）。余额表的列合计就是这么按列直加的，
        // 两侧口径必须一致。
        let (debit, credit) = fx::side_amounts(record, je_map, "functional").unwrap_or((0.0, 0.0));
        entry.debit += debit;
        entry.credit += credit;
        names
            .entry(key)
            .or_insert_with(|| display_name(je, row, je_map));
    }

    let mut items = Vec::new();
    let mut mismatched = 0usize;
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
        let off =
            beyond(debit_diff, t.debit.max(j.debit)) || beyond(credit_diff, t.credit.max(j.credit));
        if off {
            mismatched += 1;
        }
        if (include_all_accounts || off) && (include_all_accounts || items.len() < 500) {
            items.push(json!({
                "entity": key.0,
                "code": key.1,
                "name": names.get(&key).cloned().unwrap_or_default(),
                "presence": match (tb_side.is_some(), je_side.is_some()) {
                    (true, true) => "both",
                    (true, false) => "tbOnly",
                    (false, true) => "jeOnly",
                    _ => "none",
                },
                "tbDebit": t.debit, "jeDebit": j.debit, "debitDifference": debit_diff,
                "tbCredit": t.credit, "jeCredit": j.credit, "creditDifference": credit_diff,
            }));
        }
    }
    // 绝大多数科目都对不上，多半不是数据错，而是序时账只覆盖了一部分期间
    // （实测样例里就有把一年拆成两个文件导出的）。这种整体性差异要和
    // 「个别科目对不上」分开说，否则用户会以为账全错了。
    let systematic = total_keys >= 5 && mismatched * 10 >= total_keys * 8;
    Ok(json!({
        "performed": true,
        "passed": mismatched == 0,
        "accounts": total_keys,
        "mismatched": mismatched,
        "systematic": systematic,
        "items": items,
    }))
}

#[cfg(test)]
#[path = "tbje_check_tests.rs"]
mod tests;
