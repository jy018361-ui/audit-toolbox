//! 数据流（DataFlow）公式求值器：自写小型递归下降解析，不引入新依赖。
//!
//! 函数集按设计文档 DATAFLOW_DESIGN.md 第 5 节：
//! - 金额与数学：四则运算、括号、ABS、ROUND（中点远离零）、取余；
//! - 比较：= != <> < <= > >=（普通比较遇空值产生空值）；
//! - 逻辑：IF（只求值命中分支，空条件按未成立）、AND/OR（三值逻辑）、NOT、
//!   ISNULL、COALESCE；
//! - 文本：CONCAT、LEFT/RIGHT/MID、LEN、TRIM、UPPER/LOWER、REPLACE、CONTAINS、
//!   SPLITPART（按分隔符取第 n 段）、TOHALF（全角转半角）；
//! - 日期：DATE/TODATE（识别日期）、YEAR/MONTH/DAY、YEARMONTH（如 202610）、
//!   DAYSBETWEEN、TODAY（运行开始时点）、DATEFORMAT（按格式输出文本）；
//! - 类型转换：TOTEXT、TOINT、TODECIMAL、TOBOOL、TODATE。
//!
//! 空值传播：普通算术/比较/文本函数遇空值产生空值，须用 ISNULL/COALESCE/IF
//! 显式处理；除零按行级异常返回 [`RowError`]，不静默写零。

use super::value::{
    ColType, Dec, Value, parse_bool_strict, parse_date_explicit, parse_integer_strict,
    string_to_half_width, trim_spaces,
};
use chrono::{Datelike, NaiveDate};
use std::collections::{HashMap, HashSet};

/// 行级异常（除零、类型转换失败等），由节点按 onRowError 停止或跳过。
#[derive(Debug, Clone)]
pub(crate) struct RowError(pub String);

/// 表达式求值上下文：行数据、列索引与本次运行的业务日期（运行开始时确定）。
pub(crate) struct EvalContext<'a> {
    pub today: NaiveDate,
    pub column_index: &'a HashMap<String, usize>,
}

#[derive(Debug, Clone)]
enum Token {
    Int(i64),
    Dec(Dec),
    Str(String),
    Field(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    LParen,
    RParen,
    Comma,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    AndSym,
    OrSym,
    NotSym,
    End,
}

fn lex(source: &str) -> Result<Vec<(Token, usize)>, String> {
    let mut tokens = Vec::new();
    let characters: Vec<char> = source.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character.is_whitespace() {
            index += 1;
            continue;
        }
        let start = index;
        let push = |tokens: &mut Vec<(Token, usize)>, token: Token| {
            tokens.push((token, start));
        };
        match character {
            '+' => {
                push(&mut tokens, Token::Plus);
                index += 1;
            }
            '-' => {
                push(&mut tokens, Token::Minus);
                index += 1;
            }
            '*' => {
                push(&mut tokens, Token::Star);
                index += 1;
            }
            '/' => {
                push(&mut tokens, Token::Slash);
                index += 1;
            }
            '%' => {
                push(&mut tokens, Token::Percent);
                index += 1;
            }
            '(' => {
                push(&mut tokens, Token::LParen);
                index += 1;
            }
            ')' => {
                push(&mut tokens, Token::RParen);
                index += 1;
            }
            ',' => {
                push(&mut tokens, Token::Comma);
                index += 1;
            }
            '[' => {
                index += 1;
                let mut name = String::new();
                while index < characters.len() && characters[index] != ']' {
                    name.push(characters[index]);
                    index += 1;
                }
                if index >= characters.len() {
                    return Err(format!("字段引用 [{name} 缺少右括号 ]"));
                }
                index += 1;
                if name.trim().is_empty() {
                    return Err("字段引用不能为空".to_owned());
                }
                tokens.push((Token::Field(name), start));
            }
            '"' => {
                index += 1;
                let mut text = String::new();
                loop {
                    if index >= characters.len() {
                        return Err("字符串缺少结束引号".to_owned());
                    }
                    let current = characters[index];
                    index += 1;
                    match current {
                        '"' => break,
                        '\\' => {
                            if index >= characters.len() {
                                return Err("字符串转义不完整".to_owned());
                            }
                            let escaped = characters[index];
                            index += 1;
                            text.push(match escaped {
                                'n' => '\n',
                                't' => '\t',
                                'r' => '\r',
                                other => other,
                            });
                        }
                        other => text.push(other),
                    }
                }
                tokens.push((Token::Str(text), start));
            }
            '<' => {
                index += 1;
                if index < characters.len() {
                    if characters[index] == '=' {
                        index += 1;
                        push(&mut tokens, Token::Le);
                    } else if characters[index] == '>' {
                        index += 1;
                        push(&mut tokens, Token::Ne);
                    } else {
                        push(&mut tokens, Token::Lt);
                    }
                } else {
                    push(&mut tokens, Token::Lt);
                }
            }
            '>' => {
                index += 1;
                if index < characters.len() && characters[index] == '=' {
                    index += 1;
                    push(&mut tokens, Token::Ge);
                } else {
                    push(&mut tokens, Token::Gt);
                }
            }
            '=' => {
                index += 1;
                if index < characters.len() && characters[index] == '=' {
                    index += 1;
                }
                push(&mut tokens, Token::Eq);
            }
            '!' => {
                index += 1;
                if index < characters.len() && characters[index] == '=' {
                    index += 1;
                    push(&mut tokens, Token::Ne);
                } else {
                    push(&mut tokens, Token::NotSym);
                }
            }
            '&' => {
                index += 1;
                if index < characters.len() && characters[index] == '&' {
                    index += 1;
                    push(&mut tokens, Token::AndSym);
                } else {
                    return Err("单独的 & 不是有效运算符".to_owned());
                }
            }
            '|' => {
                index += 1;
                if index < characters.len() && characters[index] == '|' {
                    index += 1;
                    push(&mut tokens, Token::OrSym);
                } else {
                    return Err("单独的 | 不是有效运算符".to_owned());
                }
            }
            _ if character.is_ascii_digit() => {
                let mut digits = String::new();
                let mut saw_dot = false;
                while index < characters.len() {
                    let current = characters[index];
                    if current.is_ascii_digit() {
                        digits.push(current);
                        index += 1;
                    } else if current == '.' && !saw_dot && index + 1 < characters.len() && characters[index + 1].is_ascii_digit() {
                        saw_dot = true;
                        digits.push(current);
                        index += 1;
                    } else {
                        break;
                    }
                }
                let token = if saw_dot {
                    Token::Dec(
                        Dec::parse(&digits)
                            .map_err(|err| format!("数字 {digits} 无效：{err}"))?,
                    )
                } else {
                    Token::Int(
                        digits
                            .parse::<i64>()
                            .map_err(|_| format!("数字 {digits} 超出整数范围"))?,
                    )
                };
                tokens.push((token, start));
            }
            _ if character.is_alphabetic() || character == '_' => {
                let mut name = String::new();
                while index < characters.len()
                    && (characters[index].is_alphanumeric() || characters[index] == '_')
                {
                    name.push(characters[index]);
                    index += 1;
                }
                tokens.push((Token::Ident(name), start));
            }
            other => {
                return Err(format!("无法识别的字符“{other}”"));
            }
        }
    }
    tokens.push((Token::End, characters.len()));
    Ok(tokens)
}

