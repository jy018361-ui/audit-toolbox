//! 第二期「关联合并/筛选排序」节点：纵向合并（union_n）、去重（unique_n）、
//! 排序（sort_n）。
//!
//! - Union：按字段名（默认，取并集、缺失补空值）或按位置对齐；多出字段默认
//!   保留；类型冲突默认统一文本并提示；差异报告（多出/缺失/类型不同，逐上游
//!   列出）进 stats 与 messages，未逐项处理不阻止运行（默认裁定第 7 条）；
//! - Unique：保留规则 first/last 按输入到达序（可解释、可重现）；空值键视为
//!   同一键参与去重；U=保留、D=被剔除的重复，两路行数进统计；
//! - Sort：多字段优先级，稳定排序（相同排序键保持输入相对次序）；空值位置
//!   逐字段可配、默认排最后（默认裁定第 4 条）。

use super::{config_error, structural, NodeOutcome, Table, MAX_TABLE_ROWS};
use crate::dataflow::model::{SortConfig, SortRule, UniqueConfig, UnionConfig};
use crate::dataflow::nodes::keys::{compare_values, composite_key};
use crate::dataflow::value::{ColType, Value};
use crate::AppError;
use serde_json::Value as Json;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// 纵向合并 Union
// ---------------------------------------------------------------------------

