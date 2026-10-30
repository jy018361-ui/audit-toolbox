//! 整理与筛选节点：字段选择（select）、字段清洗（clean）、公式（formula）、
//! 筛选（filter）。

use super::{config_error, structural, NodeOutcome, RunContext, Table};
use crate::dataflow::formula::{self, EvalContext, RowError};
use crate::dataflow::model::{CleanConfig, FilterConfig, FormulaConfig, RowErrorPolicy, SelectConfig};
use crate::dataflow::value::{
    ColType, Dec, Value, parse_bool_strict, parse_date_explicit, string_to_half_width,
    strip_invisible, trim_spaces,
};
use crate::AppError;
use chrono::NaiveDate;
use serde_json::Value as Json;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

/// 字段选择节点（保留/删除、重命名、顺序；新增字段是否自动传递）。
pub(crate) fn run_select(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: SelectConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("字段选择", node_name, error.to_string()))?;
    let index = input.column_index();
    for field in &config.fields {
        if !index.contains_key(&field.source) {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」引用了字段“{}”，但输入中没有该字段。可用字段：{}。",
                    field.source,
                    input.columns.join("、")
                ),
            ));
        }
    }
    let mut columns = Vec::new();
    let mut sources = Vec::new();
    let mut renamed = 0usize;
    let mut removed = 0usize;
    for field in &config.fields {
        if !field.keep {
            removed += 1;
            continue;
        }
        columns.push(field.rename.clone().unwrap_or_else(|| field.source.clone()));
        sources.push(index[&field.source]);
        if field.rename.is_some() {
            renamed += 1;
        }
    }
    let referenced: Vec<&str> = config.fields.iter().map(|f| f.source.as_str()).collect();
    let mut passed_through = 0usize;
    if config.pass_through_new_fields {
        for (position, name) in input.columns.iter().enumerate() {
            if !referenced.contains(&name.as_str()) {
                columns.push(name.clone());
                sources.push(position);
                passed_through += 1;
            }
        }
    }
    if columns.is_empty() {
        return Err(config_error("字段选择", node_name, "至少需要保留 1 个字段。".into()));
    }
    let types: Vec<ColType> = sources.iter().map(|source| input.types[*source]).collect();
    let rows: Vec<Vec<Value>> = input
        .rows
        .iter()
        .map(|row| sources.iter().map(|source| row[*source].clone()).collect())
        .collect();
    let mut outcome = NodeOutcome::with_anchor(
        "output",
        Table { columns, types, rows },
    );
    outcome.stats = vec![format!(
        "保留 {} 个字段、删除 {removed} 个、重命名 {renamed} 个、透传新增字段 {passed_through} 个",
        config.fields.iter().filter(|f| f.keep).count()
    )];
    Ok(outcome)
}

