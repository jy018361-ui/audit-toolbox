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

use rust_xlsxwriter::{Format, Workbook};
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
            let result = run(&params, &cancel)?;
            pause.wait()?;
            progress("write", 2, 3, "正在写出核对明细…");
            let path = export(&params, &result)?;
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

// ────────────────────────────── 三条核对 ──────────────────────────────

const TOLERANCE: f64 = 0.01;

/// 差异是否超出容差。账面金额都是两位小数，一分钱以内当尾差。
fn beyond(difference: f64, scale: f64) -> bool {
    difference.abs() > TOLERANCE.max(scale.abs() * 1e-8)
}

pub(crate) fn run(params: &Value, cancel: &AtomicBool) -> Result<Value, AppError> {
    let tb = load(params, "tbSource", "TB")?;
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

    let Some(tb) = tb else {
        return Err(error(
            "TBJE_CHECK_NO_TB",
            "请先上传科目余额表——三条核对都以它为准。",
            None,
        ));
    };

    // 符号口径判一次、写进映射，三条核对都从映射里读同一个结论。
    // 自己现算会与勾稽那条分叉——实测 04 号样例上勾稽用 Signed、恒等式现算成
    // Unsigned，负债被再乘一次 −1，合计差出两倍资产。
    fx::ensure_sign_convention(&tb, &mut tb_map, "tb");
    if let Some(je) = je.as_deref() {
        fx::ensure_sign_convention(je, &mut je_map, "je");
    }

    let rollforward = check_rollforward(&tb, &tb_map);
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let equation = check_equation(&tb, &tb_map, &tb_fixed);
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    let tb_vs_je = match je.as_deref() {
        Some(je) => check_tb_vs_je(&tb, &tb_map, &tb_fixed, je, &je_map, &je_fixed, cancel)?,
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

fn cell(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 把三条核对的差异明细写成一个工作簿，每条一张表。
///
/// 页面上只给结论和前几条；科目多的时候（实测有几百个科目对不上的）得靠这个
/// 工作簿逐条查，所以每张表都带上两侧的原始数字和差额，而不只是「不平」二字。
fn export(params: &Value, result: &Value) -> Result<PathBuf, AppError> {
    let path = output_path(params)?;
    let mut workbook = Workbook::new();
    let header = Format::new().set_bold().set_background_color(0xEFEFEF);
    let money = Format::new().set_num_format("#,##0.00");

    let mut write = |title: &str,
                     columns: &[&str],
                     rows: &[Vec<Value>],
                     numeric_from: usize|
     -> Result<(), AppError> {
        let sheet = workbook.add_worksheet();
        sheet.set_name(title).map_err(xlsx)?;
        for (index, name) in columns.iter().enumerate() {
            sheet
                .write_string_with_format(0, index as u16, *name, &header)
                .map_err(xlsx)?;
        }
        for (r, row) in rows.iter().enumerate() {
            for (c, value) in row.iter().enumerate() {
                let (r, c) = (r as u32 + 1, c as u16);
                match value.as_f64() {
                    Some(number) if c as usize >= numeric_from => sheet
                        .write_number_with_format(r, c, number, &money)
                        .map_err(xlsx)?,
                    _ => sheet.write_string(r, c, cell(value)).map_err(xlsx)?,
                };
            }
        }
        sheet.set_freeze_panes(1, 0).map_err(xlsx)?;
        Ok(())
    };

    // TB 发生额与余额勾稽不平的行
    let mut rows = Vec::new();
    for unit in result
        .pointer("/rollforward/units")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let label = unit["unit"].as_str().unwrap_or("").to_owned();
        for item in unit["items"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            rows.push(vec![
                json!(label),
                item["sourceRow"].clone(),
                item["account"].clone(),
                item["opening"].clone(),
                item["debit"].clone(),
                item["credit"].clone(),
                item["derived"].clone(),
                item["closing"].clone(),
                item["difference"].clone(),
            ]);
        }
    }
    write(
        "TB发生额与余额勾稽",
        &[
            "口径",
            "源表行号",
            "科目",
            "期初",
            "本年借方",
            "本年贷方",
            "期初+借-贷",
            "期末",
            "差额",
        ],
        &rows,
        3,
    )?;

    // TB 与 JE 发生额对不上的科目
    let rows = result
        .pointer("/tbVsJe/items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|item| {
            vec![
                item["entity"].clone(),
                item["code"].clone(),
                item["name"].clone(),
                json!(match item["presence"].as_str() {
                    Some("tbOnly") => "仅余额表有",
                    Some("jeOnly") => "仅序时账有",
                    _ => "两边都有",
                }),
                item["tbDebit"].clone(),
                item["jeDebit"].clone(),
                item["debitDifference"].clone(),
                item["tbCredit"].clone(),
                item["jeCredit"].clone(),
                item["creditDifference"].clone(),
            ]
        })
        .collect::<Vec<_>>();
    write(
        "TB与JE发生额勾稽",
        &[
            "主体",
            "科目编码",
            "科目名称",
            "出现在",
            "TB借方",
            "JE借方",
            "借方差额",
            "TB贷方",
            "JE贷方",
            "贷方差额",
        ],
        &rows,
        4,
    )?;

    // BS 与 PL 勾稽：两个时点各按要素类别列一遍，外加认不出类别的科目
    let mut rows = Vec::new();
    for (label, key) in [("年初", "opening"), ("年末", "closing")] {
        let Some(side) = result.pointer(&format!("/equation/{key}")) else {
            continue;
        };
        if side.is_null() {
            continue;
        }
        for item in side["byCategory"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            rows.push(vec![
                json!(label),
                item["category"].clone(),
                item["amount"].clone(),
            ]);
        }
        rows.push(vec![
            json!(label),
            json!("合计（应为 0）"),
            side["total"].clone(),
        ]);
    }
    write("BS与PL勾稽", &["时点", "会计要素", "金额"], &rows, 2)?;

    let rows = result
        .pointer("/equation/unclassified")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|item| {
            vec![
                item["sourceRow"].clone(),
                item["code"].clone(),
                item["name"].clone(),
                item["opening"].clone(),
                item["closing"].clone(),
            ]
        })
        .collect::<Vec<_>>();
    write(
        "BS与PL待分类",
        &["源表行号", "科目编码", "科目名称", "年初", "年末"],
        &rows,
        3,
    )?;

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
        if !off {
            continue;
        }
        mismatched += 1;
        if items.len() < 500 {
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
