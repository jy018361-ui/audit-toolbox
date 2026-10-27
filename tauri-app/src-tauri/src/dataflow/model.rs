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
    /// 「运行到选中节点」：只执行该节点及其全部上游（按 edges 反向闭包），
    /// 未执行节点不出现在响应 nodes 中；缺省＝运行全部节点。
    #[serde(default)]
    pub upto_node_id: Option<String>,
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

// ---------------------------------------------------------------------------
// 第二期节点配置（12 个新节点，camelCase 与前端契约严格一致）
// ---------------------------------------------------------------------------

/// 关联 Join：一对键配对（复合键多对）。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct JoinKeyPair {
    pub left: String,
    pub right: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JoinConfig {
    #[serde(default)]
    pub keys: Vec<JoinKeyPair>,
    /// 左侧输出字段；空 = 全部保留。
    #[serde(default)]
    pub left_fields: Vec<String>,
    /// 右侧输出字段；空 = 全部保留。
    #[serde(default)]
    pub right_fields: Vec<String>,
    /// 右侧同名字段后缀（默认裁定第 6 条：右侧加 _右）。
    #[serde(default = "default_same_name_suffix")]
    pub same_name_suffix: String,
}

fn default_same_name_suffix() -> String {
    "_右".to_owned()
}

/// 纵向合并 Union。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnionConfig {
    /// "byName"（默认）| "byPosition"。
    #[serde(default)]
    pub align: Option<String>,
    /// "keep"（默认，字段取并集）| "drop"（仅保留第一个输入的字段）。
    #[serde(default)]
    pub extra_field_policy: Option<String>,
    /// 类型冲突策略：首版仅 "text"（统一文本并提示）。
    #[serde(default)]
    pub type_conflict_policy: Option<String>,
    /// 拼接次序：上游节点 id 数组；空 = 按连线顺序（默认裁定第 7 条）。
    #[serde(default)]
    pub order: Vec<String>,
}

/// 去重 Unique。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UniqueConfig {
    #[serde(default)]
    pub fields: Vec<String>,
    /// "first"（默认）| "last"；保留规则按输入到达序（可解释、可重现）。
    #[serde(default)]
    pub keep: Option<String>,
}

/// 排序 Sort 的单字段规则。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SortRule {
    pub field: String,
    /// "asc"（默认）| "desc"。
    #[serde(default)]
    pub direction: Option<String>,
    /// "last"（默认）| "first"；空值位置逐字段可配（默认裁定第 4 条）。
    #[serde(default)]
    pub nulls: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct SortConfig {
    #[serde(default)]
    pub rules: Vec<SortRule>,
}

/// 汇总 Summarize 的单条聚合配置。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AggregationSpec {
    /// 源字段；空仅 countAll 合法。
    #[serde(default)]
    pub field: String,
    /// countAll | countNonEmpty | distinctCount | sum | avg | min | max。
    pub func: String,
    /// 输出字段名；空 = 默认命名（countAll=总行数，其余=字段_聚合中文名）。
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummarizeConfig {
    /// 分组字段；空 = 全表一组（默认裁定第 15 条）。
    #[serde(default)]
    pub group_by: Vec<String>,
    #[serde(default)]
    pub aggregations: Vec<AggregationSpec>,
}

/// 透视 Crosstab（首版列字段只支持 1 个，默认裁定第 8 条）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrosstabConfig {
    #[serde(default)]
    pub row_field: String,
    #[serde(default)]
    pub column_field: String,
    #[serde(default)]
    pub value_field: String,
    /// sum | countNonEmpty | distinctCount。
    #[serde(default)]
    pub value_func: Option<String>,
    /// 缺失组合填充值：数字（默认 0）或 null。
    #[serde(default = "default_crosstab_fill")]
    pub fill: Value,
}

fn default_crosstab_fill() -> Value {
    Value::from(0)
}

/// 宽转长 Transpose（默认列名：项目 / 数值，默认裁定第 9 条）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransposeConfig {
    #[serde(default)]
    pub fixed_fields: Vec<String>,
    #[serde(default)]
    pub value_columns: Vec<String>,
    #[serde(default = "default_name_column")]
    pub name_column: String,
    #[serde(default = "default_value_column")]
    pub value_column: String,
}

fn default_name_column() -> String {
    "项目".to_owned()
}
fn default_value_column() -> String {
    "数值".to_owned()
}

/// 分列 Split。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SplitConfig {
    #[serde(default)]
    pub field: String,
    /// "delimiter" | "fixedWidth"。
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub delimiter: String,
    #[serde(default)]
    pub widths: Vec<usize>,
    #[serde(default)]
    pub keep_original: bool,
    #[serde(default)]
    pub column_prefix: String,
}

/// 检查 Check 的规则（按 kind 区分五种形态；name 可选自定义规则名）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum CheckRule {
    /// 借贷合计一致（groupBy 空 = 全表）。
    Balance {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        group_by: Option<String>,
        debit_field: String,
        credit_field: String,
        /// 必须显式配置（设计文档）。
        tolerance: Option<Value>,
    },
    /// 关键字段非空（空值与纯空格都算空，默认裁定第 10 条）。
    NotEmpty {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        fields: Vec<String>,
    },
    /// 编号唯一（groupBy 空 = 全表；空值不参与唯一性；重复整组进 NG）。
    Unique {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        field: String,
        #[serde(default)]
        group_by: Option<String>,
    },
    /// 数值区间（闭区间；空值判 NG 并标注「空值」）。
    Range {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        field: String,
        #[serde(default)]
        min: Option<Value>,
        #[serde(default)]
        max: Option<Value>,
    },
    /// 自定义行级条件（公式求值器；结果为假或空值 → NG）。
    Expression {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        expression: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckConfig {
    #[serde(default)]
    pub rules: Vec<CheckRule>,
}

/// 手工输入 Manual Input 的列定义。
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ManualColumn {
    pub name: String,
    /// text | int | decimal | date | bool；空/auto = 自动识别（超 15 位保底文本）。
    #[serde(default)]
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManualInConfig {
    #[serde(default)]
    pub columns: Vec<ManualColumn>,
    /// 行数据（config 即数据，小表随流程文件保存）。
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub on_row_error: Option<String>,
}

/// 数据库文件输入 DB File Input（SQLite 优先验证对象）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DbInConfig {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub table: String,
    /// 空 = 全部列。
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub on_row_error: Option<String>,
}

/// Parquet 输入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParquetInConfig {
    #[serde(default)]
    pub path: String,
    /// 空 = 全部列。
    #[serde(default)]
    pub fields: Vec<String>,
}
