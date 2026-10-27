//! 输入节点：Excel 输入（excel_in）与 CSV/文本输入（csv_in）。
//!
//! 读取复用统一读取层，不重造识别与解码：
//! - Excel 全家（xlsx/xlsm/xls/xlsb/ods、伪 xls 分隔文本、SpreadsheetML）
//!   走 `disk_table::for_each_source_row` / `workbook_sheets`；
//! - CSV 自动编码/自动分隔符走同一层（`spreadsheet_input` 的识别与严格解码）；
//!   仅在用户手动指定编码或分隔符时用本模块的定向读取器（encoding_rs 严格解码）。
//!
//! 类型规则（设计文档第 9 节）：按前 1000 条非空样例建议类型，全量逐行校验，
//! 失败按 onRowError 停止（默认）或跳过；整数超 15 位保底按文本；前导零编号
//! 保持文本；空单元格读为空值（Null），空格文本保持文本。

use super::{config_error, NodeOutcome, RunContext, Table, MAX_TABLE_ROWS, PREVIEW_ROWS, structural};
use crate::AppError;
use encoding_rs::{Encoding, GBK, UTF_16BE, UTF_16LE, UTF_8};
use serde_json::Value as Json;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use walkdir::WalkDir;

use crate::dataflow::model::{CsvInConfig, ExcelInConfig, RowErrorPolicy};
use crate::dataflow::value::{
    self, ColType, Dec, Value, looks_like_auto_decimal, looks_like_auto_integer, parse_bool_strict,
    parse_date_auto, parse_date_explicit, parse_integer_strict,
};

const EARLY_STOP: &str = "DATAFLOW_EARLY_STOP";
const NO_CANCEL: AtomicBool = AtomicBool::new(false);

fn early_stop() -> AppError {
    AppError::new(EARLY_STOP, "读取截样完成。", false, None)
}

fn is_early_stop(error: &AppError) -> bool {
    error.code == EARLY_STOP
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 简单通配符匹配（* 任意、? 单字符，Windows 下不区分大小写）。
fn pattern_matches(pattern: &[u8], name: &[u8]) -> bool {
    match (pattern.first(), name.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            pattern_matches(&pattern[1..], name)
                || name
                    .first()
                    .is_some_and(|_| pattern_matches(pattern, &name[1..]))
        }
        (Some(b'?'), Some(_)) => pattern_matches(&pattern[1..], &name[1..]),
        (Some(want), Some(have)) if want == have => pattern_matches(&pattern[1..], &name[1..]),
        _ => false,
    }
}

fn excel_extensions() -> [&'static str; 6] {
    ["xlsx", "xlsm", "xls", "xlsb", "ods", "csv"]
}

fn text_extensions() -> [&'static str; 3] {
    ["csv", "txt", "tsv"]
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 列出文件夹内匹配的文件（单层、按文件名稳定排序）。
fn list_folder_files(
    folder: &Path,
    pattern: Option<&str>,
    extensions: &[&str],
    node_name: &str,
) -> Result<Vec<PathBuf>, AppError> {
    if !folder.is_dir() {
        return Err(structural(
            "DATAFLOW_PATH_NOT_FOUND",
            format!("节点「{node_name}」的文件夹不存在：{}", folder.display()),
        ));
    }
    let pattern = pattern.unwrap_or("*");
    let mut files: Vec<PathBuf> = WalkDir::new(folder)
        .max_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            let name = file_label(path);
            let lower = name.to_lowercase();
            (pattern.is_empty() || pattern_matches(pattern.as_bytes(), lower.as_bytes()))
                && extensions.contains(&extension_of(path).as_str())
        })
        .collect();
    files.sort_by(|a, b| file_label(a).cmp(&file_label(b)));
    if files.is_empty() {
        return Err(structural(
            "DATAFLOW_NO_INPUT_FILES",
            format!(
                "节点「{node_name}」的文件夹中没有可读取的文件：{}",
                folder.display()
            ),
        ));
    }
    Ok(files)
}

/// 一个文件读出的原始行（物理行号 + 单元格原样）。
struct RawSheet {
    header: Vec<String>,
    rows: Vec<(usize, Vec<String>)>,
}