/// 纵向合并。`inputs` 为 (上游节点 id, 上游显示名, 表共享指针)；order 配置非空时
/// 按其重排（未知 id 报错；未列入的上游按连线顺序追加并提示），空 = 连线顺序。
/// 重排直接在引用层持 &(id, 名称, Arc<Table>)，不做二次整表克隆。
pub(crate) fn run_union(
    node_name: &str,
    config: &Json,
    inputs: &[(String, String, Arc<Table>)],
) -> Result<NodeOutcome, AppError> {
    let config: UnionConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("纵向合并", node_name, error.to_string()))?;
    if inputs.is_empty() {
        return Err(config_error("纵向合并", node_name, "至少需要 1 条输入连线。".into()));
    }

    // 拼接次序：order（上游节点 id 数组）优先，空 = 按连线顺序。
    let mut ordered: Vec<&(String, String, Arc<Table>)> = Vec::with_capacity(inputs.len());
    let mut order_messages = Vec::new();
    if config.order.is_empty() {
        ordered.extend(inputs.iter());
    } else {
        for wanted in &config.order {
            let Some(found) = inputs.iter().find(|(id, _, _)| id == wanted) else {
                return Err(config_error(
                    "纵向合并",
                    node_name,
                    format!(
                        "拼接次序中的上游节点“{wanted}”没有连线连到本节点。\
                         连线上的上游：{}。",
                        inputs
                            .iter()
                            .map(|(id, name, _)| format!("{name}（{id}）"))
                            .collect::<Vec<_>>()
                            .join("、")
                    ),
                ));
            };
            ordered.push(found);
        }
        for entry in inputs.iter() {
            if !config.order.contains(&entry.0) {
                order_messages.push(format!(
                    "上游“{}”（{}）未列入拼接次序，已按连线顺序追加在末尾",
                    entry.1, entry.0
                ));
                ordered.push(entry);
            }
        }
    }

    // 重排后的工作清单：直接持有各输入的引用（含 Arc 共享指针），
    // 后续投影经 entry.2.as_ref() 读表，不复制整表。
    let inputs = ordered;
    let align = config.align.as_deref().unwrap_or("byName");
    if align != "byName" && align != "byPosition" {
        return Err(config_error(
            "纵向合并",
            node_name,
            format!("对齐方式“{align}”无法识别（应为 byName 按字段名 / byPosition 按位置）。"),
        ));
    }
    let extra_policy = config.extra_field_policy.as_deref().unwrap_or("keep");
    if extra_policy != "keep" && extra_policy != "drop" {
        return Err(config_error(
            "纵向合并",
            node_name,
            format!("多出字段策略“{extra_policy}”无法识别（应为 keep 保留 / drop 丢弃）。"),
        ));
    }
    let conflict_policy = config.type_conflict_policy.as_deref().unwrap_or("text");
    if conflict_policy != "text" {
        return Err(config_error(
            "纵向合并",
            node_name,
            format!("类型冲突策略“{conflict_policy}”无法识别（首版仅支持 text 统一文本）。"),
        ));
    }

    let mut messages = Vec::new();
    let mut stats = Vec::new();
    messages.extend(order_messages);
    let base = inputs[0].2.as_ref();

    // 输出字段集合：byName 取并集（keep）或仅基准（drop）；byPosition 以
    // 第一个输入的列数与列名为基准，多出的列截去并列入差异报告。
    let mut columns: Vec<String> = base.columns.clone();
    if align == "byName" && extra_policy == "keep" {
        for (_, _, table) in inputs.iter().skip(1) {
            for name in &table.columns {
                if !columns.contains(name) {
                    columns.push(name.clone());
                }
            }
        }
    }

    // 差异报告：逐上游列出多出/缺失/类型不同。
    for (_, label, table) in inputs.iter().skip(1) {
        let mut parts = Vec::new();
        if align == "byName" {
            let extra: Vec<&str> = table
                .columns
                .iter()
                .filter(|name| !base.columns.contains(name))
                .map(String::as_str)
                .collect();
            let missing: Vec<&str> = base
                .columns
                .iter()
                .filter(|name| !table.columns.contains(name))
                .map(String::as_str)
                .collect();
            if !extra.is_empty() {
                parts.push(format!(
                    "多出字段：{}（{}）",
                    extra.join("、"),
                    if extra_policy == "keep" { "已保留并补空值" } else { "按策略丢弃" }
                ));
            }
            if !missing.is_empty() {
                parts.push(format!("缺失字段（按空值补齐）：{}", missing.join("、")));
            }
            let mut type_conflicts = Vec::new();
            for (index, name) in base.columns.iter().enumerate() {
                if let Some(other) = table.columns.iter().position(|candidate| candidate == name) {
                    if table.types[other] != base.types[index] {
                        type_conflicts.push(format!(
                            "{name}（{}→{}）",
                            base.types[index].display(),
                            table.types[other].display()
                        ));
                    }
                }
            }
            if !type_conflicts.is_empty() {
                parts.push(format!("类型不同（统一为文本）：{}", type_conflicts.join("、")));
            }
        } else {
            if table.columns.len() > columns.len() {
                let extra: Vec<String> = table.columns[columns.len()..].to_vec();
                parts.push(format!(
                    "多出列（按位置对齐截去，请改用按字段名对齐）：{}",
                    extra.join("、")
                ));
            }
            if table.columns.len() < columns.len() {
                parts.push(format!("缺少尾部 {} 列（按空值补齐）", columns.len() - table.columns.len()));
            }
            let mut type_conflicts = Vec::new();
            for index in 0..table.columns.len().min(base.columns.len()) {
                if table.types[index] != base.types[index] {
                    type_conflicts.push(format!(
                        "{}（{}→{}）",
                        base.columns[index],
                        base.types[index].display(),
                        table.types[index].display()
                    ));
                }
            }
            if !type_conflicts.is_empty() {
                parts.push(format!("类型不同（统一为文本）：{}", type_conflicts.join("、")));
            }
        }
        if !parts.is_empty() {
            let report = format!("上游“{label}”与第一个输入的差异：{}", parts.join("；"));
            messages.push(report.clone());
            stats.push(report);
        }
    }

    // 输出列类型：各输入同名（或同位置）列类型一致 → 该类型；否则统一文本。
    let mut types: Vec<ColType> = Vec::with_capacity(columns.len());
    let mut to_text: Vec<bool> = Vec::with_capacity(columns.len());
    for (position, name) in columns.iter().enumerate() {
        let mut unified: Option<ColType> = None;
        let mut conflict = false;
        for (_, _, table) in &inputs {
            let other = if align == "byName" {
                table.columns.iter().position(|candidate| candidate == name)
            } else if position < table.columns.len() {
                Some(position)
            } else {
                None
            };
            if let Some(other) = other {
                match (unified, table.types[other]) {
                    (Some(current), other_type) if current == other_type => {}
                    (None, other_type) => unified = Some(other_type),
                    _ => conflict = true,
                }
            }
        }
        match unified {
            Some(kind) if !conflict => {
                types.push(kind);
                to_text.push(false);
            }
            _ => {
                types.push(ColType::Text);
                to_text.push(true);
            }
        }
    }

    // 预检总行数：纵向合并是纯拼接（无去重、无过滤），合并后行数 == 各输入
    // 行数之和，可先于投影物化算出——多表合计超限时立即报错，不再先白占
    // 内存与时间把全部行投影完再丢弃（守恒核对用同一数值）。
    let total: usize = inputs.iter().map(|(_, _, table)| table.rows.len()).sum();
    if total > MAX_TABLE_ROWS {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」合并后行数（{total}）超出内网上限（{MAX_TABLE_ROWS} 行）。",
            ),
        ));
    }

    // 逐表投影到输出列集合（缺失补空值，类型冲突列转显示文本）。
    // 投影经引用读表（entry.2.as_ref()）：逐格 row.get(column).cloned() 属
    // 列对齐/补空/转文本语义的固有成本，保留；但不再有整表级二次克隆。
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(total);
    for (_, _, entry) in &inputs {
        let table = entry.as_ref();
        let mapping: Vec<Option<usize>> = if align == "byName" {
            columns
                .iter()
                .map(|name| table.columns.iter().position(|candidate| candidate == name))
                .collect()
        } else {
            (0..columns.len()).map(|index| table.columns.get(index).map(|_| index)).collect()
        };
        for row in &table.rows {
            let mut line: Vec<Value> = Vec::with_capacity(columns.len());
            for (index, source) in mapping.iter().enumerate() {
                let value = match source {
                    Some(column) => row.get(*column).cloned().unwrap_or(Value::Null),
                    None => Value::Null,
                };
                if to_text[index] {
                    line.push(match value {
                        Value::Null => Value::Null,
                        other => Value::Text(other.to_display()),
                    });
                } else {
                    line.push(value);
                }
            }
            rows.push(line);
        }
    }

    stats.insert(
        0,
        format!(
            "各输入行数：{}；合并后总行数：{}（守恒核对：{}）",
            inputs
                .iter()
                .map(|(_, label, table)| format!("“{label}”{}", table.rows.len()))
                .collect::<Vec<_>>()
                .join("、"),
            rows.len(),
            if rows.len() == total { "一致" } else { "不一致，请检查" }
        ),
    );
    stats.push(format!(
        "对齐方式：{}；多出字段策略：{}；类型冲突策略：{}",
        if align == "byName" { "按字段名" } else { "按位置" },
        if extra_policy == "keep" { "保留（并集）" } else { "丢弃（仅第一个输入的字段）" },
        "统一文本并提示"
    ));

    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    outcome.messages = messages;
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 去重 Unique
// ---------------------------------------------------------------------------

