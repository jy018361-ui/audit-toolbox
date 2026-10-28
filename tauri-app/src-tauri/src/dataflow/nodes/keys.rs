//! 第二期节点共用的「规范化键」：Join 匹配、去重、分组（汇总/透视/检查）
//! 都需要把一个或多个单元格值归一成可哈希、可比较的字符串键。
//!
//! 规则（设计文档第 9 节）：
//! - 数值键跨整数/十进制按数值相等归一（Int(5) 与 Dec("5.0") 同键）；
//! - 文本键区分空值与空文本（Null ≠ Text("")，二者不合并）；
//! - 日期、布尔按各自值归一；
//! - Join 空值键不参与匹配（调用方先排除）；分组/去重把同位置空值视为同一键。

use crate::dataflow::value::{Dec, Value};

/// 判定空值：Null 或纯空格文本（检查节点「非空」从严口径，默认裁定第 10 条）。
pub(crate) fn is_blank(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Text(text) => text.trim().is_empty(),
        _ => false,
    }
}

/// 单值规范化键。Null 产出固定占位（仅在分组/去重语义中使用；
/// Join 调用方必须先排除空值键）。
pub(crate) fn value_key(value: &Value) -> String {
    match value {
        Value::Null => "\u{2205}NULL".to_owned(),
        Value::Bool(flag) => format!("B:{flag}"),
        Value::Int(number) => format!("N:{}", normalize_dec(i128::from(*number), 0)),
        Value::Dec(number) => format!("N:{}", normalize_dec(number.mantissa(), number.scale())),
        Value::Text(text) => format!("T:{text}"),
        Value::Date(date) => format!("D:{}", date.format("%Y-%m-%d")),
    }
}

/// 复合键（按字段顺序拼接，避免跨列歧义）。
pub(crate) fn composite_key(values: &[Value]) -> String {
    let mut key = String::new();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            key.push('\u{1}');
        }
        key.push_str(&value_key(value));
    }
    key
}

/// 数值归一：去掉 mantissa 尾部零（5.00 → 5），使整数与等值十进制同键。
fn normalize_dec(mantissa: i128, mut scale: u32) -> String {
    let mut mantissa = mantissa;
    while scale > 0 && mantissa % 10 == 0 {
        mantissa /= 10;
        scale -= 1;
    }
    if scale == 0 {
        mantissa.to_string()
    } else {
        // 手工构造最短形式（mantissa/scale 已去尾零）。
        let negative = mantissa < 0;
        let digits = mantissa.unsigned_abs().to_string();
        let scale = scale as usize;
        if digits.len() <= scale {
            let text = format!("0.{}{}", "0".repeat(scale - digits.len()), digits);
            if negative {
                format!("-{text}")
            } else {
                text
            }
        } else {
            let text = format!("{}.{}", &digits[..digits.len() - scale], &digits[digits.len() - scale..]);
            if negative {
                format!("-{text}")
            } else {
                text
            }
        }
    }
}

/// 数值比较（跨 Int/Dec 用精确十进制比较，避免 i128 对齐溢出）。
pub(crate) fn compare_numeric(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Int(a), Value::Int(b)) => Some(a.cmp(b)),
        (Value::Int(a), Value::Dec(b)) => Some(Dec::from_i64(*a).cmp_exact(*b)),
        (Value::Dec(a), Value::Int(b)) => Some(a.cmp_exact(Dec::from_i64(*b))),
        (Value::Dec(a), Value::Dec(b)) => Some(a.cmp_exact(*b)),
        _ => None,
    }
}

/// 同类型值比较（文本按码点、日期按时间、布尔 false<true）；
/// 数值跨 Int/Dec 精确比较；其他混搭返回 None（调用方决定回退策略）。
pub(crate) fn compare_values(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Null, _) | (_, Value::Null) => None,
        (Value::Text(a), Value::Text(b)) => Some(a.cmp(b)),
        (Value::Date(a), Value::Date(b)) => Some(a.cmp(b)),
        (Value::Bool(a), Value::Bool(b)) => Some(a.cmp(b)),
        _ => compare_numeric(left, right),
    }
}
