//! Disk-backed CSV inspection. Never materialize the complete ledger in RAM.
use super::*;
use rusqlite::{Connection, params};

const THRESHOLD: u64 = 256 * 1024 * 1024;
const MAX_ROW: usize = 8 * 1024 * 1024;

// 纵向合并文件会保留每个来源文件的表头。看账把第一行作为字段名后，后续这些
// 表头属于结构行，不是凭证明细；在缓存访问层统一跳过，已有的大文件缓存也能直接受益。
fn is_embedded_header(headers: &[String], row: &[String]) -> bool {
    let mut nonempty = 0usize;
    let mut matched = 0usize;
    for (header, value) in headers.iter().zip(row) {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        nonempty += 1;
        if header.trim() == value {
            matched += 1;
        }
    }
    matched >= 3 && matched * 2 >= nonempty
}

fn sql_error(e: rusqlite::Error) -> AppError {
    error(
        "LEDGER_CACHE_FAILED",
        "无法读写大文件缓存，请检查磁盘剩余空间后重试。",
        Some(e.to_string()),
    )
}

pub(super) fn applies(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        ["csv", "txt", "tsv"]
            .iter()
            .any(|ext| s.eq_ignore_ascii_case(ext))
    }) && fs::metadata(path).is_ok_and(|m| m.len() >= THRESHOLD)
}

pub(super) fn full_table_error() -> AppError {
    error(
        "KANZHANG_MEMORY_BUDGET",
        "该文件必须使用低内存磁盘流程，已阻止旧的整表内存读取以保护电脑。请从看账页面重新发起筛选或导出。",
        None,
    )
}

pub(super) struct Cache {
    pub(super) db: Connection,
    pub table: Table,
    pub count: usize,
}

fn open(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path).map_err(sql_error)?;
    let cache_kib = crate::resource_budget::budget()?.sqlite_cache_kib;
    db.execute_batch(&format!("PRAGMA cache_size=-{cache_kib}; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;"))
        .map_err(sql_error)?;
    Ok(db)
}

