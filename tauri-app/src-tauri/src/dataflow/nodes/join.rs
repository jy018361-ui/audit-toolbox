//! 关联 Join（join_n）：两表按一个或多个字段配对，固定输出
//! J（匹配）/ L（左未匹配）/ R（右未匹配）三路。
//!
//! 设计文档第 4 节「Join 输出约定」与默认裁定第 6 条：
//! - J 仅含匹配成功的组合：同一键左 3 条 × 右 4 条 = 12 条笛卡尔积，
//!   不自动挑一条、不自动去重；重复键与膨胀统计进 stats；
//! - 复合键任一字段为空值时不匹配（空文本按具体值参与匹配）；
//! - 左右键类型不一致（文本 vs 数值等）中文报错要求修正，不静默互转；
//! - 同名字段右侧加 sameNameSuffix（默认 _右），加后缀仍重名则报错；
//! - L/R 按统一输出字段集补空值（L 补右字段空、R 补左字段空），
//!   便于与字段选择、纵向合并组合出左/右/全关联。

use super::{config_error, structural, NodeOutcome, Table, MAX_TABLE_ROWS};
use crate::dataflow::model::JoinConfig;
use crate::dataflow::value::{ColType, Value};
use crate::AppError;
use serde_json::Value as Json;
use std::collections::HashMap;

/// 键类型类别：同类别才允许配对（整数与十进制同属数值，可精确相等）。
fn key_class(kind: ColType) -> &'static str {
    match kind {
        ColType::Text => "文本",
        ColType::Integer | ColType::Decimal => "数值",
        ColType::Date => "日期",
        ColType::Bool => "布尔",
    }
}

/// 一行的复合键；任一键字段为空值 → None（不参与匹配）。
fn row_key(row: &[Value], columns: &[usize]) -> Option<String> {
    let mut key = String::new();
    for (index, &column) in columns.iter().enumerate() {
        let value = &row[column];
        if matches!(value, Value::Null) {
            return None;
        }
        if index > 0 {
            key.push('\u{1}');
        }
        match value {
            Value::Bool(flag) => key.push_str(&format!("B:{flag}")),
            Value::Int(number) => key.push_str(&format!("N:{number}e0")),
            Value::Dec(number) => {
                // 数值相等归一：5.0 与 5 同键（去 mantissa 尾零后的最短形式）。
                let mut mantissa = number.mantissa();
                let mut scale = number.scale();
                while scale > 0 && mantissa % 10 == 0 {
                    mantissa /= 10;
                    scale -= 1;
                }
                key.push_str(&format!("N:{mantissa}e{scale}"));
            }
            Value::Text(text) => {
                key.push('T');
                key.push_str(text);
            }
            Value::Date(date) => key.push_str(&format!("D:{}", date.format("%Y-%m-%d"))),
            Value::Null => unreachable!("空值已在上方排除"),
        }
    }
    Some(key)
}

