//! 第二期「汇总变形」节点：汇总（summarize）、透视（crosstab）、宽转长
//! （transpose）。
//!
//! 设计文档第 4/9 节与默认裁定第 8/9/15 条：
//! - 空值键归「（空）」组（分组及去重把同位置的空值视为同一分组键，
//!   空文本仍是另一值）；
//! - 求和/平均/最小/最大跳过空值，无有效值时返回空值；平均以有效值数量
//!   为分母，不无提示补零；
//! - 十进制全程走 value.rs 定点规则（先逐行舍入再汇总与先汇总再舍入是不同
//!   流程，本节点不做任何隐式舍入，ROUND 只在公式里）；
//! - 透视动态列名＝列字段值文本；缺失组合默认填 0（可改空值）；列数超
//!   1000 中文报错；列字段首版只支持 1 个；
//! - 宽转长默认列名「项目 / 数值」。

use super::{config_error, structural, NodeOutcome, Table, MAX_TABLE_ROWS};
use crate::dataflow::model::{CrosstabConfig, SummarizeConfig, TransposeConfig};
use crate::dataflow::nodes::keys::{compare_values, composite_key};
use crate::dataflow::value::{ColType, Dec, Value};
use crate::AppError;
use serde_json::Value as Json;
use std::collections::HashMap;

/// 空值分组键的展示值（分组列输出「（空）」，stats 同步说明）。
const NULL_GROUP_LABEL: &str = "（空）";
/// 透视动态列数上限（超出明确报错，不静默丢列）。
const CROSSTAB_MAX_COLUMNS: usize = 1000;

/// 聚合函数名 → 中文名。
fn func_display(func: &str) -> Option<&'static str> {
    match func {
        "countAll" => Some("总行数"),
        "countNonEmpty" => Some("非空计数"),
        "distinctCount" => Some("去重计数"),
        "sum" => Some("求和"),
        "avg" => Some("平均"),
        "min" => Some("最小"),
        "max" => Some("最大"),
        _ => None,
    }
}

