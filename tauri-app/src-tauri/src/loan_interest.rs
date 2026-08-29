use crate::ledger_mapping;
use crate::lpr;
use crate::{AppError, excel_merger::PauseCheckpoint};
use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Local, NaiveDate};
use regex::Regex;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceSpec {
    input_path: String,
    #[serde(default)]
    sheet: String,
    #[serde(default)]
    header_row: usize,
    #[serde(default = "one")]
    header_depth: usize,
}
fn one() -> usize {
    1
}
#[derive(Clone)]
struct Table {
    path: PathBuf,
    sheet: String,
    sheets: Vec<String>,
    header_row: usize,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoanRow {
    loan_id: String,
    opening_principal: f64,
    additions: f64,
    reductions: f64,
    closing_principal: f64,
    rate_type: String,
    fixed_rate: Option<f64>,
    benchmark_rate: Option<f64>,
    spread_bps: Option<f64>,
    effective_rate: f64,
    calculated_interest: f64,
    /// Σ(计息本金 × 天数)。利息 = 本项 × 有效年利率 ÷ 365——分段计息里利率是常数，
    /// 所以这个乘积可以先加总。底稿把它写成一列，利息那一列就能写成活公式：
    /// 用户在「LPR报价表」改一个格子，基准利率、有效利率、利息一路重算。
    principal_days: f64,
    /// 定价基准日：浮动利率查 LPR 用的日期，也是底稿里公式引用的那一格。
    rate_basis_date: Option<String>,
    /// 采用的 LPR 品种（`1年期` / `5年期以上`）。非 LPR 定价为空。
    lpr_term: String,
    match_status: String,
    match_basis: String,
    #[serde(skip)]
    events: Vec<(NaiveDate, f64)>,
    // —— 合同台账模式（每笔借款：本金、利率、起止日）内部字段 ——
    #[serde(skip)]
    contract_start: Option<NaiveDate>,
    #[serde(skip)]
    contract_end: Option<NaiveDate>,
    #[serde(skip)]
    repaid: f64,
    #[serde(skip)]
    repayment_method: String,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "loan.inspect" => inspect(&params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到借款利息业务方法。",
            Some(method.into()),
        )),
    }
}
pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    checkpoint(&cancel, pause)?;
    progress("calculate", 1, 3, "正在读取借款数据并还原本金变动…");
    let mut rows = calculate(&params)?;
    checkpoint(&cancel, pause)?;
    progress("calculate", 2, 3, "正在按有效利率测算利息…");
    apply_overrides(&mut rows, &params);
    calculate_interest(&mut rows, &params)?;
    let mut output_paths = vec![];
    if method == "loan.export" {
        progress("export", 3, 3, "正在生成借款利息审计底稿…");
        let path = export(&rows, &params)?;
        output_paths.push(path.to_string_lossy().to_string())
    } else if method != "loan.preview" {
        return Err(error(
            "METHOD_NOT_FOUND",
            "未找到借款利息任务方法。",
            Some(method.into()),
        ));
    }
    let total: f64 = rows.iter().map(|r| r.calculated_interest).sum();
    let review = rows.iter().filter(|r| r.match_status != "已匹配").count();
    Ok(
        json!({"rows":rows,"summary":{"loanCount":rows.len(),"calculatedInterest":total,"reviewCount":review},"outputPaths":output_paths}),
    )
}
fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()
}
fn inspect(params: &Value) -> Result<Value, AppError> {
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("ledger");
    let spec: SourceSpec =
        serde_json::from_value(params.get("source").cloned().unwrap_or(Value::Null))
            .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load(&spec, kind)?;
    let suggested = suggest_with_rows(&table.headers, kind, &table.rows);
    // 台账要在预览区逐行确认利率口径，只给 8 行的话第 9 行往后就没法设置了。
    // 台账普遍几十行，整表下发；上限 2000 行防止误选超大表把界面拖垮。
    let preview_rows = if kind == "ledger" || kind == "rateLedger" {
        2000
    } else {
        8
    };
    let mut out = json!({"headers":table.headers,"preview":table.rows.iter().take(preview_rows).collect::<Vec<_>>(),"rowCount":table.rows.len(),"sheet":table.sheet,"sheets":table.sheets,"headerRow":table.header_row,"headerDepth":1,"suggestedMapping":suggested});
    // 台账的角色表与形态表随识别结果一起下发：前端据此渲染下拉、判定命中哪一型、
    // 区分 required／optional。**只有 Rust 这一份定义**，前端不再自己抄一遍。
    if kind == "ledger" || kind == "rateLedger" {
        if let Some(object) = out.as_object_mut() {
            object.insert("roles".into(), loan_role_catalog());
            object.insert("forms".into(), loan_form_catalog());
        }
    }
    Ok(out)
}

/// 台账角色表 → 前端下拉用的 `[{name,label}]`，顺序即下拉顺序。
fn loan_role_catalog() -> Value {
    Value::Array(
        ledger_mapping::loan_roles()
            .iter()
            .map(|r| json!({"name": r.name, "label": r.label}))
            .collect(),
    )
}

/// 台账四型 → 前端判型用的槽位定义。字段名与 [`ledger_mapping::Form`] 一一对应。
fn loan_form_catalog() -> Value {
    Value::Array(
        ledger_mapping::loan_forms()
            .iter()
            .map(|f| {
                json!({
                    "id": f.id,
                    "display": f.display,
                    "label": f.label,
                    "anyOf": f.any_of,
                    "required": f.required,
                    "optional": f.optional,
                })
            })
            .collect(),
    )
}

fn calculate(params: &Value) -> Result<Vec<LoanRow>, AppError> {
    if params.get("mode").and_then(Value::as_str) == Some("tb") {
        calculate_tb(params)
    } else {
        calculate_ledger(params)
    }
}
/// 台账映射命中哪一型（[`ledger_mapping::loan_forms`]）。未完整命中返回 `None`。
fn loan_form(mapping: &Map<String, Value>) -> Option<String> {
    let filled: Vec<&str> = mapping
        .iter()
        .filter(|(_, v)| match v {
            Value::String(one) => !one.trim().is_empty(),
            Value::Array(all) => all
                .iter()
                .any(|x| x.as_str().is_some_and(|v| !v.trim().is_empty())),
            _ => false,
        })
        .map(|(k, _)| k.as_str())
        .collect();
    let mapped: std::collections::HashSet<&str> = filled.into_iter().collect();
    match ledger_mapping::resolve_form("loan", &mapped) {
        ledger_mapping::FormVerdict::Matched(m) => Some(m.form.to_string()),
        ledger_mapping::FormVerdict::Incomplete(_) => None,
    }
}

/// 用户在台账预览区逐行确认的利率口径。下标 = 台账数据行序（与预览行一一对应）。
///
/// 台账普遍没有「利率类型」列，利率列里混着 `3.85`、`0.0365`、`浮动`、`LPR+90BP`
/// 好几种写法。默认值由前端按同一条规则算出来摆在预览里，用户看得见也改得动；
/// 改完整份回传，引擎不再自己猜——**猜错的代价是整笔利息算错，且没人看得出来**。
#[derive(Clone, Debug, Default)]
struct RateOverride {
    /// `fixed` 或 `floating`。
    rate_type: String,
    /// 上浮为正、下浮为负，单位 BP（1BP = 0.01%）。仅浮动利率有意义。
    spread_bps: Option<f64>,
}

