//! 第二期输入节点：手工输入（manual_in）、数据库文件输入（db_in）、
//! Parquet 输入（parquet_in），以及数据库表清单 `db_tables`（供前端配置下拉）。
//!
//! - manual_in：小表随流程文件保存（config 即数据）；按 columns.type 转型，
//!   失败按 onRowError 行级处理；空/自动类型按输入节点同套规则识别，
//!   超 15 位整数保底文本；
//! - db_in：SQLite（rusqlite 只读打开）；INTEGER→整数、REAL→按最短十进制
//!   文本转定点十进制（浮点来源披露进 stats，不静默宣称为精确十进制）、
//!   TEXT→文本、BLOB→十六进制文本（安全无损，写入报告）；非 SQLite 文件头
//!   /加密/损坏分别给中文诊断；路径授权沿用 RunContext.ensure_permitted；
//! - parquet_in：polars 读取，类型映射进 value.rs 类型系统；浮点与日期时间
//!   的转换方式在 stats 披露；
//! - db_tables：文件头快速识别 + sqlite_master 列表（仅表名、按名排序、
//!   排除 sqlite_ 内部表）；路径授权由 lib.rs 接线 engine_call
//!   ("dataflow_db_tables") 时统一注入（本函数只做识别与列表）。

use super::{config_error, structural, NodeOutcome, RunContext, Table, MAX_TABLE_ROWS, PREVIEW_ROWS};
use crate::dataflow::model::{DbInConfig, ManualInConfig, ParquetInConfig, RowErrorPolicy};
use crate::dataflow::value::{
    self, ColType, Dec, Value, integer_digits_exceed_limit, looks_like_auto_decimal,
    looks_like_auto_integer, parse_date_auto, parse_date_explicit,
};
use crate::AppError;
use serde_json::Value as Json;
use polars::prelude::SerReader;
use std::io::Read;
use std::path::Path;

/// 手工小表内嵌行数上限（超限提示改用外部文件输入；容量上限待技术验证，
/// 先取保守值）。
const MANUAL_MAX_ROWS: usize = 10_000;

// ---------------------------------------------------------------------------
// 手工输入 manual_in
// ---------------------------------------------------------------------------

