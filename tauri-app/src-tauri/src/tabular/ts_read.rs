use super::*;
use calamine::{DataRef, Xlsx, XlsxError};
use polars_io::parquet::write::BatchedWriter;
use std::io::{Read, Seek};

const PREVIEW_ROWS: usize = 20;
const PROGRESS_TOTAL: usize = 10_000;

pub(super) fn inspect(
    source: SourceParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let started = Instant::now();
    let path = Path::new(&source.input_path);
    progress("read", 0, PROGRESS_TOTAL, "正在核对工时表与读取缓存…");
    check_cancel(cancel)?;
    let (mut sheet, mut sheets, mut cache, mut key) = ts_cache_identity(
        path,
        source.sheet.as_deref(),
        source.header_row,
        source.header_depth,
    )?;
    let (mut preview, mut cache_hit) = (None, false);
    if cache != path && cache.is_file() {
        progress("read", 7_000, PROGRESS_TOTAL, "正在从缓存读取工时表预览…");
        match read_preview(&cache, cancel) {
            Ok(data) => {
                touch_cache(&cache);
                preview = Some(data);
                cache_hit = true;
            }
            Err(err) if err.code == "JOB_CANCELLED" => return Err(err),
            Err(_) => (),
        }
    }
    if preview.is_none() && is_ooxml(path) {
        // 保留 parquet 后缀，让缓存清理也能回收进程被强停后留下的临时文件。
        let partial = cache.with_extension(format!("{}.partial.parquet", uuid::Uuid::new_v4()));
        fs::create_dir_all(cache.parent().unwrap_or(Path::new("."))).map_err(io_error)?;
        let result = (|| {
            let data = stream_xlsx(path, &sheet, &source, &partial, progress, cancel)?;
            if data.is_some() {
                check_cancel(cancel)?;
                if fingerprint(path, &sheet, source.header_row, source.header_depth)? != key {
                    return Err(error(
                        "TS_SOURCE_CHANGED",
                        "读取期间工时表已变更，请重新加载。",
                        None,
                    ));
                }
                fs::rename(&partial, &cache).map_err(io_error)?;
            }
            Ok(data)
        })();
        let _ = fs::remove_file(&partial);
        preview = result?;
    }
    let (data, encoding, delimiter) = if let Some(data) = preview {
        (data, None, None)
    } else {
        progress("read", 0, PROGRESS_TOTAL, "正在读取工时表并建立缓存…");
        let (mut table, hit, fallback_cache) = load_ts_cached(
            path,
            Some(&sheet),
            source.header_row,
            source.header_depth,
            true,
        )?;
        cache_hit = hit;
        cache = fallback_cache;
        sheet = table.sheet;
        sheets = table.sheets;
        key = fingerprint(path, &sheet, source.header_row, source.header_depth)?;
        let (_, department) = ts_default_filter(&table.headers, &table.rows);
        let rows = table.rows.len();
        table.rows.truncate(PREVIEW_ROWS);
        (
            Preview {
                headers: table.headers,
                rows,
                sample: table.rows,
                default_department: !department.is_empty(),
            },
            table.encoding,
            table.delimiter,
        )
    };
    let mut defaults = ts_defaults(&data.headers);
    let department = data
        .default_department
        .then(|| header_alias(&data.headers, TS_DEPARTMENT_ALIASES))
        .flatten();
    defaults["filterValue"] = json!(if department.is_some() {
        TS_DEFAULT_DEPARTMENT_VALUE
    } else {
        ""
    });
    defaults["filterField"] = json!(department.unwrap_or_default());
    Ok(json!({
        "engine":"rust-polars", "sourceFingerprint":key, "headerDepth":source.header_depth,
        "path":path, "sheets":sheets, "selectedSheet":sheet,
        "headers":data.headers, "preview":data.sample,
        "dimensions":{"rows":data.rows,"columns":data.headers.len()},
        "encoding":encoding, "delimiter":delimiter.map(|v|v.to_string()),
        "defaults":defaults, "cacheHit":cache_hit, "cachePath":cache,
        "timings":{"readMs":started.elapsed().as_millis()}
    }))
}

struct Preview {
    headers: Vec<String>,
    rows: usize,
    sample: Vec<Vec<String>>,
    default_department: bool,
}

