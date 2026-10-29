//! 第二期检查节点（check_n）：审计校验，通过 P / 未通过 NG 两路 +
//! 规则执行摘要。
//!
//! 五种规则（设计文档第 4 节、默认裁定第 10 条）：
//! - balance 借贷合计一致：全表或按分组（如凭证号）；借方合计与贷方合计
//!   之差的绝对值 > 容差 → 未通过；容差必须显式配置；未通过组内所有记录
//!   进 NG（全表规则失败时全部输入记录进 NG）；
//! - notEmpty 关键字段非空：空值与纯空格文本都算空（从严口径）；
//! - unique 编号唯一：全表或分组内唯一；空值不参与唯一性；重复记录整组
//!   进 NG；
//! - range 数值区间：闭区间（≥下限且 ≤上限）；空值判 NG 并标注「空值」；
//! - expression 自定义行级条件：公式求值器；结果为假或空值 → NG（与筛选
//!   「空值进 F 路」口径一致）。
//!
//! 输出附「检查结果」列写明违规原因（规则名+实际值）；空输入或无规则时
//! 摘要明确说明，不得显示为全部通过。

use super::{config_error, structural, NodeOutcome, RunContext, Table};
use crate::dataflow::formula::{self, EvalContext};
use crate::dataflow::model::{CheckConfig, CheckRule};
use crate::dataflow::nodes::keys::{compare_numeric, composite_key, is_blank};
use crate::dataflow::value::{ColType, Dec, Value};
use crate::AppError;
use serde_json::Value as Json;
use std::collections::HashMap;

/// 违规原因列的列名。
const RESULT_COLUMN: &str = "检查结果";

/// 规则默认名（配置可用 name 覆盖）。
fn default_rule_name(rule: &CheckRule) -> &'static str {
    match rule {
        CheckRule::Balance { .. } => "借贷合计一致",
        CheckRule::NotEmpty { .. } => "关键字段非空",
        CheckRule::Unique { .. } => "编号唯一",
        CheckRule::Range { .. } => "数值区间",
        CheckRule::Expression { .. } => "自定义条件",
    }
}

fn rule_name(rule: &CheckRule) -> String {
    rule.custom_name()
        .map(str::to_owned)
        .unwrap_or_else(|| default_rule_name(rule).to_owned())
}

impl CheckRule {
    fn custom_name(&self) -> Option<&str> {
        match self {
            CheckRule::Balance { name, .. }
            | CheckRule::NotEmpty { name, .. }
            | CheckRule::Unique { name, .. }
            | CheckRule::Range { name, .. }
            | CheckRule::Expression { name, .. } => name.as_deref(),
        }
    }
}

/// 解析容差/区间边界（JSON 数字或数字文本 → Dec）。
fn parse_dec(value: &Json, what: &str, node_name: &str) -> Result<Dec, AppError> {
    let text = match value {
        Json::Number(number) => number.to_string(),
        Json::String(text) => text.trim().to_owned(),
        other => {
            return Err(config_error(
                "检查",
                node_name,
                format!("{what}必须是数字（收到 {other}）。"),
            ));
        }
    };
    Dec::parse(&text).map_err(|error| config_error("检查", node_name, format!("{what}{error}。")))
}

/// 五种规则类型标识（前端 `type` 与手写 `kind` 均按此识别）。
const KNOWN_RULE_KINDS: [&str; 5] = ["balance", "notEmpty", "unique", "range", "expression"];

fn supported_rule_kinds_label() -> String {
    "借贷合计一致（balance）、关键字段非空（notEmpty）、编号唯一（unique）、\
     数值区间（range）、自定义条件（expression）"
        .to_owned()
}

