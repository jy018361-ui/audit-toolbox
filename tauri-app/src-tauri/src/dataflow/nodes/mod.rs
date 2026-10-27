//! 数据流（DataFlow）节点实现：
//! 第一期 8 类——输入（excel_in / csv_in）、整理（select / clean / formula）、
//! 筛选（filter）、输出（excel_out / csv_out）；
//! 第二期 12 类——关联（join_n）、合并（union_n）、去重（unique_n）、
//! 排序（sort_n）、汇总（summarize）、透视（crosstab）、宽转长（transpose）、
//! 分列（split）、检查（check_n）、手工输入（manual_in）、数据库文件输入
//! （db_in）、Parquet 输入（parquet_in），以及数据库表清单 db_tables。

pub(crate) mod aggregate;
pub(crate) mod check;
pub(crate) mod combine;
pub(crate) mod input;
pub(crate) mod inputs2;
pub(crate) mod join;
pub(crate) mod keys;
pub(crate) mod output;
pub(crate) mod split;
pub(crate) mod transform;

use super::value::{ColType, Value};
use crate::AppError;
use chrono::NaiveDate;
use std::collections::HashMap;
use std::path::PathBuf;

/// 第一期内存物化的行数上限：超出时明确报错（不静默截断），
/// 提示等待第三期磁盘执行路径。
pub(crate) const MAX_TABLE_ROWS: usize = 1_000_000;
/// 预览运行每个输入节点读取的数据行数（设计文档第 7 节，全局默认 1000）。
pub(crate) const PREVIEW_ROWS: usize = 1000;
/// 结果区锚点样例最多展示的行数。
pub(crate) const ANCHOR_SAMPLE_ROWS: usize = 200;

pub(crate) fn structural(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message, false, None)
}

pub(crate) fn config_error(node_kind: &str, node_name: &str, detail: String) -> AppError {
    structural(
        "DATAFLOW_CONFIG_INVALID",
        format!("节点「{node_name}」（{node_kind}）配置无效：{detail}"),
    )
}

/// 节点执行中间与输出使用的一张完整表（列名、列类型、行值）。
#[derive(Debug, Clone)]
pub(crate) struct Table {
    pub columns: Vec<String>,
    pub types: Vec<ColType>,
    pub rows: Vec<Vec<Value>>,
}

impl Table {
    pub(crate) fn row_count(&self) -> usize {
        self.rows.len()
    }

    pub(crate) fn column_index(&self) -> HashMap<String, usize> {
        self.columns
            .iter()
            .enumerate()
            .map(|(index, name)| (name.clone(), index))
            .collect()
    }

    pub(crate) fn check_budget(&self) -> Result<(), AppError> {
        if self.rows.len() > MAX_TABLE_ROWS {
            return Err(structural(
                "DATAFLOW_ROW_LIMIT",
                format!(
                    "数据行数（{}）超出第一期内网上限（{MAX_TABLE_ROWS} 行）。\
                     第一期在内存中完整处理数据，不会静默截断；请缩小数据范围，\
                     或等待第三期磁盘执行路径。",
                    self.rows.len()
                ),
            ));
        }
        Ok(())
    }
}

/// 输出节点写出的一个文件（进入响应的 outputs 数组）。
#[derive(Debug, Clone)]
pub(crate) struct WrittenFile {
    pub path: PathBuf,
    pub sheet: String,
    pub rows: usize,
}

/// 单个节点的一次执行结果。
pub(crate) struct NodeOutcome {
    /// 输出锚点（key：输入/整理节点为 "output"，筛选为 "T"/"F"，
    /// 输出节点为 "sheet:名" / "file:名"）。
    pub anchors: Vec<(String, Table)>,
    pub messages: Vec<String>,
    pub stats: Vec<String>,
    pub written: Vec<WrittenFile>,
    /// 节点角标显示的行数。
    pub rows: usize,
    /// 是否存在实质性警告（跳过行、精度保底转文本等）。预览提示之类的
    /// 说明性 messages 不算警告，节点状态保持“成功”。
    pub has_warnings: bool,
}

impl NodeOutcome {
    pub(crate) fn with_anchor(key: &str, table: Table) -> Self {
        let rows = table.row_count();
        Self {
            anchors: vec![(key.to_owned(), table)],
            messages: Vec::new(),
            stats: Vec::new(),
            written: Vec::new(),
            rows,
            has_warnings: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RunMode {
    Preview,
    Full,
}

impl RunMode {
    pub(crate) fn key(self) -> &'static str {
        match self {
            RunMode::Preview => "preview",
            RunMode::Full => "full",
        }
    }
}

/// 一次运行的共享上下文。
pub(crate) struct RunContext {
    pub mode: RunMode,
    /// 本次运行开始时确定的业务日期（TODAY() 取值，运行中不变）。
    pub today: NaiveDate,
    /// {参数id} 占位解析后的路径/文件名替换表。
    pub param_values: HashMap<String, String>,
    /// 预览行数上限（默认 PREVIEW_ROWS）。
    pub preview_rows: usize,
    /// lib.rs engine_call 注入的已授权路径；None＝未注入（单元测试直调），
    /// 不启用授权门。
    pub allowed_paths: Option<Vec<PathBuf>>,
}

impl RunContext {
    /// 替换字符串中的 {参数id} 占位符（缺省回落 params 默认值，已由引擎合并）。
    pub(crate) fn resolve_placeholders(&self, text: &str) -> String {
        let mut result = text.to_owned();
        for (id, value) in &self.param_values {
            result = result.replace(&format!("{{{id}}}"), value);
        }
        result
    }

    /// 路径授权门：与 lib.rs::path_is_permitted 同语义——选中目录授权后代，
    /// 选中文件仅授权该文件本身。未注入白名单（单元测试直调）时放行。
    pub(crate) fn ensure_permitted(&self, path: &std::path::Path) -> Result<(), AppError> {
        let Some(allowed) = self.allowed_paths.as_ref() else {
            return Ok(());
        };
        let requested = path
            .canonicalize()
            .unwrap_or_else(|_| path.to_path_buf());
        let permitted = allowed.iter().any(|base| {
            let normalized = base.canonicalize().unwrap_or_else(|_| base.clone());
            requested == normalized || (normalized.is_dir() && requested.starts_with(&normalized))
        });
        if permitted {
            Ok(())
        } else {
            Err(structural(
                "PATH_NOT_AUTHORIZED",
                format!(
                    "路径未授权：{}。请重新在工具中选择该文件或文件夹。",
                    path.display()
                ),
            ))
        }
    }
}

/// 单元格在响应样例里的 JSON 表示：十进制用字符串保留精确值。
pub(crate) fn sample_json(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(*flag),
        Value::Int(number) => serde_json::Value::Number((*number).into()),
        Value::Dec(number) => serde_json::Value::String(number.to_text()),
        Value::Text(text) => serde_json::Value::String(text.clone()),
        Value::Date(date) => serde_json::Value::String(date.format("%Y-%m-%d").to_string()),
    }
}
