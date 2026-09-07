//! Bounded-memory ledger analysis. Detail rows, voucher membership and aggregates
//! remain in SQLite; only one voucher and the minimal classification sets are
//! resident. The latter are guarded by the caller's dynamic memory budget.
use super::disk_ledger::DiskLedger;
use super::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::thread;

pub(super) struct DiskSuiteResult {
    pub summary: PivotResult,
    pub loss_count: usize,
    pub voucher_count: usize,
    pub overflow_paths: Vec<PathBuf>,
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, accounts: &[(&str, f64)], targets: &[&str]) -> VoucherInfo {
        let account_nets = accounts
            .iter()
            .map(|(a, n)| (a.to_string(), *n))
            .collect::<BTreeMap<_, _>>();
        let nonzero_accounts = account_nets
            .iter()
            .filter(|(_, n)| round_to_cent(**n) != 0.0)
            .map(|(a, _)| a.clone())
            .collect();
        let target_signs = targets
            .iter()
            .filter_map(|target| {
                account_nets
                    .get(*target)
                    .map(|n| (target.to_string(), if *n > 0.0 { 1 } else { -1 }))
            })
            .collect();
        VoucherInfo {
            id: id.into(),
            account_nets,
            nonzero_accounts,
            target_signs,
            summaries: Vec::new(),
            month_nets: BTreeMap::new(),
        }
    }

    fn disk_groups(infos: &[VoucherInfo], strict: bool) -> Vec<Vec<usize>> {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE suite_shapes(seq INTEGER PRIMARY KEY,id TEXT,full TEXT,signs TEXT);",
        )
        .unwrap();
        for (index, info) in infos.iter().enumerate() {
            db.execute(
                "INSERT INTO suite_shapes VALUES(?1,?2,?3,?4)",
                params![
                    index as i64,
                    info.id,
                    encode(&info.nonzero_accounts).unwrap(),
                    encode(&info.target_signs).unwrap()
                ],
            )
            .unwrap();
        }
        classify(&db, strict, 64 * 1024 * 1024, &AtomicBool::new(false)).unwrap();
        let mut stmt = db
            .prepare("SELECT grp,seq FROM suite_members ORDER BY grp,seq")
            .unwrap();
        let pairs = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as usize))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut output = Vec::<Vec<usize>>::new();
        let mut group = None;
        for (next, index) in pairs {
            if group != Some(next) {
                output.push(Vec::new());
                group = Some(next);
            }
            output.last_mut().unwrap().push(index);
        }
        output
    }

    #[test]
    fn disk_classification_matches_memory_algorithm_for_loose_and_strict() {
        let infos = vec![
            info("001", &[("目标A", 100.0), ("对方X", -100.0)], &["目标A"]),
            info("002", &[("目标A", 20.0), ("对方X", -20.0)], &["目标A"]),
            info("003", &[("目标A", -30.0), ("对方X", 30.0)], &["目标A"]),
            info(
                "004",
                &[("目标A", 10.0), ("目标B", 20.0), ("对方X", -30.0)],
                &["目标A", "目标B"],
            ),
            info(
                "005",
                &[
                    ("目标A", 12.0),
                    ("目标B", 8.0),
                    ("对方X", -20.0),
                    ("扩展Y", 0.0),
                ],
                &["目标A", "目标B"],
            ),
        ];
        for strict in [false, true] {
            assert_eq!(
                disk_groups(&infos, strict),
                classify_vouchers(&infos, strict)
            );
        }
    }

    #[test]
    fn classification_budget_fails_cleanly() {
        let item = info(
            "001",
            &[("很长的目标科目", 1.0), ("很长的对方科目", -1.0)],
            &["很长的目标科目"],
        );
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE suite_shapes(seq INTEGER PRIMARY KEY,id TEXT,full TEXT,signs TEXT);",
        )
        .unwrap();
        db.execute(
            "INSERT INTO suite_shapes VALUES(0,?1,?2,?3)",
            params![
                item.id,
                encode(&item.nonzero_accounts).unwrap(),
                encode(&item.target_signs).unwrap()
            ],
        )
        .unwrap();
        let failure = classify(&db, false, 64, &AtomicBool::new(false)).unwrap_err();
        assert_eq!(failure.code, "KANZHANG_SUITE_MEMORY_LIMIT");
    }

    #[test]
    fn parallel_json_decode_preserves_source_order() {
        let records = (0..257)
            .map(|index| AggregateRecord {
                seq: index,
                raw: serde_json::to_string(&vec![
                    format!("凭证-{index:04}"),
                    format!("科目-{index}"),
                ])
                .unwrap(),
                id: index.to_string(),
                account: String::new(),
                net: index as f64,
            })
            .collect::<Vec<_>>();
        let serial = decode_aggregate_rows(&records, 1).unwrap();
        let parallel = decode_aggregate_rows(&records, 4).unwrap();
        assert_eq!(parallel, serial);
        assert_eq!(parallel[0][0], "凭证-0000");
        assert_eq!(parallel[256][0], "凭证-0256");
    }

    #[test]
    fn type_rows_streams_group_labels_summaries_and_months() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE suite_shapes(seq INTEGER PRIMARY KEY,id TEXT,full TEXT,signs TEXT);
             CREATE TABLE suite_nets(id TEXT,account TEXT,net REAL,PRIMARY KEY(id,account));
             CREATE TABLE suite_month(id TEXT,month TEXT,account TEXT,net REAL,PRIMARY KEY(id,month,account));
             CREATE TABLE suite_summaries(id TEXT,value TEXT,seq INTEGER,PRIMARY KEY(id,value));
             CREATE TABLE suite_output(sheet TEXT,sort_head TEXT,sort_rank INTEGER,sort_label TEXT,sort_account TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT,rowdata TEXT);",
        )
        .unwrap();
        let full = encode(&BTreeSet::from(["目标A".to_owned(), "对方X".to_owned()])).unwrap();
        let signs = encode(&BTreeMap::from([("目标A".to_owned(), 1_i8)])).unwrap();
        for (seq, id, target, other, month, summary) in [
            (0_i64, "001", 100.0, -100.0, "2026-01", "摘要一"),
            (1_i64, "002", 20.0, -20.0, "2026-02", "摘要二"),
        ] {
            db.execute(
                "INSERT INTO suite_shapes VALUES(?1,?2,?3,?4)",
                params![seq, id, full, signs],
            )
            .unwrap();
            for (account, net) in [("目标A", target), ("对方X", other)] {
                db.execute(
                    "INSERT INTO suite_nets VALUES(?1,?2,?3)",
                    params![id, account, net],
                )
                .unwrap();
                db.execute(
                    "INSERT INTO suite_month VALUES(?1,?2,?3,?4)",
                    params![id, month, account, net],
                )
                .unwrap();
            }
            db.execute(
                "INSERT INTO suite_summaries VALUES(?1,?2,?3)",
                params![id, summary, seq],
            )
            .unwrap();
        }
        for (sheet, strict) in [("凭证类型-宽松", false), ("凭证类型-严格", true)] {
            type_rows(
                &db,
                sheet,
                strict,
                64 * 1024 * 1024,
                &|_, _, _, _| {},
                0,
                &AtomicBool::new(false),
            )
            .unwrap();
            let rows = db
                .prepare("SELECT rowdata FROM suite_output WHERE sheet=?1 ORDER BY sort_account")
                .unwrap()
                .query_map([sheet], |row| row.get::<_, String>(0))
                .unwrap()
                .map(|row| serde_json::from_str::<Vec<String>>(&row.unwrap()).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(rows.len(), 2);
            assert!(
                rows.iter()
                    .all(|row| row[0] == "目标A-类型1" && row[1] == "001")
            );
            assert!(rows.iter().all(|row| row[2] == "摘要一 | 摘要二"));
            assert!(
                rows.iter()
                    .any(|row| row[3] == "目标A" && row[4..] == ["120", "100", "20"])
            );
            assert!(
                rows.iter()
                    .any(|row| row[3] == "对方X" && row[4..] == ["-120", "-100", "-20"])
            );
        }
        let root =
            std::env::temp_dir().join(format!("audit-toolbox-type-csv-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("严格.csv");
        write_type_output_csv(
            &db,
            "凭证类型-严格",
            &path,
            "凭证号",
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut reader = csv::Reader::from_path(&path).unwrap();
        let header = reader.headers().unwrap().clone();
        assert_eq!(
            header.iter().take(4).collect::<Vec<_>>(),
            ["科目名称-类型", "凭证号", "摘要", "科目名称"]
        );
        assert_eq!(header.get(header.len() - 2), Some("2026-01"));
        assert_eq!(header.get(header.len() - 1), Some("2026-02"));
        assert_eq!(reader.records().count(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn type_sheet_switches_to_csv_only_after_excel_data_row_limit() {
        assert!(!type_sheet_requires_csv(EXCEL_DATA_ROW_LIMIT));
        assert!(type_sheet_requires_csv(EXCEL_DATA_ROW_LIMIT + 1));
    }
}

fn db_error(e: rusqlite::Error) -> AppError {
    error(
        "KANZHANG_SUITE_DATABASE",
        "看账磁盘分析失败，请检查缓存磁盘空间。",
        Some(e.to_string()),
    )
}
fn json_error(e: serde_json::Error) -> AppError {
    error(
        "KANZHANG_SUITE_CACHE",
        "看账分析缓存内容无效，请重新读取源文件。",
        Some(e.to_string()),
    )
}
fn encode<T: Serialize + ?Sized>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(json_error)
}
fn guard(bytes: usize, budget: u64) -> Result<(), AppError> {
    if bytes as u64 > budget {
        return Err(error(
            "KANZHANG_SUITE_MEMORY_LIMIT",
            "此批次的凭证科目组合或透视列超过当前可用内存预算。请缩小目标科目批次或减少透视列后重试；明细筛选不受此分析限制。",
            None,
        ));
    }
    Ok(())
}
fn shape_bytes(full: &BTreeSet<String>, signs: &BTreeMap<String, i8>) -> usize {
    full.iter().map(|v| v.len() + 96).sum::<usize>()
        + signs.keys().map(|v| v.len() + 112).sum::<usize>()
}

#[derive(Clone)]
struct Shape {
    index: i64,
    id: String,
    full: BTreeSet<String>,
    signs: BTreeMap<String, i8>,
}
impl Shape {
    fn targets(&self) -> BTreeSet<String> {
        self.signs.keys().cloned().collect()
    }
}
fn visit_shapes(
    db: &Connection,
    cancel: &AtomicBool,
    mut visit: impl FnMut(Shape) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut stmt = db
        .prepare("SELECT seq,id,full,signs FROM suite_shapes ORDER BY seq")
        .map_err(db_error)?;
    let mut cursor = stmt.query([]).map_err(db_error)?;
    while let Some(row) = cursor.next().map_err(db_error)? {
        check_cancel(cancel)?;
        visit(Shape {
            index: row.get(0).map_err(db_error)?,
            id: row.get(1).map_err(db_error)?,
            full: serde_json::from_str(&row.get::<_, String>(2).map_err(db_error)?)
                .map_err(json_error)?,
            signs: serde_json::from_str(&row.get::<_, String>(3).map_err(db_error)?)
                .map_err(json_error)?,
        })?;
    }
    Ok(())
}

fn initialize(db: &Connection) -> Result<(), AppError> {
    db.execute_batch("
        DROP TABLE IF EXISTS suite_vouchers; DROP TABLE IF EXISTS suite_nets;
        DROP TABLE IF EXISTS suite_month; DROP TABLE IF EXISTS suite_summaries;
        DROP TABLE IF EXISTS suite_subject; DROP TABLE IF EXISTS suite_pivot;
        DROP TABLE IF EXISTS suite_custom; DROP TABLE IF EXISTS suite_shapes;
        DROP TABLE IF EXISTS suite_output;
        CREATE TEMP TABLE suite_vouchers(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,loss INTEGER NOT NULL);
        CREATE TEMP TABLE suite_nets(id TEXT,account TEXT,net REAL,PRIMARY KEY(id,account));
        CREATE TEMP TABLE suite_month(id TEXT,month TEXT,account TEXT,net REAL,PRIMARY KEY(id,month,account));
        CREATE TEMP TABLE suite_summaries(id TEXT,value TEXT,seq INTEGER,PRIMARY KEY(id,value));
        CREATE TEMP TABLE suite_subject(account TEXT PRIMARY KEY,net REAL,count INTEGER);
        CREATE TEMP TABLE suite_pivot(id TEXT,account TEXT,direction TEXT,net REAL,PRIMARY KEY(id,account,direction));
        CREATE TEMP TABLE suite_custom(rowkey TEXT,col TEXT,net REAL,PRIMARY KEY(rowkey,col));
        CREATE TEMP TABLE suite_shapes(seq INTEGER PRIMARY KEY,id TEXT,full TEXT,signs TEXT);
        CREATE TEMP TABLE suite_output(sheet TEXT,sort_head TEXT,sort_rank INTEGER,sort_label TEXT,sort_account TEXT,seq INTEGER PRIMARY KEY AUTOINCREMENT,rowdata TEXT);
        CREATE INDEX suite_output_sheet ON suite_output(sheet,seq);
    ").map_err(db_error)
}

struct PivotConfig {
    rows: Vec<(String, usize)>,
    columns: Vec<usize>,
    values: Vec<(String, Option<usize>)>,
    date: Option<usize>,
}

struct AggregateRecord {
    seq: i64,
    raw: String,
    id: String,
    account: String,
    net: f64,
}

fn decode_aggregate_rows(
    records: &[AggregateRecord],
    parallelism: usize,
) -> Result<Vec<Vec<String>>, AppError> {
    if parallelism <= 1 || records.len() < 64 {
        return records
            .iter()
            .map(|record| serde_json::from_str(&record.raw).map_err(json_error))
            .collect();
    }
    let chunk_size = records.len().div_ceil(parallelism);
    let decoded = thread::scope(|scope| {
        records
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    chunk
                        .iter()
                        .map(|record| serde_json::from_str::<Vec<String>>(&record.raw))
                        .collect::<Result<Vec<_>, _>>()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|worker| worker.join())
            .collect::<Vec<_>>()
    });
    let mut rows = Vec::with_capacity(records.len());
    for result in decoded {
        let chunk = result.map_err(|_| {
            error(
                "KANZHANG_SUITE_WORKER",
                "看账并行分析线程异常退出，请重试。",
                None,
            )
        })?;
        rows.extend(chunk.map_err(json_error)?);
    }
    Ok(rows)
}
impl PivotConfig {
    fn new(
        headers: &[String],
        mapping: &LedgerMapping,
        job: &KanzhangParams,
    ) -> Result<Self, AppError> {
        let rows = job
            .pivot_rows
            .iter()
            .filter_map(|s| header_index(headers, s).map(|i| (s.clone(), i)))
            .collect::<Vec<_>>();
        if !job.pivot_rows.is_empty() && rows.is_empty() {
            return Err(error(
                "KANZHANG_PIVOT_ROWS_MISSING",
                "透视配置没有有效的行字段。",
                None,
            ));
        }
        let mut values = Vec::new();
        for name in &job.pivot_values {
            if name == NET_VALUE_FIELD {
                if !values.iter().any(|(label, _)| label == name) {
                    values.push((name.clone(), None));
                }
            } else if !name.trim().is_empty() {
                if let Some(i) = header_index(headers, name) {
                    values.push((name.clone(), Some(i)));
                }
            }
        }
        if values.is_empty() {
            values.push((NET_VALUE_FIELD.into(), None));
        }
        Ok(Self {
            rows,
            columns: job
                .pivot_columns
                .iter()
                .filter_map(|s| header_index(headers, s))
                .collect(),
            values,
            date: mapping
                .date
                .as_deref()
                .and_then(|s| header_index(headers, s)),
        })
    }
}

fn aggregate(
    ledger: &DiskLedger,
    mapping: &LedgerMapping,
    targets: &[String],
    job: &KanzhangParams,
    budget: u64,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<PivotConfig, AppError> {
    let db = &ledger.db;
    let headers = &ledger.table.headers;
    let accounts = mapping
        .account_columns()
        .into_iter()
        .filter_map(|s| header_index(headers, s))
        .collect::<Vec<_>>();
    let summary = mapping
        .summary
        .as_deref()
        .and_then(|s| header_index(headers, s));
    let direction = mapping
        .direction
        .as_deref()
        .and_then(|s| header_index(headers, s));
    let config = PivotConfig::new(headers, mapping, job)?;
    let mut stmt = db.prepare(&format!("SELECT p.seq,r.data,p.voucher,p.account,p.{} FROM processed p JOIN raw_cache.rows r ON r.rowid=p.seq+1 JOIN selected s ON s.voucher=p.voucher ORDER BY p.seq", ledger.selected_net_column())).map_err(db_error)?;
    let mut cursor = stmt.query([]).map_err(db_error)?;
    let mut count = 0;
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    // These statements run once per selected ledger row. Preparing them inside
    // the loop dominated large exports (millions of rows * several statements)
    // and kept one CPU core busy compiling identical SQL. Reuse one VM for the
    // whole transaction while preserving the original row order and sums.
    let mut insert_voucher = transaction.prepare("INSERT INTO suite_vouchers VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET loss=MAX(loss,excluded.loss)").map_err(db_error)?;
    let mut insert_net = transaction.prepare("INSERT INTO suite_nets VALUES(?1,?2,?3) ON CONFLICT(id,account) DO UPDATE SET net=net+excluded.net").map_err(db_error)?;
    let mut insert_subject = transaction.prepare("INSERT INTO suite_subject VALUES(?1,?2,1) ON CONFLICT(account) DO UPDATE SET net=net+excluded.net,count=count+1").map_err(db_error)?;
    let mut insert_pivot = transaction.prepare("INSERT INTO suite_pivot VALUES(?1,?2,?3,?4) ON CONFLICT(id,account,direction) DO UPDATE SET net=net+excluded.net").map_err(db_error)?;
    let mut insert_month = transaction.prepare("INSERT INTO suite_month VALUES(?1,?2,?3,?4) ON CONFLICT(id,month,account) DO UPDATE SET net=net+excluded.net").map_err(db_error)?;
    let mut insert_summary = transaction.prepare("INSERT OR IGNORE INTO suite_summaries SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM suite_summaries WHERE id=?1)<3").map_err(db_error)?;
    let runtime_budget = crate::resource_budget::budget()?;
    let decode_batch_bytes = (runtime_budget.batch_bytes / 8).max(2 * 1024 * 1024) as usize;
    let parallelism = crate::resource_budget::recommended_parallelism()?;
    loop {
        let mut records = Vec::<AggregateRecord>::new();
        let mut raw_bytes = 0usize;
        while raw_bytes < decode_batch_bytes {
            let Some(record) = cursor.next().map_err(db_error)? else {
                break;
            };
            let raw: String = record.get(1).map_err(db_error)?;
            guard(raw.len().saturating_mul(4), budget)?;
            raw_bytes = raw_bytes.saturating_add(raw.len());
            records.push(AggregateRecord {
                seq: record.get(0).map_err(db_error)?,
                raw,
                id: record.get(2).map_err(db_error)?,
                account: record.get(3).map_err(db_error)?,
                net: record.get(4).map_err(db_error)?,
            });
        }
        if records.is_empty() {
            break;
        }
        check_cancel(cancel)?;
        let rows = decode_aggregate_rows(&records, parallelism)?;
        for (record, row) in records.iter().zip(rows.iter()) {
            let loss = job.mark_loss_transfer
                && accounts.iter().any(|i| {
                    row.get(*i)
                        .is_some_and(|s| s.contains("本年利润") || s.contains("未分配利润"))
                });
            insert_voucher
                .execute(params![&record.id, record.seq, loss])
                .map_err(db_error)?;
            insert_net
                .execute(params![&record.id, &record.account, record.net])
                .map_err(db_error)?;
            insert_subject
                .execute(params![&record.account, record.net])
                .map_err(db_error)?;
            let direction_value = direction
                .and_then(|i| row.get(i))
                .map(|s| s.trim())
                .unwrap_or("");
            insert_pivot
                .execute(params![
                    &record.id,
                    &record.account,
                    direction_value,
                    record.net
                ])
                .map_err(db_error)?;
            if let Some(month) = config
                .date
                .and_then(|i| row.get(i))
                .and_then(|s| parse_month(s))
            {
                insert_month
                    .execute(params![&record.id, month, &record.account, record.net])
                    .map_err(db_error)?;
            }
            if let Some(value) = summary
                .and_then(|i| row.get(i))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
            {
                // Only the first three distinct summaries of each voucher can ever
                // contribute to the original type-summary algorithm.
                insert_summary
                    .execute(params![&record.id, value, record.seq])
                    .map_err(db_error)?;
            }
            count += 1;
        }
        progress(
            "analyze",
            count,
            ledger.count,
            &format!(
                "正在并行汇总凭证和科目：已处理 {} 行（{} 个线程）…",
                count, parallelism
            ),
        );
    }
    drop(insert_summary);
    drop(insert_month);
    drop(insert_pivot);
    drop(insert_subject);
    drop(insert_net);
    drop(insert_voucher);
    transaction.commit().map_err(db_error)?;
    let targets = targets
        .iter()
        .map(|s| normalize_account_text(s))
        .filter(|s| !s.is_empty())
        .collect::<HashSet<_>>();
    let mut vouchers = db
        .prepare("SELECT id,seq FROM suite_vouchers WHERE loss=0 ORDER BY seq")
        .map_err(db_error)?;
    let mut cursor = vouchers.query([]).map_err(db_error)?;
    while let Some(row) = cursor.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let id: String = row.get(0).map_err(db_error)?;
        let seq: i64 = row.get(1).map_err(db_error)?;
        let mut full = BTreeSet::new();
        let mut signs = BTreeMap::new();
        let mut stmt = db
            .prepare("SELECT account,net FROM suite_nets WHERE id=?1 ORDER BY account")
            .map_err(db_error)?;
        let mut nets = stmt.query([&id]).map_err(db_error)?;
        while let Some(netrow) = nets.next().map_err(db_error)? {
            let account: String = netrow.get(0).map_err(db_error)?;
            let net = round_to_cent(netrow.get(1).map_err(db_error)?);
            if net != 0.0 {
                if targets.contains(&normalize_account_text(&account)) {
                    signs.insert(account.clone(), if net > 0.0 { 1i8 } else { -1i8 });
                }
                full.insert(account);
                guard(shape_bytes(&full, &signs), budget)?;
            }
        }
        if !signs.is_empty() {
            db.execute(
                "INSERT INTO suite_shapes VALUES(?1,?2,?3,?4)",
                params![seq, id, encode(&full)?, encode(&signs)?],
            )
            .map_err(db_error)?;
        }
    }
    // Loss status is only known after the entire voucher has been seen. Make a
    // second streaming pass for custom pivots, excluding every line of that ID.
    if !config.rows.is_empty() {
        let mut stmt = db.prepare(&format!("SELECT r.data,p.{} FROM processed p JOIN raw_cache.rows r ON r.rowid=p.seq+1 JOIN selected s ON s.voucher=p.voucher JOIN suite_vouchers v ON v.id=p.voucher WHERE v.loss=0 ORDER BY p.seq", ledger.selected_net_column())).map_err(db_error)?;
        let mut cursor = stmt.query([]).map_err(db_error)?;
        let transaction = db.unchecked_transaction().map_err(db_error)?;
        let mut insert_custom = transaction.prepare("INSERT INTO suite_custom VALUES(?1,?2,?3) ON CONFLICT(rowkey,col) DO UPDATE SET net=net+excluded.net").map_err(db_error)?;
        while let Some(record) = cursor.next().map_err(db_error)? {
            check_cancel(cancel)?;
            let raw: String = record.get(0).map_err(db_error)?;
            guard(raw.len().saturating_mul(4), budget)?;
            let row: Vec<String> = serde_json::from_str(&raw).map_err(json_error)?;
            let net: f64 = record.get(1).map_err(db_error)?;
            let key = config
                .rows
                .iter()
                .map(|(_, i)| row.get(*i).cloned().unwrap_or_default())
                .collect::<Vec<_>>();
            let base = config
                .columns
                .iter()
                .map(|i| {
                    let raw = row.get(*i).map(String::as_str).unwrap_or("");
                    if Some(*i) == config.date {
                        parse_month(raw).unwrap_or_else(|| "Unknown".into())
                    } else {
                        raw.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("-");
            for (label, index) in &config.values {
                let col = if base.is_empty() {
                    label.clone()
                } else {
                    format!("{base}-{label}")
                };
                let amount = index
                    .map(|i| parse_number(row.get(i).map(String::as_str).unwrap_or("")))
                    .unwrap_or(net);
                insert_custom
                    .execute(params![encode(&key)?, col, amount])
                    .map_err(db_error)?;
            }
        }
        drop(insert_custom);
        transaction.commit().map_err(db_error)?;
    }
    Ok(config)
}

fn root(db: &Connection, mut index: i64) -> Result<i64, AppError> {
    loop {
        let parent: i64 = db
            .query_row(
                "SELECT parent FROM suite_union WHERE seq=?1",
                [index],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if parent == index {
            return Ok(index);
        }
        let grand: i64 = db
            .query_row(
                "SELECT parent FROM suite_union WHERE seq=?1",
                [parent],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        db.execute(
            "UPDATE suite_union SET parent=?2 WHERE seq=?1",
            params![index, grand],
        )
        .map_err(db_error)?;
        index = grand;
    }
}
fn union(db: &Connection, left: i64, right: i64) -> Result<(), AppError> {
    let (left, right) = (root(db, left)?, root(db, right)?);
    if left != right {
        db.execute(
            "UPDATE suite_union SET parent=?2 WHERE seq=?1",
            params![right, left],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn minimal_sets(
    db: &Connection,
    target: bool,
    strict: bool,
    budget: u64,
    cancel: &AtomicBool,
) -> Result<Vec<BTreeSet<String>>, AppError> {
    let mut unique = BTreeSet::<BTreeSet<String>>::new();
    let mut bytes = 0usize;
    visit_shapes(db, cancel, |shape| {
        if strict && ((target && shape.signs.len() <= 1) || (!target && shape.signs.len() != 1)) {
            return Ok(());
        }
        let set = if target { shape.targets() } else { shape.full };
        if !set.is_empty() && !unique.contains(&set) {
            bytes = bytes.saturating_add(set.iter().map(|s| s.len() + 128).sum::<usize>() + 128);
            guard(bytes, budget / 4)?;
            unique.insert(set);
        }
        Ok(())
    })?;
    // A non-minimal subset always contains at least one minimal subset. Compare
    // length-ordered candidates only with the minima already retained instead
    // of scanning every unique shape for every candidate (quadratic on varied
    // ledgers). `order_base_sets` below restores the legacy output order.
    let mut candidates = unique.into_iter().collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.len().cmp(&right.len()).then_with(|| left.cmp(right)));
    let mut minimal = Vec::new();
    for candidate in candidates {
        check_cancel(cancel)?;
        if !minimal.iter().any(|other: &BTreeSet<String>| {
            other.len() < candidate.len() && other.is_subset(&candidate)
        }) {
            minimal.push(candidate);
        }
    }
    Ok(order_base_sets(&minimal))
}

// Base-group membership is kept in the disk union table. Only its seed and sign
// map are needed to exactly reproduce seed_base_group/attach_to_base_group.
fn seed(
    db: &Connection,
    stage: &str,
    base: &BTreeSet<String>,
    shape: &Shape,
) -> Result<(), AppError> {
    let base = encode(base)?;
    let mut stmt = db
        .prepare("SELECT signs FROM suite_base WHERE stage=?1 AND base=?2 ORDER BY seed")
        .map_err(db_error)?;
    let mut cursor = stmt.query(params![stage, base]).map_err(db_error)?;
    while let Some(row) = cursor.next().map_err(db_error)? {
        let signs: BTreeMap<String, i8> =
            serde_json::from_str(&row.get::<_, String>(0).map_err(db_error)?)
                .map_err(json_error)?;
        if compatible_signs(&signs, &shape.signs) {
            return Ok(());
        }
    }
    db.execute(
        "INSERT INTO suite_base VALUES(?1,?2,?3,?4)",
        params![stage, base, shape.index, encode(&shape.signs)?],
    )
    .map_err(db_error)?;
    Ok(())
}
fn attach(
    db: &Connection,
    stage: &str,
    base: &BTreeSet<String>,
    shape: &Shape,
) -> Result<(), AppError> {
    let base = encode(base)?;
    let mut stmt = db
        .prepare("SELECT seed,signs FROM suite_base WHERE stage=?1 AND base=?2 ORDER BY seed")
        .map_err(db_error)?;
    let mut cursor = stmt.query(params![stage, base]).map_err(db_error)?;
    let mut matched = None;
    while let Some(row) = cursor.next().map_err(db_error)? {
        let signs: BTreeMap<String, i8> =
            serde_json::from_str(&row.get::<_, String>(1).map_err(db_error)?)
                .map_err(json_error)?;
        if compatible_signs(&signs, &shape.signs) {
            if matched.is_some() {
                return Ok(());
            }
            matched = Some((row.get::<_, i64>(0).map_err(db_error)?, signs));
        }
    }
    if let Some((index, mut signs)) = matched {
        union(db, shape.index, index)?;
        for (account, sign) in &shape.signs {
            signs.entry(account.clone()).or_insert(*sign);
        }
        db.execute(
            "UPDATE suite_base SET signs=?4 WHERE stage=?1 AND base=?2 AND seed=?3",
            params![stage, base, index, encode(&signs)?],
        )
        .map_err(db_error)?;
    }
    Ok(())
}

fn classify(
    db: &Connection,
    strict: bool,
    budget: u64,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    db.execute_batch("DROP TABLE IF EXISTS suite_union; DROP TABLE IF EXISTS suite_base; DROP TABLE IF EXISTS suite_members;
        CREATE TEMP TABLE suite_union(seq INTEGER PRIMARY KEY,parent INTEGER);
        INSERT INTO suite_union SELECT seq,seq FROM suite_shapes;
        CREATE TEMP TABLE suite_base(stage TEXT,base TEXT,seed INTEGER,signs TEXT,PRIMARY KEY(stage,base,seed));
        CREATE TEMP TABLE suite_members(seq INTEGER PRIMARY KEY,root INTEGER,grp INTEGER);").map_err(db_error)?;
    let targets = minimal_sets(db, true, strict, budget, cancel)?;
    let fulls = minimal_sets(db, false, strict, budget, cancel)?;
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    if strict {
        visit_shapes(db, cancel, |s| {
            let t = s.targets();
            if t.len() > 1 && targets.contains(&t) {
                seed(db, "target", &t, &s)?;
            }
            if t.len() == 1 && fulls.contains(&s.full) {
                seed(db, "full", &s.full, &s)?;
            }
            Ok(())
        })?;
        visit_shapes(db, cancel, |s| {
            if s.signs.len() > 1 {
                if let Some(base) = pick_base_set(&targets, &s.targets()) {
                    attach(db, "target", base, &s)?;
                }
            } else if let Some(base) = pick_base_set(&fulls, &s.full) {
                attach(db, "full", base, &s)?;
            }
            Ok(())
        })?;
        // Exact-set fallback compares every later member with the first member,
        // never with the accumulated group's signs (legacy strict semantics).
        db.execute_batch("DROP TABLE IF EXISTS suite_fallback; CREATE TEMP TABLE suite_fallback(full TEXT PRIMARY KEY,seq INTEGER,signs TEXT);").map_err(db_error)?;
        visit_shapes(db, cancel, |s| {
            if s.signs.len() != 1 {
                return Ok(());
            }
            let full = encode(&s.full)?;
            let first: Option<(i64, String)> = db
                .query_row(
                    "SELECT seq,signs FROM suite_fallback WHERE full=?1",
                    [&full],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            if let Some((index, raw)) = first {
                let signs = serde_json::from_str(&raw).map_err(json_error)?;
                if compatible_signs(&signs, &s.signs) && compatible_signs(&s.signs, &signs) {
                    union(db, index, s.index)?;
                }
            } else {
                db.execute(
                    "INSERT INTO suite_fallback VALUES(?1,?2,?3)",
                    params![full, s.index, encode(&s.signs)?],
                )
                .map_err(db_error)?;
            }
            Ok(())
        })?;
    } else {
        for (stage, bases, is_target) in [("target", &targets, true), ("full", &fulls, false)] {
            visit_shapes(db, cancel, |s| {
                if pick_base_set(&targets, &s.targets()).is_none() {
                    return Ok(());
                }
                let set = if is_target {
                    s.targets()
                } else {
                    s.full.clone()
                };
                if let Some(base) = pick_base_set(bases, &set) {
                    seed(db, stage, base, &s)?;
                }
                Ok(())
            })?;
            visit_shapes(db, cancel, |s| {
                if pick_base_set(&targets, &s.targets()).is_none() {
                    return Ok(());
                }
                let set = if is_target {
                    s.targets()
                } else {
                    s.full.clone()
                };
                if let Some(base) = pick_base_set(bases, &set) {
                    attach(db, stage, base, &s)?;
                }
                Ok(())
            })?;
        }
    }
    visit_shapes(db, cancel, |s| {
        let root = root(db, s.index)?;
        db.execute(
            "INSERT INTO suite_members VALUES(?1,?2,0)",
            params![s.index, root],
        )
        .map_err(db_error)?;
        Ok(())
    })?;
    db.execute_batch("CREATE INDEX suite_members_root ON suite_members(root); UPDATE suite_members SET grp=(SELECT MIN(other.seq) FROM suite_members other WHERE other.root=suite_members.root); CREATE INDEX suite_members_grp ON suite_members(grp,seq);").map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn type_rows(
    db: &Connection,
    sheet: &str,
    strict: bool,
    budget: u64,
    progress: Progress<'_>,
    stage_start: usize,
    cancel: &AtomicBool,
) -> Result<usize, AppError> {
    let label = if strict { "严格" } else { "宽松" };
    progress(
        "classify",
        stage_start,
        6,
        &format!("正在建立{label}凭证分组索引…"),
    );
    classify(db, strict, budget, cancel)?;
    progress(
        "classify",
        stage_start + 1,
        6,
        &format!("正在汇总{label}凭证分组…"),
    );
    db.execute_batch("DROP TABLE IF EXISTS suite_group_target; DROP TABLE IF EXISTS suite_group_account;
        DROP TABLE IF EXISTS suite_group_month; DROP TABLE IF EXISTS suite_group_rep;
        CREATE TEMP TABLE suite_group_target(grp INTEGER,account TEXT,PRIMARY KEY(grp,account));
        CREATE TEMP TABLE suite_group_account(grp INTEGER,account TEXT,net REAL,PRIMARY KEY(grp,account));
        CREATE TEMP TABLE suite_group_month(grp INTEGER,account TEXT,month TEXT,net REAL,PRIMARY KEY(grp,account,month));
        CREATE TEMP TABLE suite_group_rep(grp INTEGER PRIMARY KEY,rep TEXT NOT NULL);").map_err(db_error)?;
    let tx = db.unchecked_transaction().map_err(db_error)?;
    let mut insert_target = tx
        .prepare("INSERT OR IGNORE INTO suite_group_target VALUES(?1,?2)")
        .map_err(db_error)?;
    let mut shape_stmt = tx
        .prepare("SELECT m.grp,s.signs FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq ORDER BY m.grp,m.seq")
        .map_err(db_error)?;
    let mut shapes = shape_stmt.query([]).map_err(db_error)?;
    while let Some(shape) = shapes.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let grp: i64 = shape.get(0).map_err(db_error)?;
        let signs: BTreeMap<String, i8> =
            serde_json::from_str(&shape.get::<_, String>(1).map_err(db_error)?)
                .map_err(json_error)?;
        for account in signs.keys() {
            insert_target
                .execute(params![grp, account])
                .map_err(db_error)?;
        }
    }
    drop(shapes);
    drop(shape_stmt);
    drop(insert_target);
    // Aggregate all classification groups in two scans. The previous loop ran
    // both joins once per group, which became quadratic for varied ledgers.
    tx.execute_batch(
        "INSERT INTO suite_group_account
            SELECT m.grp,n.account,SUM(n.net)
            FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_nets n ON n.id=s.id
            GROUP BY m.grp,n.account;
         INSERT INTO suite_group_month
            SELECT m.grp,x.account,x.month,SUM(x.net)
            FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_month x ON x.id=s.id
            GROUP BY m.grp,x.account,x.month;
         INSERT INTO suite_group_rep
            SELECT first.grp,s.id
            FROM (SELECT grp,MIN(seq) AS seq FROM suite_members GROUP BY grp) first
            JOIN suite_shapes s ON s.seq=first.seq;
         CREATE INDEX suite_group_target_account ON suite_group_target(account,grp);",
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    progress(
        "classify",
        stage_start + 2,
        6,
        &format!("正在生成{label}凭证类型明细…"),
    );
    let months = {
        let mut stmt = db
            .prepare("SELECT DISTINCT month FROM suite_month ORDER BY month")
            .map_err(db_error)?;
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    let tx = db.unchecked_transaction().map_err(db_error)?;
    tx.execute_batch(
        "DROP TABLE IF EXISTS suite_group_rank;
         DROP TABLE IF EXISTS suite_group_meta;
         CREATE TEMP TABLE suite_group_rank AS
           SELECT t.grp,t.account,
                  DENSE_RANK() OVER(PARTITION BY t.account ORDER BY r.rep) AS rank
           FROM suite_group_target t JOIN suite_group_rep r ON r.grp=t.grp;
         CREATE INDEX suite_group_rank_grp ON suite_group_rank(grp,account);
         CREATE TEMP TABLE suite_group_meta(
           grp INTEGER PRIMARY KEY,rep TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',summaries TEXT NOT NULL DEFAULT ''
         );
         INSERT INTO suite_group_meta(grp,rep) SELECT grp,rep FROM suite_group_rep;",
    )
    .map_err(db_error)?;
    let mut update_label = tx
        .prepare("UPDATE suite_group_meta SET label=?2 WHERE grp=?1")
        .map_err(db_error)?;
    let mut rank_stmt = tx
        .prepare("SELECT grp,account,rank FROM suite_group_rank ORDER BY grp,account")
        .map_err(db_error)?;
    let mut ranks = rank_stmt.query([]).map_err(db_error)?;
    let mut current_group = None;
    let mut labels = Vec::new();
    while let Some(row) = ranks.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let grp: i64 = row.get(0).map_err(db_error)?;
        if current_group.is_some_and(|value| value != grp) {
            update_label
                .execute(params![current_group.unwrap(), labels.join(" | ")])
                .map_err(db_error)?;
            labels.clear();
        }
        current_group = Some(grp);
        let account: String = row.get(1).map_err(db_error)?;
        let rank: i64 = row.get(2).map_err(db_error)?;
        labels.push(format!("{account}-类型{}", rank.max(1)));
    }
    if let Some(grp) = current_group {
        update_label
            .execute(params![grp, labels.join(" | ")])
            .map_err(db_error)?;
    }
    drop(ranks);
    drop(rank_stmt);
    drop(update_label);

    let mut update_summaries = tx
        .prepare("UPDATE suite_group_meta SET summaries=?2 WHERE grp=?1")
        .map_err(db_error)?;
    let mut summary_stmt = tx
        .prepare(
            "SELECT grp,value FROM (
           SELECT m.grp AS grp,x.value AS value,
                  ROW_NUMBER() OVER(PARTITION BY m.grp ORDER BY MIN(x.seq),x.value) AS rn
           FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq
           JOIN suite_summaries x ON x.id=s.id
           GROUP BY m.grp,x.value
         ) WHERE rn<=3 ORDER BY grp,rn",
        )
        .map_err(db_error)?;
    let mut summary_rows = summary_stmt.query([]).map_err(db_error)?;
    let mut summary_group = None;
    let mut summaries = Vec::new();
    while let Some(row) = summary_rows.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let grp: i64 = row.get(0).map_err(db_error)?;
        if summary_group.is_some_and(|value| value != grp) {
            update_summaries
                .execute(params![summary_group.unwrap(), summaries.join(" | ")])
                .map_err(db_error)?;
            summaries.clear();
        }
        summary_group = Some(grp);
        summaries.push(row.get::<_, String>(1).map_err(db_error)?);
    }
    if let Some(grp) = summary_group {
        update_summaries
            .execute(params![grp, summaries.join(" | ")])
            .map_err(db_error)?;
    }
    drop(summary_rows);
    drop(summary_stmt);
    drop(update_summaries);

    let mut insert_output = tx.prepare("INSERT INTO suite_output(sheet,sort_head,sort_rank,sort_label,sort_account,rowdata) VALUES(?1,?2,?3,?4,?5,?6)").map_err(db_error)?;
    let month_positions = months
        .iter()
        .enumerate()
        .map(|(index, month)| (month.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut output_stmt = tx
        .prepare(
            "SELECT a.grp,g.rep,g.label,g.summaries,a.account,a.net,m.month,m.net
         FROM suite_group_account a JOIN suite_group_meta g ON g.grp=a.grp
         LEFT JOIN suite_group_month m ON m.grp=a.grp AND m.account=a.account
         ORDER BY a.grp,a.account,m.month",
        )
        .map_err(db_error)?;
    let mut output_rows = output_stmt.query([]).map_err(db_error)?;
    let mut current_key = None::<(i64, String)>;
    let mut current = None::<(String, String, String, String, f64)>;
    let mut month_values = vec![0.0_f64; months.len()];
    let mut written = 0usize;
    let mut flush = |record: Option<(String, String, String, String, f64)>,
                     values: &mut Vec<f64>|
     -> Result<(), AppError> {
        if let Some((rep, label, summaries, name, net)) = record {
            let mut output = vec![
                label.clone(),
                display_voucher_key(&rep),
                summaries,
                name.clone(),
                format_number(net),
            ];
            let mut nonzero = net != 0.0;
            for amount in values.iter() {
                let value = round_to_cent(*amount);
                nonzero |= value != 0.0;
                output.push(format_number(value));
            }
            if nonzero {
                let (sort_head, sort_rank) = type_sort_key(&label);
                insert_output
                    .execute(params![
                        sheet,
                        sort_head,
                        sort_rank,
                        label,
                        name,
                        encode(&output)?
                    ])
                    .map_err(db_error)?;
                written += 1;
            }
        }
        values.fill(0.0);
        Ok(())
    };
    let mut visited = 0usize;
    while let Some(row) = output_rows.next().map_err(db_error)? {
        if visited % 2000 == 0 {
            check_cancel(cancel)?;
        }
        visited += 1;
        let grp: i64 = row.get(0).map_err(db_error)?;
        let name: String = row.get(4).map_err(db_error)?;
        let next_key = (grp, name.clone());
        if current_key.as_ref().is_some_and(|value| value != &next_key) {
            flush(current.take(), &mut month_values)?;
        }
        if current_key.as_ref() != Some(&next_key) {
            current_key = Some(next_key);
            current = Some((
                row.get(1).map_err(db_error)?,
                row.get(2).map_err(db_error)?,
                row.get(3).map_err(db_error)?,
                name,
                round_to_cent(row.get(5).map_err(db_error)?),
            ));
        }
        let month: Option<String> = row.get(6).map_err(db_error)?;
        let amount: Option<f64> = row.get(7).map_err(db_error)?;
        if let (Some(month), Some(amount)) = (month, amount)
            && let Some(position) = month_positions.get(month.as_str())
        {
            month_values[*position] = amount;
        }
    }
    flush(current.take(), &mut month_values)?;
    drop(flush);
    drop(output_rows);
    drop(output_stmt);
    drop(insert_output);
    tx.commit().map_err(db_error)?;
    progress(
        "classify",
        stage_start + 3,
        6,
        &format!("{label}凭证类型已生成。"),
    );
    Ok(written)
}

fn write_row(
    sheet: &mut Worksheet,
    row: u32,
    values: &[String],
    number_start: usize,
) -> Result<(), AppError> {
    // Excel has 1,048,576 rows including the header. Fail before handing an
    // out-of-range row to rust_xlsxwriter so the user sees an actionable cause.
    if row >= 1_048_576 {
        return Err(error(
            "KANZHANG_EXCEL_ROW_LIMIT",
            "套表中的单个工作表超过 Excel 的 1,048,576 行上限。请缩小目标科目批次或关闭凭证透视后重试；凭证明细仍可按 CSV 分片导出。",
            None,
        ));
    }
    if values.len() > 16_384 {
        return Err(error(
            "KANZHANG_EXCEL_COLUMN_LIMIT",
            "套表列数超过 Excel 的 16,384 列上限，请减少透视列值。",
            None,
        ));
    }
    for (column, value) in values.iter().enumerate() {
        if column >= number_start {
            if let Ok(number) = value.parse::<f64>() {
                sheet
                    .write_number(row, column as u16, number)
                    .map_err(xlsx_error)?;
                continue;
            }
        }
        sheet
            .write_string(row, column as u16, value)
            .map_err(xlsx_error)?;
    }
    Ok(())
}
fn headers(sheet: &mut Worksheet, values: &[String]) -> Result<(), AppError> {
    let format = Format::new()
        .set_bold()
        .set_background_color("#D9EAF7")
        .set_border(FormatBorder::Thin);
    for (i, value) in values.iter().enumerate() {
        sheet
            .write_string_with_format(0, i as u16, value, &format)
            .map_err(xlsx_error)?;
    }
    Ok(())
}
fn output_rows(
    db: &Connection,
    sheet_name: &str,
    sheet: &mut Worksheet,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut stmt=db.prepare("SELECT rowdata FROM suite_output WHERE sheet=?1 ORDER BY sort_head DESC,sort_rank DESC,sort_label,sort_account,seq").map_err(db_error)?;
    let mut rows = stmt.query([sheet_name]).map_err(db_error)?;
    let mut index = 1u32;
    while let Some(row) = rows.next().map_err(db_error)? {
        if index % 2000 == 0 {
            check_cancel(cancel)?;
        }
        let values: Vec<String> = serde_json::from_str(&row.get::<_, String>(0).map_err(db_error)?)
            .map_err(json_error)?;
        write_row(sheet, index, &values, 4)?;
        index += 1;
    }
    Ok(())
}

const EXCEL_DATA_ROW_LIMIT: usize = 1_048_575;

fn type_sheet_requires_csv(row_count: usize) -> bool {
    row_count > EXCEL_DATA_ROW_LIMIT
}

fn overflow_csv_path(suite_path: &Path, sheet_name: &str) -> PathBuf {
    let parent = suite_path.parent().unwrap_or(Path::new("."));
    let stem = suite_path.file_stem().unwrap_or_default().to_string_lossy();
    parent.join(format!("{stem}_{}.csv", sanitize_filename(sheet_name)))
}

fn write_type_output_csv(
    db: &Connection,
    sheet_name: &str,
    path: &Path,
    voucher_header: &str,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let partial = partial_path(path);
    let file = File::create(&partial).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().flexible(true).from_writer(file);
    let months = {
        let mut statement = db
            .prepare("SELECT DISTINCT month FROM suite_month ORDER BY month")
            .map_err(db_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    let mut header = vec![
        "科目名称-类型".to_owned(),
        voucher_header.to_owned(),
        "摘要".to_owned(),
        "科目名称".to_owned(),
        NET_VALUE_FIELD.to_owned(),
    ];
    header.extend(months);
    writer.write_record(&header).map_err(csv_error)?;
    let result = (|| {
        let mut statement = db
            .prepare(
                "SELECT rowdata FROM suite_output WHERE sheet=?1
             ORDER BY sort_head DESC,sort_rank DESC,sort_label,sort_account,seq",
            )
            .map_err(db_error)?;
        let mut rows = statement.query([sheet_name]).map_err(db_error)?;
        let mut scanned = 0usize;
        while let Some(row) = rows.next().map_err(db_error)? {
            if scanned % 2_000 == 0 {
                check_cancel(cancel)?;
            }
            let values: Vec<String> =
                serde_json::from_str(&row.get::<_, String>(0).map_err(db_error)?)
                    .map_err(json_error)?;
            writer.write_record(values).map_err(csv_error)?;
            scanned += 1;
        }
        writer.flush().map_err(io_error)
    })();
    if let Err(failure) = result {
        drop(writer);
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    drop(writer);
    if let Err(failure) = replace_file(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    Ok(())
}

fn export_type_overflow_if_needed(
    db: &Connection,
    suite_path: &Path,
    sheet_name: &str,
    row_count: usize,
    voucher_header: &str,
    overflow_paths: &mut Vec<PathBuf>,
    warnings: &mut Vec<String>,
    progress: Progress<'_>,
    classify_stage: usize,
    cancel: &AtomicBool,
) -> Result<bool, AppError> {
    if !type_sheet_requires_csv(row_count) {
        return Ok(false);
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS suite_output_order ON suite_output(
            sheet,sort_head DESC,sort_rank DESC,sort_label,sort_account,seq
        );",
    )
    .map_err(db_error)?;
    let csv_path = overflow_csv_path(suite_path, sheet_name);
    progress(
        "classify",
        classify_stage,
        6,
        &format!("{sheet_name}预计 {row_count} 行，超过 Excel 上限，正在直接导出 CSV…"),
    );
    write_type_output_csv(db, sheet_name, &csv_path, voucher_header, cancel)?;
    overflow_paths.push(csv_path.clone());
    warnings.push(format!(
        "套表工作表「{sheet_name}」共有 {row_count} 行数据，已自动改为 CSV：{}",
        csv_path.to_string_lossy()
    ));
    Ok(true)
}

fn write_voucher_output_csv(
    db: &Connection,
    path: &Path,
    key_header: &str,
    directions: &[String],
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let partial = partial_path(path);
    let file = File::create(&partial).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().flexible(true).from_writer(file);
    let mut header = vec![key_header.to_owned(), "科目名称".to_owned()];
    if directions.is_empty() {
        header.push(NET_VALUE_FIELD.to_owned());
    } else {
        header.extend(directions.iter().cloned());
    }
    writer.write_record(header).map_err(csv_error)?;
    let result = (|| {
        let mut scanned = 0usize;
        if directions.is_empty() {
            let mut statement = db
                .prepare(
                    "SELECT id,account,SUM(net) FROM suite_pivot
                     GROUP BY id,account ORDER BY id,account",
                )
                .map_err(db_error)?;
            let mut rows = statement.query([]).map_err(db_error)?;
            while let Some(row) = rows.next().map_err(db_error)? {
                if scanned % 2_000 == 0 {
                    check_cancel(cancel)?;
                }
                writer
                    .write_record([
                        display_voucher_key(&row.get::<_, String>(0).map_err(db_error)?),
                        row.get::<_, String>(1).map_err(db_error)?,
                        format_number(round_to_cent(row.get::<_, f64>(2).map_err(db_error)?)),
                    ])
                    .map_err(csv_error)?;
                scanned += 1;
            }
        } else {
            let direction_indexes = directions
                .iter()
                .enumerate()
                .map(|(index, value)| (value.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut statement = db
                .prepare(
                    "SELECT id,account,direction,net FROM suite_pivot
                 WHERE direction<>'' ORDER BY id,account,direction",
                )
                .map_err(db_error)?;
            let mut rows = statement.query([]).map_err(db_error)?;
            let mut current = None::<(String, String)>;
            let mut amounts = vec![0.0_f64; directions.len()];
            let mut flush =
                |record: Option<(String, String)>, values: &mut Vec<f64>| -> Result<(), AppError> {
                    if let Some((id, account)) = record {
                        let mut output = vec![display_voucher_key(&id), account];
                        output.extend(
                            values
                                .iter()
                                .map(|value| format_number(round_to_cent(*value))),
                        );
                        writer.write_record(output).map_err(csv_error)?;
                    }
                    values.fill(0.0);
                    Ok(())
                };
            while let Some(row) = rows.next().map_err(db_error)? {
                if scanned % 2_000 == 0 {
                    check_cancel(cancel)?;
                }
                scanned += 1;
                let next = (
                    row.get::<_, String>(0).map_err(db_error)?,
                    row.get::<_, String>(1).map_err(db_error)?,
                );
                if current.as_ref().is_some_and(|value| value != &next) {
                    flush(current.take(), &mut amounts)?;
                }
                current = Some(next);
                let direction: String = row.get(2).map_err(db_error)?;
                if let Some(position) = direction_indexes.get(direction.as_str()) {
                    amounts[*position] = row.get(3).map_err(db_error)?;
                }
            }
            flush(current.take(), &mut amounts)?;
        }
        writer.flush().map_err(io_error)
    })();
    if let Err(failure) = result {
        drop(writer);
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    drop(writer);
    if let Err(failure) = replace_file(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    Ok(())
}

fn write_custom_output_csv(
    db: &Connection,
    path: &Path,
    config: &PivotConfig,
    columns: &[String],
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let partial = partial_path(path);
    let file = File::create(&partial).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().flexible(true).from_writer(file);
    let mut header = config
        .rows
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if !config.columns.is_empty() {
        header.push("合计".to_owned());
    }
    header.extend(columns.iter().cloned());
    writer.write_record(header).map_err(csv_error)?;
    let result = (|| {
        let column_indexes = columns
            .iter()
            .enumerate()
            .map(|(index, value)| (value.as_str(), index))
            .collect::<HashMap<_, _>>();
        let mut statement = db
            .prepare("SELECT rowkey,col,net FROM suite_custom ORDER BY rowkey,col")
            .map_err(db_error)?;
        let mut rows = statement.query([]).map_err(db_error)?;
        let mut current = None::<String>;
        let mut amounts = vec![0.0_f64; columns.len()];
        let mut total = 0.0_f64;
        let mut flush =
            |key: Option<String>, values: &mut Vec<f64>, sum: &mut f64| -> Result<(), AppError> {
                if let Some(key) = key {
                    let mut output: Vec<String> = serde_json::from_str(&key).map_err(json_error)?;
                    if !config.columns.is_empty() {
                        output.push(format_number(*sum));
                    }
                    output.extend(values.iter().map(|value| format_number(*value)));
                    writer.write_record(output).map_err(csv_error)?;
                }
                values.fill(0.0);
                *sum = 0.0;
                Ok(())
            };
        let mut visited = 0usize;
        while let Some(row) = rows.next().map_err(db_error)? {
            if visited % 2_000 == 0 {
                check_cancel(cancel)?;
            }
            visited += 1;
            let key: String = row.get(0).map_err(db_error)?;
            if current.as_ref().is_some_and(|value| value != &key) {
                flush(current.take(), &mut amounts, &mut total)?;
            }
            current = Some(key);
            let column: String = row.get(1).map_err(db_error)?;
            let amount: f64 = row.get(2).map_err(db_error)?;
            total += amount;
            if let Some(position) = column_indexes.get(column.as_str()) {
                amounts[*position] = amount;
            }
        }
        flush(current.take(), &mut amounts, &mut total)?;
        drop(flush);
        writer.flush().map_err(io_error)
    })();
    if let Err(failure) = result {
        drop(writer);
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    drop(writer);
    if let Err(failure) = replace_file(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    Ok(())
}

/// Write every suite sheet directly from SQLite using rust_xlsxwriter's
/// constant-memory worksheets. This deliberately doesn't construct a
/// `LedgerAnalysis.rows` or a full `PivotResult.rows` in Rust.
pub(super) fn write_suite(
    ledger: &DiskLedger,
    mapping: &LedgerMapping,
    targets: &[String],
    job: &KanzhangParams,
    path: &Path,
    budget: u64,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<DiskSuiteResult, AppError> {
    initialize(&ledger.db)?;
    let config = aggregate(ledger, mapping, targets, job, budget, progress, cancel)?;
    let mut overflow_paths = Vec::new();
    let mut warnings = Vec::new();
    let mut overflow_type_sheets = HashSet::<String>::new();
    if job.include_voucher_types {
        progress("classify", 0, 6, "正在按原有宽松和严格口径归类凭证…");
        let voucher_header = voucher_key_label(
            &ledger.table.headers,
            &ledger_id_indexes(&ledger.table.headers, mapping),
        );
        let loose_rows = type_rows(
            &ledger.db,
            "凭证类型-宽松",
            false,
            budget,
            progress,
            0,
            cancel,
        )?;
        if export_type_overflow_if_needed(
            &ledger.db,
            path,
            "凭证类型-宽松",
            loose_rows,
            &voucher_header,
            &mut overflow_paths,
            &mut warnings,
            progress,
            3,
            cancel,
        )? {
            overflow_type_sheets.insert("凭证类型-宽松".to_owned());
        }
        let strict_rows = type_rows(
            &ledger.db,
            "凭证类型-严格",
            true,
            budget,
            progress,
            3,
            cancel,
        )?;
        ledger.db.execute_batch("CREATE INDEX IF NOT EXISTS suite_output_order ON suite_output(sheet,sort_head DESC,sort_rank DESC,sort_label,sort_account,seq);").map_err(db_error)?;
        if export_type_overflow_if_needed(
            &ledger.db,
            path,
            "凭证类型-严格",
            strict_rows,
            &voucher_header,
            &mut overflow_paths,
            &mut warnings,
            progress,
            6,
            cancel,
        )? {
            overflow_type_sheets.insert("凭证类型-严格".to_owned());
        }
        progress("classify", 6, 6, "宽松和严格凭证类型已生成。");
    }
    let loss_count = ledger
        .db
        .query_row(
            "SELECT COUNT(*) FROM suite_vouchers WHERE loss=1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_error)? as usize;
    let voucher_count = ledger
        .db
        .query_row("SELECT COUNT(*) FROM suite_vouchers", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(db_error)? as usize;
    let summary = {
        let mut stmt = ledger
            .db
            .prepare("SELECT account,net,count FROM suite_subject ORDER BY account LIMIT 40")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(vec![
                    r.get(0)?,
                    format_number(r.get(1)?),
                    r.get::<_, i64>(2)?.to_string(),
                ])
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        PivotResult {
            headers: vec!["科目名称".into(), "净额".into(), "行数".into()],
            rows,
            row_field_count: 1,
        }
    };
    let llm_analysis = if job.llm_analysis
        && job
            .settings
            .get("llm")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        let preview = |name: &str, limit: usize| -> Result<Vec<Vec<String>>, AppError> {
            let mut stmt=ledger.db.prepare("SELECT rowdata FROM suite_output WHERE sheet=?1 ORDER BY sort_head DESC,sort_rank DESC,sort_label,sort_account,seq LIMIT ?2").map_err(db_error)?;
            stmt.query_map(params![name, limit as i64], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .map(|r| {
                    r.map_err(db_error)
                        .and_then(|s| serde_json::from_str(&s).map_err(json_error))
                })
                .collect()
        };
        let strict = preview("凭证类型-严格", 80)?;
        let loose = preview("凭证类型-宽松", 40)?;
        let payload = json!({"targetAccounts":targets,"subjectSummary":{"headers":&summary.headers,"rows":&summary.rows},
            "voucherTypesStrict":{"headers":["科目名称-类型","凭证","摘要","科目名称",NET_VALUE_FIELD],"rows":strict},
            "voucherTypesLoose":{"headers":["科目名称-类型","凭证","摘要","科目名称",NET_VALUE_FIELD],"rows":loose}});
        crate::audipick::kanzhang_llm_call(
            &json!({"mode":"analysis","payload":payload}),
            &job.settings,
        )
        .ok()
    } else {
        None
    };
    let has_direction = if job.include_pivot {
        ledger
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM suite_pivot WHERE direction<>'')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?
    } else {
        false
    };
    let directions = if has_direction {
        let mut statement = ledger
            .db
            .prepare(
                "SELECT DISTINCT direction FROM suite_pivot
                 WHERE direction<>'' ORDER BY direction",
            )
            .map_err(db_error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    } else {
        Vec::new()
    };
    let voucher_row_count = if job.include_pivot {
        let where_clause = if has_direction {
            "WHERE direction<>''"
        } else {
            ""
        };
        ledger
            .db
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM (
                        SELECT 1 FROM suite_pivot {where_clause} GROUP BY id,account
                    )"
                ),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)? as usize
    } else {
        0
    };
    let voucher_overflow = type_sheet_requires_csv(voucher_row_count);
    if voucher_overflow {
        let csv_path = overflow_csv_path(path, "凭证");
        progress(
            "write",
            0,
            7,
            &format!("凭证透视预计 {voucher_row_count} 行，超过 Excel 上限，正在直接导出 CSV…"),
        );
        let key_header = voucher_key_label(
            &ledger.table.headers,
            &ledger_id_indexes(&ledger.table.headers, mapping),
        );
        write_voucher_output_csv(&ledger.db, &csv_path, &key_header, &directions, cancel)?;
        overflow_paths.push(csv_path.clone());
        warnings.push(format!(
            "套表工作表「凭证」共有 {voucher_row_count} 行数据，已自动改为 CSV：{}",
            csv_path.to_string_lossy()
        ));
    }
    progress("write", 0, 7, "正在生成看账套表工作表…");
    let mut workbook = Workbook::new();
    if job.include_pivot && !voucher_overflow {
        let ws = workbook.add_worksheet_with_constant_memory();
        ws.set_name("凭证").map_err(xlsx_error)?;
        let key = voucher_key_label(
            &ledger.table.headers,
            &ledger_id_indexes(&ledger.table.headers, mapping),
        );
        let mut head = vec![key, "科目名称".into()];
        if directions.is_empty() {
            head.push(NET_VALUE_FIELD.into())
        } else {
            head.extend(directions.clone())
        }
        headers(ws, &head)?;
        // The ordinary direction pivot skips rows whose direction cell is
        // blank. Once any nonblank direction exists, don't synthesize an all
        // zero voucher/account row for an empty direction.
        let mut index = 1u32;
        if directions.is_empty() {
            let mut stmt = ledger.db.prepare("SELECT id,account,SUM(net) FROM suite_pivot GROUP BY id,account ORDER BY id,account").map_err(db_error)?;
            let mut rows = stmt.query([]).map_err(db_error)?;
            while let Some(row) = rows.next().map_err(db_error)? {
                if index % 2000 == 0 {
                    check_cancel(cancel)?;
                }
                let id: String = row.get(0).map_err(db_error)?;
                let account: String = row.get(1).map_err(db_error)?;
                let net: f64 = row.get(2).map_err(db_error)?;
                write_row(
                    ws,
                    index,
                    &[
                        display_voucher_key(&id),
                        account,
                        format_number(round_to_cent(net)),
                    ],
                    2,
                )?;
                index += 1;
            }
        } else {
            let direction_indexes = directions
                .iter()
                .enumerate()
                .map(|(index, value)| (value.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut stmt = ledger.db.prepare("SELECT id,account,direction,net FROM suite_pivot WHERE direction<>'' ORDER BY id,account,direction").map_err(db_error)?;
            let mut rows = stmt.query([]).map_err(db_error)?;
            let mut current: Option<(String, String)> = None;
            let mut amounts = vec![0.0_f64; directions.len()];
            while let Some(row) = rows.next().map_err(db_error)? {
                let id: String = row.get(0).map_err(db_error)?;
                let account: String = row.get(1).map_err(db_error)?;
                let next = (id, account);
                if current.as_ref().is_some_and(|value| value != &next) {
                    let (id, account) = current.take().unwrap();
                    let mut values = vec![display_voucher_key(&id), account];
                    values.extend(
                        amounts
                            .iter()
                            .map(|value| format_number(round_to_cent(*value))),
                    );
                    write_row(ws, index, &values, 2)?;
                    index += 1;
                    amounts.fill(0.0);
                    if index % 2000 == 0 {
                        check_cancel(cancel)?;
                    }
                }
                current = Some(next);
                let direction: String = row.get(2).map_err(db_error)?;
                if let Some(position) = direction_indexes.get(direction.as_str()) {
                    amounts[*position] = row.get(3).map_err(db_error)?;
                }
            }
            if let Some((id, account)) = current {
                let mut values = vec![display_voucher_key(&id), account];
                values.extend(
                    amounts
                        .iter()
                        .map(|value| format_number(round_to_cent(*value))),
                );
                write_row(ws, index, &values, 2)?;
            }
        }
        ws.set_hidden(true);
    }
    progress(
        "write",
        1,
        7,
        if voucher_overflow {
            "凭证透视超过 Excel 行数上限，已改为 CSV。"
        } else {
            "凭证透视表已生成。"
        },
    );
    if job.include_voucher_types {
        let months = {
            let mut s = ledger
                .db
                .prepare("SELECT DISTINCT month FROM suite_month ORDER BY month")
                .map_err(db_error)?;
            s.query_map([], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        for (type_index, name) in ["凭证类型-宽松", "凭证类型-严格"].into_iter().enumerate()
        {
            if overflow_type_sheets.contains(name) {
                progress(
                    "write",
                    type_index + 2,
                    7,
                    &format!("{name}超过 Excel 行数上限，已改为 CSV。"),
                );
                continue;
            }
            let ws = workbook.add_worksheet_with_constant_memory();
            ws.set_name(name).map_err(xlsx_error)?;
            let mut h = vec![
                "科目名称-类型".into(),
                voucher_key_label(
                    &ledger.table.headers,
                    &ledger_id_indexes(&ledger.table.headers, mapping),
                ),
                "摘要".into(),
                "科目名称".into(),
                NET_VALUE_FIELD.into(),
            ];
            h.extend(months.clone());
            headers(ws, &h)?;
            output_rows(&ledger.db, name, ws, cancel)?;
            progress("write", type_index + 2, 7, &format!("{name}工作表已生成。"));
        }
    }
    progress("write", 3, 7, "凭证类型工作表已生成。");
    if !config.rows.is_empty() {
        let columns = {
            let mut s = ledger
                .db
                .prepare("SELECT DISTINCT col FROM suite_custom ORDER BY col")
                .map_err(db_error)?;
            let values = s
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?;
            guard(values.iter().map(|s| s.len() + 96).sum(), budget / 4)?;
            values
        };
        let custom_row_count = ledger
            .db
            .query_row(
                "SELECT COUNT(DISTINCT rowkey) FROM suite_custom",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(db_error)? as usize;
        if type_sheet_requires_csv(custom_row_count) {
            let csv_path = overflow_csv_path(path, "透视分析");
            progress(
                "write",
                3,
                7,
                &format!("透视分析预计 {custom_row_count} 行，超过 Excel 上限，正在直接导出 CSV…"),
            );
            write_custom_output_csv(&ledger.db, &csv_path, &config, &columns, cancel)?;
            overflow_paths.push(csv_path.clone());
            warnings.push(format!(
                "套表工作表「透视分析」共有 {custom_row_count} 行数据，已自动改为 CSV：{}",
                csv_path.to_string_lossy()
            ));
        } else {
            let ws = workbook.add_worksheet_with_constant_memory();
            ws.set_name("透视分析").map_err(xlsx_error)?;
            let mut h = config
                .rows
                .iter()
                .map(|(s, _)| s.clone())
                .collect::<Vec<_>>();
            if !config.columns.is_empty() {
                h.push("合计".into());
            }
            h.extend(columns.clone());
            headers(ws, &h)?;
            let column_indexes = columns
                .iter()
                .enumerate()
                .map(|(index, value)| (value.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut stmt = ledger
                .db
                .prepare("SELECT rowkey,col,net FROM suite_custom ORDER BY rowkey,col")
                .map_err(db_error)?;
            let mut rows = stmt.query([]).map_err(db_error)?;
            let mut index = 1u32;
            let mut current = None::<String>;
            let mut amounts = vec![0.0_f64; columns.len()];
            let mut total = 0.0_f64;
            while let Some(row) = rows.next().map_err(db_error)? {
                let key: String = row.get(0).map_err(db_error)?;
                if current.as_ref().is_some_and(|value| value != &key) {
                    let mut values: Vec<String> =
                        serde_json::from_str(current.as_deref().unwrap()).map_err(json_error)?;
                    if !config.columns.is_empty() {
                        values.push(format_number(total));
                    }
                    values.extend(amounts.iter().map(|value| format_number(*value)));
                    write_row(ws, index, &values, config.rows.len())?;
                    index += 1;
                    amounts.fill(0.0);
                    total = 0.0;
                    if index % 2000 == 0 {
                        check_cancel(cancel)?;
                    }
                }
                current = Some(key);
                let column: String = row.get(1).map_err(db_error)?;
                let amount: f64 = row.get(2).map_err(db_error)?;
                total += amount;
                if let Some(position) = column_indexes.get(column.as_str()) {
                    amounts[*position] = amount;
                }
            }
            if let Some(key) = current {
                let mut values: Vec<String> = serde_json::from_str(&key).map_err(json_error)?;
                if !config.columns.is_empty() {
                    values.push(format_number(total));
                }
                values.extend(amounts.iter().map(|value| format_number(*value)));
                write_row(ws, index, &values, config.rows.len())?;
            }
        }
    }
    progress("write", 4, 7, "自定义透视工作表已生成。");
    {
        let ws = workbook.add_worksheet_with_constant_memory();
        ws.set_name("科目汇总").map_err(xlsx_error)?;
        headers(ws, &summary.headers)?;
        let mut stmt = ledger
            .db
            .prepare("SELECT account,net,count FROM suite_subject ORDER BY account")
            .map_err(db_error)?;
        let mut rows = stmt.query([]).map_err(db_error)?;
        let mut index = 1u32;
        while let Some(row) = rows.next().map_err(db_error)? {
            if index % 2000 == 0 {
                check_cancel(cancel)?;
            }
            write_row(
                ws,
                index,
                &[
                    row.get(0).map_err(db_error)?,
                    format_number(row.get(1).map_err(db_error)?),
                    row.get::<_, i64>(2).map_err(db_error)?.to_string(),
                ],
                1,
            )?;
            index += 1;
        }
    }
    progress("write", 5, 7, "科目汇总工作表已生成。");
    {
        let ws = workbook.add_worksheet_with_constant_memory();
        ws.set_name("_targets").map_err(xlsx_error)?;
        headers(ws, &["目标科目".into()])?;
        for (i, target) in targets.iter().enumerate() {
            ws.write_string(i as u32 + 1, 0, target)
                .map_err(xlsx_error)?;
        }
        ws.set_hidden(true);
    }
    progress("write", 6, 7, "正在压缩并保存看账套表…");
    if let Some(value) = llm_analysis.as_ref() {
        write_llm_analysis_sheet(workbook.add_worksheet(), value)?;
    }
    activate_first_visible_sheet(&mut workbook);
    let partial = partial_path(path);
    if let Err(failure) = workbook.save(&partial).map_err(xlsx_error) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    if let Err(failure) = replace_file(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    progress("write", 7, 7, "看账套表已写出。");
    Ok(DiskSuiteResult {
        summary,
        loss_count,
        voucher_count,
        overflow_paths,
        warnings,
    })
}