fn rate_overrides(params: &Value) -> Vec<Option<RateOverride>> {
    params
        .get("ledgerRateOverrides")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .map(|item| {
                    if !item.is_object() {
                        return None;
                    }
                    let kind = item.get("rateType").and_then(Value::as_str).unwrap_or("");
                    Some(RateOverride {
                        rate_type: kind.into(),
                        spread_bps: item.get("spreadBps").and_then(Value::as_f64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 把某一行的利率口径覆盖应用到已解析出的 (固定利率, 基准利率, 加点)。
///
/// 浮动的基准只取台账独立的基准利率列。数值执行利率按已确认口径默认固定；
/// 只有用户明确改为浮动才清空执行利率，并改走独立基准或 LPR 回退。
/// 两处都取不到数值时返回 `None` 基准——由 [`calculate_interest`] 标为待复核，
/// 不能默默按 0 出数。
fn apply_rate_override(
    over: Option<&RateOverride>,
    rate_type: String,
    fixed: Option<f64>,
    benchmark: Option<f64>,
    bps: Option<f64>,
) -> (String, Option<f64>, Option<f64>, Option<f64>) {
    let Some(over) = over else {
        return (rate_type, fixed, benchmark, bps);
    };
    if over.rate_type.is_empty() || over.rate_type == rate_type {
        return (rate_type, fixed, benchmark, over.spread_bps.or(bps));
    }
    if over.rate_type == "floating" {
        // 用户明确从固定改为浮动时，原数值是已执行利率，不能当成
        // 基准利率再加一遍 BP。只保留台账独立的基准利率列；缺失时由
        // LPR 补全逻辑按报告期和期限取基准，取不到则待复核。
        ("floating".into(), None, benchmark, over.spread_bps.or(bps))
    } else {
        ("fixed".into(), fixed.or(benchmark), None, None)
    }
}

fn calculate_ledger(params: &Value) -> Result<Vec<LoanRow>, AppError> {
    let (table, mapping) = source(params, "ledgerSource")?;
    // 命中 A／B 型走合同模式（一笔借款一行：起算额、利率、起始日、到期日或期限）；
    // 命中 C／D 型走期初/新增/归还/期末的变动表模式。
    let contract_mode = matches!(loan_form(&mapping).as_deref(), Some("A") | Some("B"));
    // 逐行利率口径下标 = 台账数据行序，与预览行一一对应；分段台账要加上段起点。
    let overrides = rate_overrides(params);
    let mut out = vec![];
    if contract_mode {
        // 同一 Sheet 可能拼接多套台账（各段表头、单位、口径不同）：
        // 探测主表头之后的表头特征行，逐段用各自表头重新映射；多段时金额统一折算为元。
        let segs = detect_segments(&table);
        let multi = segs.len() > 1;
        for (n, seg) in segs.into_iter().enumerate() {
            let seg_headers = match seg.header {
                None => table.headers.clone(),
                Some(hi) => padded_headers(&table.rows[hi], table.headers.len()),
            };
            let seg_rows = table.rows[seg.start..seg.end].to_vec();
            let seg_mapping = if n == 0 {
                mapping.clone()
            } else {
                suggest(&seg_headers, "ledger")
            };
            if !seg_mapping.contains_key("principal") {
                continue; // 识别不出金额列的段（纯备注/标题段）不生成借款记录
            }
            // 单段台账保持原币原单位输出（用户自行按单位口径使用）；多段才折算，避免口径混算
            let unit = if multi {
                unit_factor(
                    seg_mapping
                        .get("principal")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )
            } else {
                1.0
            };
            let seg_table = Table {
                path: table.path.clone(),
                sheet: table.sheet.clone(),
                sheets: table.sheets.clone(),
                header_row: table.header_row,
                headers: seg_headers,
                rows: seg_rows,
            };
            contract_rows(
                &seg_table,
                &seg_mapping,
                unit,
                n + 1,
                multi,
                seg.start,
                &overrides,
                &mut out,
            );
        }
        if out.is_empty() {
            return Err(error("NO_LOANS", "未从借款台账识别到可测算的借款。", None));
        }
        return Ok(out);
    }
    let mut out = vec![];
    for (idx, row) in table.rows.iter().enumerate() {
        let id = text(&table, row, &mapping, "loanId");
        if id.is_empty() {
            continue;
        }
        let opening = num(&table, row, &mapping, "openingPrincipal");
        let additions = num(&table, row, &mapping, "drawdownAmount");
        let reductions = num(&table, row, &mapping, "repaymentAmount");
        let closing = num(&table, row, &mapping, "closingPrincipal");
        let (fixed, benchmark, bps) = rates(&table, row, &mapping);
        let (rate_type, fixed, benchmark, bps) = apply_rate_override(
            overrides.get(idx).and_then(Option::as_ref),
            source_rate_type(&table, row, &mapping),
            fixed,
            benchmark,
            bps,
        );
        let mut events = vec![];
        if let Some(value) = row_date(&table, row, &mapping, "drawdownDate") {
            events.push((value, additions));
        }
        if let Some(value) = row_date(&table, row, &mapping, "repaymentDate") {
            events.push((value, -reductions));
        }
        out.push(LoanRow {
            loan_id: id,
            opening_principal: opening,
            additions,
            reductions,
            closing_principal: closing,
            rate_type,
            fixed_rate: fixed,
            benchmark_rate: benchmark,
            spread_bps: bps,
            effective_rate: 0.0,
            calculated_interest: 0.0,
            principal_days: 0.0,
            rate_basis_date: None,
            lpr_term: String::new(),
            match_status: if (opening + additions - reductions - closing).abs() < 0.01 {
                "已匹配".into()
            } else {
                "待复核".into()
            },
            match_basis: "客户借款台账".into(),
            events,
            contract_start: None,
            contract_end: None,
            repaid: 0.0,
            repayment_method: String::new(),
        })
    }
    if out.is_empty() {
        return Err(error("NO_LOANS", "未从借款台账识别到可测算的借款。", None));
    }
    Ok(out)
}
/// 合同模式逐行解析一段台账：本金、利率、起止日/期限。
/// unit 为该段金额折算为元的系数（单段台账恒为 1，保持原单位输出）。
fn contract_rows(
    table: &Table,
    mapping: &Map<String, Value>,
    unit: f64,
    seg_no: usize,
    multi: bool,
    // row_offset：本段首行在整张表里的行序，逐行利率口径按整表行序对齐。
    row_offset: usize,
    overrides: &[Option<RateOverride>],
    out: &mut Vec<LoanRow>,
) {
    let has_id = mapping.contains_key("loanId");
    let has_lender = mapping.contains_key("lender");
    for (idx, row_orig) in table.rows.iter().enumerate() {
        // 整行右移纠偏：首格为空且右邻格像合同编号（字母+数字的短文本）时，整行左移一格读数
        let shifted;
        let row: &[String] = if has_id
            && row_orig.first().is_some_and(|v| v.trim().is_empty())
            && row_orig.get(1).is_some_and(|v| looks_like_id(v))
        {
            let mut r = row_orig[1..].to_vec();
            r.push(String::new());
            shifted = r;
            &shifted
        } else {
            row_orig
        };
        // 编号列存在但该行为空（无编号借据等）：回退用“贷款方#行号”生成标识，避免整行被跳过
        let id = {
            let raw = if has_id {
                text(table, row, mapping, "loanId")
            } else {
                String::new()
            };
            if !raw.is_empty() {
                raw
            } else {
                let lender = if has_lender {
                    text(table, row, mapping, "lender")
                } else {
                    String::new()
                };
                format!(
                    "{}#{}",
                    if lender.is_empty() { "借款" } else { &lender },
                    idx + 1
                )
            }
        };
        let principal = num(table, row, mapping, "principal");
        let (fixed, benchmark, bps) = rates(table, row, mapping);
        // 合同模式的 rate 角色即执行利率（数值列，6.5=6.5%），优先级低于显式 fixedRate 映射。
        // 用户在预览区逐行确认的利率口径，优先于台账列里的写法。
        let (rate_type_final, fixed, benchmark, bps) = apply_rate_override(
            overrides.get(row_offset + idx).and_then(Option::as_ref),
            source_rate_type(table, row, mapping),
            fixed,
            benchmark,
            bps,
        );
        let start = row_date(table, row, mapping, "startDate");
        let end = row_date(table, row, mapping, "endDate").or_else(|| {
            let term = parse_term_months(&text(table, row, mapping, "term"));
            term.zip(start)
                .and_then(|(m, s)| s.checked_add_months(chrono::Months::new(m)))
                .map(|d| d.pred_opt().unwrap_or(d))
        });
        let outstanding = num(table, row, mapping, "closingPrincipal");
        let repaid = num(table, row, mapping, "repaymentAmount");
        if principal == 0.0 {
            continue; // 金额为空的行（小计/备注行）不生成借款记录
        }
        // 期初余额列（变动表）优先作为年初占用本金；无该列时用合同本金
        let opening = {
            let op = num(table, row, mapping, "openingPrincipal");
            if op > 0.0 { op } else { principal }
        };
        let basis = if multi && unit != 1.0 {
            format!(
                "借款合同台账（合同模式，第{seg_no}段，金额单位{}，已折算为元）",
                if unit == 10000.0 { "万元" } else { "千元" }
            )
        } else if multi {
            format!("借款合同台账（合同模式，第{seg_no}段）")
        } else {
            "借款合同台账（合同模式）".to_string()
        };
        out.push(LoanRow {
            loan_id: id,
            opening_principal: opening * unit,
            additions: 0.0,
            reductions: repaid * unit,
            closing_principal: outstanding * unit,
            rate_type: rate_type_final,
            fixed_rate: fixed,
            benchmark_rate: benchmark,
            spread_bps: bps,
            effective_rate: 0.0,
            calculated_interest: 0.0,
            principal_days: 0.0,
            rate_basis_date: None,
            lpr_term: String::new(),
            match_status: "已匹配".into(),
            match_basis: basis,
            events: vec![],
            contract_start: start,
            contract_end: end,
            repaid: repaid * unit,
            repayment_method: text(table, row, mapping, "repaymentMethod"),
        });
    }
}
/// 像“合同编号”的文本：短（≤24字符）且同时含英文字母与数字（日期/金额/机构名都不满足）。
fn looks_like_id(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty()
        && t.chars().count() <= 24
        && t.chars().any(|c| c.is_ascii_alphabetic())
        && t.chars().any(|c| c.is_ascii_digit())
}
fn calculate_tb(params: &Value) -> Result<Vec<LoanRow>, AppError> {
    let (tb, tm) = source(params, "tbSource")?;
    let (je, jm) = source(params, "jeSource")?;
    let rate_source = optional_source(params, "rateLedgerSource")?;
    // 贷方列写的是绝对值还是已带负号，全表判一次，不逐行猜。
    let tb_convention = tb_sign_convention(&tb, &tm);
    let je_convention = je_sign_convention(&je, &jm);
    let tb_leaf =
        ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| mapped_names(&tm, "tb", role));
    let mut out = vec![];
    for (row_index, row) in tb.rows.iter().enumerate() {
        if !tb_leaf[row_index] {
            continue;
        }
        let account = account_text(&tb, row, &tm, "tb");
        let id = text(&tb, row, &tm, "loanId");
        if id.is_empty() || account.is_empty() {
            continue;
        }
        // 借款是负债类科目，贷方为正。六种 TB 形态的差异由内核吸收。
        let opening = ledger_mapping::credit_positive(ledger_mapping::signed_amount(
            &amount_inputs(&tb, row, &tm, "opening"),
            tb_convention,
        ));
        let closing = ledger_mapping::credit_positive(ledger_mapping::signed_amount(
            &amount_inputs(&tb, row, &tm, "closing"),
            tb_convention,
        ));
        let mut additions = 0.0;
        let mut reductions = 0.0;
        let mut matched = 0usize;
        let mut events = vec![];
        for jr in &je.rows {
            let ja = account_text(&je, jr, &jm, "je");
            let ji = text(&je, jr, &jm, "loanId");
            let summary = text(&je, jr, &jm, "summary");
            let hit = norm(&ja) == norm(&account)
                && (ji.is_empty() || norm(&ji) == norm(&id) || norm(&summary).contains(&norm(&id)));
            if !hit {
                continue;
            }
            matched += 1;
            let net = ledger_mapping::signed_amount(&je_amount_inputs(&je, jr, &jm), je_convention);
            if net > 0.0 {
                reductions += net;
            } else if net < 0.0 {
                additions += -net;
            }
            if net != 0.0 {
                if let Some(value) = row_date(&je, jr, &jm, "date") {
                    // 借款本金台账以贷方增加为正，正好是公共“借正贷负”净额的反号。
                    events.push((value, -net));
                }
            }
        }
        if matched == 0 {
            let net =
                ledger_mapping::signed_amount(&amount_inputs(&tb, row, &tm, "ytd"), tb_convention);
            if net > 0.0 {
                reductions = net;
            } else if net < 0.0 {
                additions = -net;
            }
        }
        let mut rate_type = "fixed".into();
        let (mut fixed, mut benchmark, mut bps) = (None, None, None);
        if let Some((rt, rm)) = &rate_source {
            if let Some(rr) = rt
                .rows
                .iter()
                .find(|rr| norm(&text(rt, rr, rm, "loanId")) == norm(&id))
            {
                rate_type = source_rate_type(rt, rr, rm);
                (fixed, benchmark, bps) = rates(rt, rr, rm)
            }
        }
        let diff = opening + additions - reductions - closing;
        out.push(LoanRow {
            loan_id: id,
            opening_principal: opening,
            additions,
            reductions,
            closing_principal: closing,
            rate_type,
            fixed_rate: fixed,
            benchmark_rate: benchmark,
            spread_bps: bps,
            effective_rate: 0.0,
            calculated_interest: 0.0,
            principal_days: 0.0,
            rate_basis_date: None,
            lpr_term: String::new(),
            match_status: if matched > 0 && diff.abs() < 0.01 {
                "已匹配".into()
            } else {
                "待复核".into()
            },
            match_basis: if matched > 0 {
                format!("科目＋明细/摘要模糊匹配 {} 条 JE", matched)
            } else {
                "未匹配 JE，采用 TB 发生额".into()
            },
            events,
            contract_start: None,
            contract_end: None,
            repaid: 0.0,
            repayment_method: String::new(),
        })
    }
    if out.is_empty() {
        return Err(error("NO_LOANS", "未从 TB 识别到借款明细。", None));
    }
    Ok(out)
}
fn apply_overrides(rows: &mut [LoanRow], params: &Value) {
    let Some(all) = params.get("rateOverrides").and_then(Value::as_object) else {
        return;
    };
    for row in rows {
        let Some(v) = all.get(&row.loan_id) else {
            continue;
        };
        if let Some(t) = v.get("rateType").and_then(Value::as_str) {
            let next = rate_type_fn(t);
            if next != row.rate_type {
                if next == "floating" {
                    // 执行利率属于固定口径。用户切换为浮动后必须重新走
                    // “基准＋加减点”，不得沿用或把执行利率当成基准。
                    row.fixed_rate = None;
                } else {
                    row.benchmark_rate = None;
                    row.spread_bps = None;
                }
            }
            row.rate_type = next;
        }
        if let Some(x) = v.get("fixedRate").and_then(Value::as_f64) {
            row.fixed_rate = Some(normalize_rate(x))
        }
        if let Some(x) = v.get("benchmarkRate").and_then(Value::as_f64) {
            row.benchmark_rate = Some(normalize_rate(x))
        }
        if let Some(x) = v.get("spreadBps").and_then(Value::as_f64) {
            row.spread_bps = Some(x)
        }
    }
}
fn calculate_interest(rows: &mut [LoanRow], params: &Value) -> Result<(), AppError> {
    let start = date(params, "reportStart")?;
    let end = date(params, "reportEnd")?;
    if end < start {
        return Err(error(
            "INVALID_PERIOD",
            "测算期间结束日不能早于开始日。",
            None,
        ));
    }
    let days = (end - start).num_days() + 1;
    for row in rows {
        // 浮动利率：基准利率已列示时按“基准+点数”推算；
        // 台账直接给执行利率数值的（未列基准）按该执行利率测算，不得算成 0。
        row.effective_rate = if row.rate_type == "floating" && row.benchmark_rate.is_some() {
            row.benchmark_rate.unwrap() + row.spread_bps.unwrap_or(0.0) / 10000.0
        } else {
            row.fixed_rate.unwrap_or(
                row.benchmark_rate.unwrap_or(0.0) + row.spread_bps.unwrap_or(0.0) / 10000.0,
            )
        };
        // 标了浮动却拿不到基准（台账利率列写的是「浮动」两个字、又没有基准利率列）：
        // 回落到内置 LPR 报价表。
        //
        // 定价基准日取 **max(起息日, 报告期初)**：报告期前发放的按报告期初适用的报价，
        // 报告期内发放的按起息日的报价。这是简化——真实重定价日各家合同不同——
        // 所以底稿把这个日期单独列一列、基准利率写成引用它的公式，用户改日期就重算。
        if row.rate_type == "floating" && row.benchmark_rate.is_none() && row.fixed_rate.is_none() {
            let basis = row.contract_start.map(|s| s.max(start)).unwrap_or(start);
            let term = lpr::Term::of_loan(row.contract_start, row.contract_end);
            match lpr::lookup(basis, term) {
                Some(hit) => {
                    row.match_status = "待复核".into();
                    row.benchmark_rate = Some(hit.rate);
                    row.effective_rate = hit.rate + row.spread_bps.unwrap_or(0.0) / 10000.0;
                    row.rate_basis_date = Some(basis.to_string());
                    row.lpr_term = term.label().into();
                    row.match_basis.push_str(&format!(
                        "；浮动利率按内置{}LPR（{}起执行{:.2}%）加{}BP测算",
                        term.label(),
                        hit.effective,
                        hit.rate * 100.0,
                        row.spread_bps.unwrap_or(0.0),
                    ));
                    row.match_basis.push_str("；未提供合同重定价日和期限品种，按借款期限及期初/起息日估算，请核对合同后确认");
                    if hit.stale {
                        row.match_status = "待复核".into();
                        row.match_basis.push_str(&format!(
                            "；内置报价表数据截至{}，该笔的定价基准日在此之后，请在底稿「LPR报价表」补录最新报价后复核",
                            lpr::through()
                        ));
                    }
                }
                None => {
                    row.match_status = "待复核".into();
                    row.match_basis.push_str(
                        "；已标为浮动利率，但定价基准日早于 2019-08-20（LPR 改革之前）无内置报价，请手工补基准利率",
                    );
                }
            }
        }
        if row.fixed_rate.is_none() && row.benchmark_rate.is_none() {
            row.match_status = "待复核".into();
            row.match_basis
                .push_str("；缺少可用利率数值，请补充执行利率或基准利率；当前利息不可作为审计结论");
        }
        // —— 合同台账模式：与审计测算口径一致 ——
        // 计息本金与分段：
        //  a) 年内新放款：本金自放款日起算至 min(到期日, 年末)
        //  b) 有期末/未偿余额（closing>0）：
        //     - 年内到期且有部分还款：还款视同发生在到期日——期初占用计至到期日、
        //       期末余额自到期日续算至年末（逾期挂账按合同利率）
        //     - 其余（未到期/无还款）：期末余额恒定计至年末
        //  c) 无余额信息（或余额为0）：
        //     - 年内到期：视同到期结清，本金=期初/合同金额计至到期日
        //     - 存续：本金=合同金额-累计已还（已还视同期初前发生）
        // 天数：算头不算尾——止于年中到期日当天不计息，止于报告期末当天计息（全年365天）。
        if let Some(cs) = row.contract_start {
            let ce = row.contract_end.unwrap_or(end);
            let settled = row.contract_end.map(|c| c <= end).unwrap_or(false);
            let from = cs.max(start);
            // (本金, 起日含, 止日, 是否止于报告期末[期末当天计息])
            let mut segs: Vec<(f64, chrono::NaiveDate, chrono::NaiveDate, bool)> = vec![];
            let mid = start
                .checked_add_months(chrono::Months::new(6))
                .and_then(|d| d.pred_opt())
                .unwrap_or(end); // 报告期中点（如 2025-06-30），分期还本的默认归还时点
            if row.repayment_method.contains("分期")
                && row.repaid > 0.0
                && row.closing_principal > 0.0
                && row.closing_principal < row.opening_principal
            {
                // 台账注明“分期还本”但无逐期还款日期：视同归还集中于期中发生——
                // 期初占用计至期中，期末余额自期中次日计至报告期末
                segs.push((row.opening_principal, from, mid, false));
                let mid_next = mid.succ_opt().unwrap_or(mid);
                let seg2_from = if from > mid_next { from } else { mid_next };
                segs.push((row.closing_principal, seg2_from, end, true));
            } else if row.closing_principal > 0.0 {
                if settled && row.closing_principal < row.opening_principal {
                    segs.push((row.opening_principal, from, ce, false));
                    segs.push((row.closing_principal, ce, end, true));
                } else {
                    segs.push((row.closing_principal, from, end, true));
                }
            } else if settled {
                // 年内到期（含年内放款年内到期）：视同到期结清，全额计至到期日
                segs.push((row.opening_principal, from, ce, ce == end));
            } else if cs > start {
                // 年内新放款且存续：本金=放款额-已还，自放款日起算至年末
                segs.push((
                    (row.opening_principal - row.repaid).max(0.0),
                    from,
                    end,
                    true,
                ));
            } else {
                segs.push((
                    (row.opening_principal - row.repaid).max(0.0),
                    from,
                    end,
                    true,
                ));
            }
            let mut interest = 0.0;
            let mut days_total = 0i64;
            let mut principal_days = 0.0;
            for (p, f, t, year_end) in segs {
                let to_ex = if year_end {
                    t.succ_opt().unwrap_or(t)
                } else {
                    t
                };
                let d = (to_ex - f).num_days().max(0);
                interest += p * row.effective_rate * d as f64 / 365.0;
                principal_days += p * d as f64;
                days_total += d;
            }
            row.calculated_interest = interest;
            row.principal_days = principal_days;
            row.match_basis
                .push_str(&format!("；按合同期间计息{days_total}天/365"));
            // 存续但期末余额低于期初/合同额（年内归还、时点未列示）：提示结合备注复核
            if !settled
                && row.closing_principal > 0.0
                && row.closing_principal < row.opening_principal
            {
                row.match_basis
                    .push_str("；年内有归还且时点未列示，按期末余额恒定测算，建议结合备注复核");
            }
            continue;
        }
        if row.events.is_empty() {
            let average = (row.opening_principal + row.closing_principal) / 2.0;
            row.calculated_interest = average * row.effective_rate * days as f64 / 365.0;
            row.principal_days = average * days as f64;
            row.match_basis.push_str("；无逐笔日期，按平均本金粗算");
        } else {
            row.events.sort_by_key(|event| event.0);
            let mut principal = row.opening_principal;
            let mut cursor = start;
            let mut principal_days = 0.0;
            for (event_date, change) in &row.events {
                if *event_date < start {
                    principal += change;
                    continue;
                }
                if *event_date > end {
                    break;
                }
                principal_days += principal * (*event_date - cursor).num_days() as f64;
                principal += change;
                cursor = *event_date;
            }
            principal_days += principal * ((end - cursor).num_days() + 1) as f64;
            row.calculated_interest = principal_days * row.effective_rate / 365.0;
            row.principal_days = principal_days;
            row.match_basis.push_str("；按记账日逐日加权计息");
        }
    }
    Ok(())
}

fn export(rows: &[LoanRow], params: &Value) -> Result<PathBuf, AppError> {
    let path = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|x| !x.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let base = params
                .get("ledgerSource")
                .or_else(|| params.get("tbSource"))
                .and_then(|x| x.get("source"))
                .and_then(|x| x.get("inputPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .and_then(|x| x.parent().map(Path::to_path_buf))
                .unwrap_or_else(std::env::temp_dir);
            base.join(format!(
                "借款利息测算_{}.xlsx",
                Local::now().format("%Y%m%d_%H%M%S")
            ))
        });
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("借款变动与利息测算").map_err(xlsx)?;
    let header = Format::new()
        .set_bold()
        .set_align(FormatAlign::Center)
        .set_border(FormatBorder::Thin)
        .set_background_color("#D9EAD3");
    let date_fmt = Format::new().set_num_format("yyyy-mm-dd");
    let percent = Format::new().set_num_format("0.0000%");
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    // 列序与下面的公式一一对应，改这里必须同步改 `LPR_SHEET` 那几条公式。
    // A借款标识 B期初 C增加 D减少 E期末 F差异 G利率类型 H固定利率 I定价基准日
    // J LPR品种 K基准利率 L加减点 M有效年利率 N计息本金天数 O测算利息 P状态 Q依据
    let headers = [
        "借款标识",
        "期初本金",
        "本期增加",
        "本期减少",
        "期末本金",
        "勾稽差异",
        "利率类型",
        "固定/执行利率",
        "定价基准日",
        "LPR品种",
        "基准利率",
        "加/减点BP",
        "有效年利率",
        "计息本金天数",
        "测算利息",
        "匹配状态",
        "匹配依据",
    ];
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, &header)
            .map_err(xlsx)?;
    }
    for (r, row) in rows.iter().enumerate() {
        let y = (r + 1) as u32;
        let excel_row = y + 1; // Excel 行号从 1 起，且第 1 行是表头
        ws.write_string(y, 0, &row.loan_id).map_err(xlsx)?;
        for (c, n) in [
            row.opening_principal,
            row.additions,
            row.reductions,
            row.closing_principal,
        ]
        .iter()
        .enumerate()
        {
            ws.write_number_with_format(y, (c + 1) as u16, *n, &amount)
                .map_err(xlsx)?;
        }
        // 勾稽差异写成公式：复核时常直接在底稿上改期初/增加/减少/期末，
        // 差异是死数的话改完还显示平，等于把勾稽这道关废掉。
        ws.write_formula_with_format(
            y,
            5,
            Formula::new(format!(
                "=B{excel_row}+C{excel_row}-D{excel_row}-E{excel_row}"
            ))
            .set_result(
                (row.opening_principal + row.additions - row.reductions - row.closing_principal)
                    .to_string(),
            ),
            &amount,
        )
        .map_err(xlsx)?;
        let floating = row.rate_type == "floating";
        ws.write_string(y, 6, if floating { "浮动" } else { "固定" })
            .map_err(xlsx)?;
        if let Some(rate) = row.fixed_rate {
            ws.write_number_with_format(y, 7, rate, &percent)
                .map_err(xlsx)?;
        } else {
            ws.write_blank(y, 7, &percent).map_err(xlsx)?;
        }
        // 定价基准日：只有走内置 LPR 的行才有。它是基准利率公式引用的那一格——
        // 改日期就换一期报价，这是给用户的第一个可调旋钮。
        match (&row.rate_basis_date, row.lpr_term.as_str()) {
            (Some(date), term) if !term.is_empty() => {
                if let Ok(parsed) = NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                    ws.write_date_with_format(y, 8, &parsed, &date_fmt)
                        .map_err(xlsx)?;
                } else {
                    ws.write_string(y, 8, date.as_str()).map_err(xlsx)?;
                }
                ws.write_string(y, 9, term).map_err(xlsx)?;
                // 基准利率 = 在 LPR 报价表里取「不晚于定价基准日的最近一次调整」。
                // MATCH 的第三参数 1 要求查找列升序——报价表就是按日期升序写的。
                ws.write_formula_with_format(
                    y,
                    10,
                    Formula::new(format!(
                        "=INDEX('{sheet}'!$B${first}:$C${last},MATCH(I{excel_row},'{sheet}'!$A${first}:$A${last},1),{col})/100",
                        sheet = LPR_SHEET,
                        first = LPR_FIRST_DATA_ROW,
                        last = LPR_FIRST_DATA_ROW + lpr::quotes().len() - 1,
                        // INDEX 区间是 B:C 两列——1 年期在第 1 列、5 年期以上在第 2 列。
                        col = if term == lpr::Term::OverFiveYear.label() { 2 } else { 1 },
                    )).set_result(row.benchmark_rate.unwrap_or(0.0).to_string()),
                    &percent,
                )
                .map_err(xlsx)?;
            }
            _ => {
                ws.write_blank(y, 8, &date_fmt).map_err(xlsx)?;
                ws.write_string(y, 9, "").map_err(xlsx)?;
                if let Some(rate) = row.benchmark_rate {
                    ws.write_number_with_format(y, 10, rate, &percent)
                        .map_err(xlsx)?;
                } else {
                    ws.write_blank(y, 10, &percent).map_err(xlsx)?;
                }
            }
        }
        ws.write_number(y, 11, row.spread_bps.unwrap_or(0.0))
            .map_err(xlsx)?;
        // 有效年利率与测算利息都写成公式：改了基准利率或加点，两者跟着重算。
        // 利息 = Σ(本金×天数) × 年利率 ÷ 365——分段计息里利率是常数，可以先加总本金天数。
        ws.write_formula_with_format(
            y,
            12,
            Formula::new(format!("=IF(AND(G{excel_row}=\"浮动\",ISNUMBER(K{excel_row})),K{excel_row}+L{excel_row}/10000,IF(ISNUMBER(H{excel_row}),H{excel_row},K{excel_row}+L{excel_row}/10000))"))
                .set_result(row.effective_rate.to_string()),
            &percent,
        )
        .map_err(xlsx)?;
        // 计息本金天数只能是数值：分段计息里每段的本金和天数都不同
        // （年内到期分两段、分期还本按期中切一刀），Σ(本金ᵢ×天数ᵢ) 落不成单格公式。
        // 但利率是常数，所以利息那一列仍可由它算出来。
        ws.write_number(y, 13, row.principal_days).map_err(xlsx)?;
        ws.write_formula_with_format(
            y,
            14,
            Formula::new(format!("=N{excel_row}*M{excel_row}/365"))
                .set_result(row.calculated_interest.to_string()),
            &amount,
        )
        .map_err(xlsx)?;
        ws.write_string(y, 15, &row.match_status).map_err(xlsx)?;
        ws.write_string(y, 16, &row.match_basis).map_err(xlsx)?;
    }
    // 合计行。审计底稿的合计如果是死数，明细一改就对不上——这里一律 SUM。
    // 利率类的列（固定利率、基准利率、加减点、有效年利率）不合计，加总没有意义。
    if !rows.is_empty() {
        let y = (rows.len() + 1) as u32;
        let first = 2; // 第一行数据的 Excel 行号
        let last = rows.len() + 1;
        let total = Format::new()
            .set_bold()
            .set_border_top(FormatBorder::Thin)
            .set_num_format("#,##0.00;[Red](#,##0.00);-");
        ws.write_string_with_format(y, 0, "合计", &Format::new().set_bold())
            .map_err(xlsx)?;
        for col in [1u16, 2, 3, 4, 5, 13, 14] {
            let letter = char::from(b'A' + col as u8);
            let cached: f64 = rows
                .iter()
                .map(|row| match col {
                    1 => row.opening_principal,
                    2 => row.additions,
                    3 => row.reductions,
                    4 => row.closing_principal,
                    5 => {
                        row.opening_principal + row.additions
                            - row.reductions
                            - row.closing_principal
                    }
                    13 => row.principal_days,
                    14 => row.calculated_interest,
                    _ => 0.0,
                })
                .sum();
            ws.write_formula_with_format(
                y,
                col,
                Formula::new(format!("=SUM({letter}{first}:{letter}{last})"))
                    .set_result(cached.to_string()),
                &total,
            )
            .map_err(xlsx)?;
        }
    }
    ws.autofit();
    write_lpr_sheet(&mut wb, &header, &date_fmt)?;
    wb.save(&path).map_err(xlsx)?;
    Ok(path)
}

/// 底稿里 LPR 报价表那张 Sheet 的名字。主表的公式按名字引用它。
const LPR_SHEET: &str = "LPR报价表";
/// 报价数据从第几行开始（前面是标题与来源说明）。公式的 INDEX/MATCH 区间据此算。
const LPR_FIRST_DATA_ROW: usize = 5;

/// 写「LPR报价表」Sheet。
///
/// 这张表是**给用户改的**：主表的基准利率、有效年利率、测算利息三列都引用它，
/// 改一个格子整份底稿重算。所以表头必须把两件事说清楚——
/// 数据来源、以及本表只列**利率调整生效日**（LPR 每月报价，未调整的月份不重复列）。
fn write_lpr_sheet(wb: &mut Workbook, header: &Format, date_fmt: &Format) -> Result<(), AppError> {
    let ws = wb.add_worksheet();
    ws.set_name(LPR_SHEET).map_err(xlsx)?;
    let title = Format::new().set_bold();
    let warn = Format::new().set_font_color("#9C0006");
    ws.write_string_with_format(0, 0, "贷款市场报价利率（LPR）", &title)
        .map_err(xlsx)?;
    ws.write_string_with_format(
        1,
        0,
        format!(
            "数据截至 {}。本表只列利率发生调整的日期；LPR 每月 20 日报价，未调整的月份沿用上一次报价。",
            lpr::through()
        )
        .as_str(),
        &warn,
    )
    .map_err(xlsx)?;
    ws.write_string_with_format(
        2,
        0,
        format!("来源：全国银行间同业拆借中心；2026-08-28 核验。历史月表：{}；最新公告：{}。正式出具前请核对合同重定价约定；补录报价时在数据区内按日期升序插入整行并核对公式引用范围。", lpr::HISTORY_SOURCE, lpr::LATEST_SOURCE).as_str(),
        &warn,
    )
    .map_err(xlsx)?;
    for (c, h) in ["利率调整生效日", "1年期LPR(%)", "5年期以上LPR(%)"]
        .iter()
        .enumerate()
    {
        ws.write_string_with_format(3, c as u16, *h, header)
            .map_err(xlsx)?;
    }
    for (i, q) in lpr::quotes().iter().enumerate() {
        let y = (LPR_FIRST_DATA_ROW - 1 + i) as u32;
        ws.write_date_with_format(y, 0, &q.date(), date_fmt)
            .map_err(xlsx)?;
        ws.write_number(y, 1, q.one_year).map_err(xlsx)?;
        ws.write_number(y, 2, q.over_five_year).map_err(xlsx)?;
    }
    ws.autofit();
    Ok(())
}

fn source(params: &Value, key: &str) -> Result<(Table, Map<String, Value>), AppError> {
    let v = params
        .get(key)
        .ok_or_else(|| error("MISSING_SOURCE", format!("缺少 {} 数据源。", key), None))?;
    let spec: SourceSpec = serde_json::from_value(v.get("source").cloned().unwrap_or(Value::Null))
        .map_err(|e| error("INVALID_PARAMS", "数据源参数不完整。", Some(e.to_string())))?;
    let mapping = v
        .get("mapping")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    // key 形如 tbSource／jeSource／ledgerSource，前缀即表的种类。
    let kind = key.trim_end_matches("Source");
    // 台账的取值一律按标准角色名读（[`text`] 直接查键，不做迁移），
    // 所以历史保存的旧名要在这里先翻译一遍。
    let mapping = if kind == "ledger" || kind == "rateLedger" {
        normalize_loan_mapping(mapping)
    } else {
        mapping
    };
    Ok((load(&spec, kind)?, mapping))
}
/// 台账映射的旧角色名 → 标准名。认不出的旧名原样保留（用户手工填的自定义键不该被吞掉）。
fn normalize_loan_mapping(m: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in m {
        let std = ledger_mapping::migrate_role_name("loan", &key);
        let name = if std.is_empty() { key } else { std.to_string() };
        out.entry(name).or_insert(value);
    }
    out
}

fn optional_source(
    params: &Value,
    key: &str,
) -> Result<Option<(Table, Map<String, Value>)>, AppError> {
    if params.get(key).is_none_or(Value::is_null) {
        Ok(None)
    } else {
        source(params, key).map(Some)
    }
}
/// 读表分两条路，**按表的种类分流**。
///
/// TB 与 JE 是账表，走五个工具共用的那套读取——它的 Sheet 选择、双语表头合并、
/// 大文件抽样、内存缓存都更全。借款台账与利率台账**不是账表**：共用那套的标题行
/// 探测内置了账表的语义先验（按科目、金额、日期这类词打分），拿它扫台账会把
/// 数据行当成表头。实测「08 星衡科技集团-票据及短期融资登记簿」就被判到第 9 行，
/// 整张表识别不出一笔借款。台账因此保留本模块自己的探测规则。
fn load(spec: &SourceSpec, kind: &str) -> Result<Table, AppError> {
    if matches!(kind, "tb" | "je") {
        let table = crate::fx::load_fx_table(&crate::fx::SourceSpec {
            input_path: spec.input_path.clone(),
            sheet: spec.sheet.clone(),
            header_row: spec.header_row,
            header_depth: spec.header_depth,
        })?;
        return Ok(Table {
            path: table.path.clone(),
            sheet: table.sheet.clone(),
            sheets: table.sheets.clone(),
            header_row: table.header_row,
            headers: table.headers.clone(),
            rows: table.rows.clone(),
        });
    }
    load_ledger_table(spec)
}

/// 台账专用读取：标题行按本模块的 [`detect_header`] 规则找，单行表头。
fn load_ledger_table(spec: &SourceSpec) -> Result<Table, AppError> {
    let path = PathBuf::from(&spec.input_path);
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(spec.input_path.clone()),
        ));
    }
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    let (sheet, sheets, all) = if matches!(ext.as_str(), "csv" | "txt" | "tsv") {
        ("CSV".into(), vec!["CSV".into()], read_text(&path)?)
    } else {
        let mut book = open_workbook_auto(&path).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作簿。",
                Some(e.to_string()),
            )
        })?;
        let sheets = book.sheet_names().to_vec();
        let selected = if !spec.sheet.is_empty() && sheets.contains(&spec.sheet) {
            spec.sheet.clone()
        } else {
            sheets
                .first()
                .cloned()
                .ok_or_else(|| error("SOURCE_EMPTY", "工作簿没有 Sheet。", None))?
        };
        let range = book.worksheet_range(&selected).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取 Sheet。",
                Some(e.to_string()),
            )
        })?;
        (
            selected,
            sheets,
            range
                .rows()
                .map(|r| r.iter().map(data_text).collect())
                .collect(),
        )
    };
    let header_row = if spec.header_row > 0 {
        spec.header_row
    } else {
        detect_header(&all)
    };
    if header_row == 0 || header_row > all.len() {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let mut headers = (0..width)
        .map(|i| all[header_row - 1].get(i).cloned().unwrap_or_default())
        .collect::<Vec<_>>();
    for (i, h) in headers.iter_mut().enumerate() {
        if h.trim().is_empty() {
            *h = format!("未命名列{}", i + 1)
        }
    }
    let rows = all
        .into_iter()
        .skip(header_row + spec.header_depth.saturating_sub(1))
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .map(|mut r| {
            r.resize(width, String::new());
            r
        })
        .collect();
    Ok(Table {
        path,
        sheet,
        sheets,
        header_row,
        headers,
        rows,
    })
}

