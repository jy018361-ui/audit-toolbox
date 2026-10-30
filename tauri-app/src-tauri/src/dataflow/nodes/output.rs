//! 输出节点：Excel 输出（excel_out）与 CSV 输出（csv_out）。
//!
//! - 预览运行不写输出文件，仅在结果区展示（锚点正常返回）；
//! - 全量运行先写同目录临时文件，成功后按覆盖策略提交（error 默认报错、
//!   timestamp 加时间戳、replace 覆盖且提交前保留原文件）；
//! - xlsx 超 1048576 行按 splitMode（sheet / file / error）处理；列数超限明确报错；
//! - CSV 按 splitRows 分文件；GBK 编码不可表示字符明确报错，不以问号替换；
//! - 精确十进制与 15 位以上整数写入 Excel 数值前做往返校验，可能失真的
//!   值改按文本写出并记入警告（不静默丢失精度）。

use super::{config_error, structural, NodeOutcome, RunContext, Table, WrittenFile};
use crate::AppError;
use crate::dataflow::model::{CsvOutConfig, ExcelOutConfig};
use crate::dataflow::value::{Dec, Value};
use encoding_rs::GBK;
use rust_xlsxwriter::Workbook;
use serde_json::Value as Json;
use std::fs;
use std::path::{Path, PathBuf};

const XLSX_MAX_ROWS: usize = 1_048_576;
const XLSX_MAX_COLS: usize = 16_384;
/// 每个 Sheet 的最大数据行数（扣除表头行）。
const XLSX_DATA_ROWS_PER_SHEET: usize = XLSX_MAX_ROWS - 1;
/// 写出的临时文件前缀（同目标文件系统，提交成功前不是正式文件）。
const TMP_PREFIX: &str = ".dataflow-tmp-";

fn timestamp() -> String {
    chrono::Local::now().format("%Y%m%d_%H%M%S").to_string()
}

fn resolve_output_path(
    node_kind: &str,
    node_name: &str,
    file_name: &str,
    context: &RunContext,
) -> Result<PathBuf, AppError> {
    let resolved = context.resolve_placeholders(file_name);
    if resolved.trim().is_empty() {
        return Err(config_error(node_kind, node_name, "未填写输出文件名。".into()));
    }
    let path = PathBuf::from(&resolved);
    // F13 回归：相对路径（含纯文件名）一律拒绝。此前纯文件名会跳过目录
    // 存在性检查与授权检查，文件被写到进程当前工作目录（常见为安装目录），
    // 用户难以找到交付文件，且绕过了与其他节点一致的路径授权门。
    if !path.is_absolute() {
        return Err(config_error(
            node_kind,
            node_name,
            format!(
                "输出位置须为含盘符的完整路径：当前填写的是“{resolved}”。\
                 相对路径会被写到程序运行目录，既难以找到，也不经过输出目录\
                 检查与授权。请填写完整路径，例如 D:\\审计底稿\\大额客商_{{参数id}}.xlsx。"
            ),
        ));
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(structural(
                "DATAFLOW_OUTPUT_DIR_MISSING",
                format!(
                    "节点「{node_name}」的输出目录不存在：{}。请先选择输出位置。",
                    parent.display()
                ),
            ));
        }
    }
    // 目标文件可能尚不存在（canonicalize 不可用），授权检查落在其所在目录上；
    // timestamp/分片等变体与主输出同目录，随主路径的目录检查一并覆盖。
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            context.ensure_permitted(parent)?;
        }
    }
    Ok(path)
}

/// 解析覆盖策略：error 已存在即返回中文错误；timestamp 在文件名加时间戳；
/// replace 由提交阶段处理。
fn resolve_collision(path: &Path, strategy: &str, node_name: &str) -> Result<PathBuf, AppError> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    match strategy {
        "timestamp" => {
            let stem = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default();
            let extension = path
                .extension()
                .map(|ext| ext.to_string_lossy().into_owned())
                .unwrap_or_default();
            let stamped = if extension.is_empty() {
                path.with_file_name(format!("{stem}_{}", timestamp()))
            } else {
                path.with_file_name(format!("{stem}_{}.{extension}", timestamp()))
            };
            Ok(stamped)
        }
        "replace" => Ok(path.to_path_buf()),
        _ => Err(structural(
            "DATAFLOW_OUTPUT_EXISTS",
            format!(
                "目标文件已存在：{}。节点「{node_name}」已按“报错”覆盖策略停止；\
                 可将覆盖保护改为“自动加时间戳”或“直接覆盖”。",
                path.display()
            ),
        )),
    }
}