pub(crate) fn run_manual_in(
    node_name: &str,
    config: &Json,
    _context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: ManualInConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("手工输入", node_name, error.to_string()))?;
    if config.columns.is_empty() {
        return Err(config_error("手工输入", node_name, "至少定义 1 列（列名与类型）。".into()));
    }
    if config.rows.len() > MANUAL_MAX_ROWS {
        return Err(structural(
            "DATAFLOW_MANUAL_TABLE_LIMIT",
            format!(
                "节点「{node_name}」的手工小表（{} 行）超过内嵌上限 {MANUAL_MAX_ROWS} 行，\
                 请改用外部文件输入节点。",
                config.rows.len()
            ),
        ));
    }
    let mut columns: Vec<String> = Vec::new();
    for column in &config.columns {
        let name = column.name.trim().to_owned();
        if name.is_empty() {
            return Err(config_error("手工输入", node_name, "列名不能为空。".into()));
        }
        if columns.contains(&name) {
            return Err(config_error(
                "手工输入",
                node_name,
                format!("列名“{name}”重复。"),
            ));
        }
        columns.push(name);
    }

    // 列类型：显式优先；空/auto 按全量样例自动识别（超 15 位整数保底文本）。
    let policy = RowErrorPolicy::parse(config.on_row_error.as_deref());
    let mut types: Vec<ColType> = Vec::with_capacity(columns.len());
    let mut type_notes: Vec<String> = Vec::new();
    for (index, column) in config.columns.iter().enumerate() {
        let declared = column.kind.trim().to_ascii_lowercase();
        let kind = if declared.is_empty() || declared == "auto" {
            let samples: Vec<String> = config
                .rows
                .iter()
                .filter_map(|row| cell_text(row.get(index)))
                .filter(|text| !text.trim().is_empty())
                .collect();
            let kind = infer_manual_type(&samples, index);
            if kind == ColType::Text {
                let long = samples.iter().any(|text| integer_digits_exceed_limit(text));
                if long {
                    type_notes.push(format!(
                        "列“{}”：含超过 15 位的整数，已按文本读入",
                        columns[index]
                    ));
                }
            }
            kind
        } else {
            ColType::parse(&declared).ok_or_else(|| {
                config_error(
                    "手工输入",
                    node_name,
                    format!(
                        "列“{}”的类型“{}”无法识别（可选 text / int / decimal / date / bool / auto）。",
                        columns[index], column.kind
                    ),
                )
            })?
        };
        types.push(kind);
    }

    // 逐行转型；行级错误按 onRowError 停止（默认）或跳过并记录。
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(config.rows.len());
    let mut skipped = 0usize;
    let mut messages = Vec::new();
    let mut short_rows = 0usize;
    for (ordinal, raw_row) in config.rows.iter().enumerate() {
        if raw_row.len() < columns.len() {
            short_rows += 1;
        }
        let mut converted: Vec<Value> = Vec::with_capacity(columns.len());
        let mut failure: Option<String> = None;
        for index in 0..columns.len() {
            let cell = raw_row.get(index);
            let value = match cell {
                None | Some(Json::Null) => Value::Null,
                Some(raw) => match convert_manual_cell(raw, types[index]) {
                    Ok(value) => value,
                    Err(reason) => {
                        failure = Some(format!(
                            "第 {} 行字段“{}”的值“{}”{reason}",
                            ordinal + 1,
                            columns[index],
                            cell_text(cell).unwrap_or_default()
                        ));
                        break;
                    }
                },
            };
            converted.push(value);
        }
        match failure {
            Some(detail) => match policy {
                RowErrorPolicy::Stop => {
                    return Err(structural(
                        "DATAFLOW_ROW_ERROR",
                        format!(
                            "节点「{node_name}」{detail}。已按“停止”策略中止；\
                             可在节点配置中改为“跳过并记录”。"
                        ),
                    ));
                }
                RowErrorPolicy::Skip => {
                    skipped += 1;
                    if messages.len() < 10 {
                        messages.push(format!("跳过{detail}"));
                    }
                }
            },
            None => rows.push(converted),
        }
    }

    let mut stats = vec![
        format!("手工小表：{} 行 × {} 列（内容随流程文件保存与分享）", rows.len(), columns.len()),
        format!(
            "列类型：{}",
            columns
                .iter()
                .zip(types.iter())
                .map(|(name, kind)| format!("{name}：{}", kind.display()))
                .collect::<Vec<_>>()
                .join("，")
        ),
    ];
    stats.extend(type_notes);
    if short_rows > 0 {
        stats.push(format!("有 {short_rows} 行单元格数少于列数，缺失单元格按空值读取"));
    }
    if skipped > 0 {
        stats.push(format!("跳过行数：{skipped}"));
    }
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    outcome.messages = messages;
    outcome.has_warnings = skipped > 0;
    Ok(outcome)
}

/// 手工输入的自动类型识别（同输入节点第 9 节规则；样例为全量值）。
fn infer_manual_type(samples: &[String], _index: usize) -> ColType {
    if samples.is_empty() {
        return ColType::Text;
    }
    if samples.iter().all(|text| parse_date_auto(text).is_some()) {
        return ColType::Date;
    }
    if samples.iter().any(|text| integer_digits_exceed_limit(text)) {
        return ColType::Text;
    }
    if samples.iter().all(|text| looks_like_auto_integer(text)) {
        return ColType::Integer;
    }
    if samples.iter().all(|text| looks_like_auto_decimal(text)) {
        return ColType::Decimal;
    }
    ColType::Text
}

