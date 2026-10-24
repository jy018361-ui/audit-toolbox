//! Shared, repeatable disk table source. Source rows retain their physical row
//! numbers; consumers own their business rules and never receive a full table.
use crate::AppError;
use calamine::{Reader, open_workbook_auto};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::{Instant, UNIX_EPOCH}};

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;
const MAX_ROW_BYTES: usize = 8 * 1024 * 1024;
#[path = "disk_table_xlsx.rs"]
mod xlsx;
pub(crate) type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

/// 同一任务的监控与所有嵌套读表共用启动时的决定，不随内存波动重新分流。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ReadPlan {
    sources: Vec<(PathBuf, bool)>,
}

impl ReadPlan {
    pub(crate) fn add(&mut self, path: &Path, disk: bool) {
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if let Some((_, previous)) = self.sources.iter_mut().find(|(source, _)| *source == path) {
            *previous |= disk;
        } else {
            self.sources.push((path, disk));
        }
    }

    pub(crate) fn uses_disk(&self) -> bool {
        self.sources.iter().any(|(_, disk)| *disk)
    }

    fn decision(&self, sources: &[(&Path, Option<&str>)]) -> Option<bool> {
        let mut disk = false;
        for (path, _) in sources {
            let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            disk |= self.sources.iter().find(|(source, _)| *source == path)?.1;
        }
        Some(disk)
    }

    pub(crate) fn enter(self) -> ReadPlanGuard {
        ReadPlanGuard(READ_PLAN.with(|slot| slot.replace(Some(self))))
    }
}

thread_local! {
    static READ_PLAN: std::cell::RefCell<Option<ReadPlan>> = const { std::cell::RefCell::new(None) };
}

pub(crate) struct ReadPlanGuard(Option<ReadPlan>);
impl Drop for ReadPlanGuard {
    fn drop(&mut self) {
        READ_PLAN.with(|slot| { slot.replace(self.0.take()); });
    }
}

fn failure(code: &str, message: &str, detail: impl ToString) -> AppError {
    AppError::new(code, message, true, Some(detail.to_string()))
}
fn io(e: impl ToString) -> AppError { failure("DISK_TABLE_IO", "无法读写表格磁盘缓存，请检查文件和磁盘空间。", e) }
fn sql(e: rusqlite::Error) -> AppError { io(e) }
fn check(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) { return Err(failure("JOB_CANCELLED", "任务已取消。", "")); }
    crate::resource_budget::check_available_if_managed()
}

/// Small working sets retain the ordinary reader independently of host pressure.
/// Larger/unknown working sets still require the dynamic disk-worker policy.
pub(crate) fn should_use_disk(paths: &[&Path], working_factor: u64) -> bool {
    let sources = paths.iter().map(|path| (*path, None)).collect::<Vec<_>>();
    should_use_disk_for_sheets(&sources, working_factor)
}

/// 指定工作表时只估算该表及工作簿共享字符串；未知选表时保守估算整本。
pub(crate) fn should_use_disk_for_sheets(sources: &[(&Path, Option<&str>)], working_factor: u64) -> bool {
    if let Some(disk) = READ_PLAN.with(|slot| slot.borrow().as_ref().and_then(|plan| plan.decision(sources))) {
        return disk;
    }
    let mut seen = HashSet::new();
    let mut estimates = Vec::with_capacity(sources.len());
    for &(path, sheet) in sources {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if !seen.insert((canonical, sheet)) { continue; }
        let Ok(meta) = fs::metadata(path) else { return true; };
        let Some(bytes) = estimated_sheet_resident_bytes(path, sheet) else { return true; };
        estimates.push((meta.len(),bytes));
    }
    decision_with_budget(&estimates, working_factor, || {
        crate::resource_budget::budget().ok().map(|budget| budget.worker_bytes)
    })
}
fn decision_with_budget(inputs: &[(u64, u64)], factor: u64, budget: impl FnOnce() -> Option<u64>) -> bool {
    // 小工作集保持普通路径；超过此参考值仅选择磁盘处理，不拒绝任务启动。
    if !decision(inputs, 256 * MIB, factor) {
        return false;
    }
    budget().is_none_or(|worker| decision(inputs, worker, factor))
}
fn decision(inputs:&[(u64,u64)],worker:u64,factor:u64)->bool {
    let peak = inputs.iter().fold(0_u64,|total,(_,peak)| total.saturating_add(peak.saturating_mul(factor.max(1))));
    inputs.iter().any(|(file,_)| *file >= 2*GIB)
        || peak > worker.saturating_mul(65)/100
}

pub(crate) fn estimated_resident_bytes(path: &Path) -> Option<u64> {
    estimated_sheet_resident_bytes(path, None)
}