/// 从统一读取层读取一个文件的一个 Sheet。
/// `row_cap` 为数据行上限（预览截样或行数预算），到达后立即早停。
fn read_sheet_rows(
    path: &Path,
    sheet: Option<&str>,
    header_row: usize,
    data_start: usize,
    row_cap: usize,
    node_name: &str,
) -> Result<RawSheet, AppError> {
    if !path.is_file() {
        return Err(structural(
            "DATAFLOW_PATH_NOT_FOUND",
            format!("节点「{node_name}」的文件不存在：{}", path.display()),
        ));
    }
    let mut header: Option<Vec<String>> = None;
    let mut rows: Vec<(usize, Vec<String>)> = Vec::new();
    let result = crate::disk_table::for_each_source_row(path, sheet, &NO_CANCEL, |cells, physical| {
        if physical == header_row && header.is_none() {
            header = Some(cells);
        } else if physical >= data_start {
            if rows.len() >= row_cap {
                return Err(early_stop());
            }
            rows.push((physical, cells));
        }
        Ok(())
    });
    if let Err(error) = result {
        if !is_early_stop(&error) {
            return Err(error);
        }
    }
    let header = header.ok_or_else(|| {
        structural(
            "DATAFLOW_HEADER_MISSING",
            format!(
                "节点「{node_name}」读取 {} 时：文件行数少于表头行 {header_row}。",
                file_label(path)
            ),
        )
    })?;
    Ok(RawSheet { header, rows })
}

/// firstData：选每个文件第一个有数据的 Sheet（默认裁定第 2 条）。
fn pick_sheet(
    path: &Path,
    sheet_mode: &str,
    sheet_name: Option<&str>,
    data_start: usize,
) -> Result<String, AppError> {
    if crate::spreadsheet_input::is_text(path) {
        return Ok("CSV".to_owned());
    }
    if sheet_mode == "byName" {
        let name = sheet_name.unwrap_or("").trim();
        if name.is_empty() {
            return Err(structural(
                "DATAFLOW_CONFIG_INVALID",
                "Sheet 选择方式为“按名称”时必须填写 Sheet 名称。",
            ));
        }
        let (selected, _all) = crate::disk_table::workbook_sheets(path, Some(name))?;
        return Ok(selected);
    }
    let (selected, all) = crate::disk_table::workbook_sheets(path, None)?;
    if all.len() <= 1 {
        return Ok(selected);
    }
    for candidate in &all {
        let mut saw_data = false;
        let result = crate::disk_table::for_each_source_row(
            path,
            Some(candidate),
            &NO_CANCEL,
            |cells, physical| {
                if physical >= data_start {
                    if cells.iter().any(|cell| !cell.trim().is_empty()) {
                        saw_data = true;
                        return Err(early_stop());
                    }
                    if physical >= data_start + 3 {
                        return Err(early_stop());
                    }
                }
                Ok(())
            },
        );
        if let Err(error) = result {
            if !is_early_stop(&error) {
                return Err(error);
            }
        }
        if saw_data {
            return Ok(candidate.clone());
        }
    }
    Ok(selected)
}

/// 表头规范化：去尾部空列名；空列名补「列N」；重名加后缀并返回改名说明。
fn normalize_header(raw: &[String]) -> (Vec<String>, Vec<String>) {
    let mut names: Vec<String> = raw.iter().map(|name| name.trim().to_owned()).collect();
    while names.last().is_some_and(|name| name.is_empty()) {
        names.pop();
    }
    if names.is_empty() {
        return (names, Vec::new());
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut renames = Vec::new();
    let mut result = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let mut final_name = if name.is_empty() {
            format!("列{}", index + 1)
        } else {
            name.clone()
        };
        let count = seen.entry(final_name.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            let renamed = format!("{final_name}_{}", *count);
            renames.push(format!("“{final_name}”重命名为“{renamed}”"));
            final_name = renamed;
        }
        result.push(final_name);
    }
    (result, renames)
}