fn cell_text(cell: Option<&Json>) -> Option<String> {
    match cell? {
        Json::String(text) => Some(text.clone()),
        Json::Number(number) => Some(number.to_string()),
        Json::Bool(flag) => Some(flag.to_string()),
        Json::Null => None,
        other => Some(other.to_string()),
    }
}

fn convert_manual_cell(raw: &Json, kind: ColType) -> Result<Value, String> {
    if matches!(raw, Json::Null) {
        return Ok(Value::Null);
    }
    match kind {
        ColType::Text => Ok(Value::Text(cell_text(Some(raw)).unwrap_or_default())),
        ColType::Integer => {
            let text = cell_text(Some(raw)).unwrap_or_default();
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            value::parse_integer_strict(&text).map(Value::Int)
        }
        ColType::Decimal => {
            let text = cell_text(Some(raw)).unwrap_or_default();
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            Dec::parse(&text).map(Value::Dec)
        }
        ColType::Date => {
            let text = cell_text(Some(raw)).unwrap_or_default();
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            parse_date_explicit(&text)
                .map(Value::Date)
                .ok_or_else(|| format!("无法识别为日期（“{text}”）"))
        }
        ColType::Bool => {
            let text = cell_text(Some(raw)).unwrap_or_default();
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            value::parse_bool_strict(&text)
                .map(Value::Bool)
                .ok_or_else(|| format!("无法识别为布尔值（“{text}”）"))
        }
    }
}

// ---------------------------------------------------------------------------
// SQLite 识别与表清单
// ---------------------------------------------------------------------------

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// SQLite 文件头快速识别：合法 / 加密 / 损坏 / 非 SQLite 四种中文诊断。
enum HeaderVerdict {
    Sqlite,
    TooSmall,
    EncryptedOrUnknown,
    Corrupted,
}

fn inspect_header(path: &Path) -> HeaderVerdict {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return HeaderVerdict::TooSmall,
    };
    let mut header = [0u8; 100];
    let mut read = 0usize;
    loop {
        match file.read(&mut header[read..]) {
            Ok(0) => break,
            Ok(count) => {
                read += count;
                if read == header.len() {
                    break;
                }
            }
            Err(_) => return HeaderVerdict::TooSmall,
        }
    }
    if read == 0 {
        // 空文件在 SQLite 语义里是合法的空库（打开后无表）。
        return HeaderVerdict::Sqlite;
    }
    if read < 16 || &header[..16] != SQLITE_MAGIC {
        // 明文 SQLite 第 16 字节起是页大小（512..65536 的 2 的幂或 1）、
        // 第 18/19 字节是读写版本号（1 或 2）。加密库此处为随机字节。
        if read >= 20 {
            let page_size = u16::from_be_bytes([header[16], header[17]]);
            let page_size_ok = page_size == 1 || (page_size.is_power_of_two() && (512..=32768).contains(&page_size));
            let version_ok = (1..=2).contains(&header[18]) && (1..=2).contains(&header[19]);
            if page_size_ok && version_ok {
                return HeaderVerdict::Corrupted;
            }
        }
        return HeaderVerdict::EncryptedOrUnknown;
    }
    if read < 100 {
        return HeaderVerdict::Corrupted;
    }
    HeaderVerdict::Sqlite
}