/// 汇总 Summarize。
pub(crate) fn run_summarize(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: SummarizeConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("汇总", node_name, error.to_string()))?;
    let index = input.column_index();

    // 分组字段校验。
    let mut group_columns = Vec::new();
    for field in &config.group_by {
        let Some(&column) = index.get(field) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的分组字段“{field}”不存在。可用字段：{}。",
                    input.columns.join("、")
                ),
            ));
        };
        group_columns.push(column);
    }

    // 聚合配置校验与默认输出名。
    if config.aggregations.is_empty() {
        return Err(config_error("汇总", node_name, "至少需要 1 条聚合配置。".into()));
    }
    struct PreparedAgg {
        output: String,
        column: Option<usize>,
        func: &'static str,
        numeric: bool,
    }
    let mut aggregations: Vec<PreparedAgg> = Vec::new();
    for spec in &config.aggregations {
        let Some(display) = func_display(&spec.func) else {
            return Err(config_error(
                "汇总",
                node_name,
                format!(
                    "聚合方式“{}”无法识别（可选 countAll / countNonEmpty / distinctCount / sum / avg / min / max）。",
                    spec.func
                ),
            ));
        };
        if spec.func == "countAll" {
            if !spec.field.trim().is_empty() {
                return Err(config_error(
                    "汇总",
                    node_name,
                    "聚合方式「总行数」不需要源字段（field 留空即可）。".into(),
                ));
            }
            aggregations.push(PreparedAgg {
                output: spec.output.trim().to_owned(),
                column: None,
                func: display,
                numeric: false,
            });
            continue;
        }
        if spec.field.trim().is_empty() {
            return Err(config_error(
                "汇总",
                node_name,
                format!("聚合方式「{display}」必须指定源字段（仅总行数可不填）。"),
            ));
        }
        let Some(&column) = index.get(spec.field.trim()) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的聚合字段“{}”不存在。可用字段：{}。",
                    spec.field,
                    input.columns.join("、")
                ),
            ));
        };
        let kind = input.types[column];
        match spec.func.as_str() {
            "sum" | "avg" => {
                if !matches!(kind, ColType::Integer | ColType::Decimal) {
                    return Err(config_error(
                        "汇总",
                        node_name,
                        format!(
                            "字段“{}”是{}，求和/平均仅适用于数值字段（整数/十进制小数）。",
                            spec.field,
                            kind.display()
                        ),
                    ));
                }
            }
            "min" | "max" => {
                if matches!(kind, ColType::Bool) {
                    return Err(config_error(
                        "汇总",
                        node_name,
                        format!("字段“{}”是布尔值，不支持最小/最大。", spec.field),
                    ));
                }
            }
            _ => {}
        }
        let output = if spec.output.trim().is_empty() {
            format!("{}_{}", spec.field.trim(), display)
        } else {
            spec.output.trim().to_owned()
        };
        aggregations.push(PreparedAgg {
            output,
            column: Some(column),
            func: display,
            numeric: matches!(input.types[column], ColType::Integer | ColType::Decimal),
        });
    }
    // countAll 默认名「总行数」；输出名不可重复、不可与分组字段重名。
    for agg in &mut aggregations {
        if agg.output.is_empty() && agg.func == "总行数" {
            agg.output = "总行数".to_owned();
        }
    }
    let mut seen_names: Vec<String> = config.group_by.clone();
    for agg in &aggregations {
        if agg.output.is_empty() {
            return Err(config_error("汇总", node_name, "聚合输出字段名不能为空。".into()));
        }
        if seen_names.contains(&agg.output) {
            return Err(config_error(
                "汇总",
                node_name,
                format!("聚合输出字段名“{}”重复（彼此及与分组字段均不可重名）。", agg.output),
            ));
        }
        seen_names.push(agg.output.clone());
    }

    // 分组（按首次出现顺序）；空值键归「（空）」组。
    struct Group {
        key_values: Vec<Value>,
        /// 各聚合字段的取值缓存（惰性收集：直接收集全部值，行级数据在内存中）。
        values: Vec<Vec<Value>>,
        rows: usize,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    let mut null_group_rows = 0usize;
    for row in &input.rows {
        let key_values: Vec<Value> = group_columns.iter().map(|&column| row[column].clone()).collect();
        let has_null = key_values.iter().any(|value| matches!(value, Value::Null));
        if has_null {
            null_group_rows += 1;
        }
        let key = composite_key(&key_values);
        let position = match group_index.get(&key) {
            Some(&position) => position,
            None => {
                let position = groups.len();
                group_index.insert(key, position);
                groups.push(Group {
                    key_values,
                    values: vec![Vec::new(); aggregations.len()],
                    rows: 0,
                });
                position
            }
        };
        groups[position].rows += 1;
        for (slot, agg) in aggregations.iter().enumerate() {
            if let Some(column) = agg.column {
                groups[position].values[slot].push(row[column].clone());
            }
        }
    }
    if groups.len() > MAX_TABLE_ROWS {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」分组数（{}）超出内网上限（{MAX_TABLE_ROWS} 组）。\
                 高分组数量场景请先筛选或拆分数据。",
                groups.len()
            ),
        ));
    }

    // 输出表：分组列（空值键显示「（空）」）+ 各聚合结果。
    let mut columns: Vec<String> = config.group_by.clone();
    let mut types: Vec<ColType> = group_columns
        .iter()
        .map(|&column| input.types[column])
        .collect();
    columns.extend(aggregations.iter().map(|agg| agg.output.clone()));
    types.extend(aggregations.iter().map(|agg| match agg.func {
        "总行数" | "非空计数" | "去重计数" => ColType::Integer,
        "平均" => ColType::Decimal,
        "求和" | "最小" | "最大" => {
            let column = agg.column.expect("非 countAll 已校验字段");
            input.types[column]
        }
        _ => ColType::Text,
    }));
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(groups.len());
    for group in &groups {
        let mut line: Vec<Value> = group
            .key_values
            .iter()
            .map(|value| match value {
                Value::Null => Value::Text(NULL_GROUP_LABEL.to_owned()),
                other => other.clone(),
            })
            .collect();
        for (slot, agg) in aggregations.iter().enumerate() {
            let empty: Vec<Value> = Vec::new();
            let values = if agg.column.is_some() { &group.values[slot] } else { &empty };
            line.push(aggregate_values(agg.func, values, &group.rows, node_name, &agg.output)?);
        }
        rows.push(line);
    }

    let mut stats = vec![
        format!("输入 {} 行 → 输出 {} 组", input.rows.len(), groups.len()),
        format!(
            "聚合配置：{}",
            aggregations
                .iter()
                .map(|agg| format!("{}（{}）", agg.output, agg.func))
                .collect::<Vec<_>>()
                .join("、")
        ),
    ];
    if null_group_rows > 0 {
        stats.push(format!(
            "空值键 {null_group_rows} 行归入「{NULL_GROUP_LABEL}」组（空文本是另一个值）"
        ));
    }
    stats.push(
        "求和/平均/最小/最大跳过空值，全空返回空值；平均以有效值数量为分母；\
         本节点不做隐式舍入（ROUND 仅在公式节点）"
            .to_owned(),
    );
    if config.group_by.is_empty() {
        stats.push("未设置分组字段：全表作为一组（默认裁定第 15 条）".to_owned());
    }
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    Ok(outcome)
}

