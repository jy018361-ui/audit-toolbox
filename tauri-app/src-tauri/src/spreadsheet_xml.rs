//! SpreadsheetML 2003 data reader. No Excel/COM, no evaluation of formulas.
//! Metadata is cached separately; row visitors stop before decoding the tail.
//! Layout-preserving template consumers still use spreadsheet_input::prepare_xlsx.
use crate::AppError;
use calamine::{Data, ExcelDateTime, ExcelDateTimeType};
use quick_xml::{
    NsReader,
    events::{BytesStart, Event},
    name::ResolveResult,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const NS: &[u8] = b"urn:schemas-microsoft-com:office:spreadsheet";
const EXCEL_NS: &[u8] = b"urn:schemas-microsoft-com:office:excel";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const ROWS: usize = 1_048_576;
const COLS: usize = 16_384;
const DONE: &str = "XML_SHEET_DONE";

fn invalid(detail: impl ToString) -> AppError {
    AppError::new(
        "XML_WORKBOOK_INVALID",
        "无法读取 Excel 2003 XML 表格，请检查源文件。",
        true,
        Some(detail.to_string()),
    )
}
fn cancelled(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new("JOB_CANCELLED", "任务已取消。", true, None))
    } else {
        Ok(())
    }
}
fn attr(tag: &BytesStart<'_>, key: &[u8]) -> Result<Option<String>, AppError> {
    for item in tag.attributes() {
        let item = item.map_err(invalid)?;
        if item.key.local_name().as_ref() == key {
            return Ok(Some(
                quick_xml::escape::unescape(std::str::from_utf8(&item.value).map_err(invalid)?)
                    .map_err(invalid)?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}
fn index(tag: &BytesStart<'_>, key: &[u8], default: usize, max: usize) -> Result<usize, AppError> {
    let value = attr(tag, key)?
        .map(|v| v.parse::<usize>().map_err(invalid))
        .transpose()?
        .unwrap_or(default);
    if value > max {
        return Err(invalid("行列索引超出 Excel 范围"));
    }
    Ok(value)
}

// Cap a single XML token before quick-xml can allocate an unbounded buffer.
struct Input<'a, R> {
    input: BufReader<R>,
    used: std::rc::Rc<std::cell::Cell<usize>>,
    cancel: &'a AtomicBool,
}
impl<R: Read> BufRead for Input<'_, R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("任务已取消。"));
        }
        let left = (MAX_BYTES + 4096).saturating_sub(self.used.get());
        if left == 0 {
            return Err(std::io::Error::other("Excel XML 单个记录超过安全预算"));
        }
        let bytes = self.input.fill_buf()?;
        Ok(&bytes[..bytes.len().min(left)])
    }
    fn consume(&mut self, count: usize) {
        self.used.set(self.used.get() + count);
        self.input.consume(count);
    }
}
impl<R: Read> Read for Input<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let bytes = self.fill_buf()?;
        let count = bytes.len().min(output.len());
        output[..count].copy_from_slice(&bytes[..count]);
        self.consume(count);
        Ok(count)
    }
}