/// 只读打开 SQLite；非 SQLite / 加密 / 损坏给中文诊断。`context` 用于错误文案。
fn open_sqlite(path: &Path, context: &str) -> Result<rusqlite::Connection, AppError> {
    if !path.is_file() {
        return Err(structural(
            "DATAFLOW_PATH_NOT_FOUND",
            format!("{context}的文件不存在：{}", path.display()),
        ));
    }
    match inspect_header(path) {
        HeaderVerdict::Sqlite => {}
        HeaderVerdict::TooSmall => {
            return Err(structural(
                "DATAFLOW_DB_NOT_SQLITE",
                format!(
                    "{context}的文件不是 SQLite 数据库（文件过小或为空内容）：{}。",
                    path.display()
                ),
            ));
        }
        HeaderVerdict::EncryptedOrUnknown => {
            return Err(structural(
                "DATAFLOW_DB_ENCRYPTED_OR_UNKNOWN",
                format!(
                    "{context}的文件头不是 SQLite 格式且头部结构随机——文件可能已加密\
                     （如 SQLCipher）或为其他数据库格式，请提供未加密的 SQLite 文件：{}。",
                    path.display()
                ),
            ));
        }
        HeaderVerdict::Corrupted => {
            return Err(structural(
                "DATAFLOW_DB_CORRUPTED",
                format!(
                    "{context}的文件疑似已损坏（头部结构不完整或页参数异常）：{}。",
                    path.display()
                ),
            ));
        }
    }
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| {
        structural(
            "DATAFLOW_DB_CORRUPTED",
            format!(
                "{context}的文件头是 SQLite 但无法打开，文件可能已损坏（{error}）：{}。",
                path.display()
            ),
        )
    })
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 列出数据表（仅普通表，排除 sqlite_ 内部表；按名排序）。
fn list_tables(connection: &rusqlite::Connection) -> Result<Vec<String>, AppError> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .map_err(|error| {
            structural(
                "DATAFLOW_DB_CORRUPTED",
                format!("读取数据库表清单失败（{error}），文件可能已损坏。"),
            )
        })?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_query_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_query_error)?;
    Ok(names)
}

fn db_query_error(error: rusqlite::Error) -> AppError {
    structural(
        "DATAFLOW_DB_READ_FAILED",
        format!("数据库读取失败：{error}。"),
    )
}