/// 单组聚合计算。`all_rows` 为该组总行数（countAll 用）。
fn aggregate_values(
    func: &str,
    values: &[Value],
    all_rows: &usize,
    node_name: &str,
    output: &str,
) -> Result<Value, AppError> {
    let non_null: Vec<&Value> = values.iter().filter(|value| !matches!(value, Value::Null)).collect();
    match func {
        "总行数" => Ok(Value::Int(*all_rows as i64)),
        "非空计数" => Ok(Value::Int(non_null.len() as i64)),
        "去重计数" => {
            let mut keys = std::collections::HashSet::new();
            for value in &non_null {
                keys.insert(composite_key(std::slice::from_ref(value)));
            }
            Ok(Value::Int(keys.len() as i64))
        }
        "求和" => {
            let mut total: Option<Dec> = None;
            let mut all_int = true;
            for value in &non_null {
                let number = numeric_of(value);
                all_int = all_int && matches!(value, Value::Int(_));
                total = Some(match total {
                    None => number,
                    Some(current) => current
                        .checked_add(number)
                        .map_err(|error| sum_overflow(node_name, output, error))?,
                });
            }
            Ok(match total {
                None => Value::Null,
                // 全整数的求和保持整数类型（Dec 求和过程 scale 恒为 0）；
                // 尾数超出 i64 范围时回落为十进制值，不静默截断。
                Some(number) if all_int && number.scale() == 0 => match i64::try_from(number.mantissa()) {
                    Ok(total) => Value::Int(total),
                    Err(_) => Value::Dec(number),
                },
                Some(number) => Value::Dec(number),
            })
        }
        "平均" => {
            if non_null.is_empty() {
                return Ok(Value::Null);
            }
            let mut total = Dec::from_i64(0);
            for value in &non_null {
                total = total
                    .checked_add(numeric_of(value))
                    .map_err(|error| sum_overflow(node_name, output, error))?;
            }
            let denominator = Dec::from_i64(non_null.len() as i64);
            let average = total
                .checked_div(denominator)
                .map_err(|error| structural("DATAFLOW_ROW_ERROR", format!("计算平均时{error}。")))?;
            Ok(Value::Dec(average))
        }
        "最小" | "最大" => {
            let mut best: Option<&Value> = None;
            for value in &non_null {
                best = Some(match best {
                    None => value,
                    Some(current) => {
                        let order = compare_values(value, current)
                            .unwrap_or_else(|| value.to_display().cmp(&current.to_display()));
                        let take = if func == "最小" {
                            order == std::cmp::Ordering::Less
                        } else {
                            order == std::cmp::Ordering::Greater
                        };
                        if take {
                            value
                        } else {
                            current
                        }
                    }
                });
            }
            Ok(best.map(|value| (*value).clone()).unwrap_or(Value::Null))
        }
        other => Err(config_error(
            "汇总",
            node_name,
            format!("聚合方式“{other}”无法识别。"),
        )),
    }
}