/// 依样例给出列类型建议（第 9 节：日期优先、其次整数、十进制，超 15 位
/// 整数保底文本并提示；全空或证据不足列保守建议文本）。
fn infer_column_type(samples: &[String]) -> (ColType, Option<String>) {
    let non_empty: Vec<&String> = samples
        .iter()
        .take(1000)
        .filter(|text| !text.trim().is_empty())
        .collect();
    if non_empty.is_empty() {
        return (ColType::Text, None);
    }
    if non_empty.iter().all(|text| parse_date_auto(text).is_some()) {
        return (ColType::Date, None);
    }
    if non_empty
        .iter()
        .any(|text| value::integer_digits_exceed_limit(text))
    {
        return (
            ColType::Text,
            Some("含超过 15 位的整数，已按文本读入（可在“列类型”中锁定覆盖）".to_owned()),
        );
    }
    if non_empty.iter().all(|text| looks_like_auto_integer(text)) {
        return (ColType::Integer, None);
    }
    if non_empty.iter().all(|text| looks_like_auto_decimal(text)) {
        return (ColType::Decimal, None);
    }
    (ColType::Text, None)
}

/// 单元格转换：空串→空值；空格文本在非文本列按空值处理、文本列原样保留。
fn convert_cell(raw: &str, kind: ColType) -> Result<Value, String> {
    if raw.is_empty() {
        return Ok(Value::Null);
    }
    match kind {
        ColType::Text => Ok(Value::Text(raw.to_owned())),
        ColType::Integer => {
            if raw.trim().is_empty() {
                return Ok(Value::Null);
            }
            parse_integer_strict(raw).map(Value::Int)
        }
        ColType::Decimal => {
            if raw.trim().is_empty() {
                return Ok(Value::Null);
            }
            Dec::parse(raw).map(Value::Dec)
        }
        ColType::Date => {
            if raw.trim().is_empty() {
                return Ok(Value::Null);
            }
            parse_date_explicit(raw)
                .map(Value::Date)
                .ok_or_else(|| format!("无法识别为日期（“{raw}”）"))
        }
        ColType::Bool => {
            if raw.trim().is_empty() {
                return Ok(Value::Null);
            }
            parse_bool_strict(raw)
                .map(Value::Bool)
                .ok_or_else(|| format!("无法识别为布尔值（“{raw}”）"))
        }
    }
}

/// Excel 输入节点。
pub(crate) fn run_excel_in(
    node_name: &str,
    config: &Json,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: ExcelInConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("Excel 输入", node_name, error.to_string()))?;
    if config.header_row == 0 {
        return Err(config_error("Excel 输入", node_name, "表头行必须为正整数。".into()));
    }
    let data_start = config
        .data_start_row
        .unwrap_or(config.header_row + 1)
        .max(config.header_row + 1);
    let path_text = context.resolve_placeholders(&config.path);
    if path_text.trim().is_empty() {
        return Err(config_error("Excel 输入", node_name, "未选择文件或文件夹。".into()));
    }
    let path = PathBuf::from(&path_text);
    context.ensure_permitted(&path)?;
    let files = if config.source_type.eq_ignore_ascii_case("folder") {
        list_folder_files(&path, config.file_pattern.as_deref(), &excel_extensions(), node_name)?
    } else {
        vec![path]
    };
    let sheet_mode = config.sheet_mode.clone().unwrap_or_else(|| "firstData".to_owned());
    let mut collected: Vec<(String, String, RawSheet)> = Vec::new();
    let mut stats: Vec<String> = Vec::new();
    for file in &files {
        let sheet = pick_sheet(file, &sheet_mode, config.sheet_name.as_deref(), data_start)?;
        let raw = read_sheet_rows(
            file,
            Some(&sheet),
            config.header_row,
            data_start,
            row_cap(context),
            node_name,
        )?;
        stats.push(format!(
            "{}（Sheet：{sheet}）：{} 行数据",
            file_label(file),
            raw.rows.len()
        ));
        collected.push((file_label(file), sheet, raw));
    }
    assemble_outcome(
        node_name,
        "Excel 输入",
        collected,
        &config.column_types,
        RowErrorPolicy::parse(config.on_row_error.as_deref()),
        config.attach_source_columns,
        context,
        stats,
    )
}