fn estimated_sheet_resident_bytes(path: &Path, sheet: Option<&str>) -> Option<u64> {
    let size = fs::metadata(path).ok()?.len();
    if crate::spreadsheet_input::is_text(path) {
        if size <= 64 * MIB { return Some(size.saturating_mul(6)); }
        let mut sample = Vec::with_capacity((16 * MIB).min(size) as usize);
        fs::File::open(path).ok()?.take(16 * MIB).read_to_end(&mut sample).ok()?;
        if sample.is_empty() { return Some(0); }
        let lines = sample.iter().filter(|b| **b == b'\n').count().max(1) as u64;
        let separators = [b',', b'\t', b';', b'|'].into_iter()
            .map(|d| sample.iter().filter(|b| **b == d).count() as u64).max()?;
        let rows = size.saturating_mul(lines).div_ceil(sample.len() as u64);
        let cells = size.saturating_mul(separators.saturating_add(lines)).div_ceil(sample.len() as u64);
        return Some(size.saturating_add(rows.saturating_mul(32)).saturating_add(cells.saturating_mul(32)).saturating_mul(5).div_ceil(2));
    }
    if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("xlsx") || x.eq_ignore_ascii_case("xlsm")) {
        let Some((sheets, shared)) = xlsx::shapes(path) else { return None; };
        let wanted = sheet.filter(|name| !name.trim().is_empty());
        // xlsx 的 XML 是给 Excel 看的标记文本：未压缩 XML 字节与解析后的常驻体量
        // 同一量级（稠密表两者相差约一成），不能按标记体量再乘系数。有 dimension
        // 时按行列结构求和并与 XML 体量取大者——稀疏表靠行数兜底、谎报维度靠
        // XML 兜底；没有 dimension 的生成器退回按 XML 4 倍的旧口径。
        let mut total = shared;
        let mut matched = 0_usize;
        for (name, xml, dims) in sheets {
            if wanted.is_some_and(|wanted| &name != wanted) { continue; }
            matched += 1;
            match dims {
                Some((rows, cols)) => {
                    // 单元格数受 XML 体量约束（每个单元格在 XML 中至少十余字节），
                    // 防止谎报维度撑爆估算；稀疏空行不占 XML 但行结构真实，行数不设上限。
                    let cells = rows.saturating_mul(cols).min(xml.saturating_div(12));
                    total = total.saturating_add(xml
                        .max(rows.saturating_mul(32).saturating_add(cells.saturating_mul(32))));
                }
                None => total = total.saturating_add(xml.saturating_mul(4)),
            }
        }
        if wanted.is_some() && matched == 0 { return None; }
        return Some(total);
    }
    // 老格式 .xls 读 BIFF 维度记录取真实行列：文件字节本身就是单元格数据，
    // 没有标记膨胀，按“文件体量 + 行列结构”求和；读不出维度时回退 12 倍旧口径。
    if let Some((rows, cells)) = crate::xls_sample::sheet_shape(path, sheet) {
        return Some(size
            .saturating_add(rows.saturating_mul(32))
            .saturating_add(cells.saturating_mul(32)));
    }
    Some(size.saturating_mul(12))
}

fn workbook_sheets(path: &Path, sheet: Option<&str>) -> Result<(String, Vec<String>), AppError> {
    if crate::spreadsheet_input::is_text(path) { return Ok(("CSV".into(), vec!["CSV".into()])); }
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm")) {
        return xlsx::sheets(path, sheet);
    }
    // Legacy workbook constructors can materialize the complete workbook before
    // worksheet access. Reject over-budget sources before even opening them.
    if should_use_disk(&[path], 1) {
        return Err(failure("STREAM_FORMAT_UNSUPPORTED", "此格式的大文件暂不支持磁盘分批读取，请另存为 XLSX 或 CSV 后重试。", path.display()));
    }
    let book = open_workbook_auto(path).map_err(io)?;
    let all = book.sheet_names().to_vec();
    let selected = match sheet.filter(|s| !s.trim().is_empty()) {
        Some(name) if all.iter().any(|s| s == name) => name.to_owned(),
        Some(name) => return Err(failure("SHEET_NOT_FOUND", "指定的工作表已不存在，请重新选择。", name)),
        None => book.sheets_metadata().iter().find(|s| s.visible == calamine::SheetVisible::Visible)
            .map(|s| s.name.clone()).or_else(|| all.first().cloned()).ok_or_else(|| failure("WORKBOOK_EMPTY", "工作簿没有工作表。", ""))?,
    };
    Ok((selected, all))
}

/// One row in memory. Blank physical rows/columns are preserved. OOXML streams
/// XML and a disk string dictionary, retaining dates and cached formula values.
pub(crate) fn for_each_source_row(
    path: &Path, sheet: Option<&str>, cancel: &AtomicBool,
    visitor: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    for_each_source_row_with_style(path, sheet, cancel, false, visitor)
}

