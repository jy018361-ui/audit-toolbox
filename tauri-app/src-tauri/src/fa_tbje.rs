//! 固定资产 TB+JE 变动表业务层。
//!
//! 文件读取、TB/JE 识别、字段角色、金额符号和 Net=0 匹配全部由
//! `fx` / `ledger_mapping` / `tabular` 公共内核提供；本模块只做固定资产科目
//! 分类、变动归属及底稿输出。

use chrono::{Datelike, NaiveDate};
use rust_xlsxwriter::{Format, FormatBorder, Formula, Workbook, Worksheet};
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
    date: String,
    summary: String,
    account: String,
    role: String,
    category: String,
    net: f64,
    status: String,
    movement: String,
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
    unassigned_dep: f64,
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
    let je = crate::fx::forward_filled_je_table(&load_fx_table(&je_spec)?, &je_map);
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
    let (additions, disposals, mut totals, mut warnings) =
        classify_movements(&mut je_lines, &tb_lines);
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
            date: dates[i].clone(),
            summary: text(table, row, map, "summary"),
            account: accounts[i].clone(),
            role: assigned.map(|a| a.role.clone()).unwrap_or_default(),
            category: assigned.map(category_of).unwrap_or_default(),
            net: net_zero.net[i],
            status: net_zero.status[i].clone(),
            movement: String::new(),
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
    tb: &[TbLine],
) -> (
    Vec<Movement>,
    Vec<Movement>,
    BTreeMap<(String, String), CategoryTotals>,
    Vec<String>,
) {
    let mut vouchers = BTreeMap::<(String, String), Vec<usize>>::new();
    for (i, line) in lines.iter().enumerate() {
        vouchers
            .entry((line.entity.clone(), line.voucher.clone()))
            .or_default()
            .push(i);
    }
    let known = tb
        .iter()
        .filter(|x| x.role == "cost")
        .map(|x| (x.entity.clone(), x.category.clone()))
        .collect::<BTreeSet<_>>();
    let mut additions = Vec::new();
    let mut disposals = Vec::new();
    let mut totals = BTreeMap::<(String, String), CategoryTotals>::new();
    let mut warnings = Vec::new();
    for ((entity, voucher), indexes) in vouchers {
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
            if is_net_zero_matched(&line.status) {
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
                slot.reclass_cost += amount;
                slot.reclass_dep += -dep.remove(&category).unwrap_or(0.0);
                mark_indexes(lines, &indexes, &category, "重分类");
                continue;
            }
            let dep_amount = dep.remove(&category).unwrap_or(0.0);
            let (method, rule, review) = classify_method(amount > 0.0, &counterpart);
            let sample = indexes
                .iter()
                .map(|i| &lines[*i])
                .find(|l| l.category == category)
                .or_else(|| indexes.first().map(|i| &lines[*i]))
                .unwrap();
            let movement = Movement {
                entity: entity.clone(),
                voucher: voucher.clone(),
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
                method,
                evidence: evidence.clone(),
                rule,
                review,
            };
            if amount > 0.0 {
                slot.additions += amount;
                slot.addition_dep += -dep_amount;
                mark_indexes(lines, &indexes, &category, "新增");
                additions.push(movement);
            } else {
                slot.disposals += -amount;
                slot.disposal_dep += dep_amount;
                mark_indexes(lines, &indexes, &category, "处置");
                disposals.push(movement);
            }
        }
        for (category, amount) in dep {
            let category = if category.is_empty() {
                "未归属".to_owned()
            } else {
                category
            };
            let slot = totals
                .entry((entity.clone(), category.clone()))
                .or_default();
            if !known.contains(&(entity.clone(), category.clone())) {
                slot.unassigned_dep += -amount;
                warnings.push(format!(
                    "{entity} / {voucher} 有累计折旧变动 {amount:.2} 无法归属到原值类别。"
                ));
                mark_indexes(lines, &indexes, &category, "未归属折旧");
            } else if amount < 0.0 {
                slot.dep_charge += -amount;
                mark_indexes(lines, &indexes, &category, "本年计提/其他增加");
            } else {
                slot.dep_other_decrease += amount;
                mark_indexes(lines, &indexes, &category, "折旧其他减少");
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
    (additions, disposals, totals, warnings)
}

fn mark_indexes(lines: &mut [JeLine], indexes: &[usize], category: &str, movement: &str) {
    for &i in indexes {
        if is_net_zero_matched(&lines[i].status) {
            continue;
        }
        if !lines[i].counterpart && lines[i].category == category {
            lines[i].movement = movement.into();
        }
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
    let (method, rule) = if addition {
        if hit(&["在建工程", "cip", "工程物资"]) {
            ("在建工程转入", "对方科目命中在建工程/CIP/工程物资")
        } else if hit(&["租赁负债", "长期应付款", "未确认融资费用"]) {
            ("融资租入", "对方科目命中租赁负债/长期应付款")
        } else if hit(&["原材料", "库存商品", "存货", "生产成本"]) {
            ("自制/存货转入", "对方科目命中存货或生产成本")
        } else if hit(&["银行存款", "库存现金", "应付账款", "其他应付款", "预付账款"])
        {
            ("购置", "对方科目命中现金/往来购置科目")
        } else {
            ("其他/待判断", "未命中新增方式确定性规则")
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
    } else if hit(&["固定资产清理", "营业外支出"]) {
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
                    + t.reclass_dep
                    + t.unassigned_dep)
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
    write_counterparts(wb.add_worksheet(), a)?;
    write_tb_hidden(wb.add_worksheet(), a)?;
    wb.save(path).map_err(|e| {
        error(
            "FA_TBJE_EXPORT_FAILED",
            "固定资产 TB＋JE 底稿保存失败。",
            Some(e.to_string()),
        )
    })
}

fn formats() -> (Format, Format) {
    (
        Format::new()
            .set_bold()
            .set_background_color("#E9EEF5")
            .set_border(FormatBorder::Thin),
        Format::new()
            .set_num_format("#,##0.00;[Red]-#,##0.00;-")
            .set_border(FormatBorder::Thin),
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

fn write_summary(ws: &mut Worksheet, a: &Analysis) -> Result<(), AppError> {
    ws.set_name("固定资产汇总变动表").map_err(xlsx)?;
    let (header, money) = formats();
    let headers = [
        "主体",
        "资产类别",
        "项目",
        "TB期初",
        "新增",
        "处置",
        "重分类净额",
        "其他变动",
        "JE推导年末",
        "TB年末",
        "勾稽差异",
    ];
    write_headers(ws, &headers, &header)?;
    let mut row = 1u32;
    for ((entity, category), t) in &a.totals {
        for (label, opening, add, disposal, reclass, other, closing) in [
            (
                "原值",
                t.opening_cost,
                t.additions,
                t.disposals,
                t.reclass_cost,
                0.0,
                t.closing_cost,
            ),
            (
                "累计折旧",
                t.opening_dep,
                t.addition_dep,
                t.disposal_dep,
                t.reclass_dep,
                t.dep_charge + t.unassigned_dep - t.dep_other_decrease,
                t.closing_dep,
            ),
        ] {
            ws.write_string(row, 0, entity).map_err(xlsx)?;
            ws.write_string(row, 1, category).map_err(xlsx)?;
            ws.write_string(row, 2, label).map_err(xlsx)?;
            let excel = row + 1;
            let tb_role = if label == "原值" {
                "cost"
            } else {
                "depreciation"
            };
            let opening_formula = format!(
                "SUMIFS('_TB规范数据'!$F:$F,'_TB规范数据'!$A:$A,A{excel},'_TB规范数据'!$D:$D,B{excel},'_TB规范数据'!$C:$C,\"{tb_role}\")"
            );
            let closing_formula = format!(
                "SUMIFS('_TB规范数据'!$G:$G,'_TB规范数据'!$A:$A,A{excel},'_TB规范数据'!$D:$D,B{excel},'_TB规范数据'!$C:$C,\"{tb_role}\")"
            );
            ws.write_formula_with_format(
                row,
                3,
                Formula::new(opening_formula).set_result(opening.to_string()),
                &money,
            )
            .map_err(xlsx)?;
            let je_sum = |movement: &str| {
                format!(
                    "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,A{excel},'固定资产相关JE完整明细'!$G:$G,B{excel},'固定资产相关JE完整明细'!$F:$F,\"{tb_role}\",'固定资产相关JE完整明细'!$L:$L,\"{movement}\")"
                )
            };
            let (add_formula, disposal_formula, reclass_formula, other_formula) = if label == "原值"
            {
                (
                    je_sum("新增"),
                    format!("-{}", je_sum("处置")),
                    je_sum("重分类"),
                    je_sum("其他变动"),
                )
            } else {
                (
                    format!("-{}", je_sum("新增")),
                    je_sum("处置"),
                    format!("-{}", je_sum("重分类")),
                    format!(
                        "-{}-{}-{}",
                        je_sum("本年计提/其他增加"),
                        je_sum("折旧其他减少"),
                        je_sum("未归属折旧")
                    ),
                )
            };
            for (col, formula, value) in [
                (4, add_formula, add),
                (5, disposal_formula, disposal),
                (6, reclass_formula, reclass),
                (7, other_formula, other),
            ] {
                ws.write_formula_with_format(
                    row,
                    col,
                    Formula::new(formula).set_result(value.to_string()),
                    &money,
                )
                .map_err(xlsx)?;
            }
            ws.write_formula_with_format(
                row,
                8,
                Formula::new(format!("D{excel}+E{excel}-F{excel}+G{excel}+H{excel}"))
                    .set_result((opening + add - disposal + reclass + other).to_string()),
                &money,
            )
            .map_err(xlsx)?;
            ws.write_formula_with_format(
                row,
                9,
                Formula::new(closing_formula).set_result(closing.to_string()),
                &money,
            )
            .map_err(xlsx)?;
            ws.write_formula_with_format(
                row,
                10,
                Formula::new(format!("I{excel}-J{excel}"))
                    .set_result((opening + add - disposal + reclass + other - closing).to_string()),
                &money,
            )
            .map_err(xlsx)?;
            row += 1;
        }
        let excel = row + 1;
        ws.write_string(row, 0, entity).map_err(xlsx)?;
        ws.write_string(row, 1, category).map_err(xlsx)?;
        ws.write_string(row, 2, "净值").map_err(xlsx)?;
        let original_values = summary_values(t, false);
        let depreciation_values = summary_values(t, true);
        for col in 3..=10 {
            let letter = (b'A' + col as u8) as char;
            ws.write_formula_with_format(
                row,
                col,
                Formula::new(format!("{letter}{}-{letter}{}", excel - 2, excel - 1)).set_result(
                    (original_values[col as usize - 3] - depreciation_values[col as usize - 3])
                        .to_string(),
                ),
                &money,
            )
            .map_err(xlsx)?;
        }
        row += 1;
    }
    let detail_last = row;
    let mut entity_totals = BTreeMap::<String, CategoryTotals>::new();
    let mut grand_totals = CategoryTotals::default();
    for ((entity, _), totals) in &a.totals {
        merge_totals(entity_totals.entry(entity.clone()).or_default(), totals);
        merge_totals(&mut grand_totals, totals);
    }
    let total_money = money.clone().set_bold();
    for (entity, totals) in entity_totals {
        write_summary_total_block(
            ws,
            &mut row,
            detail_last,
            &entity,
            "主体合计",
            &totals,
            &header,
            &total_money,
            false,
        )?;
    }
    write_summary_total_block(
        ws,
        &mut row,
        detail_last,
        "全部主体",
        "总计",
        &grand_totals,
        &header,
        &total_money,
        true,
    )?;
    Ok(())
}

fn write_summary_total_block(
    ws: &mut Worksheet,
    row: &mut u32,
    detail_last: u32,
    entity: &str,
    category: &str,
    totals: &CategoryTotals,
    header: &Format,
    money: &Format,
    grand: bool,
) -> Result<(), AppError> {
    let original_row = *row + 1;
    let depreciation_row = *row + 2;
    let original_values = summary_values(totals, false);
    let depreciation_values = summary_values(totals, true);
    for (label, values) in [
        ("原值", original_values),
        ("累计折旧", depreciation_values),
        (
            "净值",
            std::array::from_fn(|i| original_values[i] - depreciation_values[i]),
        ),
    ] {
        let excel = *row + 1;
        ws.write_string_with_format(*row, 0, entity, header)
            .map_err(xlsx)?;
        ws.write_string_with_format(*row, 1, category, header)
            .map_err(xlsx)?;
        ws.write_string_with_format(*row, 2, label, header)
            .map_err(xlsx)?;
        for col in 3..=10 {
            let letter = (b'A' + col as u8) as char;
            let formula = if label == "净值" {
                format!("{letter}{original_row}-{letter}{depreciation_row}")
            } else if grand {
                format!("SUMIF($C$2:$C${detail_last},$C{excel},{letter}$2:{letter}${detail_last})")
            } else {
                format!(
                    "SUMIFS({letter}$2:{letter}${detail_last},$A$2:$A${detail_last},$A{excel},$C$2:$C${detail_last},$C{excel})"
                )
            };
            ws.write_formula_with_format(
                *row,
                col,
                Formula::new(formula).set_result(values[col as usize - 3].to_string()),
                money,
            )
            .map_err(xlsx)?;
        }
        *row += 1;
    }
    Ok(())
}

fn summary_values(t: &CategoryTotals, depreciation: bool) -> [f64; 8] {
    let (opening, addition, disposal, reclass, other, closing) = if depreciation {
        (
            t.opening_dep,
            t.addition_dep,
            t.disposal_dep,
            t.reclass_dep,
            t.dep_charge + t.unassigned_dep - t.dep_other_decrease,
            t.closing_dep,
        )
    } else {
        (
            t.opening_cost,
            t.additions,
            t.disposals,
            t.reclass_cost,
            0.0,
            t.closing_cost,
        )
    };
    let derived = opening + addition - disposal + reclass + other;
    [
        opening,
        addition,
        disposal,
        reclass,
        other,
        derived,
        closing,
        derived - closing,
    ]
}

fn merge_totals(target: &mut CategoryTotals, value: &CategoryTotals) {
    target.opening_cost += value.opening_cost;
    target.closing_cost += value.closing_cost;
    target.opening_dep += value.opening_dep;
    target.closing_dep += value.closing_dep;
    target.additions += value.additions;
    target.addition_dep += value.addition_dep;
    target.disposals += value.disposals;
    target.disposal_dep += value.disposal_dep;
    target.dep_charge += value.dep_charge;
    target.dep_other_decrease += value.dep_other_decrease;
    target.reclass_cost += value.reclass_cost;
    target.reclass_dep += value.reclass_dep;
    target.unassigned_dep += value.unassigned_dep;
}

fn write_movements(
    ws: &mut Worksheet,
    name: &str,
    rows: &[Movement],
    addition: bool,
) -> Result<(), AppError> {
    ws.set_name(name).map_err(xlsx)?;
    let (header, money) = formats();
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
            ws.write_string(row, c as u16, *v).map_err(xlsx)?;
        }
        let movement = if addition { "新增" } else { "处置" };
        let excel = row + 1;
        let base = format!(
            "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,A{excel},'固定资产相关JE完整明细'!$B:$B,B{excel},'固定资产相关JE完整明细'!$G:$G,E{excel},'固定资产相关JE完整明细'!$L:$L,\"{movement}\",'固定资产相关JE完整明细'!$F:$F,"
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
            ws.write_string(row, c, v).map_err(xlsx)?;
        }
    }
    Ok(())
}

fn write_je(ws: &mut Worksheet, a: &Analysis, cancel: &AtomicBool) -> Result<(), AppError> {
    ws.set_name("固定资产相关JE完整明细").map_err(xlsx)?;
    let (header, money) = formats();
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
        "正负标记",
        "智能匹配状态",
        "变动分类",
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
            &l.voucher,
            &l.date,
            &l.summary,
            &l.account,
            &l.role,
            &l.category,
        ]
        .iter()
        .enumerate()
        {
            ws.write_string(row, c as u16, *v).map_err(xlsx)?;
        }
        ws.write_number_with_format(row, 7, l.net, &money)
            .map_err(xlsx)?;
        ws.write_number_with_format(row, 8, l.net.abs(), &money)
            .map_err(xlsx)?;
        ws.write_string(row, 9, if l.net >= 0.0 { "正数" } else { "负数" })
            .map_err(xlsx)?;
        ws.write_string(row, 10, &l.status).map_err(xlsx)?;
        ws.write_string(row, 11, &l.movement).map_err(xlsx)?;
        ws.write_string(row, 12, if l.counterpart { "是" } else { "否" })
            .map_err(xlsx)?;
        for (c, v) in l.raw.iter().enumerate() {
            ws.write_string(row, (13 + c) as u16, v).map_err(xlsx)?;
        }
    }
    Ok(())
}

fn write_counterparts(ws: &mut Worksheet, a: &Analysis) -> Result<(), AppError> {
    ws.set_name("对方科目汇总表").map_err(xlsx)?;
    let (header, money) = formats();
    write_headers(
        ws,
        &[
            "主体",
            "变动分类",
            "对方科目",
            "凭证数",
            "借方金额",
            "贷方金额",
            "净额",
            "涉及资产类别",
            "代表凭证",
        ],
        &header,
    )?;
    let mut groups = BTreeMap::<
        (String, String, String),
        (
            BTreeSet<String>,
            f64,
            f64,
            BTreeSet<String>,
            BTreeSet<String>,
        ),
    >::new();
    for l in &a.je {
        if !l.counterpart || l.net.abs() < 0.005 {
            continue;
        }
        let kind = l.movement.clone();
        let e = groups
            .entry((l.entity.clone(), kind, l.account.clone()))
            .or_default();
        e.0.insert(l.voucher.clone());
        if l.net > 0.0 {
            e.1 += l.net
        } else {
            e.2 += -l.net
        }
        e.3.extend(
            a.je.iter()
                .filter(|x| {
                    x.entity == l.entity && x.voucher == l.voucher && !x.category.is_empty()
                })
                .map(|x| x.category.clone()),
        );
        e.4.insert(l.voucher.clone());
    }
    for (r, ((entity, kind, account), (vouchers, debit, credit, categories, reps))) in
        groups.into_iter().enumerate()
    {
        let row = r as u32 + 1;
        let excel = row + 1;
        ws.write_string(row, 0, &entity).map_err(xlsx)?;
        ws.write_string(row, 1, &kind).map_err(xlsx)?;
        ws.write_string(row, 2, &account).map_err(xlsx)?;
        ws.write_number(row, 3, vouchers.len() as f64)
            .map_err(xlsx)?;
        let base = format!(
            "SUMIFS('固定资产相关JE完整明细'!$H:$H,'固定资产相关JE完整明细'!$A:$A,A{excel},'固定资产相关JE完整明细'!$L:$L,B{excel},'固定资产相关JE完整明细'!$E:$E,C{excel},'固定资产相关JE完整明细'!$M:$M,\"是\",'固定资产相关JE完整明细'!$H:$H,"
        );
        let debit_formula = format!("{base}\">0\")");
        let credit_formula = format!("-{base}\"<0\")");
        ws.write_formula_with_format(
            row,
            4,
            Formula::new(debit_formula).set_result(debit.to_string()),
            &money,
        )
        .map_err(xlsx)?;
        ws.write_formula_with_format(
            row,
            5,
            Formula::new(credit_formula).set_result(credit.to_string()),
            &money,
        )
        .map_err(xlsx)?;
        ws.write_formula_with_format(
            row,
            6,
            Formula::new(format!("E{excel}-F{excel}")).set_result((debit - credit).to_string()),
            &money,
        )
        .map_err(xlsx)?;
        ws.write_string(
            row,
            7,
            categories.into_iter().collect::<Vec<_>>().join("；"),
        )
        .map_err(xlsx)?;
        ws.write_string(
            row,
            8,
            reps.into_iter().take(3).collect::<Vec<_>>().join("；"),
        )
        .map_err(xlsx)?;
    }
    Ok(())
}

fn write_tb_hidden(ws: &mut Worksheet, a: &Analysis) -> Result<(), AppError> {
    ws.set_name("_TB规范数据").map_err(xlsx)?;
    let (header, money) = formats();
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
            ws.write_string(row, c as u16, *v).map_err(xlsx)?;
        }
        ws.write_number(row, 4, l.source_row as f64).map_err(xlsx)?;
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
                "对方科目汇总表",
                "_TB规范数据"
            ]
        );
        let formulas = book.worksheet_formula("固定资产汇总变动表").unwrap();
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().contains("SUMIFS('_TB规范数据'"))
        );
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|v| v.to_string().contains("固定资产相关JE完整明细"))
        );
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

    /// Evaluate the generated SUMIFS criteria against the exported source sheets, not
    /// against CategoryTotals (which could repeat the same cache calculation defect).
    fn assert_export_caches(path: &Path) {
        let mut book = open_workbook_auto(path).unwrap();
        let summary = book.worksheet_range("固定资产汇总变动表").unwrap();
        let je = book.worksheet_range("固定资产相关JE完整明细").unwrap();
        let tb = book.worksheet_range("_TB规范数据").unwrap();
        let formulas = book.worksheet_formula("固定资产汇总变动表").unwrap();
        let s = |row: &[calamine::Data], col: usize| row[col].to_string();
        let n = |row: &[calamine::Data], col: usize| row[col].as_f64().unwrap_or(0.0);
        for (index, row) in summary.rows().enumerate().skip(1) {
            let (entity, category, label) = (s(row, 0), s(row, 1), s(row, 2));
            let selected = |other: &[calamine::Data], category_col: usize| {
                (category == "总计" || s(other, 0) == entity)
                    && (["主体合计", "总计"].contains(&category.as_str())
                        || s(other, category_col) == category)
            };
            let values = |depreciation: bool| {
                let role = if depreciation { "depreciation" } else { "cost" };
                let tb_sum = |col| {
                    tb.rows()
                        .skip(1)
                        .filter(|r| selected(r, 3) && s(r, 2) == role)
                        .map(|r| n(r, col))
                        .sum::<f64>()
                };
                let je_sum = |movement: &str| {
                    je.rows()
                        .skip(1)
                        .filter(|r| selected(r, 6) && s(r, 5) == role && s(r, 11) == movement)
                        .map(|r| n(r, 7))
                        .sum::<f64>()
                };
                let sign = if depreciation { -1.0 } else { 1.0 };
                let opening = tb_sum(5);
                let add = sign * je_sum("新增");
                let disposal = -sign * je_sum("处置");
                let reclass = sign * je_sum("重分类");
                let other = if depreciation {
                    -(je_sum("本年计提/其他增加") + je_sum("折旧其他减少") + je_sum("未归属折旧"))
                } else {
                    je_sum("其他变动")
                };
                let derived = opening + add - disposal + reclass + other;
                [
                    opening,
                    add,
                    disposal,
                    reclass,
                    other,
                    derived,
                    tb_sum(6),
                    derived - tb_sum(6),
                ]
            };
            let expected = match label.as_str() {
                "原值" => values(false),
                "累计折旧" => values(true),
                "净值" => std::array::from_fn(|i| values(false)[i] - values(true)[i]),
                _ => panic!("unexpected summary row"),
            };
            for (col, expected) in expected.iter().enumerate() {
                assert!(
                    (n(row, col + 3) - expected).abs() < 0.00001,
                    "summary row {index}, col {} cache {} != computed {expected}",
                    col + 3,
                    n(row, col + 3)
                );
                assert!(
                    !formulas
                        .get_value((index as u32, (col + 3) as u32))
                        .unwrap()
                        .is_empty()
                );
            }
        }
        for name in ["新增清单", "处置清单"] {
            let range = book.worksheet_range(name).unwrap();
            let kind = if name == "新增清单" {
                "新增"
            } else {
                "处置"
            };
            for row in range.rows().skip(1) {
                for (role, col, sign) in [
                    ("cost", 5, if kind == "新增" { 1.0 } else { -1.0 }),
                    ("depreciation", 6, if kind == "新增" { -1.0 } else { 1.0 }),
                ] {
                    let expected = sign
                        * je.rows()
                            .skip(1)
                            .filter(|r| {
                                s(r, 0) == s(row, 0)
                                    && s(r, 1) == s(row, 1)
                                    && s(r, 6) == s(row, 4)
                                    && s(r, 5) == role
                                    && s(r, 11) == kind
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
        let range = book.worksheet_range("对方科目汇总表").unwrap();
        for row in range.rows().skip(1) {
            let matched = je
                .rows()
                .skip(1)
                .filter(|r| {
                    s(r, 0) == s(row, 0)
                        && s(r, 11) == s(row, 1)
                        && s(r, 4) == s(row, 2)
                        && s(r, 12) == "是"
                })
                .collect::<Vec<_>>();
            let debit = matched.iter().map(|r| n(r, 7).max(0.0)).sum::<f64>();
            let credit = matched.iter().map(|r| (-n(r, 7)).max(0.0)).sum::<f64>();
            for (col, expected) in [(4, debit), (5, credit), (6, debit - credit)] {
                assert!(
                    (n(row, col) - expected).abs() < 0.00001,
                    "counterpart cache mismatch"
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
        let (add, dispose, mut totals, warnings) = classify_movements(&mut a.je, &a.tb);
        assert_eq!(
            a.je.iter()
                .find(|line| line.voucher == "MIX" && line.role == "cost")
                .unwrap()
                .movement,
            "新增"
        );
        assert_eq!(
            a.je.iter()
                .find(|line| line.voucher == "MIX" && line.role == "depreciation")
                .unwrap()
                .movement,
            "未归属折旧"
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
        a.warnings = warnings;
        write_workbook(&out, &a, &AtomicBool::new(false)).unwrap();
        assert_export_caches(&out);
        assert_eq!(a.warnings.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn method_uses_directional_nonzero_counterpart_nets() {
        let nets = BTreeMap::from([("在建工程".into(), 0.0), ("银行存款".into(), -500.0)]);
        assert_eq!(classify_method(true, &nets).0, "购置");
        assert_eq!(classify_method(false, &nets).0, "其他/待判断");
        let (_, _, review) = classify_method(true, &BTreeMap::new());
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
        let tb = vec![
            tb_line("A", "cost", "机器设备", 1000.0, 900.0),
            tb_line("A", "cost", "运输设备", 300.0, 400.0),
            tb_line("A", "depreciation", "机器设备", -200.0, -245.0),
            tb_line("B", "cost", "运输设备", 0.0, 50.0),
        ];
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
        let (additions, disposals, totals, warnings) = classify_movements(&mut je, &tb);
        assert_eq!(additions.len(), 1);
        assert!(disposals.is_empty());
        assert_eq!(
            totals[&("A".into(), "机器设备".into())].reclass_cost,
            -100.0
        );
        assert_eq!(totals[&("A".into(), "运输设备".into())].reclass_cost, 100.0);
        assert_eq!(totals[&("A".into(), "机器设备".into())].dep_charge, 30.0);
        assert_eq!(
            totals[&("A".into(), "未知类别".into())].unassigned_dep,
            15.0
        );
        assert_eq!(totals[&("B".into(), "运输设备".into())].additions, 50.0);
        assert_eq!(warnings.len(), 1);
        assert!(
            je.iter()
                .any(|line| line.counterpart && line.movement == "未归属折旧")
        );
    }

    fn tb_line(entity: &str, role: &str, category: &str, opening: f64, closing: f64) -> TbLine {
        TbLine {
            entity: entity.into(),
            account: format!("test-{category}"),
            role: role.into(),
            category: category.into(),
            opening,
            closing,
            source_row: 2,
        }
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
            date: "2025-12-31".into(),
            summary: String::new(),
            account: account.into(),
            role: role.into(),
            category: category.into(),
            net,
            status: "未匹配".into(),
            movement: String::new(),
            counterpart: role.is_empty(),
            raw: vec![],
        }
    }
}