pub(crate) fn run_join(
    node_name: &str,
    config: &Json,
    left: &Table,
    right: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: JoinConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("关联", node_name, error.to_string()))?;
    if config.keys.is_empty() {
        return Err(config_error("关联", node_name, "至少需要 1 对关联字段。".into()));
    }
    if config.same_name_suffix.trim().is_empty() {
        return Err(config_error("关联", node_name, "同名字段后缀不能为空。".into()));
    }
    let left_index = left.column_index();
    let right_index = right.column_index();

    // 关联字段存在性与类型一致性（文本 vs 数值不静默互转）。
    for pair in &config.keys {
        let Some(&left_column) = left_index.get(&pair.left) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的关联字段“{}”在左表中不存在。左表字段：{}。",
                    pair.left,
                    left.columns.join("、")
                ),
            ));
        };
        let Some(&right_column) = right_index.get(&pair.right) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的关联字段“{}”在右表中不存在。右表字段：{}。",
                    pair.right,
                    right.columns.join("、")
                ),
            ));
        };
        let left_class = key_class(left.types[left_column]);
        let right_class = key_class(right.types[right_column]);
        if left_class != right_class {
            return Err(structural(
                "DATAFLOW_JOIN_KEY_TYPE_MISMATCH",
                format!(
                    "节点「{node_name}」的关联字段类型不一致：左表“{}”是{}（{}），\
                     右表“{}”是{}（{}）。请先在上游统一类型（如用公式转换），\
                     本节点不做自动互转。",
                    pair.left,
                    left_class,
                    left.types[left_column].display(),
                    pair.right,
                    right_class,
                    right.types[right_column].display()
                ),
            ));
        }
    }

    // 输出字段：空 = 全部保留；同名字段右侧加后缀；加后缀仍重名报错。
    let pick_fields = |table: &Table, wanted: &[String], side: &str| -> Result<Vec<usize>, AppError> {
        if wanted.is_empty() {
            return Ok((0..table.columns.len()).collect());
        }
        let index = table.column_index();
        let mut picked = Vec::new();
        for name in wanted {
            let Some(&column) = index.get(name) else {
                return Err(structural(
                    "DATAFLOW_FIELD_MISSING",
                    format!(
                        "节点「{node_name}」的{side}侧输出字段“{name}”不存在。可用字段：{}。",
                        table.columns.join("、")
                    ),
                ));
            };
            picked.push(column);
        }
        Ok(picked)
    };
    let left_pick = pick_fields(left, &config.left_fields, "左")?;
    let right_pick = pick_fields(right, &config.right_fields, "右")?;

    let mut columns: Vec<String> = Vec::new();
    let mut left_slots: Vec<usize> = Vec::new();
    for &column in &left_pick {
        let name = left.columns[column].clone();
        if columns.contains(&name) {
            return Err(config_error(
                "关联",
                node_name,
                format!("左表输出字段“{name}”重复，请检查字段清单。"),
            ));
        }
        columns.push(name);
        left_slots.push(column);
    }
    let mut right_slots: Vec<usize> = Vec::new();
    for &column in &right_pick {
        let mut name = right.columns[column].clone();
        if columns.contains(&name) {
            name = format!("{name}{}", config.same_name_suffix);
            if columns.contains(&name) {
                return Err(structural(
                    "DATAFLOW_JOIN_NAME_CONFLICT",
                    format!(
                        "节点「{node_name}」的右侧字段“{}”加后缀“{}”后仍与现有输出字段重名，\
                         请减少一侧的输出字段或调整后缀。",
                        right.columns[column],
                        config.same_name_suffix
                    ),
                ));
            }
        }
        columns.push(name);
        right_slots.push(column);
    }
    let types: Vec<ColType> = left_slots
        .iter()
        .map(|&column| left.types[column])
        .chain(right_slots.iter().map(|&column| right.types[column]))
        .collect();
    let left_width = left_slots.len();
    let width = columns.len();

    // 右表索引：键 → 行号列表（空值键不建索引，永不匹配）。
    let right_key_columns: Vec<usize> = config.keys.iter().map(|pair| right_index[&pair.right]).collect();
    let mut right_map: HashMap<String, Vec<usize>> = HashMap::new();
    let mut right_null_keys = 0usize;
    for (ordinal, row) in right.rows.iter().enumerate() {
        match row_key(row, &right_key_columns) {
            Some(key) => right_map.entry(key).or_default().push(ordinal),
            None => right_null_keys += 1,
        }
    }

    // 左表逐行匹配：J = 笛卡尔积组合；未匹配进 L（右字段补空值）。
    let left_key_columns: Vec<usize> = config.keys.iter().map(|pair| left_index[&pair.left]).collect();
    let mut left_counts: HashMap<String, usize> = HashMap::new();
    let mut left_null_keys = 0usize;
    for row in &left.rows {
        match row_key(row, &left_key_columns) {
            Some(key) => *left_counts.entry(key).or_default() += 1,
            None => left_null_keys += 1,
        }
    }

    let mut j_rows: Vec<Vec<Value>> = Vec::new();
    let mut l_rows: Vec<Vec<Value>> = Vec::new();
    let mut left_matched_rows = 0usize;
    for row in &left.rows {
        let key = row_key(row, &left_key_columns);
        let matched = key.as_deref().and_then(|key| right_map.get(key));
        match matched {
            Some(partners) if !partners.is_empty() => {
                left_matched_rows += 1;
                let mut combined: Vec<Value> = left_slots
                    .iter()
                    .map(|&column| row[column].clone())
                    .collect();
                combined.resize(width, Value::Null);
                for &partner in partners {
                    let mut line = combined.clone();
                    for (slot, &column) in right_slots.iter().enumerate() {
                        line[left_width + slot] = right.rows[partner][column].clone();
                    }
                    j_rows.push(line);
                }
            }
            _ => {
                let mut line: Vec<Value> = left_slots.iter().map(|&column| row[column].clone()).collect();
                line.resize(width, Value::Null);
                l_rows.push(line);
            }
        }
    }
    if j_rows.len() > MAX_TABLE_ROWS {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」的 J 路（匹配）行数（{}）超出内网上限（{MAX_TABLE_ROWS} 行），\
                 多对多组合膨胀明显超出资源预算。请先去重关联键或缩小数据范围。",
                j_rows.len()
            ),
        ));
    }

    // 右表未匹配行 → R（左字段补空值）。空值键的右侧行一律未匹配。
    let mut right_matched = vec![false; right.rows.len()];
    for (key, partners) in &right_map {
        if left_counts.contains_key(key) {
            for &partner in partners {
                right_matched[partner] = true;
            }
        }
    }
    let mut r_rows: Vec<Vec<Value>> = Vec::new();
    for (ordinal, row) in right.rows.iter().enumerate() {
        if right_matched[ordinal] {
            continue;
        }
        let mut line: Vec<Value> = vec![Value::Null; left_width];
        line.extend(right_slots.iter().map(|&column| row[column].clone()));
        r_rows.push(line);
    }

    // 重复键膨胀统计（左行数 vs J 行数对比与原因）。
    let mut stats = vec![
        format!("左表输入：{} 行", left.rows.len()),
        format!("右表输入：{} 行", right.rows.len()),
        format!(
            "J（匹配）：{} 行；L（左未匹配）：{} 行；R（右未匹配）：{} 行",
            j_rows.len(),
            l_rows.len(),
            r_rows.len()
        ),
    ];
    let mut dup_left_keys = 0usize;
    let mut dup_right_keys = 0usize;
    let mut max_left = 1usize;
    let mut max_right = 1usize;
    for (key, partners) in &right_map {
        if partners.len() > 1 {
            dup_right_keys += 1;
            max_right = max_right.max(partners.len());
        }
        if let Some(count) = left_counts.get(key) {
            if *count > 1 {
                dup_left_keys += 1;
                max_left = max_left.max(*count);
            }
        }
    }
    if j_rows.len() > left_matched_rows || dup_left_keys > 0 || dup_right_keys > 0 {
        stats.push(format!(
            "重复键膨胀提示：J 路 {} 行 > 左表参与匹配的 {} 行——源于多对多键\
             （左表重复键 {} 个、右表重复键 {} 个，最大单键组合 {}×{}={} 行）；\
             多对多不做逐条配对、不自动挑一条、不自动去重",
            j_rows.len(),
            left_matched_rows,
            dup_left_keys,
            dup_right_keys,
            max_left,
            max_right,
            max_left * max_right
        ));
    } else {
        stats.push(format!(
            "无重复键膨胀：J 路行数（{}）= 左表匹配行数（{}）",
            j_rows.len(),
            left_matched_rows
        ));
    }
    if left_null_keys + right_null_keys > 0 {
        stats.push(format!(
            "空值键 {} 行（左 {} / 右 {}）不参与匹配，分别进入 L / R 路",
            left_null_keys + right_null_keys,
            left_null_keys,
            right_null_keys
        ));
    }
    stats.push(format!(
        "同名字段处理：右侧重名字段加后缀“{}”；L/R 路按统一字段集补空值，\
         可用「字段选择＋纵向合并」组合出左/右/全关联",
        config.same_name_suffix
    ));

    let j_count = j_rows.len();
    let l_count = l_rows.len();
    let r_count = r_rows.len();
    let outcome = NodeOutcome {
        anchors: vec![
            ("J".to_owned(), Table { columns: columns.clone(), types: types.clone(), rows: j_rows }),
            ("L".to_owned(), Table { columns: columns.clone(), types: types.clone(), rows: l_rows }),
            ("R".to_owned(), Table { columns, types, rows: r_rows }),
        ],
        messages: Vec::new(),
        stats,
        written: Vec::new(),
        rows: j_count + l_count + r_count,
        has_warnings: false,
    };
    Ok(outcome)
}
