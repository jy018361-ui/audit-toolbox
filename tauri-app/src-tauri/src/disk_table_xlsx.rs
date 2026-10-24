//! OOXML row stream with a disk shared-string dictionary. Opening calamine's
//! Xlsx cell stream alone still materializes every shared string in memory.
use super::*;
use quick_xml::{
    Reader as XmlReader,
    events::{BytesStart, Event},
};
use std::io::{BufRead, BufReader};
use std::collections::{HashMap, VecDeque};

/// Keep one read snapshot and prepared lookup for the sheet, rather than
/// opening a SQLite read transaction and compiling SQL for every string cell.
/// Repeated account/entity labels stay in a bounded cache; unique summaries
/// spill through the dictionary without growing with the workbook.
struct SharedStringReader<'a> {
    lookup: rusqlite::Statement<'a>,
    values: HashMap<u64, String>,
    order: VecDeque<u64>,
    bytes: usize,
}
impl<'a> SharedStringReader<'a> {
    const CACHE_BYTES: usize = 8 * 1024 * 1024;
    const CACHE_ENTRIES: usize = 65_536;

    fn new(db: &'a Connection) -> Result<Self, AppError> {
        db.execute_batch("BEGIN DEFERRED").map_err(sql)?;
        Ok(Self {
            lookup: db.prepare("SELECT value FROM strings WHERE id=?1").map_err(sql)?,
            values: HashMap::new(), order: VecDeque::new(), bytes: 0,
        })
    }

    fn get(&mut self, id: u64) -> Result<String, AppError> {
        if let Some(value) = self.values.get(&id) { return Ok(value.clone()); }
        let value: String = self.lookup.query_row([id], |row| row.get(0)).map_err(sql)?;
        let cost = value.len().saturating_add(96);
        if cost <= Self::CACHE_BYTES {
            while self.bytes.saturating_add(cost) > Self::CACHE_BYTES || self.values.len() >= Self::CACHE_ENTRIES {
                let Some(old) = self.order.pop_front() else { break; };
                if let Some(value) = self.values.remove(&old) { self.bytes -= value.len() + 96; }
            }
            self.bytes += cost;
            self.order.push_back(id);
            self.values.insert(id, value.clone());
        }
        Ok(value)
    }
}

/// Limit bytes consumed by each XML event before quick-xml expands its buffer.
struct TokenBudget<'a, R: Read> {
    input: BufReader<R>,
    used: std::rc::Rc<std::cell::Cell<usize>>,
    cancel: &'a AtomicBool,
}
impl<R: Read> BufRead for TokenBudget<'_, R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                // quick-xml retries Interrupted indefinitely; cancellation is
                // terminal and is mapped back to JOB_CANCELLED by stream_error.
                std::io::ErrorKind::Other,
                "任务已取消。",
            ));
        }
        let left = (MAX_ROW_BYTES + 4096).saturating_sub(self.used.get());
        if left == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "XML 单个记录超过安全预算",
            ));
        }
        let bytes = self.input.fill_buf()?;
        Ok(&bytes[..bytes.len().min(left)])
    }
    fn consume(&mut self, amount: usize) {
        self.used.set(self.used.get().saturating_add(amount));
        self.input.consume(amount);
    }
}
impl<R: Read> Read for TokenBudget<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let bytes = self.fill_buf()?;
        let count = output.len().min(bytes.len());
        output[..count].copy_from_slice(&bytes[..count]);
        self.consume(count);
        Ok(count)
    }
}
fn reader<'a, R: Read>(
    input: R,
    cancel: &'a AtomicBool,
) -> (
    XmlReader<TokenBudget<'a, R>>,
    std::rc::Rc<std::cell::Cell<usize>>,
) {
    let used = std::rc::Rc::new(std::cell::Cell::new(0));
    (
        XmlReader::from_reader(TokenBudget {
            input: BufReader::new(input),
            used: used.clone(),
            cancel,
        }),
        used,
    )
}
fn stream_error(e: impl ToString, cancel: &AtomicBool) -> AppError {
    if cancel.load(Ordering::Relaxed) {
        failure("JOB_CANCELLED", "任务已取消。", "")
    } else {
        io(e)
    }
}

