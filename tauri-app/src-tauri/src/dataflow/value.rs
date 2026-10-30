//! 数据流（DataFlow）第一期的列值类型系统。
//!
//! 类型按设计文档 DATAFLOW_DESIGN.md 第 9 节执行：
//! - 金额等要求精确十进制计算的字段使用定点十进制 [`Dec`]（i128 尾数 + 10 的幂），
//!   绝不走二进制浮点（0.1 + 0.2 必须等于 0.3）；
//! - 整数位数超过 15 位（[`INT_DIGIT_LIMIT`]）时默认按文本读入（列类型锁定可覆盖）；
//! - 空值（Null）与空文本（Text("")）是两个不同的值，空值不参与筛选 T 路；
//! - 日期只到「日」，不含时分秒（日期时间为后续期次；含时间部分且非零点的
//!   文本不自动降为日期，见 `parse_date_auto` 的说明）。

use chrono::NaiveDate;
use std::cmp::Ordering;
use std::fmt;

/// 自动类型建议时允许按整数读入的最大位数（超 15 位保底文本，设计文档第 9 节）。
pub(crate) const INT_DIGIT_LIMIT: usize = 15;
/// 定点十进制允许的最大小数位（解析与计算共用上限）。
pub(crate) const MAX_SCALE: u32 = 15;
/// 除法结果最多保留的小数位（超出部分向零截断，规则记录在节点 stats）。
pub(crate) const DIV_SCALE_LIMIT: u32 = 12;

/// 定点十进制：值 = mantissa / 10^scale。永不使用二进制浮点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Dec {
    mantissa: i128,
    scale: u32,
}

impl Dec {
    pub(crate) fn from_i64(value: i64) -> Self {
        Self {
            mantissa: value as i128,
            scale: 0,
        }
    }