fn sum_overflow(node_name: &str, output: &str, error: String) -> AppError {
    structural(
        "DATAFLOW_ROW_ERROR",
        format!("节点「{node_name}」计算“{output}”时{error}。"),
    )
}

fn numeric_of(value: &Value) -> Dec {
    match value {
        Value::Int(number) => Dec::from_i64(*number),
        Value::Dec(number) => *number,
        _ => Dec::from_i64(0),
    }
}

// ---------------------------------------------------------------------------
// 透视 Crosstab
// ---------------------------------------------------------------------------

pub(crate) fn run_crosstab(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: CrosstabConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("透视", node_name, error.to_string()))?;
    if config.row_field.trim().is_empty() {
        return Err(config_error("透视", node_name, "必须选择行字段。".into()));
    }
    if config.column_field.trim().is_empty() {
        return Err(config_error("透视", node_name, "必须选择列字段（首版只支持 1 个）。".into()));
    }
    if config.value_field.trim().is_empty() {
        return Err(config_error("透视", node_name, "必须选择值字段。".into()));
    }
    let value_func = config.value_func.as_deref().unwrap_or("sum");
    let func_display = match value_func {
        "sum" => "求和",
        "countNonEmpty" => "非空计数",
        "distinctCount" => "去重计数",
        other => {
            return Err(config_error(
                "透视",
                node_name,
                format!("聚合方式“{other}”无法识别（透视支持 sum / countNonEmpty / distinctCount）。"),
            ));
        }
    };
    let index = input.column_index();
    let column_of = |name: &str| -> Result<usize, AppError> {
        index
            .get(name.trim())
            .copied()
            .ok_or_else(|| {
                structural(
                    "DATAFLOW_FIELD_MISSING",
                    format!(
                        "节点「{node_name}」的字段“{name}”不存在。可用字段：{}。",
                        input.columns.join("、")
                    ),
                )
            })
    };
    let row_column = column_of(&config.row_field)?;
    let column_column = column_of(&config.column_field)?;
    let value_column = column_of(&config.value_field)?;
    if value_func == "sum" && !matches!(input.types[value_column], ColType::Integer | ColType::Decimal) {
        return Err(config_error(
            "透视",
            node_name,
            format!(
                "值字段“{}”是{}，求和仅适用于数值字段。",
                config.value_field,
                input.types[value_column].display()
            ),
        ));
    }

    // 填充值：数字（默认 0）或 null。
    let fill: Value = match &config.fill {
        Json::Null => Value::Null,
        Json::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Value::Int(integer)
            } else {
                Dec::parse(&number.to_string())
                    .map(Value::Dec)
                    .map_err(|error| config_error("透视", node_name, format!("填充值{error}。")))?
            }
        }
        other => {
            return Err(config_error(
                "透视",
                node_name,
                format!("缺失组合填充值只支持数字或空值（收到 {other}）。"),
            ));
        }
    };

    // 行键与列键按首次出现顺序；单元格收集值。
    let mut row_order: Vec<Value> = Vec::new();
    let mut row_seen: HashMap<String, usize> = HashMap::new();
    let mut column_order: Vec<Value> = Vec::new();
    let mut column_seen: HashMap<String, usize> = HashMap::new();
    let mut cells: HashMap<(usize, usize), Vec<Value>> = HashMap::new();
    let display = |value: &Value| -> String {
        match value {
            Value::Null => NULL_GROUP_LABEL.to_owned(),
            other => other.to_display(),
        }
    };
    for row in &input.rows {
        let row_key = &row[row_column];
        let column_key = &row[column_column];
        let row_position = match row_seen.get(&composite_key(std::slice::from_ref(row_key))) {
            Some(&position) => position,
            None => {
                let position = row_order.len();
                row_seen.insert(composite_key(std::slice::from_ref(row_key)), position);
                row_order.push(row_key.clone());
                position
            }
        };
        let column_position = match column_seen.get(&composite_key(std::slice::from_ref(column_key))) {
            Some(&position) => position,
            None => {
                let position = column_order.len();
                column_seen.insert(composite_key(std::slice::from_ref(column_key)), position);
                column_order.push(column_key.clone());
                position
            }
        };
        cells
            .entry((row_position, column_position))
            .or_default()
            .push(row[value_column].clone());
    }
    if column_order.len() > CROSSTAB_MAX_COLUMNS {
        return Err(structural(
            "DATAFLOW_CROSSTAB_COLUMN_LIMIT",
            format!(
                "节点「{node_name}」透视动态列数（{}）超过上限 {CROSSTAB_MAX_COLUMNS}，\
                 已明确停止、不静默丢列。请先筛选列字段取值或改用汇总+导出。",
                column_order.len()
            ),
        ));
    }

    // 动态列名＝列字段值文本；不同键产生相同列名时明确报错（不静默合并）。
    let row_field_name = input.columns[row_column].clone();
    let mut columns = vec![row_field_name.clone()];
    let mut names: Vec<String> = Vec::with_capacity(column_order.len());
    for key in &column_order {
        let name = display(key);
        if name == row_field_name || names.contains(&name) {
            return Err(structural(
                "DATAFLOW_CROSSTAB_NAME_CONFLICT",
                format!(
                    "节点「{node_name}」透视动态列名“{name}”与行字段或已有列名重复，\
                     请先处理列字段取值（如清洗或合并同名列值）。"
                ),
            ));
        }
        names.push(name);
    }
    columns.extend(names.iter().cloned());

    // 列类型：求和→数值；计数→整数；全空列按值字段类型。
    let cell_type = match value_func {
        "sum" => input.types[value_column],
        _ => ColType::Integer,
    };
    let fill_aligned = if matches!(fill, Value::Null) {
        Value::Null
    } else if cell_type == ColType::Decimal && matches!(fill, Value::Int(_)) {
        match &fill {
            Value::Int(number) => Value::Dec(Dec::from_i64(*number)),
            other => other.clone(),
        }
    } else {
        fill.clone()
    };
    let mut types = vec![input.types[row_column]];
    types.extend(std::iter::repeat(cell_type).take(column_order.len()));

    // 组装单元格；缺失组合填 fill。
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(row_order.len());
    let mut filled_cells = 0usize;
    for (row_position, row_key) in row_order.iter().enumerate() {
        let mut line = vec![match row_key {
            Value::Null => Value::Text(NULL_GROUP_LABEL.to_owned()),
            other => other.clone(),
        }];
        for column_position in 0..column_order.len() {
            match cells.get(&(row_position, column_position)) {
                Some(values) => {
                    let group_rows = values.len();
                    line.push(aggregate_values(func_display, values, &group_rows, node_name, "透视单元格")?);
                }
                None => {
                    line.push(fill_aligned.clone());
                    filled_cells += 1;
                }
            }
        }
        rows.push(line);
    }

    let mut stats = vec![
        format!(
            "输入 {} 行 → 输出 {} 行 × {} 列（行字段 {}、列字段 {}、聚合 {}）",
            input.rows.len(),
            rows.len(),
            column_order.len() + 1,
            config.row_field,
            config.column_field,
            func_display
        ),
        format!("缺失组合填充单元格：{filled_cells} 个（填充值：{}）", fill_display(&fill_aligned)),
    ];
    stats.push("动态列名＝列字段值文本（空值列名显示「（空）」）；列数上限 1000".to_owned());
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    Ok(outcome)
}