pub(crate) fn run_unique(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: UniqueConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("去重", node_name, error.to_string()))?;
    if config.fields.is_empty() {
        return Err(config_error("去重", node_name, "至少需要选择 1 个去重字段。".into()));
    }
    let keep = config.keep.as_deref().unwrap_or("first");
    if keep != "first" && keep != "last" {
        return Err(config_error(
            "去重",
            node_name,
            format!("保留规则“{keep}”无法识别（应为 first 首次出现 / last 最后一次）。"),
        ));
    }
    let index = input.column_index();
    let mut key_columns = Vec::new();
    for field in &config.fields {
        let Some(&column) = index.get(field) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的去重字段“{field}”不存在。可用字段：{}。",
                    input.columns.join("、")
                ),
            ));
        };
        key_columns.push(column);
    }

    // 空值键视为同一键参与去重（设计文档第 9 节；空文本是另一个值）。
    // keep=first：组内首条进 U；keep=last：组内末条进 U；其余进 D。
    // U/D 两路均按输入到达序输出，顺序可解释、可重现。
    let mut keeper: HashMap<String, usize> = HashMap::new();
    for (ordinal, row) in input.rows.iter().enumerate() {
        let values: Vec<Value> = key_columns.iter().map(|&column| row[column].clone()).collect();
        let key = composite_key(&values);
        match keeper.get(&key) {
            None => {
                keeper.insert(key, ordinal);
            }
            Some(&previous) if keep == "last" => {
                keeper.insert(key, ordinal);
                let _ = previous;
            }
            _ => {}
        }
    }
    let mut u_rows = Vec::new();
    let mut d_rows = Vec::new();
    for (ordinal, row) in input.rows.iter().enumerate() {
        let values: Vec<Value> = key_columns.iter().map(|&column| row[column].clone()).collect();
        let keep_ordinal = keeper[&composite_key(&values)];
        if keep_ordinal == ordinal {
            u_rows.push(row.clone());
        } else {
            d_rows.push(row.clone());
        }
    }

    let u_count = u_rows.len();
    let d_count = d_rows.len();
    let stats = vec![
        format!("U（保留）：{u_count} 行；D（重复）：{d_count} 行"),
        format!(
            "行数守恒：U + D = {} = 输入行数（{}）",
            u_count + d_count,
            input.rows.len()
        ),
        format!(
            "保留规则：{}（依据输入到达序，可解释、可重现）；空值键视为同一键参与去重，空文本是另一个值",
            if keep == "first" { "首次出现" } else { "最后一次" }
        ),
    ];
    let outcome = NodeOutcome {
        anchors: vec![
            ("U".to_owned(), Arc::new(Table {
                columns: input.columns.clone(),
                types: input.types.clone(),
                rows: u_rows,
            })),
            ("D".to_owned(), Arc::new(Table {
                columns: input.columns.clone(),
                types: input.types.clone(),
                rows: d_rows,
            })),
        ],
        messages: Vec::new(),
        stats,
        written: Vec::new(),
        rows: u_count + d_count,
        has_warnings: false,
    };
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 排序 Sort
// ---------------------------------------------------------------------------