// Match calamine's single-pass Excel escape decoding. In particular the
// escaped literal `_x005F_x000D_` must stay `_x000D_`, rather than becoming CR.
fn excel_text(text: &str, preserve: bool) -> String {
    let text = if preserve {
        text
    } else {
        text.trim_matches([' ', '\t', '\r', '\n'])
    };
    let mut output = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let b = text.as_bytes();
        if i + 7 <= b.len() && &b[i..i + 4] == b"_x00" && b[i + 6] == b'_' {
            if let Ok(n) = u8::from_str_radix(&text[i + 4..i + 6], 16) {
                output.push(n as char);
                i += 7;
                continue;
            }
        }
        let c = text[i..].chars().next().expect("已检查字符范围");
        output.push(c);
        i += c.len_utf8();
    }
    output
}
fn physical_row(start: &BytesStart<'_>, next: usize) -> Result<usize, AppError> {
    let row = attr(start, b"r")?
        .map(|value| value.parse::<usize>().map_err(io))
        .transpose()?
        .unwrap_or(next);
    if row < next || row > 1_048_576 {
        return Err(failure(
            "XLSX_ROW_INVALID",
            "工作表行号无效或顺序异常，请重新导出文件。",
            row,
        ));
    }
    Ok(row)
}

fn attr(start: &BytesStart<'_>, key: &[u8]) -> Result<Option<String>, AppError> {
    for a in start.attributes() {
        let a = a.map_err(io)?;
        if a.key.local_name().as_ref() == key {
            return Ok(Some(
                quick_xml::escape::unescape(std::str::from_utf8(&a.value).map_err(io)?)
                    .map_err(io)?
                    .into_owned(),
            ));
        }
    }
    Ok(None)
}
fn decoded(text: &quick_xml::events::BytesText<'_>) -> Result<String, AppError> {
    let value = text
        .xml_content(quick_xml::XmlVersion::Implicit1_0)
        .map_err(io)?;
    Ok(quick_xml::escape::unescape(&value)
        .map_err(io)?
        .into_owned())
}
fn reference(text: &quick_xml::events::BytesRef<'_>) -> Result<String, AppError> {
    let name = text.decode().map_err(io)?;
    Ok(quick_xml::escape::unescape(&format!("&{name};"))
        .map_err(io)?
        .into_owned())
}
/// 磁盘分流前的体量估算素材：每张工作表的 (表名, 未压缩 XML 字节, 维度行列)
/// 与共享字符串未压缩字节。只读各表文件头部的 dimension 标签，不解析单元格。
pub(super) fn shapes(
    path: &Path,
) -> Option<(Vec<(String, u64, Option<(u64, u64)>)>, u64)> {
    let entries = crate::fx::xlsx_sheet_entries(path).ok()?;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).ok()?).ok()?;
    let shared = zip
        .by_name("xl/sharedStrings.xml")
        .map(|entry| entry.size())
        .unwrap_or(0);
    let mut sheets = Vec::with_capacity(entries.len());
    for (name, entry) in entries {
        let mut file = zip.by_name(&entry).ok()?;
        let xml = file.size();
        let mut head = vec![0u8; 8192];
        let read = file.read(&mut head).ok()?;
        head.truncate(read);
        sheets.push((name, xml, dimension(&head)));
    }
    Some((sheets, shared))
}