/// CSV/文本输入节点。
pub(crate) fn run_csv_in(
    node_name: &str,
    config: &Json,
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: CsvInConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("CSV 输入", node_name, error.to_string()))?;
    if config.header_row == 0 {
        return Err(config_error("CSV 输入", node_name, "表头行必须为正整数。".into()));
    }
    let data_start = config
        .data_start_row
        .unwrap_or(config.header_row + 1)
        .max(config.header_row + 1);
    let path_text = context.resolve_placeholders(&config.path);
    if path_text.trim().is_empty() {
        return Err(config_error("CSV 输入", node_name, "未选择文件或文件夹。".into()));
    }
    let path = PathBuf::from(&path_text);
    context.ensure_permitted(&path)?;
    let encoding_key = config
        .encoding
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_lowercase();
    let delimiter_key = config
        .delimiter
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_lowercase();
    let files = if config.source_type.eq_ignore_ascii_case("folder") {
        list_folder_files(&path, config.file_pattern.as_deref(), &text_extensions(), node_name)?
    } else {
        vec![path]
    };
    for file in &files {
        let extension = extension_of(file);
        let is_plain =
            text_extensions().contains(&extension.as_str()) || crate::spreadsheet_input::is_text(file);
        if !is_plain {
            return Err(structural(
                "DATAFLOW_NOT_TEXT_FILE",
                format!(
                    "节点「{node_name}」的 {} 不是文本分隔文件（CSV 输入支持 csv/txt/tsv 及文本型 xls）。",
                    file.display()
                ),
            ));
        }
    }

    let manual = (encoding_key != "auto") || (delimiter_key != "auto");
    let mut collected: Vec<(String, String, RawSheet)> = Vec::new();
    let mut stats: Vec<String> = Vec::new();
    for file in &files {
        if manual {
            let mut header: Option<Vec<String>> = None;
            let mut rows: Vec<(usize, Vec<String>)> = Vec::new();
            let result = manual_text_rows(
                file,
                &encoding_key,
                &delimiter_key,
                |cells, physical| {
                    if physical == config.header_row && header.is_none() {
                        header = Some(cells);
                    } else if physical >= data_start {
                        if rows.len() >= row_cap(context) {
                            return Err(early_stop());
                        }
                        rows.push((physical, cells));
                    }
                    Ok(())
                },
            );
            if let Err(error) = result {
                if !is_early_stop(&error) {
                    return Err(error);
                }
            }
            let header = header.ok_or_else(|| {
                structural(
                    "DATAFLOW_HEADER_MISSING",
                    format!(
                        "节点「{node_name}」读取 {} 时：文件行数少于表头行 {}。",
                        file_label(file),
                        config.header_row
                    ),
                )
            })?;
            stats.push(format!(
                "{}：编码 {encoding_key}、分隔符 {delimiter_key}（手动指定）：{} 行数据",
                file_label(file),
                rows.len()
            ));
            collected.push((file_label(file), "CSV".to_owned(), RawSheet { header, rows }));
        } else {
            let (encoding, delimiter) = crate::spreadsheet_input::text_metadata(file)?;
            let raw = read_sheet_rows(file, None, config.header_row, data_start, row_cap(context), node_name)?;
            stats.push(format!(
                "{}：编码 {encoding}、分隔符“{delimiter}”（自动识别）：{} 行数据",
                file_label(file),
                raw.rows.len()
            ));
            collected.push((file_label(file), "CSV".to_owned(), raw));
        }
    }
    assemble_outcome(
        node_name,
        "CSV 输入",
        collected,
        &config.column_types,
        RowErrorPolicy::parse(config.on_row_error.as_deref()),
        config.attach_source_columns,
        context,
        stats,
    )
}

fn row_cap(context: &RunContext) -> usize {
    if context.mode == super::RunMode::Preview {
        context.preview_rows
    } else {
        MAX_TABLE_ROWS + 1
    }
}

