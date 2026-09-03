//! 固定资产 TB+JE 变动表业务层。
//!
//! 文件读取、TB/JE 识别、字段角色、金额符号和 Net=0 匹配全部由
//! `fx` / `ledger_mapping` / `tabular` 公共内核提供；本模块只做固定资产科目
//! 分类、变动归属及底稿输出。

use chrono::{Datelike, NaiveDate};
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Formula, Workbook, Worksheet};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    fx::{FxTable, SourceSpec, load_fx_table, parse_date},
    ledger_mapping::{self, AmountInputs, SignConvention},
    tabular::{self, LedgerMapping},
};

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Assignment {
    #[serde(default)]
    entity: Option<String>,
    account: String,
    role: String,
    #[serde(default)]
    category: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Assigned {
    role: String,
    category: String,
}

#[derive(Default)]
struct AssignmentIndex {
    codes: HashMap<(String, String), Assigned>,
    names: HashMap<(String, String), Assigned>,
}

#[derive(Clone)]
struct AccountIdentity {
    entity: String,
    code: String,
    name: String,
    display: String,
    legacy_display: String,
}

#[derive(Clone, Debug)]
struct TbLine {
    entity: String,
    account: String,
    role: String,
    category: String,
    opening: f64,
    closing: f64,
    source_row: usize,
}

#[derive(Clone, Debug)]
struct JeLine {
    entity: String,
    voucher: String,
    /// 落表展示用的凭证号：只取凭证识别字段（如「记-0067」），不含主体与日期。
    /// `voucher` 仍是含主体/日期的完整分组键；清单公式靠「主体＋凭证键＋日期」三维保唯一。
    voucher_display: String,
    date: String,
    summary: String,
    account: String,
    role: String,
    category: String,
    net: f64,
    status: String,
    movement: String,
    /// 变动方式（购入／在建工程转入／出售…），由分类结果回填，供汇总表
    /// 方式子行的 SUMIFS 引用；对方科目行为空。
    method: String,
    counterpart: bool,
    raw: Vec<String>,
}

#[derive(Clone, Debug, Default)]
struct Movement {
    entity: String,
    voucher: String,
    date: String,
    summary: String,
    category: String,
    kind: String,
    original: f64,
    depreciation: f64,
    method: String,
    evidence: String,
    rule: String,
    review: String,
}

#[derive(Clone, Debug, Default)]
struct CategoryTotals {
    opening_cost: f64,
    closing_cost: f64,
    opening_dep: f64,
    closing_dep: f64,
    additions: f64,
    addition_dep: f64,
    disposals: f64,
    disposal_dep: f64,
    dep_charge: f64,
    dep_other_decrease: f64,
    reclass_cost: f64,
    reclass_dep: f64,
}

#[derive(Clone, Debug)]
struct Analysis {
    tb: Vec<TbLine>,
    je: Vec<JeLine>,
    je_headers: Vec<String>,
    additions: Vec<Movement>,
    disposals: Vec<Movement>,
    totals: BTreeMap<(String, String), CategoryTotals>,
    direct_pairs: usize,
    cross_pairs: usize,
    sign_basis: String,
    warnings: Vec<String>,
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    if !matches!(method, "fa.tbje_preview" | "fa.tbje_export") {
        return Err(error(
            "METHOD_NOT_FOUND",
            "未找到固定资产 TB＋JE 任务。",
            Some(method.into()),
        ));
    }
    checkpoint(&cancel, pause)?;
    progress("read", 1, 4, "正在通过公共 TB/JE 引擎读取账表…");
    let analysis = analyze(&params, &cancel)?;
    checkpoint(&cancel, pause)?;
    progress("classify", 2, 4, "正在分类新增、处置、重分类及对方科目…");
    let mut result = preview_json(&analysis);
    if method == "fa.tbje_export" {
        progress("export", 3, 4, "正在生成五张固定资产底稿表…");
        let output = output_path(&params)?;
        write_workbook(&output, &analysis, &cancel)?;
        result["outputPaths"] = json!([output.to_string_lossy()]);
    }
    progress("completed", 4, 4, "固定资产 TB＋JE 处理完成");
    Ok(result)
}

fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()
}

fn analyze(params: &Value, cancel: &AtomicBool) -> Result<Analysis, AppError> {
    let tb_spec: SourceSpec = parse_param(params, "tbSource", "缺少 TB 数据源。")?;
    let je_spec: SourceSpec = parse_param(params, "jeSource", "缺少 JE 数据源。")?;
    let tb_map = mapping(params, "tbMapping");
    let je_map = mapping(params, "jeMapping");
    validate_required(&tb_map, &je_map)?;
    let tb = load_fx_table(&tb_spec)?;
    let raw_je = load_fx_table(&je_spec)?;
    let tb_keep = ledger_mapping::tb_leaf_mask(&tb.headers, &tb.rows, &|role| {
        crate::fx::mapped_cols(&tb_map, role)
    });
    crate::fx::validate_mapped_amount_values(&tb, &tb_map, "tb", "TB", Some(&tb_keep))?;
    let je_keep = ledger_mapping::ledger_junk_mask(&raw_je.headers, &raw_je.rows, &|role| {
        crate::fx::mapped_cols(&je_map, role)
    });
    crate::fx::validate_mapped_amount_values(&raw_je, &je_map, "je", "JE", Some(&je_keep))?;
    let je = crate::fx::forward_filled_je_table(&raw_je, &je_map);
    for (kind, table, map) in [("TB", &tb, &tb_map), ("JE", &je, &je_map)] {
        for role in map.keys() {
            if mapped_columns(map, role)
                .iter()
                .any(|column| ledger_mapping::header_index(&table.headers, column).is_none())
            {
                return Err(error(
                    "FA_TBJE_MAPPING_STALE",
                    format!("{kind} 映射列已不在当前文件中，请返回字段映射区重新确认。"),
                    None,
                ));
            }
        }
    }
    let assignments = assignment_index(params, &tb, &tb_map, &je, &je_map)?;
    if assignments.codes.is_empty() && assignments.names.is_empty() {
        return Err(error(
            "FA_TBJE_ACCOUNTS_REQUIRED",
            "请至少确认一个固定资产原值或累计折旧科目。",
            None,
        ));
    }
    let report_end = NaiveDate::parse_from_str(
        params
            .get("reportEnd")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "%Y-%m-%d",
    )
    .map_err(|_| error("INVALID_DATE", "报告截止日必须为 YYYY-MM-DD。", None))?;
    let tb_lines = normalize_tb(&tb, &tb_map, &assignments, params)?;
    if tb_lines.is_empty() {
        return Err(error(
            "FA_TBJE_NO_TB_ACCOUNTS",
            "TB 中没有命中已确认的固定资产末级科目。",
            None,
        ));
    }
    let (mut je_lines, direct_pairs, cross_pairs, sign_basis) =
        normalize_je(&je, &je_map, &assignments, params, report_end, cancel)?;
    let (additions, disposals, mut totals) = classify_movements(&mut je_lines);
    let mut warnings = Vec::new();
    let tb_accounts = account_identities(&tb, &tb_map, params, "tbFixedEntity");
    for id in account_identities(&je, &je_map, params, "jeFixedEntity") {
        if find_assignment(&assignments, &id).is_some()
            && !tb_accounts.iter().any(|other| {
                other.entity == id.entity
                    && ((!id.code.is_empty() && other.code == id.code)
                        || (id.code.is_empty() || other.code.is_empty())
                            && ledger_mapping::normalize_name(&other.name)
                                == ledger_mapping::normalize_name(&id.name))
            })
        {
            let warning = format!(
                "主体 {} 的已确认科目 {} 仅存在于 JE，已保留变动；TB 期初/期末无对应科目，请复核勾稽差异。",
                id.entity, id.display
            );
            if !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }
    }
    for line in &tb_lines {
        let slot = totals
            .entry((line.entity.clone(), line.category.clone()))
            .or_default();
        if line.role == "cost" {
            slot.opening_cost += line.opening;
            slot.closing_cost += line.closing;
        } else if line.role == "depreciation" {
            slot.opening_dep += -line.opening;
            slot.closing_dep += -line.closing;
        }
    }
    Ok(Analysis {
        tb: tb_lines,
        je: je_lines,
        je_headers: je.headers.clone(),
        additions,
        disposals,
        totals,
        direct_pairs,
        cross_pairs,
        sign_basis,
        warnings,
    })
}

/// 必填口径走公共引擎：金标身份槽 ∪ 金额／余额形态槽（TB1–TB6／JE1–JE3）∪
/// `Tool::FaTbje` 自己声明的角色，三者取并集（[`ledger_mapping::missing_required`]），
/// 本模块不再自持一份规则。报错用标签版（`missing_required_labels`），
/// 把缺的角色逐个说给用户听。
fn validate_required(tb: &Map<String, Value>, je: &Map<String, Value>) -> Result<(), AppError> {
    for (kind, map, code, subject) in [
        ("tb", tb, "FA_TBJE_TB_MAPPING_INCOMPLETE", "TB"),
        ("je", je, "FA_TBJE_JE_MAPPING_INCOMPLETE", "JE"),
    ] {
        let missing = ledger_mapping::missing_required_labels(
            ledger_mapping::Tool::FaTbje,
            kind,
            &mapped_roles(kind, map),
        );
        if !missing.is_empty() {
            return Err(error(
                code,
                format!("{subject} 必填字段未映射：{}。", missing.join("、")),
                None,
            ));
        }
    }
    Ok(())
}

/// 把 TB／JE 映射翻译成引擎的标准角色集合（与 `tabular::mapped_roles` 同一职责）。
///
/// 唯一的本地归并在**科目身份槽**：本工具的科目键一直是「编码｜名称｜旧版混合列」
/// 三槽兜底（见 [`account_indexes`]），名称兜底是既定业务——编码缺失时靠名称做
/// 受唯一性校验的匹配（错误码 `FA_TBJE_ACCOUNT_NAME_UNVERIFIED`）。因此三者任一
/// 到位，就把金标的「科目编码」「科目名称」两个槽都视作已满足；金标槽缺谁报谁
/// 的其余判定（日期、凭证识别字段、摘要、期初／期末／金额形态）全部交给引擎。
fn mapped_roles(kind: &str, map: &Map<String, Value>) -> HashSet<&'static str> {
    let mut out: HashSet<&'static str> = ledger_mapping::roles(kind)
        .iter()
        .filter(|role| !mapped_columns(map, role.name).is_empty())
        .map(|role| role.name)
        .collect();
    if out.contains("accountCode")
        || out.contains("accountName")
        || !mapped_columns(map, "account").is_empty()
    {
        out.insert("accountCode");
        out.insert("accountName");
    }
    out
}

fn normalize_tb(
    table: &FxTable,
    map: &Map<String, Value>,
    assignments: &AssignmentIndex,
    params: &Value,
) -> Result<Vec<TbLine>, AppError> {
    let mask = ledger_mapping::tb_leaf_mask(&table.headers, &table.rows, &|role| {
        mapped_columns(map, role)
    });
    let evidence =
        ledger_mapping::detect_tb_sign_convention(&table.headers, &table.rows, &|role| {
            mapped_columns(map, role)
        });
    let convention = evidence.convention.unwrap_or(SignConvention::Unsigned);
    // 余额列是否整列自带符号，期初期末各判一次——两列的写法可以不一致。
    let self_signed = |prefix: &str| {
        ledger_mapping::balance_self_signed(
            &table.headers,
            &table.rows,
            &|role| mapped_columns(map, role),
            prefix,
        )
    };
    let (opening_self_signed, closing_self_signed) = (
        self_signed("openingFunctional"),
        self_signed("closingFunctional"),
    );
    let identities = account_identities(table, map, params, "tbFixedEntity");
    let mut out = Vec::new();
    for (index, row) in table.rows.iter().enumerate() {
        if !mask.get(index).copied().unwrap_or(true) {
            continue;
        }
        let identity = &identities[index];
        let Some(assigned) = find_assignment(assignments, identity) else {
            continue;
        };
        out.push(TbLine {
            entity: identity.entity.clone(),
            account: identity.display.clone(),
            role: assigned.role.clone(),
            category: category_of(assigned),
            opening: balance(
                table,
                row,
                map,
                "openingFunctional",
                convention,
                opening_self_signed,
            ),
            closing: balance(
                table,
                row,
                map,
                "closingFunctional",
                convention,
                closing_self_signed,
            ),
            source_row: table.header_row + index + 2,
        });
    }
    Ok(out)
}

/// 序时账实际覆盖的记账年度，用于把"期间选错了"讲清楚。
fn je_years(table: &FxTable, map: &Map<String, Value>) -> Vec<String> {
    table
        .rows
        .iter()
        .filter_map(|row| parse_date(&text(table, row, map, "date")))
        .map(|date| date.year())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|year| year.to_string())
        .collect()
}