/// Read complete metadata columns without first writing a full-width row cache.
/// Indexes and physical rows are unchanged; other formats retain their existing reader.
pub(crate) fn for_each_source_row_projected(
    path: &Path, sheet: &str, columns: &HashSet<usize>, cancel: &AtomicBool,
    visitor: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    check(cancel)?;
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm")) {
        return xlsx::visit_projected(path, sheet, cancel, false, Some(columns), visitor);
    }
    for_each_source_row(path, Some(sheet), cancel, visitor)
}
pub(crate) fn for_each_source_row_with_style(
    path: &Path, sheet: Option<&str>, cancel: &AtomicBool, preserve_excel_dates: bool,
    mut visitor: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
) -> Result<(), AppError> {
    check(cancel)?;
    let mut emit = |row: Vec<String>, index: usize| {
        if index % 256 == 0 { check(cancel)?; }
        let bytes = row.iter().map(|v| v.len().saturating_add(32)).sum::<usize>();
        if bytes > MAX_ROW_BYTES { return Err(failure("TABLE_ROW_TOO_LARGE", "单行数据超过安全预算，请检查异常长字段。", index)); }
        visitor(row, index)
    };
    if crate::spreadsheet_input::is_text(path) {
        let mut index = 0;
        return crate::spreadsheet_input::for_each_text_row_bounded(path, cancel, MAX_ROW_BYTES, |row| { index += 1; emit(row, index) });
    }
    let (selected, _) = workbook_sheets(path, sheet)?;
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm")) {
        return xlsx::visit(path, &selected, cancel, preserve_excel_dates, emit);
    }
    // BIFF/ODS lack a bounded row reader here. Never silently load a large
    // legacy workbook while advertising a disk processing path.
    if should_use_disk(&[path], 1) {
        return Err(failure("STREAM_FORMAT_UNSUPPORTED", "此格式的大文件暂不支持磁盘分批读取，请另存为 XLSX 或 CSV 后重试。", path.display()));
    }
    let mut book = open_workbook_auto(path).map_err(io)?;
    let range = book.worksheet_range(&selected).map_err(io)?;
    let start = range.start().unwrap_or((0, 0));
    for index in 0..start.0 as usize { emit(Vec::new(), index + 1)?; }
    for (index, cells) in range.rows().enumerate() {
        let mut values = vec![String::new(); start.1 as usize];
        values.extend(cells.iter().map(crate::fx::data_text));
        emit(values, start.0 as usize + index + 1)?;
    }
    check(cancel)
}

pub(crate) fn preview_source(path: &Path, sheet: Option<&str>, limit: usize) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    preview_source_with_cancel(path, sheet, limit, &AtomicBool::new(false))
}
fn preview_source_with_cancel(path: &Path, sheet: Option<&str>, limit: usize, cancel: &AtomicBool) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    let (selected, sheets) = workbook_sheets(path, sheet)?;
    let mut rows = Vec::new();
    if limit > 0 {
        let result = for_each_source_row(path, Some(&selected), cancel, |row, _| {
            rows.push(row);
            if rows.len() >= limit { return Err(failure("DISK_PREVIEW_DONE", "预览完成。", "")); }
            Ok(())
        });
        if let Err(e) = result { if e.code != "DISK_PREVIEW_DONE" { return Err(e); } }
    }
    Ok((selected, sheets, rows))
}

#[derive(Serialize, Deserialize)]
struct Meta { version: u32, headers: Vec<String>, header_row: usize, header_depth: usize, sheet: String, sheets: Vec<String>, row_count: usize }