/// 归一检查规则 JSON，消除前后端历史契约分叉后再交给 serde：
/// - 判别字段：`kind`（手写/历史形态）或 `type`（前端表单序列化形态），
///   统一写回 `kind`；
/// - 分组字段 `groupBy`：单个字符串（历史形态）或字符串数组（前端多选
///   形态），统一归一为去空白的字符串数组；
/// - 就地校验各字段形态，报错全部用中文（避免 serde 英文消息直达用户）。
fn canonicalize_config(config: &Json, node_name: &str) -> Result<Json, AppError> {
    let mut value = config.clone();
    let Some(object) = value.as_object_mut() else {
        return Err(config_error(
            "检查",
            node_name,
            "节点配置必须是对象（含 rules 规则数组）。".to_owned(),
        ));
    };
    let Some(rules) = object.get_mut("rules") else {
        // 缺省 rules ＝ 未配置规则：保留原值，走「未配置任何检查规则」摘要。
        return Ok(value);
    };
    let Json::Array(list) = rules else {
        return Err(config_error(
            "检查",
            node_name,
            "「rules」必须是检查规则数组。".to_owned(),
        ));
    };
    for (index, rule) in list.iter_mut().enumerate() {
        let ordinal = index + 1;
        let invalid = |detail: String| {
            config_error("检查", node_name, format!("第 {ordinal} 条检查规则{detail}"))
        };
        let Json::Object(fields) = rule else {
            return Err(invalid("必须是对象（字段集合）。".to_owned()));
        };
        let kind = match fields
            .get("kind")
            .and_then(Json::as_str)
            .or_else(|| fields.get("type").and_then(Json::as_str))
            .map(str::trim)
            .filter(|kind| !kind.is_empty())
        {
            Some(kind) => kind.to_owned(),
            None => {
                return Err(invalid(format!(
                    "缺少类型标识（kind 或 type），无法识别规则类型。支持的规则类型：{}。",
                    supported_rule_kinds_label()
                )))
            }
        };
        if !KNOWN_RULE_KINDS.contains(&kind.as_str()) {
            return Err(invalid(format!(
                "的规则类型「{kind}」无法识别。支持的规则类型：{}。",
                supported_rule_kinds_label()
            )));
        }
        fields.insert("kind".to_owned(), Json::String(kind.clone()));
        fields.remove("type");
        // 分组字段：单字符串 → 数组；数组逐项须为文本；剔除空白项。
        let group_by: Vec<String> = match fields.get("groupBy") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::String(text)) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    Vec::new()
                } else {
                    vec![trimmed.to_owned()]
                }
            }
            Some(Json::Array(items)) => {
                let mut group = Vec::new();
                for item in items {
                    let Some(text) = item.as_str() else {
                        return Err(invalid(
                            "的分组字段（groupBy）每一项都必须是文本。".to_owned(),
                        ));
                    };
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        group.push(trimmed.to_owned());
                    }
                }
                group
            }
            Some(_) => {
                return Err(invalid(
                    "的分组字段（groupBy）必须是文本或文本数组。".to_owned(),
                ))
            }
        };
        fields.insert(
            "groupBy".to_owned(),
            Json::Array(group_by.iter().map(|field| Json::String(field.clone())).collect()),
        );
        if let Some(name) = fields.get("name") {
            if !name.is_null() && !name.is_string() {
                return Err(invalid("的规则名（name）必须是文本。".to_owned()));
            }
        }
        // 逐类型校验必填字段形态，缺字段/类型不对直接给中文提示。
        match kind.as_str() {
            "balance" => {
                let labels = [("debitField", "借方金额字段（debitField）"), ("creditField", "贷方金额字段（creditField）")];
                for (key, label) in labels {
                    if !matches!(fields.get(key), Some(Json::String(_))) {
                        return Err(invalid(format!("（借贷合计一致）必须填写{label}。")));
                    }
                }
            }
            "notEmpty" => match fields.get("fields") {
                None | Some(Json::Null) => {}
                Some(Json::Array(items)) => {
                    if items.iter().any(|item| !item.is_string()) {
                        return Err(invalid("的字段清单（fields）每一项都必须是文本。".to_owned()));
                    }
                }
                Some(_) => return Err(invalid("的字段清单（fields）必须是文本数组。".to_owned())),
            },
            "unique" | "range" => {
                if let Some(field) = fields.get("field") {
                    if !field.is_null() && !field.is_string() {
                        return Err(invalid("的字段名（field）必须是文本。".to_owned()));
                    }
                }
            }
            "expression" => {
                if let Some(expression) = fields.get("expression") {
                    if !expression.is_null() && !expression.is_string() {
                        return Err(invalid("的条件表达式（expression）必须是文本。".to_owned()));
                    }
                }
            }
            other => unreachable!("上方已校验 kind ∈ 五种之内：{other}"),
        }
    }
    Ok(value)
}