fn normalize_je(
    table: &FxTable,
    map: &Map<String, Value>,
    assignments: &AssignmentIndex,
    params: &Value,
    end: NaiveDate,
    cancel: &AtomicBool,
) -> Result<(Vec<JeLine>, usize, usize, String), AppError> {
    // 期间过滤先于公共 Net=0 匹配，避免未来期间的冲销消掉报告期内变动。
    // 噪声行再先于期间过滤：SAP 的 ALV 分组小计、合计行下面的手工草稿都没有
    // 日期，眼下靠日期解析失败被顺带滤掉——那是副作用，不是判据。按公共引擎
    // 显式剔一次，日期口径将来怎么变都不会把它们放进来。
    let junk = ledger_mapping::ledger_junk_mask(&table.headers, &table.rows, &|role| {
        mapped_columns(map, role)
    });
    let start = NaiveDate::from_ymd_opt(end.year(), 1, 1).unwrap();
    let mut period_table = table.clone();
    period_table.rows = table
        .rows
        .iter()
        .enumerate()
        .filter(|(index, row)| {
            junk.get(*index).copied().unwrap_or(true)
                && parse_date(&text(table, row, map, "date"))
                    .is_some_and(|date| date >= start && date <= end)
        })
        .map(|(_, row)| row.clone())
        .collect();
    // 期间过滤把整本序时账滤空时必须当场报错。此前只是安静地往下走，
    // 导出的新增／处置／JE 明细全是空表，用户以为"JE 没匹配上"，
    // 实际是报告截止日的年度和账套年度对不上。
    if period_table.rows.is_empty() && !table.rows.is_empty() {
        let years = je_years(table, map);
        let detail = if years.is_empty() {
            "序时账里没有能解析出来的记账日期。".to_owned()
        } else {
            format!("序时账的数据年度是 {} 年。", years.join("、"))
        };
        return Err(error(
            "FA_TBJE_PERIOD_EMPTY",
            format!(
                "报告期间 {start} 至 {end} 内没有任何序时账凭证，无法生成底稿。{detail}请把报告截止日改到账套所属年度后重试。"
            ),
            None,
        ));
    }
    let table = &period_table;
    let ledger = ledger_mapping_for(map);
    let (voucher_keys, accounts) = tabular::ledger_row_keys(&table.rows, &table.headers, &ledger);
    let identities = account_identities(table, map, params, "jeFixedEntity");
    let target_accounts = identities
        .iter()
        .filter(|identity| find_assignment(assignments, identity).is_some())
        .map(|identity| identity.display.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let net_zero = tabular::net_zero_view(
        &table.rows,
        &table.headers,
        &ledger,
        &target_accounts,
        cancel,
    )?;
    let dates = table
        .rows
        .iter()
        .map(|row| text(table, row, map, "date"))
        .collect::<Vec<_>>();
    let wanted = table
        .rows
        .iter()
        .enumerate()
        .filter_map(|(i, _)| {
            let date = parse_date(&dates[i])?;
            (date >= start && date <= end && find_assignment(assignments, &identities[i]).is_some())
                .then(|| voucher_keys[i].clone())
        })
        .collect::<HashSet<_>>();
    let mut out = Vec::new();
    for (i, row) in table.rows.iter().enumerate() {
        if i % 4096 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        if !wanted.contains(&voucher_keys[i]) {
            continue;
        }
        let assigned = find_assignment(assignments, &identities[i]);
        out.push(JeLine {
            entity: identities[i].entity.clone(),
            voucher: voucher_keys[i].clone(),
            voucher_display: voucher_display(table, row, map, &voucher_keys[i]),
            date: dates[i].clone(),
            summary: text(table, row, map, "summary"),
            account: accounts[i].clone(),
            role: assigned.map(|a| a.role.clone()).unwrap_or_default(),
            category: assigned.map(category_of).unwrap_or_default(),
            net: net_zero.net[i],
            status: net_zero.status[i].clone(),
            movement: String::new(),
            method: String::new(),
            counterpart: assigned.is_none(),
            raw: row.clone(),
        });
    }
    Ok((
        out,
        net_zero.direct_pairs,
        net_zero.cross_pairs,
        net_zero.sign_basis,
    ))
}

fn classify_movements(
    lines: &mut [JeLine],
) -> (
    Vec<Movement>,
    Vec<Movement>,
    BTreeMap<(String, String), CategoryTotals>,
) {
    let mut vouchers = BTreeMap::<(String, String), Vec<usize>>::new();
    for (i, line) in lines.iter().enumerate() {
        vouchers
            .entry((line.entity.clone(), line.voucher.clone()))
            .or_default()
            .push(i);
    }
    let mut additions = Vec::new();
    let mut disposals = Vec::new();
    let mut totals = BTreeMap::<(String, String), CategoryTotals>::new();
    for ((entity, voucher), indexes) in vouchers {
        // 折旧的类别间调整按**行级等额配对**识别：凭证内借方折旧行与等额的贷方
        // 折旧行配成一对（如记-0059 的「折旧科目调整」借机械设备／贷工具仪器
        // 各 507550），配上的两侧进「重分类净额」与清单，配不上的行按方向走
        // 计提／其他减少。这样计提与调整混在同一张凭证也能完整拆开，重分类
        // 两侧永远等额、全表净额恒为 0。
        let mut dep_rows = indexes
            .iter()
            .copied()
            .filter(|&i| {
                let line = &lines[i];
                line.role == "depreciation"
                    && !line.counterpart
                    && !is_net_zero_matched(&line.status)
                    && line.net.abs() >= 0.005
            })
            .collect::<Vec<_>>();
        dep_rows.sort_by(|a, b| lines[*a].net.partial_cmp(&lines[*b].net).unwrap());
        let mut paired: Vec<(usize, usize)> = Vec::new();
        {
            // 升序排列后双指针找和为零的行对：left 指向最负（贷方转出侧的反向，
            // 即折旧增加），right-1 指向最正（借方，折旧减少）。
            let mut left = 0usize;
            let mut right = dep_rows.len();
            while left < right {
                if left == right - 1 {
                    break;
                }
                let sum = lines[dep_rows[left]].net + lines[dep_rows[right - 1]].net;
                if sum.abs() < 0.005 {
                    paired.push((dep_rows[right - 1], dep_rows[left])); // (借方行, 贷方行)
                    left += 1;
                    right -= 1;
                } else if sum < 0.0 {
                    left += 1;
                } else {
                    right -= 1;
                }
            }
        }
        let paired_rows = paired
            .iter()
            .flat_map(|(a, b)| [*a, *b])
            .collect::<HashSet<_>>();
        let mut cost = BTreeMap::<String, f64>::new();
        let mut dep = BTreeMap::<String, f64>::new();
        let voucher_nets = tabular::voucher_account_nets(
            &indexes.iter().map(|_| voucher.clone()).collect::<Vec<_>>(),
            &indexes
                .iter()
                .map(|i| lines[*i].account.clone())
                .collect::<Vec<_>>(),
            &indexes.iter().map(|i| lines[*i].net).collect::<Vec<_>>(),
        );
        let counterpart = voucher_nets
            .get(&voucher)
            .into_iter()
            .flat_map(|v| v.iter())
            .filter(|(account, _)| {
                !indexes
                    .iter()
                    .any(|i| lines[*i].account == **account && !lines[*i].counterpart)
            })
            .map(|(account, net)| (account.clone(), *net))
            .collect::<BTreeMap<_, _>>();
        for &i in &indexes {
            let line = &lines[i];
            if is_net_zero_matched(&line.status) || paired_rows.contains(&i) {
                continue;
            }
            match line.role.as_str() {
                "cost" => *cost.entry(line.category.clone()).or_default() += line.net,
                "depreciation" => *dep.entry(line.category.clone()).or_default() += line.net,
                _ => {}
            }
        }
        cost.retain(|_, amount| amount.abs() >= 0.005);
        let total_cost: f64 = cost.values().sum();
        let reclass = total_cost.abs() < 0.005
            && cost.values().any(|v| *v > 0.005)
            && cost.values().any(|v| *v < -0.005);
        let evidence = counterpart
            .iter()
            .filter(|(_, v)| v.abs() >= 0.005)
            .map(|(a, v)| format!("{a}：{v:.2}"))
            .collect::<Vec<_>>()
            .join("；");
        // 行级配对出的折旧类别间调整：两侧等额进「重分类净额」并生成清单行。
        // 转入（贷方、折旧调增）进新增清单，转出（借方、折旧调减）进处置清单，
        // 清单金额取绝对值；汇总表子行按转入为正、转出为负的净额口径呈现。
        // 标记先于下方 cost／dep 循环执行，`mark_indexes` 会跳过这些行不被
        // 新增／处置口径覆盖。
        for &(debit, credit) in &paired {
            let amount = lines[debit].net;
            let out_category = lines[debit].category.clone();
            let in_category = lines[credit].category.clone();
            for (category, delta) in [
                (out_category.clone(), -amount),
                (in_category.clone(), amount),
            ] {
                let key = if category.is_empty() {
                    "未归属".to_owned()
                } else {
                    category
                };
                totals
                    .entry((entity.clone(), key))
                    .or_default()
                    .reclass_dep += delta;
            }
            for i in [debit, credit] {
                lines[i].movement = "重分类".into();
                lines[i].method = "折旧类别间调整".into();
            }
            let in_key = if in_category.is_empty() {
                "未归属".to_owned()
            } else {
                in_category.clone()
            };
            let out_key = if out_category.is_empty() {
                "未归属".to_owned()
            } else {
                out_category.clone()
            };
            additions.push(Movement {
                entity: entity.clone(),
                voucher: lines[credit].voucher_display.clone(),
                date: lines[credit].date.clone(),
                summary: lines[credit].summary.clone(),
                category: in_key,
                kind: "重分类转入".into(),
                original: 0.0,
                depreciation: amount,
                method: "折旧类别间调整".into(),
                evidence: evidence.clone(),
                rule: "凭证内累计折旧等额对冲（行级配对）".into(),
                review: String::new(),
            });
            disposals.push(Movement {
                entity: entity.clone(),
                voucher: lines[debit].voucher_display.clone(),
                date: lines[debit].date.clone(),
                summary: lines[debit].summary.clone(),
                category: out_key,
                kind: "重分类转出".into(),
                original: 0.0,
                depreciation: amount,
                method: "折旧类别间调整".into(),
                evidence: evidence.clone(),
                rule: "凭证内累计折旧等额对冲（行级配对）".into(),
                review: String::new(),
            });
        }
        for (category, amount) in cost {
            let key = (
                entity.clone(),
                if category.is_empty() {
                    "未分类".into()
                } else {
                    category.clone()
                },
            );
            let slot = totals.entry(key.clone()).or_default();
            if reclass {
                // 原值类别间调整（借 A 类原值／贷 B 类原值，净额为零）原封不动：
                // 汇总表进「重分类净额」列，明细进新增／处置清单，两侧都逐笔可追溯。
                slot.reclass_cost += amount;
                let dep_amount = dep.remove(&category).unwrap_or(0.0);
                slot.reclass_dep += -dep_amount;
                mark_indexes(lines, &indexes, &category, "重分类", "原值类别间调整");
                let sample = reclass_sample(lines, &indexes, &category);
                let movement = Movement {
                    entity: entity.clone(),
                    voucher: sample.voucher_display.clone(),
                    date: sample.date.clone(),
                    summary: sample.summary.clone(),
                    category: key.1.clone(),
                    kind: if amount > 0.0 {
                        "重分类转入".into()
                    } else {
                        "重分类转出".into()
                    },
                    original: amount.abs(),
                    depreciation: if amount > 0.0 {
                        -dep_amount
                    } else {
                        dep_amount
                    },
                    method: "原值类别间调整".into(),
                    evidence: evidence.clone(),
                    rule: "凭证内原值类别间对冲，净额为零".into(),
                    review: String::new(),
                };
                if amount > 0.0 {
                    additions.push(movement);
                } else {
                    disposals.push(movement);
                }
                continue;
            }
            let dep_amount = dep.remove(&category).unwrap_or(0.0);
            let (method, rule, review) = classify_method(amount > 0.0, &counterpart);
            let sample = reclass_sample(lines, &indexes, &category);
            let movement = Movement {
                entity: entity.clone(),
                voucher: sample.voucher_display.clone(),
                date: sample.date.clone(),
                summary: sample.summary.clone(),
                category: key.1.clone(),
                kind: if amount > 0.0 {
                    "新增".into()
                } else {
                    "处置".into()
                },
                original: amount.abs(),
                depreciation: if amount > 0.0 {
                    -dep_amount
                } else {
                    dep_amount
                },
                method: method.clone(),
                evidence: evidence.clone(),
                rule,
                review,
            };
            if amount > 0.0 {
                slot.additions += amount;
                slot.addition_dep += -dep_amount;
                mark_indexes(lines, &indexes, &category, "新增", &method);
                additions.push(movement);
            } else {
                slot.disposals += -amount;
                slot.disposal_dep += dep_amount;
                mark_indexes(lines, &indexes, &category, "处置", &method);
                disposals.push(movement);
            }
        }
        // 纯折旧对冲判定见上方 dep_reclass 的定义处。
        for (category, amount) in dep {
            let category = if category.is_empty() {
                "未归属".to_owned()
            } else {
                category
            };
            let slot = totals
                .entry((entity.clone(), category.clone()))
                .or_default();
            if amount < 0.0 {
                slot.dep_charge += -amount;
                mark_indexes(lines, &indexes, &category, "本年计提/其他增加", "");
            } else {
                slot.dep_other_decrease += amount;
                mark_indexes(lines, &indexes, &category, "折旧其他减少", "");
            }
        }
        let kinds = indexes
            .iter()
            .filter_map(|i| {
                let line = &lines[*i];
                (!line.counterpart && !line.movement.is_empty()).then_some(line.movement.clone())
            })
            .collect::<BTreeSet<_>>();
        let counterpart_kind = if kinds.len() > 1 {
            "混合变动".into()
        } else {
            kinds
                .into_iter()
                .next()
                .unwrap_or_else(|| "Net=0冲销".into())
        };
        for &i in &indexes {
            if lines[i].counterpart {
                lines[i].movement = counterpart_kind.clone();
            }
        }
    }
    (additions, disposals, totals)
}

/// 重分类清单行的日期／摘要取该类别的第一行业务行；没有同类别行时退回凭证首行。
fn reclass_sample<'a>(lines: &'a [JeLine], indexes: &[usize], category: &str) -> &'a JeLine {
    indexes
        .iter()
        .map(|i| &lines[*i])
        .find(|l| !l.counterpart && l.category == category)
        .or_else(|| indexes.first().map(|i| &lines[*i]))
        .unwrap()
}

fn mark_indexes(
    lines: &mut [JeLine],
    indexes: &[usize],
    category: &str,
    movement: &str,
    method: &str,
) {
    for &i in indexes {
        if is_net_zero_matched(&lines[i].status) || paired_out(&lines[i]) {
            continue;
        }
        if !lines[i].counterpart && lines[i].category == category {
            lines[i].movement = movement.into();
            lines[i].method = method.into();
        }
    }
}

/// 行级配对出的折旧调整行不再参与类别级标记，避免被新增／处置口径覆盖。
fn paired_out(line: &JeLine) -> bool {
    line.movement == "重分类" && line.method == "折旧类别间调整"
}

/// 落表用的凭证号：优先只取凭证识别字段（映射的 id 列原文，如「记-0067」），
/// 不再拼主体与日期；识别字段为空时退回完整键并把内部连接符还原成「-」，
/// 避免控制字符落进 xlsx 变成 `_x001F_`。
fn voucher_display(table: &FxTable, row: &[String], map: &Map<String, Value>, key: &str) -> String {
    let id = indexes(table, map, "id")
        .iter()
        .filter_map(|i| row.get(*i))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if id.is_empty() {
        key.replace('\u{1f}', "-")
    } else {
        id
    }
}

fn is_net_zero_matched(status: &str) -> bool {
    matches!(
        status,
        "已匹配-计提" | "已匹配-冲销" | "跨行已匹配-计提" | "跨行已匹配-冲销"
    )
}