/// 多文件按字段名对齐（以第一个文件为基准，默认裁定第 1 条），
/// 随后统一做类型建议、逐行转换并附加来源列。
fn assemble_outcome(
    node_name: &str,
    node_kind: &str,
    collected: Vec<(String, String, RawSheet)>,
    column_types: &Option<HashMap<String, String>>,
    policy: RowErrorPolicy,
    attach: bool,
    context: &RunContext,
    mut stats: Vec<String>,
) -> Result<NodeOutcome, AppError> {
    if collected.is_empty() {
        return Err(config_error(node_kind, node_name, "没有可读取的文件。".into()));
    }
    let mut messages = Vec::new();
    let mut locked = HashMap::new();
    if let Some(map) = column_types {
        for (column, key) in map {
            let kind = ColType::parse(key).ok_or_else(|| {
                config_error(
                    node_kind,
                    node_name,
                    format!("列“{column}”的锁定类型“{key}”无法识别。"),
                )
            })?;
            locked.insert(column.clone(), kind);
        }
    }

    // 基准表头 = 第一个文件；其余文件按字段名投影对齐（缺失补空值）。
    let (base_header, base_renames) = normalize_header(&collected[0].2.header);
    if base_header.is_empty() {
        return Err(structural(
            "DATAFLOW_HEADER_EMPTY",
            format!("节点「{node_name}」读取 {} 时：表头行为空。", collected[0].0),
        ));
    }
    for rename in &base_renames {
        messages.push(format!("表头{}", rename));
    }
    let width = base_header.len();
    // aligned：(文件, Sheet, 物理行, 按基准表头投影后的单元格)。
    let mut aligned: Vec<(String, String, usize, Vec<String>)> = Vec::new();
    for (label, sheet, raw) in &collected {
        let (names, renames) = normalize_header(&raw.header);
        for rename in &renames {
            messages.push(format!("{label} 表头{rename}"));
        }
        let mapping: Vec<Option<usize>> = base_header
            .iter()
            .map(|base| names.iter().position(|name| name == base))
            .collect();
        let extra: Vec<&str> = names
            .iter()
            .filter(|name| !base_header.contains(name))
            .map(|name| name.as_str())
            .collect();
        let missing: Vec<&str> = base_header
            .iter()
            .filter(|base| !names.contains(base))
            .map(|name| name.as_str())
            .collect();
        if !extra.is_empty() || !missing.is_empty() {
            let mut parts = Vec::new();
            if !extra.is_empty() {
                parts.push(format!("多出字段：{}", extra.join("、")));
            }
            if !missing.is_empty() {
                parts.push(format!("缺失字段（按空值读取）：{}", missing.join("、")));
            }
            messages.push(format!("{label} 与第一个文件字段不一致：{}", parts.join("；")));
        }
        for (physical, cells) in &raw.rows {
            let projected: Vec<String> = (0..width)
                .map(|index| match mapping[index] {
                    Some(source) => cells.get(source).cloned().unwrap_or_default(),
                    None => String::new(),
                })
                .collect();
            aligned.push((label.clone(), sheet.clone(), *physical, projected));
        }
    }
    if aligned.len() > MAX_TABLE_ROWS {
        return Err(structural(
            "DATAFLOW_ROW_LIMIT",
            format!(
                "节点「{node_name}」读取的数据行数（{}）超出第一期内网上限（{MAX_TABLE_ROWS} 行）。\
                 第一期在内存中完整处理数据，不会静默截断；请缩小数据范围，或等待第三期磁盘执行路径。",
                aligned.len()
            ),
        ));
    }

    // 列类型：锁定优先，其余按样例建议；超 15 位整数列给出提示。
    let mut types = Vec::with_capacity(width);
    let mut type_notes = Vec::new();
    for (index, column) in base_header.iter().enumerate() {
        if let Some(kind) = locked.get(column) {
            types.push(*kind);
            continue;
        }
        let mut samples: Vec<String> = Vec::new();
        for (_, _, _, cells) in &aligned {
            if let Some(cell) = cells.get(index) {
                if !cell.trim().is_empty() {
                    samples.push(cell.clone());
                }
                if samples.len() >= 1000 {
                    break;
                }
            }
        }
        let (kind, note) = infer_column_type(&samples);
        if let Some(note) = note {
            type_notes.push(format!("列“{column}”：{note}"));
        }
        types.push(kind);
    }

    // 全量逐行转换；行级错误按 onRowError 处理（默认停止）。
    let mut rows: Vec<Vec<Value>> = Vec::with_capacity(aligned.len());
    let mut skipped = 0usize;
    for (label, sheet, physical, cells) in &aligned {
        let mut converted: Vec<Value> = Vec::with_capacity(width);
        let mut failure: Option<String> = None;
        for index in 0..width {
            let raw = cells.get(index).map(String::as_str).unwrap_or("");
            match convert_cell(raw, types[index]) {
                Ok(value) => converted.push(value),
                Err(reason) => {
                    failure = Some(format!("字段“{}”的值“{raw}”{reason}", base_header[index]));
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
                            "节点「{node_name}」读取 {label} 第 {physical} 行时{detail}。\
                             已按“停止”策略中止；可在节点配置中改为“跳过并记录”。"
                        ),
                    ));
                }
                RowErrorPolicy::Skip => {
                    skipped += 1;
                    if messages.len() < 20 {
                        messages.push(format!("跳过 {label} 第 {physical} 行：{detail}"));
                    }
                }
            },
            None => {
                if attach {
                    converted.push(Value::Text(label.clone()));
                    converted.push(Value::Text(sheet.clone()));
                    converted.push(Value::Int(*physical as i64));
                }
                rows.push(converted);
            }
        }
    }

    let mut columns = base_header.clone();
    if attach {
        columns.push("来源文件".to_owned());
        columns.push("Sheet".to_owned());
        columns.push("原始行号".to_owned());
        types.push(ColType::Text);
        types.push(ColType::Text);
        types.push(ColType::Integer);
    }
    stats.extend(type_notes);
    if skipped > 0 {
        stats.push(format!("跳过行数：{skipped}"));
    }
    if context.mode == super::RunMode::Preview {
        stats.push(format!(
            "预览模式：每个输入节点仅读取前 {} 行数据（全局默认 {PREVIEW_ROWS} 行）",
            context.preview_rows
        ));
    }
    let type_summary = columns
        .iter()
        .zip(types.iter())
        .map(|(name, kind)| format!("{name}：{}", kind.display()))
        .collect::<Vec<_>>()
        .join("，");
    stats.push(format!("列类型：{type_summary}"));

    let table = Table { columns, types, rows };
    let mut outcome = NodeOutcome::with_anchor("output", table);
    outcome.stats = stats;
    outcome.messages = messages;
    outcome.has_warnings = skipped > 0;
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 手动编码/分隔符的定向文本读取器（encoding_rs 严格解码 + csv 解析）。
// 空白行保留为一条空记录（与共享层 spreadsheet_input 行为一致，保证行号一致）。
// ---------------------------------------------------------------------------