fn scan(
    path: &Path,
    cancel: &AtomicBool,
    mut visit: impl FnMut(Event<'_>, bool, bool) -> Result<(), AppError>,
) -> Result<(), AppError> {
    cancelled(cancel)?;
    let used = std::rc::Rc::new(std::cell::Cell::new(0));
    let mut reader = NsReader::from_reader(Input {
        input: BufReader::new(crate::spreadsheet_input::xml_input(path)?),
        used: used.clone(),
        cancel,
    });
    let mut buffer = Vec::new();
    let mut depth = 0usize;
    let mut root = false;
    let mut closed = false;
    loop {
        used.set(0);
        buffer.clear();
        let (namespace, event) = reader
            .read_resolved_event_into(&mut buffer)
            .map_err(|e| cancelled(cancel).err().unwrap_or_else(|| invalid(e)))?;
        let ss = matches!(&namespace, ResolveResult::Bound(ns) if ns.as_ref() == NS);
        let excel = matches!(&namespace, ResolveResult::Bound(ns) if ns.as_ref() == EXCEL_NS);
        match &event {
            Event::Start(tag) | Event::Empty(tag) => {
                if depth == 0 {
                    if root || !ss || tag.local_name().as_ref() != b"Workbook" {
                        return Err(invalid("根元素不是 SpreadsheetML Workbook"));
                    }
                    root = true;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                } else if depth == 0 {
                    closed = true;
                }
                if depth > 128 {
                    return Err(invalid("XML 嵌套层数过深"));
                }
            }
            Event::End(_) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("XML 层级无效"))?;
                closed |= depth == 0;
            }
            Event::DocType(_) => return Err(invalid("不支持带 DTD 的 Excel XML")),
            Event::Eof => {
                if !root || !closed || depth != 0 {
                    return Err(invalid("XML 文件未完整结束"));
                }
                return Ok(());
            }
            _ => {}
        }
        visit(event, ss, excel)?;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Sheet {
    pub(crate) name: String,
    pub(crate) hidden: bool,
    pub(crate) very_hidden: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Style {
    parent: String,
    format: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Catalog {
    pub(crate) sheets: Vec<Sheet>,
    styles: HashMap<String, Style>,
    date1904: bool,
}

fn event_text(event: &Event<'_>) -> Result<Option<String>, AppError> {
    Ok(match event {
        Event::Text(value) => Some(
            quick_xml::escape::unescape(
                &value
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(invalid)?,
            )
            .map_err(invalid)?
            .into_owned(),
        ),
        Event::CData(value) => Some(value.decode().map_err(invalid)?.into_owned()),
        Event::GeneralRef(value) => {
            let name = value.decode().map_err(invalid)?;
            Some(
                quick_xml::escape::unescape(&format!("&{name};"))
                    .map_err(invalid)?
                    .into_owned(),
            )
        }
        _ => None,
    })
}

pub(crate) fn catalog(path: &Path) -> Result<Catalog, AppError> {
    catalog_with_cancel(path, &AtomicBool::new(false))
}

fn catalog_with_cancel(path: &Path, cancel: &AtomicBool) -> Result<Catalog, AppError> {
    cancelled(cancel)?;
    crate::table_read_cache::read(path, "spreadsheetml-catalog-v1", &(), || {
        let mut catalog = Catalog::default();
        let mut style_id = None;
        let mut visibility = false;
        let mut visibility_text = String::new();
        scan(path, cancel, |event, ss, excel| {
            match &event {
                Event::Start(tag) | Event::Empty(tag) if ss => match tag.local_name().as_ref() {
                    b"Style" => {
                        let id = attr(tag, b"ID")?.ok_or_else(|| invalid("样式缺少 ID"))?;
                        catalog.styles.insert(
                            id.clone(),
                            Style {
                                parent: attr(tag, b"Parent")?.unwrap_or_default(),
                                format: None,
                            },
                        );
                        style_id = Some(id);
                    }
                    b"NumberFormat" => {
                        if let Some(style) =
                            style_id.as_ref().and_then(|id| catalog.styles.get_mut(id))
                        {
                            style.format = attr(tag, b"Format")?;
                        }
                    }
                    b"Worksheet" => {
                        let name = attr(tag, b"Name")?
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| invalid("工作表缺少名称"))?;
                        if catalog
                            .sheets
                            .iter()
                            .any(|s| s.name.eq_ignore_ascii_case(&name))
                        {
                            return Err(invalid("工作表名称重复"));
                        }
                        catalog.sheets.push(Sheet {
                            name,
                            hidden: false,
                            very_hidden: false,
                        });
                    }
                    _ => {}
                },
                Event::Start(tag) | Event::Empty(tag) if excel => match tag.local_name().as_ref() {
                    b"Date1904" => catalog.date1904 = true,
                    b"Visible" => {
                        visibility = true;
                        visibility_text.clear();
                    }
                    _ => {}
                },
                Event::End(tag) if ss && tag.local_name().as_ref() == b"Style" => style_id = None,
                Event::End(tag) if excel && tag.local_name().as_ref() == b"Visible" => {
                    if let Some(sheet) = catalog.sheets.last_mut() {
                        sheet.hidden =
                            matches!(visibility_text.trim(), "SheetHidden" | "SheetVeryHidden");
                        sheet.very_hidden = visibility_text.trim() == "SheetVeryHidden";
                    }
                    visibility = false;
                }
                _ if visibility => {
                    if let Some(text) = event_text(&event)? {
                        visibility_text.push_str(&text);
                    }
                }
                _ => {}
            }
            Ok(())
        })?;
        if catalog.sheets.is_empty() {
            return Err(invalid("工作簿没有工作表"));
        }
        Ok(catalog)
    })
}

pub(crate) fn sheets(
    path: &Path,
    requested: Option<&str>,
) -> Result<(String, Vec<String>), AppError> {
    let catalog = catalog(path)?;
    let all = catalog
        .sheets
        .iter()
        .map(|s| s.name.clone())
        .collect::<Vec<_>>();
    let selected = match requested.filter(|s| !s.trim().is_empty()) {
        Some(name) if all.iter().any(|s| s == name) => name.to_owned(),
        Some(name) => {
            return Err(AppError::new(
                "SHEET_NOT_FOUND",
                "指定的工作表已不存在，请重新选择。",
                true,
                Some(name.to_owned()),
            ));
        }
        None => catalog
            .sheets
            .iter()
            .find(|s| !s.hidden)
            .unwrap_or(&catalog.sheets[0])
            .name
            .clone(),
    };
    Ok((selected, all))
}

impl Catalog {
    fn date_style(&self, id: &str) -> bool {
        let mut id = if id.is_empty() { "Default" } else { id };
        for _ in 0..128 {
            let Some(style) = self.styles.get(id) else {
                return false;
            };
            if let Some(format) = &style.format {
                return date_format(format);
            }
            if style.parent.is_empty() {
                if id == "Default" {
                    return false;
                }
                id = "Default";
            } else {
                id = &style.parent;
            }
        }
        false
    }
}

fn date_format(format: &str) -> bool {
    let lower = format.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "short date"
            | "long date"
            | "general date"
            | "short time"
            | "long time"
            | "medium date"
            | "medium time"
    ) {
        return true;
    }
    if matches!(
        lower.as_str(),
        "general"
            | "general number"
            | "fixed"
            | "standard"
            | "currency"
            | "euro currency"
            | "percent"
            | "scientific"
            | "yes/no"
            | "true/false"
            | "on/off"
    ) {
        return false;
    }
    let mut quoted = false;
    let mut escaped = false;
    let mut bracket = false;
    let mut cleaned = String::new();
    for c in lower.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '"' {
            quoted = !quoted;
            continue;
        }
        if quoted {
            continue;
        }
        if c == '[' {
            bracket = true;
            continue;
        }
        if c == ']' {
            bracket = false;
            continue;
        }
        if !bracket {
            cleaned.push(c);
        }
    }
    cleaned.contains('y')
        || cleaned.contains('d')
        || cleaned.contains("mm")
        || cleaned.contains("h:")
        || cleaned.contains(":ss")
}