fn classify_method(addition: bool, accounts: &BTreeMap<String, f64>) -> (String, String, String) {
    let names = accounts
        .iter()
        .filter(|(_, amount)| {
            if addition {
                **amount < -0.005
            } else {
                **amount > 0.005
            }
        })
        .map(|(account, _)| account.clone())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let hit = |terms: &[&str]| {
        terms
            .iter()
            .any(|term| names.contains(&term.to_lowercase()))
    };
    // 编码前缀判定：不少账套的在建工程科目直接叫「工具仪器」「数据处理设备」
    // （挂在 1604 下），名称里没有「在建」二字；固定资产清理同理（1606）。
    // 国标编码前缀是比名称更稳的判据，两者取或。
    let code_prefix = |prefixes: &[&str]| {
        names.split_whitespace().any(|token| {
            token
                .split(['-', '_'])
                .any(|part| prefixes.iter().any(|prefix| part.starts_with(prefix)))
        })
    };
    let is_cip = code_prefix(&["1604", "1605"]) || hit(&["在建工程", "cip", "工程物资"]);
    let is_disposal_account =
        code_prefix(&["1606"]) || hit(&["固定资产清理"]);
    let (method, rule) = if addition {
        // 新增方式三分：在建工程转入／更新改造转入（对方为固定资产清理）／购入。
        // 固定资产科目之间的类别调整不走这里——凭证级净额对冲已按「重分类」
        // 单独列示，不会误进购入口径。
        if is_cip {
            ("在建工程转入", "对方科目命中在建工程/CIP/工程物资（编码或名称）")
        } else if is_disposal_account {
            ("更新改造转入", "对方科目命中固定资产清理（编码或名称）")
        } else {
            ("购入", "对方科目非在建工程/固定资产清理，按购入列示")
        }
    } else if hit(&["捐赠支出", "公益性捐赠"]) {
        ("对外捐赠", "对方科目命中捐赠支出")
    } else if hit(&[
        "银行存款",
        "库存现金",
        "应收账款",
        "其他应收款",
        "资产处置收益",
        "资产处置损益",
    ]) {
        ("出售", "对方科目命中收款或资产处置损益")
    } else if is_disposal_account || hit(&["营业外支出"]) {
        ("报废/毁损", "无收款科目且命中固定资产清理/营业外支出")
    } else {
        ("其他/待判断", "未命中处置方式确定性规则")
    };
    (
        method.into(),
        rule.into(),
        if method == "其他/待判断" {
            "需人工复核".into()
        } else {
            String::new()
        },
    )
}

fn preview_json(a: &Analysis) -> Value {
    let differences = a
        .totals
        .iter()
        .filter(|(_, t)| {
            ((t.opening_cost + t.additions - t.disposals + t.reclass_cost) - t.closing_cost).abs()
                >= 0.01
                || ((t.opening_dep + t.addition_dep + t.dep_charge
                    - t.disposal_dep
                    - t.dep_other_decrease
                    + t.reclass_dep)
                    - t.closing_dep)
                    .abs()
                    >= 0.01
        })
        .count();
    json!({
        "engine":"shared-ledger+fa-business", "tbRows":a.tb.len(), "jeRows":a.je.len(),
        "additions":a.additions.len(), "disposals":a.disposals.len(),
        "directNetZeroPairs":a.direct_pairs, "crossNetZeroPairs":a.cross_pairs,
        "reconciliationDifferences":differences, "signBasis":a.sign_basis,
        "warnings":a.warnings, "preview": a.additions.iter().take(10).map(|m| json!({
            "entity":m.entity,"voucher":m.voucher,"category":m.category,"kind":m.kind,
            "original":m.original,"depreciation":m.depreciation,"method":m.method
        })).collect::<Vec<_>>()
    })
}

fn write_workbook(path: &Path, a: &Analysis, cancel: &AtomicBool) -> Result<(), AppError> {
    let mut wb = Workbook::new();
    write_summary(wb.add_worksheet(), a)?;
    write_movements(wb.add_worksheet(), "新增清单", &a.additions, true)?;
    write_movements(wb.add_worksheet(), "处置清单", &a.disposals, false)?;
    write_je(wb.add_worksheet(), a, cancel)?;
    write_counterpart_pivots(&mut wb, a)?;
    write_tb_hidden(wb.add_worksheet(), a)?;
    wb.save(path).map_err(|e| {
        error(
            "FA_TBJE_EXPORT_FAILED",
            "固定资产 TB＋JE 底稿保存失败。",
            Some(e.to_string()),
        )
    })
}

fn formats() -> (Format, Format, Format) {
    (
        Format::new()
            .set_bold()
            .set_background_color("#E9EEF5")
            .set_border(FormatBorder::Thin),
        Format::new()
            .set_num_format("#,##0.00;[Red]-#,##0.00;-")
            .set_border(FormatBorder::Thin),
        // 文字单元格统一细边框，让整张表的数据区域连成完整表格。
        Format::new().set_border(FormatBorder::Thin),
    )
}

fn write_headers(ws: &mut Worksheet, headers: &[&str], header: &Format) -> Result<(), AppError> {
    for (c, value) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *value, header)
            .map_err(xlsx)?;
        ws.set_column_width(c as u16, if c < 2 { 18 } else { 16 })
            .map_err(xlsx)?;
    }
    ws.set_freeze_panes(1, 0).map_err(xlsx)?;
    Ok(())
}

/// FA List 版式的固定资产汇总变动表：资产类别做列、变动项目做行，A 列段名
/// （原值／累计折旧／净值）纵向合并，合计列写 `=SUM()` 活公式；新增／处置按
/// 方式以「——其中-」明细行展开，重分类拆转入／转出两侧，期初／期末后跟
/// 勾稽差异行（JE 推导 − TB 余额）。
/// FA List 版式的固定资产汇总变动表：资产类别做列、变动项目做行，A 列段名
/// （原值／累计折旧／净值）纵向合并，合计列写 `=SUM()` 活公式；新增／处置按
/// 方式以「——其中-」明细行展开，重分类拆转入（正）／转出（负）两侧。
/// 全部数据行都是活公式：期初／期末 SUMIFS 到隐藏 `_TB规范数据`，变动行
/// SUMIFS 到 JE 明细（主体＋类别＋变动分类＋［变动方式］＋角色），净值行做
/// 行引用；勾稽差异两行放在表体下方（原值／累计折旧），公式即勾稽等式。
fn sumifs_tb_formula(entity: &str, category: &str, role: &str, col: char) -> String {
    format!(
        "SUMIFS('_TB规范数据'!${col}:${col},'_TB规范数据'!$A:$A,\"{entity}\",'_TB规范数据'!$D:$D,\"{category}\",'_TB规范数据'!$C:$C,\"{role}\")"
    )
}

fn sumifs_je_formula(entity: &str, category: &str, role: &str, movement: &str) -> String {
    format!(
        "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,\"{entity}\",'固定资产相关JE完整明细'!$G:$G,\"{category}\",'固定资产相关JE完整明细'!$K:$K,\"{movement}\",'固定资产相关JE完整明细'!$F:$F,\"{role}\")"
    )
}

fn sumifs_je_method_formula(
    entity: &str,
    category: &str,
    role: &str,
    movement: &str,
    method: &str,
) -> String {
    format!(
        "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,\"{entity}\",'固定资产相关JE完整明细'!$G:$G,\"{category}\",'固定资产相关JE完整明细'!$K:$K,\"{movement}\",'固定资产相关JE完整明细'!$L:$L,\"{method}\",'固定资产相关JE完整明细'!$F:$F,\"{role}\")"
    )
}