    /// 精确解析十进制文本：允许首尾空白、正负号、千分位逗号（如 "1,234.56"）。
    /// 小数位超过 [`MAX_SCALE`] 或有效数字过大时报错（不静默截断）。
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let cleaned: String = text.trim().chars().filter(|c| *c != ',').collect();
        if cleaned.is_empty() {
            return Err("不是有效的十进制数".to_owned());
        }
        let mut mantissa: i128 = 0;
        let mut scale: u32 = 0;
        let mut seen_dot = false;
        let mut seen_digit = false;
        let bytes = cleaned.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            match byte {
                b'-' | b'+' if index == 0 => {}
                b'0'..=b'9' => {
                    seen_digit = true;
                    if seen_dot {
                        if scale >= MAX_SCALE {
                            return Err(format!("小数位超过 {MAX_SCALE} 位上限"));
                        }
                        scale += 1;
                    }
                    mantissa = mantissa
                        .checked_mul(10)
                        .and_then(|m| m.checked_add((byte - b'0') as i128))
                        .ok_or_else(|| "数值超出可表示范围".to_owned())?;
                }
                b'.' if !seen_dot => seen_dot = true,
                _ => return Err("不是有效的十进制数".to_owned()),
            }
        }
        if !seen_digit || (seen_dot && scale == 0) {
            // "12." 视为非法；"."、"+"/"-" 同样非法。
            if seen_dot && scale == 0 && seen_digit {
                return Err("小数点后缺少数字".to_owned());
            }
            return Err("不是有效的十进制数".to_owned());
        }
        Ok(Self { mantissa, scale })
    }

    pub(crate) fn mantissa(&self) -> i128 {
        self.mantissa
    }
    pub(crate) fn scale(&self) -> u32 {
        self.scale
    }

    /// 去掉小数尾部的零后按最短形式输出（内部值不变，仅显示）。
    pub(crate) fn to_text(&self) -> String {
        let negative = self.mantissa < 0;
        let digits = self.mantissa.unsigned_abs().to_string();
        let scale = self.scale as usize;
        let mut text = if scale == 0 {
            digits
        } else if digits.len() <= scale {
            format!("0.{}{}", "0".repeat(scale - digits.len()), digits)
        } else {
            format!("{}.{}", &digits[..digits.len() - scale], &digits[digits.len() - scale..])
        };
        if scale > 0 {
            while text.ends_with('0') {
                text.pop();
            }
            if text.ends_with('.') {
                text.pop();
            }
        }
        if negative && text != "0" {
            format!("-{text}")
        } else {
            text
        }
    }

    pub(crate) fn is_zero(&self) -> bool {
        self.mantissa == 0
    }
    pub(crate) fn is_negative(&self) -> bool {
        self.mantissa < 0
    }

    pub(crate) fn abs(&self) -> Self {
        Self {
            mantissa: self.mantissa.abs(),
            scale: self.scale,
        }
    }

    fn aligned(self, scale: u32) -> Result<i128, String> {
        if scale >= self.scale {
            let factor = 10i128
                .checked_pow(scale - self.scale)
                .ok_or_else(|| "数值超出可表示范围".to_owned())?;
            self.mantissa
                .checked_mul(factor)
                .ok_or_else(|| "数值超出可表示范围".to_owned())
        } else {
            // 降位（截断）：只在内部对齐时发生，调用方保证只在比大小时使用。
            let factor = 10i128
                .checked_pow(self.scale - scale)
                .ok_or_else(|| "数值超出可表示范围".to_owned())?;
            Ok(self.mantissa / factor)
        }
    }

    pub(crate) fn checked_add(self, other: Self) -> Result<Self, String> {
        let scale = self.scale.max(other.scale);
        let left = self.aligned(scale)?;
        let right = other.aligned(scale)?;
        Ok(Self {
            mantissa: left
                .checked_add(right)
                .ok_or_else(|| "数值超出可表示范围（加法溢出）".to_owned())?,
            scale,
        })
    }

    pub(crate) fn checked_sub(self, other: Self) -> Result<Self, String> {
        let scale = self.scale.max(other.scale);
        let left = self.aligned(scale)?;
        let right = other.aligned(scale)?;
        Ok(Self {
            mantissa: left
                .checked_sub(right)
                .ok_or_else(|| "数值超出可表示范围（减法溢出）".to_owned())?,
            scale,
        })
    }

    pub(crate) fn checked_mul(self, other: Self) -> Result<Self, String> {
        let scale = self.scale + other.scale;
        if scale > MAX_SCALE {
            return Err(format!("乘积小数位超过 {MAX_SCALE} 位上限"));
        }
        Ok(Self {
            mantissa: self
                .mantissa
                .checked_mul(other.mantissa)
                .ok_or_else(|| "数值超出可表示范围（乘法溢出）".to_owned())?,
            scale,
        })
    }

    /// 除法：先尝试整除得到精确终止小数；除不尽时最多保留
    /// [`DIV_SCALE_LIMIT`] 位，超出部分向零截断（第一期规则，记入节点 stats）。
    pub(crate) fn checked_div(self, other: Self) -> Result<Self, String> {
        if other.mantissa == 0 {
            return Err("除数为零".to_owned());
        }
        let mut target: u32 = 0;
        loop {
            // M = m1 * 10^(s2 + target - s1) / m2（指数为负时改为放大分母）。
            let exponent = other.scale as i64 + target as i64 - self.scale as i64;
            let (numerator, denominator) = if exponent >= 0 {
                let factor = 10i128
                    .checked_pow(exponent as u32)
                    .ok_or_else(|| "数值超出可表示范围".to_owned())?;
                (
                    self.mantissa.checked_mul(factor).ok_or_else(|| "数值超出可表示范围".to_owned())?,
                    other.mantissa,
                )
            } else {
                let factor = 10i128
                    .checked_pow((-exponent) as u32)
                    .ok_or_else(|| "数值超出可表示范围".to_owned())?;
                (self.mantissa, other.mantissa.checked_mul(factor).ok_or_else(|| "数值超出可表示范围".to_owned())?)
            };
            let quotient = numerator / denominator;
            let remainder = numerator % denominator;
            if remainder == 0 {
                return Ok(Self {
                    mantissa: quotient,
                    scale: target,
                });
            }
            if target >= DIV_SCALE_LIMIT {
                return Ok(Self {
                    mantissa: quotient,
                    scale: target,
                });
            }
            target += 1;
        }
    }

    /// 四舍五入（中点远离零）：ROUND(1.005, 2) = 1.01，ROUND(-1.005, 2) = -1.01。
    /// n 为负数时舍入到十位以上（结果 scale = 0）。
    pub(crate) fn round(self, digits: i64) -> Result<Self, String> {
        if digits < 0 {
            let shift = (-digits) as u32;
            let mantissa = self.mantissa_rescaled_to_zero(shift)?;
            let factor = 10i128
                .checked_pow(shift)
                .ok_or_else(|| "数值超出可表示范围".to_owned())?;
            return Ok(Self {
                mantissa: round_half_away(mantissa, factor),
                scale: 0,
            });
        }
        let digits = digits as u32;
        if self.scale <= digits {
            return Ok(self);
        }
        let factor = 10i128
            .checked_pow(self.scale - digits)
            .ok_or_else(|| "数值超出可表示范围".to_owned())?;
        Ok(Self {
            mantissa: round_half_away(self.mantissa, factor),
            scale: digits,
        })
    }

    fn mantissa_rescaled_to_zero(self, shift: u32) -> Result<i128, String> {
        let exponent = self.scale + shift;
        let factor = 10i128
            .checked_pow(exponent)
            .ok_or_else(|| "数值超出可表示范围".to_owned())?;
        self.mantissa
            .checked_mul(factor)
            .ok_or_else(|| "数值超出可表示范围".to_owned())
    }

    /// 用 digit 字符串做精确比较，避免大数对齐时 i128 溢出。
    pub(crate) fn cmp_exact(self, other: Self) -> Ordering {
        let (sign_a, int_a, frac_a) = self.digit_parts();
        let (sign_b, int_b, frac_b) = other.digit_parts();
        let order = sign_a.cmp(&sign_b);
        if order != Ordering::Equal {
            return order;
        }
        let int_order = (int_a.len(), int_a.as_str()).cmp(&(int_b.len(), int_b.as_str()));
        if int_order != Ordering::Equal {
            return if sign_a == Ordering::Less {
                int_order.reverse()
            } else {
                int_order
            };
        }
        let width = frac_a.len().max(frac_b.len());
        let padded_a = format!("{frac_a:0<width$}", width = width);
        let padded_b = format!("{frac_b:0<width$}", width = width);
        let frac_order = padded_a.cmp(&padded_b);
        if sign_a == Ordering::Less {
            frac_order.reverse()
        } else {
            frac_order
        }
    }

    /// 返回（符号序，去前导零整数位字符串，去尾零小数位字符串）。
    fn digit_parts(self) -> (Ordering, String, String) {
        let negative = self.mantissa < 0;
        let digits = self.mantissa.unsigned_abs().to_string();
        let scale = self.scale as usize;
        let (int_part, frac_part) = if scale == 0 {
            (digits, String::new())
        } else if digits.len() <= scale {
            (
                "0".to_owned(),
                format!("{}{}", "0".repeat(scale - digits.len()), digits),
            )
        } else {
            (
                digits[..digits.len() - scale].to_owned(),
                digits[digits.len() - scale..].to_owned(),
            )
        };
        let int_trimmed = int_part.trim_start_matches('0').to_owned();
        let int_out = if int_trimmed.is_empty() { "0".to_owned() } else { int_trimmed };
        let mut frac_out = frac_part;
        while frac_out.ends_with('0') {
            frac_out.pop();
        }
        let sign = if int_out == "0" && frac_out.is_empty() {
            Ordering::Equal
        } else if negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
        (sign, int_out, frac_out)
    }
}