/// 分组字段名清单 → 列号（剔除空白项；重复分组列去重且保持次序）。
fn resolve_group_columns(
    group_by: &[String],
    column_of: &dyn Fn(&str) -> Result<usize, AppError>,
) -> Result<Vec<usize>, AppError> {
    let mut columns = Vec::new();
    for field in group_by {
        let field = field.trim();
        if field.is_empty() {
            continue;
        }
        let column = column_of(field)?;
        if !columns.contains(&column) {
            columns.push(column);
        }
    }
    Ok(columns)
}

/// 组合分组键：分组列为空 = 全表一组（空串）；多列以复合键拼接。
fn group_key_of(group_by: &[usize], row: &[Value]) -> String {
    if group_by.is_empty() {
        String::new()
    } else {
        composite_key(&group_by.iter().map(|&column| row[column].clone()).collect::<Vec<_>>())
    }
}

pub(crate) fn run_check(
    node_name: &str,
    config: &Json,
    input: &Table,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let canonical = canonicalize_config(config, node_name)?;
    let config: CheckConfig = serde_json::from_value(canonical).map_err(|_| {
        // 归一已覆盖常见错误并给中文提示，此处兜底极端手工编辑场景。
        config_error(
            "检查",
            node_name,
            "规则字段形态无法解析，请在画布上重新配置该节点的检查规则。".to_owned(),
        )
    })?;
    let index = input.column_index();
    let column_of = |name: &str| -> Result<usize, AppError> {
        index
            .get(name)
            .copied()
            .ok_or_else(|| {
                structural(
                    "DATAFLOW_FIELD_MISSING",
                    format!(
                        "节点「{node_name}」的检查规则引用了字段“{name}”，但输入中没有该字段。可用字段：{}。",
                        input.columns.join("、")
                    ),
                )
            })
    };

    // 预处理规则：编译表达式、校验字段、解析数值。
    enum Prepared {
        Balance {
            name: String,
            group_by: Vec<usize>,
            debit: usize,
            credit: usize,
            tolerance: Dec,
        },
        NotEmpty { name: String, fields: Vec<(String, usize)> },
        Unique { name: String, field: (String, usize), group_by: Vec<usize> },
        Range {
            name: String,
            field: (String, usize),
            min: Option<Dec>,
            max: Option<Dec>,
        },
        Expression { name: String, expr: formula::Expr },
    }
    let mut prepared: Vec<Prepared> = Vec::new();
    for rule in &config.rules {
        match rule {
            CheckRule::Balance {
                name,
                group_by,
                debit_field,
                credit_field,
                tolerance,
            } => {
                let debit_field = debit_field.trim();
                let credit_field = credit_field.trim();
                if debit_field.is_empty() || credit_field.is_empty() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!(
                            "规则「{}」必须填写借方金额字段与贷方金额字段。",
                            rule_name(rule)
                        ),
                    ));
                }
                let debit = column_of(debit_field)?;
                let credit = column_of(credit_field)?;
                for (field, column) in [(debit_field, debit), (credit_field, credit)] {
                    if !matches!(input.types[column], ColType::Integer | ColType::Decimal) {
                        return Err(structural(
                            "DATAFLOW_CHECK_FIELD_TYPE",
                            format!(
                                "节点「{node_name}」的规则「{}」：借贷金额字段“{field}”必须是数值字段（当前：{}）。",
                                name.clone().unwrap_or_else(|| default_rule_name(rule).to_owned()),
                                input.types[column].display()
                            ),
                        ));
                    }
                }
                let Some(tolerance_json) = tolerance else {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!(
                            "规则「{}」必须显式填写容差（金额比较容差须写入配置）。",
                            rule_name(rule)
                        ),
                    ));
                };
                let tolerance = parse_dec(tolerance_json, "容差", node_name)?;
                prepared.push(Prepared::Balance {
                    name: rule_name(rule),
                    group_by: resolve_group_columns(group_by, &column_of)?,
                    debit,
                    credit,
                    tolerance,
                });
            }
            CheckRule::NotEmpty { name, fields } => {
                if fields.is_empty() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」至少选择 1 个字段。", rule_name(rule)),
                    ));
                }
                let mut columns = Vec::new();
                for field in fields {
                    columns.push((field.clone(), column_of(field)?));
                }
                prepared.push(Prepared::NotEmpty { name: rule_name(rule), fields: columns });
            }
            CheckRule::Unique { name, field, group_by } => {
                if field.trim().is_empty() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」必须选择字段。", rule_name(rule)),
                    ));
                }
                let column = column_of(field.trim())?;
                prepared.push(Prepared::Unique {
                    name: rule_name(rule),
                    field: (field.trim().to_owned(), column),
                    group_by: resolve_group_columns(group_by, &column_of)?,
                });
            }
            CheckRule::Range { name, field, min, max } => {
                if field.trim().is_empty() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」必须选择字段。", rule_name(rule)),
                    ));
                }
                let column = column_of(field.trim())?;
                if !matches!(input.types[column], ColType::Integer | ColType::Decimal) {
                    return Err(structural(
                        "DATAFLOW_CHECK_FIELD_TYPE",
                        format!(
                            "节点「{node_name}」的规则「{}」：数值区间只能用于数值字段，“{}”是{}。",
                            rule_name(rule),
                            field,
                            input.types[column].display()
                        ),
                    ));
                }
                if min.is_none() && max.is_none() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」至少填写下限或上限一边。", rule_name(rule)),
                    ));
                }
                let min = match min {
                    Some(value) => Some(parse_dec(value, "下限", node_name)?),
                    None => None,
                };
                let max = match max {
                    Some(value) => Some(parse_dec(value, "上限", node_name)?),
                    None => None,
                };
                prepared.push(Prepared::Range {
                    name: rule_name(rule),
                    field: (field.trim().to_owned(), column),
                    min,
                    max,
                });
            }
            CheckRule::Expression { name, expression } => {
                if expression.trim().is_empty() {
                    return Err(config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」必须填写条件表达式。", rule_name(rule)),
                    ));
                }
                let expr = formula::compile(expression).map_err(|error| {
                    config_error(
                        "检查",
                        node_name,
                        format!("规则「{}」的表达式语法错误：{error}", rule_name(rule)),
                    )
                })?;
                // 字段引用集中校验（结构性错误）。
                let mut referenced = Vec::new();
                formula::collect_fields(&expr, &mut referenced);
                let available: std::collections::HashSet<&str> =
                    input.columns.iter().map(String::as_str).collect();
                let missing: Vec<String> = referenced
                    .into_iter()
                    .filter(|field| !available.contains(field.as_str()))
                    .collect();
                if !missing.is_empty() {
                    return Err(structural(
                        "DATAFLOW_FIELD_MISSING",
                        format!(
                            "节点「{node_name}」的规则「{}」引用了输入中不存在的字段：{}。可用字段：{}。",
                            rule_name(rule),
                            missing.join("、"),
                            input.columns.join("、")
                        ),
                    ));
                }
                prepared.push(Prepared::Expression { name: rule_name(rule), expr });
            }
        }
    }

    // 逐规则计算违规（violation[行号] 累积原因）。
    let mut violations: Vec<Vec<String>> = vec![Vec::new(); input.rows.len()];
    let mut stats = Vec::new();
    let eval_context = EvalContext {
        today: context.today,
        column_index: &index,
    };
    for rule in &prepared {
        match rule {
            Prepared::Balance { name, group_by, debit, credit, tolerance } => {
                // 分组（空分组键 = 全表一组）；求和跳过空值。
                let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
                let mut group_order: Vec<String> = Vec::new();
                for (ordinal, row) in input.rows.iter().enumerate() {
                    let key = group_key_of(group_by, row);
                    if !groups.contains_key(&key) {
                        group_order.push(key.clone());
                    }
                    groups.entry(key).or_default().push(ordinal);
                }
                let mut passed_groups = 0usize;
                let mut failed_groups: Vec<String> = Vec::new();
                for key in &group_order {
                    let members = &groups[key];
                    let mut debit_sum = Dec::from_i64(0);
                    let mut credit_sum = Dec::from_i64(0);
                    for &ordinal in members {
                        for (column, target) in [(*debit, &mut debit_sum), (*credit, &mut credit_sum)] {
                            match &input.rows[ordinal][column] {
                                Value::Int(number) => {
                                    *target = target
                                        .checked_add(Dec::from_i64(*number))
                                        .map_err(|error| balance_overflow(node_name, name, error))?;
                                }
                                Value::Dec(number) => {
                                    *target = target
                                        .checked_add(*number)
                                        .map_err(|error| balance_overflow(node_name, name, error))?;
                                }
                                _ => {}
                            }
                        }
                    }
                    let difference = debit_sum
                        .checked_sub(credit_sum)
                        .map_err(|error| balance_overflow(node_name, name, error))?
                        .abs();
                    if difference.cmp_exact(*tolerance) == std::cmp::Ordering::Greater {
                        failed_groups.push(key.clone());
                        for &ordinal in members {
                            violations[ordinal].push(format!(
                                "「{name}」{}借方合计 {}、贷方合计 {}，差 {} 超过容差 {}",
                                group_label(group_by, &input.rows[members[0]], key),
                                debit_sum.to_text(),
                                credit_sum.to_text(),
                                difference.to_text(),
                                tolerance.to_text()
                            ));
                        }
                    } else {
                        passed_groups += 1;
                    }
                }
                if input.rows.is_empty() {
                    stats.push(format!(
                        "规则「{name}」（借贷合计一致，{}，容差 {}）：输入为空，未检查任何记录",
                        scope_label(group_by, input),
                        tolerance.to_text()
                    ));
                } else {
                    stats.push(format!(
                        "规则「{name}」（借贷合计一致，{}，容差 {}）：检查 {} 组，通过 {} 组，未通过 {} 组",
                        scope_label(group_by, input),
                        tolerance.to_text(),
                        group_order.len(),
                        passed_groups,
                        failed_groups.len()
                    ));
                }
            }
            Prepared::NotEmpty { name, fields } => {
                let mut failed = 0usize;
                for (ordinal, row) in input.rows.iter().enumerate() {
                    let mut empties = Vec::new();
                    for (field, column) in fields {
                        if is_blank(&row[*column]) {
                            empties.push(field.clone());
                        }
                    }
                    if !empties.is_empty() {
                        failed += 1;
                        violations[ordinal].push(format!(
                            "「{name}」字段{}为空（空值与纯空格都算空）",
                            empties
                                .iter()
                                .map(|field| format!("“{field}”"))
                                .collect::<Vec<_>>()
                                .join("、")
                        ));
                    }
                }
                push_row_rule_stat(&mut stats, name, "关键字段非空", input.rows.len(), failed);
            }
            Prepared::Unique { name, field, group_by } => {
                // 空值不参与唯一性；重复记录整组进 NG。
                let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
                let mut group_order: Vec<String> = Vec::new();
                for (ordinal, row) in input.rows.iter().enumerate() {
                    let scope = group_key_of(group_by, row);
                    if !groups.contains_key(&scope) {
                        group_order.push(scope.clone());
                    }
                    groups.entry(scope).or_default().push(ordinal);
                }
                let mut duplicated_values = 0usize;
                let mut failed_rows = std::collections::HashSet::new();
                for scope in &group_order {
                    let mut by_value: HashMap<String, Vec<usize>> = HashMap::new();
                    for &ordinal in &groups[scope] {
                        let value = &input.rows[ordinal][field.1];
                        if matches!(value, Value::Null) {
                            continue; // 空值不参与唯一性
                        }
                        by_value
                            .entry(composite_key(std::slice::from_ref(value)))
                            .or_default()
                            .push(ordinal);
                    }
                    for members in by_value.values() {
                        if members.len() > 1 {
                            duplicated_values += 1;
                            for &ordinal in members {
                                failed_rows.insert(ordinal);
                                violations[ordinal].push(format!(
                                    "「{name}」字段“{}”值 {} 重复出现 {} 次（整组进未通过）",
                                    field.0,
                                    input.rows[ordinal][field.1].to_display(),
                                    members.len()
                                ));
                            }
                        }
                    }
                }
                if input.rows.is_empty() {
                    stats.push(format!(
                        "规则「{name}」（编号唯一，{}）：输入为空，未检查任何记录",
                        scope_label(group_by, input)
                    ));
                } else {
                    stats.push(format!(
                        "规则「{name}」（编号唯一，{}）：检查 {} 行，未通过 {} 行（重复值 {} 个，重复记录整组进未通过；空值不参与唯一性）",
                        scope_label(group_by, input),
                        input.rows.len(),
                        failed_rows.len(),
                        duplicated_values
                    ));
                }
            }
            Prepared::Range { name, field, min, max } => {
                let mut failed = 0usize;
                let mut null_failed = 0usize;
                for (ordinal, row) in input.rows.iter().enumerate() {
                    let value = &row[field.1];
                    match value {
                        Value::Null => {
                            null_failed += 1;
                            failed += 1;
                            violations[ordinal].push(format!(
                                "「{name}」字段“{}”为空值（空值遇区间规则判未通过）",
                                field.0
                            ));
                        }
                        Value::Int(_) | Value::Dec(_) => {
                            let mut reason = None;
                            if let Some(min) = min {
                                if numeric_order(value, min) == std::cmp::Ordering::Less {
                                    reason = Some(format!(
                                        "「{name}」字段“{}”值 {} 低于下限 {}（闭区间）",
                                        field.0,
                                        value.to_display(),
                                        min.to_text()
                                    ));
                                }
                            }
                            if reason.is_none() {
                                if let Some(max) = max {
                                    if numeric_order(value, max) == std::cmp::Ordering::Greater {
                                        reason = Some(format!(
                                            "「{name}」字段“{}”值 {} 超过上限 {}（闭区间）",
                                            field.0,
                                            value.to_display(),
                                            max.to_text()
                                        ));
                                    }
                                }
                            }
                            if let Some(reason) = reason {
                                failed += 1;
                                violations[ordinal].push(reason);
                            }
                        }
                        other => {
                            failed += 1;
                            violations[ordinal].push(format!(
                                "「{name}」字段“{}”值 {} 不是数值（区间规则按未通过处理）",
                                field.0,
                                other.to_display()
                            ));
                        }
                    }
                }
                if input.rows.is_empty() {
                    stats.push(format!(
                        "规则「{name}」（数值区间 [{}，{}]，闭区间）：输入为空，未检查任何记录",
                        min.map(|v| v.to_text()).unwrap_or_else(|| "不限".to_owned()),
                        max.map(|v| v.to_text()).unwrap_or_else(|| "不限".to_owned())
                    ));
                } else {
                    stats.push(format!(
                        "规则「{name}」（数值区间 [{}，{}]，闭区间）：检查 {} 行，未通过 {} 行（其中空值 {} 行）",
                        min.map(|v| v.to_text()).unwrap_or_else(|| "不限".to_owned()),
                        max.map(|v| v.to_text()).unwrap_or_else(|| "不限".to_owned()),
                        input.rows.len(),
                        failed,
                        null_failed
                    ));
                }
            }
            Prepared::Expression { name, expr } => {
                let mut failed = 0usize;
                for (ordinal, row) in input.rows.iter().enumerate() {
                    let result = formula::eval(expr, &eval_context, row).map_err(|error| {
                        structural(
                            "DATAFLOW_ROW_ERROR",
                            format!(
                                "节点「{node_name}」的规则「{name}」处理第 {} 行数据时{}。\
                                 已按“停止”策略中止（检查节点不适用行级跳过，规则未通过属数据结果，\
                                 求值失败属配置或数据错误）。",
                                ordinal + 1,
                                error.0
                            ),
                        )
                    })?;
                    match result {
                        Value::Bool(true) => {}
                        Value::Bool(false) => {
                            failed += 1;
                            violations[ordinal]
                                .push(format!("「{name}」条件不成立（表达式结果为假）"));
                        }
                        Value::Null => {
                            failed += 1;
                            violations[ordinal]
                                .push(format!("「{name}」条件结果为空值（空值按未通过处理）"));
                        }
                        other => {
                            failed += 1;
                            violations[ordinal].push(format!(
                                "「{name}」条件结果不是布尔值（实际：{}）",
                                other.to_display()
                            ));
                        }
                    }
                }
                push_row_rule_stat(&mut stats, name, "自定义条件", input.rows.len(), failed);
            }
        }
    }
    if prepared.is_empty() {
        stats.push(
            "未配置任何检查规则：本节点未执行校验，不得视为“全部通过”。请在配置中添加规则。".to_owned(),
        );
    }
    if input.rows.is_empty() && !prepared.is_empty() {
        stats.push(
            "输入为空：以上规则均未检查任何记录，不得把“没有违规行”直接等同于检查通过。".to_owned(),
        );
    }

    // 分流：附「检查结果」列（P 路为空值，NG 路为原因，多规则以；连接）。
    let mut columns = input.columns.clone();
    columns.push(RESULT_COLUMN.to_owned());
    let mut types = input.types.clone();
    types.push(ColType::Text);
    let mut p_rows = Vec::new();
    let mut ng_rows = Vec::new();
    for (ordinal, row) in input.rows.iter().enumerate() {
        if violations[ordinal].is_empty() {
            let mut line = row.clone();
            line.push(Value::Null);
            p_rows.push(line);
        } else {
            let mut line = row.clone();
            line.push(Value::Text(violations[ordinal].join("；")));
            ng_rows.push(line);
        }
    }
    let p_count = p_rows.len();
    let ng_count = ng_rows.len();
    stats.push(format!(
        "通过路 P：{p_count} 行；未通过路 NG：{ng_count} 行（行数守恒：P + NG = {} = 输入行数）",
        p_count + ng_count
    ));

    let outcome = NodeOutcome {
        anchors: vec![
            ("P".to_owned(), Table { columns: columns.clone(), types: types.clone(), rows: p_rows }),
            ("NG".to_owned(), Table { columns, types, rows: ng_rows }),
        ],
        messages: Vec::new(),
        stats,
        written: Vec::new(),
        rows: p_count + ng_count,
        has_warnings: false,
    };
    Ok(outcome)
}