fn read_text(path: &Path) -> Result<Vec<Vec<String>>, AppError> {
    let bytes = fs::read(path).map_err(|e| {
        error(
            "SOURCE_READ_FAILED",
            "无法读取文本文件。",
            Some(e.to_string()),
        )
    })?;
    let text = String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| encoding_rs::GBK.decode(&bytes).0.into_owned());
    let first = text.lines().find(|x| !x.trim().is_empty()).unwrap_or("");
    let delim = if first.matches('\t').count() > first.matches(',').count() {
        b'\t'
    } else {
        b','
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delim)
        .flexible(true)
        .from_reader(text.as_bytes());
    reader
        .records()
        .map(|r| {
            r.map(|x| x.iter().map(str::to_string).collect())
                .map_err(|e| error("CSV_READ_FAILED", "无法解析文本表格。", Some(e.to_string())))
        })
        .collect()
}
fn detect_header(rows: &[Vec<String>]) -> usize {
    // 表头行特征：多数单元格是含关键词的短文本（数据行的日期/金额/长机构名不满足）。
    let score = |r: &Vec<String>| r.iter().filter(|v| header_cell_hit(v)).count();
    rows.iter()
        .take(30)
        .enumerate()
        .max_by_key(|(i, r)| (score(r), std::cmp::Reverse(*i)))
        .map(|(i, _)| i + 1)
        .unwrap_or(1)
}
/// 单元格是否像表头列名：非空、短文本（≤12字符）、含台账关键词。
fn header_cell_hit(v: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "金额", "本金", "利率", "利息", "日", "编号", "银行", "机构", "币种", "余额", "到期",
        "期限", "状态", "担保", "抵押", "用途", "类型", "方式", "债权", "贷款", "借款", "序号",
        "归还", "已还", "月供", "基准", "贴现", "承兑", "主体", "经办", "备注", "起", "止",
        "lender", "amount", "rate", "date", "maturity", "currency", "term", "security", "ref",
    ];
    let s = v.trim().to_lowercase();
    !s.is_empty() && s.chars().count() <= 12 && KEYWORDS.iter().any(|k| s.contains(k))
}
/// 台账的一段：header=None 表示沿用主表头（table.headers），否则为该段表头在 table.rows 中的下标。
struct Seg {
    header: Option<usize>,
    start: usize,
    end: usize,
}
/// 多段台账探测：主表头之后再次出现“表头特征行”（同一 Sheet 拼接多套台账）即切段。
/// 特征行 = 过半非空单元格是含关键词的短文本，且按该行重新映射能找到金额列（排除备注/标题误判）。
fn detect_segments(table: &Table) -> Vec<Seg> {
    let mut segs = vec![Seg {
        header: None,
        start: 0,
        end: table.rows.len(),
    }];
    for i in 1..table.rows.len() {
        let row = &table.rows[i];
        let non_empty = row.iter().filter(|v| !v.trim().is_empty()).count();
        let hits = row.iter().filter(|v| header_cell_hit(v)).count();
        if hits >= 3 && non_empty >= 3 && hits * 2 >= non_empty {
            let headers = padded_headers(row, table.headers.len());
            if !suggest(&headers, "ledger").contains_key("principal") {
                continue;
            }
            segs.last_mut().unwrap().end = i;
            segs.push(Seg {
                header: Some(i),
                start: i + 1,
                end: table.rows.len(),
            });
        }
    }
    segs
}
/// 用数据行单元格充当表头（切段后的段表头），补齐宽度并填未命名列。
fn padded_headers(row: &[String], width: usize) -> Vec<String> {
    let mut hs: Vec<String> = (0..width)
        .map(|i| row.get(i).cloned().unwrap_or_default())
        .collect();
    for (i, h) in hs.iter_mut().enumerate() {
        if h.trim().is_empty() {
            *h = format!("未命名列{}", i + 1);
        }
    }
    hs
}
/// 金额列表头标注的记账单位折算为元：万元×10000、千元×1000，其余（元/英文/未标注）×1。
fn unit_factor(header: &str) -> f64 {
    if header.contains('万') {
        10000.0
    } else if header.contains('千') {
        1000.0
    } else {
        1.0
    }
}
fn suggest(headers: &[String], kind: &str) -> Map<String, Value> {
    suggest_with_rows(headers, kind, &[])
}