struct PreparedSortRule {
    field: String,
    column: usize,
    descending: bool,
    nulls_first: bool,
}

pub(crate) fn run_sort(
    node_name: &str,
    config: &Json,
    mut input: Arc<Table>,
) -> Result<NodeOutcome, AppError> {
    let config: SortConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("排序", node_name, error.to_string()))?;
    if config.rules.is_empty() {
        return Err(config_error("排序", node_name, "至少需要 1 个排序字段。".into()));
    }
    let index = input.column_index();
    let mut rules: Vec<PreparedSortRule> = Vec::new();
    for rule in &config.rules {
        rules.push(prepare_rule(node_name, rule, &index, &input)?);
    }

    // 稳定排序：相同排序键保持输入相对次序（sort_by 稳定）。
    // 写时复制：锚点库仍持引用（refcount ≥ 2）时 make_mut 克隆一次，与改造前
    // input.rows.clone() 成本等价、行为一致；引用计数归 1 后自动退化为原地
    // 排序零拷贝。columns/types/rows 经共享锚点原样复用，不再克隆。
    Arc::make_mut(&mut input).rows.sort_by(|a, b| {
        for rule in &rules {
            let order = sort_level(&a[rule.column], &b[rule.column], rule.nulls_first);
            let order = if rule.descending { order.reverse() } else { order };
            if order != Ordering::Equal {
                return order;
            }
        }
        Ordering::Equal
    });

    let stats = vec![
        format!("进出行数相同：{}", input.rows.len()),
        format!(
            "排序字段（按优先级）：{}；相同排序键保持输入相对次序（稳定排序）",
            config
                .rules
                .iter()
                .map(|rule| {
                    format!(
                        "{}{}（空值排{}）",
                        rule.field,
                        if rule.direction.as_deref() == Some("desc") { " 降序" } else { " 升序" },
                        if rule.nulls.as_deref() == Some("first") { "最前" } else { "最后" }
                    )
                })
                .collect::<Vec<_>>()
                .join("、")
        ),
    ];
    let mut outcome = NodeOutcome::with_shared_anchor("output", input);
    outcome.stats = stats;
    Ok(outcome)
}

fn prepare_rule(
    node_name: &str,
    rule: &SortRule,
    index: &HashMap<String, usize>,
    input: &Table,
) -> Result<PreparedSortRule, AppError> {
    let Some(&column) = index.get(&rule.field) else {
        return Err(structural(
            "DATAFLOW_FIELD_MISSING",
            format!(
                "节点「{node_name}」的排序字段“{}”不存在。可用字段：{}。",
                rule.field,
                input.columns.join("、")
            ),
        ));
    };
    let direction = rule.direction.as_deref().unwrap_or("asc");
    if direction != "asc" && direction != "desc" {
        return Err(config_error(
            "排序",
            node_name,
            format!(
                "字段“{}”的排序方向“{direction}”无法识别（应为 asc 升序 / desc 降序）。",
                rule.field
            ),
        ));
    }
    let nulls = rule.nulls.as_deref().unwrap_or("last");
    if nulls != "first" && nulls != "last" {
        return Err(config_error(
            "排序",
            node_name,
            format!("字段“{}”的空值位置“{nulls}”无法识别（应为 first 最前 / last 最后）。", rule.field),
        ));
    }
    Ok(PreparedSortRule {
        field: rule.field.clone(),
        column,
        descending: direction == "desc",
        nulls_first: nulls == "first",
    })
}