pub(crate) struct DiskTable {
    pub(crate) path: PathBuf,
    pub(crate) cache_path: PathBuf,
    pub(crate) headers: Vec<String>,
    pub(crate) header_row: usize,
    pub(crate) header_depth: usize,
    pub(crate) sheet: String,
    pub(crate) sheets: Vec<String>,
    pub(crate) row_count: usize,
    db: Connection,
}
pub(crate) fn fingerprint(path: &Path, sheet: &str, row: usize, depth: usize) -> Result<String, AppError> {
    let meta = fs::metadata(path).map_err(io)?;
    let identity = (fs::canonicalize(path).map_err(io)?, meta.len(), meta.modified().map_err(io)?.duration_since(UNIX_EPOCH).map_err(io)?.as_nanos(), sheet, row, depth, 4, crate::header_detection::RULE_VERSION);
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(&identity).map_err(io)?)))
}
impl DiskTable {
    pub(crate) fn open(path: &Path, sheet: Option<&str>, header_row: usize, header_depth: usize, progress: Progress<'_>, cancel: &AtomicBool) -> Result<Self, AppError> {
        Self::open_style(path, sheet, header_row, header_depth, progress, cancel, false)
    }
    pub(crate) fn open_fa(path: &Path, sheet: Option<&str>, header_row: usize, header_depth: usize, progress: Progress<'_>, cancel: &AtomicBool) -> Result<Self, AppError> {
        Self::open_style(path, sheet, header_row, header_depth, progress, cancel, true)
    }
    fn open_style(path: &Path, sheet: Option<&str>, header_row: usize, header_depth: usize, progress: Progress<'_>, cancel: &AtomicBool, fa_style: bool) -> Result<Self, AppError> {
        check(cancel)?;
        let (selected, sheets, prefix) = preview_source_with_cancel(path, sheet, header_row.saturating_add(32).max(32), cancel)?;
        crate::header_detection::require_tabular(&prefix, header_row == 0)?;
        let inferred = crate::fx::infer_public_header_layout(&prefix);
        let header_row = if header_row == 0 { inferred.0 } else { header_row };
        let header_depth = if header_depth == 0 { inferred.1 } else { header_depth }.clamp(1, 2);
        let key = fingerprint(path, &selected, header_row, header_depth)?;
        let root = crate::tabular::cache_root()?.join("tables/v1");
        fs::create_dir_all(&root).map_err(io)?;
        let cache_path = root.join(format!("{key}{}.sqlite", if fa_style { "-fa" } else { "" }));
        if let Ok(table) = Self::read(path, &cache_path) {
            let _ = fs::File::options().append(true).open(&cache_path).and_then(|file| file.set_modified(std::time::SystemTime::now()));
            return Ok(table);
        }
        let estimate = estimated_resident_bytes(path).unwrap_or(fs::metadata(path).map_err(io)?.len().saturating_mul(6));
        crate::resource_budget::check_disk_space(&root, estimate)?;
        let partial = root.join(format!("{key}-{}.partial", uuid::Uuid::new_v4()));
        let build = (|| {
            let mut db = Self::connect(&partial)?;
            db.execute_batch("CREATE TABLE rows(id INTEGER PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE meta(value TEXT NOT NULL);").map_err(sql)?;
            let tx = db.transaction().map_err(sql)?;
            let mut insert = tx.prepare("INSERT INTO rows(id,data) VALUES (?1,?2)").map_err(sql)?;
            let mut raw_headers = Vec::new();
            let mut width = 0;
            let mut row_count = 0;
            let mut tick = Instant::now();
            progress("disk_cache", 0, 0, "正在分批读取表格并建立磁盘缓存…");
            for_each_source_row_with_style(path, Some(&selected), cancel, fa_style, |mut row, number| {
                if fa_style && !crate::spreadsheet_input::is_text(path) { for value in &mut row { *value = value.trim().to_owned(); } }
                width = width.max(row.len());
                if number >= header_row && number < header_row + header_depth { raw_headers.push(row); }
                else if number >= header_row + header_depth {
                    insert.execute(params![number, serde_json::to_string(&row).map_err(io)?]).map_err(sql)?;
                    row_count += 1;
                }
                if tick.elapsed().as_millis() >= 500 {
                    progress("disk_cache", row_count, 0, &format!("已缓存 {row_count} 行，可随时取消。"));
                    tick = Instant::now();
                }
                Ok(())
            })?;
            if raw_headers.len() != header_depth { return Err(failure("HEADER_ROW_INVALID", "标题行超出数据范围。", header_row)); }
            let headers = crate::fx::merge_headers(&raw_headers, width);
            let meta = Meta { version: 1, headers, header_row, header_depth, sheet: selected.clone(), sheets, row_count };
            drop(insert);
            tx.execute("INSERT INTO meta VALUES (?1)", [serde_json::to_string(&meta).map_err(io)?]).map_err(sql)?;
            check(cancel)?;
            if fingerprint(path, &selected, header_row, header_depth)? != key { return Err(failure("SOURCE_CHANGED", "读取期间源文件发生变化，请重新读取。", "")); }
            tx.commit().map_err(sql)?;
            drop(db);
            crate::tabular::replace_file(&partial, &cache_path)?;
            Self::read(path, &cache_path)
        })();
        if build.is_err() { let _ = fs::remove_file(&partial); }
        build
    }
    fn connect(path: &Path) -> Result<Connection, AppError> {
        let db = Connection::open(path).map_err(sql)?;
        let cache = crate::resource_budget::budget()?.sqlite_cache_kib.min(65536);
        db.execute_batch(&format!("PRAGMA cache_size=-{cache}; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;")).map_err(sql)?;
        Ok(db)
    }
    fn read(path: &Path, cache_path: &Path) -> Result<Self, AppError> {
        if !cache_path.is_file() { return Err(io("缓存不存在")); }
        let db = Self::connect(cache_path)?;
        let text: String = db.query_row("SELECT value FROM meta", [], |r| r.get(0)).map_err(sql)?;
        let meta: Meta = serde_json::from_str(&text).map_err(io)?;
        if meta.version != 1 { return Err(io("缓存版本不匹配")); }
        let count: usize = db.query_row("SELECT COUNT(*) FROM rows", [], |row| row.get(0)).map_err(sql)?;
        if count != meta.row_count { return Err(io("缓存行数不完整")); }
        Ok(Self { path: path.into(), cache_path: cache_path.into(), db, headers: meta.headers, header_row: meta.header_row, header_depth: meta.header_depth, sheet: meta.sheet, sheets: meta.sheets, row_count: meta.row_count })
    }
    pub(crate) fn connection(&self) -> &Connection { &self.db }
    pub(crate) fn visit(&self, cancel: &AtomicBool, mut visitor: impl FnMut(&[String], usize) -> Result<(), AppError>) -> Result<(), AppError> {
        let mut stmt = self.db.prepare("SELECT id,data FROM rows ORDER BY id").map_err(sql)?;
        let mut rows = stmt.query([]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let id: usize = row.get(0).map_err(sql)?;
            if id % 256 == 0 { check(cancel)?; }
            let text: String = row.get(1).map_err(sql)?;
            let mut values: Vec<String> = serde_json::from_str(&text).map_err(io)?;
            values.resize(values.len().max(self.headers.len()), String::new());
            visitor(&values, id)?;
        }
        check(cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_sheet_estimate_excludes_other_sheets_but_keeps_shared_strings() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("多工作表.xlsx");
        let mut archive = zip::ZipWriter::new(fs::File::create(&input).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in [
            ("xl/workbook.xml", "<workbook><sheets><sheet name=\"资产\" r:id=\"r1\"/><sheet name=\"其他\" r:id=\"r2\"/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"r1\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"r2\" Target=\"worksheets/sheet2.xml\"/></Relationships>"),
            ("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>"),
            ("xl/sharedStrings.xml", "<sst><si><t>共享名称</t></si></sst>"),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.start_file("xl/worksheets/sheet2.xml", options).unwrap();
        for _ in 0..256 { archive.write_all(&[b' '; 65536]).unwrap(); }
        archive.finish().unwrap();
        let small = estimated_sheet_resident_bytes(&input, Some("资产")).unwrap();
        // 这些表没有 dimension 标签，退回按 XML 4 倍估算；共享字符串只计一次。
        assert_eq!(small, "<sst><si><t>共享名称</t></si></sst>".len() as u64 + "<worksheet><sheetData/></worksheet>".len() as u64 * 4);
        assert!(estimated_resident_bytes(&input).unwrap() > 64 * MIB);
        assert!(estimated_sheet_resident_bytes(&input, Some("不存在")).is_none());
        crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
            total: 16 * GIB, available: 158 * GIB / 100, commit_available: 8 * GIB,
        }, || {
            assert!(!should_use_disk_for_sheets(&[(&input, Some("资产"))], 12));
            assert!(should_use_disk_for_sheets(&[(&input, Some("其他"))], 12));
            assert!(should_use_disk_for_sheets(&[(&input, Some("资产")), (&input, Some("其他"))], 12));
        });
    }

    #[test]
    fn xlsx_estimate_tracks_content_and_stays_in_memory_at_low_watermarks() {
        // 黄金测试集 01 组体量（约 3.7 万行 × 29 列，文件约 5MB）：估算应接近
        // 真实常驻体量而不是标记体量的倍数，且任何内存水位都不再切磁盘缓存。
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("序时账.xlsx");
        let mut book = rust_xlsxwriter::Workbook::new();
        let sheet = book.add_worksheet();
        for col in 0..29_u16 {
            sheet.write_string(0, col, format!("列{}", col + 1)).unwrap();
        }
        for row in 1..37_329_u32 {
            for col in 0..29_u16 {
                sheet.write_number(row, col, row as f64 * (col as f64 + 1.0)).unwrap();
            }
        }
        book.save(&input).unwrap();
        let estimate = estimated_resident_bytes(&input).unwrap();
        assert!(estimate < 60 * MIB, "估算应接近真实体量：{estimate}");
        crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
            total: 16 * GIB, available: MIB, commit_available: MIB,
        }, || {
            assert!(!should_use_disk(&[&input], 4), "01 组体量在最低内存水位也不应切磁盘");
        });
    }

    #[test]
    fn xlsx_estimate_caps_lied_dimensions_with_markup_bytes() {
        use std::io::Write;
        // 个别生成器会写出整表尺寸的 dimension：单元格数以 XML 体量封顶，
        // 行结构按谎报行数计（约 32MB 上限），不会撑爆估算。
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("谎报.xlsx");
        let mut archive = zip::ZipWriter::new(fs::File::create(&input).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in [
            ("xl/workbook.xml", "<workbook><sheets><sheet name=\"数据\" r:id=\"r1\"/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"r1\" Target=\"worksheets/sheet1.xml\"/></Relationships>"),
            ("xl/worksheets/sheet1.xml", "<worksheet><dimension ref=\"A1:XFD1048576\"/><sheetData><row r=\"1\"><c r=\"A1\"><v>1</v></c></row></sheetData></worksheet>"),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(body.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
        let estimate = estimated_resident_bytes(&input).unwrap();
        assert!(estimate < 64 * MIB, "谎报维度应以 XML 体量封顶：{estimate}");
    }

    #[test]
    #[ignore = "设置 AUDIT_GOLDEN_DIR 指向 TBJE 黄金测试集目录后运行"]
    fn golden_tbje_pairs_keep_memory_switch_points() {
        let Some(root) = std::env::var_os("AUDIT_GOLDEN_DIR").map(std::path::PathBuf::from) else {
            return;
        };
        let sources = |je: &str, tb: &str| -> Vec<(std::path::PathBuf, Option<&'static str>)> {
            vec![(root.join(je), None), (root.join(tb), None)]
        };
        let extreme = crate::resource_budget::MemoryStatus {
            total: 16 * GIB, available: MIB, commit_available: MIB,
        };
        // 01/06/08/09 组（0.4MB–5MB）：任何内存水位都整表读取。
        for (je, tb) in [
            ("01序时账 (JE).xlsx", "01科目余额表（TB）.xls"),
            ("06序时账-2024.1-3.xlsx", "06科目余额表_2024.1-3.xlsx"),
            ("08序时账 (2).xlsx", "08TB.xlsx"),
            ("09序时账-2025.xls", "09科目余额表-2025.xls"),
        ] {
            let owned = sources(je, tb);
            let pairs = owned.iter().map(|(path, sheet)| (path.as_path(), *sheet)).collect::<Vec<_>>();
            crate::resource_budget::with_test_memory(extreme, || {
                assert!(!should_use_disk_for_sheets(&pairs, 4), "{je} 极端低水位不应切磁盘");
            });
        }
        // 02/03/04 组（23MB–80MB）：16GB 机器内存充裕（可用 8GB）时整表读取，
        // 真正紧张（可用 2GB）才切磁盘保护。
        for (je, tb) in [
            ("02序时账 (2).xlsx", "02科目余额表.xlsx"),
            ("03序时账 (2).xlsx", "03科目余额表.xlsx"),
            ("04JE.XLSX", "04TB.XLSX"),
        ] {
            let owned = sources(je, tb);
            let pairs = owned.iter().map(|(path, sheet)| (path.as_path(), *sheet)).collect::<Vec<_>>();
            crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
                total: 16 * GIB, available: 8 * GIB, commit_available: 8 * GIB,
            }, || {
                assert!(!should_use_disk_for_sheets(&pairs, 4), "{je} 16GB 机器可用 8GB 不应切磁盘");
            });
            crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
                total: 16 * GIB, available: 2 * GIB, commit_available: 2 * GIB,
            }, || {
                assert!(should_use_disk_for_sheets(&pairs, 4), "{je} 可用 2GB 应切磁盘保护");
            });
        }
    }

    #[test]
    fn small_working_set_does_not_request_a_worker_budget() {
        // The reported FX2 workbook is about 2 MiB compressed and its base
        // resident estimate is about 70 MiB. Small combined inputs also qualify.
        for inputs in [vec![(2 * MIB, 71 * MIB)], vec![(MIB, 30 * MIB), (MIB, 40 * MIB)]] {
            assert!(!decision_with_budget(&inputs, 1, || panic!("小文件不应申请大文件启动预算")));
        }
        assert!(!decision_with_budget(&[(MIB, 10 * MIB)], 12, || panic!("小工作集不应申请大文件启动预算")));
        let boundary = 256 * MIB * 65 / 100;
        assert!(!decision_with_budget(&[(MIB, boundary)], 1, || panic!("边界内仍是小工作集")));
        assert!(decision_with_budget(&[(MIB, boundary + 1)], 1, || None));
    }
    #[test]
    fn large_decompressed_or_combined_working_sets_keep_dynamic_protection() {
        // A tiny compressed XLSX may expand dramatically; raw size alone must
        // never exempt it. The sum and tool intermediates still count as well.
        for (inputs, factor) in [
            (vec![(MIB, 300 * MIB)], 1),
            (vec![(MIB, 90 * MIB), (MIB, 90 * MIB)], 1),
            (vec![(MIB, 20 * MIB)], 12),
            (vec![(2 * GIB, MIB)], 1),
        ] {
            assert!(decision_with_budget(&inputs, factor, || None));
        }
        assert!(!decision_with_budget(&[(MIB, 300 * MIB)], 1, || Some(GIB)));
        assert!(decision_with_budget(&[(MIB, 300 * MIB)], 1, || Some(256 * MIB)));
        assert!(decision_with_budget(&[(2 * GIB, MIB)], 1, || Some(64 * GIB)));
    }
    #[test]
    fn combined_input_budget_includes_all_files_and_module_working_set(){
        assert!(!decision(&[(10,300)],1000,1));
        assert!(decision(&[(10,300),(10,351)],1000,1));
        assert!(!decision(&[(10,300),(10,350)],1000,1));
        assert!(decision(&[(10,300)],1000,3));
        assert!(decision(&[(2*GIB,1)],64*GIB,1));
        assert!(decision(&[(10,u64::MAX)],1000,u64::MAX));
    }
    #[test]
    fn disk_table_ragged_group_headers_match_rectangular_input_and_cache() {
        let dir = tempfile::tempdir().unwrap();
        let expected = ["基础信息-编号", "基础信息-名称", "金额-原值", "金额-累计折旧"];
        for extension in ["csv", "xlsx"] {
            let path = dir.path().join(format!("分组表头.{extension}"));
            if extension == "csv" {
                fs::write(&path, "基础信息,,金额\n编号,名称,原值,累计折旧\n0001,设备,100,10\n").unwrap();
            } else {
                let mut book = rust_xlsxwriter::Workbook::new();
                let sheet = book.add_worksheet();
                sheet.write_string(0, 0, "基础信息").unwrap();
                sheet.write_string(0, 2, "金额").unwrap();
                for (r, values) in [(1, ["编号", "名称", "原值", "累计折旧"]), (2, ["0001", "设备", "100", "10"])] {
                    for (c, value) in values.iter().enumerate() {
                        sheet.write_string(r, c as u16, *value).unwrap();
                    }
                }
                book.save(&path).unwrap();
            }
            for _ in 0..2 {
                let table = DiskTable::open(&path, None, 1, 2, &|_,_,_,_|{}, &AtomicBool::new(false)).unwrap();
                assert_eq!(table.headers, expected);
                assert_eq!(table.row_count, 1);
                table.visit(&AtomicBool::new(false), |row, _| {
                    assert_eq!(row, ["0001", "设备", "100", "10"]);
                    Ok(())
                }).unwrap();
            }
        }
    }

    #[test]
    fn disk_table_keeps_sparse_physical_rows_dates_and_reuses_cache() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("数据.xlsx");
        let mut book = rust_xlsxwriter::Workbook::new();
        let sheet = book.add_worksheet();
        sheet.write_string(1, 0, "日期").unwrap();
        sheet.write_string(1, 1, "编号").unwrap();
        sheet.write_string(2, 1, "0001").unwrap();
        sheet.write_string(4, 1, "0002").unwrap();
        book.save(&input).unwrap();
        let cancel = AtomicBool::new(false);
        let first = DiskTable::open(&input, None, 2, 1, &|_,_,_,_|{}, &cancel).unwrap();
        let mut rows = Vec::new();
        first.visit(&cancel, |r,i| { rows.push((i,r.to_vec())); Ok(()) }).unwrap();
        assert_eq!(rows, vec![(3,vec!["".into(),"0001".into()]),(4,vec!["".into(),"".into()]),(5,vec!["".into(),"0002".into()])]);
        let second = DiskTable::open(&input, None, 2, 1, &|_,_,_,_|panic!("缓存命中不应重扫"), &cancel).unwrap();
        assert_eq!(first.cache_path, second.cache_path);
        assert_eq!(second.row_count, 3);
    }
    #[test]
    fn disk_table_multiline_text_headers_and_source_change_are_not_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("表.csv");
        fs::write(&input, "科目,摘要\n0001,\"第一行\n第二行\"\n0002,正常\n").unwrap();
        let cancel = AtomicBool::new(false);
        let first = DiskTable::open(&input,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
        assert_eq!(first.row_count,2);
        let mut values = Vec::new();
        first.visit(&cancel,|r,_|{values.push(r.to_vec());Ok(())}).unwrap();
        assert_eq!(values[0][0],"0001"); assert_eq!(values[0][1],"第一行\n第二行");
        fs::write(&input,"科目,摘要\n0003,已修改\n").unwrap();
        let second=DiskTable::open(&input,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
        assert_ne!(first.cache_path,second.cache_path); assert_eq!(second.row_count,1);
        cancel.store(true,Ordering::Relaxed);
        assert!(second.visit(&cancel,|_,_|Ok(())).is_err());
    }
    #[test]
    fn 通用表头单层空标题普通与磁盘列位一致() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("空标题.csv");
        fs::write(&input, "科目编码,,科目名称,借方金额,\n1001,辅助甲,现金,10,尾列\n").unwrap();
        let regular = crate::fx::load_fx_table(&crate::fx::SourceSpec {
            input_path: input.to_string_lossy().into_owned(), sheet: String::new(), header_row: 1, header_depth: 1,
        }).unwrap();
        let cancel = AtomicBool::new(false);
        let disk = DiskTable::open(&input, None, 1, 1, &|_,_,_,_|{}, &cancel).unwrap();
        assert_eq!(regular.headers, ["科目编码", "列2", "科目名称", "借方金额", "列5"]);
        let automatic = crate::fx::load_fx_table(&crate::fx::SourceSpec {
            input_path: input.to_string_lossy().into_owned(), sheet: String::new(), header_row: 0, header_depth: 1,
        }).unwrap();
        assert_eq!(automatic.headers, regular.headers);
        assert_eq!(automatic.rows, regular.rows);
        assert_eq!(disk.headers, regular.headers);
        let mut rows = Vec::new();
        disk.visit(&cancel, |row, _| { rows.push(row.to_vec()); Ok(()) }).unwrap();
        assert_eq!(rows, regular.rows);
    }

    #[test]
    fn disk_table_xlsx_matches_reader_strings_dates_formulas_and_sheet_identity() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("含日期与公式.xlsx");
        let mut book = rust_xlsxwriter::Workbook::new();
        book.add_worksheet().set_name("无关页").unwrap().write_string(0,0,"不应读取").unwrap();
        let sheet = book.add_worksheet();
        sheet.set_name("明细&原文").unwrap();
        for (i, name) in ["编号", "日期", "金额", "公式"].iter().enumerate() { sheet.write_string(0,i as u16,*name).unwrap(); }
        sheet.write_string(1,0,"  A&B <原文> &amp;  ").unwrap();
        let format=rust_xlsxwriter::Format::new().set_num_format("yyyy-mm-dd hh:mm:ss");
        let date=rust_xlsxwriter::ExcelDateTime::from_ymd(2024,2,29).unwrap().and_hms(12,30,45).unwrap();
        sheet.write_datetime_with_format(1,1,&date,&format).unwrap();
        sheet.write_number(1,2,-123.25).unwrap();
        sheet.write_formula(1,3,rust_xlsxwriter::Formula::new("C2*2").set_result("-246.5")).unwrap();
        book.save(&input).unwrap();
        let cancel=AtomicBool::new(false);
        let mut streamed=Vec::new();
        for_each_source_row(&input,Some("明细&原文"),&cancel,|r,_|{streamed.push(r);Ok(())}).unwrap();
        let mut reader=open_workbook_auto(&input).unwrap();
        let range=reader.worksheet_range("明细&原文").unwrap();
        let expected=range.rows().map(|r|r.iter().map(crate::fx::data_text).collect::<Vec<_>>()).collect::<Vec<_>>();
        assert_eq!(streamed,expected);
        let regular=DiskTable::open(&input,Some("明细&原文"),1,1,&|_,_,_,_|{},&cancel).unwrap();
        let fa=DiskTable::open_fa(&input,Some("明细&原文"),1,1,&|_,_,_,_|{},&cancel).unwrap();
        assert_ne!(regular.cache_path,fa.cache_path);
        fa.visit(&cancel,|row,_|{assert_eq!(row[0],"A&B <原文> &amp;");assert!(row[1].parse::<f64>().is_ok());Ok(())}).unwrap();
    }

    #[test]
    fn disk_table_rebuilds_incomplete_shared_string_dictionary() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("字典.xlsx");
        let mut book=rust_xlsxwriter::Workbook::new();
        let sheet=book.add_worksheet();sheet.write_string(0,0,"标题").unwrap();sheet.write_string(1,0,"完整正文").unwrap();book.save(&path).unwrap();
        let cancel=AtomicBool::new(false);
        for_each_source_row(&path,None,&cancel,|_,_|Ok(())).unwrap();
        let key=fingerprint(&path,"shared-strings",1,1).unwrap();
        let dictionary=crate::tabular::cache_root().unwrap().join("tables/shared-v2").join(format!("{key}.sqlite"));
        let db=Connection::open(&dictionary).unwrap();db.execute("DELETE FROM strings WHERE id=1",[]).unwrap();drop(db);
        let mut rows=Vec::new();for_each_source_row(&path,None,&cancel,|r,_|{rows.push(r);Ok(())}).unwrap();
        assert_eq!(rows[1],vec!["完整正文"]);
    }

    #[test]
    fn disk_table_rejects_oversized_xlsx_row_while_reading_cells() {
        use std::io::Write;
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("异常宽行.xlsx");
        let mut zip=zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options=zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("xl/workbook.xml",options).unwrap();zip.write_all(br#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels",options).unwrap();zip.write_all(br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#).unwrap();
        zip.start_file("xl/worksheets/sheet1.xml",options).unwrap();zip.write_all(b"<worksheet><sheetData><row r=\"1\">").unwrap();
        let value="x".repeat(32768);
        for _ in 0..260 {zip.write_all(b"<c t=\"inlineStr\"><is><t>").unwrap();zip.write_all(value.as_bytes()).unwrap();zip.write_all(b"</t></is></c>").unwrap();}
        zip.write_all(b"</row></sheetData></worksheet>").unwrap();zip.finish().unwrap();
        let err=for_each_source_row(&path,None,&AtomicBool::new(false),|_,_|panic!("超限行不应提交给调用者")).unwrap_err();
        assert_eq!(err.code,"TABLE_ROW_TOO_LARGE");
    }
}