/// 临时文件写入成功后提交为正式文件（覆盖时先保留原文件，失败可回退）。
fn commit_output(tmp: &Path, target: &Path) -> Result<(), AppError> {
    let io = |error: std::io::Error| {
        structural(
            "DATAFLOW_OUTPUT_WRITE_FAILED",
            format!("输出文件提交失败：{error}"),
        )
    };
    if target.exists() {
        let backup = target.with_extension(format!(
            "{}.bak-{}",
            target
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or(""),
            uuid::Uuid::new_v4().simple()
        ));
        fs::rename(target, &backup).map_err(io)?;
        if let Err(error) = fs::rename(tmp, target) {
            let _ = fs::rename(&backup, target);
            return Err(io(error));
        }
        let _ = fs::remove_file(&backup);
    } else {
        fs::rename(tmp, target).map_err(io)?;
    }
    Ok(())
}

fn unique_sheet_name(base: &str, used: &mut Vec<String>) -> String {
    let mut candidate: String = base.chars().take(31).collect();
    while used.contains(&candidate) {
        let suffix = format!("_{}", used.len() + 1);
        let keep: usize = 31usize.saturating_sub(suffix.len());
        let stem: String = candidate.chars().take(keep).collect();
        candidate = format!("{stem}{suffix}");
    }
    used.push(candidate.clone());
    candidate
}

fn dec_to_f64(number: Dec) -> f64 {
    format!("{}e-{}", number.mantissa(), number.scale())
        .parse::<f64>()
        .unwrap_or(f64::NAN)
}

/// Excel 数值写入前的精确性校验：f64 往返后与原值相等才写数字单元格，
/// 否则按文本写出并记警告（不静默丢失精度，设计文档第 9 节）。
fn write_xlsx_cell(
    sheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    value: &Value,
    node_name: &str,
    text_precision_warnings: &mut usize,
) -> Result<(), AppError> {
    let write_error = |error: rust_xlsxwriter::XlsxError| {
        structural(
            "DATAFLOW_OUTPUT_WRITE_FAILED",
            format!("节点「{node_name}」写出 Excel 失败：{error}"),
        )
    };
    match value {
        Value::Null => Ok(()),
        Value::Text(text) => sheet.write_string(row, column, text).map(|_| ()).map_err(write_error),
        Value::Bool(flag) => sheet
            .write_boolean(row, column, *flag)
            .map(|_| ())
            .map_err(write_error),
        Value::Int(number) => {
            if *number as f64 as i64 == *number {
                sheet.write_number(row, column, *number as f64).map(|_| ()).map_err(write_error)
            } else {
                *text_precision_warnings += 1;
                sheet.write_string(row, column, &number.to_string()).map(|_| ()).map_err(write_error)
            }
        }
        Value::Dec(number) => {
            let float = dec_to_f64(*number);
            let roundtrip = Dec::parse(&format!("{float}")).ok();
            let exact = roundtrip.is_some_and(|back| back.cmp_exact(*number) == std::cmp::Ordering::Equal);
            if exact {
                sheet.write_number(row, column, float).map(|_| ()).map_err(write_error)
            } else {
                *text_precision_warnings += 1;
                sheet
                    .write_string(row, column, &number.to_text())
                    .map(|_| ())
                    .map_err(write_error)
            }
        }
        Value::Date(date) => sheet
            .write_datetime(row, column, *date)
            .map(|_| ())
            .map_err(write_error),
    }
}