/// 字段清洗节点（去空格、全角转半角、去不可见字符、文本替换、空值处理、
/// 删除整行空记录）。文本操作只作用于文本值，空值不受影响。
/// 输入以共享指针（Arc<Table>）传入：改写段经 Arc::make_mut 写时复制，
/// 产出锚点复用 columns/types/rows，不再克隆整表。
pub(crate) fn run_clean(
    node_name: &str,
    config: &Json,
    mut input: Arc<Table>,
) -> Result<NodeOutcome, AppError> {
    let config: CleanConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("字段清洗", node_name, error.to_string()))?;
    let index = input.column_index();
    const KNOWN_OPS: [&str; 4] = ["trim", "toHalfWidth", "stripInvisible", "replace"];
    for action in &config.actions {
        if !index.contains_key(&action.field) {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的清洗动作引用了字段“{}”，但输入中没有该字段。可用字段：{}。",
                    action.field,
                    input.columns.join("、")
                ),
            ));
        }
        for op in &action.ops {
            if !KNOWN_OPS.contains(&op.as_str()) {
                return Err(config_error(
                    "字段清洗",
                    node_name,
                    format!("字段“{}”的清洗动作“{op}”无法识别（可选 trim / toHalfWidth / stripInvisible / replace）。", action.field),
                ));
            }
        }
        if action.ops.iter().any(|op| op == "replace") {
            if action
                .replace_from
                .as_deref()
                .is_none_or(|text| text.is_empty())
            {
                return Err(config_error(
                    "字段清洗",
                    node_name,
                    format!("字段“{}”启用“文本替换”时必须填写查找内容。", action.field),
                ));
            }
        }
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut null_converted = 0usize;
    let mut dropped = 0usize;
    // 写时复制改写段：锚点库仍持引用（refcount ≥ 2）时 make_mut 克隆一次，
    // 与改造前 input.rows.clone() 成本等价、行为一致；引用计数归 1 后自动
    // 退化为原地改写零拷贝（配置校验段在上面经 Deref 只读，零改动）。
    {
        let table = Arc::make_mut(&mut input);
        for action in &config.actions {
            let column = index[&action.field];
            let replace_from = action.replace_from.clone().unwrap_or_default();
            let replace_to = action.replace_to.clone().unwrap_or_default();
            for row in &mut table.rows {
                if let Value::Text(text) = &mut row[column] {
                    let original = std::mem::take(text);
                    let mut updated = original.clone();
                    for op in &action.ops {
                        match op.as_str() {
                            "trim" => {
                                let trimmed = trim_spaces(&updated).to_owned();
                                if trimmed != updated {
                                    *counts.entry("去空格").or_default() += 1;
                                }
                                updated = trimmed;
                            }
                            "toHalfWidth" => {
                                let half = string_to_half_width(&updated);
                                if half != updated {
                                    *counts.entry("全角转半角").or_default() += 1;
                                }
                                updated = half;
                            }
                            "stripInvisible" => {
                                let stripped = strip_invisible(&updated);
                                if stripped != updated {
                                    *counts.entry("去不可见字符").or_default() += 1;
                                }
                                updated = stripped;
                            }
                            "replace" => {
                                if updated.contains(&replace_from) {
                                    *counts.entry("文本替换").or_default() += 1;
                                    updated = updated.replace(&replace_from, &replace_to);
                                }
                            }
                            _ => {}
                        }
                    }
                    *text = updated;
                }
            }
        }
        if config.null_text_to_null {
            for row in &mut table.rows {
                for cell in row.iter_mut() {
                    if let Value::Text(text) = cell {
                        if trim_spaces(text).is_empty() {
                            *cell = Value::Null;
                            null_converted += 1;
                        }
                    }
                }
            }
        }
        if config.drop_blank_rows {
            let before = table.rows.len();
            table.rows.retain(|row| {
                row.iter().any(|cell| match cell {
                    Value::Null => false,
                    Value::Text(text) => !trim_spaces(text).is_empty(),
                    _ => true,
                })
            });
            dropped = before - table.rows.len();
        }
    } // 写时复制改写段结束：此后 input 可作为共享锚点产出（columns/types/rows 全复用）
    let mut stats = Vec::new();
    for op in KNOWN_OPS {
        let label = match op {
            "trim" => "去空格",
            "toHalfWidth" => "全角转半角",
            "stripInvisible" => "去不可见字符",
            _ => "文本替换",
        };
        if let Some(count) = counts.get(label) {
            stats.push(format!("{label}：{count} 个单元格"));
        }
    }
    if config.null_text_to_null {
        stats.push(format!("空文本转空值：{null_converted} 个单元格"));
    }
    if config.drop_blank_rows {
        stats.push(format!("删除整行空记录：{dropped} 行"));
    }
    let mut outcome = NodeOutcome::with_shared_anchor("output", input);
    outcome.stats = stats;
    Ok(outcome)
}