/// 有数据行时一并交给内核——列名分不出本年累计与本期发生时要看金额量级。
fn suggest_with_rows(headers: &[String], kind: &str, rows: &[Vec<String>]) -> Map<String, Value> {
    // TB 与 JE 走统一映射内核，角色名、别名库、冲突词与其余四个工具完全一致。
    if kind == "tb" || kind == "je" {
        let mut out = Map::new();
        for (column, role) in ledger_mapping::suggest_roles_with_data(kind, headers, rows) {
            // 借款利息不启用原币口径，识别出来也用不上，不如不占格子。
            if role.contains("Foreign") {
                continue;
            }
            if let Some(header) = headers.get(column) {
                out.insert((*role).into(), Value::String(header.clone()));
            }
        }
        // 借款标识是本工具专属角色，不在标准表里，仍按关键词找。
        let loan_id = ["辅助", "明细", "客户"]
            .iter()
            .find_map(|w| headers.iter().find(|h| norm(h).contains(&norm(w))));
        if let Some(h) = loan_id {
            out.insert("loanId".into(), Value::String(h.clone()));
        }
        return out;
    }
    // 借款台账与利率台账走内核的 `loan` 角色表。此前这里是一份平铺关键词列表，
    // 它认出来的角色名（outstanding / endDate / rate）与前端面板下拉里的角色名
    // （closingPrincipal / maturityDate / fixedRate）根本不是一套，
    // 自动建议落不进格子，必填校验又按另一套问，台账模式因此一直卡在映射这一步。
    if kind == "ledger" || kind == "rateLedger" {
        let mut out = Map::new();
        for (column, role) in ledger_mapping::suggest_roles_with_data("loan", headers, rows) {
            if let Some(header) = headers.get(column) {
                out.insert(role.into(), Value::String(header.clone()));
            }
        }
        return out;
    }
    let rules: &[(&str, &[&str])] = match kind {
        _ => &[
            (
                "loanId",
                &[
                    "合同编号",
                    "借款编号",
                    "借据",
                    "登记编号",
                    "合同号",
                    "编号",
                    "ref",
                ],
            ),
            (
                "lender",
                &[
                    "贷款银行",
                    "贷款方",
                    "债权人",
                    "贷款人",
                    "贷款机构",
                    "金融机构",
                    "交易对手",
                    "承兑行",
                    "银行",
                    "lender",
                ],
            ),
            (
                "principal",
                &[
                    "借款本金",
                    "借款金额",
                    "放款金额",
                    "已提款",
                    "提款",
                    "票面金额",
                    "合同金额",
                    "原币金额",
                    "本金",
                    "金额",
                    "amount",
                ],
            ),
            (
                "startDate",
                &[
                    "借款起始日",
                    "放款起始日",
                    "放款日期",
                    "放款日",
                    "起息日",
                    "起始日",
                    "借款时间",
                    "起租日",
                    "借款日",
                    "drawdown",
                ],
            ),
            (
                "endDate",
                &["到期日期", "贷款到期日", "到期日", "到期时间", "maturity"],
            ),
            ("term", &["期限", "term"]),
            (
                "rate",
                &[
                    "执行利率",
                    "折算年利率",
                    "年利率",
                    "固定利率",
                    "贴现率",
                    "利率",
                    "利息",
                    "rate",
                ],
            ),
            ("rateType", &["利率类型", "利率形式"]),
            ("benchmarkRate", &["基准利率", "lpr"]),
            ("spreadBps", &["加点", "bp"]),
            (
                "outstanding",
                &[
                    "未偿还本金",
                    "未还余额",
                    "期末余额",
                    "贷款余额",
                    "期末本金",
                    "余额",
                ],
            ),
            ("openingPrincipal", &["期初本金", "期初余额", "年初余额"]),
            ("drawdownAmount", &["本期新增", "新增本金", "借款增加"]),
            ("drawdownDate", &["新增借款日期"]),
            (
                "repaymentAmount",
                &["本期归还", "还款本金", "本期减少", "归还", "已还"],
            ),
            ("repaymentMethod", &["还本方式", "还款方式", "还本安排"]),
            ("repaymentDate", &["还款日期", "归还日"]),
        ],
    };
    let mut out = Map::new();
    for (role, words) in rules {
        // 词为外层循环：特异词（如"执行利率"）优先于泛化词（如"利率"）；
        // 个别角色需排除易混淆列（"利率类型"不是利率值，"剩余天数"不是期限）。
        let exclude: &[&str] = match *role {
            "rate" => &["类型", "方式", "定价", "调整"],
            "term" => &["剩余", "天数"],
            _ => &[],
        };
        let hit = words.iter().find_map(|w| {
            headers.iter().find(|h| {
                let nh = norm(h);
                !exclude.iter().any(|x| nh.contains(x)) && nh.contains(&norm(w))
            })
        });
        if let Some(h) = hit {
            out.insert((*role).into(), Value::String(h.clone()));
        }
    }
    out
}
/// 历史保存的映射用的是旧角色名（`account`、`voucherId`、`openingPrincipal`…），
/// 读取时统一迁移到标准名，两种都能命中。
fn slot<'a>(m: &'a Map<String, Value>, kind: &str, role: &str) -> Option<&'a Value> {
    if let Some(v) = m.get(role) {
        return Some(v);
    }
    // 反向找：映射里存的是旧名，而调用方问的是标准名。
    m.iter()
        .find(|(k, _)| ledger_mapping::migrate_role_name(kind, k) == role)
        .map(|(_, v)| v)
}