/// 写一个 xlsx 文件（多 Sheet、超量分 Sheet）。返回（数据总行数，按文本
/// 写出的精度告警数）。
fn write_xlsx_file(
    path: &Path,
    tables: &[(String, &Table)],
    node_name: &str,
) -> Result<(usize, usize), AppError> {
    let mut book = Workbook::new();
    let mut used_names: Vec<String> = Vec::new();
    let mut total = 0usize;
    let mut precision_warnings = 0usize;
    for (base_name, table) in tables {
        if table.columns.len() > XLSX_MAX_COLS {
            return Err(structural(
                "EXCEL_COLUMN_LIMIT",
                format!(
                    "节点「{node_name}」的 Sheet“{base_name}”列数（{}）超过 Excel 上限 {XLSX_MAX_COLS}，\
                     已明确停止，不会静默丢列。",
                    table.columns.len()
                ),
            ));
        }
        // 空表也写一个仅含表头的 Sheet（分片不截断记录，也不丢 Sheet）。
        let chunks: Vec<&[Vec<Value>]> = if table.rows.is_empty() {
            vec![&table.rows[..]]
        } else {
            table.rows.chunks(XLSX_DATA_ROWS_PER_SHEET).collect()
        };
        for (chunk_index, chunk) in chunks.iter().enumerate() {
            let sheet_name = if chunk_index == 0 {
                unique_sheet_name(base_name, &mut used_names)
            } else {
                unique_sheet_name(&format!("{base_name}_{}", chunk_index + 1), &mut used_names)
            };
            let sheet = book.add_worksheet_with_constant_memory();
            sheet.set_name(&sheet_name).map_err(|error| {
                config_error(
                    "Excel 输出",
                    node_name,
                    format!("Sheet 名“{sheet_name}”无效：{error}"),
                )
            })?;
            for (column, name) in table.columns.iter().enumerate() {
                sheet
                    .write_string(0, column as u16, name)
                    .map(|_| ())
                    .map_err(|error| {
                        structural(
                            "DATAFLOW_OUTPUT_WRITE_FAILED",
                            format!("节点「{node_name}」写出 Excel 失败：{error}"),
                        )
                    })?;
            }
            for (row_offset, row) in chunk.iter().enumerate() {
                for (column, value) in row.iter().enumerate() {
                    write_xlsx_cell(
                        sheet,
                        (row_offset + 1) as u32,
                        column as u16,
                        value,
                        node_name,
                        &mut precision_warnings,
                    )?;
                }
            }
            total += chunk.len();
        }
    }
    let tmp = path.with_file_name(format!("{TMP_PREFIX}{}.xlsx", uuid::Uuid::new_v4().simple()));
    if let Err(error) = book.save(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(structural(
            "DATAFLOW_OUTPUT_WRITE_FAILED",
            format!("节点「{node_name}」写出 Excel 失败：{error}"),
        ));
    }
    commit_output(&tmp, path)?;
    Ok((total, precision_warnings))
}

