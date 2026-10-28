//! 第二期分列节点（split）：把一列按分隔符或固定宽度拆成多列。
//!
//! 默认裁定第 14 条与本任务契约：
//! - 列名＝（columnPrefix 或原字段名）+_1..n；
//! - 段数不足补空值；超出部分并入最后一段（不丢内容）；
//! - 拆出列数上限 20（分隔符模式超过 20 段时第 20 列吸收余下内容；
//!   固定宽度模式 widths 不得超过 20 段）；
//! - 固定宽度按 widths 逐段切（按字符切，不切断多字节文本）；
//! - keepOriginal=true 时保留原列（拆出列追加在表尾）。

use super::{config_error, structural, NodeOutcome, Table};
use crate::dataflow::model::SplitConfig;
use crate::dataflow::value::Value;
use crate::AppError;
use serde_json::Value as Json;

/// 拆出列数上限（默认裁定第 14 条）。
const SPLIT_MAX_COLUMNS: usize = 20;

pub(crate) fn run_split(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: SplitConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("分列", node_name, error.to_string()))?;
    if config.field.trim().is_empty() {
        return Err(config_error("分列", node_name, "必须选择源列。".into()));
    }
    let mode = config.mode.as_deref().unwrap_or("delimiter");
    if mode != "delimiter" && mode != "fixedWidth" {
        return Err(config_error(
            "分列",
            node_name,
            format!("拆分方式“{mode}”无法识别（应为 delimiter 按分隔符 / fixedWidth 按固定宽度）。"),
        ));
    }
    let Some(&source_column) = input.column_index().get(config.field.trim()) else {
        return Err(structural(
            "DATAFLOW_FIELD_MISSING",
            format!(
                "节点「{node_name}」的分列源字段“{}”不存在。可用字段：{}。",
                config.field,
                input.columns.join("、")
            ),
        ));
    };
    let base = if config.column_prefix.trim().is_empty() {
        config.field.trim().to_owned()
    } else {
        config.column_prefix.trim().to_owned()
    };

    // 预拆分每行（返回 None 表示原值为空值）。
    let segments_of = |value: &Value| -> Option<Vec<String>> {
        let text = match value {
            Value::Null => return None,
            Value::Text(text) => text.clone(),
            other => other.to_display(),
        };
        Some(match mode {
            "delimiter" => text.split(&config.delimiter).map(str::to_owned).collect(),
            _ => {
                let mut segments = Vec::with_capacity(config.widths.len());
                let characters: Vec<char> = text.chars().collect();
                let mut position = 0usize;
                for (ordinal, &width) in config.widths.iter().enumerate() {
                    if ordinal + 1 == config.widths.len() {
                        // 最后一段吸收剩余全部字符（超出并入最后一段，不丢内容）。
                        segments.push(characters[position.min(characters.len())..].iter().collect());
                    } else {
                        let end = (position + width).min(characters.len());
                        segments.push(characters[position.min(end)..end].iter().collect());
                        position = end;
                    }
                }
                segments
            }
        })
    };

    // 参数校验。
    if mode == "delimiter" && config.delimiter.is_empty() {
        return Err(config_error("分列", node_name, "按分隔符拆分时必须填写分隔符。".into()));
    }
    if mode == "fixedWidth" {
        if config.widths.is_empty() {
            return Err(config_error("分列", node_name, "按固定宽度拆分时至少设置 1 段宽度。".into()));
        }
        if config.widths.len() > SPLIT_MAX_COLUMNS {
            return Err(config_error(
                "分列",
                node_name,
                format!("固定宽度段数（{}）超过上限 {SPLIT_MAX_COLUMNS} 段。", config.widths.len()),
            ));
        }
        if config.widths.iter().any(|&width| width == 0) {
            return Err(config_error("分列", node_name, "固定宽度每段必须为正整数。".into()));
        }
    }

    // 逐行拆分，确定列数（分隔符模式取全局最大段数，上限 20）。
    let mut parsed: Vec<Option<Vec<String>>> = Vec::with_capacity(input.rows.len());
    let mut max_segments = 0usize;
    let mut over_limit_rows = 0usize;
    for row in &input.rows {
        let segments = segments_of(&row[source_column]);
        if let Some(segments) = &segments {
            max_segments = max_segments.max(segments.len());
        }
        parsed.push(segments);
    }
    let column_count = match mode {
        "delimiter" => max_segments.min(SPLIT_MAX_COLUMNS),
        _ => config.widths.len(),
    };
    if column_count == 0 {
        return Err(config_error(
            "分列",
            node_name,
            "未拆出任何列（源列全部为空值时请检查数据，或改用固定宽度模式）。".into(),
        ));
    }
    for segments in &parsed {
        if let Some(segments) = segments {
            if segments.len() > SPLIT_MAX_COLUMNS {
                over_limit_rows += 1;
            }
        }
    }

    // 新列命名与冲突检查。
    let mut columns = input.columns.clone();
    if !config.keep_original {
        columns.remove(source_column);
    }
    let new_names: Vec<String> = (1..=column_count)
        .map(|ordinal| format!("{base}_{ordinal}"))
        .collect();
    for name in &new_names {
        if columns.contains(name) {
            return Err(structural(
                "DATAFLOW_FIELD_DUPLICATE",
                format!(
                    "节点「{node_name}」拆出列名“{name}”与现有字段重名，请调整列名前缀。"
                ),
            ));
        }
    }
    columns.extend(new_names.iter().cloned());
    let mut types = input.types.clone();
    if !config.keep_original {
        types.remove(source_column);
    }
    types.extend(std::iter::repeat(crate::dataflow::value::ColType::Text).take(column_count));

    // 组装行：keepOriginal=true 保留原值（原列位置不变，拆出列追加表尾）；
    // false 时移除原列。段数不足补空值；超出并入最后一段。
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(input.rows.len());
    for (ordinal, row) in input.rows.iter().enumerate() {
        let mut line: Vec<Value> = row.clone();
        let segments = &parsed[ordinal];
        let pieces: Vec<Value> = match segments {
            None => vec![Value::Null; column_count],
            Some(segments) => {
                let mut pieces: Vec<Value> = Vec::with_capacity(column_count);
                for index in 0..column_count {
                    if index + 1 == column_count && segments.len() > column_count {
                        // 超出部分并入最后一段（含原分隔符，不丢内容）。
                        let merged = segments[column_count - 1..].join(&config.delimiter);
                        pieces.push(Value::Text(merged));
                    } else {
                        pieces.push(
                            segments
                                .get(index)
                                .map(|text| Value::Text(text.clone()))
                                .unwrap_or(Value::Null),
                        );
                    }
                }
                pieces
            }
        };
        if config.keep_original {
            line.extend(pieces);
        } else {
            line.remove(source_column);
            line.extend(pieces);
        }
        rows.push(line);
    }

    let mut stats = vec![
        format!("进出行数相同：{}", input.rows.len()),
        format!(
            "拆分方式：{}；拆出 {} 列（{}..{}）；{}",
            if mode == "delimiter" { "按分隔符" } else { "按固定宽度" },
            column_count,
            new_names.first().map(String::as_str).unwrap_or(""),
            new_names.last().map(String::as_str).unwrap_or(""),
            if config.keep_original {
                "保留原列（拆出列追加在表尾）".to_owned()
            } else {
                "原列由拆出列取代".to_owned()
            }
        ),
    ];
    if over_limit_rows > 0 {
        stats.push(format!(
            "有 {over_limit_rows} 行拆分段数超过 {SPLIT_MAX_COLUMNS}，超出部分已并入最后一段（不丢内容）"
        ));
    }
    stats.push("段数不足的行按空值补齐；空值原值整行拆出列均为空值".to_owned());
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    Ok(outcome)
}