fn round_half_away(mantissa: i128, factor: i128) -> i128 {
    let quotient = mantissa / factor;
    let remainder = mantissa % factor;
    if remainder.abs() * 2 >= factor.abs() {
        quotient + mantissa.signum()
    } else {
        quotient
    }
}

impl fmt::Display for Dec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_text())
    }
}

/// 列类型。第一期覆盖文本/整数/十进制/日期四类核心类型，
/// 布尔仅作为公式与筛选的中间类型出现。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ColType {
    Text,
    Integer,
    Decimal,
    Date,
    Bool,
}

impl ColType {
    pub(crate) fn key(self) -> &'static str {
        match self {
            ColType::Text => "text",
            ColType::Integer => "integer",
            ColType::Decimal => "decimal",
            ColType::Date => "date",
            ColType::Bool => "bool",
        }
    }

    pub(crate) fn display(self) -> &'static str {
        match self {
            ColType::Text => "文本",
            ColType::Integer => "整数",
            ColType::Decimal => "十进制小数",
            ColType::Date => "日期",
            ColType::Bool => "布尔值",
        }
    }

    /// 解析 columnTypes 锁定配置里的类型名（支持常见别名）。
    ///
    /// 前端 src/dataflow/ConfigPanel.tsx 的 COLUMN_TYPE_OPTIONS 与
    /// src/dataflow/model.ts 的 MANUAL_COLUMN_TYPES 提供的每个 value
    /// 都必须能被这里识别，否则用户一锁定该类型，输入节点整次运行即报
    /// 「锁定类型无法识别」（两侧清单的对照测试见文件尾 tests 模块）。
    /// "datetime"（日期时间）第一期按日期处理——引擎日期只到日、不含
    /// 时分秒（见模块文档），日期时间完整语义为后续期期内容。
    pub(crate) fn parse(key: &str) -> Option<Self> {
        match key.trim().to_ascii_lowercase().as_str() {
            "text" | "文本" | "string" | "str" => Some(ColType::Text),
            "integer" | "int" | "整数" => Some(ColType::Integer),
            "decimal" | "number" | "数值" | "十进制" | "金额" => Some(ColType::Decimal),
            "date" | "datetime" | "日期" | "日期时间" => Some(ColType::Date),
            "bool" | "boolean" | "布尔" => Some(ColType::Bool),
            _ => None,
        }
    }
}

