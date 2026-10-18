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

/// 只读文件开头若干行（不带单行字节预算），供合并预览在超大文本上
/// 秒级取表头：几 GB 的台账也只扫到凑满 `limit` 行为止。
pub(crate) fn read_rows_head(
    path: &Path,
    limit: usize,
) -> Result<(Vec<Vec<String>>, TextReadReport), AppError> {
    let mut rows = Vec::with_capacity(limit);
    let report = text_rows_with_budget(
        path,
        &AtomicBool::new(false),
        None,
        Some(limit),
        |row| {
            rows.push(row);
            Ok(())
        },
    )?;
    Ok((rows, report))
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
    /// 解码器替换出的 U+FFFD 个数（编码瑕疵的留痕，供调用方转成警告）。
    replaced: std::rc::Rc<std::cell::Cell<u64>>,
    /// 实际扫描过的原始字节数。行数受限的读取只扫文件头部，
    /// 防误判阈值必须与扫过的量比，不能与整个文件大小比。
    bytes_in: std::rc::Rc<std::cell::Cell<u64>>,
}

impl Read for DecodedText {
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
            // WHATWG 解码器遇到非法序列会输出 U+FFFD 并继续（不再像过去那样
            // 整个文件判死）——源系统导出常见的「个别字符编码不出被写坏」
            // 只伤及那一小段，其余几百万行照常可用。替换处会记数，读完后
            // 由 [`text_rows_with_budget`] 判断是零星瑕疵还是编码判断错了。
            let (status, used, written, _malformed) =
                self.decoder.decode_to_utf8(bytes, &mut self.output, last);
            self.input.consume(used);
            let replaced = count_replacement_chars(&self.output[..written]);
            self.replaced
                .set(self.replaced.get().saturating_add(replaced));
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

fn count_replacement_chars(bytes: &[u8]) -> u64 {
    let mut count = 0u64;
    let mut i = 0usize;
    while i + 3 <= bytes.len() {
        if bytes[i] == 0xEF && bytes[i + 1] == 0xBF && bytes[i + 2] == 0xBD {
            count += 1;
            i += 3;
        } else {
            i += 1;
        }
    }
    count
}

/// 文本读取的留痕：源文件里有多少字符按检测编码解不出来、被替换成了 U+FFFD。
/// 零星替换（源系统导出瑕疵）照常出数据；大面积替换仍按编码错误报错。
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct TextReadReport {
    pub(crate) replaced_chars: u64,
}

pub(crate) fn for_each_text_row(
    path: &Path,
    cancel: &AtomicBool,
    visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    text_rows_with_budget(path, cancel, None, None, visit).map(|_| ())
}

/// 与 [`for_each_text_row`] 相同，额外返回替换留痕，供合并结果转成用户可见的警告。
pub(crate) fn for_each_text_row_reported(
    path: &Path,
    cancel: &AtomicBool,
    visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<TextReadReport, AppError> {
    text_rows_with_budget(path, cancel, None, None, visit)
}

pub(crate) fn for_each_text_row_bounded(
    path: &Path,
    cancel: &AtomicBool,
    max_record_bytes: usize,
    visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    text_rows_with_budget(path, cancel, Some(max_record_bytes), None, visit).map(|_| ())
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

/// csv 默认跳过完全空白的记录。只在引号外的空行补入空字段，保持表格行号，
/// 引号内换行、转义双引号和 CRLF 都原样交给 CSV 解析器。
struct EmptyRecords<R: Read> {
    reader: BufReader<R>,
    state: u8, // 0 字段起点，1 普通字段，2 引号内，3 闭引号之后
    empty: bool,
    cr: bool,
    pending: [u8; 3],
    pending_start: usize,
    pending_end: usize,
    delimiter: u8,
}
impl<R: Read> EmptyRecords<R> {
    fn new(reader: R, delimiter: u8) -> Self {
        Self { reader: BufReader::new(reader), state: 0, empty: true, cr: false,
            pending: [0;3], pending_start: 0, pending_end: 0, delimiter }
    }
}
impl<R: Read> Read for EmptyRecords<R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let mut written=0;
        while written < output.len() {
            if self.pending_start < self.pending_end {
                output[written]=self.pending[self.pending_start];
                self.pending_start+=1;written+=1;continue;
            }
            let buffer=self.reader.fill_buf()?;
            let Some(&byte)=buffer.first() else {break;};
            self.reader.consume(1);
            let newline=matches!(byte,b'\r'|b'\n') && self.state!=2;
            let continuation=byte==b'\n' && self.cr;
            self.cr=byte==b'\r' && newline;
            let insert=newline && self.empty && !continuation;
            if newline {self.empty=true;self.state=0;}
            else {
                self.empty=false;
                self.state=match (self.state,byte) {
                    (0,b'"')=>2,(2,b'"')=>3,(3,b'"')=>2,
                    (2,_)=>2,(_,b) if b==self.delimiter=>0,_=>1,
                };
            }
            self.pending_start=0;
            if insert {self.pending=[b'"',b'"',byte];self.pending_end=3;}
            else {self.pending[0]=byte;self.pending_end=1;}
        }
        Ok(written)
    }
}

fn text_rows_with_budget(
    path: &Path,
    cancel: &AtomicBool,
    max_record_bytes: Option<usize>,
    row_limit: Option<usize>,
    mut visit: impl FnMut(Vec<String>) -> Result<(), AppError>,
) -> Result<TextReadReport, AppError> {
    let (sample, encoding) = text_sample(path).map_err(io_error)?;
    let delimiter = text_delimiter(path, &encoding.decode(&sample).0);
    let replaced = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let bytes_in = std::rc::Rc::new(std::cell::Cell::new(0u64));
    let decoded = DecodedText {
        input: BufReader::new(fs::File::open(path).map_err(io_error)?),
        decoder: encoding.new_decoder(),
        output: [0; 32_768],
        start: 0,
        end: 0,
        finished: false,
        replaced: replaced.clone(),
        bytes_in: bytes_in.clone(),
    };
    let used = std::rc::Rc::new(std::cell::Cell::new(0));
    let bounded = RecordBudget {
        reader: EmptyRecords::new(decoded, delimiter),
        used: used.clone(),
        limit: max_record_bytes.unwrap_or(usize::MAX),
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(bounded);
    for (index, record) in reader.records().take(row_limit.unwrap_or(usize::MAX)).enumerate() {
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
    let report = TextReadReport {
        replaced_chars: replaced.get(),
    };
    // 替换个数与实际扫描字节数比过高说明不是零星导出瑕疵，而是编码判断
    // 错了（典型如无 BOM 的 UTF-16 被当 GBK，几乎每个字都会替换）——
    // 这种情况读出来的行是乱码，宁可报错也不让乱数据混进底稿。
    if report.replaced_chars > 0 && report.replaced_chars > bytes_in.get() / 8 {
        return Err(error(
            "TEXT_ENCODING_INVALID",
            &format!(
                "{}：文本编码无效或疑似判断错误，请重新导出为 UTF-8 文本。",
                file_name(path)
            ),
            None,
        ));
    }
    Ok(report)
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

    #[test]
    fn text_empty_records_keep_table_rows_without_splitting_quoted_newlines() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("空行.csv");
        fs::write(&path,"\r\n编号,摘要\r\n\r\n1,\"跨行\r\n\r\n与\"\"双引号\"\"\"\r\n\r\n2,末行\r\n\r\n").unwrap();
        let rows=read_rows(&path).unwrap();
        assert_eq!(rows,vec![vec![""],vec!["编号","摘要"],vec![""],vec!["1","跨行\r\n\r\n与\"双引号\""],vec![""],vec!["2","末行"],vec![""]]);
        assert_eq!(read_rows_limited(&path,3).unwrap(),rows[..3]);
        let mut utf16=vec![0xff,0xfe];for unit in "标题\n\n正文\n".encode_utf16(){utf16.extend_from_slice(&unit.to_le_bytes());}
        fs::write(&path,utf16).unwrap();assert_eq!(read_rows(&path).unwrap(),vec![vec!["标题"],vec![""],vec!["正文"]]);
    }

    /// 真实场景：超大 GBK 台账中段混有导出时写坏的孤立字节（如 0xB1 后跟
    /// ASCII '?'）。零星瑕疵只替换为 U+FFFD 并留痕计数，不再整档报错。
    #[test]
    fn sparse_bad_gbk_bytes_are_replaced_with_report() {
        let root =
            std::env::temp_dir().join(format!("spreadsheet-sparse-bad-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("台账.csv");
        // "地址," 的 GBK 编码 + 坏字节 0xB1（后跟 ',' 非法尾字节）+ 正常行。
        let mut bytes = GBK.encode("摘要,地址\n正常行,雅加达\n").0.into_owned();
        bytes.extend_from_slice(&GBK.encode("带瑕疵,").0);
        bytes.push(0xB1);
        bytes.extend_from_slice(b",tail\n");
        fs::write(&path, bytes).unwrap();
        let cancel = AtomicBool::new(false);
        let report = for_each_text_row_reported(&path, &cancel, |_| Ok(())).unwrap();
        assert_eq!(report.replaced_chars, 1);
        let mut rows = Vec::new();
        for_each_text_row(&path, &cancel, |row| {
            rows.push(row);
            Ok(())
        })
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[2][1], "\u{FFFD}");
        assert_eq!(rows[2][2], "tail");
        fs::remove_dir_all(root).unwrap();
    }

    /// 大面积解码替换说明编码判断错了（如无 BOM 的 UTF-16 被当 GBK），
    /// 仍要报错，不能让整档乱码混进结果。
    #[test]
    fn dense_corruption_still_errors() {
        let root =
            std::env::temp_dir().join(format!("spreadsheet-dense-bad-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("乱码.csv");
        let mut bytes = GBK.encode("摘要,地址\n").0.into_owned();
        bytes.extend(std::iter::repeat(0xFF).take(64 * 1024));
        fs::write(&path, bytes).unwrap();
        let err =
            for_each_text_row_reported(&path, &AtomicBool::new(false), |_| Ok(()))
                .unwrap_err();
        assert_eq!(err.code, "TEXT_ENCODING_INVALID");
        fs::remove_dir_all(root).unwrap();
    }

    /// 只读文件开头的预览读取：凑满行数即停，文件尾部的内容（包括坏字节）
    /// 根本不会被扫描——几 GB 的台账识别表头保持秒级。
    #[test]
    fn head_read_stops_before_tail_trouble() {
        let root =
            std::env::temp_dir().join(format!("spreadsheet-head-stop-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("大台账.csv");
        let mut bytes = GBK.encode("摘要,地址\n").0.into_owned();
        // 600 行 × 约 32 字节 ≈ 19KB，远超 csv 读取器 8KB 的缓冲窗口。
        for i in 0..600 {
            bytes.extend_from_slice(&GBK.encode(&format!("行{i}，张三丰的往来款说明文字\n")).0);
        }
        // 尾部埋一颗坏字节：全文扫描会替换并计数，早停读法则根本看不到。
        bytes.push(0xB1);
        bytes.push(b',');
        bytes.extend_from_slice(b"end\n");
        fs::write(&path, bytes).unwrap();
        let (rows, report) = read_rows_head(&path, 5).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[4][0], "行3，张三丰的往来款说明文字");
        assert_eq!(report.replaced_chars, 0);
        fs::remove_dir_all(root).unwrap();
    }
}