struct DecodeReader {
    input: BufReader<fs::File>,
    decoder: encoding_rs::Decoder,
    buffer: Box<[u8]>,
    start: usize,
    end: usize,
    finished: bool,
    replaced: std::rc::Rc<std::cell::Cell<u64>>,
    bytes_in: std::rc::Rc<std::cell::Cell<u64>>,
}

impl Read for DecodeReader {
    fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
        if target.is_empty() {
            return Ok(0);
        }
        while self.start == self.end && !self.finished {
            let bytes = self.input.fill_buf()?;
            let last = bytes.is_empty();
            self.bytes_in.set(
                self.bytes_in
                    .get()
                    .saturating_add(bytes.len() as u64),
            );
            let (status, used, written, _malformed) =
                self.decoder.decode_to_utf8(bytes, self.buffer.as_mut(), last);
            self.input.consume(used);
            let window = &self.buffer[..written];
            let mut replaced = 0u64;
            let mut index = 0usize;
            while index + 3 <= window.len() {
                if window[index] == 0xEF && window[index + 1] == 0xBF && window[index + 2] == 0xBD {
                    replaced += 1;
                    index += 3;
                } else {
                    index += 1;
                }
            }
            self.replaced.set(self.replaced.get().saturating_add(replaced));
            self.start = 0;
            self.end = written;
            self.finished = last && status == encoding_rs::CoderResult::InputEmpty;
        }
        let count = target.len().min(self.end - self.start);
        target[..count].copy_from_slice(&self.buffer[self.start..self.start + count]);
        self.start += count;
        Ok(count)
    }
}