struct Cell {
    column: usize,
    end_column: usize,
    style: String,
    kind: String,
    value: String,
    has_data: bool,
    formula: bool,
}
fn cell_data(cell: &Cell, catalog: &Catalog) -> Result<Data, AppError> {
    if !cell.has_data {
        return if cell.formula {
            Err(invalid("公式单元格没有缓存结果，请在 Excel 中重算并保存"))
        } else {
            Ok(Data::Empty)
        };
    }
    let value = cell.value.trim();
    Ok(match cell.kind.as_str() {
        "String" => Data::String(cell.value.clone()),
        "Number" => {
            let number = value.parse::<f64>().map_err(invalid)?;
            if !number.is_finite() {
                return Err(invalid("金额包含非有限数值"));
            }
            if catalog.date_style(&cell.style) {
                Data::DateTime(ExcelDateTime::new(
                    number,
                    ExcelDateTimeType::DateTime,
                    catalog.date1904,
                ))
            } else {
                Data::Float(number)
            }
        }
        "DateTime" => {
            let number = rust_xlsxwriter::ExcelDateTime::parse_from_str(value)
                .map_err(invalid)?
                .to_excel();
            Data::DateTime(ExcelDateTime::new(
                number,
                ExcelDateTimeType::DateTime,
                false,
            ))
        }
        "Boolean" => Data::Bool(match value {
            "1" | "true" => true,
            "0" | "false" => false,
            _ => return Err(invalid("布尔值无效")),
        }),
        "Error" => Data::Error(match value {
            "#DIV/0!" => calamine::CellErrorType::Div0,
            "#N/A" => calamine::CellErrorType::NA,
            "#NAME?" => calamine::CellErrorType::Name,
            "#NULL!" => calamine::CellErrorType::Null,
            "#NUM!" => calamine::CellErrorType::Num,
            "#REF!" => calamine::CellErrorType::Ref,
            "#VALUE!" => calamine::CellErrorType::Value,
            _ => return Err(invalid("未知的 Excel 错误类型")),
        }),
        _ => return Err(invalid(format!("不支持的单元格类型：{}", cell.kind))),
    })
}