/// engine_call("dataflow_db_tables")：返回 [{"name":"表名"}]（按名排序）。
/// 路径授权由 lib.rs 接线时统一注入校验（与 pick_path 相同语义），
/// 本函数只做文件头识别与表清单。
pub(crate) fn db_tables(path: &str) -> Result<Json, AppError> {
    if path.trim().is_empty() {
        return Err(config_error("数据库表清单", "配置", "未选择数据库文件。".into()));
    }
    let path = Path::new(path.trim());
    let connection = open_sqlite(path, "数据库表清单")?;
    let names = list_tables(&connection)?;
    Ok(Json::Array(
        names
            .into_iter()
            .map(|name| serde_json::json!({ "name": name }))
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// 数据库文件输入 db_in
// ---------------------------------------------------------------------------

struct DbColumnInfo {
    name: String,
    declared: String,
}

pub(crate) fn run_db_in(
    node_name: &str,
    config: &Json,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: DbInConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("数据库文件输入", node_name, error.to_string()))?;
    if config.table.trim().is_empty() {
        return Err(config_error("数据库文件输入", node_name, "必须选择数据表。".into()));
    }
    let path_text = context.resolve_placeholders(&config.path);
    if path_text.trim().is_empty() {
        return Err(config_error("数据库文件输入", node_name, "未选择数据库文件。".into()));
    }
    let path = std::path::PathBuf::from(path_text.trim());
    context.ensure_permitted(&path)?;
    let connection = open_sqlite(&path, "数据库文件输入")?;

    let tables = list_tables(&connection)?;
    let table = config.table.trim();
    if !tables.contains(&table.to_owned()) {
        return Err(structural(
            "DATAFLOW_DB_TABLE_MISSING",
            format!(
                "节点「{node_name}」选择的数据表“{table}”不存在。可用数据表：{}。",
                if tables.is_empty() { "（无）".to_owned() } else { tables.join("、") }
            ),
        ));
    }

    // 列清单：PRAGMA table_info；fields 空 = 全部列。
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", quote_ident(table)))
        .map_err(db_query_error)?;
    let columns: Vec<DbColumnInfo> = statement
        .query_map([], |row| {
            Ok(DbColumnInfo {
                name: row.get::<_, String>(1)?,
                declared: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })
        .map_err(db_query_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_query_error)?;
    if columns.is_empty() {
        return Err(structural(
            "DATAFLOW_DB_TABLE_MISSING",
            format!("节点「{node_name}」选择的数据表“{table}”没有可用字段。"),
        ));
    }
    let selected: Vec<&DbColumnInfo> = if config.fields.is_empty() {
        columns.iter().collect()
    } else {
        let mut picked = Vec::new();
        for field in &config.fields {
            let Some(column) = columns.iter().find(|column| &column.name == field) else {
                return Err(structural(
                    "DATAFLOW_FIELD_MISSING",
                    format!(
                        "节点「{node_name}」选择的字段“{field}”在表“{table}”中不存在。可用字段：{}。",
                        columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>().join("、")
                    ),
                ));
            };
            picked.push(column);
        }
        picked
    };

    // 读取行：优先按 rowid（可解释顺序）；无 rowid 表退回引擎返回顺序。
    let select_list = selected
        .iter()
        .map(|column| quote_ident(&column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let plain_sql = format!("SELECT {select_list} FROM {}", quote_ident(table));
    let ordered_sql = format!("{plain_sql} ORDER BY rowid");
    let ordered = connection.prepare(&ordered_sql).is_ok();
    let mut statement = if ordered {
        connection.prepare(&ordered_sql).map_err(db_query_error)?
    } else {
        connection.prepare(&plain_sql).map_err(db_query_error)?
    };
    let policy = RowErrorPolicy::parse(config.on_row_error.as_deref());
    let row_cap = if context.mode == super::RunMode::Preview {
        context.preview_rows
    } else {
        MAX_TABLE_ROWS + 1
    };
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut real_cells = 0usize;
    let mut blob_cells = 0usize;
    let mut skipped = 0usize;
    let mut messages = Vec::new();
    let mut iterator = statement.query([]).map_err(db_query_error)?;
    loop {
        match iterator.next() {
            Ok(Some(row)) => {
                if rows.len() >= row_cap {
                    if context.mode == super::RunMode::Preview {
                        break;
                    }
                    return Err(structural(
                        "DATAFLOW_ROW_LIMIT",
                        format!(
                            "节点「{node_name}」读取的行数超出内网上限（{MAX_TABLE_ROWS} 行）。"
                        ),
                    ));
                }
                let mut converted = Vec::with_capacity(selected.len());
                let mut failure: Option<String> = None;
                for index in 0..selected.len() {
                    let raw = row.get_ref(index).map_err(db_query_error)?;
                    match map_sqlite_value(raw, index, &selected, &mut real_cells, &mut blob_cells) {
                        Ok(value) => converted.push(value),
                        Err(reason) => {
                            failure = Some(reason);
                            break;
                        }
                    }
                }
                match failure {
                    Some(detail) => match policy {
                        RowErrorPolicy::Stop => {
                            return Err(structural(
                                "DATAFLOW_ROW_ERROR",
                                format!(
                                    "节点「{node_name}」读取表“{table}”第 {} 行时{detail}。\
                                     已按“停止”策略中止；可在节点配置中改为“跳过并记录”。",
                                    rows.len() + 1
                                ),
                            ));
                        }
                        RowErrorPolicy::Skip => {
                            skipped += 1;
                            if messages.len() < 10 {
                                messages.push(format!("跳过第 {} 行：{detail}", rows.len() + 1));
                            }
                        }
                    },
                    None => rows.push(converted),
                }
            }
            Ok(None) => break,
            Err(error) => return Err(db_query_error(error)),
        }
    }

    // 列类型：按实际取值推断（INTEGER→整数、含 REAL→十进制、其余文本），
    // 源浮点/BLOB 的转换方式在 stats 披露。
    let mut types = Vec::with_capacity(selected.len());
    for index in 0..selected.len() {
        let mut saw_integer = false;
        let mut saw_real = false;
        let mut saw_other = false;
        for row in &rows {
            match &row[index] {
                Value::Int(_) => saw_integer = true,
                Value::Dec(_) => saw_real = true,
                Value::Null => {}
                _ => saw_other = true,
            }
        }
        let kind = if saw_other || (!saw_integer && !saw_real) {
            ColType::Text
        } else if saw_real {
            ColType::Decimal
        } else {
            ColType::Integer
        };
        types.push(kind);
    }

    let mut stats = vec![
        format!("数据表 {table}：{} 行 × {} 列（SQLite，只读打开）", rows.len(), selected.len()),
        format!(
            "字段：{}",
            selected
                .iter()
                .map(|column| format!(
                    "{}（源声明：{}）",
                    column.name,
                    if column.declared.is_empty() { "（未声明）".to_owned() } else { column.declared.clone() }
                ))
                .collect::<Vec<_>>()
                .join("、")
        ),
    ];
    if real_cells > 0 {
        stats.push(format!(
            "浮点来源披露：{real_cells} 个 REAL 取值按二进制浮点存储，已按最短十进制文本\
             转为定点十进制；源精度损失不可恢复，不静默视作精确值"
        ));
    }
    if blob_cells > 0 {
        stats.push(format!(
            "BLOB 处理：{blob_cells} 个取值转为十六进制文本（无损，可对照原库核对）"
        ));
    }
    stats.push(
        "读取顺序：按 rowid（无 rowid 表按引擎返回顺序）——做首次/末次保留前建议先排序".to_owned(),
    );
    if skipped > 0 {
        stats.push(format!("跳过行数：{skipped}"));
    }
    if context.mode == super::RunMode::Preview {
        stats.push(format!(
            "预览模式：仅读取前 {} 行数据（全局默认 {PREVIEW_ROWS} 行）",
            context.preview_rows
        ));
    }
    let columns_out: Vec<String> = selected.iter().map(|column| column.name.clone()).collect();
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns: columns_out, types, rows });
    outcome.stats = stats;
    outcome.messages = messages;
    outcome.has_warnings = skipped > 0;
    Ok(outcome)
}

fn map_sqlite_value(
    raw: rusqlite::types::ValueRef<'_>,
    index: usize,
    selected: &[&DbColumnInfo],
    real_cells: &mut usize,
    blob_cells: &mut usize,
) -> Result<Value, String> {
    use rusqlite::types::ValueRef;
    let name = selected
        .get(index)
        .map(|column| column.name.as_str())
        .unwrap_or_default();
    match raw {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Integer(number) => Ok(Value::Int(number)),
        ValueRef::Real(number) => {
            *real_cells += 1;
            let text = format!("{number}");
            Dec::parse(&text)
                .map(Value::Dec)
                .map_err(|_| format!("“{name}”的浮点值“{text}”无法转为十进制（非有限数值）"))
        }
        ValueRef::Text(bytes) => Ok(Value::Text(String::from_utf8_lossy(bytes).into_owned())),
        ValueRef::Blob(bytes) => {
            *blob_cells += 1;
            Ok(Value::Text(bytes.iter().map(|byte| format!("{byte:02x}")).collect()))
        }
    }
}

// ---------------------------------------------------------------------------
// Parquet 输入 parquet_in
// ---------------------------------------------------------------------------

pub(crate) fn run_parquet_in(
    node_name: &str,
    config: &Json,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: ParquetInConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("Parquet 输入", node_name, error.to_string()))?;
    let path_text = context.resolve_placeholders(&config.path);
    if path_text.trim().is_empty() {
        return Err(config_error("Parquet 输入", node_name, "未选择 Parquet 文件。".into()));
    }
    let path = std::path::PathBuf::from(path_text.trim());
    context.ensure_permitted(&path)?;
    if !path.is_file() {
        return Err(structural(
            "DATAFLOW_PATH_NOT_FOUND",
            format!("节点「{node_name}」的文件不存在：{}", path.display()),
        ));
    }
    let file = std::fs::File::open(&path).map_err(|error| {
        structural(
            "DATAFLOW_PARQUET_READ_FAILED",
            format!("节点「{node_name}」打开 Parquet 文件失败：{error}。"),
        )
    })?;
    let frame = polars::prelude::ParquetReader::new(file)
        .finish()
        .map_err(|error| {
            structural(
                "DATAFLOW_PARQUET_READ_FAILED",
                format!(
                    "节点「{node_name}」读取 Parquet 文件失败（文件可能已损坏或非 Parquet 格式）：{error}。"
                ),
            )
        })?;

    let all_names: Vec<String> = frame
        .get_column_names()
        .iter()
        .map(|name| name.as_str().to_owned())
        .collect();
    let selected: Vec<String> = if config.fields.is_empty() {
        all_names.clone()
    } else {
        for field in &config.fields {
            if !all_names.contains(field) {
                return Err(structural(
                    "DATAFLOW_FIELD_MISSING",
                    format!(
                        "节点「{node_name}」选择的字段“{field}”不存在。可用字段：{}。",
                        all_names.join("、")
                    ),
                ));
            }
        }
        config.fields.clone()
    };

    let row_cap = if context.mode == super::RunMode::Preview {
        context.preview_rows
    } else {
        MAX_TABLE_ROWS + 1
    };
    let height = frame.height();
    let take = height.min(row_cap);
    if height > MAX_TABLE_ROWS && context.mode != super::RunMode::Preview {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」读取的行数（{height}）超出内网上限（{MAX_TABLE_ROWS} 行）。"
            ),
        ));
    }

    // 选列索引 + 列类型（按 dtype 映射进 value.rs 类型系统）。
    use polars::prelude::DataType;
    let mut columns: Vec<String> = Vec::with_capacity(selected.len());
    let mut types: Vec<ColType> = Vec::with_capacity(selected.len());
    for name in &selected {
        let series = frame.column(name).map_err(polars_error)?;
        let kind = match series.dtype() {
            DataType::Boolean => ColType::Bool,
            DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => ColType::Integer,
            DataType::UInt8 | DataType::UInt16 | DataType::UInt32 => ColType::Integer,
            DataType::UInt64 => ColType::Integer,
            DataType::Float32 | DataType::Float64 => ColType::Decimal,
            DataType::Date => ColType::Date,
            _ => ColType::Text,
        };
        types.push(kind);
        columns.push(name.clone());
    }
    let positions: Vec<usize> = selected
        .iter()
        .map(|name| all_names.iter().position(|candidate| candidate == name).expect("已校验存在"))
        .collect();

    let mut float_cells = 0usize;
    let mut datetime_cells = 0usize;
    let mut fallback_cells = 0usize;
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(take);
    for ordinal in 0..take {
        let row = frame.get_row(ordinal).map_err(polars_error)?.0;
        let mut line: Vec<Value> = Vec::with_capacity(selected.len());
        for &position in &positions {
            let any = row.get(position).cloned().unwrap_or(polars::prelude::AnyValue::Null);
            line.push(map_parquet_value(any, &mut float_cells, &mut datetime_cells, &mut fallback_cells));
        }
        rows.push(line);
    }

    let mut stats = vec![
        format!(
            "Parquet 文件：{} 行 × {} 列（读取 {} 行）",
            height,
            all_names.len(),
            rows.len()
        ),
        format!(
            "字段：{}",
            selected
                .iter()
                .zip(types.iter())
                .map(|(name, kind)| format!("{name}：{}", kind.display()))
                .collect::<Vec<_>>()
                .join("，")
        ),
    ];
    if float_cells > 0 {
        stats.push(format!(
            "浮点来源披露：{float_cells} 个浮点取值按二进制浮点存储，已按最短十进制文本\
             转为定点十进制；源精度损失不可恢复"
        ));
    }
    if datetime_cells > 0 {
        stats.push(format!(
            "日期时间披露：{datetime_cells} 个日期时间取值按文本读取（保留时分秒，\
             不无提示丢弃时间部分）"
        ));
    }
    if fallback_cells > 0 {
        stats.push(format!(
            "类型映射披露：{fallback_cells} 个取值属于未专门映射的类型，按文本读取"
        ));
    }
    if context.mode == super::RunMode::Preview && height > take {
        stats.push(format!(
            "预览模式：仅读取前 {} 行数据（文件共 {height} 行）",
            rows.len()
        ));
    }
    let mut outcome = NodeOutcome::with_anchor("output", Table { columns, types, rows });
    outcome.stats = stats;
    Ok(outcome)
}