pub(super) fn load(
    source: &SourceParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Cache, AppError> {
    check_cancel(cancel)?;
    let source_path = Path::new(&source.input_path);
    let key = fingerprint(source_path, "CSV", source.header_row)?;
    let path = cache_path("kanzhang-stream", &key)?.with_extension("sqlite");
    fs::create_dir_all(path.parent().unwrap()).map_err(io_error)?;
    if path.is_file() {
        let cached = read_cache(&path, source_path);
        if let Ok(cache) = cached {
            touch_cache(&path);
            return Ok(cache);
        }
    }
    crate::resource_budget::check_disk_space(
        path.parent().unwrap(),
        fs::metadata(source_path)
            .map_err(io_error)?
            .len()
            .saturating_mul(3),
    )?;
    // Each attempt owns its partial file. A cancellation never publishes it.
    let partial = path.with_extension(format!("{}.partial", uuid::Uuid::new_v4()));
    let result = build(&partial, source, progress, cancel).and_then(|()| {
        if fingerprint(source_path, "CSV", source.header_row)? != key {
            return Err(error(
                "SOURCE_CHANGED",
                "读取期间源文件发生变化，请重新读取。",
                None,
            ));
        }
        check_cancel(cancel)?;
        replace_file(&partial, &path)?;
        read_cache(&path, source_path)
    });
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

fn build(
    path: &Path,
    source: &SourceParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut db = open(path)?;
    // This is an unpublished derived cache; incomplete writes are discarded.
    db.execute_batch(
        "CREATE TABLE rows(data TEXT NOT NULL); CREATE TABLE meta(value TEXT NOT NULL);",
    )
    .map_err(sql_error)?;
    let transaction = db.transaction().map_err(sql_error)?;
    let mut insert = transaction
        .prepare("INSERT INTO rows VALUES (?1)")
        .map_err(sql_error)?;
    let mut header = None;
    let mut width = 0;
    let mut count = 0usize;
    let mut index = 0usize;
    let mut last_progress = Instant::now();
    progress("read", 0, 0, "正在低内存读取 CSV，数据将分批存入磁盘缓存…");
    crate::spreadsheet_input::for_each_text_row_bounded(
        Path::new(&source.input_path),
        cancel,
        MAX_ROW,
        |row| {
            if index % 1000 == 0 {
                crate::resource_budget::check_available()?;
            }
            let bytes = row
                .iter()
                .map(|s| s.len() + std::mem::size_of::<String>())
                .sum::<usize>();
            if bytes > MAX_ROW {
                return Err(error(
                    "CSV_ROW_TOO_LARGE",
                    "CSV 单行数据超过安全预算，请检查是否存在异常长字段或缺失引号。",
                    None,
                ));
            }
            width = width.max(row.len());
            if index == source.header_row.saturating_sub(1) {
                header = Some(row);
            } else if index >= source.header_row.max(1) {
                let text = serde_json::to_string(&row).map_err(|e| {
                    error(
                        "LEDGER_CACHE_FAILED",
                        "无法编码缓存行。",
                        Some(e.to_string()),
                    )
                })?;
                insert.execute([text]).map_err(sql_error)?;
                count += 1;
            }
            index += 1;
            if last_progress.elapsed() >= Duration::from_millis(500) {
                progress(
                    "read",
                    count,
                    0,
                    &format!("低内存读取中：已缓存 {count} 行，可随时取消。"),
                );
                last_progress = Instant::now();
            }
            Ok(())
        },
    )?;
    let header = header.ok_or_else(|| error("HEADER_ROW_INVALID", "标题行超出数据范围。", None))?;
    let (encoding, delimiter) =
        crate::spreadsheet_input::text_metadata(Path::new(&source.input_path))?;
    let metadata = json!({"version":1,"headers":normalize_headers(&header, width),"rows":count,"encoding":encoding,"delimiter":delimiter});
    drop(insert);
    transaction
        .execute("INSERT INTO meta VALUES (?1)", [metadata.to_string()])
        .map_err(sql_error)?;
    check_cancel(cancel)?;
    transaction.commit().map_err(sql_error)?;
    Ok(())
}

fn read_cache(path: &Path, source: &Path) -> Result<Cache, AppError> {
    let db = open(path)?;
    let text: String = db
        .query_row("SELECT value FROM meta", [], |r| r.get(0))
        .map_err(sql_error)?;
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        error(
            "LEDGER_CACHE_FAILED",
            "大文件缓存已损坏。",
            Some(e.to_string()),
        )
    })?;
    if value["version"] != 1 {
        return Err(error(
            "LEDGER_CACHE_FAILED",
            "缓存版本已过期，请重新读取。",
            None,
        ));
    }
    let headers: Vec<String> = serde_json::from_value(value["headers"].clone())
        .map_err(|e| error("LEDGER_CACHE_FAILED", "缓存标题无效。", Some(e.to_string())))?;
    let count = value["rows"]
        .as_u64()
        .ok_or_else(|| error("LEDGER_CACHE_FAILED", "缓存行数无效。", None))?
        as usize;
    let mut cache = Cache {
        db,
        count,
        table: Table {
            path: source.to_path_buf(),
            sheet: "CSV".into(),
            headers,
            rows: Vec::new(),
            sheets: Vec::new(),
            encoding: value["encoding"].as_str().map(str::to_owned),
            delimiter: value["delimiter"].as_str().and_then(|s| s.chars().next()),
        },
    };
    let mut rows = Vec::new();
    cache.visit(Some(50), &AtomicBool::new(false), |row, _| {
        rows.push(row);
        Ok(())
    })?;
    cache.table.rows = rows;
    Ok(cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("kanzhang-stream-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn disk_rows_and_accounts_preserve_csv_semantics() {
        let root = fixture();
        let input = root.join("source.csv");
        let db = root.join("cache.sqlite");
        fs::write(&input, "说明,,,,,\n凭证号,科目编码,科目名称,借方,贷方\n0001,1001,现金,1.20,0\n0001,1001,现金,0,1.20\n0002,6601,\"销售\n费用\",3,0,尾列\n0003,1002,银行\n").unwrap();
        let source = SourceParams {
            input_path: input.to_string_lossy().into_owned(),
            sheet: None,
            header_row: 2,
        };
        build(&db, &source, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let cache = read_cache(&db, &input).unwrap();
        let ordinary = load_text(&input, 2).unwrap();
        let mut rows = Vec::new();
        cache
            .visit(None, &AtomicBool::new(false), |row, _| {
                rows.push(row);
                Ok(())
            })
            .unwrap();
        assert_eq!(cache.table.headers, ordinary.headers);
        assert_eq!(rows, ordinary.rows);
        assert_eq!(cache.count, 4);
        let mapping = LedgerMapping {
            account_code: Some("科目编码".into()),
            account_name: vec!["科目名称".into()],
            ..Default::default()
        };
        let expected = account_values(&ordinary, &mapping, "", &[]);
        let actual = cache
            .accounts(
                &mapping,
                "",
                &[],
                100,
                &|_, _, _, _| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(actual["values"], json!(expected.0));
        assert_eq!(actual["codes"], json!(expected.1));
        let filtered = cache
            .accounts(
                &mapping,
                "",
                &["10".into()],
                1,
                &|_, _, _, _| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(filtered["total"], 2);
        assert_eq!(filtered["truncated"], true);
        let changed_non_account_mapping = LedgerMapping {
            amount: Some("借方".into()),
            ..mapping.clone()
        };
        let rescanned = std::cell::Cell::new(false);
        cache
            .accounts(
                &changed_non_account_mapping,
                "",
                &[],
                100,
                &|phase, current, total, _| {
                    rescanned.set(rescanned.get() || phase == "accounts" && current < total);
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(!rescanned.get(), "非科目映射变化不应重新扫描科目索引");
        let index_count: i64 = cache
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'accounts_v3_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
        drop(cache);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_build_does_not_publish_cache() {
        let root = fixture();
        let input = root.join("source.csv");
        fs::write(&input, "凭证号,金额\n1,1\n").unwrap();
        let source = SourceParams {
            input_path: input.to_string_lossy().into_owned(),
            sheet: None,
            header_row: 1,
        };
        assert!(load(&source, &|_, _, _, _| {}, &AtomicBool::new(true)).is_err());
        let key = fingerprint(&input, "CSV", 1).unwrap();
        assert!(
            !cache_path("kanzhang-stream", &key)
                .unwrap()
                .with_extension("sqlite")
                .exists()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oversized_csv_record_stops_before_unbounded_allocation() {
        let root = fixture();
        let input = root.join("source.csv");
        fs::write(&input, format!("a,b\n\"{}", "x".repeat(32768))).unwrap();
        let result = crate::spreadsheet_input::for_each_text_row_bounded(
            &input,
            &AtomicBool::new(false),
            1024,
            |_| Ok(()),
        );
        assert!(result.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn embedded_headers_are_skipped_without_rebuilding_the_cache() {
        use std::cell::RefCell;
        let root = fixture();
        let input = root.join("merged.csv");
        let db = root.join("cache.sqlite");
        fs::write(
            &input,
            "来源,凭证号,科目编码,金额\na.csv,1,1001,10\n来源,凭证号,科目编码,金额\nb.csv,2,6601,-10\n",
        )
        .unwrap();
        let source = SourceParams {
            input_path: input.to_string_lossy().into_owned(),
            sheet: None,
            header_row: 1,
        };
        build(&db, &source, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let cache = read_cache(&db, &input).unwrap();
        let mut rows = Vec::new();
        cache
            .visit(None, &AtomicBool::new(false), |row, index| {
                rows.push((index, row));
                Ok(())
            })
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, 0);
        assert_eq!(rows[1].0, 2);
        assert_eq!(rows[1].1[1], "2");

        let mapping = LedgerMapping {
            account_code: Some("科目编码".into()),
            ..Default::default()
        };
        let progress_events = RefCell::new(Vec::new());
        let accounts = cache
            .accounts(
                &mapping,
                "",
                &[],
                10,
                &|phase, current, total, _| {
                    progress_events
                        .borrow_mut()
                        .push((phase.to_owned(), current, total));
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(accounts["values"], json!(["1001", "6601"]));
        assert!(
            progress_events
                .borrow()
                .iter()
                .any(|(phase, current, total)| phase == "accounts" && current == total)
        );
        drop(cache);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_csv_cannot_fall_back_to_whole_table_loading() {
        let root = fixture();
        let input = root.join("large.csv");
        File::create(&input).unwrap().set_len(THRESHOLD).unwrap();
        let err = load_ledger_cached(&input, None, 1).unwrap_err();
        assert_eq!(err.code, "KANZHANG_MEMORY_BUDGET");
        fs::remove_dir_all(root).unwrap();
    }
}

impl Cache {
    pub fn visit(
        &self,
        limit: Option<usize>,
        cancel: &AtomicBool,
        mut visit: impl FnMut(Vec<String>, usize) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut statement = self
            .db
            .prepare("SELECT data FROM rows ORDER BY rowid LIMIT ?1")
            .map_err(sql_error)?;
        let mut cursor = statement
            .query([limit.map(|n| n as i64).unwrap_or(-1)])
            .map_err(sql_error)?;
        let mut index = 0;
        while let Some(record) = cursor.next().map_err(sql_error)? {
            if index % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            let text: String = record.get(0).map_err(sql_error)?;
            let mut row: Vec<String> = serde_json::from_str(&text).map_err(|e| {
                error(
                    "LEDGER_CACHE_FAILED",
                    "缓存数据损坏，请重新读取源文件。",
                    Some(e.to_string()),
                )
            })?;
            row.resize(self.table.headers.len(), String::new());
            if is_embedded_header(&self.table.headers, &row) {
                index += 1;
                continue;
            }
            visit(row, index)?;
            index += 1;
        }
        Ok(())
    }

    pub fn accounts(
        &self,
        mapping: &LedgerMapping,
        keyword: &str,
        prefixes: &[String],
        limit: usize,
        progress: Progress<'_>,
        cancel: &AtomicBool,
    ) -> Result<Value, AppError> {
        // 科目索引只依赖科目列。借贷、日期等映射被 LLM 调整后仍可直接复用，
        // 避免从第一步进入第二步时再次扫描数十亿字节。
        let account_columns = mapping.account_columns();
        let identity = hex::encode(Sha256::digest(serde_json::to_vec(&account_columns).map_err(
            |e| {
                error(
                    "INVALID_MAPPING",
                    "字段映射格式不正确。",
                    Some(e.to_string()),
                )
            },
        )?));
        let name = format!("accounts_v3_{identity}");
        let indexes = account_columns
            .iter()
            .filter_map(|s| header_index(&self.table.headers, s))
            .collect::<Vec<_>>();
        let code = mapping
            .account_code
            .as_deref()
            .and_then(|s| header_index(&self.table.headers, s));
        let primary = mapping
            .account_name
            .first()
            .and_then(|s| header_index(&self.table.headers, s));
        let lower = keyword.trim().to_lowercase();
        let mut exists: bool = self
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                [&name],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if !exists {
            // alpha.49/50 的 v2 索引以完整映射命名。若当前完整映射已有索引，
            // 原子改名到稳定键，升级后也无需重新扫 6GB 行缓存。
            let legacy_identity = hex::encode(Sha256::digest(
                serde_json::to_vec(mapping).map_err(|e| {
                    error(
                        "INVALID_MAPPING",
                        "字段映射格式不正确。",
                        Some(e.to_string()),
                    )
                })?,
            ));
            let legacy_name = format!("accounts_v2_{legacy_identity}");
            let legacy_exists: bool = self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
                    [&legacy_name],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            if legacy_exists {
                self.db
                    .execute_batch(&format!("ALTER TABLE {legacy_name} RENAME TO {name}"))
                    .map_err(sql_error)?;
                exists = true;
                progress(
                    "accounts",
                    self.count,
                    self.count,
                    "已复用第一步生成的科目索引。",
                );
            }
        }
        if !exists {
            let transaction = self.db.unchecked_transaction().map_err(sql_error)?;
            transaction.execute_batch(&format!("CREATE TABLE {name}(value TEXT PRIMARY KEY COLLATE BINARY,code TEXT,primary_name TEXT);")).map_err(sql_error)?;
            let mut insert = transaction
                .prepare(&format!("INSERT OR IGNORE INTO {name} VALUES (?1,?2,?3)"))
                .map_err(sql_error)?;
            self.visit(None, cancel, |row, index| {
                if index % 10_000 == 0 {
                    progress(
                        "accounts",
                        index,
                        self.count,
                        &format!(
                            "正在从磁盘缓存汇总科目：已扫描 {} / {} 行…",
                            index, self.count
                        ),
                    );
                }
                let value = joined_account(&row, &indexes);
                if value.trim().is_empty() {
                    return Ok(());
                }
                let code = code
                    .and_then(|i| row.get(i))
                    .map(|s| s.trim())
                    .unwrap_or("");
                let name = primary
                    .and_then(|i| row.get(i))
                    .map(|s| s.trim())
                    .unwrap_or("");
                // Filter AFTER deduplication: first occurrence supplies code/name.
                insert
                    .execute(params![value, code, name])
                    .map_err(sql_error)?;
                Ok(())
            })?;
            drop(insert);
            check_cancel(cancel)?;
            transaction.commit().map_err(sql_error)?;
            progress(
                "accounts",
                self.count,
                self.count,
                "科目索引已生成，正在读取结果…",
            );
        }
        let mut values = Vec::new();
        let mut codes = Vec::new();
        let mut names = Vec::new();
        let mut total = 0;
        let mut bytes = 0usize;
        let mut stmt = self
            .db
            .prepare(&format!(
                "SELECT value,code,primary_name FROM {name} ORDER BY value COLLATE BINARY"
            ))
            .map_err(sql_error)?;
        let mut cursor = stmt.query([]).map_err(sql_error)?;
        while let Some(row) = cursor.next().map_err(sql_error)? {
            if total % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            let value: String = row.get(0).map_err(sql_error)?;
            let code: String = row.get(1).map_err(sql_error)?;
            if (!lower.is_empty()
                && !value.to_lowercase().contains(&lower)
                && !code.to_lowercase().contains(&lower))
                || (!prefixes.is_empty() && !matches_code_prefix(&code, &value, prefixes))
            {
                continue;
            }
            total += 1;
            if values.len() < limit {
                let name: String = row.get(2).map_err(sql_error)?;
                bytes += value.len() + code.len() + name.len();
                if bytes > 16 * 1024 * 1024 {
                    return Err(error(
                        "KANZHANG_RESULT_TOO_LARGE",
                        "科目列表超过安全预算，请检查科目映射或缩小查询范围。",
                        None,
                    ));
                }
                values.push(value);
                codes.push(code);
                names.push(name);
            }
        }
        Ok(
            json!({"engine":"rust-polars","values":values,"codes":codes,"primaryNames":names,"total":total,"truncated":total>limit}),
        )
    }
}