/// 保留空白行为一条空记录（csv 解析器默认丢弃空行）。
struct KeepBlankRecords<R: Read> {
    reader: BufReader<R>,
    state: u8, // 0 字段起点，1 普通字段，2 引号内，3 闭引号之后
    empty: bool,
    crlf: bool,
    pending: [u8; 3],
    pending_start: usize,
    pending_end: usize,
    delimiter: u8,
}

impl<R: Read> KeepBlankRecords<R> {
    fn new(reader: R, delimiter: u8) -> Self {
        Self {
            reader: BufReader::new(reader),
            state: 0,
            empty: true,
            crlf: false,
            pending: [0; 3],
            pending_start: 0,
            pending_end: 0,
            delimiter,
        }
    }
}

impl<R: Read> Read for KeepBlankRecords<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut written = 0;
        while written < output.len() {
            if self.pending_start < self.pending_end {
                output[written] = self.pending[self.pending_start];
                self.pending_start += 1;
                written += 1;
                continue;
            }
            let buffer = self.reader.fill_buf()?;
            let Some(&byte) = buffer.first() else { break };
            self.reader.consume(1);
            let newline = matches!(byte, b'\r' | b'\n') && self.state != 2;
            let continuation = byte == b'\n' && self.crlf;
            self.crlf = byte == b'\r' && newline;
            let insert = newline && self.empty && !continuation;
            if newline {
                self.empty = true;
                self.state = 0;
            } else {
                self.empty = false;
                self.state = match (self.state, byte) {
                    (0, b'"') => 2,
                    (2, b'"') => 3,
                    (3, b'"') => 2,
                    (2, _) => 2,
                    (_, b) if b == self.delimiter => 0,
                    _ => 1,
                };
            }
            self.pending_start = 0;
            if insert {
                self.pending = [b'"', b'"', byte];
                self.pending_end = 3;
            } else {
                self.pending[0] = byte;
                self.pending_end = 1;
            }
        }
        Ok(written)
    }
}

fn delimiter_byte(key: &str) -> Option<u8> {
    match key {
        "comma" | "," => Some(b','),
        "tab" | "\\t" | "\t" => Some(b'\t'),
        "semicolon" | ";" => Some(b';'),
        "pipe" | "|" => Some(b'|'),
        _ => None,
    }
}