fn read_preview(path: &Path, cancel: &AtomicBool) -> Result<Preview, AppError> {
    let file = File::open(path).map_err(io_error)?;
    let mut reader = ParquetReader::new(file.try_clone().map_err(io_error)?);
    let rows = reader.num_rows().map_err(polars_error)?;
    let metadata = reader.get_metadata().map_err(polars_error)?.clone();
    let frame = reader
        .with_slice(Some((0, PREVIEW_ROWS)))
        .finish()
        .map_err(polars_error)?;
    let headers: Vec<String> = frame
        .get_column_names()
        .iter()
        .map(ToString::to_string)
        .collect();
    let mut default_department = false;
    if let Some(field) = header_alias(&headers, TS_DEPARTMENT_ALIASES) {
        default_department = has_default_department(&frame, &field)?;
        if !default_department && rows > PREVIEW_ROWS {
            check_cancel(cancel)?;
            let mut reader = ParquetReader::new(file)
                .with_columns(Some(vec![field.clone()]))
                .with_slice(Some((PREVIEW_ROWS, rows - PREVIEW_ROWS)));
            reader.set_metadata(metadata);
            default_department =
                has_default_department(&reader.finish().map_err(polars_error)?, &field)?;
        }
    }
    check_cancel(cancel)?;
    Ok(Preview {
        headers,
        rows,
        sample: frame_string_rows(&frame, PREVIEW_ROWS),
        default_department,
    })
}

fn has_default_department(frame: &DataFrame, field: &str) -> Result<bool, AppError> {
    let column = frame
        .column(field)
        .map_err(polars_error)?
        .as_materialized_series();
    if let Ok(values) = column.str() {
        Ok(values
            .iter()
            .flatten()
            .any(|value| value == TS_DEFAULT_DEPARTMENT_VALUE))
    } else {
        Ok((0..frame.height()).any(|index| {
            column
                .get(index)
                .is_ok_and(|value| any_to_string(&value) == TS_DEFAULT_DEPARTMENT_VALUE)
        }))
    }
}

/// 单遍解码工作表，直接填充列缓冲，每组写完即释放。表头宽度取实际单元格，
/// 不用可能带格式空列的 dimension。迟出现的额外列或乱序单元格走兼容读取。
fn stream_xlsx(
    path: &Path,
    sheet: &str,
    source: &SourceParams,
    partial: &Path,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Option<Preview>, AppError> {
    let file = File::open(path).map_err(io_error)?;
    let size = file.metadata().map_err(io_error)?.len().max(1);
    let workbook_error = |err: XlsxError| {
        check_cancel(cancel).err().unwrap_or_else(|| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工时表工作簿或指定 Sheet。",
                Some(err.to_string()),
            )
        })
    };
    progress("read", 300, PROGRESS_TOTAL, "正在打开工作簿并加载共享文本…");
    let mut workbook = Xlsx::new(TrackedFile {
        // 顺序缓冲远程 ZIP 的小块读取，无需先把整个共享文件复制到本机。
        file: BufReader::with_capacity(1024 * 1024, file),
        size,
        seen: 0,
        last_report: Instant::now(),
        progress,
        cancel,
    })
    .map_err(workbook_error)?;
    let mut reader = match workbook.worksheet_cells_reader(sheet) {
        Ok(reader) => reader,
        Err(XlsxError::NotAWorksheet(_)) => return Ok(None),
        Err(err) => return Err(workbook_error(err)),
    };
    let header_start = source.header_row.saturating_sub(1);
    let header_depth = source.header_depth.max(1);
    let data_start = header_start.saturating_add(header_depth);
    let mut batch_start = data_start;
    let mut cache = XlsxCache::new(partial);
    let mut last: Option<(usize, usize)> = None;
    let mut batch_rows = 16_384;
    while let Some(cell) = reader.next_cell().map_err(workbook_error)? {
        let value = cell.get_value();
        if matches!(value, DataRef::Empty) {
            continue;
        }
        let (row, col) = cell.get_position();
        let (row, col) = (row as usize, col as usize);
        if last.is_some_and(|last| (row, col) <= last) || col >= 16_384 || row >= 1_048_576 {
            return Ok(None);
        }
        if col >= cache.columns.len() {
            if cache.writer.is_some() {
                return Ok(None);
            }
            cache.columns.resize_with(col + 1, XlsxColumn::new);
            let buffered_rows = last.map_or(0, |(row, _)| (row + 1).saturating_sub(batch_start));
            batch_rows = batch_capacity(cache.columns.len()).max(buffered_rows);
        }
        last = Some((row, col));
        if row < data_start {
            if row >= header_start {
                let index = row - header_start;
                if index >= cache.raw_headers.len() {
                    cache.raw_headers.resize_with(index + 1, Vec::new);
                }
                let values = &mut cache.raw_headers[index];
                values.resize(col + 1, String::new());
                values[col] = data_text(&value.clone().into());
            }
            continue;
        }
        while row - batch_start >= batch_rows {
            cache.flush(batch_rows, header_depth, cancel)?;
            batch_start += batch_rows;
            batch_rows = batch_capacity(cache.columns.len());
        }
        let column = &mut cache.columns[col];
        column.fill_to(row - batch_start);
        match value {
            DataRef::SharedString(value) => column.builder.append_value(value),
            DataRef::String(value) => column.builder.append_value(value),
            other => column
                .builder
                .append_value(data_text(&other.clone().into())),
        }
        column.len += 1;
    }
    check_cancel(cancel)?;
    let physical_rows = last.map_or(0, |(row, _)| row + 1);
    if physical_rows <= header_start {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    progress("cache", 9_600, PROGRESS_TOTAL, "正在完成读取缓存…");
    cache.flush(
        physical_rows.saturating_sub(batch_start),
        header_depth.min(physical_rows - header_start),
        cancel,
    )?;
    if let Some(writer) = cache.writer.take() {
        writer.finish().map_err(polars_error)?;
    }
    Ok(Some(cache.preview))
}