fn mapped_names(m: &Map<String, Value>, kind: &str, role: &str) -> Vec<String> {
    match slot(m, kind, role) {
        Some(Value::String(name)) => vec![name.clone()],
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}

fn text(table: &Table, row: &[String], m: &Map<String, Value>, role: &str) -> String {
    m.get(role)
        .and_then(Value::as_str)
        .and_then(|h| table.headers.iter().position(|x| x == h))
        .and_then(|i| row.get(i))
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_string()
}
fn num(table: &Table, row: &[String], m: &Map<String, Value>, role: &str) -> f64 {
    parse_num(&text(table, row, m, role))
}
fn row_date(
    table: &Table,
    row: &[String],
    mapping: &Map<String, Value>,
    role: &str,
) -> Option<NaiveDate> {
    parse_date(&text(table, row, mapping, role))
}
/// 宽容日期解析：覆盖台账里常见的文本写法、日期时间串与 Excel 序列号。
/// 日期解析，**走统一内核**。本模块原有的英文月份缩写与「先切时间段」两项能力
/// 已经并进内核，汇兑损益的 ISO `T` 分隔写法也一并覆盖。
fn parse_date(s: &str) -> Option<NaiveDate> {
    ledger_mapping::parse_date(s)
}
/// 中文日期："2024年3月5日"、"25年1月10日"（两位年按 20xx）。
fn parse_cn_date(s: &str) -> Option<NaiveDate> {
    let i_nian = s.find('年')?;
    let y_str = &s[..i_nian];
    let y = if y_str.chars().count() <= 2 {
        2000 + y_str.parse::<i32>().ok()?
    } else {
        y_str.parse::<i32>().ok()?
    };
    let rest = &s[i_nian + '年'.len_utf8()..];
    let i_yue = rest.find('月')?;
    let m = rest[..i_yue].parse::<u32>().ok()?;
    let d_part = &rest[i_yue + '月'.len_utf8()..];
    let d = d_part.trim_end_matches('日').trim().parse::<u32>().ok()?;
    NaiveDate::from_ymd_opt(y, m, d)
}
/// 期限解析为月数："12个月"、"3年"、"一年"、"17个月（含展期）"、"12"。
fn parse_term_months(s: &str) -> Option<u32> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<u32>() {
        return (n > 0).then_some(n);
    }
    let cn = |c: char| -> i32 {
        match c {
            '一' => 1,
            '二' | '两' => 2,
            '三' => 3,
            '四' => 4,
            '五' => 5,
            '六' => 6,
            '七' => 7,
            '八' => 8,
            '九' => 9,
            '十' => 10,
            _ => 0,
        }
    };
    let first = t.chars().next()?;
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.parse::<u32>().is_ok() {
        let n = digits.parse::<u32>().ok()?;
        return if t.contains('年') {
            Some(n.saturating_mul(12))
        } else {
            Some(n)
        };
    }
    let n = cn(first);
    if n == 0 {
        return None;
    }
    if t.contains('年') {
        Some((n.saturating_mul(12)) as u32)
    } else {
        Some(n as u32)
    }
}
fn rates(
    t: &Table,
    r: &[String],
    m: &Map<String, Value>,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let opt = |role| {
        let s = text(t, r, m, role);
        parse_optional_num(&s).map(normalize_rate)
    };
    // `fixedRate` 是台账角色统一之前的旧名，仍可能出现在历史映射里；
    // 现在的标准名是 `rate`（执行利率数值列）。
    (
        opt("fixedRate").or_else(|| opt("rate")),
        opt("benchmarkRate"),
        {
            let s = text(t, r, m, "spreadBps");
            parse_optional_num(
                s.trim()
                    .trim_end_matches("BP")
                    .trim_end_matches("bp")
                    .trim_end_matches("基点"),
            )
            .or_else(|| spread_in_rate_text(&text(t, r, m, "rate")))
        },
    )
}
fn spread_in_rate_text(s: &str) -> Option<f64> {
    let clean = s.replace('＋', "+").replace(['−', '－'], "-");
    Regex::new(r"(?i)([+-]\s*\d+(?:\.\d+)?)\s*(?:bps?|基点)")
        .ok()?
        .captures(&clean)?
        .get(1)?
        .as_str()
        .replace(' ', "")
        .parse()
        .ok()
}
fn parse_optional_num(s: &str) -> Option<f64> {
    let percent = s.contains(['%', '％']);
    let clean = s
        .replace([',', '，', '¥', '￥', ' ', '%', '％'], "")
        .replace(['(', '（'], "-")
        .replace([')', '）'], "");
    let n = clean.parse::<f64>().ok().filter(|n| n.is_finite())?;
    Some(if percent { n / 100.0 } else { n })
}
fn source_rate_type(t: &Table, r: &[String], m: &Map<String, Value>) -> String {
    // 已有数值执行利率时一律默认固定。旁列即使写「浮动」，也只有用户在
    // 预览区明确切换后才会作为 override 生效，避免把执行利率误当浮动基准。
    let execution = text(t, r, m, "fixedRate");
    let execution = if execution.is_empty() {
        text(t, r, m, "rate")
    } else {
        execution
    };
    if parse_optional_num(&execution).is_some() {
        return "fixed".into();
    }
    let explicit = text(t, r, m, "rateType");
    rate_type_fn(&if explicit.is_empty() {
        execution
    } else {
        explicit
    })
}
fn parse_num(s: &str) -> f64 {
    let percent = s.contains('%');
    let clean = s
        .replace([',', '¥', '￥', ' '], "")
        .replace('%', "")
        .replace('(', "-")
        .replace(')', "");
    let n = clean.parse::<f64>().unwrap_or(0.0);
    if percent { n / 100.0 } else { n }
}
fn normalize_rate(x: f64) -> f64 {
    if x.abs() > 1.0 { x / 100.0 } else { x }
}
fn rate_type_fn(s: &str) -> String {
    let lower = s.to_lowercase();
    if [
        "浮",
        "lpr",
        "基准",
        "挂钩",
        "随行就市",
        "重定价",
        "可变",
        "float",
        "variable",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        "floating".into()
    } else {
        "fixed".into()
    }
}
fn date(params: &Value, key: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(
        params.get(key).and_then(Value::as_str).unwrap_or(""),
        "%Y-%m-%d",
    )
    .map_err(|_| error("INVALID_DATE", "测算期间日期无效。", None))
}
/// 按标准角色名取数（旧名也能命中）。
fn num_role(table: &Table, row: &[String], m: &Map<String, Value>, kind: &str, role: &str) -> f64 {
    mapped_names(m, kind, role)
        .first()
        .and_then(|h| table.headers.iter().position(|x| x == h))
        .and_then(|i| row.get(i))
        .map(|v| parse_num(v))
        .unwrap_or(0.0)
}

/// 按标准角色名取文本（旧名也能命中）。
fn role_text(
    table: &Table,
    row: &[String],
    m: &Map<String, Value>,
    kind: &str,
    role: &str,
) -> String {
    mapped_names(m, kind, role)
        .iter()
        .filter_map(|h| table.headers.iter().position(|x| x == h))
        .filter_map(|i| row.get(i))
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 科目文本＝编码＋名称拼起来；历史映射把两者混在一个 account 格子里时，
/// slot 的旧名迁移会把它当编码命中，同样得到完整文本。
/// 统一内核的建议只给 accountCode／accountName 新名，按旧名直查会得到空串，
/// TB＋JE 模式曾经因此一行都进不来。
fn account_text(table: &Table, row: &[String], m: &Map<String, Value>, kind: &str) -> String {
    let mut parts = vec![];
    for role in ["accountCode", "accountName"] {
        let t = role_text(table, row, m, kind, role);
        if !t.is_empty() {
            parts.push(t);
        }
    }
    parts.join(" ")
}

/// 收集某个时点（`opening` / `closing`）在这一行的原始取值，交给内核折算。
fn amount_inputs(
    table: &Table,
    row: &[String],
    m: &Map<String, Value>,
    prefix: &str,
) -> ledger_mapping::AmountInputs {
    let cap = |suffix: &str| format!("{prefix}Functional{suffix}");
    let has = |role: &str| slot(m, "tb", role).is_some();
    let get = |role: &str| {
        if has(role) {
            Some(num_role(table, row, m, "tb", role))
        } else {
            None
        }
    };
    let direction_role = format!("{prefix}Direction");
    ledger_mapping::AmountInputs {
        amount: get(&cap("Amount")),
        debit: get(&cap("Debit")),
        credit: get(&cap("Credit")),
        direction: slot(m, "tb", &direction_role)
            .and_then(Value::as_str)
            .and_then(|h| table.headers.iter().position(|x| x == h))
            .and_then(|i| row.get(i))
            .cloned(),
    }
}

fn je_amount_inputs(
    table: &Table,
    row: &[String],
    m: &Map<String, Value>,
) -> ledger_mapping::AmountInputs {
    let has = |role: &str| !mapped_names(m, "je", role).is_empty();
    if has("functionalDebit") && has("functionalCredit") {
        ledger_mapping::AmountInputs {
            debit: Some(num_role(table, row, m, "je", "functionalDebit")),
            credit: Some(num_role(table, row, m, "je", "functionalCredit")),
            ..Default::default()
        }
    } else {
        ledger_mapping::AmountInputs {
            amount: has("functionalAmount")
                .then(|| num_role(table, row, m, "je", "functionalAmount")),
            direction: has("direction").then(|| role_text(table, row, m, "je", "direction")),
            ..Default::default()
        }
    }
}

fn je_sign_convention(table: &Table, m: &Map<String, Value>) -> ledger_mapping::SignConvention {
    let evidence = ledger_mapping::detect_sign_convention(&table.headers, &table.rows, &|role| {
        mapped_names(m, "je", role)
    });
    evidence
        .convention
        .unwrap_or(ledger_mapping::SignConvention::Unsigned)
}

/// 全表判一次贷方列的符号口径。
fn tb_sign_convention(table: &Table, m: &Map<String, Value>) -> ledger_mapping::SignConvention {
    let rows: Vec<ledger_mapping::BalanceRow> = table
        .rows
        .iter()
        .map(|row| ledger_mapping::BalanceRow {
            opening: ledger_mapping::signed_amount(
                &amount_inputs(table, row, m, "opening"),
                ledger_mapping::SignConvention::Unsigned,
            ),
            debit: num_role(table, row, m, "tb", "ytdFunctionalDebit"),
            credit: num_role(table, row, m, "tb", "ytdFunctionalCredit"),
            closing: ledger_mapping::signed_amount(
                &amount_inputs(table, row, m, "closing"),
                ledger_mapping::SignConvention::Unsigned,
            ),
        })
        .collect();
    ledger_mapping::tb_sign_evidence(&rows)
        .convention
        .unwrap_or(ledger_mapping::SignConvention::Unsigned)
}

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !['-', '_', '/', '—'].contains(c))
        .flat_map(char::to_lowercase)
        .collect()
}
fn data_text(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(n) => {
            if n.fract() == 0.0 {
                format!("{n:.0}")
            } else {
                n.to_string()
            }
        }
        Data::Int(n) => n.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => format!("{e:?}"),
    }
}
fn xlsx(e: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "EXPORT_FAILED",
        "无法生成 Excel 底稿。",
        Some(e.to_string()),
    )
}
fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

#[cfg(test)]
mod loan_form_tests {
    use super::*;