/// Emits physical rows, including gaps; only one typed row is held at a time.
pub(crate) fn visit(
    path: &Path,
    selected: &str,
    cancel: &AtomicBool,
    mut visitor: impl FnMut(Vec<Data>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    visit_rows(path, selected, cancel, &mut visitor)
}

// Keep the XML state machine out of each consumer's generic row pipeline.
fn visit_rows(
    path: &Path,
    selected: &str,
    cancel: &AtomicBool,
    visitor: &mut dyn FnMut(Vec<Data>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    cancelled(cancel)?;
    let catalog = catalog_with_cancel(path, cancel)?;
    if !catalog.sheets.iter().any(|s| s.name == selected) {
        return Err(AppError::new(
            "SHEET_NOT_FOUND",
            "指定的工作表已不存在，请重新选择。",
            true,
            Some(selected.to_owned()),
        ));
    }
    let mut wanted = false;
    let mut table = false;
    let mut row = None::<Vec<Data>>;
    let mut row_number = 0;
    let mut next_row = 1;
    let mut next_column = 1;
    let mut row_style = String::new();
    let mut columns = Vec::<(usize, usize, String)>::new();
    let mut next_style_column = 1;
    let mut cell = None::<Cell>;
    let mut data = false;
    let mut row_bytes = 0usize;
    let result = scan(path, cancel, |event, ss, _| {
        let empty = matches!(&event, Event::Empty(_));
        match &event {
            Event::Start(tag) | Event::Empty(tag) if ss => match tag.local_name().as_ref() {
                b"Worksheet" => {
                    wanted = attr(tag, b"Name")?.as_deref() == Some(selected);
                }
                b"Table" if wanted => {
                    table = !empty;
                }
                b"Column" if wanted && table => {
                    let start = index(tag, b"Index", next_style_column, COLS)?;
                    let span = index(tag, b"Span", 0, COLS - 1)?;
                    let end = start
                        .checked_add(span)
                        .filter(|n| *n <= COLS)
                        .ok_or_else(|| invalid("列样式范围无效"))?;
                    if start < next_style_column {
                        return Err(invalid("列样式索引顺序无效"));
                    }
                    columns.push((start, end, attr(tag, b"StyleID")?.unwrap_or_default()));
                    next_style_column = end + 1;
                }
                b"Row" if wanted && table => {
                    row_number = index(tag, b"Index", next_row, ROWS)?;
                    if row_number < next_row {
                        return Err(invalid("行索引顺序无效"));
                    }
                    for number in next_row..row_number {
                        cancelled(cancel)?;
                        visitor(Vec::new(), number)?;
                    }
                    next_row = row_number + 1;
                    next_column = 1;
                    row_bytes = 0;
                    row_style = attr(tag, b"StyleID")?.unwrap_or_default();
                    row = Some(Vec::new());
                }
                b"Cell" if row.is_some() => {
                    let column = index(tag, b"Index", next_column, COLS)?;
                    if column < next_column {
                        return Err(invalid("单元格索引顺序无效"));
                    }
                    let across = index(tag, b"MergeAcross", 0, COLS - 1)?;
                    let end_column = column
                        .checked_add(across)
                        .filter(|n| *n <= COLS)
                        .ok_or_else(|| invalid("合并单元格范围无效"))?;
                    let style = attr(tag, b"StyleID")?.unwrap_or_else(|| {
                        if !row_style.is_empty() {
                            row_style.clone()
                        } else {
                            columns
                                .iter()
                                .rev()
                                .find(|(a, b, _)| (*a..=*b).contains(&column))
                                .map(|(_, _, s)| s.clone())
                                .unwrap_or_default()
                        }
                    });
                    cell = Some(Cell {
                        column,
                        end_column,
                        style,
                        kind: "String".into(),
                        value: String::new(),
                        has_data: false,
                        formula: attr(tag, b"Formula")?.is_some(),
                    });
                    next_column = end_column + 1;
                }
                b"Data" if cell.is_some() => {
                    let cell = cell.as_mut().unwrap();
                    cell.kind = attr(tag, b"Type")?.unwrap_or_else(|| "String".into());
                    cell.has_data = true;
                    data = !empty;
                }
                _ => {}
            },
            Event::End(tag) if ss => match tag.local_name().as_ref() {
                b"Data" => data = false,
                b"Table" => table = false,
                b"Worksheet" if wanted => {
                    return Err(AppError::new(DONE, "工作表读取完成。", false, None));
                }
                _ => {}
            },
            _ if data => {
                if let Some(text) = event_text(&event)? {
                    row_bytes = row_bytes.saturating_add(text.len());
                    if row_bytes > MAX_BYTES {
                        return Err(invalid("单行数据超过安全预算"));
                    }
                    cell.as_mut().unwrap().value.push_str(&text);
                }
            }
            _ => {}
        }
        let closing = match &event {
            Event::End(tag) => Some(tag.local_name().as_ref().to_vec()),
            Event::Empty(tag) if ss => Some(tag.local_name().as_ref().to_vec()),
            _ => None,
        };
        if let Some(tag) = closing {
            if tag == b"Cell" && ss {
                if let Some(cell) = cell.take() {
                    let values = row.as_mut().ok_or_else(|| invalid("单元格不在行内"))?;
                    values.resize(cell.end_column, Data::Empty);
                    values[cell.column - 1] = cell_data(&cell, &catalog)?;
                    row_bytes = row_bytes.saturating_add((cell.end_column - cell.column + 1) * 32);
                    if row_bytes > MAX_BYTES {
                        return Err(invalid("单行数据超过安全预算"));
                    }
                }
            } else if tag == b"Row" && ss {
                if let Some(values) = row.take() {
                    cancelled(cancel)?;
                    visitor(values, row_number)?;
                }
            }
        }
        Ok(())
    });
    match result {
        Err(err) if err.code == DONE => Ok(()),
        other => other,
    }
}

/// Existing whole-workbook data readers use a native, values-only XLSX adapter.
/// The source identity keys the copy; previews never call this conversion.
pub(crate) fn data_copy(path: &Path) -> Result<PathBuf, AppError> {
    let key = crate::disk_table::fingerprint(path, "spreadsheetml-data-v1", 0, 0)?;
    let directory = crate::tabular::cache_root()?.join("tables/xml-data-v1");
    fs::create_dir_all(&directory).map_err(invalid)?;
    let output = directory.join(format!("{key}.xlsx"));
    if output.is_file() {
        if calamine::open_workbook_auto(&output).is_ok() {
            return Ok(output);
        }
        fs::remove_file(&output).map_err(invalid)?;
    }
    let partial = directory.join(format!("{key}-{}.partial.xlsx", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut book = rust_xlsxwriter::Workbook::new();
        let date_format = rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        for info in catalog(path)?.sheets {
            let mut sheet = book.new_worksheet_with_constant_memory();
            sheet.set_name(&info.name).map_err(invalid)?;
            if info.very_hidden {
                sheet.set_very_hidden(true);
            } else if info.hidden {
                sheet.set_hidden(true);
            }
            visit(path, &info.name, &AtomicBool::new(false), |values, row| {
                for (column, value) in values.into_iter().enumerate() {
                    let r = (row - 1) as u32;
                    let c = column as u16;
                    match value {
                        Data::String(text) => {
                            sheet.write_string(r, c, text).map_err(invalid)?;
                        }
                        Data::Float(n) => {
                            sheet.write_number(r, c, n).map_err(invalid)?;
                        }
                        Data::Bool(b) => {
                            sheet.write_boolean(r, c, b).map_err(invalid)?;
                        }
                        Data::DateTime(d) => {
                            let date = d
                                .as_datetime()
                                .ok_or_else(|| invalid("日期超出可读取范围"))?;
                            sheet
                                .write_datetime_with_format(r, c, &date, &date_format)
                                .map_err(invalid)?;
                        }
                        Data::Error(e) => {
                            sheet
                                .write_formula(
                                    r,
                                    c,
                                    rust_xlsxwriter::Formula::new("=0").set_result(e.to_string()),
                                )
                                .map_err(invalid)?;
                        }
                        Data::Empty => {}
                        _ => return Err(invalid("单元格类型无效")),
                    }
                }
                Ok(())
            })?;
            book.push_worksheet(sheet);
        }
        book.save(&partial).map_err(invalid)?;
        if key != crate::disk_table::fingerprint(path, "spreadsheetml-data-v1", 0, 0)? {
            return Err(invalid("读取期间源文件发生变化，请重新读取"));
        }
        // Concurrent workers publish identical identities. Never replace an open copy.
        match fs::rename(&partial, &output) {
            Ok(()) => {}
            Err(_) if output.is_file() => {
                fs::remove_file(&partial).map_err(invalid)?;
            }
            Err(e) => return Err(invalid(e)),
        }
        Ok(output)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader;

    fn workbook(body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><s:Workbook xmlns:s="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:h="http://www.w3.org/TR/REC-html40">{body}</s:Workbook>"#
        )
    }
    fn source(body: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("export.XLS");
        fs::write(&path, workbook(body)).unwrap();
        (root, path)
    }
    fn values(path: &Path) -> Vec<Vec<Data>> {
        let mut rows = Vec::new();
        visit(path, "账表", &AtomicBool::new(false), |row, _| {
            rows.push(row);
            Ok(())
        })
        .unwrap();
        rows
    }

    #[test]
    fn spreadsheetml_sparse_typed_cells_dates_and_cached_formulas() {
        let (_root, path) = source(
            r#"<s:Styles><s:Style s:ID="d"><s:NumberFormat s:Format="Short Date"/></s:Style><s:Style s:ID="inherited" s:Parent="d"/></s:Styles>
          <s:Worksheet s:Name="账表"><s:Table><s:Row s:Index="3">
          <s:Cell s:Index="2" s:MergeAcross="1"><s:Data s:Type="String"> 001 &amp; &lt;甲&gt;<![CDATA[\原文]]><h:B>富文本</h:B>&#10;末尾 </s:Data></s:Cell>
          <s:Cell><s:Data s:Type="Number">123.50</s:Data></s:Cell>
          <s:Cell><s:Data s:Type="DateTime">2026-10-26T00:00:00.000</s:Data></s:Cell>
          <s:Cell s:StyleID="inherited"><s:Data s:Type="Number">46321</s:Data></s:Cell>
          <s:Cell s:Formula="=RC[-3]*2"><s:Data s:Type="Number">247</s:Data></s:Cell>
          <s:Cell><s:Data s:Type="Boolean">1</s:Data></s:Cell>
          <s:Cell><s:Data s:Type="Error">#DIV/0!</s:Data></s:Cell></s:Row><s:Row/></s:Table></s:Worksheet>"#,
        );
        let rows = values(&path);
        assert_eq!(rows.len(), 4);
        assert!(rows[0].is_empty() && rows[1].is_empty());
        assert_eq!(
            rows[2][1],
            Data::String(" 001 & <甲>\\原文富文本\n末尾 ".into())
        );
        assert_eq!(rows[2][2], Data::Empty);
        assert_eq!(rows[2][3], Data::Float(123.5));
        assert_eq!(crate::fx::data_text(&rows[2][4]), "2026-10-26 00:00:00");
        assert!(matches!(rows[2][5], Data::DateTime(_)));
        assert_eq!(rows[2][6], Data::Float(247.));
        assert_eq!(rows[2][7], Data::Bool(true));
        assert_eq!(rows[2][8], Data::Error(calamine::CellErrorType::Div0));
        let mut adapted = crate::spreadsheet_input::open_workbook_auto(&path).unwrap();
        let range = adapted.worksheet_range("账表").unwrap();
        for (column, value) in rows[2].iter().enumerate() {
            assert_eq!(
                range.get_value((2, column as u32)).unwrap_or(&Data::Empty),
                value,
                "column {column}"
            );
        }
    }

    #[test]
    fn spreadsheetml_preview_stops_before_invalid_tail_full_read_rejects_it() {
        let (_root, path) = source(
            r#"<s:Worksheet s:Name="账表"><s:Table><s:Row><s:Cell><s:Data s:Type="String">编号</s:Data></s:Cell></s:Row><s:Row><s:Cell><s:Data s:Type="Number">broken</s:Data></s:Cell></s:Row></s:Table></s:Worksheet>"#,
        );
        assert_eq!(
            crate::disk_table::preview_source(&path, None, 1).unwrap().2,
            vec![vec!["编号"]]
        );
        assert!(visit(&path, "账表", &AtomicBool::new(false), |_, _| Ok(())).is_err());
        assert!(data_copy(&path).is_err());
        assert_eq!(
            crate::disk_table::preview_source(&path, None, 1)
                .unwrap()
                .2
                .len(),
            1
        );
        assert_eq!(
            visit(&path, "账表", &AtomicBool::new(true), |_, _| panic!())
                .unwrap_err()
                .code,
            "JOB_CANCELLED"
        );
        assert_eq!(
            sheets(&path, Some("不存在")).unwrap_err().code,
            "SHEET_NOT_FOUND"
        );
    }

    #[test]
    fn spreadsheetml_utf16_gbk_visibility_and_source_invalidation() {
        let (_root, path) = source(
            r#"<s:Worksheet s:Name="隐藏"><s:Table/><x:WorksheetOptions><x:Visible>SheetHidden</x:Visible></x:WorksheetOptions></s:Worksheet><s:Worksheet s:Name="账表"><s:Table><s:Row><s:Cell><s:Data s:Type="String">001中文</s:Data></s:Cell></s:Row></s:Table></s:Worksheet>"#,
        );
        let xml = fs::read_to_string(&path)
            .unwrap()
            .replace("encoding=\"UTF-8\"", "encoding=\"UTF-16\"");
        let mut bytes = vec![0xff, 0xfe];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&path, bytes).unwrap();
        assert!(crate::spreadsheet_input::is_xml_workbook(&path));
        assert_eq!(sheets(&path, None).unwrap().0, "账表");
        assert_eq!(
            crate::fa_sheet_pick::list_visible_sheets(&path).unwrap(),
            vec!["账表"]
        );
        assert_eq!(values(&path)[0][0], Data::String("001中文".into()));
        let old = data_copy(&path).unwrap();
        let changed = xml
            .replace("UTF-16", "GBK")
            .replace("001中文", "002新的中文");
        fs::write(&path, encoding_rs::GBK.encode(&changed).0.as_ref()).unwrap();
        assert_eq!(values(&path)[0][0], Data::String("002新的中文".into()));
        assert_ne!(old, data_copy(&path).unwrap());
    }

    #[test]
    fn spreadsheetml_rejects_invalid_indices_missing_formula_cache_and_truncation() {
        for body in [
            r#"<s:Row s:Index="0"/>"#,
            r#"<s:Row><s:Cell s:Index="0"/></s:Row>"#,
            r#"<s:Row><s:Cell s:Index="16384" s:MergeAcross="1"/></s:Row>"#,
            r#"<s:Row s:Index="1048577"/>"#,
            r#"<s:Row><s:Cell s:Formula="=1+1"/></s:Row>"#,
            r#"<s:Row/><s:Row s:Index="1"/>"#,
        ] {
            let (_root, path) = source(&format!(
                r#"<s:Worksheet s:Name="账表"><s:Table>{body}</s:Table></s:Worksheet>"#
            ));
            assert!(
                visit(&path, "账表", &AtomicBool::new(false), |_, _| Ok(())).is_err(),
                "{body}"
            );
        }
        let (_root, path) = source(r#"<s:Worksheet s:Name="账表"><s:Table>"#);
        assert!(catalog(&path).is_err());
        fs::write(&path, "<html><table/></html>").unwrap();
        assert!(!crate::spreadsheet_input::is_xml_workbook(&path));
        assert!(catalog(&path).is_err());
    }

    #[test]
    fn spreadsheetml_numeric_1904_dates_and_column_row_styles() {
        let (_root, path) = source(
            r#"<x:ExcelWorkbook><x:Date1904/></x:ExcelWorkbook><s:Styles><s:Style s:ID="d"><s:NumberFormat s:Format="yyyy-mm-dd"/></s:Style></s:Styles><s:Worksheet s:Name="账表"><s:Table><s:Column s:StyleID="d"/><s:Row><s:Cell><s:Data s:Type="Number">1</s:Data></s:Cell></s:Row><s:Row s:StyleID="d"><s:Cell s:Index="2"><s:Data s:Type="Number">2</s:Data></s:Cell></s:Row></s:Table></s:Worksheet>"#,
        );
        let rows = values(&path);
        assert_eq!(crate::fx::data_text(&rows[0][0]), "1904-01-02 00:00:00");
        assert_eq!(crate::fx::data_text(&rows[1][1]), "1904-01-03 00:00:00");
    }
}