/// Excel 输出节点。多条上游连线各成一个 Sheet（默认裁定第 11 条）。
pub(crate) fn run_excel_out(
    node_name: &str,
    config: &Json,
    inputs: &[(String, Table)],
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: ExcelOutConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("Excel 输出", node_name, error.to_string()))?;
    if inputs.is_empty() {
        return Err(config_error("Excel 输出", node_name, "输出节点缺少输入连线。".into()));
    }
    let split_mode = config.split_mode.clone().unwrap_or_else(|| "sheet".to_owned());
    if !matches!(split_mode.as_str(), "sheet" | "file" | "error") {
        return Err(config_error(
            "Excel 输出",
            node_name,
            format!("超量分片方式“{split_mode}”无法识别（可选 sheet / file / error）。"),
        ));
    }
    let overwrite = config.overwrite.clone().unwrap_or_else(|| "error".to_owned());

    // Sheet 名：第 1 条连线用配置名（缺省＝上游节点名），其余连线用各自上游节点名。
    let mut sheet_bases: Vec<String> = Vec::new();
    for (position, (upstream, _)) in inputs.iter().enumerate() {
        let base = if position == 0 {
            config
                .sheet_name
                .clone()
                .unwrap_or_else(|| upstream.clone())
        } else {
            upstream.clone()
        };
        sheet_bases.push(base);
    }

    let mut anchors = Vec::new();
    let mut rows_total = 0usize;
    for (position, (_, table)) in inputs.iter().enumerate() {
        rows_total += table.row_count();
        anchors.push((format!("sheet:{}", sheet_bases[position]), table.clone()));
    }

    if context.mode == super::RunMode::Preview {
        let mut outcome = NodeOutcome {
            anchors,
            messages: vec!["预览模式：未写入输出文件。".to_owned()],
            stats: vec![format!("拟写入 Sheet：{}", sheet_bases.join("、"))],
            written: Vec::new(),
            rows: rows_total,
            has_warnings: false,
        };
        outcome
            .stats
            .push(format!("拟写入数据行数：{rows_total}"));
        return Ok(outcome);
    }

    let path = resolve_output_path("Excel 输出", node_name, &config.file_name, context)?;
    if !matches!(overwrite.as_str(), "error" | "timestamp" | "replace") {
        return Err(config_error(
            "Excel 输出",
            node_name,
            format!("覆盖保护“{overwrite}”无法识别（可选 error / timestamp / replace）。"),
        ));
    }
    let mut written: Vec<WrittenFile> = Vec::new();
    let mut stats = Vec::new();
    let mut messages = Vec::new();
    let mut precision_total = 0usize;
    match split_mode.as_str() {
        "sheet" => {
            let target = resolve_collision(&path, &overwrite, node_name)?;
            let tables: Vec<(String, &Table)> = sheet_bases
                .iter()
                .cloned()
                .zip(inputs.iter().map(|(_, table)| table))
                .collect();
            for (base, table) in &tables {
                if table.rows.len() > XLSX_DATA_ROWS_PER_SHEET {
                    stats.push(format!(
                        "Sheet“{base}”数据行数超过 {} 行，已自动分到后续 Sheet（名_2 递增）。",
                        XLSX_DATA_ROWS_PER_SHEET
                    ));
                }
            }
            let (total, precision) = write_xlsx_file(&target, &tables, node_name)?;
            precision_total += precision;
            written.push(WrittenFile {
                path: target.clone(),
                sheet: sheet_bases[0].clone(),
                rows: total,
            });
            stats.push(format!("已写入：{}（{total} 行）", target.display()));
        }
        "file" => {
            // 分片到文件：每个数据分片一个文件，文件名按 名、名_2、名_3 递增。
            let mut file_index = 0usize;
            for (base, table) in sheet_bases.iter().zip(inputs.iter().map(|(_, table)| table)) {
                let chunks: Vec<&[Vec<Value>]> = if table.rows.is_empty() {
                    vec![&table.rows[..]]
                } else {
                    table.rows.chunks(XLSX_DATA_ROWS_PER_SHEET).collect()
                };
                if table.rows.len() > XLSX_DATA_ROWS_PER_SHEET {
                    stats.push(format!(
                        "“{base}”数据行数超过 {} 行，超出部分已分到后续文件。",
                        XLSX_DATA_ROWS_PER_SHEET
                    ));
                }
                for chunk in chunks {
                    let file = if file_index == 0 {
                        path.clone()
                    } else {
                        append_suffix(&path, &format!("_{}", file_index + 1))
                    };
                    file_index += 1;
                    let target = resolve_collision(&file, &overwrite, node_name)?;
                    let chunk_table = Table {
                        columns: table.columns.clone(),
                        types: table.types.clone(),
                        rows: chunk.to_vec(),
                    };
                    let tables = vec![(base.clone(), &chunk_table)];
                    let (count, precision) = write_xlsx_file(&target, &tables, node_name)?;
                    precision_total += precision;
                    written.push(WrittenFile {
                        path: target.clone(),
                        sheet: base.clone(),
                        rows: count,
                    });
                    stats.push(format!("已写入：{}（{count} 行）", target.display()));
                }
            }
        }
        _ => {
            for (base, table) in sheet_bases.iter().zip(inputs.iter().map(|(_, table)| table)) {
                if table.rows.len() > XLSX_DATA_ROWS_PER_SHEET {
                    return Err(structural(
                        "DATAFLOW_OUTPUT_TOO_LARGE",
                        format!(
                            "节点「{node_name}」的“{base}”数据行数（{}）超过单个 Sheet 上限 \
                             （{XLSX_DATA_ROWS_PER_SHEET} 行数据），且超量分片方式为“报错”。\
                             请改分片方式或缩小数据范围。",
                            table.rows.len()
                        ),
                    ));
                }
            }
            let target = resolve_collision(&path, &overwrite, node_name)?;
            let tables: Vec<(String, &Table)> = sheet_bases
                .iter()
                .cloned()
                .zip(inputs.iter().map(|(_, table)| table))
                .collect();
            let (total, precision) = write_xlsx_file(&target, &tables, node_name)?;
            precision_total += precision;
            written.push(WrittenFile {
                path: target.clone(),
                sheet: sheet_bases[0].clone(),
                rows: total,
            });
            stats.push(format!("已写入：{}（{total} 行）", target.display()));
        }
    }
    if precision_total > 0 {
        messages.push(format!(
            "有 {precision_total} 个数值超出 Excel 数值可精确表示的范围，已按文本写出以避免精度损失。"
        ));
    }
    let rows = written.iter().map(|file| file.rows).sum();
    let mut outcome = NodeOutcome {
        anchors,
        messages,
        stats,
        written,
        rows,
        has_warnings: precision_total > 0,
    };
    outcome.stats.push(format!("写入数据行数合计：{rows}"));
    Ok(outcome)
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    match path.extension() {
        Some(ext) => path.with_file_name(format!("{stem}{suffix}.{}", ext.to_string_lossy())),
        None => path.with_file_name(format!("{stem}{suffix}")),
    }
}