fn summary_row_ref(lookup: &BTreeMap<(&'static str, String), u32>, section: &'static str, item: &str, col: char) -> Option<String> {
    lookup
        .get(&(section, item.to_owned()))
        .map(|row| format!("{col}{}", row + 1))
}

fn write_summary(ws: &mut Worksheet, a: &Analysis) -> Result<(), AppError> {
    ws.set_name("固定资产汇总变动表").map_err(xlsx)?;
    let (header, money, text) = formats();
    let entities: BTreeSet<&String> = a.totals.keys().map(|(entity, _)| entity).collect();
    let multi_entity = entities.len() > 1;
    let mut columns: Vec<String> = Vec::new();
    for (entity, category) in a.totals.keys() {
        columns.push(if multi_entity {
            format!("{entity}-{category}")
        } else {
            category.clone()
        });
    }
    let mut headers = vec![String::new(), "变动项目".to_owned(), "合计".to_owned()];
    headers.extend(columns.iter().cloned());
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, &header)
            .map_err(xlsx)?;
        ws.set_column_width(c as u16, if c == 0 { 14.0 } else if c == 1 { 30.0 } else { 16.0 })
            .map_err(xlsx)?;
    }
    for c in 0..headers.len() {
        ws.write_string_with_format(
            1,
            c as u16,
            match c {
                0 | 1 => "变动项目",
                2 => "计算",
                _ if multi_entity => "主体-资产类别",
                _ => "资产类别",
            },
            &text,
        )
        .map_err(xlsx)?;
    }
    // 方式明细按（主体，类别，方式）聚合；重分类转入／转出不算新增／处置
    // 方式，只在重分类段单独立行。
    let mut addition_by_method: BTreeMap<(String, String, String), f64> = BTreeMap::new();
    let mut disposal_by_method: BTreeMap<(String, String, String), f64> = BTreeMap::new();
    let mut disposal_dep_by_method: BTreeMap<(String, String, String), f64> = BTreeMap::new();
    for m in a.additions.iter().chain(&a.disposals) {
        let key = (m.entity.clone(), m.category.clone(), m.method.clone());
        match m.kind.as_str() {
            "新增" => *addition_by_method.entry(key).or_default() += m.original,
            "处置" => {
                *disposal_by_method.entry(key.clone()).or_default() += m.original;
                *disposal_dep_by_method.entry(key).or_default() += m.depreciation;
            }
            _ => {}
        }
    }
    let keys: Vec<(String, String)> = a.totals.keys().cloned().collect();
    let values = |f: &dyn Fn(&CategoryTotals) -> f64| -> Vec<f64> {
        keys.iter().map(|k| f(&a.totals[k])).collect()
    };
    let method_values =
        |map: &BTreeMap<(String, String, String), f64>, method: &str| -> Vec<f64> {
            keys.iter()
                .map(|k| {
                    *map.get(&(k.0.clone(), k.1.clone(), method.to_owned()))
                        .unwrap_or(&0.0)
                })
                .collect()
        };
    let reclass_cost_values = |positive: bool| -> Vec<f64> {
        keys.iter()
            .map(|k| {
                let net = a.totals[k].reclass_cost;
                if positive {
                    net.max(0.0)
                } else {
                    net.min(0.0)
                }
            })
            .collect()
    };
    let reclass_dep_values = |positive: bool| -> Vec<f64> {
        keys.iter()
            .map(|k| {
                let net = a.totals[k].reclass_dep;
                if positive {
                    net.max(0.0)
                } else {
                    net.min(0.0)
                }
            })
            .collect()
    };
    let addition_methods = addition_by_method
        .keys()
        .map(|k| k.2.clone())
        .collect::<BTreeSet<_>>();
    let disposal_methods = disposal_by_method
        .keys()
        .map(|k| k.2.clone())
        .collect::<BTreeSet<_>>();
    // 公式素材：TB 隐藏页（期初 F／期末 G，折旧余额已取反为正数）与 JE 明细
    // （H 净额、A 主体、G 类别、F 角色、K 变动分类、L 变动方式）。
    type Lookup = BTreeMap<(&'static str, String), u32>;
    // 行定义：values 是缓存值；formula 按列生成活公式（找不到被引用行时返回
    // 空串，该单元格退化为缓存数值）。
    struct RowDef {
        section: &'static str,
        item: String,
        keep_when_zero: bool,
        values: Vec<f64>,
        formula: Box<dyn Fn(&str, &str, char, &Lookup) -> String>,
    }
    let mut rows: Vec<RowDef> = Vec::new();
    let mut push = |section: &'static str,
                    item: String,
                    vals: Vec<f64>,
                    keep: bool,
                    formula: Box<dyn Fn(&str, &str, char, &Lookup) -> String>| {
        rows.push(RowDef {
            section,
            item,
            keep_when_zero: keep,
            values: vals,
            formula,
        });
    };
    let plain = |text: String| -> Box<dyn Fn(&str, &str, char, &Lookup) -> String> {
        Box::new(move |_, _, _, _| text.clone())
    };
    push(
        "原值",
        "期初原值".into(),
        values(&|t| t.opening_cost),
        true,
        Box::new(|e, c, _, _| sumifs_tb_formula(e, c, "cost", 'F')),
    );
    push(
        "原值",
        "原值增加".into(),
        values(&|t| t.additions),
        false,
        Box::new(|e, c, _, _| sumifs_je_formula(e, c, "cost", "新增")),
    );
    for method in &addition_methods {
        let m = method.clone();
        push(
            "原值",
            format!("——其中-{method}"),
            method_values(&addition_by_method, method),
            false,
            Box::new(move |e, c, _, _| sumifs_je_method_formula(e, c, "cost", "新增", &m)),
        );
    }
    push(
        "原值",
        "原值减少".into(),
        values(&|t| t.disposals),
        false,
        Box::new(|e, c, _, _| format!("-{}", sumifs_je_formula(e, c, "cost", "处置"))),
    );
    for method in &disposal_methods {
        let m = method.clone();
        push(
            "原值",
            format!("——其中-{method}"),
            method_values(&disposal_by_method, method),
            false,
            Box::new(move |e, c, _, _| {
                format!("-{}", sumifs_je_method_formula(e, c, "cost", "处置", &m))
            }),
        );
    }
    push(
        "原值",
        "原值重分类".into(),
        values(&|t| t.reclass_cost),
        false,
        Box::new(|e, c, _, _| sumifs_je_formula(e, c, "cost", "重分类")),
    );
    push(
        "原值",
        "——其中-重分类转入".into(),
        reclass_cost_values(true),
        false,
        Box::new(|e, c, _, _| {
            format!("MAX({},0)", sumifs_je_formula(e, c, "cost", "重分类"))
        }),
    );
    push(
        "原值",
        "——其中-重分类转出".into(),
        reclass_cost_values(false),
        false,
        Box::new(|e, c, _, _| {
            format!("MIN({},0)", sumifs_je_formula(e, c, "cost", "重分类"))
        }),
    );
    push(
        "原值",
        "期末原值".into(),
        values(&|t| t.closing_cost),
        true,
        Box::new(|e, c, _, _| sumifs_tb_formula(e, c, "cost", 'G')),
    );
    push(
        "累计折旧",
        "期初累计折旧".into(),
        values(&|t| t.opening_dep),
        true,
        Box::new(|e, c, _, _| sumifs_tb_formula(e, c, "depreciation", 'F')),
    );
    push(
        "累计折旧",
        "当期计提".into(),
        values(&|t| t.dep_charge + t.addition_dep),
        false,
        Box::new(|e, c, _, _| {
            format!(
                "-{}-{}",
                sumifs_je_formula(e, c, "depreciation", "新增"),
                sumifs_je_formula(e, c, "depreciation", "本年计提/其他增加")
            )
        }),
    );
    push(
        "累计折旧",
        "——其中-本年计提".into(),
        values(&|t| t.dep_charge),
        false,
        Box::new(|e, c, _, _| {
            format!(
                "-{}",
                sumifs_je_formula(e, c, "depreciation", "本年计提/其他增加")
            )
        }),
    );
    push(
        "累计折旧",
        "——其中-新增随转折旧".into(),
        values(&|t| t.addition_dep),
        false,
        Box::new(|e, c, _, _| format!("-{}", sumifs_je_formula(e, c, "depreciation", "新增"))),
    );
    push(
        "累计折旧",
        "处置减少".into(),
        values(&|t| t.disposal_dep + t.dep_other_decrease),
        false,
        Box::new(|e, c, _, _| {
            format!(
                "{}+{}",
                sumifs_je_formula(e, c, "depreciation", "处置"),
                sumifs_je_formula(e, c, "depreciation", "折旧其他减少")
            )
        }),
    );
    for method in &disposal_methods {
        let m = method.clone();
        push(
            "累计折旧",
            format!("——其中-{method}折旧"),
            method_values(&disposal_dep_by_method, method),
            false,
            Box::new(move |e, c, _, _| sumifs_je_method_formula(e, c, "depreciation", "处置", &m)),
        );
    }
    push(
        "累计折旧",
        "——其中-折旧其他减少".into(),
        values(&|t| t.dep_other_decrease),
        false,
        Box::new(|e, c, _, _| sumifs_je_formula(e, c, "depreciation", "折旧其他减少")),
    );
    push(
        "累计折旧",
        "累计折旧重分类".into(),
        values(&|t| t.reclass_dep),
        false,
        Box::new(|e, c, _, _| {
            format!("-{}", sumifs_je_formula(e, c, "depreciation", "重分类"))
        }),
    );
    push(
        "累计折旧",
        "——其中-重分类转入".into(),
        reclass_dep_values(true),
        false,
        Box::new(|e, c, _, _| {
            format!(
                "MAX(-{},0)",
                sumifs_je_formula(e, c, "depreciation", "重分类")
            )
        }),
    );
    push(
        "累计折旧",
        "——其中-重分类转出".into(),
        reclass_dep_values(false),
        false,
        Box::new(|e, c, _, _| {
            format!(
                "MIN(-{},0)",
                sumifs_je_formula(e, c, "depreciation", "重分类")
            )
        }),
    );
    push(
        "累计折旧",
        "期末累计折旧".into(),
        values(&|t| t.closing_dep),
        true,
        Box::new(|e, c, _, _| sumifs_tb_formula(e, c, "depreciation", 'G')),
    );
    // 净值段：行引用公式（期初原值行 − 期初折旧行）。
    push(
        "净值(NBV)",
        "年初余额".into(),
        values(&|t| t.opening_cost - t.opening_dep),
        true,
        Box::new(|_, _, col, lookup| {
            match (
                summary_row_ref(lookup, "原值", "期初原值", col),
                summary_row_ref(lookup, "累计折旧", "期初累计折旧", col),
            ) {
                (Some(a), Some(b)) => format!("{a}-{b}"),
                _ => String::new(),
            }
        }),
    );
    push(
        "净值(NBV)",
        "年末余额".into(),
        values(&|t| t.closing_cost - t.closing_dep),
        true,
        Box::new(|_, _, col, lookup| {
            match (
                summary_row_ref(lookup, "原值", "期末原值", col),
                summary_row_ref(lookup, "累计折旧", "期末累计折旧", col),
            ) {
                (Some(a), Some(b)) => format!("{a}-{b}"),
                _ => String::new(),
            }
        }),
    );
    // 勾稽差异放在表体下方独立两行：公式即勾稽等式，零值随公式实时呈现。
    push(
        "勾稽差异",
        "原值（期初＋增加－减少＋重分类－期末）".into(),
        values(&|t| {
            t.opening_cost + t.additions - t.disposals + t.reclass_cost - t.closing_cost
        }),
        true,
        Box::new(|_, _, col, lookup| {
            let parts = [
                ("原值", "期初原值", 1.0f64),
                ("原值", "原值增加", 1.0),
                ("原值", "原值减少", -1.0),
                ("原值", "原值重分类", 1.0),
                ("原值", "期末原值", -1.0),
            ];
            let mut formula = String::new();
            let mut complete = true;
            for (offset, (section, item, sign)) in parts.iter().enumerate() {
                match summary_row_ref(lookup, section, item, col) {
                    Some(reference) => {
                        if offset > 0 || *sign < 0.0 {
                            formula.push(if *sign > 0.0 { '+' } else { '-' });
                        }
                        formula.push_str(&reference);
                    }
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            if complete {
                formula
            } else {
                String::new()
            }
        }),
    );
    push(
        "勾稽差异",
        "累计折旧（期初＋计提－处置减少＋重分类－期末）".into(),
        values(&|t| {
            t.opening_dep + t.addition_dep + t.dep_charge - t.disposal_dep
                - t.dep_other_decrease
                + t.reclass_dep
                - t.closing_dep
        }),
        true,
        Box::new(|_, _, col, lookup| {
            let parts = [
                ("累计折旧", "期初累计折旧", 1.0f64),
                ("累计折旧", "当期计提", 1.0),
                ("累计折旧", "处置减少", -1.0),
                ("累计折旧", "累计折旧重分类", 1.0),
                ("累计折旧", "期末累计折旧", -1.0),
            ];
            let mut formula = String::new();
            let mut complete = true;
            for (offset, (section, item, sign)) in parts.iter().enumerate() {
                match summary_row_ref(lookup, section, item, col) {
                    Some(reference) => {
                        if offset > 0 || *sign < 0.0 {
                            formula.push(if *sign > 0.0 { '+' } else { '-' });
                        }
                        formula.push_str(&reference);
                    }
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            if complete {
                formula
            } else {
                String::new()
            }
        }),
    );
    // 过滤零行后分配行号并登记引用表，再统一写入。
    let visible: Vec<&RowDef> = rows
        .iter()
        .filter(|r| r.keep_when_zero || r.values.iter().any(|v| v.abs() > 0.005))
        .collect();
    let mut lookup: Lookup = BTreeMap::new();
    for (index, row) in visible.iter().enumerate() {
        lookup.insert((row.section, row.item.clone()), index as u32 + 2);
    }
    let section_format = header
        .clone()
        .set_align(FormatAlign::Left)
        .set_align(FormatAlign::VerticalCenter);
    let last_letter = col_letter(headers.len().saturating_sub(1));
    for (index, row) in visible.iter().enumerate() {
        let excel_row = index as u32 + 2;
        let excel = excel_row + 1;
        ws.write_string_with_format(excel_row, 1, &row.item, &text)
            .map_err(xlsx)?;
        let total: f64 = row.values.iter().sum();
        ws.write_formula_with_format(
            excel_row,
            2,
            Formula::new(format!("=SUM(D{excel}:{last_letter}{excel})"))
                .set_result(total.to_string()),
            &money,
        )
        .map_err(xlsx)?;
        for (c, value) in row.values.iter().enumerate() {
            let col = col_letter(3 + c);
            let formula = (row.formula)(&keys[c].0, &keys[c].1, col.chars().next().unwrap(), &lookup);
            if formula.is_empty() {
                ws.write_number_with_format(excel_row, (3 + c) as u16, *value, &money)
                    .map_err(xlsx)?;
            } else {
                ws.write_formula_with_format(
                    excel_row,
                    (3 + c) as u16,
                    Formula::new(formula).set_result(value.to_string()),
                    &money,
                )
                .map_err(xlsx)?;
            }
        }
    }
    let written: Vec<(u32, &'static str)> = visible
        .iter()
        .enumerate()
        .map(|(index, row)| (index as u32 + 2, row.section))
        .collect();
    let mut index = 0usize;
    while index < written.len() {
        let section = written[index].1;
        let mut end = index;
        while end + 1 < written.len() && written[end + 1].1 == section {
            end += 1;
        }
        let (first, last) = (written[index].0, written[end].0);
        if last > first {
            ws.merge_range(first, 0, last, 0, section, &section_format)
                .map_err(xlsx)?;
        } else {
            ws.write_string_with_format(first, 0, section, &section_format)
                .map_err(xlsx)?;
        }
        index = end + 1;
    }
    ws.set_freeze_panes(2, 2).map_err(xlsx)?;
    let note_row = written.len() as u32 + 3;
    let note_format = Format::new()
        .set_background_color("#F6F6F6")
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    ws.set_row_height(note_row - 1, 8).map_err(xlsx)?;
    ws.write_string_with_format(note_row, 0, "本表说明", &header)
        .map_err(xlsx)?;
    let note = "期初／期末取科目余额表已确认科目的余额，增加／减少／重分类取序时账逐凭证归集；数据行均为活公式（SUMIFS 至 TB 隐藏页／JE 明细），勾稽差异行零值表示 JE 与 TB 分毫勾稽。";
    if headers.len() >= 4 {
        ws.merge_range(note_row, 1, note_row, 3, note, &note_format)
            .map_err(xlsx)?;
    }
    ws.set_row_height(note_row, 72).map_err(xlsx)?;
    Ok(())
}

fn col_letter(mut index: usize) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    out
}

/// 原值／累计折旧各自的对方科目透视表：凭证里出现原值变动的，其对方科目
/// 进「原值透视表」；出现折旧变动的进「累计折旧透视表」。原值处置与折旧
/// 转出常常是同一张凭证的两面，这类凭证的对方科目两边都进，各自完整。
fn write_counterpart_pivots(wb: &mut Workbook, a: &Analysis) -> Result<(), AppError> {
    let mut voucher_flags: BTreeMap<(String, String), (bool, bool)> = BTreeMap::new();
    for line in &a.je {
        if line.counterpart || is_net_zero_matched(&line.status) {
            continue;
        }
        let flag = voucher_flags
            .entry((line.entity.clone(), line.voucher.clone()))
            .or_default();
        if line.role == "cost" {
            flag.0 = true;
        } else if line.role == "depreciation" {
            flag.1 = true;
        }
    }
    let mut cost_map: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    let mut dep_map: BTreeMap<String, (f64, f64)> = BTreeMap::new();
    for line in &a.je {
        if line.net.abs() < 0.005 {
            continue;
        }
        let Some((has_cost, has_dep)) = voucher_flags.get(&(line.entity.clone(), line.voucher.clone()))
        else {
            continue;
        };
        // 整张凭证的全部科目（含固定资产科目自身）都进透视：固定资产科目与
        // 对方科目互为镜像，两侧都在表内，借贷自然平衡；固定资产科目行的
        // 借贷差即本类变动额，与汇总表直接勾稽。
        let entry = |map: &mut BTreeMap<String, (f64, f64)>| {
            let entry = map.entry(line.account.clone()).or_default();
            if line.net > 0.0 {
                entry.0 += line.net;
            } else {
                entry.1 += -line.net;
            }
        };
        if *has_cost {
            entry(&mut cost_map);
        }
        if *has_dep {
            entry(&mut dep_map);
        }
    }
    write_pivot_sheet(wb.add_worksheet(), "原值透视表", &cost_map)?;
    write_pivot_sheet(wb.add_worksheet(), "累计折旧透视表", &dep_map)?;
    Ok(())
}

fn write_pivot_sheet(
    ws: &mut Worksheet,
    name: &str,
    groups: &BTreeMap<String, (f64, f64)>,
) -> Result<(), AppError> {
    ws.set_name(name).map_err(xlsx)?;
    let (header, money, text) = formats();
    write_headers(ws, &["科目", "借方金额", "贷方金额"], &header)?;
    for (r, (account, (debit, credit))) in groups.iter().enumerate() {
        let row = r as u32 + 1;
        ws.write_string_with_format(row, 0, account, &text)
            .map_err(xlsx)?;
        ws.write_number_with_format(row, 1, *debit, &money)
            .map_err(xlsx)?;
        ws.write_number_with_format(row, 2, *credit, &money)
            .map_err(xlsx)?;
    }
    let total_row = groups.len() as u32 + 1;
    let excel = total_row + 1;
    let (debit, credit): (f64, f64) =
        groups.values().fold((0.0, 0.0), |acc, v| (acc.0 + v.0, acc.1 + v.1));
    ws.write_string_with_format(total_row, 0, "合计", &header)
        .map_err(xlsx)?;
    for (col, value) in [(1u16, debit), (2, credit)] {
        let letter = (b'A' + col as u8) as char;
        ws.write_formula_with_format(
            total_row,
            col,
            Formula::new(format!("=SUM({letter}2:{letter}{excel})")).set_result(value.to_string()),
            &money,
        )
        .map_err(xlsx)?;
    }
    Ok(())
}

/// 清单行的变动分类（JE 明细 K 列口径）：新增／处置照旧，重分类转入／转出
/// 都按「重分类」聚合，清单公式据此过滤 JE 明细。
fn movement_label(kind: &str) -> &'static str {
    if kind.starts_with("重分类") {
        "重分类"
    } else if kind == "处置" {
        "处置"
    } else {
        "新增"
    }
}

fn write_movements(
    ws: &mut Worksheet,
    name: &str,
    rows: &[Movement],
    addition: bool,
) -> Result<(), AppError> {
    ws.set_name(name).map_err(xlsx)?;
    let (header, money, text) = formats();
    write_headers(
        ws,
        &[
            "主体",
            "凭证键",
            "日期",
            "摘要",
            "资产类别",
            if addition {
                "新增原值"
            } else {
                "处置原值"
            },
            if addition {
                "新增折旧"
            } else {
                "处置折旧"
            },
            if addition {
                "新增方式"
            } else {
                "处置方式"
            },
            "对方科目及金额",
            "判断依据",
            "复核标记",
        ],
        &header,
    )?;
    for (r, m) in rows.iter().enumerate() {
        let row = r as u32 + 1;
        for (c, v) in [&m.entity, &m.voucher, &m.date, &m.summary, &m.category]
            .iter()
            .enumerate()
        {
            ws.write_string_with_format(row, c as u16, *v, &text)
                .map_err(xlsx)?;
        }
        // 凭证键列只显示凭证识别字段，同主体跨日同号凭证靠日期列区分，
        // SUMIFS 因此带上日期维度，保证逐行金额不被同号凭证合并。
        let movement = movement_label(&m.kind);
        let excel = row + 1;
        let base = format!(
            "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,A{excel},'固定资产相关JE完整明细'!$B:$B,B{excel},'固定资产相关JE完整明细'!$C:$C,C{excel},'固定资产相关JE完整明细'!$G:$G,E{excel},'固定资产相关JE完整明细'!$K:$K,\"{movement}\",'固定资产相关JE完整明细'!$F:$F,"
        );
        let cost = if addition {
            format!("{base}\"cost\")")
        } else {
            format!("-{base}\"cost\")")
        };
        let dep = if addition {
            format!("-{base}\"depreciation\")")
        } else {
            format!("{base}\"depreciation\")")
        };
        ws.write_formula_with_format(
            row,
            5,
            Formula::new(cost).set_result(m.original.to_string()),
            &money,
        )
        .map_err(xlsx)?;
        ws.write_formula_with_format(
            row,
            6,
            Formula::new(dep).set_result(m.depreciation.to_string()),
            &money,
        )
        .map_err(xlsx)?;
        for (c, v) in [
            (7, &m.method),
            (8, &m.evidence),
            (9, &m.rule),
            (10, &m.review),
        ] {
            ws.write_string_with_format(row, c, v, &text).map_err(xlsx)?;
        }
    }
    Ok(())
}

fn write_je(ws: &mut Worksheet, a: &Analysis, cancel: &AtomicBool) -> Result<(), AppError> {
    ws.set_name("固定资产相关JE完整明细").map_err(xlsx)?;
    let (header, money, text) = formats();
    let mut headers = vec![
        "主体",
        "凭证键",
        "日期",
        "摘要",
        "科目",
        "科目角色",
        "资产类别",
        "借正贷负净额",
        "绝对值",
        "智能匹配状态",
        "变动分类",
        "变动方式",
        "是否对方科目",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    headers.extend(a.je_headers.iter().map(|value| format!("原始_{value}")));
    let refs = headers.iter().map(String::as_str).collect::<Vec<_>>();
    write_headers(ws, &refs, &header)?;
    for (r, l) in a.je.iter().enumerate() {
        if r % 4096 == 0 && cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        let row = r as u32 + 1;
        for (c, v) in [
            &l.entity,
            &l.voucher_display,
            &l.date,
            &l.summary,
            &l.account,
            &l.role,
            &l.category,
        ]
        .iter()
        .enumerate()
        {
            ws.write_string_with_format(row, c as u16, *v, &text)
                .map_err(xlsx)?;
        }
        ws.write_number_with_format(row, 7, l.net, &money)
            .map_err(xlsx)?;
        ws.write_number_with_format(row, 8, l.net.abs(), &money)
            .map_err(xlsx)?;
        ws.write_string_with_format(row, 9, &l.status, &text).map_err(xlsx)?;
        ws.write_string_with_format(row, 10, &l.movement, &text).map_err(xlsx)?;
        ws.write_string_with_format(row, 11, &l.method, &text).map_err(xlsx)?;
        ws.write_string_with_format(row, 12, if l.counterpart { "是" } else { "否" }, &text)
            .map_err(xlsx)?;
        for (c, v) in l.raw.iter().enumerate() {
            ws.write_string_with_format(row, (13 + c) as u16, v, &text)
                .map_err(xlsx)?;
        }
    }
    Ok(())
}

fn write_tb_hidden(ws: &mut Worksheet, a: &Analysis) -> Result<(), AppError> {
    ws.set_name("_TB规范数据").map_err(xlsx)?;
    let (header, money, text) = formats();
    write_headers(
        ws,
        &[
            "主体",
            "科目",
            "角色",
            "资产类别",
            "源行号",
            "期初标准余额",
            "期末标准余额",
        ],
        &header,
    )?;
    for (r, l) in a.tb.iter().enumerate() {
        let row = r as u32 + 1;
        for (c, v) in [&l.entity, &l.account, &l.role, &l.category]
            .iter()
            .enumerate()
        {
            ws.write_string_with_format(row, c as u16, *v, &text)
                .map_err(xlsx)?;
        }
        ws.write_number_with_format(row, 4, l.source_row as f64, &text)
            .map_err(xlsx)?;
        ws.write_number_with_format(
            row,
            5,
            if l.role == "depreciation" {
                -l.opening
            } else {
                l.opening
            },
            &money,
        )
        .map_err(xlsx)?;
        ws.write_number_with_format(
            row,
            6,
            if l.role == "depreciation" {
                -l.closing
            } else {
                l.closing
            },
            &money,
        )
        .map_err(xlsx)?;
    }
    ws.set_hidden(true);
    Ok(())
}

fn balance(
    table: &FxTable,
    row: &[String],
    map: &Map<String, Value>,
    prefix: &str,
    convention: SignConvention,
    self_signed: bool,
) -> f64 {
    let debit = number(table, row, map, &format!("{prefix}Debit"));
    let credit = number(table, row, map, &format!("{prefix}Credit"));
    let amount = number(table, row, map, &format!("{prefix}Amount"));
    let direction = text(
        table,
        row,
        map,
        if prefix.starts_with("opening") {
            "openingDirection"
        } else {
            "closingDirection"
        },
    );
    // 余额列走 `signed_balance`：整列自带符号时并排的方向列是冗余标注，
    // 再按它翻一次号，负债与权益会整片变正。判定见 `balance_self_signed`。
    ledger_mapping::signed_balance(
        &AmountInputs {
            amount,
            debit,
            credit,
            direction: (!direction.is_empty()).then_some(direction),
        },
        convention,
        self_signed,
    )
}
fn ledger_mapping_for(map: &Map<String, Value>) -> LedgerMapping {
    LedgerMapping {
        id: mapped_columns(map, "id"),
        account_code: mapped_columns(map, "accountCode").first().cloned(),
        account_name: mapped_columns(map, "accountName"),
        legacy_account: mapped_columns(map, "account"),
        entity: mapped_columns(map, "entity").first().cloned(),
        date: mapped_columns(map, "date").first().cloned(),
        summary: mapped_columns(map, "summary").first().cloned(),
        amount: mapped_columns(map, "functionalAmount").first().cloned(),
        direction: mapped_columns(map, "direction").first().cloned(),
        debit: mapped_columns(map, "functionalDebit").first().cloned(),
        credit: mapped_columns(map, "functionalCredit").first().cloned(),
    }
}
fn account_identities(
    table: &FxTable,
    map: &Map<String, Value>,
    params: &Value,
    fixed_key: &str,
) -> Vec<AccountIdentity> {
    let (_, display) =
        tabular::ledger_row_keys(&table.rows, &table.headers, &ledger_mapping_for(map));
    let fixed = params
        .get(fixed_key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    table
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let entity = text(table, row, map, "entity");
            let raw_code = text(table, row, map, "accountCode");
            let mut name = join(row, &indexes(table, map, "accountName"));
            if name.is_empty() {
                name = join(row, &indexes(table, map, "account"));
            }
            // 编码与名称混写在一格：03 号样例整张表只有一列科目
            // （`1001010000:库存现金-人民币`），名称只能从编码那一格里取。
            // 08 号样例反过来——名称列写成 `10020101\银行存款\…`，编码在
            // 前面，得把它切掉，否则和序时账那侧的纯名称对不上。
            if name.is_empty() {
                name = ledger_mapping::account_name_of(&raw_code);
            } else {
                name = ledger_mapping::account_name_of(&name);
            }
            AccountIdentity {
                entity: if entity.is_empty() {
                    fixed.to_owned()
                } else {
                    entity
                },
                code: ledger_mapping::account_code_of(&raw_code),
                name,
                display: display[i].clone(),
                legacy_display: join(row, &account_indexes(table, map)),
            }
        })
        .collect()
}

fn assignment_index(
    params: &Value,
    tb: &FxTable,
    tb_map: &Map<String, Value>,
    je: &FxTable,
    je_map: &Map<String, Value>,
) -> Result<AssignmentIndex, AppError> {
    let rows: Vec<Assignment> = serde_json::from_value(
        params
            .get("accountAssignments")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| error("INVALID_PARAMS", "科目分类参数无效。", Some(e.to_string())))?;
    let tb_ids = account_identities(tb, tb_map, params, "tbFixedEntity");
    let je_ids = account_identities(je, je_map, params, "jeFixedEntity");
    let tuples = |ids: &[AccountIdentity]| {
        ids.iter()
            .map(|id| (id.entity.clone(), id.code.clone(), id.name.clone()))
            .collect::<Vec<_>>()
    };
    let valid_names =
        ledger_mapping::validated_account_name_keys(&tuples(&tb_ids), &tuples(&je_ids));
    let mut out = AssignmentIndex::default();
    for a in &rows {
        if !matches!(a.role.as_str(), "cost" | "depreciation") {
            continue;
        }
        let assigned = Assigned {
            role: a.role.clone(),
            category: category_of(&Assigned {
                role: a.role.clone(),
                category: a.category.clone(),
            }),
        };
        for id in tb_ids.iter().chain(&je_ids).filter(|id| {
            a.entity
                .as_ref()
                .is_none_or(|entity| entity.trim() == id.entity)
                && (norm(&a.account) == norm(&id.display)
                    || norm(&a.account) == norm(&id.legacy_display))
        }) {
            let name_key = (id.entity.clone(), ledger_mapping::normalize_name(&id.name));
            if id.code.is_empty() && !valid_names.contains(&name_key) {
                return Err(error(
                    "FA_TBJE_ACCOUNT_NAME_UNVERIFIED",
                    format!(
                        "主体 {} 的科目 {} 无编码，且公共引擎未能确认 TB/JE 名称唯一对应。请核对科目映射或补充编码。",
                        id.entity, id.display
                    ),
                    None,
                ));
            }
            if !id.code.is_empty() {
                insert_assignment(
                    &mut out.codes,
                    (
                        id.entity.clone(),
                        ledger_mapping::normalize_account_code(&id.code),
                    ),
                    &assigned,
                )?;
            }
            if valid_names.contains(&name_key) {
                insert_assignment(&mut out.names, name_key, &assigned)?;
            }
        }
    }
    Ok(out)
}

fn insert_assignment(
    map: &mut HashMap<(String, String), Assigned>,
    key: (String, String),
    value: &Assigned,
) -> Result<(), AppError> {
    if map.get(&key).is_some_and(|old| old != value) {
        return Err(error(
            "FA_TBJE_ACCOUNT_ASSIGNMENT_CONFLICT",
            format!(
                "主体 {} 的科目 {} 被分配了不同角色或类别，请在科目分类区统一确认。",
                key.0, key.1
            ),
            None,
        ));
    }
    map.insert(key, value.clone());
    Ok(())
}

fn find_assignment<'a>(map: &'a AssignmentIndex, id: &AccountIdentity) -> Option<&'a Assigned> {
    map.codes
        .get(&(
            id.entity.clone(),
            ledger_mapping::normalize_account_code(&id.code),
        ))
        .or_else(|| {
            map.names
                .get(&(id.entity.clone(), ledger_mapping::normalize_name(&id.name)))
        })
}
fn category_of(a: &Assigned) -> String {
    if a.category.trim().is_empty() {
        "未分类".into()
    } else {
        a.category.trim().into()
    }
}
fn norm(v: &str) -> String {
    v.chars()
        .filter(|c| !c.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}
fn mapping(params: &Value, key: &str) -> Map<String, Value> {
    params
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn mapped_columns(map: &Map<String, Value>, role: &str) -> Vec<String> {
    match map.get(role) {
        Some(Value::String(v)) if !v.trim().is_empty() => vec![v.clone()],
        Some(Value::Array(v)) => v
            .iter()
            .filter_map(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}
fn indexes(table: &FxTable, map: &Map<String, Value>, role: &str) -> Vec<usize> {
    mapped_columns(map, role)
        .iter()
        .filter_map(|v| ledger_mapping::header_index(&table.headers, v))
        .collect()
}
fn account_indexes(table: &FxTable, map: &Map<String, Value>) -> Vec<usize> {
    let mut v = indexes(table, map, "accountCode");
    v.extend(indexes(table, map, "accountName"));
    if v.is_empty() {
        v = indexes(table, map, "account");
    }
    v.sort_unstable();
    v.dedup();
    v
}
fn join(row: &[String], ix: &[usize]) -> String {
    ix.iter()
        .filter_map(|i| row.get(*i))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
fn text(table: &FxTable, row: &[String], map: &Map<String, Value>, role: &str) -> String {
    indexes(table, map, role)
        .first()
        .and_then(|i| row.get(*i))
        .map(|v| v.trim().to_owned())
        .unwrap_or_default()
}
fn number(table: &FxTable, row: &[String], map: &Map<String, Value>, role: &str) -> Option<f64> {
    // 金额读取走公共引擎的宽松口径：`%`／货币符号／括号负数先剥掉，尾部负号、
    // CR/DR、「借／贷」后缀由 `parse_amount` 认；读不出一律 `None`。余额槽位
    // `None` 即未映射，下游 `signed_balance` 按 0 兜底，与切换前的缺省语义一致。
    ledger_mapping::parse_amount_lenient(&text(table, row, map, role))
}
fn parse_param<T: for<'de> Deserialize<'de>>(
    params: &Value,
    key: &str,
    message: &str,
) -> Result<T, AppError> {
    serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|e| error("INVALID_PARAMS", message, Some(e.to_string())))
}
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
    error(
        "FA_TBJE_EXPORT_FAILED",
        "写入 Excel 底稿失败。",
        Some(e.to_string()),
    )
}
fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message.into(), false, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 存款入口仅测试还在借道（分类器/识别器的公共入口对照），业务代码已不再
    // 依赖它的解析实现。
    use crate::deposit_interest;
    use calamine::{DataType, Reader, open_workbook_auto};
    use std::io::Read;

    /// 本机 PBC 回归入口。夹具不进仓库，通过环境变量指向 TBJEPBC 目录。
    /// 跑法：$env:FA_TBJE_PBC_DIR='...\\TBJEPBC'; cargo test pbc10 -- --ignored --nocapture
    #[test]
    #[ignore = "requires the local TBJEPBC fixture directory"]
    fn pbc10_uses_the_public_classifier_and_mapping_engine() {
        let dir = PathBuf::from(std::env::var("FA_TBJE_PBC_DIR").expect("FA_TBJE_PBC_DIR"));
        for (name, expected) in [("10科目余额表.xlsx", "tb"), ("10序时账 (2).xlsx", "je")] {
            let path = dir.join(name);
            let classified = deposit_interest::call(
                "deposit.classify_source",
                json!({"source":{"inputPath":path}}),
            )
            .unwrap();
            assert_eq!(classified["kind"], expected, "{name}: {classified}");
            let inspected = deposit_interest::call(
                &format!("deposit.inspect_{expected}"),
                json!({"source":{
                    "inputPath":path,
                    "sheet":classified["sheet"],
                    "headerRow":classified["headerRow"],
                    "headerDepth":classified["headerDepth"]
                }}),
            )
            .unwrap();
            assert!(
                inspected["headers"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty())
            );
            if expected == "je" {
                assert_eq!(
                    inspected.pointer("/suggestedMapping/id"),
                    Some(&json!(["凭证字", "凭证号"])),
                    "公共引擎必须用凭证字＋凭证号组成完整凭证键"
                );
            }
        }
    }

    /// 本机真实样例回归入口：汇兑损益测试资料（科目余额表.xls ＋ 序时账-1.xlsx）。
    /// 跑法：$env:FA_TBJE_FX_DIR='...\汇兑损益测试资料';
    ///      cargo test fx_real_sample -- --ignored --nocapture
    /// 验收口径：16020002 机械设备折旧（TB 原值侧无同名类别）不再产生
    /// 「无法归属到原值类别」告警；1、2 月计提与 3 月调整全部落在底稿里。
    #[test]
    #[ignore = "requires the local 汇兑损益测试资料 directory"]
    fn fx_real_sample_keeps_adjustments_without_unassigned_warnings() {
        let dir = PathBuf::from(std::env::var("FA_TBJE_FX_DIR").expect("FA_TBJE_FX_DIR"));
        let mut params = json!({
            "tbSource":{"inputPath":dir.join("科目余额表.xls"),"headerRow":1,"headerDepth":1},
            "jeSource":{"inputPath":dir.join("序时账-1.xlsx"),"headerRow":1,"headerDepth":1},
            "tbMapping":{
                "accountCode":"科目编码","accountName":["科目名称"],
                "openingFunctionalDebit":"期初余额借方","openingFunctionalCredit":"期初余额贷方",
                "ytdFunctionalDebit":"本期发生借方","ytdFunctionalCredit":"本期发生贷方",
                "closingFunctionalDebit":"期末余额借方","closingFunctionalCredit":"期末余额贷方"
            },
            "jeMapping":{
                "date":"日期","id":["凭证号数"],"accountCode":"科目编码",
                "accountName":["科目名称"],"summary":"摘要",
                "functionalAmount":"金额","direction":"方向"
            },
            "reportEnd":"2024-12-31",
            "tbFixedEntity":"默认主体","jeFixedEntity":"默认主体"
        });
        let mut assignments = Vec::new();
        for (code, name) in [
            ("16010003", "工具仪器"),
            ("16010004", "数据处理设备"),
            ("16010005", "办公设备"),
            ("16010006", "运输工具"),
            ("16010007", "其他"),
        ] {
            assignments.push(json!({"account": format!("{code} {name}"), "role": "cost", "category": name}));
        }
        for (code, name) in [
            ("16020002", "机械设备"),
            ("16020003", "工具仪器"),
            ("16020004", "数据处理设备"),
            ("16020005", "办公设备"),
            ("16020006", "运输工具"),
            ("16020007", "其他"),
        ] {
            assignments.push(json!({"account": format!("{code} {name}"), "role": "depreciation", "category": name}));
        }
        params["accountAssignments"] = json!(assignments);
        let a = analyze(&params, &AtomicBool::new(false)).unwrap();
        // 记-0035 的对方是在建科目 16040002（名称就叫「工具仪器」），
        // 必须按编码前缀判成在建工程转入，而不是落进购入。
        let j35 = a
            .additions
            .iter()
            .find(|m| m.voucher == "记-0035" && m.category == "工具仪器")
            .expect("记-0035 新增行");
        assert_eq!(j35.method, "在建工程转入");
        assert!(
            a.additions
                .iter()
                .any(|m| m.method == "购入" && m.voucher != "记-0035"),
            "其余新增应全部按购入列示"
        );
        assert!(
            a.warnings.is_empty(),
            "不应再有无法归属告警：{:?}",
            a.warnings
        );
        let machinery = &a.totals[&(String::from("默认主体"), String::from("机械设备"))];
        assert_eq!(machinery.dep_charge, 82467.38); // 41233.69 × 2 个月计提
        assert_eq!(machinery.reclass_dep, -507550.0); // 3 月折旧科目调整
        // 记-0059 是计提与调整混在同一张凭证的混合凭证：按类别聚合原封落列
        // （工具仪器 549491.65 = 计提 41941.65 ＋ 调整 507550，不做拆分猜测），
        // 机械设备的调整转出侧单独成行。
        let adjust = a
            .additions
            .iter()
            .find(|m| m.voucher == "记-0059" && m.category == "工具仪器" && m.kind == "重分类转入")
            .expect("折旧调整转入清单行");
        assert_eq!(adjust.depreciation, 507550.0);
        let adjust_out = a
            .disposals
            .iter()
            .find(|m| m.category == "机械设备")
            .expect("折旧调整转出清单行");
        assert_eq!(adjust_out.depreciation, 507550.0);
        // 行级配对后，记-0059 里混着的 3 月计提不再被卷进重分类：
        // 工具仪器计提 41941.65 单独进「本年计提」。
        let machinery_dep = &a.totals[&(String::from("默认主体"), String::from("工具仪器"))];
        assert_eq!(machinery_dep.reclass_dep, 507550.0);
        // 全表重分类净额必须为 0（转入＝转出），这是类别间调整的定义。
        let reclass_net: f64 = a.totals.values().map(|t| t.reclass_dep + t.reclass_cost).sum();
        assert!(
            reclass_net.abs() < 0.01,
            "重分类净额应为 0，实际 {reclass_net}"
        );
        assert_eq!(preview_json(&a)["reconciliationDifferences"], 0);
        // 底稿默认留在资料目录里供人工复核版式，重复跑同名覆盖；
        // 文件正被 Excel 打开时退回带序号的文件名，不阻断回归。
        let cancel = AtomicBool::new(false);
        let preferred = dir.join("fa-tbje-回归底稿.xlsx");
        let out = if write_workbook(&preferred, &a, &cancel).is_ok() {
            preferred
        } else {
            let fallback = dir.join(format!("fa-tbje-回归底稿-{}.xlsx", uuid::Uuid::new_v4()));
            write_workbook(&fallback, &a, &cancel).unwrap();
            fallback
        };
        assert_export_caches(&out);
        println!("固定资产 TB＋JE 回归底稿：{}", out.display());
    }

    /// 记-0035 形态的更新改造凭证：借原值＋贷原值（净增）＋对方为 1604 在建
    /// 科目（名称就叫「工具仪器」，不含「在建」二字），必须按编码前缀判成
    /// 在建工程转入而不是购入。
    #[test]
    fn cip_counterpart_named_like_category_still_maps_to_cip_transfer() {
        let mut je = vec![
            je_line("A", "J35", "16010003-工具仪器", "cost", "工具仪器", 191150.38),
            je_line("A", "J35", "16010003-工具仪器", "cost", "工具仪器", -148672.56),
            je_line("A", "J35", "16040002-工具仪器", "", "", -191150.38),
            je_line("A", "J35", "16040002-工具仪器", "", "", 111504.36),
        ];
        let (additions, disposals, totals) = classify_movements(&mut je);
        assert_eq!(additions.len(), 1);
        assert_eq!(additions[0].method, "在建工程转入");
        assert!((additions[0].original - 42477.82).abs() < 0.005);
        assert!(disposals.is_empty());
        assert!((totals[&("A".into(), "工具仪器".into())].additions - 42477.82).abs() < 0.005);
    }

    fn fixture() -> (PathBuf, PathBuf, Value) {
        let dir = std::env::temp_dir().join(format!("fa-tbje-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let tb = dir.join("tb.csv");
        let je = dir.join("je.csv");
        std::fs::write(&tb, "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\nA,1601,机器设备,1000,500,200,1300\nA,1602,累计折旧,-200,50,100,-250\n").unwrap();
        std::fs::write(&je, "主体,日期,凭证号,科目编码,科目名称,摘要,借方,贷方\nA,2025-01-10,V1,1601,机器设备,购置,500,0\nA,2025-01-10,V1,2202,应付账款,购置,0,500\nA,2025-06-01,V2,1601,机器设备,处置,0,200\nA,2025-06-01,V2,1602,累计折旧,处置,50,0\nA,2025-06-01,V2,1002,银行存款,处置,150,0\nA,2025-12-31,V3,6602,折旧费,计提,100,0\nA,2025-12-31,V3,1602,累计折旧,计提,0,100\nA,2025-03-01,V4,1601,机器设备,冲销,30,0\nA,2025-03-01,V4,2202,应付账款,冲销,0,30\nA,2025-03-02,V5,1601,机器设备,冲销,0,30\nA,2025-03-02,V5,2202,应付账款,冲销,30,0\n").unwrap();
        let out = dir.join("result.xlsx");
        let params = json!({
            "tbSource":{"inputPath":tb,"headerRow":1,"headerDepth":1},
            "jeSource":{"inputPath":je,"headerRow":1,"headerDepth":1},
            "tbMapping":{"entity":"主体","accountCode":"科目编码","accountName":["科目名称"],"openingFunctionalAmount":"期初余额","ytdFunctionalDebit":"本年借方","ytdFunctionalCredit":"本年贷方","closingFunctionalAmount":"期末余额"},
            "jeMapping":{"entity":"主体","date":"日期","id":["凭证号"],"accountCode":"科目编码","accountName":["科目名称"],"summary":"摘要","functionalDebit":"借方","functionalCredit":"贷方"},
            "accountAssignments":[
                {"account":"1601 机器设备","role":"cost","category":"机器设备"},
                {"account":"1602 累计折旧","role":"depreciation","category":"机器设备"}
            ],
            "reportEnd":"2025-12-31","outputPath":out
        });
        (dir, out, params)
    }

    #[test]
    fn shared_engine_classifies_and_excludes_net_zero_pairs() {
        let (dir, _, params) = fixture();
        let analysis = analyze(&params, &AtomicBool::new(false)).unwrap();
        assert_eq!(analysis.additions.len(), 1);
        assert_eq!(analysis.disposals.len(), 1);
        assert_eq!(analysis.direct_pairs, 1);
        assert!(
            analysis
                .je
                .iter()
                .filter(|x| is_net_zero_matched(&x.status))
                .count()
                >= 2
        );
        let totals = &analysis.totals[&(String::from("A"), String::from("机器设备"))];
        assert_eq!(totals.additions, 500.0);
        assert_eq!(totals.disposals, 200.0);
        assert_eq!(totals.dep_charge, 100.0);

        let spec: SourceSpec = serde_json::from_value(params["jeSource"].clone()).unwrap();
        let table = load_fx_table(&spec).unwrap();
        let map = mapping(&params, "jeMapping");
        let ledger = ledger_mapping_for(&map);
        let (_, accounts) = tabular::ledger_row_keys(&table.rows, &table.headers, &ledger);
        let targets = accounts
            .into_iter()
            .filter(|account| account.starts_with("1601-") || account.starts_with("1602-"))
            .collect::<Vec<_>>();
        let common = tabular::net_zero_view(
            &table.rows,
            &table.headers,
            &ledger,
            &targets,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            analysis
                .je
                .iter()
                .map(|line| line.status.clone())
                .collect::<Vec<_>>(),
            common.status
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fa_frontend_classification_entry_is_the_shared_fx_engine() {
        let (dir, _, params) = fixture();
        let request = json!({"source": params["jeSource"].clone()});
        let through_existing_deposit_entry =
            deposit_interest::call("deposit.classify_source", request.clone()).unwrap();
        let direct_shared_engine = crate::fx::classify_source(&request).unwrap();
        assert_eq!(through_existing_deposit_entry, direct_shared_engine);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 报告期间与账套年度错位时当场报错而不是导出空表() {
        // 前端此前把报告截止日默认成"当前年 12-31"，账套只要不是本年度的，
        // 期间过滤会滤空整本序时账，导出的新增／处置／JE 明细全是空表。
        let (dir, _, mut params) = fixture();
        params["reportEnd"] = json!("2030-12-31");
        let err = analyze(&params, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "FA_TBJE_PERIOD_EMPTY");
        assert!(err.user_message.contains("2025"), "{}", err.user_message);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn export_has_five_visible_sheets_hidden_tb_and_formulas() {
        let (dir, out, params) = fixture();
        let analysis = analyze(&params, &AtomicBool::new(false)).unwrap();
        write_workbook(&out, &analysis, &AtomicBool::new(false)).unwrap();
        let mut book = open_workbook_auto(&out).unwrap();
        assert_eq!(
            book.sheet_names(),
            &[
                "固定资产汇总变动表",
                "新增清单",
                "处置清单",
                "固定资产相关JE完整明细",
                "原值透视表",
                "累计折旧透视表",
                "_TB规范数据"
            ]
        );
        // 汇总表是 FA List 版式：合计列 =SUM() 活公式，行数据为数值缓存。
        let formulas = book.worksheet_formula("固定资产汇总变动表").unwrap();
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().contains("SUM(D")),
            "合计列必须是跨类别列的活公式"
        );
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().contains("SUMIFS('_TB规范数据'")),
            "期初／期末必须活公式链到 TB 隐藏页"
        );
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().contains("SUMIFS('固定资产相关JE完整明细'")),
            "变动行必须活公式链到 JE 明细"
        );
        // 勾稽差异在表体下方的独立段，公式即勾稽等式。
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().replace("=", "").starts_with("D3")),
            "勾稽差异应为行引用公式"
        );
        // 清单金额公式仍引用 JE 明细，且按「主体＋凭证键＋日期＋类别＋变动分类＋角色」过滤。
        for name in ["新增清单", "处置清单"] {
            let sheet_formulas = book.worksheet_formula(name).unwrap();
            assert!(
                sheet_formulas
                    .rows()
                    .flatten()
                    .any(|v| v.to_string().contains("'固定资产相关JE完整明细'!$C:$C")),
                "{name} 公式必须带日期维度"
            );
        }
        // 凭证键列只显示凭证识别字段（本夹具即「V1」等凭证号原文），
        // 不再拼主体与日期，也不残留内部连接符。
        let voucher_col = analysis
            .je_headers
            .iter()
            .position(|h| h == "凭证号")
            .expect("夹具 JE 必须有凭证号列");
        let je_range = book.worksheet_range("固定资产相关JE完整明细").unwrap();
        let je_headers_row = je_range.rows().next().unwrap().to_vec();
        assert!(
            !je_headers_row
                .iter()
                .any(|v| v.to_string().contains("正负")),
            "JE 明细不应再有正负数标记列"
        );
        for row in je_range.rows().skip(1) {
            let voucher = row[1].to_string();
            assert!(!voucher.contains('\u{1f}'), "凭证键不应残留内部连接符：{voucher}");
            assert!(!voucher.contains("2025"), "凭证键不应拼入日期：{voucher}");
            assert_eq!(
                voucher,
                row[13 + voucher_col].to_string(),
                "凭证键应等于凭证识别字段原文"
            );
        }
        for name in book.sheet_names().to_vec() {
            let sheet_formulas = book.worksheet_formula(&name).unwrap();
            assert!(!sheet_formulas.rows().flatten().any(|value| {
                let text = value.to_string();
                ["#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?"]
                    .iter()
                    .any(|error| text.contains(error))
            }));
        }
        let file = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut workbook_xml = String::new();
        zip.by_name("xl/workbook.xml")
            .unwrap()
            .read_to_string(&mut workbook_xml)
            .unwrap();
        assert!(workbook_xml.contains("_TB规范数据") && workbook_xml.contains("state=\"hidden\""));
        assert!(workbook_xml.contains("fullCalcOnLoad=\"1\""));
        assert_eq!(workbook_xml.matches("state=\"hidden\"").count(), 1);
        assert_export_caches(&out);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 汇总表按 FA List 版式输出后，缓存值必须仍能对着两张源表独立勾稽：
    /// 期初／期末对照 `_TB规范数据`，增加／减少／重分类对照 JE 明细的
    /// （类别，角色，变动分类）净额；方式子行与主行、合计列与类别列自洽。
    fn assert_export_caches(path: &Path) {
        let mut book = open_workbook_auto(path).unwrap();
        let summary = book.worksheet_range("固定资产汇总变动表").unwrap();
        let je = book.worksheet_range("固定资产相关JE完整明细").unwrap();
        let tb = book.worksheet_range("_TB规范数据").unwrap();
        let s = |row: &[calamine::Data], col: usize| row[col].to_string();
        let n = |row: &[calamine::Data], col: usize| row[col].as_f64().unwrap_or(0.0);
        let header = summary.rows().next().unwrap().to_vec();
        let columns: Vec<String> = header
            .iter()
            .enumerate()
            .skip(3)
            .map(|(_, value)| value.to_string())
            .collect();
        // 行定位必须带段：原值段与折旧段各有「勾稽差异」与重分类转入／转出。
        let mut rows: Vec<(String, String, f64, Vec<f64>)> = Vec::new();
        let mut current_section = String::new();
        for row in summary.rows().skip(2) {
            if !s(row, 0).trim().is_empty() {
                current_section = s(row, 0);
            }
            let item = s(row, 1);
            if item.is_empty() || item == "本表说明" {
                continue;
            }
            let values: Vec<f64> = (3..header.len()).map(|c| n(row, c)).collect();
            rows.push((current_section.clone(), item, n(row, 2), values));
        }
        // 多主体时列标题是「主体-类别」，从 TB／JE 的（主体，类别）组合反解回来。
        let mut pairs: Vec<(String, String)> = Vec::new();
        let mut entities: Vec<String> = Vec::new();
        for (entity, category) in tb
            .rows()
            .skip(1)
            .map(|r| (s(r, 0), s(r, 3)))
            .chain(je.rows().skip(1).map(|r| (s(r, 0), s(r, 6))))
        {
            if !entity.is_empty() && !entities.contains(&entity) {
                entities.push(entity.clone());
            }
            if !category.is_empty() && !pairs.contains(&(entity.clone(), category.clone())) {
                pairs.push((entity.clone(), category.clone()));
            }
        }
        let multi_entity = entities.len() > 1;
        let resolve = |title: &str| -> (String, String) {
            pairs
                .iter()
                .find(|(entity, category)| {
                    if multi_entity {
                        format!("{entity}-{category}") == title
                    } else {
                        category == title
                    }
                })
                .cloned()
                .unwrap_or_else(|| (String::new(), title.to_owned()))
        };
        // TB 期初／期末（隐藏页按主体＋类别＋角色聚合；折旧余额已取反为正数）。
        let tb_sum = |entity: &str, category: &str, role: &str, col: usize| -> f64 {
            tb.rows()
                .skip(1)
                .filter(|r| s(r, 0) == entity && s(r, 3) == category && s(r, 2) == role)
                .map(|r| n(r, col))
                .sum::<f64>()
        };
        let je_sum = |entity: &str, category: &str, role: &str, movements: &[&str]| -> f64 {
            je.rows()
                .skip(1)
                .filter(|r| s(r, 0) == entity && s(r, 6) == category && s(r, 5) == role)
                .filter(|r| movements.contains(&s(r, 10).as_str()))
                .map(|r| n(r, 7))
                .sum::<f64>()
        };
        for (col, title) in columns.iter().enumerate() {
            let (entity, category) = resolve(title);
            let category = category.as_str();
            let entity = entity.as_str();
            let value = |section: &str, item: &str| -> f64 {
                rows.iter()
                    .find(|(sct, name, _, _)| sct == section && name == item)
                    .and_then(|(_, _, _, values)| values.get(col).copied())
                    .unwrap_or(0.0)
            };
            let derived_cost = tb_sum(entity, category, "cost", 5)
                + je_sum(entity, category, "cost", &["新增"])
                + je_sum(entity, category, "cost", &["处置"])
                + je_sum(entity, category, "cost", &["重分类"]);
            for (item, expected) in [
                ("期初原值", tb_sum(entity, category, "cost", 5)),
                ("原值增加", je_sum(entity, category, "cost", &["新增"])),
                ("原值减少", -je_sum(entity, category, "cost", &["处置"])),
                ("原值重分类", je_sum(entity, category, "cost", &["重分类"])),
                ("期末原值", tb_sum(entity, category, "cost", 6)),
                (
                    "——其中-重分类转入",
                    je_sum(entity, category, "cost", &["重分类"]).max(0.0),
                ),
                (
                    "——其中-重分类转出",
                    je_sum(entity, category, "cost", &["重分类"]).min(0.0),
                ),
            ] {
                assert!(
                    (value("原值", item) - expected).abs() < 0.00001,
                    "{title} 原值 {item} = {} != {expected}",
                    value("原值", item)
                );
            }
            let diff_row = rows
                .iter()
                .find(|(sct, name, _, _)| sct == "勾稽差异" && name.starts_with("原值"))
                .map(|(_, _, _, values)| values.get(col).copied().unwrap_or(0.0))
                .unwrap_or(0.0);
            assert!(
                (diff_row - (derived_cost - tb_sum(entity, category, "cost", 6))).abs() < 0.00001,
                "{title} 勾稽差异（原值）缓存与重算不符"
            );
            // 隐藏页的折旧期初／期末已取反为正数（贷方余额），直接相加。
            let derived_dep = tb_sum(entity, category, "depreciation", 5)
                - je_sum(entity, category, "depreciation", &["新增", "本年计提/其他增加"])
                - je_sum(entity, category, "depreciation", &["处置", "折旧其他减少"])
                - je_sum(entity, category, "depreciation", &["重分类"]);
            for (item, expected) in [
                ("期初累计折旧", tb_sum(entity, category, "depreciation", 5)),
                (
                    "当期计提",
                    -je_sum(
                        entity,
                        category,
                        "depreciation",
                        &["新增", "本年计提/其他增加"],
                    ),
                ),
                (
                    "——其中-本年计提",
                    -je_sum(entity, category, "depreciation", &["本年计提/其他增加"]),
                ),
                (
                    "——其中-新增随转折旧",
                    -je_sum(entity, category, "depreciation", &["新增"]),
                ),
                (
                    "处置减少",
                    je_sum(entity, category, "depreciation", &["处置", "折旧其他减少"]),
                ),
                (
                    "——其中-折旧其他减少",
                    je_sum(entity, category, "depreciation", &["折旧其他减少"]),
                ),
                (
                    "累计折旧重分类",
                    -je_sum(entity, category, "depreciation", &["重分类"]),
                ),
                ("期末累计折旧", tb_sum(entity, category, "depreciation", 6)),
            ] {
                assert!(
                    (value("累计折旧", item) - expected).abs() < 0.00001,
                    "{title} 折旧 {item} = {} != {expected}",
                    value("累计折旧", item)
                );
            }
            let dep_diff_row = rows
                .iter()
                .find(|(sct, name, _, _)| sct == "勾稽差异" && name.starts_with("累计折旧"))
                .map(|(_, _, _, values)| values.get(col).copied().unwrap_or(0.0))
                .unwrap_or(0.0);
            assert!(
                (dep_diff_row - (derived_dep - tb_sum(entity, category, "depreciation", 6)))
                    .abs()
                    < 0.00001,
                "{title} 勾稽差异（累计折旧）缓存与重算不符"
            );
            let nbv_opening =
                tb_sum(entity, category, "cost", 5) - tb_sum(entity, category, "depreciation", 5);
            assert!(
                (value("净值(NBV)", "年初余额") - nbv_opening).abs() < 0.00001,
                "{title} 年初余额不匹配"
            );
        }
        // 合计列（C）缓存等于类别列之和；每个主行的「——其中-」子行按符号
        // 还原后必须等于主行（重分类的转出子行取负，其余子行直接相加）。
        for (section, item, total, values) in rows.iter() {
            let sum: f64 = values.iter().sum();
            assert!(
                (total - sum).abs() < 0.00001,
                "{section}/{item} 合计列缓存 {total} != {sum}"
            );
        }
        let mut main_index = 0usize;
        while main_index < rows.len() {
            if rows[main_index].1.starts_with("——其中-") {
                main_index += 1;
                continue;
            }
            let (section, item, _, _) = &rows[main_index];
            let mut child_end = main_index + 1;
            while child_end < rows.len()
                && rows[child_end].0 == *section
                && rows[child_end].1.starts_with("——其中-")
            {
                child_end += 1;
            }
            if child_end > main_index + 1 {
                for c in 0..columns.len() {
                    let expected: f64 = rows[main_index + 1..child_end]
                        .iter()
                        .map(|row| row.3[c])
                        .sum();
                    let actual = rows[main_index].3[c];
                    assert!(
                        (actual - expected).abs() < 0.00001,
                        "{section}/{item} 第 {c} 列 {} 与子行合计 {expected} 不符",
                        actual
                    );
                }
            }
            main_index = child_end;
        }
        for name in ["新增清单", "处置清单"] {
            let range = book.worksheet_range(name).unwrap();
            for row in range.rows().skip(1) {
                // 重分类转入／转出行按「重分类」维度聚合，普通行按新增／处置。
                let kind = if s(row, 7).contains("类别间调整") {
                    "重分类"
                } else if name == "新增清单" {
                    "新增"
                } else {
                    "处置"
                };
                for (role, col, sign) in [
                    ("cost", 5, if name == "新增清单" { 1.0 } else { -1.0 }),
                    ("depreciation", 6, if name == "新增清单" { -1.0 } else { 1.0 }),
                ] {
                    let expected = sign
                        * je.rows()
                            .skip(1)
                            .filter(|r| {
                                s(r, 0) == s(row, 0)
                                    && s(r, 1) == s(row, 1)
                                    && s(r, 2) == s(row, 2)
                                    && s(r, 6) == s(row, 4)
                                    && s(r, 5) == role
                                    && s(r, 10) == kind
                            })
                            .map(|r| n(r, 7))
                            .sum::<f64>();
                    assert!(
                        (n(row, col) - expected).abs() < 0.00001,
                        "{name} {role} cache mismatch"
                    );
                }
            }
        }
        // 原值／累计折旧对方科目透视表：按「凭证含哪类变动」把对方科目行
        // 分派到两张表，对照 JE 明细逐科目重算借贷。
        let net_zero_status = |status: &str| {
            matches!(
                status,
                "已匹配-计提" | "已匹配-冲销" | "跨行已匹配-计提" | "跨行已匹配-冲销"
            )
        };
        let mut flags: Vec<((String, String, String), (bool, bool))> = Vec::new();
        for r in je.rows().skip(1) {
            // 凭证分组必须带日期：跨日同号凭证（如 1 月与 7 月各一张「记-0067」）
            // 是两张不同的凭证，对方科目不能互相串表。
            let key = (s(r, 0), s(r, 1), s(r, 2));
            if s(r, 12) == "是" || net_zero_status(&s(r, 9)) {
                continue;
            }
            let flag = match flags.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => &mut entry.1,
                None => {
                    flags.push((key, (false, false)));
                    &mut flags.last_mut().unwrap().1
                }
            };
            if s(r, 5) == "cost" {
                flag.0 = true;
            } else if s(r, 5) == "depreciation" {
                flag.1 = true;
            }
        }
        let mut expected_cost = std::collections::BTreeMap::new();
        let mut expected_dep = std::collections::BTreeMap::new();
        for r in je.rows().skip(1) {
            if n(r, 7).abs() < 0.005 {
                continue;
            }
            let key = (s(r, 0), s(r, 1), s(r, 2));
            let Some((has_cost, has_dep)) = flags
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, flag)| *flag)
            else {
                continue;
            };
            for (hit, map) in [(has_cost, &mut expected_cost), (has_dep, &mut expected_dep)] {
                if !hit {
                    continue;
                }
                let entry = map.entry(s(r, 4)).or_insert((0.0, 0.0));
                if n(r, 7) > 0.0 {
                    entry.0 += n(r, 7);
                } else {
                    entry.1 += -n(r, 7);
                }
            }
        }
        for (name, expected) in [("原值透视表", &expected_cost), ("累计折旧透视表", &expected_dep)] {
            let pivot = book.worksheet_range(name).unwrap();
            let mut pivot_rows = pivot.rows().skip(1).collect::<Vec<_>>();
            let total_row = pivot_rows.pop().unwrap_or_else(|| panic!("{name} 必须有合计行"));
            assert_eq!(s(total_row, 0), "合计");
            let mut pivot_map = std::collections::BTreeMap::new();
            for row in &pivot_rows {
                pivot_map.insert(s(row, 0), (n(row, 1), n(row, 2)));
            }
            assert_eq!(
                pivot_map.len(),
                expected.len(),
                "{name} 科目数不匹配：{:?} vs {:?}",
                pivot_map.keys().collect::<Vec<_>>(),
                expected.keys().collect::<Vec<_>>()
            );
            for (account, (debit, credit)) in expected.iter() {
                let actual = pivot_map.get(account).copied().unwrap_or((0.0, 0.0));
                assert!(
                    (actual.0 - debit).abs() < 0.00001 && (actual.1 - credit).abs() < 0.00001,
                    "{name} {account} 借贷不匹配"
                );
            }
            for col in [1usize, 2] {
                let sum: f64 = pivot_rows.iter().map(|r| n(r, col)).sum();
                assert!(
                    (n(total_row, col) - sum).abs() < 0.00001,
                    "{name} 合计列不匹配"
                );
            }
        }
    }

    #[test]
    fn alphanumeric_codes_and_same_code_in_two_entities_do_not_share_categories() {
        let (dir, out, mut params) = fixture();
        std::fs::write(dir.join("tb.csv"), "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\nA,FA01,固定资产,0,100,0,100\nB,FA01,固定资产,0,200,0,200\n").unwrap();
        std::fs::write(dir.join("je.csv"), "主体,日期,凭证号,科目编码,科目名称,摘要,借方,贷方\nA,2025-01-01,V1,FA01,固定资产,购置,100,0\nA,2025-01-01,V1,AP01,应付账款,购置,0,100\nB,2025-01-01,V1,FA01,固定资产,购置,200,0\nB,2025-01-01,V1,AP01,应付账款,购置,0,200\n").unwrap();
        params["accountAssignments"] = json!([
            {"entity":"A","account":"FA01 固定资产","role":"cost","category":"机器"},
            {"entity":"B","account":"FA01 固定资产","role":"cost","category":"车辆"}
        ]);
        let a = analyze(&params, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.totals[&("A".into(), "机器".into())].additions, 100.0);
        assert_eq!(a.totals[&("B".into(), "车辆".into())].additions, 200.0);
        assert_eq!(a.totals.len(), 2);
        assert_eq!(preview_json(&a)["reconciliationDifferences"], 0);
        write_workbook(&out, &a, &AtomicBool::new(false)).unwrap();
        assert_export_caches(&out);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 序时账补零编码与余额表去零编码视为同一科目() {
        // 05 号样例：SAP 序时账把科目补零到十位（`0000943100`），同一套账的
        // 余额表导出时去掉了前导零（`943100`）。不归一化的话这批科目在
        // TB 与 JE 之间对不上，而且不报错——只会安静地少算一批变动。
        let (dir, _, mut params) = fixture();
        std::fs::write(
            dir.join("tb.csv"),
            "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\nA,943100,固定资产,0,100,0,100\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("je.csv"),
            "主体,日期,凭证号,科目编码,科目名称,摘要,借方,贷方\nA,2025-01-01,V1,0000943100,固定资产,购置,100,0\nA,2025-01-01,V1,2202,应付账款,购置,0,100\n",
        )
        .unwrap();
        // 用户在科目分类区只会看到并选中其中一种写法，另一侧要靠归一化跟上。
        params["accountAssignments"] =
            json!([{"entity":"A","account":"943100 固定资产","role":"cost","category":"机器"}]);
        let a = analyze(&params, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.totals[&("A".into(), "机器".into())].additions, 100.0);
        assert_eq!(preview_json(&a)["reconciliationDifferences"], 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn name_only_fallback_requires_public_engine_unique_correspondence() {
        let (dir, _, mut params) = fixture();
        params["jeMapping"]
            .as_object_mut()
            .unwrap()
            .remove("accountCode");
        let a = analyze(&params, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.additions[0].original, 500.0);
        let tuples = |rows: &[(&str, &str, &str)]| {
            rows.iter()
                .map(|(e, c, n)| (e.to_string(), c.to_string(), n.to_string()))
                .collect::<Vec<_>>()
        };
        let keys = ledger_mapping::validated_account_name_keys(
            &tuples(&[
                ("A", "FA1", "设备"),
                ("A", "FA2", "设备"),
                ("B", "FA1", "设备"),
            ]),
            &tuples(&[("A", "", "设备"), ("B", "", "设备")]),
        );
        assert!(!keys.contains(&("A".into(), "设备".into())));
        assert!(keys.contains(&("B".into(), "设备".into())));
        params["tbMapping"]
            .as_object_mut()
            .unwrap()
            .remove("accountCode");
        params["accountAssignments"] =
            json!([{"account":"仅JE科目","role":"cost","category":"设备"}]);
        std::fs::write(dir.join("je.csv"), "主体,日期,凭证号,科目编码,科目名称,摘要,借方,贷方\nA,2025-01-01,V1,,仅JE科目,,100,0\nA,2025-01-01,V1,,银行存款,,0,100\n").unwrap();
        assert_eq!(
            analyze(&params, &AtomicBool::new(false)).unwrap_err().code,
            "FA_TBJE_ACCOUNT_NAME_UNVERIFIED"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unassigned_depreciation_does_not_overwrite_cost_and_counterpart_caches() {
        let (dir, out, params) = fixture();
        let mut a = analyze(&params, &AtomicBool::new(false)).unwrap();
        a.je.extend([
            je_line("A", "MIX", "1601-机器设备", "cost", "机器设备", 120.0),
            je_line(
                "A",
                "MIX",
                "1699-未知折旧",
                "depreciation",
                "未知类别",
                -20.0,
            ),
            je_line("A", "MIX", "1002-银行存款", "", "", -100.0),
        ]);
        let (add, dispose, mut totals) = classify_movements(&mut a.je);
        assert_eq!(
            a.je.iter()
                .find(|line| line.voucher == "MIX" && line.role == "cost")
                .unwrap()
                .movement,
            "新增"
        );
        // 折旧类别在 TB 原值侧没有同名科目不再是审计发现：按方向照常进计提列。
        assert_eq!(
            a.je.iter()
                .find(|line| line.voucher == "MIX" && line.role == "depreciation")
                .unwrap()
                .movement,
            "本年计提/其他增加"
        );
        for ((entity, category), t) in &a.totals {
            let target = totals
                .entry((entity.clone(), category.clone()))
                .or_default();
            target.opening_cost = t.opening_cost;
            target.closing_cost = t.closing_cost;
            target.opening_dep = t.opening_dep;
            target.closing_dep = t.closing_dep;
        }
        a.additions = add;
        a.disposals = dispose;
        a.totals = totals;
        write_workbook(&out, &a, &AtomicBool::new(false)).unwrap();
        assert_export_caches(&out);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn method_uses_directional_nonzero_counterpart_nets() {
        // 新增方式三分：在建工程转入／更新改造转入（固定资产清理）／购入。
        let nets = BTreeMap::from([("16040001-在建工程".into(), -500.0), ("银行存款".into(), -100.0)]);
        assert_eq!(classify_method(true, &nets).0, "在建工程转入");
        // 名称不含「在建」的 1604 科目（如「16040002-工具仪器」）按编码前缀识别。
        assert_eq!(
            classify_method(true, &BTreeMap::from([("16040002-工具仪器".into(), -100.0)])).0,
            "在建工程转入"
        );
        assert_eq!(
            classify_method(true, &BTreeMap::from([("1606-固定资产清理".into(), -100.0)])).0,
            "更新改造转入"
        );
        assert_eq!(
            classify_method(true, &BTreeMap::from([("160601-清理".into(), -100.0)])).0,
            "更新改造转入"
        );
        assert_eq!(classify_method(true, &BTreeMap::from([("银行存款".into(), -500.0)])).0, "购入");
        assert_eq!(classify_method(true, &BTreeMap::new()).0, "购入");
        // 处置侧规则保持：出售／报废毁损／其他待判断。
        assert_eq!(
            classify_method(false, &BTreeMap::from([("银行存款".into(), 500.0)])).0,
            "出售"
        );
        assert_eq!(
            classify_method(false, &BTreeMap::from([("160601-清理".into(), 500.0)])).0,
            "报废/毁损"
        );
        assert_eq!(
            classify_method(false, &BTreeMap::from([("在建工程".into(), 500.0)])).0,
            "其他/待判断"
        );
        let (_, _, review) = classify_method(false, &BTreeMap::new());
        assert_eq!(review, "需人工复核");
    }

    #[test]
    fn missing_tb_balances_and_stale_columns_are_blocked() {
        let (dir, _, mut params) = fixture();
        params["tbMapping"]
            .as_object_mut()
            .unwrap()
            .remove("openingFunctionalAmount");
        assert_eq!(
            analyze(&params, &AtomicBool::new(false)).unwrap_err().code,
            "FA_TBJE_TB_MAPPING_INCOMPLETE"
        );
        params["tbMapping"]["openingFunctionalAmount"] = json!("不存在");
        assert_eq!(
            analyze(&params, &AtomicBool::new(false)).unwrap_err().code,
            "FA_TBJE_MAPPING_STALE"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 必填校验走引擎并集且名称兜底不收紧() {
        let (dir, _, mut params) = fixture();
        // TB 缺期初槽：形态槽（TB1–TB6）拦下，报错要点名缺的角色。
        params["tbMapping"]
            .as_object_mut()
            .unwrap()
            .remove("openingFunctionalAmount");
        let err = analyze(&params, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "FA_TBJE_TB_MAPPING_INCOMPLETE");
        assert!(err.user_message.contains("期初"), "{}", err.user_message);
        params["tbMapping"]["openingFunctionalAmount"] = json!("期初余额");

        // JE 缺凭证识别字段：金标身份槽拦下。
        params["jeMapping"].as_object_mut().unwrap().remove("id");
        let err = analyze(&params, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "FA_TBJE_JE_MAPPING_INCOMPLETE");
        assert!(
            err.user_message.contains("凭证识别字段"),
            "{}",
            err.user_message
        );
        params["jeMapping"]["id"] = json!(["凭证号"]);

        // 金额方案两头落空（净额与借贷分列都没有）：形态槽拦下。
        let je = params["jeMapping"].as_object_mut().unwrap();
        je.remove("functionalDebit");
        je.remove("functionalCredit");
        let err = analyze(&params, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "FA_TBJE_JE_MAPPING_INCOMPLETE");
        assert!(
            err.user_message.contains("本位币净额"),
            "{}",
            err.user_message
        );
        params["jeMapping"]["functionalDebit"] = json!("借方");
        params["jeMapping"]["functionalCredit"] = json!("贷方");

        // 科目只有名称、没有编码：不在此处拦——名称兜底是既定业务，
        // 交给后续 FA_TBJE_ACCOUNT_NAME_UNVERIFIED 的唯一性校验。
        params["jeMapping"]
            .as_object_mut()
            .unwrap()
            .remove("accountCode");
        assert!(analyze(&params, &AtomicBool::new(false)).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn 金额读取走引擎的宽松口径() {
        let (dir, _, params) = fixture();
        // 千分位、括号负数、尾部负号——旧路径借用的存款 parse_number 认不全
        // （尾部负号直接读丢成 None），引擎 parse_amount_lenient 必须全读得出。
        std::fs::write(
            dir.join("tb.csv"),
            "主体,科目编码,科目名称,期初余额,本年借方,本年贷方,期末余额\nA,1601,机器设备,\"1,000\",500,200,\"1,300\"\nA,1602,累计折旧,(200),50,100,250-\n",
        )
        .unwrap();
        let a = analyze(&params, &AtomicBool::new(false)).unwrap();
        let totals = &a.totals[&(String::from("A"), String::from("机器设备"))];
        assert_eq!(totals.opening_cost, 1000.0); // 千分位
        assert_eq!(totals.closing_cost, 1300.0);
        assert_eq!(totals.opening_dep, 200.0); // (200) 读成 -200，折旧取反
        assert_eq!(totals.closing_dep, 250.0); // 250- 读成 -250，折旧取反
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn business_layer_handles_reclass_multi_entity_and_unassigned_depreciation() {
        let mut je = vec![
            je_line("A", "R1", "1601-机器设备", "cost", "机器设备", -100.0),
            je_line("A", "R1", "1601-运输设备", "cost", "运输设备", 100.0),
            je_line("A", "R1", "1602-机器设备", "depreciation", "机器设备", 20.0),
            je_line(
                "A",
                "R1",
                "1602-运输设备",
                "depreciation",
                "运输设备",
                -20.0,
            ),
            je_line(
                "A",
                "U1",
                "1602-未知类别",
                "depreciation",
                "未知类别",
                -15.0,
            ),
            je_line("A", "U1", "6602-折旧费", "", "", 15.0),
            je_line(
                "A",
                "P1",
                "1602-机器设备",
                "depreciation",
                "机器设备",
                -30.0,
            ),
            je_line("A", "P1", "6602-折旧费", "", "", 30.0),
            je_line("B", "N1", "1601-运输设备", "cost", "运输设备", 50.0),
            je_line("B", "N1", "2202-应付账款", "", "", -50.0),
        ];
        let (additions, disposals, totals) = classify_movements(&mut je);
        // R1 原值重分类转入侧进新增清单、转出侧进处置清单；R1 里的折旧对冲
        // （机器 +20／运输 -20）也按行级配对进清单，N1 普通新增照旧。
        assert_eq!(additions.len(), 3);
        assert_eq!(disposals.len(), 2);
        assert!(
            additions
                .iter()
                .any(|m| m.kind == "重分类转入" && m.method == "折旧类别间调整" && m.depreciation == 20.0)
        );
        let reclass_in = additions
            .iter()
            .find(|m| m.voucher == "R1" && m.method == "原值类别间调整")
            .expect("R1 原值重分类转入行");
        assert_eq!(reclass_in.category, "运输设备");
        assert_eq!(reclass_in.original, 100.0);
        // 折旧对冲按行级配对独立成行，不再挂在原值重分类行上。
        assert_eq!(reclass_in.depreciation, 0.0);
        let reclass_out = disposals
            .iter()
            .find(|m| m.voucher == "R1" && m.method == "原值类别间调整")
            .expect("R1 原值重分类转出行");
        assert_eq!(reclass_out.original, 100.0);
        assert_eq!(
            totals[&("A".into(), "机器设备".into())].reclass_cost,
            -100.0
        );
        assert_eq!(totals[&("A".into(), "运输设备".into())].reclass_cost, 100.0);
        assert_eq!(totals[&("A".into(), "机器设备".into())].dep_charge, 30.0);
        // 未知类别的折旧（TB 原值侧没有同名科目）按方向进计提列，不再是未归属差异。
        assert_eq!(totals[&("A".into(), "未知类别".into())].dep_charge, 15.0);
        assert_eq!(totals[&("B".into(), "运输设备".into())].additions, 50.0);
        assert!(
            je.iter()
                .any(|line| line.counterpart && line.movement == "本年计提/其他增加")
        );
    }

    /// 汇兑损益测试资料（序时账-1 ＋ 科目余额表）的真实形态：16020002
    /// 累计折旧-机械设备在 TB 原值侧没有同名类别，1、2 月照常计提，
    /// 3 月一张「折旧科目调整」把它调入工具仪器并冲平。计提要按方向进列，
    /// 调整两侧要原封不动进清单，全程不产生「无法归属」告警。
    #[test]
    fn depreciation_adjustment_between_categories_lands_in_lists_without_warnings() {
        let mut je = vec![
            // 1 月计提：机械设备折旧贷方，对方科目是折旧费（纯计提凭证）。
            je_line(
                "A",
                "D1",
                "16020002-机械设备",
                "depreciation",
                "机械设备",
                -41233.69,
            ),
            je_line("A", "D1", "6602-折旧费", "", "", 41233.69),
            // 3 月「折旧科目调整」：机械设备借方 ／ 工具仪器贷方，无原值变动。
            je_line(
                "A",
                "D2",
                "16020002-机械设备",
                "depreciation",
                "机械设备",
                507550.0,
            ),
            je_line(
                "A",
                "D2",
                "16020003-工具仪器",
                "depreciation",
                "工具仪器",
                -507550.0,
            ),
        ];
        let (additions, disposals, totals) = classify_movements(&mut je);
        // 计提进「本年计提/其他增加」，调整两侧进「重分类净额」。
        assert_eq!(totals[&("A".into(), "机械设备".into())].dep_charge, 41233.69);
        assert_eq!(
            totals[&("A".into(), "机械设备".into())].reclass_dep,
            -507550.0
        );
        assert_eq!(
            totals[&("A".into(), "工具仪器".into())].reclass_dep,
            507550.0
        );
        // 清单：调整转入（工具仪器折旧调增）与转出（机械设备折旧调减）各一行。
        let transfer_in = additions
            .iter()
            .find(|m| m.voucher == "D2")
            .expect("折旧调整转入行");
        assert_eq!(transfer_in.kind, "重分类转入");
        assert_eq!(transfer_in.method, "折旧类别间调整");
        assert_eq!(transfer_in.original, 0.0);
        assert_eq!(transfer_in.depreciation, 507550.0);
        let transfer_out = disposals
            .iter()
            .find(|m| m.voucher == "D2")
            .expect("折旧调整转出行");
        assert_eq!(transfer_out.kind, "重分类转出");
        assert_eq!(transfer_out.depreciation, 507550.0);
        // JE 明细行标「重分类」，汇总口径与原值重分类同一维度。
        assert!(
            je.iter()
                .filter(|line| line.voucher == "D2")
                .all(|line| line.movement == "重分类")
        );
        assert!(
            je.iter()
                .filter(|line| line.voucher == "D1" && !line.counterpart)
                .all(|line| line.movement == "本年计提/其他增加")
        );
    }

    fn je_line(
        entity: &str,
        voucher: &str,
        account: &str,
        role: &str,
        category: &str,
        net: f64,
    ) -> JeLine {
        JeLine {
            entity: entity.into(),
            voucher: voucher.into(),
            voucher_display: voucher.into(),
            date: "2025-12-31".into(),
            summary: String::new(),
            account: account.into(),
            role: role.into(),
            category: category.into(),
            net,
            status: "未匹配".into(),
            movement: String::new(),
            method: String::new(),
            counterpart: role.is_empty(),
            raw: vec![],
        }
    }
}