/// 公式节点：按顺序计算一个或多个表达式，新增列或修改现有列。
pub(crate) fn run_formula(
    node_name: &str,
    config: &Json,
    input: &Table,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: FormulaConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("公式", node_name, error.to_string()))?;
    let policy = RowErrorPolicy::parse(config.on_row_error.as_deref());
    let mut compiled = Vec::new();
    for item in &config.formulas {
        let expr = formula::compile(&item.expression).map_err(|error| {
            config_error(
                "公式",
                node_name,
                format!("目标字段“{}”的表达式语法错误：{error}", item.target),
            )
        })?;
        compiled.push((item.target.trim().to_owned(), expr));
    }
    if compiled.is_empty() {
        return Err(config_error("公式", node_name, "至少需要一条公式。".into()));
    }
    for (target, _) in &compiled {
        if target.is_empty() {
            return Err(config_error("公式", node_name, "目标字段名不能为空。".into()));
        }
    }
    // 字段引用集中校验（结构性错误）：输入字段 + 本节点更早生成的目标字段。
    let mut available: Vec<String> = input.columns.clone();
    let mut missing_reports = Vec::new();
    for (target, expr) in &compiled {
        let mut referenced = Vec::new();
        formula::collect_fields(expr, &mut referenced);
        for field in referenced {
            if !available.contains(&field) {
                missing_reports.push(format!("目标“{target}”引用了字段“{field}”"));
            }
        }
        if !available.contains(target) {
            available.push(target.clone());
        }
    }
    if !missing_reports.is_empty() {
        return Err(structural(
            "DATAFLOW_FIELD_MISSING",
            format!(
                "节点「{node_name}」的字段引用校验未通过：{}。输入字段：{}。",
                missing_reports.join("；"),
                input.columns.join("、")
            ),
        ));
    }

    // 工作表：输入列 + 依次追加的新目标列（占位类型随后按结果统一）。
    let mut columns = input.columns.clone();
    let mut types = input.types.clone();
    for (target, _) in &compiled {
        if !columns.contains(target) {
            columns.push(target.clone());
            types.push(ColType::Text);
        }
    }
    let column_index: HashMap<String, usize> = columns
        .iter()
        .enumerate()
        .map(|(position, name)| (name.clone(), position))
        .collect();

    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(input.rows.len());
    let mut skipped = 0usize;
    let mut skip_messages = Vec::new();
    let eval_context = EvalContext {
        today: context.today,
        column_index: &column_index,
    };
    for (ordinal, source_row) in input.rows.iter().enumerate() {
        let mut working: Vec<Value> = source_row.clone();
        working.resize(columns.len(), Value::Null);
        let mut failed: Option<RowError> = None;
        for (target, expr) in &compiled {
            match formula::eval(expr, &eval_context, &working) {
                Ok(value) => {
                    let slot = column_index[target];
                    working[slot] = value;
                }
                Err(error) => {
                    failed = Some(RowError(format!(
                        "目标字段“{target}”：{}", error.0
                    )));
                    break;
                }
            }
        }
        match failed {
            Some(error) => match policy {
                RowErrorPolicy::Stop => {
                    return Err(structural(
                        "DATAFLOW_ROW_ERROR",
                        format!(
                            "节点「{node_name}」处理第 {} 行数据时{}。已按“停止”策略中止；\
                             可在节点配置中改为“跳过并记录”。",
                            ordinal + 1,
                            error.0
                        ),
                    ));
                }
                RowErrorPolicy::Skip => {
                    skipped += 1;
                    if skip_messages.len() < 10 {
                        skip_messages.push(format!("跳过第 {} 行数据：{}", ordinal + 1, error.0));
                    }
                }
            },
            None => rows.push(working),
        }
    }

    // 目标列类型统一：同类保持；整数+十进制 → 十进制；混搭 → 文本（记入 stats）。
    let mut stats = Vec::new();
    let mut all_slots: Vec<usize> = compiled
        .iter()
        .map(|(target, _)| column_index[target.as_str()])
        .collect();
    all_slots.sort_unstable();
    all_slots.dedup();
    for slot in &all_slots {
        let values: Vec<Value> = rows.iter().map(|row| row[*slot].clone()).collect();
        let (kind, converted, changes) = formula::unify_types(&values);
        types[*slot] = kind;
        for (row, value) in rows.iter_mut().zip(converted.into_iter()) {
            row[*slot] = value;
        }
        if changes > 0 {
            stats.push(format!(
                "列“{}”：{changes} 个结果与其他类型不一致，已统一转为{}",
                columns[*slot],
                kind.display()
            ));
        }
    }
    if compiled.iter().any(|(_, expr)| formula::uses_today(expr)) {
        stats.push(format!(
            "业务日期（本次运行开始时点）：{}",
            context.today.format("%Y-%m-%d")
        ));
    }
    if skipped > 0 {
        stats.push(format!("跳过行数：{skipped}"));
    }

    let table = Table { columns, types, rows };
    let mut outcome = NodeOutcome::with_anchor("output", table);
    outcome.stats = stats;
    outcome.messages = skip_messages;
    outcome.has_warnings = skipped > 0;
    Ok(outcome)
}