fn fill_display(fill: &Value) -> String {
    match fill {
        Value::Null => "空值".to_owned(),
        other => other.to_display(),
    }
}

// ---------------------------------------------------------------------------
// 宽转长 Transpose
// ---------------------------------------------------------------------------

pub(crate) fn run_transpose(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: TransposeConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("宽转长", node_name, error.to_string()))?;
    let index = input.column_index();
    if config.value_columns.is_empty() {
        return Err(config_error("宽转长", node_name, "至少选择 1 个转入行的列。".into()));
    }
    let name_column = if config.name_column.trim().is_empty() {
        "项目".to_owned()
    } else {
        config.name_column.trim().to_owned()
    };
    let value_column = if config.value_column.trim().is_empty() {
        "数值".to_owned()
    } else {
        config.value_column.trim().to_owned()
    };
    if name_column == value_column {
        return Err(config_error(
            "宽转长",
            node_name,
            format!("新列名“{name_column}”重复（记录原列名的列与记录取值的列不能同名）。"),
        ));
    }
    let mut fixed_columns = Vec::new();
    for field in &config.fixed_fields {
        let Some(&column) = index.get(field) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的保持列“{field}”不存在。可用字段：{}。",
                    input.columns.join("、")
                ),
            ));
        };
        fixed_columns.push(column);
    }
    let mut value_columns = Vec::new();
    for field in &config.value_columns {
        if config.fixed_fields.contains(field) {
            return Err(config_error(
                "宽转长",
                node_name,
                format!("列“{field}”不能同时出现在保持列与转入列中。"),
            ));
        }
        let Some(&column) = index.get(field) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的转入列“{field}”不存在。可用字段：{}。",
                    input.columns.join("、")
                ),
            ));
        };
        value_columns.push(column);
    }
    for fixed in &config.fixed_fields {
        if fixed == &name_column || fixed == &value_column {
            return Err(config_error(
                "宽转长",
                node_name,
                format!("新列名“{name_column}/{value_column}”不能与保持列“{fixed}”重名。"),
            ));
        }
    }

    // 取值列类型统一：同类型保持；整数+十进制 → 十进制；其他混搭 → 文本。
    let mut value_type: Option<ColType> = None;
    for &column in &value_columns {
        let kind = input.types[column];
        value_type = Some(match value_type {
            None => kind,
            Some(current) if current == kind => current,
            Some(current) if matches!((current, kind), (ColType::Integer, ColType::Decimal))
                || matches!((current, kind), (ColType::Decimal, ColType::Integer)) =>
            {
                ColType::Decimal
            }
            Some(_) => ColType::Text,
        });
    }
    let value_type = value_type.unwrap_or(ColType::Text);
    let convert = |value: Value| -> Value {
        match (&value, value_type) {
            (Value::Null, _) => Value::Null,
            (Value::Int(number), ColType::Decimal) => Value::Dec(Dec::from_i64(*number)),
            (Value::Int(_) | Value::Dec(_), ColType::Integer) => value,
            (Value::Int(_) | Value::Dec(_) | Value::Date(_) | Value::Bool(_), ColType::Text) => {
                Value::Text(value.to_display())
            }
            _ => value,
        }
    };

    let total_rows = input.rows.len().saturating_mul(value_columns.len());
    if total_rows > MAX_TABLE_ROWS {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」宽转长后行数（{total_rows} = 输入 {} 行 × 转入 {} 列）\
                 超出内网上限（{MAX_TABLE_ROWS} 行）。",
                input.rows.len(),
                value_columns.len()
            ),
        ));
    }
    let mut columns: Vec<String> = config.fixed_fields.clone();
    columns.push(name_column.clone());
    columns.push(value_column.clone());
    let mut types: Vec<ColType> = fixed_columns.iter().map(|&column| input.types[column]).collect();
    types.push(ColType::Text);
    types.push(value_type);
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(total_rows);
    for row in &input.rows {
        for &column in &value_columns {
            let mut line: Vec<Value> = fixed_columns.iter().map(|&fixed| row[fixed].clone()).collect();
            line.push(Value::Text(input.columns[column].clone()));
            line.push(convert(row[column].clone()));
            rows.push(line);
        }
    }

    let stats = vec![
        format!(
            "输入 {} 行 × 转入 {} 列 → 输出 {} 行（核对一致：{}）",
            input.rows.len(),
            value_columns.len(),
            rows.len(),
            if rows.len() == total_rows { "是" } else { "否" }
        ),
        format!(
            "保持列：{}；记录原列名的列「{name_column}」、记录取值的列「{value_column}」",
            if config.fixed_fields.is_empty() {
                "（无）".to_owned()
            } else {
                config.fixed_fields.join("、")
            }
        ),
    ];
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    Ok(outcome)
}