/// 稠密生成器都在工作表头部写 dimension；缺失或数值离谱时返回 None，
/// 由调用方回退旧口径，不在此猜测。
fn dimension(head: &[u8]) -> Option<(u64, u64)> {
    let text = std::str::from_utf8(head).ok()?;
    let tag = text.find("dimension")?;
    let rest = &text[tag..];
    let value = rest.find("ref=")? + 4;
    let rest = &rest[value..];
    if !rest.starts_with('"') {
        return None;
    }
    let end = rest[1..].find('"')? + 1;
    let reference = &rest[1..end];
    let (_, last) = reference.split_once(':').unwrap_or(("", reference));
    let rows: u64 = last
        .trim_start_matches(|c: char| c.is_ascii_alphabetic())
        .parse()
        .ok()?;
    let cols = column(last)? as u64 + 1;
    if rows == 0 || rows > 1_048_576 || cols == 0 || cols > 16_384 {
        return None;
    }
    Some((rows, cols))
}

pub(super) fn sheets(path: &Path, wanted: Option<&str>) -> Result<(String, Vec<String>), AppError> {
    let entries = crate::fx::xlsx_sheet_entries(path)?;
    let all = entries
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if let Some(name) = wanted.filter(|n| !n.trim().is_empty()) {
        return if all.iter().any(|v| v == name) {
            Ok((name.into(), all))
        } else {
            Err(failure(
                "SHEET_NOT_FOUND",
                "指定的工作表已不存在，请重新选择。",
                name,
            ))
        };
    }
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(io)?).map_err(io)?;
    let entry = zip.by_name("xl/workbook.xml").map_err(io)?;
    let cancel = AtomicBool::new(false);
    let (mut reader, token_bytes) = reader(entry, &cancel);
    let mut buf = Vec::new();
    loop {
        token_bytes.set(0);
        match reader.read_event_into(&mut buf).map_err(io)? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref() == b"sheet" => {
                if attr(&e, b"state")?.is_none_or(|s| s == "visible") {
                    if let Some(name) = attr(&e, b"name")? {
                        return Ok((name, all));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    all.first()
        .cloned()
        .map(|first| (first, all))
        .ok_or_else(|| io("工作簿没有工作表"))
}
fn dictionary(path: &Path, cancel: &AtomicBool) -> Result<Option<Connection>, AppError> {
    check(cancel)?;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(io)?).map_err(io)?;
    let entry = match zip.by_name("xl/sharedStrings.xml") {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(io(e)),
    };
    let key = fingerprint(path, "shared-strings", 1, 1)?;
    let root = crate::tabular::cache_root()?.join("tables/shared-v2");
    fs::create_dir_all(&root).map_err(io)?;
    let output = root.join(format!("{key}.sqlite"));
    let connect = |p: &Path| -> Result<Connection, AppError> {
        let db = Connection::open(p).map_err(sql)?;
        db.execute_batch("PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;").map_err(sql)?;
        Ok(db)
    };
    if output.is_file() {
        if let Ok(db) = connect(&output) {
            let expected = db.query_row("SELECT count FROM meta WHERE done=1", [], |r| {
                r.get::<_, u64>(0)
            });
            let actual = db.query_row("SELECT COUNT(*) FROM strings", [], |r| r.get::<_, u64>(0));
            if let (Ok(expected), Ok(actual)) = (expected, actual) {
                if expected == actual {
                    return Ok(Some(db));
                }
            }
        }
    }
    crate::resource_budget::check_disk_space(&root, entry.size().saturating_mul(2))?;
    let partial = output.with_extension(format!("{}.partial", uuid::Uuid::new_v4()));
    let build = (|| {
        let mut db = connect(&partial)?;
        db.execute_batch("CREATE TABLE strings(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE meta(done INTEGER NOT NULL,count INTEGER NOT NULL);").map_err(sql)?;
        let tx = db.transaction().map_err(sql)?;
        let mut insert = tx
            .prepare("INSERT INTO strings VALUES (?1,?2)")
            .map_err(sql)?;
        let (mut reader, token_bytes) = reader(entry, cancel);
        let mut buf = Vec::new();
        let mut value = String::new();
        let mut text = String::new();
        let mut preserve = false;
        let mut index = 0_u64;
        let mut capture = false;
        let mut phonetic = false;
        loop {
            token_bytes.set(0);
            match reader
                .read_event_into(&mut buf)
                .map_err(|e| stream_error(e, cancel))?
            {
                Event::Start(e) => match e.local_name().as_ref() {
                    b"si" => value.clear(),
                    b"t" => {
                        capture = !phonetic;
                        text.clear();
                        preserve = attr(&e, b"space")?.as_deref() == Some("preserve");
                    }
                    b"rPh" => phonetic = true,
                    _ => {}
                },
                Event::Text(e) if capture => text.push_str(&decoded(&e)?),
                Event::GeneralRef(e) if capture => text.push_str(&reference(&e)?),
                Event::CData(e) if capture => text.push_str(
                    &e.xml_content(quick_xml::XmlVersion::Implicit1_0)
                        .map_err(io)?,
                ),
                Event::End(e) => match e.local_name().as_ref() {
                    b"t" => {
                        if capture {
                            value.push_str(&excel_text(&text, preserve));
                        }
                        text.clear();
                        capture = false;
                    }
                    b"rPh" => phonetic = false,
                    b"si" => {
                        insert.execute(params![index, value]).map_err(sql)?;
                        index += 1;
                        if index % 256 == 0 {
                            check(cancel)?;
                        }
                    }
                    _ => {}
                },
                Event::Empty(e) if e.local_name().as_ref() == b"si" => {
                    insert.execute(params![index, ""]).map_err(sql)?;
                    index += 1;
                    if index % 256 == 0 {
                        check(cancel)?;
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            if value.len().saturating_add(text.len()) > MAX_ROW_BYTES || buf.len() > MAX_ROW_BYTES {
                return Err(failure(
                    "TABLE_ROW_TOO_LARGE",
                    "单个文本超过安全预算，请检查异常长字段。",
                    index,
                ));
            }
            buf.clear();
        }
        check(cancel)?;
        drop(insert);
        tx.execute("INSERT INTO meta VALUES (1,?1)", [index])
            .map_err(sql)?;
        tx.commit().map_err(sql)?;
        drop(db);
        if fingerprint(path, "shared-strings", 1, 1)? != key {
            return Err(failure(
                "SOURCE_CHANGED",
                "读取期间源文件发生变化，请重新读取。",
                "",
            ));
        }
        crate::tabular::replace_file(&partial, &output)?;
        connect(&output).map(Some)
    })();
    if build.is_err() {
        let _ = fs::remove_file(&partial);
    }
    build
}
fn column(reference: &str) -> Option<usize> {
    let mut value = 0_usize;
    let mut seen = false;
    for c in reference.bytes().take_while(u8::is_ascii_alphabetic) {
        seen = true;
        value = value
            .checked_mul(26)?
            .checked_add((c.to_ascii_uppercase() - b'A' + 1) as usize)?;
    }
    seen.then(|| value - 1)
}
fn cell_value(
    raw: &str,
    kind: &str,
    style: usize,
    dates: &HashSet<usize>,
    epoch: bool,
    preserve_excel_dates: bool,
    strings: Option<&mut SharedStringReader<'_>>,
) -> Result<String, AppError> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    match kind {
        "s" => {
            let id = raw.parse::<u64>().map_err(io)?;
            strings
                .ok_or_else(|| io("共享文本表缺失"))?
                .get(id)
        }
        "b" => Ok((raw != "0").to_string()),
        "inlineStr" | "is" | "str" | "d" => Ok(raw.into()),
        "e" => Ok(match raw {
            "#DIV/0!" => "Div0",
            "#N/A" => "NA",
            "#NAME?" => "Name",
            "#NULL!" => "Null",
            "#NUM!" => "Num",
            "#REF!" => "Ref",
            "#VALUE!" => "Value",
            "#GETTING_DATA" => "GettingData",
            _ => raw,
        }
        .into()),
        _ => {
            if raw.is_empty() {
                return Ok(String::new());
            }
            let n = match raw.parse::<f64>() {
                Ok(n) => n,
                Err(_) if kind.is_empty() => return Ok(raw.into()),
                Err(e) => return Err(io(e)),
            };
            if dates.contains(&style) && preserve_excel_dates {
                return Ok(n.to_string());
            }
            let value = if dates.contains(&style) {
                calamine::Data::DateTime(calamine::ExcelDateTime::new(
                    n,
                    calamine::ExcelDateTimeType::DateTime,
                    epoch,
                ))
            } else {
                calamine::Data::Float(n)
            };
            Ok(crate::fx::data_text(&value))
        }
    }
}
pub(super) fn visit(
    path: &Path,
    sheet: &str,
    cancel: &AtomicBool,
    preserve_excel_dates: bool,
    emit: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    visit_projected(path, sheet, cancel, preserve_excel_dates, None, emit)
}

/// A metadata scan still visits every physical row, but only resolves values
/// in requested columns. The normal business reader continues to decode all cells.
pub(super) fn visit_projected(
    path: &Path,
    sheet: &str,
    cancel: &AtomicBool,
    preserve_excel_dates: bool,
    columns: Option<&HashSet<usize>>,
    mut emit: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let projection = columns.map(|columns| {
        let mut selected = vec![false; 16384];
        for column in columns { if *column < selected.len() { selected[*column] = true; } }
        selected
    });
    let strings = dictionary(path, cancel)?;
    let mut string_reader = strings.as_ref().map(SharedStringReader::new).transpose()?;
    let dates = crate::fx::xlsx_date_styles(path);
    let epoch = crate::fx::xlsx_uses_1904_epoch(path);
    let target = crate::fx::xlsx_sheet_entries(path)?
        .into_iter()
        .find(|(name, _)| name == sheet)
        .map(|(_, entry)| entry)
        .ok_or_else(|| io("工作表不存在"))?;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(io)?).map_err(io)?;
    let entry = zip.by_name(&target).map_err(io)?;
    let (mut reader, token_bytes) = reader(entry, cancel);
    let mut buf = Vec::new();
    let mut skipped = Vec::new();
    let mut row = Vec::new();
    let mut row_bytes = 0_usize;
    let mut physical = 0_usize;
    let mut next_row = 1_usize;
    let mut col = 0_usize;
    let mut next_col = 0_usize;
    let mut raw = String::new();
    let mut text = String::new();
    let mut preserve = false;
    let mut kind = String::new();
    let mut style = 0;
    let mut capture = 0;
    let mut phonetic = false;
    let mut in_cell = false;
    let mut retain_cell = true;
    loop {
        token_bytes.set(0);
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| stream_error(e, cancel))?
        {
            Event::Start(e) => match e.local_name().as_ref() {
                b"row" => {
                    physical = physical_row(&e, next_row)?;
                    while next_row < physical {
                        if next_row % 256 == 0 {
                            check(cancel)?;
                        }
                        emit(Vec::new(), next_row)?;
                        next_row += 1;
                    }
                    row.clear();
                    row_bytes = 0;
                    next_col = 0;
                }
                b"c" => {
                    in_cell = true;
                    raw.clear();
                    col = attr(&e, b"r")?
                        .as_deref()
                        .and_then(column)
                        .unwrap_or(next_col);
                    retain_cell = projection.as_ref().is_none_or(|columns| columns.get(col) == Some(&true));
                    if !retain_cell {
                        if col >= 16384 { return Err(io("列号超过Excel上限")); }
                        // Let the XML parser skip unrelated cell content without
                        // converting text, numbers, styles or shared-string IDs.
                        // TokenBudget still bounds bytes and checks cancellation.
                        reader.read_to_end_into(e.name(), &mut skipped)
                            .map_err(|error| stream_error(error, cancel))?;
                        row_bytes = row_bytes.saturating_add(col.saturating_add(1)
                            .saturating_sub(row.len()).saturating_mul(32));
                        if row_bytes > MAX_ROW_BYTES {
                            return Err(failure("TABLE_ROW_TOO_LARGE",
                                "单行数据超过安全预算，请检查异常长字段。", physical));
                        }
                        row.resize(row.len().max(col + 1), String::new());
                        next_col = col + 1;
                        in_cell = false;
                        buf.clear();
                        continue;
                    }
                    kind = if retain_cell { attr(&e, b"t")?.unwrap_or_default() } else { String::new() };
                    style = if retain_cell { attr(&e, b"s")?.and_then(|s| s.parse().ok()).unwrap_or(0) } else { 0 };
                }
                b"v" if in_cell && retain_cell && kind != "inlineStr" && kind != "is" => capture = 1,
                // Calamine treats a redundant inline-string <v> as empty;
                // a subsequent <is> supplies the actual string.
                b"v" if in_cell => raw.clear(),
                b"t" if in_cell && retain_cell && !phonetic => {
                    capture = 2;
                    text.clear();
                    preserve = attr(&e, b"space")?.as_deref() == Some("preserve");
                }
                b"rPh" => phonetic = true,
                _ => {}
            },
            Event::Text(e) if capture > 0 => {
                let value = decoded(&e)?;
                if capture == 2 {
                    text.push_str(&value)
                } else {
                    raw.push_str(&value)
                }
            }
            Event::GeneralRef(e) if capture > 0 => {
                let value = reference(&e)?;
                if capture == 2 {
                    text.push_str(&value)
                } else {
                    raw.push_str(&value)
                }
            }
            Event::CData(e) if capture > 0 => {
                let value = e
                    .xml_content(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(io)?;
                if capture == 2 {
                    text.push_str(&value)
                } else {
                    raw.push_str(&value)
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"t" => {
                    if capture == 2 {
                        raw.push_str(&excel_text(&text, preserve));
                    }
                    text.clear();
                    capture = 0;
                }
                b"v" => capture = 0,
                b"rPh" => phonetic = false,
                b"c" => {
                    if col >= 16384 {
                        return Err(io("列号超过Excel上限"));
                    }
                    let value = if retain_cell { cell_value(
                        &raw,
                        &kind,
                        style,
                        &dates,
                        epoch,
                        preserve_excel_dates,
                        string_reader.as_mut(),
                    )? } else { String::new() };
                    row_bytes = row_bytes.saturating_add(value.len()).saturating_add(
                        col.saturating_add(1)
                            .saturating_sub(row.len())
                            .saturating_mul(32),
                    );
                    if row_bytes > MAX_ROW_BYTES {
                        return Err(failure(
                            "TABLE_ROW_TOO_LARGE",
                            "单行数据超过安全预算，请检查异常长字段。",
                            physical,
                        ));
                    }
                    row.resize(row.len().max(col + 1), String::new());
                    row[col] = value;
                    next_col = col + 1;
                    in_cell = false;
                }
                b"row" => {
                    if physical % 256 == 0 { check(cancel)?; }
                    emit(std::mem::take(&mut row), physical)?;
                    next_row = physical + 1;
                }
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == b"row" => {
                let physical = physical_row(&e, next_row)?;
                while next_row <= physical {
                    if next_row % 256 == 0 {
                        check(cancel)?;
                    }
                    emit(Vec::new(), next_row)?;
                    next_row += 1;
                }
            }
            Event::Empty(e) if e.local_name().as_ref() == b"c" => {
                let c = attr(&e, b"r")?
                    .as_deref()
                    .and_then(column)
                    .unwrap_or(next_col);
                if c >= 16384 {
                    return Err(io("列号超过Excel上限"));
                }
                row.resize(row.len().max(c + 1), String::new());
                next_col = c + 1;
            }
            Event::Eof => break,
            _ => {}
        }
        if raw.len().saturating_add(text.len()) > MAX_ROW_BYTES || buf.len() > MAX_ROW_BYTES {
            return Err(failure(
                "TABLE_ROW_TOO_LARGE",
                "单个文本超过安全预算，请检查异常长字段。",
                physical,
            ));
        }
        buf.clear();
    }
    check(cancel)
}

#[cfg(test)]
#[path = "disk_table_xlsx_tests.rs"]
mod tests;
