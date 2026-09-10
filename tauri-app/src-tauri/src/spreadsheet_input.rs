//! Shared spreadsheet content detection and strict streaming text decoding.
use crate::AppError;
use encoding_rs::{Encoding, GBK, UTF_8, UTF_16BE, UTF_16LE};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}
fn io_error(err: std::io::Error) -> AppError {
    error(
        "SPREADSHEET_READ_FAILED",
        &format!("无法读取表格文件：{err}"),
        None,
    )
}
fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}
pub(crate) fn text_delimiter(path: &Path, text: &str) -> u8 {
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("tsv"))
    {
        b'\t'
    } else {
        sniff_delimiter(text)
    }
}
pub(crate) fn read_rows(path: &Path) -> Result<Vec<Vec<String>>, AppError> {
    let mut rows = Vec::new();
    for_each_text_row(path, &AtomicBool::new(false), |row| {
        rows.push(row);
        Ok(())
    })?;
    Ok(rows)
}

/// 只读取文件开头的若干条记录，供超大文本表格识别表头和字段映射。
/// CSV 引号中的换行仍按一条记录处理；达到上限后立即停止，不扫描文件尾部。
pub(crate) fn read_rows_limited(path: &Path, limit: usize) -> Result<Vec<Vec<String>>, AppError> {
    let mut rows = Vec::with_capacity(limit);
    text_rows_with_budget(
        path,
        &AtomicBool::new(false),
        Some(8 * 1024 * 1024),
        Some(limit),
        |row| {
            rows.push(row);
            Ok(())
        },
    )?;
    Ok(rows)
}
pub(crate) fn text_metadata(path: &Path) -> Result<(String, char), AppError> {
    let (sample, encoding) = text_sample(path).map_err(io_error)?;
    Ok((
        encoding.name().to_owned(),
        text_delimiter(path, &encoding.decode(&sample).0) as char,
    ))
}

pub(crate) fn prefer_workbook(path: &Path) -> PathBuf {
    if !path.exists() && path.with_extension("xls").is_file() {
        path.with_extension("xls")
    } else {
        path.to_path_buf()
    }
}

pub(crate) fn text_range(path: &Path) -> Result<calamine::Range<calamine::Data>, AppError> {
    let rows = read_rows(path)?;
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if rows.is_empty() || width == 0 {
        return Ok(calamine::Range::empty());
    }
    let mut range = calamine::Range::new((0, 0), ((rows.len() - 1) as u32, (width - 1) as u32));
    for (r, row) in rows.into_iter().enumerate() {
        for (c, value) in row.into_iter().enumerate() {
            range.set_value((r as u32, c as u32), calamine::Data::String(value));
        }
    }
    Ok(range)
}

/// Format-preserving consumers need XLSX packages; derived files never replace inputs.
pub(crate) struct PreparedWorkbook {
    path: PathBuf,
    temporary_dir: Option<PathBuf>,
}
impl PreparedWorkbook {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}
impl Drop for PreparedWorkbook {
    fn drop(&mut self) {
        if let Some(dir) = &self.temporary_dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

pub(crate) fn prepare_xlsx(path: &Path) -> Result<PreparedWorkbook, AppError> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("xls"))
    {
        return Ok(PreparedWorkbook {
            path: path.to_path_buf(),
            temporary_dir: None,
        });
    }
    let dir = std::env::temp_dir()
        .join("AuditToolbox")
        .join("spreadsheet-input")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(io_error)?;
    let prepared = PreparedWorkbook {
        path: dir.join("input.xlsx"),
        temporary_dir: Some(dir),
    };
    if is_text(path) {
        let mut book = rust_xlsxwriter::Workbook::new();
        let mut sheet = book.new_worksheet_with_constant_memory();
        sheet
            .set_name("CSV")
            .map_err(|err| error("TEXT_XLS_CONVERT_FAILED", &err.to_string(), None))?;
        let mut row_number = 0u32;
        let mut sheet_number = 1;
        for_each_text_row(path, &AtomicBool::new(false), |row| {
            if row_number == 1_048_576 {
                let next = book.new_worksheet_with_constant_memory();
                book.push_worksheet(std::mem::replace(&mut sheet, next));
                sheet_number += 1;
                sheet
                    .set_name(format!("CSV_{sheet_number}"))
                    .map_err(|err| error("TEXT_XLS_CONVERT_FAILED", &err.to_string(), None))?;
                row_number = 0;
            }
            if row.len() > 16_384 {
                return Err(error(
                    "EXCEL_COLUMN_LIMIT",
                    "文本表格超过 Excel 最大列数，不能转换为工作簿。",
                    None,
                ));
            }
            for (col, value) in row.into_iter().enumerate() {
                sheet
                    .write_string(row_number, col as u16, value)
                    .map_err(|err| {
                        error(
                            "TEXT_XLS_CONVERT_FAILED",
                            &format!("{}：无法转换文本型 XLS（{err}）。", file_name(path)),
                            None,
                        )
                    })?;
            }
            row_number += 1;
            Ok(())
        })?;
        book.push_worksheet(sheet);
        book.save(&prepared.path)
            .map_err(|err| error("TEXT_XLS_CONVERT_FAILED", &err.to_string(), None))?;
    } else {
        // A ZIP workbook may merely have an XLS suffix; preserve its package verbatim.
        let mut magic = [0u8; 4];
        let mut input = fs::File::open(path).map_err(io_error)?;
        let read = input.read(&mut magic).map_err(io_error)?;
        if read >= 2 && magic.starts_with(b"PK") {
            fs::copy(path, &prepared.path).map_err(io_error)?;
        } else {
            crate::excel_com::convert_xls_to_xlsx(path, &prepared.path)?;
        }
    }
    Ok(prepared)
}
pub(crate) fn text_sample(path: &Path) -> std::io::Result<(Vec<u8>, &'static Encoding)> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(65_536).read_to_end(&mut bytes)?;
    let encoding = if bytes.starts_with(&[0xFF, 0xFE]) {
        UTF_16LE
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        UTF_16BE
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || match std::str::from_utf8(&bytes) {
            Ok(_) => true,
            Err(err) => err.error_len().is_none(), // sample may end inside a UTF-8 character
        }
    {
        UTF_8
    } else {
        GBK
    };
    Ok((bytes, encoding))
}

/// Fixed-size decode buffers keep GBK/UTF-16 text exports independent of file size.
struct DecodedText {
    input: BufReader<fs::File>,
    decoder: encoding_rs::Decoder,
    output: [u8; 32_768],
    start: usize,
    end: usize,
    finished: bool,
}

impl Read for DecodedText {
    fn read(&mut self, target: &mut [u8]) -> std::io::Result<usize> {
        if target.is_empty() {
            return Ok(0);
        }
        while self.start == self.end && !self.finished {
            let bytes = self.input.fill_buf()?;
            let last = bytes.is_empty();
            let (status, used, written, malformed) =
                self.decoder.decode_to_utf8(bytes, &mut self.output, last);
            self.input.consume(used);
            if malformed {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "文本编码无效或混杂，请重新导出为 UTF-8 文本",
                ));
            }
            self.start = 0;
            self.end = written;
            self.finished = last && status == encoding_rs::CoderResult::InputEmpty;
        }
        let count = target.len().min(self.end - self.start);
        target[..count].copy_from_slice(&self.output[self.start..self.start + count]);
        self.start += count;
        Ok(count)
    }
}