/// 单字段排序层级：空值按配置排最前/最后（与方向无关，指输出中的位置）；
/// 非空值同类型比较；意外混搭按显示文本比较（确定性回退，不报错）。
fn sort_level(left: &Value, right: &Value, nulls_first: bool) -> Ordering {
    match (left, right) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => {
            if nulls_first {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
        (_, Value::Null) => {
            if nulls_first {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        _ => compare_values(left, right).unwrap_or_else(|| left.to_display().cmp(&right.to_display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// NodeOutcome 未实现 Debug，统一经 match 取错误，避免 unwrap_err 编译不过。
    fn expect_row_limit(result: Result<NodeOutcome, AppError>) -> AppError {
        match result {
            Ok(_) => panic!("合并总行数超限时应返回 DATAFLOW_ROW_LIMIT，而不是成功"),
            Err(error) => error,
        }
    }

    fn output_anchor(outcome: &NodeOutcome) -> &Table {
        &outcome
            .anchors
            .iter()
            .find(|(key, _)| key == "output")
            .expect("应存在 output 锚点")
            .1
    }

    /// 常规合并不受影响：按字段名取并集、缺失补空值、行数守恒。
    #[test]
    fn union_by_name_union_columns_and_fill_null() {
        let t1 = (
            "n1".to_owned(),
            "表一".to_owned(),
            Arc::new(Table {
                columns: vec!["a".into(), "b".into()],
                types: vec![ColType::Integer, ColType::Text],
                rows: vec![vec![Value::Int(1), Value::Text("x".into())]],
            }),
        );
        let t2 = (
            "n2".to_owned(),
            "表二".to_owned(),
            Arc::new(Table {
                columns: vec!["b".into(), "c".into()],
                types: vec![ColType::Text, ColType::Text],
                rows: vec![vec![Value::Text("y".into()), Value::Text("z".into())]],
            }),
        );
        let outcome = run_union("纵向合并", &json!({}), &[t1, t2]).unwrap();
        let table = output_anchor(&outcome);
        assert_eq!(table.columns, vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]);
        assert_eq!(
            table.rows,
            vec![
                vec![Value::Int(1), Value::Text("x".into()), Value::Null],
                vec![Value::Null, Value::Text("y".into()), Value::Text("z".into())],
            ]
        );
        assert!(outcome.stats[0].contains("守恒核对：一致"), "stats 应含守恒核对：{}", outcome.stats[0]);
    }

    /// 总行数预检：500000 + 500001 = 1000001 > 100 万，必须在投影物化前报
    /// DATAFLOW_ROW_LIMIT（纯拼接下总行数可先验算，不再先投影完再丢弃）。
    #[test]
    fn union_total_rows_prechecked_before_projection() {
        let int_table = |id: &str, count: usize| {
            (
                id.to_owned(),
                id.to_owned(),
                Arc::new(Table {
                    columns: vec!["v".into()],
                    types: vec![ColType::Integer],
                    rows: (0..count).map(|i| vec![Value::Int(i as i64)]).collect(),
                }),
            )
        };
        let inputs = [int_table("n1", 500_000), int_table("n2", 500_001)];
        let error = expect_row_limit(run_union("纵向合并", &json!({}), &inputs));
        let payload = serde_json::to_value(&error).unwrap();
        assert_eq!(payload["code"], "DATAFLOW_ROW_LIMIT");
        let message = payload["userMessage"].as_str().unwrap();
        assert!(message.contains("超出内网上限"), "应给出中文上限提示：{message}");
        assert!(message.contains("1000001"), "应报告合并后总行数 1000001：{message}");
    }

    /// 边界语义：500000 + 500000 = 恰好 100 万行不报错（> 才报，与既有检查一致）。
    #[test]
    fn union_exactly_one_million_rows_allowed() {
        let int_table = |id: &str, count: usize| {
            (
                id.to_owned(),
                id.to_owned(),
                Arc::new(Table {
                    columns: vec!["v".into()],
                    types: vec![ColType::Integer],
                    rows: (0..count).map(|i| vec![Value::Int(i as i64)]).collect(),
                }),
            )
        };
        let inputs = [int_table("n1", 500_000), int_table("n2", 500_000)];
        let outcome = run_union("纵向合并", &json!({}), &inputs).unwrap();
        assert_eq!(output_anchor(&outcome).rows.len(), 1_000_000);
    }
}