/// CSV 单元格序列化：仅当包含分隔符、引号或换行时加引号（RFC 4180）。
fn csv_field(text: &str, delimiter: u8) -> String {
    if text.contains(delimiter as char)
        || text.contains('"')
        || text.contains('\r')
        || text.contains('\n')
    {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

fn csv_delimiter(key: &str) -> u8 {
    match key {
        "tab" => b'\t',
        "semicolon" => b';',
        "pipe" => b'|',
        _ => b',',
    }
}

/// 写一个 CSV 文件（含表头），返回数据行数。编码不可表示字符明确报错。
fn write_csv_file(
    path: &Path,
    table: &Table,
    encoding_key: &str,
    delimiter: u8,
    node_name: &str,
) -> Result<usize, AppError> {
    let mut buffer: Vec<u8> = Vec::new();
    if encoding_key == "utf8bom" {
        buffer.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    let mut line = table
        .columns
        .iter()
        .map(|name| csv_field(name, delimiter))
        .collect::<Vec<_>>()
        .join(&(delimiter as char).to_string());
    line.push_str("\r\n");
    encode_line(&mut buffer, &line, encoding_key, 0, "表头", node_name)?;
    for (index, row) in table.rows.iter().enumerate() {
        let mut line = row
            .iter()
            .map(|value| csv_field(&value.to_display(), delimiter))
            .collect::<Vec<_>>()
            .join(&(delimiter as char).to_string());
        line.push_str("\r\n");
        encode_line(&mut buffer, &line, encoding_key, index + 1, "数据行", node_name)?;
    }
    let tmp = path.with_file_name(format!("{TMP_PREFIX}{}.csv", uuid::Uuid::new_v4().simple()));
    if let Err(error) = fs::write(&tmp, &buffer) {
        let _ = fs::remove_file(&tmp);
        return Err(structural(
            "DATAFLOW_OUTPUT_WRITE_FAILED",
            format!("节点「{node_name}」写出 CSV 失败：{error}"),
        ));
    }
    commit_output(&tmp, path)?;
    Ok(table.rows.len())
}

fn encode_line(
    buffer: &mut Vec<u8>,
    line: &str,
    encoding_key: &str,
    row_number: usize,
    row_kind: &str,
    node_name: &str,
) -> Result<(), AppError> {
    match encoding_key {
        "utf8" | "utf8bom" => {
            buffer.extend_from_slice(line.as_bytes());
        }
        _ => {
            let (bytes, _, had_errors) = GBK.encode(line);
            if had_errors {
                let sample: String = line
                    .chars()
                    .filter(|character| GBK.encode(character.to_string().as_str()).2)
                    .take(3)
                    .map(|character| character.to_string())
                    .collect::<Vec<_>>()
                    .join("、");
                return Err(structural(
                    "DATAFLOW_ENCODING_UNREPRESENTABLE",
                    format!(
                        "节点「{node_name}」写 CSV（GBK）时，第 {row_number} {row_kind}含有 GBK \
                         无法表示的字符（如“{sample}”）。请改用 UTF-8 编码输出，不会以问号替换。",
                    ),
                ));
            }
            buffer.extend_from_slice(bytes.as_ref());
        }
    }
    Ok(())
}

/// CSV 输出节点：多条上游连线每条一个文件（默认裁定第 11 条），
/// 按 splitRows 分文件（分片不截断记录）。
pub(crate) fn run_csv_out(
    node_name: &str,
    config: &Json,
    inputs: &[(String, Table)],
    context: &RunContext,
) -> Result<NodeOutcome, AppError> {
    let config: CsvOutConfig = serde_json::from_value(config.clone())
        .map_err(|error| config_error("CSV 输出", node_name, error.to_string()))?;
    if inputs.is_empty() {
        return Err(config_error("CSV 输出", node_name, "输出节点缺少输入连线。".into()));
    }
    let encoding_key = config
        .encoding
        .clone()
        .unwrap_or_else(|| "gbk".to_owned())
        .to_lowercase();
    if !matches!(encoding_key.as_str(), "gbk" | "utf8" | "utf8bom") {
        return Err(config_error(
            "CSV 输出",
            node_name,
            format!("编码“{encoding_key}”无法识别（可选 gbk / utf8 / utf8bom）。"),
        ));
    }
    let overwrite = config.overwrite.clone().unwrap_or_else(|| "error".to_owned());
    if !matches!(overwrite.as_str(), "error" | "timestamp" | "replace") {
        return Err(config_error(
            "CSV 输出",
            node_name,
            format!("覆盖保护“{overwrite}”无法识别（可选 error / timestamp / replace）。"),
        ));
    }
    let delimiter_key = config.delimiter.clone().unwrap_or_else(|| "comma".to_owned());
    let delimiter = csv_delimiter(&delimiter_key);
    let split_rows = config.split_rows.unwrap_or(0);

    let mut rows_total = 0usize;
    for (_, table) in inputs {
        rows_total += table.row_count();
    }

    let path = resolve_output_path("CSV 输出", node_name, &config.file_name, context)?;
    let base_names: Vec<String> = (0..inputs.len())
        .map(|position| {
            if position == 0 {
                path.file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "输出".to_owned())
            } else {
                format!(
                    "{}_{}",
                    path.file_stem()
                        .map(|stem| stem.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "输出".to_owned()),
                    position + 1
                )
            }
        })
        .collect();
    // 锚点用解析后的文件名做 key。
    let anchors = (0..inputs.len())
        .map(|position| {
            (
                format!(
                    "file:{}.{}",
                    base_names[position],
                    path.extension()
                        .map(|ext| ext.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "csv".to_owned())
                ),
                inputs[position].1.clone(),
            )
        })
        .collect::<Vec<_>>();

    if context.mode == super::RunMode::Preview {
        return Ok(NodeOutcome {
            anchors,
            messages: vec!["预览模式：未写入输出文件。".to_owned()],
            stats: vec![
                format!("拟写入文件：{}（编码 {encoding_key}、分隔符 {delimiter_key}）", path.display()),
                format!("拟写入数据行数：{rows_total}"),
            ],
            written: Vec::new(),
            rows: rows_total,
            has_warnings: false,
        });
    }

    let mut written: Vec<WrittenFile> = Vec::new();
    let mut stats = Vec::new();
    for (position, (_, table)) in inputs.iter().enumerate() {
        let file = if position == 0 {
            path.clone()
        } else {
            append_suffix(&path, &format!("_{}", position + 1))
        };
        if split_rows > 0 && table.rows.len() > split_rows {
            let chunks = table.rows.len().div_ceil(split_rows);
            for chunk_index in 0..chunks {
                let chunk_path = if chunk_index == 0 {
                    file.clone()
                } else {
                    append_suffix(&file, &format!("_{}", chunk_index + 1))
                };
                let target = resolve_collision(&chunk_path, &overwrite, node_name)?;
                let start = chunk_index * split_rows;
                let end = ((chunk_index + 1) * split_rows).min(table.rows.len());
                let chunk_table = Table {
                    columns: table.columns.clone(),
                    types: table.types.clone(),
                    rows: table.rows[start..end].to_vec(),
                };
                let count = write_csv_file(&target, &chunk_table, &encoding_key, delimiter, node_name)?;
                written.push(WrittenFile {
                    path: target.clone(),
                    sheet: String::new(),
                    rows: count,
                });
                stats.push(format!("已写入：{}（{count} 行）", target.display()));
            }
            stats.push(format!(
                "输入 {} 按每文件 {split_rows} 行分为 {chunks} 个文件。",
                base_names[position]
            ));
        } else {
            let target = resolve_collision(&file, &overwrite, node_name)?;
            let count = write_csv_file(&target, table, &encoding_key, delimiter, node_name)?;
            written.push(WrittenFile {
                path: target.clone(),
                sheet: String::new(),
                rows: count,
            });
            stats.push(format!("已写入：{}（{count} 行）", target.display()));
        }
    }
    let rows = written.iter().map(|file| file.rows).sum();
    stats.push(format!("写入数据行数合计：{rows}"));
    Ok(NodeOutcome {
        anchors,
        messages: Vec::new(),
        stats,
        written,
        rows,
        has_warnings: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context_with_allowed(allowed: Option<Vec<PathBuf>>) -> RunContext {
        RunContext {
            mode: super::super::RunMode::Full,
            today: chrono::NaiveDate::from_ymd_opt(2026, 10, 30).unwrap(),
            param_values: std::collections::HashMap::new(),
            preview_rows: 1000,
            allowed_paths: allowed,
        }
    }

    /// F13 回归：占位符示例鼓励填纯文件名（如 大额客商_{参数id}.xlsx），
    /// 此前该形态会跳过目录存在性检查与授权检查，文件被写到进程当前
    /// 工作目录（常见为安装目录），用户找不到交付文件且绕过授权门。
    /// 现在相对路径（含纯文件名）一律中文报错，要求填写完整路径。
    #[test]
    fn bare_file_name_and_relative_path_are_rejected() {
        let context = context_with_allowed(None);
        for name in ["大额客商_1.xlsx", "明细.csv", "sub/结果.xlsx", "./结果.xlsx"] {
            let error = resolve_output_path("Excel 输出", "节点一", name, &context)
                .expect_err("相对路径应被拒绝");
            assert_eq!(
                error.code, "DATAFLOW_CONFIG_INVALID",
                "应报配置错误（实际报 {name}）：{}",
                error.user_message
            );
            assert!(
                error.user_message.contains("完整路径"),
                "报错应引导填写完整路径：{}",
                error.user_message
            );
        }
    }

    /// 绝对路径照常放行（未注入白名单的单元测试直调场景）。
    #[test]
    fn absolute_path_in_existing_dir_is_accepted() {
        let context = context_with_allowed(None);
        let target = std::env::temp_dir().join("大额客商_1.xlsx");
        let path = resolve_output_path("Excel 输出", "节点一", &target.to_string_lossy(), &context)
            .expect("绝对路径应放行");
        assert_eq!(path, target);
    }

    /// 授权检查须覆盖输出目录：注入白名单后，目录在白名单内放行、
    /// 白名单外拒绝（此前纯文件名分支会完全跳过这一检查）。
    #[test]
    fn permitted_directory_gate_covers_output_path() {
        let temp = std::env::temp_dir();
        let allowed = context_with_allowed(Some(vec![temp.clone()]));
        let inside = temp.join("大额客商_1.xlsx");
        resolve_output_path("Excel 输出", "节点一", &inside.to_string_lossy(), &allowed)
            .expect("白名单目录内的输出应放行");

        let outside = PathBuf::from(r"C:\Windows\System32\drivers\etc\结果.xlsx");
        let error = resolve_output_path("Excel 输出", "节点一", &outside.to_string_lossy(), &allowed)
            .expect_err("白名单外的输出应被授权门拒绝");
        assert_eq!(error.code, "PATH_NOT_AUTHORIZED");
    }

    /// 既有行为回归保护：绝对路径的输出目录不存在时仍报目录缺失。
    #[test]
    fn missing_output_directory_still_errors() {
        let context = context_with_allowed(None);
        let missing = std::env::temp_dir().join("dataflow-no-such-dir-xyz")
            .join("结果.xlsx");
        let error = resolve_output_path("CSV 输出", "节点一", &missing.to_string_lossy(), &context)
            .expect_err("输出目录不存在应报错");
        assert_eq!(error.code, "DATAFLOW_OUTPUT_DIR_MISSING");
    }

    /// 占位符解析成完整路径后应正常放行（{参数id} 替换表注入白名单目录）。
    #[test]
    fn placeholder_resolved_to_absolute_path_is_accepted() {
        let mut context = context_with_allowed(None);
        let temp = std::env::temp_dir();
        context
            .param_values
            .insert("输出目录".to_owned(), temp.to_string_lossy().into_owned());
        let path = resolve_output_path(
            "Excel 输出",
            "节点一",
            "{输出目录}\\大额客商_{参数id}.xlsx",
            &context,
        )
        .expect("占位符解析为完整路径应放行");
        assert_eq!(path, temp.join("大额客商_{参数id}.xlsx"));
    }
}