fn push_row_rule_stat(stats: &mut Vec<String>, name: &str, kind: &str, total: usize, failed: usize) {
    if total == 0 {
        stats.push(format!("规则「{name}」（{kind}）：输入为空，未检查任何记录"));
    } else {
        stats.push(format!(
            "规则「{name}」（{kind}）：检查 {total} 行，通过 {} 行，未通过 {failed} 行",
            total - failed
        ));
    }
}

fn balance_overflow(node_name: &str, name: &str, error: String) -> AppError {
    structural(
        "DATAFLOW_ROW_ERROR",
        format!("节点「{node_name}」的规则「{name}」合计时{error}。"),
    )
}

fn scope_label(group_by: &[usize], input: &Table) -> String {
    if group_by.is_empty() {
        "全表".to_owned()
    } else {
        let names: Vec<&str> = group_by
            .iter()
            .map(|&column| input.columns[column].as_str())
            .collect();
        format!("按 {} 分组", names.join("、"))
    }
}

/// 借贷差违规原因里的分组展示（取组内首行的分组键值；多列以｜连接）。
fn group_label(group_by: &[usize], first_row: &[Value], _scope_key: &str) -> String {
    if group_by.is_empty() {
        "全表".to_owned()
    } else {
        let values: Vec<String> = group_by
            .iter()
            .map(|&column| match &first_row[column] {
                Value::Null => "（空）".to_owned(),
                other => other.to_display(),
            })
            .collect();
        format!("分组 {}：", values.join("｜"))
    }
}

/// 数值与边界比较（闭区间）。
fn numeric_order(value: &Value, bound: &Dec) -> std::cmp::Ordering {
    match value {
        Value::Int(number) => Dec::from_i64(*number).cmp_exact(*bound),
        Value::Dec(number) => number.cmp_exact(*bound),
        _ => compare_numeric(value, &Value::Dec(*bound))
            .unwrap_or(std::cmp::Ordering::Equal),
    }
}
