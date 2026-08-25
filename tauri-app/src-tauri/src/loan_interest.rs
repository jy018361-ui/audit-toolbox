use crate::ledger_mapping;
use crate::{AppError, excel_merger::PauseCheckpoint};
use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Local, NaiveDate};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
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
    Ok(
        json!({"headers":table.headers,"preview":table.rows.iter().take(8).collect::<Vec<_>>(),"rowCount":table.rows.len(),"sheet":table.sheet,"sheets":table.sheets,"headerRow":table.header_row,"headerDepth":1,"suggestedMapping":suggested}),
    )
}

fn calculate(params: &Value) -> Result<Vec<LoanRow>, AppError> {
    if params.get("mode").and_then(Value::as_str) == Some("tb") {
        calculate_tb(params)
    } else {
        calculate_ledger(params)
    }
}
fn calculate_ledger(params: &Value) -> Result<Vec<LoanRow>, AppError> {
    let (table, mapping) = source(params, "ledgerSource")?;
    // 合同台账模式：一笔借款一行（本金、利率、起止日/期限）；
    // 否则回落到期初/新增/归还/期末的变动表模式。
    let contract_mode = mapping.contains_key("principal")
        && mapping.contains_key("rate")
        && mapping.contains_key("startDate")
        && (mapping.contains_key("endDate") || mapping.contains_key("term"));
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
            contract_rows(&seg_table, &seg_mapping, unit, n + 1, multi, &mut out);
        }
        if out.is_empty() {
            return Err(error("NO_LOANS", "未从借款台账识别到可测算的借款。", None));
        }
        return Ok(out);
    }
    let mut out = vec![];
    for row in &table.rows {
        let id = text(&table, row, &mapping, "loanId");
        if id.is_empty() {
            continue;
        }
        let opening = num(&table, row, &mapping, "openingPrincipal");
        let additions = num(&table, row, &mapping, "drawdownAmount");
        let reductions = num(&table, row, &mapping, "repaymentAmount");
        let closing = num(&table, row, &mapping, "closingPrincipal");
        let rate_type = rate_type(&text(&table, row, &mapping, "rateType"));
        let (fixed, benchmark, bps) = rates(&table, row, &mapping);
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
                format!("{}#{}", if lender.is_empty() { "借款" } else { &lender }, idx + 1)
            }
        };
        let principal = num(table, row, mapping, "principal");
        let rate_text = text(table, row, mapping, "rate");
        let type_text = text(table, row, mapping, "rateType");
        let (fixed, benchmark, bps) = rates(table, row, mapping);
        // 合同模式的 rate 角色即执行利率（数值列，6.5=6.5%），优先级低于显式 fixedRate 映射。
        let fixed = fixed.or_else(|| {
            (!rate_text.is_empty()).then(|| normalize_rate(parse_num(&rate_text)))
        });
        let start = row_date(table, row, mapping, "startDate");
        let end = row_date(table, row, mapping, "endDate").or_else(|| {
            let term = parse_term_months(&text(table, row, mapping, "term"));
            term.zip(start)
                .and_then(|(m, s)| s.checked_add_months(chrono::Months::new(m)))
                .map(|d| d.pred_opt().unwrap_or(d))
        });
        let outstanding = num(table, row, mapping, "outstanding");
        let repaid = num(table, row, mapping, "repaymentAmount");
        if principal == 0.0 {
            continue; // 金额为空的行（小计/备注行）不生成借款记录
        }
        // 期初余额列（变动表）优先作为年初占用本金；无该列时用合同本金
        let opening = {
            let op = num(table, row, mapping, "openingPrincipal");
            if op > 0.0 {
                op
            } else {
                principal
            }
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
            rate_type: if type_text.is_empty() {
                rate_type_fn(&rate_text)
            } else {
                rate_type_fn(&type_text)
            },
            fixed_rate: fixed,
            benchmark_rate: benchmark,
            spread_bps: bps,
            effective_rate: 0.0,
            calculated_interest: 0.0,
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
    let mut out = vec![];
    for row in &tb.rows {
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
            let debit = num_role(&je, jr, &jm, "je", "functionalDebit");
            let credit = num_role(&je, jr, &jm, "je", "functionalCredit");
            if debit != 0.0 || credit != 0.0 {
                reductions += debit.abs();
                additions += credit.abs();
                if let Some(value) = row_date(&je, jr, &jm, "date") {
                    if credit != 0.0 {
                        events.push((value, credit.abs()));
                    }
                    if debit != 0.0 {
                        events.push((value, -debit.abs()));
                    }
                }
            } else {
                let amount = num_role(&je, jr, &jm, "je", "functionalAmount");
                let direction = text(&je, jr, &jm, "direction");
                if direction.contains('借') || amount < 0.0 {
                    reductions += amount.abs();
                    if let Some(value) = row_date(&je, jr, &jm, "date") {
                        events.push((value, -amount.abs()));
                    }
                } else {
                    additions += amount.abs();
                    if let Some(value) = row_date(&je, jr, &jm, "date") {
                        events.push((value, amount.abs()));
                    }
                }
            }
        }
        if matched == 0 {
            additions = num_role(&tb, row, &tm, "tb", "ytdFunctionalCredit");
            reductions = num_role(&tb, row, &tm, "tb", "ytdFunctionalDebit")
        }
        let mut rate_type = "fixed".into();
        let (mut fixed, mut benchmark, mut bps) = (None, None, None);
        if let Some((rt, rm)) = &rate_source {
            if let Some(rr) = rt
                .rows
                .iter()
                .find(|rr| norm(&text(rt, rr, rm, "loanId")) == norm(&id))
            {
                rate_type = rate_type_fn(&text(rt, rr, rm, "rateType"));
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
            row.rate_type = rate_type_fn(t)
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
            for (p, f, t, year_end) in segs {
                let to_ex = if year_end {
                    t.succ_opt().unwrap_or(t)
                } else {
                    t
                };
                let d = (to_ex - f).num_days().max(0);
                interest += p * row.effective_rate * d as f64 / 365.0;
                days_total += d;
            }
            row.calculated_interest = interest;
            row.match_basis
                .push_str(&format!("；按合同期间计息{days_total}天/365"));
            // 存续但期末余额低于期初/合同额（年内归还、时点未列示）：提示结合备注复核
            if !settled
                && row.closing_principal > 0.0
                && row.closing_principal < row.opening_principal
            {
                row.match_basis.push_str(
                    "；年内有归还且时点未列示，按期末余额恒定测算，建议结合备注复核",
                );
            }
            continue;
        }
        if row.events.is_empty() {
            let average = (row.opening_principal + row.closing_principal) / 2.0;
            row.calculated_interest = average * row.effective_rate * days as f64 / 365.0;
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
                "借款利息审计测算_{}.xlsx",
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
    let headers = [
        "借款标识",
        "期初本金",
        "本期增加",
        "本期减少",
        "期末本金",
        "勾稽差异",
        "利率类型",
        "固定利率",
        "基准利率",
        "加/减点BP",
        "有效年利率",
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
        ws.write_string(y, 0, &row.loan_id).map_err(xlsx)?;
        for (c, n) in [
            row.opening_principal,
            row.additions,
            row.reductions,
            row.closing_principal,
            row.opening_principal + row.additions - row.reductions - row.closing_principal,
        ]
        .iter()
        .enumerate()
        {
            ws.write_number(y, (c + 1) as u16, *n).map_err(xlsx)?;
        }
        ws.write_string(
            y,
            6,
            if row.rate_type == "floating" {
                "浮动"
            } else {
                "固定"
            },
        )
        .map_err(xlsx)?;
        for (c, n) in [
            row.fixed_rate.unwrap_or(0.0),
            row.benchmark_rate.unwrap_or(0.0),
            row.spread_bps.unwrap_or(0.0),
            row.effective_rate,
            row.calculated_interest,
        ]
        .iter()
        .enumerate()
        {
            ws.write_number(y, (c + 7) as u16, *n).map_err(xlsx)?;
        }
        ws.write_string(y, 12, &row.match_status).map_err(xlsx)?;
        ws.write_string(y, 13, &row.match_basis).map_err(xlsx)?;
    }
    ws.autofit();
    wb.save(&path).map_err(xlsx)?;
    Ok(path)
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
    Ok((load(&spec, kind)?, mapping))
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
        let loan_id = ["辅助", "明细", "客户"].iter().find_map(|w| {
            headers.iter().find(|h| norm(h).contains(&norm(w)))
        });
        if let Some(h) = loan_id {
            out.insert("loanId".into(), Value::String(h.clone()));
        }
        return out;
    }
    let rules: &[(&str, &[&str])] = match kind {
        _ => &[
            ("loanId", &["合同编号", "借款编号", "借据", "登记编号", "合同号", "编号", "ref"]),
            ("lender", &["贷款银行", "贷款方", "债权人", "贷款人", "贷款机构", "金融机构", "交易对手", "承兑行", "银行", "lender"]),
            ("principal", &["借款本金", "借款金额", "放款金额", "已提款", "提款", "票面金额", "合同金额", "原币金额", "本金", "金额", "amount"]),
            ("startDate", &["借款起始日", "放款起始日", "放款日期", "放款日", "起息日", "起始日", "借款时间", "起租日", "借款日", "drawdown"]),
            ("endDate", &["到期日期", "贷款到期日", "到期日", "到期时间", "maturity"]),
            ("term", &["期限", "term"]),
            ("rate", &["执行利率", "折算年利率", "年利率", "固定利率", "贴现率", "利率", "利息", "rate"]),
            ("rateType", &["利率类型", "利率形式"]),
            ("benchmarkRate", &["基准利率", "lpr"]),
            ("spreadBps", &["加点", "bp"]),
            ("outstanding", &["未偿还本金", "未还余额", "期末余额", "贷款余额", "期末本金", "余额"]),
            ("openingPrincipal", &["期初本金", "期初余额", "年初余额"]),
            ("drawdownAmount", &["本期新增", "新增本金", "借款增加"]),
            ("drawdownDate", &["新增借款日期"]),
            ("repaymentAmount", &["本期归还", "还款本金", "本期减少", "归还", "已还"]),
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
fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // calamine 把真日期读成 "2023-01-10 00:00:00" 之类，取日期段。
    let head = s.split_whitespace().next().unwrap_or(s);
    for f in [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%d/%m/%Y",
        "%d-%b-%Y",
        "%Y%m%d",
    ] {
        if let Ok(d) = NaiveDate::parse_from_str(head, f) {
            return Some(d);
        }
    }
    if let Some(d) = parse_cn_date(s) {
        return Some(d);
    }
    // Excel 日期序列号（约 2009-2064 年）。
    if let Ok(n) = head.parse::<i64>() {
        if (40000..=60000).contains(&n) {
            return NaiveDate::from_ymd_opt(1899, 12, 30)
                .and_then(|b| b.checked_add_signed(chrono::Duration::days(n)));
        }
    }
    None
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
    let digits: String = t
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
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
        (!s.is_empty()).then(|| normalize_rate(parse_num(&s)))
    };
    (opt("fixedRate"), opt("benchmarkRate"), {
        let s = text(t, r, m, "spreadBps");
        (!s.is_empty()).then(|| parse_num(&s))
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
fn rate_type(s: &str) -> String {
    rate_type_fn(s)
}
fn rate_type_fn(s: &str) -> String {
    if s.to_lowercase().contains("float") || s.contains("浮动") || s.to_uppercase().contains("LPR")
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
    slot(m, kind, role)
        .and_then(Value::as_str)
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
    slot(m, kind, role)
        .and_then(Value::as_str)
        .and_then(|h| table.headers.iter().position(|x| x == h))
        .and_then(|i| row.get(i))
        .cloned()
        .unwrap_or_default()
        .trim()
        .to_string()
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
mod tests {
    use super::*;
    #[test]
    fn floating_rate_converts_bps() {
        assert!(((0.035_f64 + 75.0 / 10000.0) - 0.0425).abs() < 1e-12)
    }
    #[test]
    fn percent_normalization() {
        assert_eq!(normalize_rate(4.2), 0.042);
        assert_eq!(parse_num("4.2%"), 0.042)
    }

    /// 测试集驱动入口：返回测试集目录（9 份借款台账 + 3 份子代理标准答案）。
    pub(crate) fn testset_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(r"C:\Users\lenovo\借款合同台账测试集")
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
    pub(crate) fn expected_by_company(file: &str) -> std::collections::BTreeMap<String, (usize, f64)> {
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
            .filter(|r| {
                data_text(r.first().unwrap_or(&Data::Empty)).contains(company_kw)
            })
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
        let result = run_preview(&preview_params(path, header_row, insp["suggestedMapping"].clone()))
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
    fn harness_compare_01() {
        compare_ledger(0, "利息测算-第1组-华辰集团及中原恒泰.xlsx", "集团有限公司", 1.0, &[], &[]);
    }
    #[test]
    fn harness_compare_02() {
        compare_ledger(1, "利息测算-第1组-华辰集团及中原恒泰.xlsx", "子公司", 10000.0, &[], &[]);
    }
    #[test]
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
    fn harness_compare_05() {
        compare_ledger(4, "利息测算-第2组-前湾供应链及润庭.xlsx", "润庭", 10000.0, &[], &[]);
    }
    #[test]
    fn harness_compare_06() {
        compare_ledger(5, "利息测算-第2组-前湾供应链及润庭.xlsx", "宏运", 10000.0, &[], &[]);
    }
    #[test]
    fn harness_compare_07() {
        compare_ledger(
            6,
            "利息测算-第3组-星衡集团及湘中联合.xlsx",
            "借款合同台账",
            1.0,
            &[],
            &[("USD", 7.10), ("HKD", 0.91), ("美元", 7.10), ("港币", 0.91), ("港元", 0.91)],
        );
    }
    #[test]
    fn harness_compare_08() {
        compare_ledger(7, "利息测算-第3组-星衡集团及湘中联合.xlsx", "票据及短期融资", 1000.0, &[], &[]);
    }
    #[test]
    fn harness_compare_09() {
        // 09 四段单位混杂（段1/4 万元、段2/3 元），先用 1.0 看量级，再按段核对
        compare_ledger(8, "利息测算-第3组-星衡集团及湘中联合.xlsx", "合并台账", 1.0, &[], &[]);
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
    fn tbje模式旧名映射仍然可读() {
        // 历史保存的映射把编码与名称混在一个 account 格子、金额用 debit/credit 旧名。
        let table = je_table(&["科目", "借方", "贷方"], &["2202 短期借款", "1000", "2000"]);
        let m: Map<String, Value> = [
            ("account", "科目"),
            ("debit", "借方"),
            ("credit", "贷方"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
        .collect();
        let row = &table.rows[0];
        assert_eq!(account_text(&table, row, &m, "je"), "2202 短期借款");
        assert_eq!(num_role(&table, row, &m, "je", "functionalDebit"), 1000.0);
        assert_eq!(num_role(&table, row, &m, "je", "functionalCredit"), 2000.0);
    }
}
