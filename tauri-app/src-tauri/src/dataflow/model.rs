//! 数据流（DataFlow）工作流 JSON 的 serde 模型。
//!
//! 与前端契约一致（camelCase，不强制 deny_unknown_fields，前端新增字段
//! 不应导致旧引擎解析失败）。顶层结构：
//! `{version, name, params:[{id,name,type,value}], nodes:[{id,type,name,x,y,config}],
//! edges:[{from,fromAnchor,to,toAnchor}], notes}`，
//! 运行时额外可带 `paramOverrides:{参数id: 值}` 覆盖参数默认值。

use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunRequest {
    #[serde(default)]
    pub version: Option<Value>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    #[serde(default)]
    pub notes: Option<Value>,
    /// 参数确认页传入的覆盖值（缺省回落 params 里的默认 value）。
    #[serde(default)]
    pub param_overrides: HashMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Param {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Edge {
    pub from: String,
    #[serde(default)]
    pub from_anchor: Option<String>,
    pub to: String,
    #[serde(default)]
    pub to_anchor: Option<String>,
}

/// 行级异常策略：停止（默认）或跳过整行并记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RowErrorPolicy {
    Stop,
    Skip,
}

impl RowErrorPolicy {
    pub(crate) fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("stop").to_ascii_lowercase().as_str() {
            "skip" => RowErrorPolicy::Skip,
            _ => RowErrorPolicy::Stop,
        }
    }
}

fn default_source_type() -> String {
    "file".to_owned()
}
fn default_header_row() -> usize {
    1
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExcelInConfig {
    #[serde(default = "default_source_type")]
    pub source_type: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub file_pattern: Option<String>,
    /// "firstData"（每个文件第一个有数据的 Sheet，默认）| "byName"。
    #[serde(default)]
    pub sheet_mode: Option<String>,
    #[serde(default)]
    pub sheet_name: Option<String>,
    #[serde(default = "default_header_row")]
    pub header_row: usize,
    #[serde(default)]
    pub data_start_row: Option<usize>,
    #[serde(default = "default_true")]
    pub attach_source_columns: bool,
    #[serde(default)]
    pub on_row_error: Option<String>,
    #[serde(default)]
    pub column_types: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvInConfig {
    #[serde(default = "default_source_type")]
    pub source_type: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub file_pattern: Option<String>,
    /// "auto"（默认）| "gbk" | "utf8" | "utf8bom" | "utf16"。
    #[serde(default)]
    pub encoding: Option<String>,
    /// "auto"（默认）| "comma" | "tab" | "semicolon" | "pipe"。
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default = "default_header_row")]
    pub header_row: usize,
    #[serde(default)]
    pub data_start_row: Option<usize>,
    #[serde(default = "default_true")]
    pub attach_source_columns: bool,
    #[serde(default)]
    pub on_row_error: Option<String>,
    #[serde(default)]
    pub column_types: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SelectField {
    pub source: String,
    #[serde(default = "default_true")]
    pub keep: bool,
    #[serde(default)]
    pub rename: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectConfig {
    #[serde(default)]
    pub fields: Vec<SelectField>,
    #[serde(default = "default_true")]
    pub pass_through_new_fields: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CleanAction {
    pub field: String,
    #[serde(default)]
    pub ops: Vec<String>,
    #[serde(default)]
    pub replace_from: Option<String>,
    #[serde(default)]
    pub replace_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanConfig {
    #[serde(default)]
    pub actions: Vec<CleanAction>,
    #[serde(default)]
    pub drop_blank_rows: bool,
    #[serde(default)]
    pub null_text_to_null: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FormulaItem {
    pub target: String,
    pub expression: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormulaConfig {
    #[serde(default)]
    pub formulas: Vec<FormulaItem>,
    /// 行级异常策略（默认 stop；除零、转换失败等）。
    #[serde(default)]
    pub on_row_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FilterRule {
    pub field: String,
    pub operator: String,
    #[serde(default)]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct FilterCondition {
    /// "and" | "or"。
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub rules: Vec<FilterRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilterConfig {
    pub condition: FilterCondition,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExcelOutConfig {
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub sheet_name: Option<String>,
    /// "error"（默认，已存在即报错）| "timestamp" | "replace"。
    #[serde(default)]
    pub overwrite: Option<String>,
    /// "sheet"（默认）| "file" | "error"——超 1048576 行时的处理。
    #[serde(default)]
    pub split_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CsvOutConfig {
    #[serde(default)]
    pub file_name: String,
    /// "gbk"（默认）| "utf8bom" | "utf8"。
    #[serde(default)]
    pub encoding: Option<String>,
    /// "comma"（默认）| "tab" | "semicolon" | "pipe"。
    #[serde(default)]
    pub delimiter: Option<String>,
    /// 每个文件最大数据行数；0 或缺省 = 不分文件。
    #[serde(default)]
    pub split_rows: Option<usize>,
    /// 覆盖保护："error"（默认）| "timestamp" | "replace"（设计文档第 7 节）。
    #[serde(default)]
    pub overwrite: Option<String>,
}