fn batch_capacity(width: usize) -> usize {
    (2_000_000 / width).min(16_384)
}

struct XlsxCache<'a> {
    path: &'a Path,
    raw_headers: Vec<Vec<String>>,
    columns: Vec<XlsxColumn>,
    writer: Option<BatchedWriter<File>>,
    department: Option<String>,
    preview: Preview,
}

impl<'a> XlsxCache<'a> {
    fn new(path: &'a Path) -> Self {
        Self {
            path,
            raw_headers: Vec::new(),
            columns: Vec::new(),
            writer: None,
            department: None,
            preview: Preview {
                headers: Vec::new(),
                rows: 0,
                sample: Vec::new(),
                default_department: false,
            },
        }
    }

    fn flush(
        &mut self,
        len: usize,
        header_depth: usize,
        cancel: &AtomicBool,
    ) -> Result<(), AppError> {
        check_cancel(cancel)?;
        if self.writer.is_none() {
            self.raw_headers.resize_with(header_depth, Vec::new);
            self.preview.headers = crate::fx::merge_headers(&self.raw_headers, self.columns.len());
            self.department = header_alias(&self.preview.headers, TS_DEPARTMENT_ALIASES);
        }
        let columns = self
            .columns
            .iter_mut()
            .zip(&self.preview.headers)
            .map(|(column, name)| {
                let mut column = std::mem::replace(column, XlsxColumn::new());
                column.fill_to(len);
                column
                    .builder
                    .finish()
                    .into_column()
                    .with_name(name.as_str().into())
            })
            .collect();
        let frame = DataFrame::new(len, columns).map_err(polars_error)?;
        if self.preview.sample.len() < PREVIEW_ROWS {
            self.preview.sample.extend(frame_string_rows(
                &frame,
                PREVIEW_ROWS - self.preview.sample.len(),
            ));
        }
        if !self.preview.default_department {
            if let Some(field) = &self.department {
                self.preview.default_department = has_default_department(&frame, field)?;
            }
        }
        let writer = match &mut self.writer {
            Some(writer) => writer,
            slot => slot.insert(
                ParquetWriter::new(File::create(self.path).map_err(io_error)?)
                    .batched(frame.schema())
                    .map_err(polars_error)?,
            ),
        };
        writer.write_batch(&frame).map_err(polars_error)?;
        self.preview.rows += len;
        Ok(())
    }
}

struct XlsxColumn {
    builder: StringChunkedBuilder,
    len: usize,
}

impl XlsxColumn {
    fn new() -> Self {
        Self {
            builder: StringChunkedBuilder::new(PlSmallStr::EMPTY, 0),
            len: 0,
        }
    }

    fn fill_to(&mut self, len: usize) {
        while self.len < len {
            self.builder.append_value("");
            self.len += 1;
        }
    }
}