#[derive(Debug, Clone)]
pub(crate) enum Expr {
    Int(i64),
    Dec(Dec),
    Str(String),
    Field(String),
    Call { name: String, name_upper: String, args: Vec<Expr> },
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Binary { op: BinaryOp, left: Box<Expr>, right: Box<Expr> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

struct Parser {
    tokens: Vec<(Token, usize)>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> &Token {
        &self.tokens[self.position].0
    }
    fn advance(&mut self) -> Token {
        let token = self.tokens[self.position].0.clone();
        if self.position + 1 < self.tokens.len() {
            self.position += 1;
        }
        token
    }
    fn expect(&mut self, wanted: &Token, description: &str) -> Result<(), String> {
        if std::mem::discriminant(self.peek()) == std::mem::discriminant(wanted) {
            self.advance();
            Ok(())
        } else {
            Err(format!("此处应为{description}"))
        }
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        loop {
            let is_or = matches!(self.peek(), Token::Ident(name) if name.eq_ignore_ascii_case("or"))
                || matches!(self.peek(), Token::OrSym);
            if !is_or {
                return Ok(left);
            }
            self.advance();
            let right = self.parse_and()?;
            left = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_not()?;
        loop {
            let is_and = matches!(self.peek(), Token::Ident(name) if name.eq_ignore_ascii_case("and"))
                || matches!(self.peek(), Token::AndSym);
            if !is_and {
                return Ok(left);
            }
            self.advance();
            let right = self.parse_not()?;
            left = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_not(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Token::Ident(name) if name.eq_ignore_ascii_case("not"))
            || matches!(self.peek(), Token::NotSym)
        {
            self.advance();
            return Ok(Expr::Not(Box::new(self.parse_not()?)));
        }
        self.parse_compare()
    }

    fn parse_compare(&mut self) -> Result<Expr, String> {
        let left = self.parse_add()?;
        let op = match self.peek() {
            Token::Eq => Some(BinaryOp::Eq),
            Token::Ne => Some(BinaryOp::Ne),
            Token::Lt => Some(BinaryOp::Lt),
            Token::Le => Some(BinaryOp::Le),
            Token::Gt => Some(BinaryOp::Gt),
            Token::Ge => Some(BinaryOp::Ge),
            _ => None,
        };
        if let Some(op) = op {
            self.advance();
            let right = self.parse_add()?;
            return Ok(Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Token::Plus => BinaryOp::Add,
                Token::Minus => BinaryOp::Sub,
                _ => return Ok(left),
            };
            self.advance();
            let right = self.parse_mul()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Token::Star => BinaryOp::Mul,
                Token::Slash => BinaryOp::Div,
                Token::Percent => BinaryOp::Mod,
                _ => return Ok(left),
            };
            self.advance();
            let right = self.parse_unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Token::Minus) {
            self.advance();
            return Ok(Expr::Neg(Box::new(self.parse_unary()?)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.advance() {
            Token::Int(value) => Ok(Expr::Int(value)),
            Token::Dec(value) => Ok(Expr::Dec(value)),
            Token::Str(value) => Ok(Expr::Str(value)),
            Token::Field(name) => Ok(Expr::Field(name)),
            Token::LParen => {
                let inner = self.parse_expr()?;
                self.expect(&Token::RParen, "右括号 )")?;
                Ok(inner)
            }
            Token::Ident(name) => {
                let upper = name.to_ascii_uppercase();
                match upper.as_str() {
                    "TRUE" => Ok(Expr::Call { name, name_upper: "TRUE".into(), args: Vec::new() }),
                    "FALSE" => Ok(Expr::Call { name, name_upper: "FALSE".into(), args: Vec::new() }),
                    "NULL" => Ok(Expr::Call { name, name_upper: "NULL".into(), args: Vec::new() }),
                    _ => {
                        if matches!(self.peek(), Token::LParen) {
                            self.advance();
                            let mut args = Vec::new();
                            if !matches!(self.peek(), Token::RParen) {
                                loop {
                                    args.push(self.parse_expr()?);
                                    if matches!(self.peek(), Token::Comma) {
                                        self.advance();
                                    } else {
                                        break;
                                    }
                                }
                            }
                            self.expect(&Token::RParen, "函数的右括号 )")?;
                            validate_arity(&upper, args.len())?;
                            Ok(Expr::Call { name, name_upper: upper, args })
                        } else {
                            Ok(Expr::Field(name))
                        }
                    }
                }
            }
            token => Err(format!("表达式此处出现意外的记号（{token:?}）")),
        }
    }
}

fn validate_arity(name: &str, count: usize) -> Result<(), String> {
    let ok = match name {
        "IF" => count == 3,
        "ROUND" => count == 1 || count == 2,
        "COALESCE" | "CONCAT" | "AND" | "OR" => count >= 1,
        "TRUE" | "FALSE" | "NULL" | "TODAY" => count == 0,
        "ABS" | "NOT" | "ISNULL" | "LEN" | "TRIM" | "UPPER" | "LOWER" | "TOHALF" | "YEAR"
        | "MONTH" | "DAY" | "YEARMONTH" | "TOTEXT" | "TOINT" | "TODECIMAL" | "TOBOOL"
        | "TODATE" | "DATE" => count == 1,
        "LEFT" | "RIGHT" | "CONTAINS" | "DAYSBETWEEN" | "DATEFORMAT" => count == 2,
        "MID" | "REPLACE" | "SPLITPART" => count == 3,
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("函数 {name} 的参数个数不正确（收到 {count} 个）"))
    }
}

/// 编译表达式（语法检查）。失败返回中文错误与位置。
pub(crate) fn compile(expression: &str) -> Result<Expr, String> {
    let tokens = lex(expression)?;
    let mut parser = Parser { tokens, position: 0 };
    let expr = parser.parse_expr()?;
    if !matches!(parser.peek(), Token::End) {
        return Err("表达式末尾存在多余内容".to_owned());
    }
    Ok(expr)
}

/// 收集表达式引用的字段名（含嵌套函数参数）。
pub(crate) fn collect_fields(expr: &Expr, fields: &mut Vec<String>) {
    match expr {
        Expr::Field(name) => fields.push(name.clone()),
        Expr::Call { args, .. } => {
            for arg in args {
                collect_fields(arg, fields);
            }
        }
        Expr::Neg(inner) | Expr::Not(inner) => collect_fields(inner, fields),
        Expr::Binary { left, right, .. } => {
            collect_fields(left, fields);
            collect_fields(right, fields);
        }
        _ => {}
    }
}

/// 表达式是否使用 TODAY()（用于把业务日期记入节点 stats）。
pub(crate) fn uses_today(expr: &Expr) -> bool {
    match expr {
        Expr::Call { name_upper, args, .. } => {
            name_upper == "TODAY" || args.iter().any(uses_today)
        }
        Expr::Neg(inner) | Expr::Not(inner) => uses_today(inner),
        Expr::Binary { left, right, .. } => uses_today(left) || uses_today(right),
        _ => false,
    }
}

fn err<T>(message: impl Into<String>) -> Result<T, RowError> {
    Err(RowError(message.into()))
}

pub(crate) fn eval(expr: &Expr, context: &EvalContext<'_>, row: &[Value]) -> Result<Value, RowError> {
    match expr {
        Expr::Int(value) => Ok(Value::Int(*value)),
        Expr::Dec(value) => Ok(Value::Dec(*value)),
        Expr::Str(value) => Ok(Value::Text(value.clone())),
        Expr::Field(name) => {
            let index = context.column_index.get(name).copied();
            match index {
                Some(index) => Ok(row.get(index).cloned().unwrap_or(Value::Null)),
                None => err(format!("未知字段：{name}")),
            }
        }
        Expr::Neg(inner) => {
            let value = eval(inner, context, row)?;
            match value {
                Value::Null => Ok(Value::Null),
                Value::Int(number) => number
                    .checked_neg()
                    .map(Value::Int)
                    .ok_or_else(|| RowError("整数取负溢出".to_owned())),
                Value::Dec(number) => Ok(Value::Dec(Dec::from_i64(0).checked_sub(number).map_err(|e| RowError(e))?)),
                other => err(format!("不能对{}取负", type_label(&other))),
            }
        }
        Expr::Not(inner) => {
            let value = eval(inner, context, row)?;
            match value {
                Value::Null => Ok(Value::Null),
                Value::Bool(flag) => Ok(Value::Bool(!flag)),
                other => err(format!("NOT 需要布尔值，收到{}", type_label(&other))),
            }
        }
        Expr::Binary { op, left, right } => eval_binary(*op, left, right, context, row),
        Expr::Call { name_upper, args, .. } => eval_call(name_upper, args, context, row),
    }
}

fn type_label(value: &Value) -> &'static str {
    match value {
        Value::Null => "空值",
        Value::Bool(_) => "布尔值",
        Value::Int(_) => "整数",
        Value::Dec(_) => "十进制小数",
        Value::Text(_) => "文本",
        Value::Date(_) => "日期",
    }
}

fn eval_binary(
    op: BinaryOp,
    left: &Expr,
    right: &Expr,
    context: &EvalContext<'_>,
    row: &[Value],
) -> Result<Value, RowError> {
    match op {
        BinaryOp::And => {
            // 三值逻辑 AND：见到假立即假；见到空值记下，全部真则空值。
            let mut saw_null = false;
            for part in [left, right] {
                match eval(part, context, row)? {
                    Value::Bool(false) => return Ok(Value::Bool(false)),
                    Value::Null => saw_null = true,
                    Value::Bool(true) => {}
                    other => return err(format!("AND 需要布尔值，收到{}", type_label(&other))),
                }
            }
            Ok(if saw_null { Value::Null } else { Value::Bool(true) })
        }
        BinaryOp::Or => {
            let mut saw_null = false;
            for part in [left, right] {
                match eval(part, context, row)? {
                    Value::Bool(true) => return Ok(Value::Bool(true)),
                    Value::Null => saw_null = true,
                    Value::Bool(false) => {}
                    other => return err(format!("OR 需要布尔值，收到{}", type_label(&other))),
                }
            }
            Ok(if saw_null { Value::Null } else { Value::Bool(false) })
        }
        BinaryOp::Eq | BinaryOp::Ne | BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
            let lhs = eval(left, context, row)?;
            let rhs = eval(right, context, row)?;
            if matches!(lhs, Value::Null) || matches!(rhs, Value::Null) {
                return Ok(Value::Null);
            }
            let ordering = compare_values(&lhs, &rhs)?;
            let result = match op {
                BinaryOp::Eq => ordering == std::cmp::Ordering::Equal,
                BinaryOp::Ne => ordering != std::cmp::Ordering::Equal,
                BinaryOp::Lt => ordering == std::cmp::Ordering::Less,
                BinaryOp::Le => ordering != std::cmp::Ordering::Greater,
                BinaryOp::Gt => ordering == std::cmp::Ordering::Greater,
                BinaryOp::Ge => ordering != std::cmp::Ordering::Less,
                _ => unreachable!(),
            };
            Ok(Value::Bool(result))
        }
        BinaryOp::Add | BinaryOp::Sub | BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => {
            let lhs = eval(left, context, row)?;
            let rhs = eval(right, context, row)?;
            if matches!(lhs, Value::Null) || matches!(rhs, Value::Null) {
                return Ok(Value::Null);
            }
            arithmetic(op, &lhs, &rhs)
        }
    }
}

fn compare_values(lhs: &Value, rhs: &Value) -> Result<std::cmp::Ordering, RowError> {
    match (lhs, rhs) {
        (Value::Int(a), Value::Int(b)) => Ok(a.cmp(b)),
        (Value::Int(_), Value::Dec(_)) | (Value::Dec(_), Value::Int(_)) => {
            let left = value_to_dec(lhs)?;
            let right = value_to_dec(rhs)?;
            Ok(left.cmp_exact(right))
        }
        (Value::Dec(a), Value::Dec(b)) => Ok(a.cmp_exact(*b)),
        (Value::Text(a), Value::Text(b)) => Ok(a.cmp(b)),
        (Value::Date(a), Value::Date(b)) => Ok(a.cmp(b)),
        (Value::Bool(a), Value::Bool(b)) => Ok(a.cmp(b)),
        _ => err(format!(
            "类型不匹配：不能比较{}与{}（文本与数字不会自动互转）",
            type_label(lhs),
            type_label(rhs)
        )),
    }
}

fn value_to_dec(value: &Value) -> Result<Dec, RowError> {
    match value {
        Value::Int(number) => Ok(Dec::from_i64(*number)),
        Value::Dec(number) => Ok(*number),
        other => err(format!("需要数值，收到{}", type_label(other))),
    }
}

fn arithmetic(op: BinaryOp, lhs: &Value, rhs: &Value) -> Result<Value, RowError> {
    use BinaryOp::*;
    match (lhs, rhs) {
        (Value::Date(a), Value::Date(b)) if op == Sub => {
            Ok(Value::Int((*a - *b).num_days()))
        }
        (Value::Text(_), _) | (_, Value::Text(_)) => {
            err("文本不能直接参与算术运算，请使用 CONCAT 拼接或先做类型转换")
        }
        (Value::Bool(_), _) | (_, Value::Bool(_)) => err("布尔值不能参与算术运算"),
        (Value::Date(_), _) | (_, Value::Date(_)) => {
            err("日期只支持两个日期相减求天数（其他日期运算暂不支持）")
        }
        (Value::Int(a), Value::Int(b)) => {
            let checked = match op {
                Add => a.checked_add(*b).map(|v| (v, true)),
                Sub => a.checked_sub(*b).map(|v| (v, true)),
                Mul => a.checked_mul(*b).map(|v| (v, true)),
                Div => {
                    if *b == 0 {
                        return err("除数为零");
                    }
                    // 整数除不尽时升级为十进制，保证 1/2 = 0.5 而不是 0。
                    if a % b == 0 {
                        Some((a / b, true))
                    } else {
                        None
                    }
                }
                Mod => {
                    if *b == 0 {
                        return err("除数为零（取余）");
                    }
                    Some((a % b, true))
                }
                _ => unreachable!(),
            };
            if let Some((value, _)) = checked {
                return Ok(Value::Int(value));
            }
            // 整数路径溢出或除不尽：升级为十进制精确计算。
            let left = Dec::from_i64(*a);
            let right = Dec::from_i64(*b);
            let result = match op {
                Add | Sub | Mul => None,
                Div => Some(left.checked_div(right).map_err(RowError)?),
                Mod => return err("取余仅支持整数"),
                _ => unreachable!(),
            };
            if let Some(value) = result {
                return Ok(Value::Dec(value));
            }
            let value = match op {
                Add => left.checked_add(right),
                Sub => left.checked_sub(right),
                Mul => left.checked_mul(right),
                _ => unreachable!(),
            }
            .map_err(RowError)?;
            Ok(Value::Dec(value))
        }
        _ => {
            let left = value_to_dec(lhs)?;
            let right = value_to_dec(rhs)?;
            let value = match op {
                Add => left.checked_add(right),
                Sub => left.checked_sub(right),
                Mul => left.checked_mul(right),
                Div => left.checked_div(right),
                Mod => return err("取余仅支持整数"),
                _ => unreachable!(),
            }
            .map_err(RowError)?;
            Ok(Value::Dec(value))
        }
    }
}

fn expect_args<'a>(
    name: &str,
    args: &'a [Expr],
    context: &EvalContext<'_>,
    row: &[Value],
    count: usize,
) -> Result<Vec<Value>, RowError> {
    if args.len() != count {
        return err(format!("函数 {name} 需要 {count} 个参数"));
    }
    args.iter()
        .map(|arg| eval(arg, context, row))
        .collect()
}

fn text_arg(value: &Value, function: &str) -> Result<String, RowError> {
    match value {
        Value::Null => Ok(String::new()), // 调用方先做空值传播，这里兜底
        Value::Text(text) => Ok(text.clone()),
        other => err(format!("函数 {function} 需要文本参数，收到{}", type_label(other))),
    }
}

fn eval_call(
    name: &str,
    args: &[Expr],
    context: &EvalContext<'_>,
    row: &[Value],
) -> Result<Value, RowError> {
    // 空值处理与逻辑函数先分支：它们正是用来处理空值的（AND/OR/NOT 按
    // 三值逻辑短路求值，不做空值传播；NULL 是空值字面量）。
    match name {
        "TRUE" => return Ok(Value::Bool(true)),
        "FALSE" => return Ok(Value::Bool(false)),
        "NULL" => return Ok(Value::Null),
        "TODAY" => return Ok(Value::Date(context.today)),
        "AND" => {
            let mut saw_null = false;
            for arg in args {
                match eval(arg, context, row)? {
                    Value::Bool(false) => return Ok(Value::Bool(false)),
                    Value::Null => saw_null = true,
                    Value::Bool(true) => {}
                    other => return err(format!("AND 需要布尔值，收到{}", type_label(&other))),
                }
            }
            return Ok(if saw_null { Value::Null } else { Value::Bool(true) });
        }
        "OR" => {
            let mut saw_null = false;
            for arg in args {
                match eval(arg, context, row)? {
                    Value::Bool(true) => return Ok(Value::Bool(true)),
                    Value::Null => saw_null = true,
                    Value::Bool(false) => {}
                    other => return err(format!("OR 需要布尔值，收到{}", type_label(&other))),
                }
            }
            return Ok(if saw_null { Value::Null } else { Value::Bool(false) });
        }
        "NOT" => {
            if args.len() != 1 {
                return err("NOT 需要 1 个参数");
            }
            return match eval(&args[0], context, row)? {
                Value::Null => Ok(Value::Null),
                Value::Bool(flag) => Ok(Value::Bool(!flag)),
                other => err(format!("NOT 需要布尔值，收到{}", type_label(&other))),
            };
        }
        "IF" => {
            if args.len() != 3 {
                return err("IF 需要 3 个参数（条件, 真值, 假值）");
            }
            // 短路：只求值命中分支；空条件按未成立处理。
            let condition = eval(&args[0], context, row)?;
            return match condition {
                Value::Bool(true) => eval(&args[1], context, row),
                Value::Bool(false) | Value::Null => eval(&args[2], context, row),
                other => err(format!("IF 的条件需要布尔值，收到{}", type_label(&other))),
            };
        }
        "ISNULL" => {
            let value = expect_args("ISNULL", args, context, row, 1)?;
            return Ok(Value::Bool(matches!(value[0], Value::Null)));
        }
        "COALESCE" => {
            for arg in args {
                let value = eval(arg, context, row)?;
                if !matches!(value, Value::Null) {
                    return Ok(value);
                }
            }
            return Ok(Value::Null);
        }
        _ => {}
    }

    // 其余函数：任一参数为空值时结果为空值（空值传播）。
    let mut values = Vec::with_capacity(args.len());
    for arg in args {
        let value = eval(arg, context, row)?;
        if matches!(value, Value::Null) {
            return Ok(Value::Null);
        }
        values.push(value);
    }

    match name {
        "ABS" => match &values[0] {
            Value::Int(number) => number
                .checked_abs()
                .map(Value::Int)
                .ok_or_else(|| RowError("整数绝对值溢出".to_owned())),
            Value::Dec(number) => Ok(Value::Dec(number.abs())),
            other => err(format!("ABS 需要数值，收到{}", type_label(other))),
        },
        "ROUND" => {
            let digits = if values.len() == 2 {
                match values[1] {
                    Value::Int(number) => number,
                    ref other => return err(format!("ROUND 的位数需要整数，收到{}", type_label(other))),
                }
            } else {
                0
            };
            match &values[0] {
                Value::Int(number) => {
                    let rounded = Dec::from_i64(*number).round(digits).map_err(RowError)?;
                    if digits <= 0 && rounded.scale() == 0 {
                        rounded
                            .mantissa()
                            .try_into()
                            .map(Value::Int)
                            .map_err(|_| RowError("四舍五入结果超出整数范围".to_owned()))
                    } else {
                        Ok(Value::Dec(rounded))
                    }
                }
                Value::Dec(number) => Ok(Value::Dec(number.round(digits).map_err(RowError)?)),
                other => err(format!("ROUND 需要数值，收到{}", type_label(other))),
            }
        }
        "CONCAT" => {
            let mut text = String::new();
            for value in &values {
                text.push_str(&value.to_display());
            }
            Ok(Value::Text(text))
        }
        "LEFT" | "RIGHT" => {
            let count = int_len_arg(&values[1], name)?;
            let text = text_arg(&values[0], name)?;
            let characters: Vec<char> = text.chars().collect();
            let count = count.min(characters.len() as i64) as usize;
            let result = if name == "LEFT" {
                characters[..count].iter().collect()
            } else {
                characters[characters.len() - count..].iter().collect()
            };
            Ok(Value::Text(result))
        }
        "MID" => {
            let start = match values[1] {
                Value::Int(number) if number >= 1 => number as usize,
                _ => return err("MID 的起始位置需要不小于 1 的整数"),
            };
            let count = int_len_arg(&values[2], name)? as usize;
            let text = text_arg(&values[0], name)?;
            let characters: Vec<char> = text.chars().collect();
            if start > characters.len() {
                return Ok(Value::Text(String::new()));
            }
            let end = (start - 1 + count).min(characters.len());
            Ok(Value::Text(characters[start - 1..end].iter().collect()))
        }
        "LEN" => {
            let text = text_arg(&values[0], name)?;
            Ok(Value::Int(text.chars().count() as i64))
        }
        "TRIM" => {
            let text = text_arg(&values[0], name)?;
            Ok(Value::Text(trim_spaces(&text).to_owned()))
        }
        "UPPER" => {
            let text = text_arg(&values[0], name)?;
            Ok(Value::Text(text.to_uppercase()))
        }
        "LOWER" => {
            let text = text_arg(&values[0], name)?;
            Ok(Value::Text(text.to_lowercase()))
        }
        "REPLACE" => {
            let source = text_arg(&values[0], name)?;
            let from = text_arg(&values[1], name)?;
            let to = text_arg(&values[2], name)?;
            if from.is_empty() {
                return err("REPLACE 的查找内容不能为空");
            }
            Ok(Value::Text(source.replace(&from, &to)))
        }
        "CONTAINS" => {
            let source = text_arg(&values[0], name)?;
            let needle = text_arg(&values[1], name)?;
            Ok(Value::Bool(source.contains(&needle)))
        }
        "SPLITPART" => {
            let source = text_arg(&values[0], name)?;
            let delimiter = text_arg(&values[1], name)?;
            let index = match values[2] {
                Value::Int(number) if number >= 1 => number as usize,
                _ => return err("SPLITPART 的段序号需要不小于 1 的整数"),
            };
            if delimiter.is_empty() {
                return err("SPLITPART 的分隔符不能为空");
            }
            // 段不存在返回空值（区别于空段文本）。
            match source.split(delimiter.as_str()).nth(index - 1) {
                Some(part) => Ok(Value::Text(part.to_owned())),
                None => Ok(Value::Null),
            }
        }
        "TOHALF" => {
            let text = text_arg(&values[0], name)?;
            Ok(Value::Text(string_to_half_width(&text)))
        }
        "DATE" | "TODATE" => match &values[0] {
            Value::Text(text) => parse_date_explicit(text)
                .map(Value::Date)
                .ok_or_else(|| RowError(format!("无法识别为日期：{text}"))),
            Value::Date(date) => Ok(Value::Date(*date)),
            Value::Int(number) => {
                let text = number.to_string();
                parse_date_explicit(&text)
                    .map(Value::Date)
                    .ok_or_else(|| RowError(format!("无法识别为日期：{text}")))
            }
            other => err(format!("TODATE 需要文本或日期，收到{}", type_label(other))),
        },
        "YEAR" | "MONTH" | "DAY" => match &values[0] {
            Value::Date(date) => Ok(Value::Int(match name {
                "YEAR" => date.year() as i64,
                "MONTH" => date.month() as i64,
                _ => date.day() as i64,
            })),
            other => err(format!("{name} 需要日期，收到{}（请先用 TODATE 转换）", type_label(other))),
        },
        "YEARMONTH" => match &values[0] {
            Value::Date(date) => Ok(Value::Int(date.year() as i64 * 100 + date.month() as i64)),
            other => err(format!("YEARMONTH 需要日期，收到{}", type_label(other))),
        },
        "DAYSBETWEEN" => match (&values[0], &values[1]) {
            (Value::Date(a), Value::Date(b)) => Ok(Value::Int((*a - *b).num_days())),
            (other, _) => err(format!("DAYSBETWEEN 需要两个日期，收到{}", type_label(other))),
        },
        "DATEFORMAT" => match (&values[0], &values[1]) {
            (Value::Date(date), Value::Text(format)) => {
                let mut pattern = String::new();
                let lower = format.to_lowercase();
                let mut index = 0;
                let bytes = lower.as_bytes();
                while index < bytes.len() {
                    if bytes[index..].starts_with(b"yyyy") {
                        pattern.push_str("%Y");
                        index += 4;
                    } else if bytes[index..].starts_with(b"yy") {
                        pattern.push_str("%y");
                        index += 2;
                    } else if bytes[index..].starts_with(b"mm") {
                        pattern.push_str("%m");
                        index += 2;
                    } else if bytes[index..].starts_with(b"dd") {
                        pattern.push_str("%d");
                        index += 2;
                    } else {
                        pattern.push(bytes[index] as char);
                        index += 1;
                    }
                }
                Ok(Value::Text(date.format(&pattern).to_string()))
            }
            (other, _) => err(format!("DATEFORMAT 需要日期，收到{}", type_label(other))),
        },
        "TOTEXT" => Ok(Value::Text(values[0].to_display())),
        "TOINT" => match &values[0] {
            Value::Int(number) => Ok(Value::Int(*number)),
            Value::Bool(flag) => Ok(Value::Int(i64::from(*flag))),
            Value::Dec(number) => {
                if number.scale() > 0 {
                    return err("十进制数存在小数部分，转整数会损失精度（请先 ROUND）");
                }
                number
                    .mantissa()
                    .try_into()
                    .map(Value::Int)
                    .map_err(|_| RowError("整数超出范围".to_owned()))
            }
            Value::Text(text) => parse_integer_strict(text)
                .map(Value::Int)
                .map_err(|e| RowError(format!("文本“{text}”{e}"))),
            other => err(format!("TOINT 不支持{}", type_label(other))),
        },
        "TODECIMAL" => match &values[0] {
            Value::Int(number) => Ok(Value::Dec(Dec::from_i64(*number))),
            Value::Dec(number) => Ok(Value::Dec(*number)),
            Value::Text(text) => Dec::parse(text)
                .map(Value::Dec)
                .map_err(|e| RowError(format!("文本“{text}”{e}"))),
            other => err(format!("TODECIMAL 不支持{}", type_label(other))),
        },
        "TOBOOL" => match &values[0] {
            Value::Bool(flag) => Ok(Value::Bool(*flag)),
            Value::Int(number) => Ok(Value::Bool(*number != 0)),
            Value::Text(text) => parse_bool_strict(text)
                .map(Value::Bool)
                .ok_or_else(|| RowError(format!("无法识别为布尔值：{text}"))),
            other => err(format!("TOBOOL 不支持{}", type_label(other))),
        },
        other => err(format!("未知函数：{other}")),
    }
}

fn int_len_arg(value: &Value, function: &str) -> Result<i64, RowError> {
    match value {
        Value::Int(number) if *number >= 0 => Ok(*number),
        Value::Int(_) => err(format!("{function} 的长度参数不能为负数")),
        other => err(format!("{function} 的长度参数需要整数，收到{}", type_label(other))),
    }
}

/// 供节点做公式引用字段的集中校验（结构性错误，打开/保存/运行共用）。
pub(crate) fn missing_fields(expr: &Expr, available: &HashSet<&str>) -> Vec<String> {
    let mut referenced = Vec::new();
    collect_fields(expr, &mut referenced);
    referenced
        .into_iter()
        .filter(|name| !available.contains(name.as_str()))
        .collect()
}

/// 把公式结果的取值集合统一成一个列类型：同类则该类型；整数与十进制
/// 混合为十进制；其他混搭统一为文本（转换计数由调用方记入 stats）。

pub(crate) fn unify_types(values: &[Value]) -> (ColType, Vec<Value>, usize) {
    let mut saw_dec = false;
    let mut saw_other: Option<ColType> = None;
    for value in values {
        match value {
            Value::Null => {}
            Value::Int(_) => {}
            Value::Dec(_) => saw_dec = true,
            Value::Text(_) => saw_other = saw_other.or(Some(ColType::Text)),
            Value::Date(_) => saw_other = saw_other.or(Some(ColType::Date)),
            Value::Bool(_) => saw_other = saw_other.or(Some(ColType::Bool)),
        }
    }
    if let Some(kind) = saw_other {
        let mut converted = Vec::with_capacity(values.len());
        let mut changes = 0;
        for value in values {
            let target = match value {
                Value::Null => Value::Null,
                Value::Text(text) if kind == ColType::Text => Value::Text(text.clone()),
                Value::Date(date) if kind == ColType::Date => Value::Date(*date),
                Value::Bool(flag) if kind == ColType::Bool => Value::Bool(*flag),
                other => {
                    changes += 1;
                    Value::Text(other.to_display())
                }
            };
            converted.push(target);
        }
        return (kind, converted, changes);
    }
    if saw_dec {
        let mut converted = Vec::with_capacity(values.len());
        let mut changes = 0;
        for value in values {
            let target = match value {
                Value::Int(number) => {
                    changes += 1;
                    Value::Dec(Dec::from_i64(*number))
                }
                other => other.clone(),
            };
            converted.push(target);
        }
        return (ColType::Decimal, converted, changes);
    }
    (ColType::Integer, values.to_vec(), 0)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn eval_text(expression: &str) -> Result<String, String> {
        let expr = compile(expression).map_err(|e| e)?;
        let mut index = HashMap::new();
        index.insert("a".to_owned(), 0usize);
        index.insert("金额".to_owned(), 1usize);
        let context = EvalContext {
            today: NaiveDate::from_ymd_opt(2026, 10, 27).unwrap(),
            column_index: &index,
        };
        let row = vec![Value::Int(10), Value::Dec(Dec::parse("2.5").unwrap())];
        eval(&expr, &context, &row)
            .map(|value| value.to_display())
            .map_err(|error| error.0)
    }

    #[test]
    fn decimal_addition_is_exact() {
        assert_eq!(eval_text("0.1 + 0.2").unwrap(), "0.3");
        assert_eq!(eval_text("0.1 + 0.2 = 0.3").unwrap(), "true");
    }

    #[test]
    fn if_short_circuits_unreachable_division() {
        assert_eq!(eval_text("IF(1 > 2, 1 / 0, 42)").unwrap(), "42");
    }

    #[test]
    fn division_by_zero_is_row_error() {
        assert_eq!(eval_text("10 / 0").unwrap_err(), "除数为零");
    }

    #[test]
    fn integer_division_promotes_to_decimal() {
        assert_eq!(eval_text("1 / 2").unwrap(), "0.5");
        assert_eq!(eval_text("10 / 4").unwrap(), "2.5");
    }

    #[test]
    fn round_half_away_from_zero() {
        assert_eq!(eval_text("ROUND(1.005, 2)").unwrap(), "1.01");
        assert_eq!(eval_text("ROUND(-1.005, 2)").unwrap(), "-1.01");
        assert_eq!(eval_text("ROUND(2.5, 0)").unwrap(), "3");
    }

    #[test]
    fn field_reference_and_functions() {
        assert_eq!(eval_text("[金额] * 2").unwrap(), "5");
        assert_eq!(eval_text("CONCAT(\"编号\", TOTEXT(7))").unwrap(), "编号7");
        assert_eq!(eval_text("LEFT(\"审计工具箱\", 2)").unwrap(), "审计");
        assert_eq!(eval_text("SPLITPART(\"a-b-c\", \"-\", 2)").unwrap(), "b");
        assert_eq!(eval_text("SPLITPART(\"a-b-c\", \"-\", 9)").unwrap(), "");
        assert_eq!(eval_text("YEAR(TODAY())").unwrap(), "2026");
        assert_eq!(eval_text("YEARMONTH(TODAY())").unwrap(), "202610");
        assert_eq!(eval_text("DAYSBETWEEN(TODAY(), TODATE(\"2026-10-20\"))").unwrap(), "7");
        assert_eq!(eval_text("TOHALF(\"ＡＢ１２３\")").unwrap(), "AB123");
        assert_eq!(eval_text("COALESCE(ISNULL(NULL), \"兜底\")").unwrap(), "true");
    }

    #[test]
    fn null_propagation_and_three_valued_logic() {
        let expr = compile("AND(true, true)").unwrap();
        let mut index = HashMap::new();
        index.insert("空列".to_owned(), 0usize);
        let context = EvalContext {
            today: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            column_index: &index,
        };
        let row = vec![Value::Null];
        // 普通算术遇空值产生空值。
        let arithmetic = compile("[空列] + 1").unwrap();
        assert!(matches!(
            eval(&arithmetic, &context, &row).unwrap(),
            Value::Null
        ));
        // 三值逻辑：OR(null, false) = null；OR(null, true) = true。
        let or_null = compile("OR([空列], false)").unwrap();
        assert!(matches!(eval(&or_null, &context, &row).unwrap(), Value::Null));
        let or_true = compile("OR([空列], true)").unwrap();
        assert!(matches!(eval(&or_true, &context, &row).unwrap(), Value::Bool(true)));
        // IF 空条件按未成立。
        let if_null = compile("IF([空列], \"是\", \"否\")").unwrap();
        assert_eq!(eval(&if_null, &context, &row).unwrap().to_display(), "否");
        assert!(matches!(eval(&expr, &context, &row).unwrap(), Value::Bool(true)));
    }

    #[test]
    fn syntax_errors_are_reported() {
        assert!(compile("1 +").is_err());
        assert!(compile("[缺右括号").is_err());
        assert!(compile("UNKNOWNFN(1)").is_ok()); // 未知函数在求值期报错
        assert!(eval_text("UNKNOWNFN(1)").is_err());
    }
}