/// 单元格值。Null 表示数据源中的空值（区别于空文本 Text("")）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Dec(Dec),
    Text(String),
    Date(NaiveDate),
}

impl Value {
    pub(crate) fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Int(_) => "integer",
            Value::Dec(_) => "decimal",
            Value::Text(_) => "text",
            Value::Date(_) => "date",
        }
    }

    /// 转为面向用户的显示文本（写 CSV、报错定位用）。
    pub(crate) fn to_display(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(value) => value.to_string(),
            Value::Int(value) => value.to_string(),
            Value::Dec(value) => value.to_text(),
            Value::Text(value) => value.clone(),
            Value::Date(date) => date.format("%Y-%m-%d").to_string(),
        }
    }
}

/// 全角转半角：全角 ASCII 区（！-～）与全角空格（U+3000）。
pub(crate) fn char_to_half_width(character: char) -> char {
    match character as u32 {
        0x3000 => ' ',
        0xFF01..=0xFF5E => char::from_u32(character as u32 - 0xFF00 + 0x20).unwrap_or(character),
        _ => character,
    }
}

pub(crate) fn string_to_half_width(text: &str) -> String {
    text.chars().map(char_to_half_width).collect()
}

/// 去不可见字符：控制字符（保留制表符）、零宽字符与 BOM。
pub(crate) fn strip_invisible(text: &str) -> String {
    text.chars()
        .filter(|c| {
            !matches!(c, '\u{200B}' | '\u{FEFF}')
                && (!c.is_control() || *c == '\t')
        })
        .collect()
}

/// 去首尾空格：ASCII 空格、全角空格、制表符与换行。
pub(crate) fn trim_spaces(text: &str) -> &str {
    text.trim_matches(|c: char| c == ' ' || c == '\u{3000}' || c == '\t' || c == '\r' || c == '\n')
}

/// 严格整数解析（用于显式转换与锁定为整数的列；允许前导零）。
pub(crate) fn parse_integer_strict(text: &str) -> Result<i64, String> {
    let trimmed = trim_spaces(text);
    if trimmed.is_empty() {
        return Err("不是有效的整数".to_owned());
    }
    trimmed
        .parse::<i64>()
        .map_err(|_| "不是有效的整数".to_owned())
}

/// 自动类型判定用的整数检查：纯数字、无前导零、不超过 15 位。
pub(crate) fn looks_like_auto_integer(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > INT_DIGIT_LIMIT + 1 {
        return false;
    }
    if let Some(rest) = trimmed.strip_prefix('-') {
        rest.len() <= INT_DIGIT_LIMIT
            && rest.bytes().all(|b| b.is_ascii_digit())
            && (rest.len() == 1 || !rest.starts_with('0'))
    } else {
        trimmed.bytes().all(|b| b.is_ascii_digit())
            && (trimmed.len() == 1 || !trimmed.starts_with('0'))
    }
}

/// 纯数字串的位数（含负号则不算），超过 15 位时自动判定应保底文本。
pub(crate) fn integer_digits_exceed_limit(text: &str) -> bool {
    let digits: String = text
        .trim()
        .trim_start_matches(['+', '-'])
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    digits.len() > INT_DIGIT_LIMIT
}

