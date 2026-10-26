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
pub(crate) const MEMORY_ONLY_FILE_BYTES: u64 = 50 * MIB;
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
        !files_stay_in_memory(&self.sources.iter().map(|(path, _)| path.as_path()).collect::<Vec<_>>())
            && self.sources.iter().any(|(_, disk)| *disk)
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

/// 硬规则：每份有效输入都严格小于 50 MiB 时固定普通模式，不读取预算或展开估算。
/// 未知/缺失路径不享受豁免，仍由原读取入口报告真实文件错误。
pub(crate) fn files_stay_in_memory(paths: &[&Path]) -> bool {
    !paths.is_empty() && paths.iter().all(|path| fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.len() < MEMORY_ONLY_FILE_BYTES))
}

/// 强制标志只为内部小样本路径对照测试保留；发布程序仍遵守文件大小硬规则。
pub(crate) fn forced_disk_allowed(paths: &[&Path], requested: bool) -> bool {
    requested && (cfg!(test) || !files_stay_in_memory(paths))
}

/// Small working sets retain the ordinary reader independently of host pressure.
/// Larger/unknown working sets still require the dynamic disk-worker policy.
pub(crate) fn should_use_disk(paths: &[&Path], working_factor: u64) -> bool {
    let sources = paths.iter().map(|path| (*path, None)).collect::<Vec<_>>();
    should_use_disk_for_sheets(&sources, working_factor)
}

/// 指定工作表时只估算该表及工作簿共享字符串；未知选表时保守估算整本。
pub(crate) fn should_use_disk_for_sheets(sources: &[(&Path, Option<&str>)], working_factor: u64) -> bool {
    if files_stay_in_memory(&sources.iter().map(|(path, _)| *path).collect::<Vec<_>>()) {
        return false;
    }
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
    if !inputs.is_empty() && inputs.iter().all(|(bytes, _)| *bytes < MEMORY_ONLY_FILE_BYTES) {
        return false;
    }
    // 小工作集保持普通路径；超过此参考值仅选择磁盘处理，不拒绝任务启动。
    if !decision(inputs, 256 * MIB, factor) {
        return false;
    }
    budget().is_none_or(|worker| decision(inputs, worker, factor))
}

#[cfg(test)]
pub(crate) fn pad_policy_test_archive<W: std::io::Write + std::io::Seek>(archive: &mut zip::ZipWriter<W>) {
    // 保留大文件选表/倍率测试：用不参与读表的 ZIP 条目跨过真实文件大小门槛。
    archive.start_file("policy-test-padding", zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)).unwrap();
    for _ in 0..800 { std::io::Write::write_all(archive, &[0; 65536]).unwrap(); }
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

/// 老格式工作簿（.xls 等）是否大到不能整本载入：只按文件自身的诚实体量
/// 判定，不受同任务其他大文件的联合读取计划连累——联合任务转入分批时，
/// 自身不大的 .xls 仍应整本载入再分批建缓存，而不是要求用户手工转存。
fn legacy_workbook_needs_stream(path: &Path) -> bool {
    if files_stay_in_memory(&[path]) { return false; }
    let Ok(meta) = fs::metadata(path) else { return true; };
    let Some(estimate) = estimated_sheet_resident_bytes(path, None) else { return true; };
    decision(&[(meta.len(), estimate)], 256 * MIB, 1)
}

/// 真正巨大的老格式工作簿自动转存 XLSX 副本供分批读取。副本按源文件指纹
/// 缓存在本机数据目录，同一文件重复任务直接复用；本机没有 Excel 或文件
/// 含宏等无法自动转存时，回到人工另存提示。
fn xls_stream_copy(path: &Path) -> Result<PathBuf, AppError> {
    let unsupported = |detail: String| {
        failure(
            "STREAM_FORMAT_UNSUPPORTED",
            "此文件过大且为老式 Excel 格式，自动转存未成功，请另存为 XLSX 或 CSV 后重试。",
            detail,
        )
    };
    let key = fingerprint(path, "xls-convert", 1, 1)
        .map_err(|e| unsupported(e.user_message))?;
    let root = crate::tabular::cache_root()
        .map_err(|e| unsupported(e.user_message))?
        .join("tables/xls-convert-v1");
    fs::create_dir_all(&root).map_err(|e| unsupported(e.to_string()))?;
    let output = root.join(format!("{key}.xlsx"));
    if output.is_file() {
        return Ok(output);
    }
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or_default();
    crate::resource_budget::check_disk_space(&root, size)
        .map_err(|e| unsupported(e.user_message))?;
    crate::excel_com::convert_xls_to_xlsx(path, &output)
        .map_err(|e| unsupported(e.user_message))?;
    Ok(output)
}