fn polars_error(error: polars::prelude::PolarsError) -> AppError {
    structural(
        "DATAFLOW_PARQUET_READ_FAILED",
        format!("Parquet 读取失败：{error}。"),
    )
}

fn map_parquet_value(
    any: polars::prelude::AnyValue<'_>,
    float_cells: &mut usize,
    datetime_cells: &mut usize,
    fallback_cells: &mut usize,
) -> Value {
    use polars::prelude::AnyValue;
    match any {
        AnyValue::Null => Value::Null,
        AnyValue::Boolean(flag) => Value::Bool(flag),
        AnyValue::Int8(number) => Value::Int(number as i64),
        AnyValue::Int16(number) => Value::Int(number as i64),
        AnyValue::Int32(number) => Value::Int(number as i64),
        AnyValue::Int64(number) => Value::Int(number),
        AnyValue::UInt8(number) => Value::Int(number as i64),
        AnyValue::UInt16(number) => Value::Int(number as i64),
        AnyValue::UInt32(number) => Value::Int(number as i64),
        AnyValue::UInt64(number) => {
            if number <= i64::MAX as u64 {
                Value::Int(number as i64)
            } else {
                Value::Dec(Dec::parse(&number.to_string()).unwrap_or(Dec::from_i64(0)))
            }
        }
        AnyValue::Float32(number) => {
            *float_cells += 1;
            Value::Dec(Dec::parse(&format!("{number}")).unwrap_or(Dec::from_i64(0)))
        }
        AnyValue::Float64(number) => {
            *float_cells += 1;
            Value::Dec(Dec::parse(&format!("{number}")).unwrap_or(Dec::from_i64(0)))
        }
        AnyValue::String(text) => Value::Text(text.to_owned()),
        AnyValue::Date(days) => Value::Date(
            chrono::NaiveDate::from_num_days_from_ce(days + 719_163),
        ),
        AnyValue::Datetime(stamp, unit, _) => {
            *datetime_cells += 1;
            Value::Text(format_datetime(stamp, unit))
        }
        AnyValue::Duration(stamp, unit) => {
            *fallback_cells += 1;
            Value::Text(format!("{any}"))
        }
        AnyValue::Time(_) | AnyValue::List(_) => {
            *fallback_cells += 1;
            Value::Text(format!("{any}"))
        }
        AnyValue::Categorical(_, _) | AnyValue::Enum(_, _) => {
            Value::Text(format!("{any}"))
        }
        AnyValue::Binary(bytes) => {
            *fallback_cells += 1;
            Value::Text(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
        }
        other => {
            *fallback_cells += 1;
            Value::Text(format!("{other}"))
        }
    }
}

fn format_datetime(stamp: i64, unit: polars::prelude::TimeUnit) -> String {
    use polars::prelude::TimeUnit;
    let (seconds, nanos) = match unit {
        TimeUnit::Milliseconds => (stamp.div_euclid(1000), stamp.rem_euclid(1000) as u32 * 1_000_000),
        TimeUnit::Microseconds => (stamp.div_euclid(1_000_000), stamp.rem_euclid(1_000_000) as u32 * 1_000),
        TimeUnit::Nanoseconds => (stamp.div_euclid(1_000_000_000), stamp.rem_euclid(1_000_000_000) as u32),
    };
    match chrono::DateTime::from_timestamp(seconds, nanos) {
        Some(datetime) => datetime.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => stamp.to_string(),
    }
}