/// 手动指定编码（gbk/utf8/utf8bom/utf16）与分隔符的逐行读取。
fn manual_text_rows(
    path: &Path,
    encoding_key: &str,
    delimiter_key: &str,
    mut visit: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    if !path.is_file() {
        return Err(structural(
            "DATAFLOW_PATH_NOT_FOUND",
            format!("文件不存在：{}", path.display()),
        ));
    }
    let file = fs::File::open(path).map_err(|error| {
        structural(
            "SPREADSHEET_READ_FAILED",
            format!("无法读取表格文件：{error}"),
        )
    })?;
    let mut reader = BufReader::new(file);
    let prefix = reader.fill_buf().map_err(|error| {
        structural(
            "SPREADSHEET_READ_FAILED",
            format!("无法读取表格文件：{error}"),
        )
    })?;
    let (encoding, skip): (&'static Encoding, usize) = match encoding_key {
        "gbk" => (GBK, 0),
        "utf8" => (UTF_8, 0),
        "utf8bom" => (
            UTF_8,
            if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
                3
            } else {
                0
            },
        ),
        "utf16" => {
            if prefix.starts_with(&[0xFE, 0xFF]) {
                (UTF_16BE, 2)
            } else if prefix.starts_with(&[0xFF, 0xFE]) {
                (UTF_16LE, 2)
            } else {
                (UTF_16LE, 0)
            }
        }
        other => {
            return Err(structural(
                "DATAFLOW_CONFIG_INVALID",
                format!("不支持的编码“{other}”（可选 gbk / utf8 / utf8bom / utf16）。"),
            ));
        }
    };
    reader.consume(skip);
    let replaced = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let bytes_in = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let decoder = DecodeReader {
        input: reader,
        decoder: encoding.new_decoder(),
        buffer: vec![0u8; 32_768].into_boxed_slice(),
        start: 0,
        end: 0,
        finished: false,
        replaced: replaced.clone(),
        bytes_in: bytes_in.clone(),
    };

    let delimiter = match delimiter_byte(delimiter_key) {
        Some(byte) => byte,
        None => {
            if delimiter_key != "auto" {
                return Err(structural(
                    "DATAFLOW_CONFIG_INVALID",
                    format!("不支持的分隔符“{delimiter_key}”（可选 comma / tab / semicolon / pipe / auto）。"),
                ));
            }
            sniff_decoded_delimiter(path, encoding, skip)?
        }
    };

    let mut csv_reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(KeepBlankRecords::new(decoder, delimiter));
    let mut physical = 0usize;
    for record in csv_reader.records() {
        physical += 1;
        let record = record.map_err(|error| {
            structural(
                "TEXT_READ_FAILED",
                format!("{}：文本读取失败（{error}）。", file_label(path)),
            )
        })?;
        visit(record.iter().map(str::to_owned).collect(), physical)?;
    }
    if replaced.get() > 0 && replaced.get() > bytes_in.get() / 8 {
        return Err(structural(
            "TEXT_ENCODING_INVALID",
            format!(
                "{}：指定编码“{encoding_key}”无法解码文件内容（大面积乱码），请改用自动识别或正确编码。",
                file_label(path)
            ),
        ));
    }
    Ok(())
}

/// 预读文件头的解码样例用于自动分隔符识别（手动编码 + 自动分隔符）。
fn sniff_decoded_delimiter(
    path: &Path,
    encoding: &'static Encoding,
    skip: usize,
) -> Result<u8, AppError> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|mut file| {
            file.seek(std::io::SeekFrom::Start(skip as u64))?;
            let mut limited = file.take(65_536);
            limited.read_to_end(&mut bytes)
        })
        .map_err(|error| {
            structural(
                "SPREADSHEET_READ_FAILED",
                format!("无法读取表格文件：{error}"),
            )
        })?;
    let (text, _, _) = encoding.decode(&bytes);
    Ok(crate::spreadsheet_input::sniff_delimiter(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_patterns_match_windows_names() {
        assert!(pattern_matches(b"*.csv", b"2026-01.csv"));
        assert!(pattern_matches(b"*", "任意".as_bytes()));
        assert!(pattern_matches(b"???.txt", b"abc.txt"));
        assert!(!pattern_matches(b"*.csv", b"data.tsv"));
        assert!(!pattern_matches(b"a*c", b"ab"));
    }

    #[test]
    fn column_type_inference_follows_section9_rules() {
        let samples = |texts: &[&str]| texts.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(infer_column_type(&samples(&["1", "23", "405"])).0, ColType::Integer);
        assert_eq!(infer_column_type(&samples(&["1", "2.5"])).0, ColType::Decimal);
        assert_eq!(infer_column_type(&samples(&["1,234.56", "78.90"])).0, ColType::Decimal);
        assert_eq!(infer_column_type(&samples(&["2026-10-27", "2026/1/5"])).0, ColType::Date);
        assert_eq!(infer_column_type(&samples(&["0012", "0013"])).0, ColType::Text);
        let (kind, note) = infer_column_type(&samples(&["123456789012345678", "5"]));
        assert_eq!(kind, ColType::Text);
        assert!(note.is_some());
        assert_eq!(infer_column_type(&samples(&[])).0, ColType::Text);
        // 8 位连续数字不自动判日期（账号场景）。
        assert_eq!(infer_column_type(&samples(&["20261027", "20261028"])).0, ColType::Integer);
    }
}