pub(crate) fn workbook_sheets(path: &Path, sheet: Option<&str>) -> Result<(String, Vec<String>), AppError> {
    if crate::spreadsheet_input::is_text(path) { return Ok(("CSV".into(), vec!["CSV".into()])); }
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm")) {
        return xlsx::sheets(path, sheet);
    }
    // 老格式没有流式读取器：自身不大就整本载入；自身巨大时先自动转存
    // XLSX 副本再分批读取（需本机 Excel），转存不了才提示人工另存。
    if legacy_workbook_needs_stream(path) {
        let converted = xls_stream_copy(path)?;
        return xlsx::sheets(&converted, sheet);
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
    // BIFF/ODS lack a bounded row reader here. A workbook that is small on its
    // own is still loaded whole (the joint plan must not doom it); an oversized
    // one is first converted to a cached XLSX copy for row streaming.
    if legacy_workbook_needs_stream(path) {
        let converted = xls_stream_copy(path)?;
        return xlsx::visit(&converted, &selected, cancel, preserve_excel_dates, emit);
    }
    let mut book = open_workbook_auto(path).map_err(io)?;
    let range = book.worksheet_range(&selected).map_err(io)?;
    let start = range.start().unwrap_or((0, 0));
    for index in 0..start.0 as usize { emit(Vec::new(), index + 1)?; }
    for (index, cells) in range.rows().enumerate() {
        let mut values = vec![String::new(); start.1 as usize];
        values.extend(cells.iter().map(|value| match value {
            calamine::Data::DateTime(value) if preserve_excel_dates => value.to_string(),
            _ => crate::fx::data_text(value),
        }));
        emit(values, start.0 as usize + index + 1)?;
    }
    check(cancel)
}