/// 筛选节点：符合 T 路，不符合（含空值参与比较的行）进 F 路。
pub(crate) fn run_filter(
    node_name: &str,
    config: &Json,
    input: &Table,
) -> Result<NodeOutcome, AppError> {
    let config: FilterConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("筛选", node_name, error.to_string()))?;
    let combinator = config.condition.op.as_deref().unwrap_or("and");
    if combinator != "and" && combinator != "or" {
        return Err(config_error(
            "筛选",
            node_name,
            format!("条件组合方式“{combinator}”无法识别（应为且 and / 或 or）。"),
        ));
    }
    if config.condition.rules.is_empty() {
        return Err(config_error("筛选", node_name, "至少需要 1 个条件。".into()));
    }
    let index = input.column_index();
    // 输入运算符会先 to_lowercase 再比对，白名单必须全小写（曾写成驼峰导致
    // 界面上的 startsWith/notContains 等条件必然报「无法识别」）。
    const OPERATORS: [&str; 13] = [
        "=", "!=", "<>", ">", ">=", "<", "<=", "contains", "notcontains", "startswith",
        "endswith", "isempty", "isnotempty",
    ];
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Cmp {
        Eq,
        Ne,
        Lt,
        Le,
        Gt,
        Ge,
    }
    #[derive(Clone)]
    enum RuleKind {
        Compare(Cmp),
        Contains(bool),
        StartsWith,
        EndsWith,
        IsEmpty,
        IsNotEmpty,
    }
    struct Rule {
        field: String,
        column: usize,
        kind: RuleKind,
        /// 与列类型对齐的比较值。
        number: Option<Dec>,
        text: Option<String>,
        date: Option<chrono::NaiveDate>,
        flag: Option<bool>,
    }
    let mut rules: Vec<Rule> = Vec::new();
    for rule in &config.condition.rules {
        let Some(&column) = index.get(&rule.field) else {
            return Err(structural(
                "DATAFLOW_FIELD_MISSING",
                format!(
                    "节点「{node_name}」的筛选条件引用了字段“{}”，但输入中没有该字段。可用字段：{}。",
                    rule.field,
                    input.columns.join("、")
                ),
            ));
        };
        let operator = rule.operator.trim().to_lowercase();
        if !OPERATORS.contains(&operator.as_str()) {
            return Err(config_error(
                "筛选",
                node_name,
                format!(
                    "字段“{}”的运算符“{}”无法识别（支持 =、!=、>、>=、<、<=、contains、notContains、startsWith、endsWith、isEmpty、isNotEmpty）。",
                    rule.field, rule.operator
                ),
            ));
        }
        let kind = match operator.as_str() {
            "=" => RuleKind::Compare(Cmp::Eq),
            "!=" | "<>" => RuleKind::Compare(Cmp::Ne),
            ">" => RuleKind::Compare(Cmp::Gt),
            ">=" => RuleKind::Compare(Cmp::Ge),
            "<" => RuleKind::Compare(Cmp::Lt),
            "<=" => RuleKind::Compare(Cmp::Le),
            "contains" => RuleKind::Contains(true),
            "notcontains" => RuleKind::Contains(false),
            "startswith" => RuleKind::StartsWith,
            "endswith" => RuleKind::EndsWith,
            "isempty" => RuleKind::IsEmpty,
            _ => RuleKind::IsNotEmpty,
        };
        let column_type = input.types[column];
        let mut parsed = Rule {
            field: rule.field.clone(),
            column,
            kind,
            number: None,
            text: None,
            date: None,
            flag: None,
        };
        let needs_value = !matches!(parsed.kind, RuleKind::IsEmpty | RuleKind::IsNotEmpty);
        if needs_value {
            let raw = rule.value.clone().unwrap_or(Json::Null);
            let as_text = match &raw {
                Json::String(text) => text.clone(),
                Json::Number(number) => number.to_string(),
                Json::Bool(flag) => flag.to_string(),
                Json::Null => {
                    return Err(config_error(
                        "筛选",
                        node_name,
                        format!("字段“{}”的条件值不能为空。", rule.field),
                    ));
                }
                other => other.to_string(),
            };
            if matches!(
                parsed.kind,
                RuleKind::Contains(_) | RuleKind::StartsWith | RuleKind::EndsWith
            ) {
                // 文字类运算符对任意列类型都按单元格的文本形式匹配
                // （日期筛“包含 01”捞一月凭证、编号找尾号等），条件值保留原文，
                // 不能再强迫解析成日期/数字，否则必然报「无法识别为日期」。
                parsed.text = Some(as_text);
                rules.push(parsed);
                continue;
            }
            match column_type {
                ColType::Integer | ColType::Decimal => {
                    parsed.number = Some(Dec::parse(&as_text).map_err(|error| {
                        config_error(
                            "筛选",
                            node_name,
                            format!("字段“{}”是{}，条件值“{as_text}”{error}", rule.field, column_type.display()),
                        )
                    })?);
                }
                ColType::Date => {
                    parsed.date = parse_date_explicit(&as_text).or_else(|| {
                        NaiveDate::parse_from_str(&as_text, "%Y%m%d").ok()
                    });
                    if parsed.date.is_none() {
                        return Err(config_error(
                            "筛选",
                            node_name,
                            format!("字段“{}”是日期，条件值“{as_text}”无法识别为日期。", rule.field),
                        ));
                    }
                }
                ColType::Bool => {
                    parsed.flag = parse_bool_strict(&as_text);
                    if parsed.flag.is_none() {
                        return Err(config_error(
                            "筛选",
                            node_name,
                            format!("字段“{}”是布尔值，条件值“{as_text}”无法识别。", rule.field),
                        ));
                    }
                }
                ColType::Text => {
                    parsed.text = Some(as_text);
                }
            }
        }
        rules.push(parsed);
    }

    let cell_text = |cell: &Value| -> String {
        match cell {
            Value::Text(text) => text.clone(),
            other => other.to_display(),
        }
    };
    let compare_order = |cmp: Cmp, order: Ordering| -> bool {
        match cmp {
            Cmp::Eq => order == Ordering::Equal,
            Cmp::Ne => order != Ordering::Equal,
            Cmp::Lt => order == Ordering::Less,
            Cmp::Le => order != Ordering::Greater,
            Cmp::Gt => order == Ordering::Greater,
            Cmp::Ge => order != Ordering::Less,
        }
    };

    let mut t_rows = Vec::new();
    let mut f_rows = Vec::new();
    for row in &input.rows {
        let mut outcomes: Vec<bool> = Vec::with_capacity(rules.len());
        for rule in &rules {
            let cell = &row[rule.column];
            let outcome = match &rule.kind {
                RuleKind::IsEmpty => matches!(cell, Value::Null)
                    || matches!(cell, Value::Text(text) if trim_spaces(text).is_empty()),
                RuleKind::IsNotEmpty => !(matches!(cell, Value::Null)
                    || matches!(cell, Value::Text(text) if trim_spaces(text).is_empty())),
                RuleKind::Contains(want) => {
                    if matches!(cell, Value::Null) {
                        false
                    } else {
                        let hay = cell_text(cell);
                        rule.text
                            .as_ref()
                            .is_some_and(|needle| hay.contains(needle.as_str()) == *want)
                    }
                }
                RuleKind::StartsWith => {
                    if matches!(cell, Value::Null) {
                        false
                    } else {
                        rule.text
                            .as_ref()
                            .is_some_and(|prefix| cell_text(cell).starts_with(prefix.as_str()))
                    }
                }
                RuleKind::EndsWith => {
                    if matches!(cell, Value::Null) {
                        false
                    } else {
                        rule.text
                            .as_ref()
                            .is_some_and(|suffix| cell_text(cell).ends_with(suffix.as_str()))
                    }
                }
                RuleKind::Compare(cmp) => {
                    // 空值不参与比较：整条规则按不成立处理，行进 F 路。
                    if matches!(cell, Value::Null) {
                        false
                    } else {
                        match (cell, rule.number, rule.date, rule.flag) {
                            (Value::Int(number), Some(target), _, _) => {
                                compare_order(*cmp, Dec::from_i64(*number).cmp_exact(target))
                            }
                            (Value::Dec(number), Some(target), _, _) => {
                                compare_order(*cmp, number.cmp_exact(target))
                            }
                            (Value::Text(text), _, _, _) => {
                                let target = rule.text.clone().unwrap_or_default();
                                compare_order(*cmp, text.cmp(&target))
                            }
                            (Value::Date(date), _, Some(target), _) => {
                                compare_order(*cmp, date.cmp(&target))
                            }
                            (Value::Bool(flag), _, _, Some(target)) => {
                                compare_order(*cmp, flag.cmp(&target))
                            }
                            _ => false,
                        }
                    }
                }
            };
            outcomes.push(outcome);
        }
        let matched = if combinator == "and" {
            outcomes.iter().all(|flag| *flag)
        } else {
            outcomes.iter().any(|flag| *flag)
        };
        if matched {
            t_rows.push(row.clone());
        } else {
            f_rows.push(row.clone());
        }
    }
    let t_count = t_rows.len();
    let f_count = f_rows.len();
    let total = t_count + f_count;
    let outcome = NodeOutcome {
        anchors: vec![
            ("T".to_owned(), Arc::new(Table {
                columns: input.columns.clone(),
                types: input.types.clone(),
                rows: t_rows,
            })),
            ("F".to_owned(), Arc::new(Table {
                columns: input.columns.clone(),
                types: input.types.clone(),
                rows: f_rows,
            })),
        ],
        messages: Vec::new(),
        stats: vec![
            format!("T 路（符合）：{t_count} 行"),
            format!("F 路（不符合）：{f_count} 行"),
            format!("行数守恒：T + F = {total} = 输入行数"),
            "空值参与的比较按不成立处理，相应记录进入 F 路（空值判断请用 isEmpty / isNotEmpty）".to_owned(),
        ],
        written: Vec::new(),
        rows: total,
        has_warnings: false,
    };
    Ok(outcome)
}