/// 自动类型判定用的十进制检查：允许千分位逗号与一位小数点；纯整数也视为
/// 十进制候选（整数与十进制混合的列应判为十进制，设计文档第 9 节），
/// 但带前导零的纯整数除外（"0012" 保持文本，前导零不丢）。
pub(crate) fn looks_like_auto_decimal(text: &str) -> bool {
    let trimmed = trim_spaces(text);
    if trimmed.is_empty() {
        return false;
    }
    let mut saw_dot = false;
    let mut saw_digit = false;
    for (index, character) in trimmed.chars().enumerate() {
        match character {
            '+' | '-' if index == 0 => {}
            '0'..='9' => saw_digit = true,
            ',' => {}
            '.' if !saw_dot => saw_dot = true,
            _ => return false,
        }
    }
    if !saw_digit {
        return false;
    }
    if saw_dot || trimmed.contains(',') {
        return true;
    }
    // 纯整数：仅当无前导零（或恰为 "0"）时才作为十进制候选。
    let digits = trimmed.trim_start_matches(['+', '-']);
    digits == "0" || !digits.starts_with('0')
}

/// 自动类型判定可识别的日期：带分隔符的 y-m-d / y/m/d / y.m.d，
/// 以及恰好零点的日期时间（Excel 单元格经统一读取层渲染成
/// "yyyy-mm-dd 00:00:00"）。含非零时间部分的文本不自动降为日期
/// （设计文档第 9 节：日期时间转日期须显式配置）。
pub(crate) fn parse_date_auto(text: &str) -> Option<NaiveDate> {
    let trimmed = trim_spaces(text);
    let formats = ["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"];
    for format in formats {
        if let Ok(date) = NaiveDate::parse_from_str(trimmed, format) {
            return Some(date);
        }
    }
    if let Ok(datetime) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        if datetime.time() == chrono::NaiveTime::default() {
            return Some(datetime.date());
        }
    }
    None
}

/// 显式日期转换（columnTypes 锁定 / TODATE 公式）：在自动规则之上
/// 额外接受 8 位连续数字日期（20261027），用于用户明确指定类型的场景。
pub(crate) fn parse_date_explicit(text: &str) -> Option<NaiveDate> {
    if let Some(date) = parse_date_auto(text) {
        return Some(date);
    }
    let trimmed = trim_spaces(text);
    if trimmed.len() == 8 && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return NaiveDate::parse_from_str(trimmed, "%Y%m%d").ok();
    }
    None
}

/// 布尔解析（公式 TOBOOL 与筛选布尔列用）。
pub(crate) fn parse_bool_strict(text: &str) -> Option<bool> {
    match trim_spaces(text).to_ascii_lowercase().as_str() {
        "true" | "1" | "是" | "y" | "yes" => Some(true),
        "false" | "0" | "否" | "n" | "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端 src/dataflow/ConfigPanel.tsx 的 COLUMN_TYPE_OPTIONS（value 集合），
    /// 即「列类型锁定」下拉的全部选项。前端清单更新时须同步本常量。
    const FRONTEND_COLUMN_TYPE_KEYS: &[&str] =
        &["text", "integer", "decimal", "boolean", "date", "datetime"];

    /// 前端 src/dataflow/model.ts 的 MANUAL_COLUMN_TYPES（value 集合），
    /// 即手工建表列类型的全部选项。前端清单更新时须同步本常量。
    const FRONTEND_MANUAL_COLUMN_KEYS: &[&str] = &["text", "int", "decimal", "date"];

    /// F6 回归：前端界面提供的每一个列类型选项引擎都必须认识，
    /// 否则用户一锁定，输入节点整次运行即报
    /// 「列"X"的锁定类型"…"无法识别」。
    #[test]
    fn parse_accepts_every_frontend_column_type_option() {
        for key in FRONTEND_COLUMN_TYPE_KEYS
            .iter()
            .chain(FRONTEND_MANUAL_COLUMN_KEYS.iter())
        {
            assert!(
                ColType::parse(key).is_some(),
                "前端提供的列类型“{key}”引擎无法识别，用户锁定后整次运行必失败"
            );
        }
    }

    /// datetime（日期时间）第一期映射到日期：引擎日期只到日。
    #[test]
    fn parse_datetime_aliases_to_date() {
        assert_eq!(ColType::parse("datetime"), Some(ColType::Date));
        assert_eq!(ColType::parse("日期时间"), Some(ColType::Date));
        assert_eq!(ColType::parse("  Datetime  "), Some(ColType::Date));
        // 锁定后按日期读入的解析路径与 date 完全一致。
        assert_eq!(ColType::parse("datetime"), ColType::parse("date"));
        // 真正无法识别的取值仍返回 None（input.rs 会转成配置错误）。
        assert_eq!(ColType::parse("timestamp"), None);
        assert_eq!(ColType::parse(""), None);
    }
}