    fn h(cols: &[&str]) -> Vec<String> {
        cols.iter().map(|x| (*x).to_string()).collect()
    }
    /// 表头 → 自动映射 → 命中的型号。
    fn form_of(cols: &[&str]) -> Option<String> {
        loan_form(&suggest(&h(cols), "ledger"))
    }
    fn col(cols: &[&str], role: &str) -> String {
        suggest(&h(cols), "ledger")
            .get(role)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    // 测试集 `借款合同台账测试集` 九份台账的真实表头。
    // 这九份是判型口径的基线：改别名库或形态定义时先跑这一组。
    const S01: &[&str] = &[
        "序号",
        "合同编号",
        "贷款银行",
        "借款金额(元)",
        "币种",
        "借款起始日",
        "到期日",
        "期限(月)",
        "利率(%)",
        "付息方式",
        "担保方式",
        "抵押/保证情况",
        "借款用途",
        "期末余额(元)",
        "合同状态",
    ];
    const S02: &[&str] = &[
        "借款主体",
        "金融机构/出借方",
        "币种",
        "放款金额(万元)",
        "放款日",
        "到期日",
        "期限(月)",
        "执行利率(%)",
        "计息方式",
        "借款类型",
        "担保方式",
        "担保人/抵质押物",
        "资金用途",
        "2025年末余额(万元)",
        "存续状态",
    ];
    const S03: &[&str] = &[
        "序号",
        "合同编号",
        "贷款银行/出借方",
        "借款金额",
        "放款日期",
        "到期日期",
        "期限",
        "利率",
        "担保方式",
        "借款用途",
        "未还余额",
        "备注",
    ];
    const S04: &[&str] = &[
        "序号",
        "借款合同号",
        "债权人",
        "借款类型",
        "币种",
        "借款本金",
        "起息日",
        "到期日",
        "定价基准",
        "折算年利率(%)",
        "还本方式",
        "付息频率",
        "增信措施",
        "资金用途",
        "期初余额",
        "本期新增",
        "本期归还",
        "期末余额",
    ];
    const S05: &[&str] = &[
        "序号",
        "贷款机构",
        "贷款品种",
        "开发项目",
        "借款合同编号",
        "授信金额",
        "已提款金额",
        "剩余额度",
        "累计归还本金",
        "贷款余额",
        "放款起始日",
        "贷款到期日",
        "执行年利率(%)",
        "抵押物",
        "他项权证号",
        "担保方式",
        "还款来源",
        "备注",
    ];
    const S06: &[&str] = &[
        "序号",
        "借款时间",
        "贷款方",
        "借款金额",
        "利息(年化%)",
        "到期时间",
        "已还",
        "状态",
        "月供(元)",
        "备注",
    ];
    const S07: &[&str] = &[
        "合同编号",
        "借款主体",
        "贷款人",
        "原币金额",
        "币种",
        "汇率",
        "折人民币金额（元）",
        "放款日",
        "到期日",
        "利率类型",
        "利率",
        "下次付息日",
        "担保方式",
        "是否关联方借款",
        "资金用途",
        "期末未偿还本金（原币）",
        "借款状态",
    ];
    const S08: &[&str] = &[
        "登记编号",
        "业务类型",
        "借款主体/出票人",
        "交易对手",
        "承兑行/开证行",
        "票面金额（千元）",
        "起始日（放款/开票日）",
        "到期日",
        "利率/贴现率",
        "剩余天数（天）",
        "保证金比例",
        "担保/追索安排",
        "经办人",
        "状态",
    ];
    const S09: &[&str] = &[
        "合同编号",
        "放款银行",
        "借款金额（万元）",
        "放款日期",
        "到期日期",
        "年利率%",
        "担保方式",
    ];

    #[test]
    fn 九份真实台账全部命中A型() {
        for (name, cols) in [
            ("01", S01),
            ("02", S02),
            ("03", S03),
            ("04", S04),
            ("05", S05),
            ("06", S06),
            ("07", S07),
            ("08", S08),
            ("09", S09),
        ] {
            assert_eq!(
                form_of(cols).as_deref(),
                Some("A"),
                "样例 {name} 应命中 A 型"
            );
        }
    }

    #[test]
    fn 到期日与期限并存时认A型() {
        // 01／02 同时给了到期日与期限(月)。到期日是直接列示的，比拿期限推算准。
        assert_eq!(form_of(S01).as_deref(), Some("A"));
        assert_eq!(col(S01, "endDate"), "到期日");
        assert_eq!(col(S01, "term"), "期限(月)");
    }

    #[test]
    fn 到期日与期间发生额并存时认A型() {
        // 04 深圳前湾四栏俱全，但它也有到期日——认 A 型，四栏留作勾稽校验。
        assert_eq!(form_of(S04).as_deref(), Some("A"));
        assert_eq!(col(S04, "drawdownAmount"), "本期新增");
        assert_eq!(col(S04, "repaymentAmount"), "本期归还");
        assert_eq!(col(S04, "openingPrincipal"), "期初余额");
        assert_eq!(col(S04, "closingPrincipal"), "期末余额");
    }

    #[test]
    fn 授信金额与剩余额度不得被当成本金() {
        // 05 金陵润庭：授信 120000 万、实提 90000 万。认错列会按授信额计息。
        assert_eq!(col(S05, "principal"), "已提款金额");
        assert_eq!(col(S05, "closingPrincipal"), "贷款余额");
        assert_eq!(col(S05, "repaymentAmount"), "累计归还本金");
    }

    #[test]
    fn 期末未偿还本金归期末余额而不是本金() {
        // 07 星衡：`期末未偿还本金（原币）` 同时含「本金」，靠最长命中判给期末余额。
        assert_eq!(col(S07, "closingPrincipal"), "期末未偿还本金（原币）");
        assert_eq!(col(S07, "principal"), "原币金额");
        // 利率类型是独立列，不能把利率值那一列抢走。
        assert_eq!(col(S07, "rate"), "利率");
        assert_eq!(col(S07, "rateType"), "利率类型");
    }

    #[test]
    fn 民间写法的利息与已还也认得出来() {
        // 06 川南宏运：利率列写成「利息(年化%)」，还款列写成「已还」。
        assert_eq!(col(S06, "rate"), "利息(年化%)");
        assert_eq!(col(S06, "repaymentAmount"), "已还");
        assert_eq!(col(S06, "startDate"), "借款时间");
        // 「月供(元)」是现金流不是本金，不能被当成起算额。
        assert_ne!(col(S06, "principal"), "月供(元)");
    }

    #[test]
    fn 剩余天数不是期限() {
        // 08 星衡票据：`剩余天数（天）` 既不是期限也不是到期日。
        assert_eq!(col(S08, "term"), "");
        assert_eq!(col(S08, "endDate"), "到期日");
        assert_eq!(col(S08, "principal"), "票面金额（千元）");
    }

    #[test]
    fn 起算额三者任一到位即可() {
        use std::collections::HashSet;
        let form = |roles: &[&str]| {
            let mapped: HashSet<&str> = roles.iter().copied().collect();
            match ledger_mapping::resolve_form("loan", &mapped) {
                ledger_mapping::FormVerdict::Matched(m) => Some(m.form),
                ledger_mapping::FormVerdict::Incomplete(_) => None,
            }
        };
        // A 型：起算额给本金、期初余额、期末余额中的任意一个都成立。
        for amount in ["principal", "openingPrincipal", "closingPrincipal"] {
            let roles = [amount, "startDate", "endDate", "rate"];
            let want = if amount == "closingPrincipal" {
                None
            } else {
                Some("A")
            };
            assert_eq!(form(&roles), want, "A 型起算额 = {amount}");
        }
        // B 型：到期日换成期限。
        assert_eq!(form(&["principal", "startDate", "term", "rate"]), Some("B"));
        // C／D 型：没有到期日也没有期限，靠期间发生额还原。
        assert_eq!(
            form(&[
                "openingPrincipal",
                "startDate",
                "rate",
                "drawdownAmount",
                "repaymentAmount"
            ]),
            Some("C")
        );
        assert_eq!(
            form(&[
                "closingPrincipal",
                "startDate",
                "rate",
                "drawdownAmount",
                "repaymentAmount"
            ]),
            Some("D")
        );
    }

    #[test]
    fn 无固定期限借款不纳入() {
        use std::collections::HashSet;
        // 只有起算额＋起始日＋利率的无固定期限借款（股东借款、关联方拆借）
        // 当前不在测算范围内：既不命中任何一型，也不该被静默当成某一型放行。
        let mapped: HashSet<&str> = ["principal", "startDate", "rate"].into_iter().collect();
        assert!(matches!(
            ledger_mapping::resolve_form("loan", &mapped),
            ledger_mapping::FormVerdict::Incomplete(_)
        ));
        // 提示语要说清楚差什么：最接近 A 型，缺到期日。
        let ledger_mapping::FormVerdict::Incomplete(m) =
            ledger_mapping::resolve_form("loan", &mapped)
        else {
            panic!("不该完整命中");
        };
        let text = ledger_mapping::describe_incomplete("loan", &m);
        assert!(text.contains("A"), "{text}"); // 「按 A（起始日＋到期日）匹配…」
        assert!(text.contains("到期日"), "{text}");
    }

    #[test]
    fn 逐行利率口径覆盖台账的写法() {
        use super::tests::{SyntheticLedger, run_preview};
        let fixture = SyntheticLedger::new(&[["3.85", "", "", ""], ["3.45", "", "", ""]]);
        let mut params = fixture.params();

        let base = run_preview(&params).expect("preview 失败");
        assert_eq!(base["rows"][0]["rateType"], "fixed");
        assert!((base["rows"][0]["effectiveRate"].as_f64().unwrap() - 0.0385).abs() < 1e-9);

        // 用户在预览区把第一行改成浮动、上浮 50BP：原 3.85% 是
        // 执行利率，不得充当基准；改用报告期初 1 年期 LPR 3.10% + 0.50%。
        params["ledgerRateOverrides"] = json!([{"rateType": "floating", "spreadBps": 50}]);
        let over = run_preview(&params).expect("preview 失败");
        assert_eq!(over["rows"][0]["rateType"], "floating");
        assert!((over["rows"][0]["effectiveRate"].as_f64().unwrap() - 0.0360).abs() < 1e-9);
        assert!(
            over["rows"][0]["matchBasis"]
                .as_str()
                .unwrap()
                .contains("LPR")
        );
        // 没给覆盖的行仍按台账原样，不受影响。
        assert_eq!(over["rows"][1]["rateType"], "fixed");
        assert!((over["rows"][1]["effectiveRate"].as_f64().unwrap() - 0.0345).abs() < 1e-9);
    }

    #[test]
    fn 下浮记为负点数() {
        let (kind, fixed, benchmark, bps) = apply_rate_override(
            Some(&RateOverride {
                rate_type: "floating".into(),
                spread_bps: Some(-85.0),
            }),
            "fixed".into(),
            Some(0.043),
            None,
            None,
        );
        assert_eq!(kind, "floating");
        assert_eq!(fixed, None);
        // 4.3% 是执行利率，切换浮动后不能当基准。
        assert_eq!(benchmark, None);
        assert_eq!(bps, Some(-85.0));
    }

    #[test]
    fn 改回固定利率时丢掉加点() {
        let (kind, fixed, benchmark, bps) = apply_rate_override(
            Some(&RateOverride {
                rate_type: "fixed".into(),
                spread_bps: Some(50.0),
            }),
            "floating".into(),
            None,
            Some(0.031),
            Some(90.0),
        );
        assert_eq!(
            (kind.as_str(), fixed, benchmark, bps),
            ("fixed", Some(0.031), None, None)
        );
    }

    /// 台账只写「浮动」两个字、没有基准利率列时，基准从内置 LPR 报价表来。
    fn floating_row() -> LoanRow {
        LoanRow {
            loan_id: "L1".into(),
            opening_principal: 1_000_000.0,
            closing_principal: 1_000_000.0,
            rate_type: "floating".into(),
            spread_bps: Some(50.0),
            match_status: "已匹配".into(),
            ..LoanRow::default()
        }
    }

    #[test]
    fn 浮动缺基准时回落到内置lpr() {
        let mut rows = vec![floating_row()];
        calculate_interest(
            &mut rows,
            &json!({"reportStart": "2025-01-01", "reportEnd": "2025-12-31"}),
        )
        .expect("测算失败");
        // 定价基准日 = 报告期初 2025-01-01 → 2024-10-21 起执行的 1 年期 3.10%，加 50BP。
        assert!((rows[0].benchmark_rate.unwrap() - 0.0310).abs() < 1e-12);
        assert!((rows[0].effective_rate - 0.0360).abs() < 1e-12);
        assert_eq!(rows[0].match_status, "待复核");
        assert!(rows[0].match_basis.contains("重定价"));
    }

    #[test]
    fn 定价基准日超出内置报价表时标待复核() {
        let mut rows = vec![floating_row()];
        // 报告期 2027 年：晚于已核验报价截止日。
        calculate_interest(
            &mut rows,
            &json!({"reportStart": "2027-01-01", "reportEnd": "2027-06-30"}),
        )
        .expect("测算失败");
        // 仍然算得出数（用最后一期报价），但必须提示补录后复核。
        assert!((rows[0].benchmark_rate.unwrap() - 0.0300).abs() < 1e-12);
        assert_eq!(rows[0].match_status, "待复核");
        assert!(
            rows[0].match_basis.contains("补录"),
            "{}",
            rows[0].match_basis
        );
    }

    #[test]
    fn 改革之前的浮动借款不硬套lpr() {
        let mut rows = vec![floating_row()];
        // 2018 年没有 LPR，挂的是央行基准贷款利率。硬套会得出一个看似合理的错数。
        calculate_interest(
            &mut rows,
            &json!({"reportStart": "2018-01-01", "reportEnd": "2018-12-31"}),
        )
        .expect("测算失败");
        assert_eq!(rows[0].benchmark_rate, None);
        assert_eq!(rows[0].match_status, "待复核");
        assert!(
            rows[0].match_basis.contains("LPR 改革之前"),
            "{}",
            rows[0].match_basis
        );
    }

    #[test]
    fn 台账执行利率改浮动后改用lpr基准() {
        use super::tests::SyntheticLedger;
        // 3.85% 是执行利率；用户改成浮动 +30BP 后改查 LPR。
        let fixture = SyntheticLedger::new(&[["3.85", "", "", ""]]);
        let mut params = fixture.params();
        params["ledgerRateOverrides"] = json!([{"rateType": "floating", "spreadBps": 30}]);

        let mut rows = calculate(&params).expect("calculate 失败");
        calculate_interest(&mut rows, &params).expect("测算失败");
        let first = &rows[0];
        assert!((first.benchmark_rate.unwrap() - 0.0310).abs() < 1e-12);
        assert!((first.effective_rate - 0.0340).abs() < 1e-12);
        assert_eq!(first.lpr_term, "1年期");
        assert_eq!(first.rate_basis_date.as_deref(), Some("2025-01-01"));
        // 利息 = Σ(本金×天数) × 有效年利率 ÷ 365，与逐段累加的结果一致。
        assert!(first.principal_days > 0.0);
        assert!(
            (first.calculated_interest - first.principal_days * first.effective_rate / 365.0).abs()
                < 1e-6
        );
    }

    #[test]
    fn 底稿写出lpr报价表且三列是活公式() {
        // 走内置 LPR 的行：基准利率、有效年利率、测算利息都要是公式——
        // 用户在「LPR报价表」改一个格子，整份底稿重算。
        let mut rows = vec![floating_row()];
        let params = json!({"reportStart": "2025-01-01", "reportEnd": "2025-12-31"});
        calculate_interest(&mut rows, &params).expect("测算失败");
        assert_eq!(rows[0].lpr_term, "1年期");
        assert_eq!(rows[0].rate_basis_date.as_deref(), Some("2025-01-01"));

        let out = std::env::temp_dir().join("借款利息_lpr_测试.xlsx");
        let _ = std::fs::remove_file(&out);
        let mut export_params = params.clone();
        export_params["outputPath"] = json!(out.to_string_lossy());
        export(&rows, &export_params).expect("导出失败");

        let mut book = calamine::open_workbook_auto(&out).unwrap();
        let names = calamine::Reader::sheet_names(&book).to_vec();
        assert!(
            names.iter().any(|n| n == LPR_SHEET),
            "缺少 LPR 报价表：{names:?}"
        );

        let quotes = calamine::Reader::worksheet_range(&mut book, LPR_SHEET).unwrap();
        assert_eq!(
            quotes.height(),
            LPR_FIRST_DATA_ROW - 1 + lpr::quotes().len()
        );
        assert_eq!(quotes.get_value((3, 1)).unwrap().to_string(), "1年期LPR(%)");

        let formulas =
            calamine::Reader::worksheet_formula(&mut book, "借款变动与利息测算").unwrap();
        // K 列基准利率：INDEX/MATCH 指向报价表，按 I 列的定价基准日取那一期。
        let base = formulas.get_value((1, 10)).cloned().unwrap_or_default();
        assert!(base.contains("LPR报价表"), "基准利率应引用报价表：{base}");
        assert!(
            base.contains("MATCH(I2"),
            "应按定价基准日那一格查表：{base}"
        );
        // M 列有效年利率、O 列测算利息同样是公式。
        assert!(formulas.get_value((1, 12)).unwrap().contains("K2+L2/10000"));
        assert_eq!(formulas.get_value((1, 14)).unwrap(), "N2*M2/365");
        // F 列勾稽差异：复核时常直接在底稿上改期初/期末，差异必须跟着动。
        assert_eq!(formulas.get_value((1, 5)).unwrap(), "B2+C2-D2-E2");
        // 合计行：金额与利息一律 SUM，且区间不含合计行自身。
        let total_row = rows.len() + 1;
        assert_eq!(
            formulas.get_value((total_row as u32, 1)).unwrap(),
            &format!("SUM(B2:B{})", rows.len() + 1)
        );
        assert_eq!(
            formulas.get_value((total_row as u32, 14)).unwrap(),
            &format!("SUM(O2:O{})", rows.len() + 1)
        );
        let values = calamine::Reader::worksheet_range(&mut book, "借款变动与利息测算").unwrap();
        assert_eq!(
            values.get_value((total_row as u32, 0)).unwrap().to_string(),
            "合计"
        );
        // 利率类的列不合计——加总没有意义。
        assert_eq!(
            formulas.get_value((total_row as u32, 12)),
            Some(&String::new())
        );
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn 固定利率行不写lpr公式() {
        use super::tests::{SyntheticLedger, run_preview};
        let fixture = SyntheticLedger::new(&[["3.85", "", "", ""]]);
        let params = fixture.params();
        let out = run_preview(&params).expect("preview 失败");
        // 台账利率列全是数值，默认全固定，不该出现定价基准日与 LPR 品种。
        assert_eq!(out["rows"][0]["rateType"], "fixed");
        assert_eq!(out["rows"][0]["lprTerm"], "");
        assert_eq!(out["rows"][0]["rateBasisDate"], Value::Null);
    }

    #[test]
    fn 旧角色名映射仍然可读() {
        // 前端面板此前用 maturityDate／fixedRate，引擎识别出来的是 endDate／rate。
        let mut old = Map::new();
        old.insert("principal".into(), Value::String("借款金额".into()));
        old.insert("startDate".into(), Value::String("放款日".into()));
        old.insert("maturityDate".into(), Value::String("到期日".into()));
        old.insert("fixedRate".into(), Value::String("利率".into()));
        old.insert("outstanding".into(), Value::String("期末余额".into()));
        let fixed = normalize_loan_mapping(old);
        assert_eq!(fixed.get("endDate").and_then(Value::as_str), Some("到期日"));
        assert_eq!(fixed.get("rate").and_then(Value::as_str), Some("利率"));
        assert_eq!(
            fixed.get("closingPrincipal").and_then(Value::as_str),
            Some("期末余额")
        );
        assert_eq!(loan_form(&fixed).as_deref(), Some("A"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 纯合成台账：不依赖本机客户目录，覆盖真实 Excel 上传与解析路径。
    pub(super) struct SyntheticLedger {
        pub(super) dir: PathBuf,
        path: PathBuf,
    }
    impl SyntheticLedger {
        pub(super) fn new(rates: &[[&str; 4]]) -> Self {
            let dir =
                std::env::temp_dir().join(format!("loan-regression-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&dir).unwrap();
            let path = dir.join("synthetic.xlsx");
            let mut book = Workbook::new();
            let sheet = book.add_worksheet();
            let headers = [
                "借款标识",
                "借款金额",
                "起始日",
                "到期日",
                "利率",
                "利率类型",
                "基准利率",
                "加/减点BP",
            ];
            for (col, name) in headers.iter().enumerate() {
                sheet.write_string(0, col as u16, *name).unwrap();
            }
            for (index, rate) in rates.iter().enumerate() {
                let y = index as u32 + 1;
                sheet
                    .write_string(y, 0, format!("SYN-{}", index + 1))
                    .unwrap();
                sheet.write_number(y, 1, 1_000_000.0).unwrap();
                sheet.write_string(y, 2, "2024-01-01").unwrap();
                sheet.write_string(y, 3, "2027-12-31").unwrap();
                for (col, text) in rate.iter().enumerate() {
                    sheet.write_string(y, col as u16 + 4, *text).unwrap();
                }
            }
            book.save(&path).unwrap();
            Self { dir, path }
        }
        pub(super) fn params(&self) -> Value {
            let inspected = inspect(&inspect_params(&self.path, 0)).unwrap();
            assert_eq!(inspected["headerRow"], 1);
            assert_eq!(inspected["suggestedMapping"]["rate"], "利率");
            preview_params(
                &self.path,
                1,
                json!({"loanId":"借款标识","principal":"借款金额","startDate":"起始日","endDate":"到期日","rate":"利率","rateType":"利率类型","benchmarkRate":"基准利率","spreadBps":"加/减点BP"}),
            )
        }
    }
    impl Drop for SyntheticLedger {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn uploaded_floating_text_preserves_missing_rate_and_source_spread() {
        let fixture = SyntheticLedger::new(&[
            ["浮动", "", "", ""],
            ["LPR+90BP", "", "", ""],
            ["LPR-25BP", "", "", "75"],
        ]);
        let mut params = fixture.params();
        params["ledgerRateOverrides"] = json!([null, null, null]);
        let result = run_preview(&params).unwrap();
        for row in result["rows"].as_array().unwrap() {
            assert_eq!(row["fixedRate"], Value::Null);
            assert!((row["benchmarkRate"].as_f64().unwrap() - 0.031).abs() < 1e-12);
            assert_eq!(row["matchStatus"], "待复核");
        }
        assert!(
            (result["rows"][0]["calculatedInterest"].as_f64().unwrap() - 31_000.0).abs() < 0.01
        );
        assert!(
            (result["rows"][1]["calculatedInterest"].as_f64().unwrap() - 40_000.0).abs() < 0.01
        );
        assert_eq!(result["rows"][1]["spreadBps"], 90.0);
        assert_eq!(result["rows"][2]["spreadBps"], 75.0);
        // 只改点数，不必同时回传类型；零是明确修改，不等于“未给”。
        params["ledgerRateOverrides"] = json!([null, {"spreadBps":0}, null]);
        assert_eq!(run_preview(&params).unwrap()["rows"][1]["spreadBps"], 0.0);
    }

    #[test]
    fn uploaded_floating_execution_rate_and_formula_caches_agree() {
        let fixture = SyntheticLedger::new(&[["4.2%", "浮动", "", "90"]]);
        let mut params = fixture.params();
        // 已有 4.2% 执行利率时默认固定；用户明确切换浮动后，清空执行利率，
        // 改用报告期初 1 年期 LPR 3.10% + 90BP = 4.00%。
        params["ledgerRateOverrides"] = json!([{"rateType":"floating", "spreadBps":90}]);
        let mut rows = calculate(&params).unwrap();
        calculate_interest(&mut rows, &params).unwrap();
        assert!((rows[0].benchmark_rate.unwrap() - 0.031).abs() < 1e-12);
        assert_eq!(rows[0].lpr_term, "1年期");
        assert!((rows[0].effective_rate - 0.040).abs() < 1e-12);
        assert!((rows[0].calculated_interest - 40_000.0).abs() < 0.01);
        params["outputPath"] = json!(fixture.dir.join("result.xlsx"));
        let out = export(&rows, &params).unwrap();
        let mut book = open_workbook_auto(&out).unwrap();
        let values = book.worksheet_range("借款变动与利息测算").unwrap();
        assert_eq!(values.get_value((1, 10)).unwrap().to_string(), "0.031");
        assert!(
            (values
                .get_value((1, 12))
                .unwrap()
                .to_string()
                .parse::<f64>()
                .unwrap()
                - 0.040)
                .abs()
                < 1e-12
        );
        assert_eq!(values.get_value((1, 14)).unwrap().to_string(), "40000");
        assert_eq!(values.get_value((2, 14)).unwrap().to_string(), "40000");
        let formulas = book.worksheet_formula("借款变动与利息测算").unwrap();
        assert_eq!(
            formulas.get_value((1, 12)).unwrap(),
            "IF(AND(G2=\"浮动\",ISNUMBER(K2)),K2+L2/10000,IF(ISNUMBER(H2),H2,K2+L2/10000))"
        );
    }

    #[test]
    fn tb_supplemental_ledger_preserves_execution_rate() {
        let fixture = SyntheticLedger::new(&[["4.2%", "浮动", "", "90"]]);
        let mut book = Workbook::new();
        for (name, data) in [
            (
                "TB",
                vec![
                    vec!["编码", "科目", "借款", "期初贷", "期末贷"],
                    vec!["2001", "短期借款", "SYN-1", "1000000", "1000000"],
                ],
            ),
            (
                "JE",
                vec![
                    vec!["编码", "科目", "借款", "日期", "借方", "贷方"],
                    vec!["2001", "短期借款", "SYN-1", "2025-01-01", "0", "0"],
                ],
            ),
        ] {
            let sheet = book.add_worksheet();
            sheet.set_name(name).unwrap();
            for (r, row) in data.iter().enumerate() {
                for (c, v) in row.iter().enumerate() {
                    sheet.write_string(r as u32, c as u16, *v).unwrap();
                }
            }
        }
        let path = fixture.dir.join("tbje.xlsx");
        book.save(&path).unwrap();
        let mut params = fixture.params();
        params["mode"] = json!("tb");
        params["rateLedgerSource"] = params["ledgerSource"].clone();
        params["tbSource"] = json!({"source":{"inputPath":path,"sheet":"TB","headerRow":1,"headerDepth":1},"mapping":{"accountCode":"编码","accountName":"科目","loanId":"借款","openingFunctionalCredit":"期初贷","closingFunctionalCredit":"期末贷"}});
        params["jeSource"] = json!({"source":{"inputPath":path,"sheet":"JE","headerRow":1,"headerDepth":1},"mapping":{"accountCode":"编码","accountName":"科目","loanId":"借款","date":"日期","functionalDebit":"借方","functionalCredit":"贷方"}});
        let result = run_preview(&params).unwrap();
        assert_eq!(result["rows"][0]["benchmarkRate"], Value::Null);
        assert!((result["rows"][0]["effectiveRate"].as_f64().unwrap() - 0.042).abs() < 1e-12);
        assert!(
            (result["rows"][0]["calculatedInterest"].as_f64().unwrap() - 42_000.0).abs() < 0.01
        );
    }
    #[test]
    fn floating_rate_converts_bps() {
        assert!(((0.035_f64 + 75.0 / 10000.0) - 0.0425).abs() < 1e-12)
    }
    #[test]
    fn frontend_and_backend_floating_words_stay_aligned() {
        for text in [
            "浮动",
            "浮息",
            "上浮15%",
            "下浮10%",
            "1Y-LPR+90BP",
            "按基准利率执行",
            "挂钩利率",
            "随行就市",
            "重定价",
            "可变利率",
            "Floating",
            "Variable",
        ] {
            assert_eq!(rate_type_fn(text), "floating", "未识别浮动字样：{text}");
        }
        for text in ["", "固定", "面议", "3.85%"] {
            assert_eq!(rate_type_fn(text), "fixed", "误判固定字样：{text}");
        }
    }
    #[test]
    fn percent_normalization() {
        assert_eq!(normalize_rate(4.2), 0.042);
        assert_eq!(parse_num("4.2%"), 0.042)
    }

    /// 测试集驱动入口：返回测试集目录（9 份借款台账 + 3 份子代理标准答案）。
    pub(crate) fn testset_dir() -> std::path::PathBuf {
        std::env::var_os("AUDIT_LOAN_TESTSET_DIR")
            .map(PathBuf::from)
            .expect("仅手工样例验收需要设置 AUDIT_LOAN_TESTSET_DIR；不要将客户样例提交仓库")
    }
    pub(crate) fn ledger_files() -> Vec<std::path::PathBuf> {
        let mut files: Vec<_> = std::fs::read_dir(testset_dir())
            .expect("读取测试集目录失败")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.extension().and_then(|x| x.to_str()) == Some("xlsx")
                    && p.file_name()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| !x.starts_with('~'))
            })
            .collect();
        files.sort();
        files
    }
    pub(crate) fn inspect_params(path: &Path, header_row: usize) -> Value {
        json!({
            "kind": "ledger",
            "source": {
                "inputPath": path.to_string_lossy(),
                "sheet": "",
                "headerRow": header_row,
                "headerDepth": 1,
            }
        })
    }
    pub(crate) fn preview_params(path: &Path, header_row: usize, mapping: Value) -> Value {
        json!({
            "mode": "ledger",
            "reportStart": "2025-01-01",
            "reportEnd": "2025-12-31",
            "ledgerSource": {
                "source": {
                    "inputPath": path.to_string_lossy(),
                    "sheet": "",
                    "headerRow": header_row,
                    "headerDepth": 1,
                },
                "mapping": mapping,
            }
        })
    }
    /// 与 run_job("loan.preview") 逐行等价的核心路径（省去进度/取消包装）。
    pub(crate) fn run_preview(params: &Value) -> Result<Value, AppError> {
        let mut rows = calculate(params)?;
        apply_overrides(&mut rows, params);
        calculate_interest(&mut rows, params)?;
        let total: f64 = rows.iter().map(|r| r.calculated_interest).sum();
        let review = rows.iter().filter(|r| r.match_status != "已匹配").count();
        Ok(json!({
            "rows": rows,
            "summary": {"loanCount": rows.len(), "calculatedInterest": total, "reviewCount": review}
        }))
    }

    /// 逐一 inspect 测试集 9 份台账，打印表头探测行与映射建议。
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_inspect_all() {
        for path in ledger_files() {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let result = inspect(&inspect_params(&path, 0));
            match result {
                Ok(v) => {
                    let header_row = v["headerRow"].as_u64().unwrap_or(0);
                    let suggested = v["suggestedMapping"].clone();
                    println!(
                        "[INSPECT] {} | headerRow={} | rowCount={} | suggested={}",
                        name,
                        header_row,
                        v["rowCount"].as_u64().unwrap_or(0),
                        suggested
                    );
                }
                Err(e) => println!("[INSPECT] {} | ERROR: {}", name, e.user_message),
            }
        }
    }

    /// 读子代理标准答案（利息测算 Excel 的「明细」sheet），返回 (公司 -> (笔数, 应计利息人民币元合计))。
    pub(crate) fn expected_by_company(
        file: &str,
    ) -> std::collections::BTreeMap<String, (usize, f64)> {
        let mut book = open_workbook_auto(testset_dir().join("利息测算").join(file)).unwrap();
        let range = book.worksheet_range("明细").unwrap();
        let mut map = std::collections::BTreeMap::new();
        for r in range.rows().skip(1) {
            let company = data_text(r.first().unwrap_or(&Data::Empty));
            if company.trim().is_empty() {
                continue;
            }
            let interest = r
                .get(13)
                .map(|v| data_text(v).parse::<f64>().unwrap_or(0.0))
                .unwrap_or(0.0);
            let e = map.entry(company).or_insert((0usize, 0.0));
            e.0 += 1;
            e.1 += interest;
        }
        map
    }
    /// 标准答案明细按公司展开：(合同编号, 应计利息人民币元, 币种)。
    pub(crate) fn expected_rows(file: &str, company_kw: &str) -> Vec<(String, f64, String)> {
        let mut book = open_workbook_auto(testset_dir().join("利息测算").join(file)).unwrap();
        let range = book.worksheet_range("明细").unwrap();
        range
            .rows()
            .skip(1)
            .filter(|r| data_text(r.first().unwrap_or(&Data::Empty)).contains(company_kw))
            .filter_map(|r| {
                let id = data_text(r.get(1).unwrap_or(&Data::Empty));
                if id.trim().is_empty() {
                    return None;
                }
                Some((
                    id,
                    r.get(13)
                        .map(|v| data_text(v).parse::<f64>().unwrap_or(0.0))
                        .unwrap_or(0.0),
                    r.get(5)
                        .map(|v| data_text(v).trim().to_string())
                        .unwrap_or_default(),
                ))
            })
            .collect()
    }

    /// 通用对比：跑第 idx 份台账全流程，与标准答案（按公司关键字过滤）对齐。
    /// unit_to_cny：台账金额单位换算到元的系数（元=1，万元=10000，千元=1000）。
    /// fx_by_id：按编号关键字指定的人民币汇率；fx_by_currency：按标准答案币种（USD/HKD等）指定的汇率。
    /// 工具输出原币，标准答案是人民币，比较时对工具值乘汇率。
    pub(crate) fn compare_ledger(
        idx: usize,
        answer_file: &str,
        company_kw: &str,
        unit_to_cny: f64,
        fx_by_id: &[(&str, f64)],
        fx_by_currency: &[(&str, f64)],
    ) {
        let path = &ledger_files()[idx];
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let insp = inspect(&inspect_params(path, 0)).expect("inspect 失败");
        let header_row = insp["headerRow"].as_u64().unwrap_or(1) as usize;
        let result = run_preview(&preview_params(
            path,
            header_row,
            insp["suggestedMapping"].clone(),
        ))
        .expect("preview 失败");
        let tool_rows: Vec<(String, f64)> = result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["loanId"].as_str().unwrap_or("").trim().to_string(),
                    r["calculatedInterest"].as_f64().unwrap_or(0.0),
                )
            })
            .collect();
        let short: String = name.chars().take(10).collect();
        // 标准答案中同一编号拆成多段的（如展期/分段还款）聚合成一笔再比
        let expected: Vec<(String, f64, String)> = {
            let raw = expected_rows(answer_file, company_kw);
            let mut agg: Vec<(String, f64, String)> = Vec::new();
            for (id, v, cur) in raw {
                if let Some(e) = agg.iter_mut().find(|(k, _, _)| k == &id) {
                    e.1 += v;
                } else {
                    agg.push((id, v, cur));
                }
            }
            agg
        };
        let exp_total: f64 = expected.iter().map(|(_, v, _)| v).sum();
        // 第一轮：编号匹配（双向 contains，短编号只允许全等，防止“—”误配）
        let mut tool_used = vec![false; tool_rows.len()];
        let mut tool_of: Vec<Option<usize>> = vec![None; expected.len()];
        for (i, (id, _, _)) in expected.iter().enumerate() {
            for (j, (t, _)) in tool_rows.iter().enumerate() {
                if tool_used[j] || t.is_empty() {
                    continue;
                }
                let same = t == id.trim();
                let fuzzy = id.chars().count() >= 4
                    && t.chars().count() >= 4
                    && (id.contains(t.as_str()) || t.contains(id.trim()));
                if same || fuzzy {
                    tool_of[i] = Some(j);
                    tool_used[j] = true;
                    break;
                }
            }
        }
        // 第二轮：仍未对上的按行序兜底（无编号列的台账，两侧行序即台账行序）
        let leftovers: Vec<usize> = (0..tool_rows.len()).filter(|j| !tool_used[*j]).collect();
        let mut cursor = 0usize;
        for (i, slot) in tool_of.iter_mut().enumerate() {
            if slot.is_none() && cursor < leftovers.len() {
                *slot = Some(leftovers[cursor]);
                tool_used[leftovers[cursor]] = true;
                cursor += 1;
                println!(
                    "  [按行序对齐] {} <- 工具行 {}",
                    expected[i].0,
                    tool_rows[leftovers[cursor - 1]].0
                );
            }
        }
        // 每笔标准答案的汇率：编号指定优先，其次币种，默认 1.0
        let fx_of: Vec<f64> = expected
            .iter()
            .map(|(id, _, cur)| {
                fx_by_id
                    .iter()
                    .find(|(k, _)| !id.is_empty() && (id.contains(k) || k.contains(id.trim())))
                    .map(|(_, f)| *f)
                    .unwrap_or_else(|| {
                        fx_by_currency
                            .iter()
                            .find(|(k, _)| cur.contains(k) || k.contains(cur.as_str()))
                            .map(|(_, f)| *f)
                            .unwrap_or(1.0)
                    })
            })
            .collect();
        // 工具合计：已配对行按各自汇率，未配对行按本位币
        let tool_total: f64 = fx_of
            .iter()
            .zip(expected.iter().zip(&tool_of))
            .map(|(fx, (_, slot))| match slot {
                Some(j) => tool_rows[*j].1 * unit_to_cny * fx,
                None => 0.0,
            })
            .sum::<f64>();
        let unjoined: f64 = tool_rows
            .iter()
            .enumerate()
            .filter(|(j, _)| !tool_used[*j])
            .map(|(_, (_, v))| v * unit_to_cny)
            .sum();
        println!(
            "[{}] {} | 工具 {} 笔, 合计 {:.2} 元",
            idx + 1,
            short,
            tool_rows.len(),
            tool_total + unjoined
        );
        for (i, (id, v, _)) in expected.iter().enumerate() {
            let fx = fx_of[i];
            match tool_of[i] {
                Some(j) => {
                    let tv = tool_rows[j].1 * unit_to_cny * fx;
                    if (tv - v).abs() > 0.05 {
                        println!("  [差异] {} 工具={:.2} 标准={:.2} (fx={fx})", id, tv, v)
                    }
                }
                None => println!("  [缺失] {} 标准={:.2} 工具无此笔", id, v),
            }
        }
        println!(
            "[{}] 标准答案 {} 笔 {:.2} 元 | 差异 {:+.2}",
            idx + 1,
            expected.len(),
            exp_total,
            tool_total + unjoined - exp_total
        );
    }

    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_01() {
        compare_ledger(
            0,
            "利息测算-第1组-华辰集团及中原恒泰.xlsx",
            "集团有限公司",
            1.0,
            &[],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_02() {
        compare_ledger(
            1,
            "利息测算-第1组-华辰集团及中原恒泰.xlsx",
            "子公司",
            10000.0,
            &[],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_03() {
        compare_ledger(
            2,
            "利息测算-第1组-华辰集团及中原恒泰.xlsx",
            "中原恒泰",
            10000.0,
            &[("ZGHT-2025-007", 7.10)],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_04() {
        compare_ledger(
            3,
            "利息测算-第2组-前湾供应链及润庭.xlsx",
            "前湾",
            1.0,
            &[("外汇借字", 7.0821)],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_05() {
        compare_ledger(
            4,
            "利息测算-第2组-前湾供应链及润庭.xlsx",
            "润庭",
            10000.0,
            &[],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_06() {
        compare_ledger(
            5,
            "利息测算-第2组-前湾供应链及润庭.xlsx",
            "宏运",
            10000.0,
            &[],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_07() {
        compare_ledger(
            6,
            "利息测算-第3组-星衡集团及湘中联合.xlsx",
            "借款合同台账",
            1.0,
            &[],
            &[
                ("USD", 7.10),
                ("HKD", 0.91),
                ("美元", 7.10),
                ("港币", 0.91),
                ("港元", 0.91),
            ],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_08() {
        compare_ledger(
            7,
            "利息测算-第3组-星衡集团及湘中联合.xlsx",
            "票据及短期融资",
            1000.0,
            &[],
            &[],
        );
    }
    #[test]
    #[ignore = "仅本机客户样例验收，需 AUDIT_LOAN_TESTSET_DIR；CI 使用合成台账"]
    fn harness_compare_09() {
        // 09 四段单位混杂（段1/4 万元、段2/3 元），先用 1.0 看量级，再按段核对
        compare_ledger(
            8,
            "利息测算-第3组-星衡集团及湘中联合.xlsx",
            "合并台账",
            1.0,
            &[],
            &[],
        );
    }

    fn je_table(headers: &[&str], row: &[&str]) -> Table {
        Table {
            path: PathBuf::new(),
            sheet: "Sheet1".into(),
            sheets: vec!["Sheet1".into()],
            header_row: 1,
            headers: headers.iter().map(|h| h.to_string()).collect(),
            rows: vec![row.iter().map(|v| v.to_string()).collect()],
        }
    }

    #[test]
    fn tbje模式按内核新名读科目与金额() {
        // 统一映射内核的建议是新角色名（accountCode／functionalDebit…），
        // TB＋JE 模式照建议映射后必须能读到科目文本与借贷金额——
        // 此前按旧名直查会得到空科目，整张 TB 一行都进不来。
        let table = je_table(
            &["科目编码", "科目名称", "借方金额", "贷方金额"],
            &["2202", "短期借款", "1000", "2000"],
        );
        let m: Map<String, Value> = [
            ("accountCode", "科目编码"),
            ("accountName", "科目名称"),
            ("functionalDebit", "借方金额"),
            ("functionalCredit", "贷方金额"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
        .collect();
        let row = &table.rows[0];
        assert_eq!(account_text(&table, row, &m, "je"), "2202 短期借款");
        assert_eq!(num_role(&table, row, &m, "je", "functionalDebit"), 1000.0);
        assert_eq!(num_role(&table, row, &m, "je", "functionalCredit"), 2000.0);
    }

    #[test]
    fn tbje模式贷方红字通过公共引擎归一() {
        let table = je_table(&["金额", "方向"], &["-500", "贷"]);
        let m: Map<String, Value> = [("functionalAmount", "金额"), ("direction", "方向")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
            .collect();
        let net = ledger_mapping::signed_amount(
            &je_amount_inputs(&table, &table.rows[0], &m),
            ledger_mapping::SignConvention::Unsigned,
        );
        assert_eq!(net, 500.0, "贷方红字应成为本金减少，不能取负绝对值");
    }

    #[test]
    fn tbje模式旧名映射仍然可读() {
        // 历史保存的映射把编码与名称混在一个 account 格子、金额用 debit/credit 旧名。
        let table = je_table(
            &["科目", "借方", "贷方"],
            &["2202 短期借款", "1000", "2000"],
        );
        let m: Map<String, Value> = [("account", "科目"), ("debit", "借方"), ("credit", "贷方")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
            .collect();
        let row = &table.rows[0];
        assert_eq!(account_text(&table, row, &m, "je"), "2202 短期借款");
        assert_eq!(num_role(&table, row, &m, "je", "functionalDebit"), 1000.0);
        assert_eq!(num_role(&table, row, &m, "je", "functionalCredit"), 2000.0);
    }
}