pub(crate) fn preview_source(path: &Path, sheet: Option<&str>, limit: usize) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    preview_source_with_cancel(path, sheet, limit, &AtomicBool::new(false))
}
fn preview_source_with_cancel(path: &Path, sheet: Option<&str>, limit: usize, cancel: &AtomicBool) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    preview_source_styled(path, sheet, limit, cancel, false)
}
pub(crate) fn preview_source_serials(path: &Path, sheet: Option<&str>, limit: usize) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    preview_source_styled(path, sheet, limit, &AtomicBool::new(false), true)
}
fn preview_source_styled(path: &Path, sheet: Option<&str>, limit: usize, cancel: &AtomicBool, serial_dates: bool) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    check(cancel)?;
    let value = crate::table_read_cache::read(path, "physical-preview-v2", &(sheet, limit, serial_dates), || {
        preview_source_uncached(path, sheet, limit, cancel, serial_dates)
    })?;
    check(cancel)?;
    Ok(value)
}
fn preview_source_uncached(path: &Path, sheet: Option<&str>, limit: usize, cancel: &AtomicBool, serial_dates: bool) -> Result<(String, Vec<String>, Vec<Vec<String>>), AppError> {
    let (selected, sheets) = workbook_sheets(path, sheet)?;
    let mut rows = Vec::new();
    if limit > 0 {
        let result = for_each_source_row_with_style(path, Some(&selected), cancel, serial_dates, |row, _| {
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
    /// Logical nonblank windows are indexed once, including old source caches.
    /// Repeated preview pages never decode the remainder merely to count it.
    pub(crate) fn nonempty_window(&self, offset: usize, limit: usize, cancel: &AtomicBool)
        -> Result<(Vec<Vec<String>>, usize), AppError> {
        use rusqlite::OptionalExtension;
        check(cancel)?;
        self.db.execute_batch("CREATE TABLE IF NOT EXISTS preview_window_meta(version INTEGER PRIMARY KEY, row_count INTEGER NOT NULL);").map_err(sql)?;
        let mut count: Option<usize> = self.db.query_row(
            "SELECT row_count FROM preview_window_meta WHERE version=1", [], |row| row.get(0)
        ).optional().map_err(sql)?;
        if count.is_none() {
            let tx = self.db.unchecked_transaction().map_err(sql)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS preview_window(position INTEGER PRIMARY KEY,source_id INTEGER NOT NULL); DELETE FROM preview_window;").map_err(sql)?;
            let mut insert = tx.prepare("INSERT INTO preview_window VALUES(?1,?2)").map_err(sql)?;
            let mut total = 0usize;
            self.visit(cancel, |row, physical| {
                if row.iter().any(|value| !value.trim().is_empty()) {
                    total += 1;
                    insert.execute(params![total, physical]).map_err(sql)?;
                }
                Ok(())
            })?;
            drop(insert);
            check(cancel)?;
            tx.execute("INSERT INTO preview_window_meta VALUES(1,?1)", [total]).map_err(sql)?;
            tx.commit().map_err(sql)?;
            count = Some(total);
        }
        let count = count.unwrap();
        let mut page = Vec::new();
        if offset < count && limit > 0 {
            let mut query = self.db.prepare("SELECT r.data FROM preview_window w JOIN rows r ON r.id=w.source_id WHERE w.position>?1 AND w.position<=?2 ORDER BY w.position").map_err(sql)?;
            let records = query.query_map(params![offset, offset.saturating_add(limit).min(count)], |row| row.get::<_,String>(0)).map_err(sql)?;
            for record in records {
                check(cancel)?;
                let mut values: Vec<String> = serde_json::from_str(&record.map_err(sql)?).map_err(io)?;
                values.resize(values.len().max(self.headers.len()), String::new());
                page.push(values);
            }
        }
        check(cancel)?;
        Ok((page, count))
    }

    /// 只复用已经完成的 FA 缓存；未命中不触发解析或建库。
    pub(crate) fn cached_fa(path: &Path, sheet: &str, header_row: usize, header_depth: usize) -> Option<Self> {
        let key = fingerprint(path, sheet, header_row, header_depth).ok()?;
        let cache = crate::tabular::cache_root().ok()?.join("tables/v1").join(format!("{key}-fa.sqlite"));
        Self::read(path, &cache).ok()
    }

    /// 从已缓存 JSON 行中仅提取所需列，避免反序列化整行的几十个字段。
    pub(crate) fn visit_columns(&self, columns: &HashSet<usize>, cancel: &AtomicBool,
        mut visitor: impl FnMut(Vec<String>, usize) -> Result<(), AppError>) -> Result<(), AppError> {
        check(cancel)?;
        if columns.is_empty() { return Ok(()); }
        let mut indexes = columns.iter().copied().collect::<Vec<_>>();
        indexes.sort_unstable();
        let fields = indexes.iter().map(|index| format!("json_extract(data,'$[{index}]')")).collect::<Vec<_>>().join(",");
        let mut statement = self.db.prepare(&format!("SELECT id,{fields} FROM rows ORDER BY id")).map_err(sql)?;
        let mut rows = statement.query([]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            let physical: usize = row.get(0).map_err(sql)?;
            if physical % 256 == 0 { check(cancel)?; }
            let mut values = vec![String::new(); indexes.last().copied().unwrap_or(0) + 1];
            for (position, index) in indexes.iter().enumerate() {
                values[*index] = row.get::<_, Option<String>>(position + 1).map_err(sql)?.unwrap_or_default();
            }
            visitor(values, physical)?;
        }
        check(cancel)
    }

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
    #[ignore = "合成大表性能探针，显式运行"]
    fn nonempty_preview_synthetic_bench() {
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("台账.csv");
        let mut writer=csv::Writer::from_path(&path).unwrap();
        writer.write_record((0..20).map(|i|format!("字段{i}"))).unwrap();
        for index in 0..50_000 { writer.write_record((0..20).map(|i|format!("记录{index}字段{i}"))).unwrap(); }
        writer.flush().unwrap();
        let cancel=AtomicBool::new(false);
        let source=DiskTable::open(&path,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
        let started=Instant::now();
        let mut old_decodes=0usize;
        for offset in [0,20_000,49_900] {
            let mut expected=Vec::new();
            source.visit(&cancel,|row,_| { let at=old_decodes%50_000; if at>=offset && at<offset+100 {expected.push(row.to_vec());} old_decodes+=1;Ok(()) }).unwrap();
            assert_eq!(expected.len(),100);
        }
        let before=started.elapsed().as_secs_f64();
        let started=Instant::now();
        let (_,count)=source.nonempty_window(0,100,&cancel).unwrap();
        let first=started.elapsed().as_secs_f64();
        assert_eq!(count,50_000);
        let started=Instant::now();
        for offset in [0,20_000,49_900] {
            let (page,count)=source.nonempty_window(offset,100,&cancel).unwrap();
            assert_eq!(count,50_000); assert_eq!(page.len(),100);
            assert_eq!(page[0][0],format!("记录{offset}字段0"));
        }
        println!("台账分页合成探针：50000行×20列，3页；原解码{old_decodes}行 {:.3}s；首次建索引 {:.3}s，索引后三页仅解码300行 {:.3}s（Debug局部探针）",before,first,started.elapsed().as_secs_f64());
    }
    #[test]
    fn nonempty_preview_pages_reuse_index_keep_count_and_do_not_decode_other_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("分页.csv");
        fs::write(&path, "编号,金额,备注\nA,1,\n, ,　\nB,2,\nC,3,\n").unwrap();
        let cancel = AtomicBool::new(false);
        let table = DiskTable::open(&path,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
        let (page,count) = table.nonempty_window(1,1,&cancel).unwrap();
        assert_eq!(count,3);
        assert_eq!(page[0][0],"B");
        let plan = table.db.prepare("EXPLAIN QUERY PLAN SELECT r.data FROM preview_window w JOIN rows r ON r.id=w.source_id WHERE w.position>?1 AND w.position<=?2 ORDER BY w.position").unwrap()
            .query_map([1,2],|row| row.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        assert!(plan.iter().any(|line|line.contains("SEARCH w USING INTEGER PRIMARY KEY")), "{plan:?}");
        assert!(plan.iter().all(|line|!line.contains("TEMP B-TREE")), "{plan:?}");
        // A bad row outside this page must not be decoded by a hidden full scan.
        table.db.execute("UPDATE rows SET data='INVALID_JSON' WHERE id=(SELECT source_id FROM preview_window WHERE position=3)",[]).unwrap();
        drop(table);
        let table = DiskTable::open(&path,None,1,1,&|_,_,_,_|panic!("缓存不能重读文件"),&cancel).unwrap();
        assert_eq!(table.nonempty_window(0,2,&cancel).unwrap().1,3);
        assert!(table.nonempty_window(2,1,&cancel).is_err());
        assert!(table.visit(&cancel,|_,_|Ok(())).is_err());
        assert!(table.nonempty_window(99,10,&cancel).unwrap().0.is_empty());
        assert!(table.nonempty_window(0,0,&cancel).unwrap().0.is_empty());
        cancel.store(true,Ordering::Relaxed);
        assert_eq!(table.nonempty_window(0,1,&cancel).err().unwrap().code,"JOB_CANCELLED");
    }

    #[test]
    fn failed_preview_index_is_not_published_and_can_be_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("失败重试.csv");
        fs::write(&path,"编号,金额\nA,1\nB,2\n").unwrap();
        let cancel=AtomicBool::new(false);
        let table=DiskTable::open(&path,None,1,1,&|_,_,_,_|{},&cancel).unwrap();
        let last:i64=table.db.query_row("SELECT MAX(id) FROM rows",[],|row|row.get(0)).unwrap();
        let original:String=table.db.query_row("SELECT data FROM rows WHERE id=?1",[last],|row|row.get(0)).unwrap();
        table.db.execute("UPDATE rows SET data='INVALID_JSON' WHERE id=?1",[last]).unwrap();
        assert!(table.nonempty_window(0,1,&cancel).is_err());
        assert_eq!(table.db.query_row("SELECT COUNT(*) FROM preview_window_meta",[],|row|row.get::<_,usize>(0)).unwrap(),0);
        table.db.execute("UPDATE rows SET data=?1 WHERE id=?2",params![original,last]).unwrap();
        assert_eq!(table.nonempty_window(0,10,&cancel).unwrap().1,2);
    }
    #[test]
    fn files_under_50_mib_override_expansion_pressure_and_transferred_plans() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("高压缩.xlsx");
        let b = dir.path().join("第二份.xls");
        for path in [&a, &b] { fs::File::create(path).unwrap().set_len(MEMORY_ONLY_FILE_BYTES - 1).unwrap(); }
        let mut plan = ReadPlan::default();
        plan.add(&a, true);
        plan.add(&b, true);
        let plan: ReadPlan = serde_json::from_slice(&serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(!plan.uses_disk(), "旧的磁盘计划也不能开启小文件内存监控");
        let _guard = plan.enter();
        crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
            total:16*GIB, available:1, commit_available:1,
        }, || {
            assert!(!should_use_disk(&[&a, &b], u64::MAX));
            assert!(!should_use_disk_for_sheets(&[(&a, Some("未读取估算"))], 12));
            assert!(!legacy_workbook_needs_stream(&b));
        });
        // 50 MiB 本身不享受豁免；这里的无效 XLSX 应交回原估算/读取流程。
        fs::File::create(&a).unwrap().set_len(MEMORY_ONLY_FILE_BYTES).unwrap();
        assert!(should_use_disk(&[&a], 1));
        assert!(files_stay_in_memory(&[&b]));
        assert!(!files_stay_in_memory(&[&dir.path().join("不存在.xlsx")]));
        assert!(!files_stay_in_memory(&[dir.path()]));
        assert!(!files_stay_in_memory(&[]));
        assert!(!decision_with_budget(&[(MEMORY_ONLY_FILE_BYTES-1, u64::MAX)], u64::MAX,
            || panic!("低于 50 MiB 不得申请预算")));
    }
    #[test]
    fn preview_stops_before_bad_tail_but_full_read_rejects_it_and_cancel_still_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preview.xlsx");
        crate::table_read_cache::workbook_with_bad_tail(&path, &["资产编号", "资产名称"]);
        let first = preview_source(&path, Some("数据"), 34).unwrap();
        assert_eq!(first.2.len(), 34);
        assert_eq!(first.2[1][0], "ID-1-0");
        assert_eq!(preview_source(&path, Some("数据"), 34).unwrap(), first);
        assert!(preview_source_with_cancel(&path, Some("数据"), 34, &AtomicBool::new(true)).is_err());
        assert!(for_each_source_row(&path, Some("数据"), &AtomicBool::new(false), |_, _| Ok(())).is_err());
        assert!(preview_source(&path, Some("不存在"), 34).is_err());
    }
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
        pad_policy_test_archive(&mut archive);
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
        // 02/03/04 组（23MB–80MB）：均小于50MiB时固定普通，其余保留动态规则。
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
                let small = files_stay_in_memory(&pairs.iter().map(|(path, _)| *path).collect::<Vec<_>>());
                assert_eq!(should_use_disk_for_sheets(&pairs, 4), !small, "{je} 小文件硬规则优先，其余按低水位分流");
            });
        }
    }

    #[test]
    fn small_legacy_workbook_loads_even_when_joint_plan_marks_disk() {
        // 联合任务转入分批时，自身不大的 .xls 不应被连累成「请另存为 XLSX」，
        // 而是照常整本载入再分批建缓存。
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/Excel Merger/simple-biff8.xls");
        assert!(!legacy_workbook_needs_stream(&path), "小 .xls 不应触发流式要求");
        let mut plan = ReadPlan::default();
        plan.add(&path, true);
        let _guard = plan.enter();
        assert!(!should_use_disk(&[&path], 1), "小文件优先于联合磁盘计划");
        let (selected, sheets) = workbook_sheets(&path, None).unwrap();
        assert!(!sheets.is_empty());
        let cancel = AtomicBool::new(false);
        let mut rows = 0_usize;
        for_each_source_row(&path, Some(&selected), &cancel, |_, _| {
            rows += 1;
            Ok(())
        })
        .unwrap();
        assert!(rows > 0, "应能读出数据行");
    }

    #[test]
    #[ignore = "需要本机 Excel，并设置 AUDIT_GOLDEN_DIR 指向含 .xls 的目录"]
    fn oversized_legacy_workbook_converts_and_streams_via_excel() {
        let root = std::env::var_os("AUDIT_GOLDEN_DIR")
            .map(std::path::PathBuf::from)
            .expect("AUDIT_GOLDEN_DIR is required");
        let path = root.join("09序时账-2025.xls");
        let converted = xls_stream_copy(&path).unwrap();
        // 副本缓存生效：再次转换应直接复用同一文件。
        assert_eq!(xls_stream_copy(&path).unwrap(), converted);
        // Excel 自身转存应无损：同一读取器逐格比对原文件与副本。
        let mut before = open_workbook_auto(&path).unwrap();
        let sheet = before.sheet_names().first().unwrap().clone();
        let mut after = open_workbook_auto(&converted).unwrap();
        let original = before.worksheet_range(&sheet).unwrap();
        let copy = after.worksheet_range(&sheet).unwrap();
        assert_eq!((original.width(), original.height()), (copy.width(), copy.height()));
        for (left, right) in original.rows().zip(copy.rows()) {
            for (a, b) in left.iter().zip(right.iter()) {
                assert_eq!(crate::fx::data_text(a), crate::fx::data_text(b));
            }
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
        assert!(!decision_with_budget(&[(MIB, boundary + 1)], 1, || None));
        assert!(decision_with_budget(&[(MEMORY_ONLY_FILE_BYTES, boundary + 1)], 1, || None));
    }
    #[test]
    fn large_decompressed_or_combined_working_sets_keep_dynamic_protection() {
        // 达到 50 MiB 后才沿用展开体积、联合工作集与工具倍率的动态规则。
        for (inputs, factor) in [
            (vec![(MEMORY_ONLY_FILE_BYTES, 300 * MIB)], 1),
            (vec![(MEMORY_ONLY_FILE_BYTES, 90 * MIB), (MIB, 90 * MIB)], 1),
            (vec![(MEMORY_ONLY_FILE_BYTES, 20 * MIB)], 12),
            (vec![(2 * GIB, MIB)], 1),
        ] {
            assert!(decision_with_budget(&inputs, factor, || None));
        }
        assert!(!decision_with_budget(&[(MEMORY_ONLY_FILE_BYTES, 300 * MIB)], 1, || Some(GIB)));
        assert!(decision_with_budget(&[(MEMORY_ONLY_FILE_BYTES, 300 * MIB)], 1, || Some(256 * MIB)));
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
    fn cached_fa_projection_keeps_columns_stops_early_and_rejects_changed_source() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("清单.csv");
        fs::write(&input, "编码,名称,备注\nA1,甲,备注1\nA2,乙,备注2\n").unwrap();
        assert!(DiskTable::cached_fa(&input, "CSV", 1, 1).is_none());
        let cancel = AtomicBool::new(false);
        let _built = DiskTable::open_fa(&input, Some("CSV"), 1, 1, &|_,_,_,_|{}, &cancel).unwrap();
        let cached = DiskTable::cached_fa(&input, "CSV", 1, 1).unwrap();
        let columns = HashSet::from([1, 4]);
        let mut seen = Vec::new();
        cached.visit_columns(&columns, &cancel, |row, physical| {
            seen.push((physical, row)); Ok(())
        }).unwrap();
        assert_eq!(seen, vec![(2, vec!["", "甲", "", "", ""].into_iter().map(String::from).collect()),
            (3, vec!["", "乙", "", "", ""].into_iter().map(String::from).collect())]);
        let mut calls = 0;
        let stopped = cached.visit_columns(&columns, &cancel, |_, _| {
            calls += 1; Err(failure("SAMPLE_DONE", "已找到样例。", ""))
        }).unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(stopped.code, "SAMPLE_DONE");
        assert!(DiskTable::cached_fa(&input, "CSV", 1, 2).is_none());
        fs::write(&input, "编码,名称\n新编号,新名称\n").unwrap();
        assert!(DiskTable::cached_fa(&input, "CSV", 1, 1).is_none());
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