pub(crate) fn for_each_text_row(
    path: &Path,
    cancel: &AtomicBool,
    visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    text_rows_with_budget(path, cancel, None, None, visit)
}

pub(crate) fn for_each_text_row_bounded(
    path: &Path,
    cancel: &AtomicBool,
    max_record_bytes: usize,
    visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    text_rows_with_budget(path, cancel, Some(max_record_bytes), None, visit)
}

struct RecordBudget<R> {
    reader: R,
    used: std::rc::Rc<std::cell::Cell<usize>>,
    limit: usize,
}
impl<R: Read> Read for RecordBudget<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.used.get() >= self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "CSV 单行超过安全预算，请检查异常长字段或缺失引号",
            ));
        }
        let len = bytes.len().min(self.limit - self.used.get());
        let read = self.reader.read(&mut bytes[..len])?;
        self.used.set(self.used.get() + read);
        Ok(read)
    }
}

fn text_rows_with_budget(
    path: &Path,
    cancel: &AtomicBool,
    max_record_bytes: Option<usize>,
    row_limit: Option<usize>,
    mut visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let (sample, encoding) = text_sample(path).map_err(io_error)?;
    let delimiter = text_delimiter(path, &encoding.decode(&sample).0);
    let decoded = DecodedText {
        input: BufReader::new(fs::File::open(path).map_err(io_error)?),
        decoder: encoding.new_decoder(),
        output: [0; 32_768],
        start: 0,
        end: 0,
        finished: false,
    };
    let used = std::rc::Rc::new(std::cell::Cell::new(0));
    let bounded = RecordBudget {
        reader: decoded,
        used: used.clone(),
        limit: max_record_bytes.unwrap_or(usize::MAX),
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(bounded);
    for (index, record) in reader.records().enumerate() {
        if row_limit.is_some_and(|limit| index >= limit) {
            break;
        }
        if index % 1000 == 0 {
            check_cancel(cancel)?;
        }
        let record = record.map_err(|err| {
            error(
                "TEXT_READ_FAILED",
                &format!("{}：文本读取失败（{}）。", file_name(path), err),
                None,
            )
        })?;
        visit(record.iter().map(str::to_owned).collect())?;
        used.set(0);
    }
    Ok(())
}

pub(crate) fn sniff_delimiter(text: &str) -> u8 {
    let first = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    [
        (b',', first.matches(',').count()),
        (b'\t', first.matches('\t').count()),
        (b';', first.matches(';').count()),
        (b'|', first.matches('|').count()),
    ]
    .into_iter()
    .max_by_key(|(_, count)| *count)
    .filter(|(_, count)| *count > 0)
    .map(|(value, _)| value)
    .unwrap_or(b',')
}

pub(crate) fn is_text(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "csv" | "txt" | "tsv") {
        return true;
    }
    if extension != "xls" {
        return false;
    }
    let Ok((sample, encoding)) = text_sample(path) else {
        return false;
    };
    // Never reinterpret OLE/ZIP workbooks or HTML/XML exports as delimited text.
    if sample.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) || sample.starts_with(b"PK") {
        return false;
    }
    let (text, _, _) = encoding.decode(&sample);
    let text = text.trim_start_matches('\u{feff}').trim_start();
    if text.starts_with('<')
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
    {
        return false;
    }
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let first = lines.next().unwrap_or("");
    let delimiter = sniff_delimiter(first) as char;
    // Also accept header-only tables and single-column exports (e.g. a name list).
    first.contains(delimiter) || lines.next().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limited_text_read_stops_after_complete_csv_records() {
        let root =
            std::env::temp_dir().join(format!("spreadsheet-limited-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.csv");
        fs::write(
            &path,
            "凭证号,摘要,金额\n1,第一行,1\n2,\"跨行\n摘要\",2\n3,第三行,3\n",
        )
        .unwrap();
        let rows = read_rows_limited(&path, 3).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2], ["2", "跨行\n摘要", "2"]);
        fs::remove_dir_all(root).unwrap();
    }
}