struct TrackedFile<'a> {
    file: BufReader<File>,
    size: u64,
    seen: u64,
    last_report: Instant,
    progress: Progress<'a>,
    cancel: &'a AtomicBool,
}

impl Read for TrackedFile<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("任务已取消"));
        }
        let count = self.file.read(buf)?;
        self.seen += count as u64;
        if count != 0 && self.last_report.elapsed() >= Duration::from_millis(300) {
            self.last_report = Instant::now();
            let fraction = (self.seen as f64 / self.size as f64).min(1.0);
            (self.progress)(
                "read",
                300 + (9_200.0 * fraction) as usize,
                PROGRESS_TOTAL,
                "正在解析工作表并分批写入读取缓存…",
            );
        }
        Ok(count)
    }
}

impl Seek for TrackedFile<'_> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_inspect_streams_xlsx_and_reuses_the_same_cache() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("工时.xlsx");
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet
            .write_string(1, 1, "Employee Department Name")
            .unwrap();
        sheet.write_string(1, 2, "Charge Hours").unwrap();
        sheet.write_string(1, 3, "Transaction Cycle Date").unwrap();
        sheet.write_string(2, 1, "  保留空格  ").unwrap();
        sheet
            .write_formula(2, 2, rust_xlsxwriter::Formula::new("1+2").set_result("3"))
            .unwrap();
        let date = rust_xlsxwriter::ExcelDateTime::from_ymd(2026, 10, 30).unwrap();
        sheet
            .write_datetime_with_format(2, 3, date, &Format::new().set_num_format("yyyy-mm-dd"))
            .unwrap();
        sheet
            .write_string(16_390, 1, TS_DEFAULT_DEPARTMENT_VALUE)
            .unwrap();
        sheet
            .write_blank(16_400, 9, &Format::new().set_bold())
            .unwrap();
        workbook.save(&input).unwrap();

        let params = json!({"inputPath":input,"headerRow":2});
        let cancel = AtomicBool::new(false);
        let (_, _, cache, _) = ts_cache_identity(&input, None, 2, 1).unwrap();
        let stop_before_footer = |phase: &str, _, _, _: &str| {
            if phase == "cache" {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let error =
            inspect_ts_with_progress(params.clone(), &stop_before_footer, &cancel).unwrap_err();
        assert_eq!(error.code, "JOB_CANCELLED");
        assert!(!cache.exists());
        let partial_prefix = cache.file_stem().unwrap().to_string_lossy();
        assert!(
            !fs::read_dir(cache.parent().unwrap())
                .unwrap()
                .flatten()
                .any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(partial_prefix.as_ref())
                })
        );

        let legacy = load_table(&input, None, 2, 1).unwrap();
        let cold = inspect_ts(params.clone()).unwrap();
        let cached = load_parquet(&cache).unwrap();
        assert_eq!(cached.headers, legacy.headers);
        assert_eq!(cached.rows, legacy.rows);
        let warm = inspect_ts(params).unwrap();
        assert_eq!(cold["cacheHit"], false);
        assert_eq!(warm["cacheHit"], true);
        for key in [
            "preview",
            "headers",
            "dimensions",
            "defaults",
            "sourceFingerprint",
        ] {
            assert_eq!(cold[key], warm[key], "{key}");
        }
        assert_eq!(warm["defaults"]["filterValue"], TS_DEFAULT_DEPARTMENT_VALUE);
        fs::remove_file(cache).unwrap();
    }

    #[test]
    fn ts_inspect_preserves_columns_that_first_appear_after_a_batch() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("表尾新列.xlsx");
        let mut workbook = Workbook::new();
        let sheet = workbook.add_worksheet();
        sheet.write_string(0, 0, "上层").unwrap();
        sheet.write_string(1, 0, "下层").unwrap();
        sheet.write_number(16_400, 0, 12).unwrap();
        sheet.write_string(16_400, 1, "表尾").unwrap();
        workbook.save(&input).unwrap();
        let result = inspect_ts(json!({"inputPath":input,"headerDepth":2})).unwrap();
        let cache = Path::new(result["cachePath"].as_str().unwrap());
        let legacy = load_table(&input, None, 1, 2).unwrap();
        let cached = load_parquet(cache).unwrap();
        assert_eq!(cached.headers, legacy.headers);
        assert_eq!(cached.rows, legacy.rows);
        assert_eq!(cached.rows.last().unwrap(), &["12", "表尾"]);
        fs::remove_file(cache).unwrap();
    }
}
