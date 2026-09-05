//! Bounded-memory ledger preparation. SQLite owns the row and voucher sets;
//! Rust retains only the current row, fill state and one voucher's counters.
use super::*;
use rusqlite::{Connection, params};
use std::cell::Cell;

const PREPARED_CACHE_VERSION: u64 = 1;

pub(super) fn sql_error(e: rusqlite::Error) -> AppError {
    error(
        "LEDGER_CACHE_FAILED",
        "无法处理大文件磁盘索引，请检查磁盘空间后重试。",
        Some(e.to_string()),
    )
}

pub(super) struct DiskLedger {
    pub db: Connection,
    pub table: Table,
    pub count: usize,
    pub convention: SignConvention,
    selected_convention: Cell<SignConvention>,
    mapping: LedgerMapping,
}

#[derive(Debug)]
pub(super) struct DetailExport {
    pub paths: Vec<PathBuf>,
    pub rows: usize,
}

#[derive(Clone, Copy)]
struct AmountColumns {
    debit: Option<usize>,
    credit: Option<usize>,
    amount: Option<usize>,
    direction: Option<usize>,
}
impl AmountColumns {
    fn new(headers: &[String], m: &LedgerMapping) -> Self {
        let at = |name: &Option<String>| name.as_deref().and_then(|n| header_index(headers, n));
        Self {
            debit: at(&m.debit),
            credit: at(&m.credit),
            amount: at(&m.amount),
            direction: at(&m.direction),
        }
    }
    fn scheme(self) -> &'static str {
        if self.debit.is_some() && self.credit.is_some() {
            "B"
        } else if self.amount.is_some() && self.direction.is_some() {
            "A"
        } else {
            "single"
        }
    }
    // dr/cr are the evidence-side sums; raw follows the shared signed_amount
    // rule, including a row that contains both debit and credit.
    fn values(self, row: &[String]) -> (f64, f64, f64, f64, bool, bool, i64, i64) {
        let number = |i: Option<usize>| {
            i.map(|i| parse_number(row.get(i).map(String::as_str).unwrap_or("")))
                .unwrap_or(0.0)
        };
        let (dr, cr, amount) = (number(self.debit), number(self.credit), number(self.amount));
        if self.scheme() == "B" {
            let raw = ledger_mapping::signed_amount(
                &ledger_mapping::AmountInputs {
                    debit: Some(dr),
                    credit: Some(cr),
                    ..Default::default()
                },
                SignConvention::Signed,
            );
            (
                dr,
                cr,
                raw,
                dr - cr,
                dr != 0.0,
                cr != 0.0,
                i64::from(cr > 0.0),
                i64::from(cr < 0.0),
            )
        } else if self.scheme() == "A" {
            let direction = self
                .direction
                .and_then(|i| row.get(i))
                .map(|v| v.trim())
                .unwrap_or("");
            let is_credit = ledger_mapping::is_credit_direction(direction);
            let has_debit = !direction.is_empty() && !is_credit;
            (
                if has_debit { amount } else { 0.0 },
                if is_credit { amount } else { 0.0 },
                amount,
                if is_credit { -amount } else { amount },
                has_debit,
                is_credit,
                i64::from(amount < 0.0 && has_debit),
                i64::from(amount < 0.0 && is_credit),
            )
        } else {
            (0.0, 0.0, amount, amount, false, false, 0, 0)
        }
    }
}

fn validate_disk_amount_row(
    headers: &[String],
    row: &[String],
    mapping: &LedgerMapping,
    source_index: usize,
) -> Result<(), AppError> {
    let one = vec![row.to_vec()];
    let issues = ledger_mapping::mapped_amount_parse_issues("je", headers, &one, &|role| {
        ledger_columns_for_role(mapping, role)
    });
    if let Some(issue) = issues.first() {
        let mut display = issue.value.chars().take(80).collect::<String>();
        if issue.value.chars().count() > 80 {
            display.push('…');
        }
        let user_message = format!(
            "金额列「{}」第{}行的值“{}”无法解析为数值，请修正后重试。",
            issue.column,
            source_index + 1,
            display
        );
        return Err(error(
            "KANZHANG_AMOUNT_VALUE_INVALID",
            &user_message,
            Some(format!(
                "{}（{}）第{}行=“{}”",
                issue.column,
                issue.label,
                source_index + 1,
                issue.value
            )),
        ));
    }
    Ok(())
}

fn prepared_key(
    cache: &large_csv::Cache,
    mapping: &LedgerMapping,
    sign_override: Option<SignConvention>,
    header_row: usize,
) -> Result<String, AppError> {
    let mut hash = Sha256::new();
    hash.update(fingerprint(&cache.table.path, "CSV", header_row)?.as_bytes());
    hash.update(serde_json::to_vec(mapping).map_err(|e| {
        error(
            "LEDGER_CACHE_FAILED",
            "无法生成凭证分析缓存标识。",
            Some(e.to_string()),
        )
    })?);
    hash.update(
        sign_override
            .map(SignConvention::as_str)
            .unwrap_or("auto")
            .as_bytes(),
    );
    hash.update(PREPARED_CACHE_VERSION.to_le_bytes());
    Ok(hex::encode(hash.finalize()))
}

fn attach_raw(db: &Connection, cache: &large_csv::Cache) -> Result<(), AppError> {
    db.execute(
        "ATTACH DATABASE ?1 AS raw_cache",
        [cache.path.to_string_lossy().as_ref()],
    )
    .map_err(sql_error)?;
    Ok(())
}

fn read_prepared(
    path: &Path,
    cache: &large_csv::Cache,
    mapping: &LedgerMapping,
    expected_key: &str,
) -> Result<DiskLedger, AppError> {
    let db = Connection::open(path).map_err(sql_error)?;
    let budget = crate::resource_budget::budget()?;
    db.execute_batch(&format!(
        "PRAGMA cache_size=-{}; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=DELETE;",
        budget.sqlite_cache_kib
    ))
    .map_err(sql_error)?;
    let text: String = db
        .query_row("SELECT value FROM meta", [], |row| row.get(0))
        .map_err(sql_error)?;
    let meta: Value = serde_json::from_str(&text).map_err(|e| {
        error(
            "LEDGER_CACHE_FAILED",
            "凭证分析缓存已损坏。",
            Some(e.to_string()),
        )
    })?;
    if meta["version"].as_u64() != Some(PREPARED_CACHE_VERSION)
        || meta["key"].as_str() != Some(expected_key)
    {
        return Err(error(
            "LEDGER_CACHE_FAILED",
            "凭证分析缓存版本已过期。",
            None,
        ));
    }
    let count = meta["rows"]
        .as_u64()
        .ok_or_else(|| error("LEDGER_CACHE_FAILED", "凭证分析缓存行数无效。", None))?
        as usize;
    let convention = match meta["convention"].as_str() {
        Some("signed") => SignConvention::Signed,
        Some("unsigned") => SignConvention::Unsigned,
        _ => {
            return Err(error(
                "LEDGER_CACHE_FAILED",
                "凭证分析缓存金额方向无效。",
                None,
            ));
        }
    };
    let actual: usize = db
        .query_row("SELECT COUNT(*) FROM processed", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(sql_error)? as usize;
    if actual != count {
        return Err(error("LEDGER_CACHE_FAILED", "凭证分析缓存不完整。", None));
    }
    attach_raw(&db, cache)?;
    let mut table = cache.table.clone();
    table.rows.clear();
    Ok(DiskLedger {
        db,
        table,
        count,
        convention,
        selected_convention: Cell::new(convention),
        mapping: mapping.clone(),
    })
}

pub(super) fn prepare(
    cache: &large_csv::Cache,
    mapping: &LedgerMapping,
    sign_override: Option<SignConvention>,
    header_row: usize,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<DiskLedger, AppError> {
    validate_mapping_required(mapping)?;
    let key = prepared_key(cache, mapping, sign_override, header_row)?;
    let path = cache_path("kanzhang-ledger", &key)?.with_extension("sqlite");
    fs::create_dir_all(path.parent().unwrap()).map_err(io_error)?;
    if path.is_file() {
        match read_prepared(&path, cache, mapping, &key) {
            Ok(ledger) => {
                touch_cache(&path);
                progress(
                    "prepare",
                    1000,
                    1000,
                    "已复用凭证分析缓存，无需重新整理和建立索引。",
                );
                return Ok(ledger);
            }
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    crate::resource_budget::check_disk_space(
        path.parent().unwrap(),
        fs::metadata(&cache.table.path)
            .map_err(io_error)?
            .len()
            .saturating_mul(2),
    )?;
    let partial = path.with_extension(format!("{}.partial", uuid::Uuid::new_v4()));
    let result = (|| {
        let ledger = build_prepared(
            cache,
            mapping,
            sign_override,
            header_row,
            progress,
            cancel,
            &partial,
        )?;
        let metadata = json!({
            "version": PREPARED_CACHE_VERSION,
            "key": key,
            "rows": ledger.count,
            "convention": ledger.convention.as_str(),
        });
        ledger
            .db
            .execute("INSERT INTO meta VALUES(?1)", [metadata.to_string()])
            .map_err(sql_error)?;
        drop(ledger);
        check_cancel(cancel)?;
        if prepared_key(cache, mapping, sign_override, header_row)? != key {
            return Err(error(
                "SOURCE_CHANGED",
                "分析期间源文件发生变化，请重新读取。",
                None,
            ));
        }
        replace_file(&partial, &path)?;
        read_prepared(&path, cache, mapping, &key)
    })();
    match result {
        Ok(ledger) => {
            touch_cache(&path);
            progress("prepare", 1000, 1000, "凭证分析缓存已保存并可复用。");
            Ok(ledger)
        }
        Err(err) => {
            let _ = fs::remove_file(&partial);
            Err(err)
        }
    }
}

fn build_prepared(
    cache: &large_csv::Cache,
    mapping: &LedgerMapping,
    sign_override: Option<SignConvention>,
    header_row: usize,
    progress: Progress<'_>,
    cancel: &AtomicBool,
    path: &Path,
) -> Result<DiskLedger, AppError> {
    validate_mapping_required(mapping)?;
    let ids = ledger_id_indexes(&cache.table.headers, mapping);
    let accounts = mapping
        .account_columns()
        .into_iter()
        .filter_map(|n| header_index(&cache.table.headers, n))
        .collect::<Vec<_>>();
    if ids.is_empty() || accounts.is_empty() {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "请先确认凭证编号和科目字段映射。",
            None,
        ));
    }
    let budget = crate::resource_budget::budget()?;
    let db = Connection::open(path).map_err(sql_error)?;
    db.execute_batch(&format!("PRAGMA cache_size=-{}; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA journal_mode=OFF; CREATE TABLE processed(seq INTEGER PRIMARY KEY,voucher TEXT NOT NULL,account TEXT NOT NULL,account_norm TEXT NOT NULL,net REAL NOT NULL DEFAULT 0,candidate INTEGER NOT NULL,signkey TEXT NOT NULL,signkey_noentity TEXT NOT NULL,entity TEXT NOT NULL,dr REAL NOT NULL,cr REAL NOT NULL,raw REAL NOT NULL,unsigned REAL NOT NULL,hd INTEGER NOT NULL,hc INTEGER NOT NULL,pos INTEGER NOT NULL,neg INTEGER NOT NULL); CREATE TABLE meta(value TEXT NOT NULL);",budget.sqlite_cache_kib)).map_err(sql_error)?;
    attach_raw(&db, cache)?;
    let mut table = cache.table.clone();
    table.rows.clear();
    let ledger = DiskLedger {
        db,
        table,
        count: 0,
        convention: SignConvention::Unsigned,
        selected_convention: Cell::new(SignConvention::Unsigned),
        mapping: mapping.clone(),
    };
    ledger.db.execute_batch("BEGIN").map_err(sql_error)?;
    let amount_columns = AmountColumns::new(&ledger.table.headers, mapping);
    let amount_indexes = [
        amount_columns.amount,
        amount_columns.debit,
        amount_columns.credit,
    ]
    .into_iter()
    .flatten()
    .collect::<HashSet<_>>();
    let mapped = mapping_columns(mapping)
        .into_iter()
        .filter_map(|n| header_index(&ledger.table.headers, n))
        .collect::<Vec<_>>();
    let fill = mapped
        .iter()
        .copied()
        .filter(|i| !amount_indexes.contains(i))
        .collect::<HashSet<_>>();
    let mut previous = HashMap::<usize, String>::new();
    let entity_index = mapping
        .entity
        .as_deref()
        .and_then(|n| header_index(&ledger.table.headers, n));
    let no_entity = ids
        .iter()
        .copied()
        .filter(|i| {
            Some(*i) != entity_index
                || mapping
                    .id
                    .iter()
                    .any(|n| header_index(&ledger.table.headers, n) == Some(*i))
                || mapping
                    .date
                    .as_deref()
                    .and_then(|n| header_index(&ledger.table.headers, n))
                    == Some(*i)
        })
        .collect::<Vec<_>>();
    let mut insert = ledger.db.prepare("INSERT INTO processed(seq,voucher,account,account_norm,candidate,signkey,signkey_noentity,entity,dr,cr,raw,unsigned,hd,hc,pos,neg) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)").map_err(sql_error)?;
    let mut last_progress = Instant::now();
    cache.visit(None, cancel, |mut row, index| {
        // Validate before fill/filter, exactly as the ordinary export path does.
        validate_disk_amount_row(&ledger.table.headers, &row, mapping, header_row + index)?;
        for &i in &fill {
            let current = row.get(i).map(|s| s.trim()).unwrap_or("");
            if current.is_empty() {
                if let (Some(value), Some(cell)) = (previous.get(&i), row.get_mut(i)) {
                    *cell = value.clone();
                }
            } else {
                previous.insert(i, current.to_owned());
            }
        }
        let present = |i: &usize| row.get(*i).is_some_and(|v| !v.trim().is_empty());
        let has_amount = amount_indexes.iter().any(present);
        let candidate = has_amount && ids.iter().chain(accounts.iter()).any(|i| !present(i));
        if mapped.iter().any(present) && (ids.iter().all(present) || has_amount) {
            let (dr, cr, raw, unsigned, hd, hc, pos, neg) = amount_columns.values(&row);
            let sign_key = |indexes: &[usize]| {
                indexes
                    .iter()
                    .map(|i| row.get(*i).map(|s| s.trim()).unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join("\u{1f}")
            };
            insert
                .execute(params![
                    index as i64,
                    voucher_key(&row, &ids),
                    joined_account(&row, &accounts),
                    normalize_account_text(&joined_account(&row, &accounts)),
                    candidate,
                    sign_key(&ids),
                    sign_key(&no_entity),
                    entity_index
                        .and_then(|i| row.get(i))
                        .map(String::as_str)
                        .unwrap_or(""),
                    dr,
                    cr,
                    raw,
                    unsigned,
                    hd,
                    hc,
                    pos,
                    neg
                ])
                .map_err(sql_error)?;
        }
        if last_progress.elapsed() >= Duration::from_millis(500) {
            let current = if cache.count == 0 {
                0
            } else {
                (index + 1).saturating_mul(550) / cache.count
            };
            progress(
                "prepare",
                current.min(550),
                1000,
                "正在分批整理凭证并建立磁盘索引…",
            );
            last_progress = Instant::now();
        }
        Ok(())
    })?;
    drop(insert);
    check_cancel(cancel)?;
    progress("prepare", 550, 1000, "凭证明细整理完成，正在提交磁盘数据…");
    ledger.db.execute_batch("COMMIT").map_err(sql_error)?;
    for (current, sql, message) in [
        (
            620,
            "CREATE INDEX processed_voucher ON processed(voucher,seq)",
            "正在建立凭证检索索引…",
        ),
        (
            680,
            "CREATE INDEX processed_account ON processed(account_norm,voucher)",
            "正在建立科目检索索引…",
        ),
        (
            730,
            "CREATE INDEX processed_sign ON processed(signkey,seq)",
            "正在建立借贷方向索引…",
        ),
        (
            770,
            "CREATE INDEX processed_sign_noentity ON processed(signkey_noentity,seq)",
            "正在完成跨主体检索索引…",
        ),
    ] {
        progress("prepare", current, 1000, message);
        ledger.db.execute_batch(sql).map_err(sql_error)?;
        check_cancel(cancel)?;
    }
    progress("prepare", 790, 1000, "正在识别凭证金额方向…");
    let evidence = ledger.evidence(false, cancel)?;
    let convention = sign_override
        .or(evidence.convention)
        .unwrap_or(SignConvention::Unsigned);
    ledger
        .db
        .execute_batch(if convention == SignConvention::Signed {
            "UPDATE processed SET net=raw"
        } else {
            "UPDATE processed SET net=unsigned"
        })
        .map_err(sql_error)?;
    progress("prepare", 830, 1000, "正在校验凭证借贷平衡…");
    // Accumulate in original row order inside each voucher, just as the memory
    // implementation does. SQL SUM may use different floating-point summation.
    ledger
        .db
        .execute_batch("CREATE TEMP TABLE rejected(voucher TEXT PRIMARY KEY) WITHOUT ROWID; BEGIN")
        .map_err(sql_error)?;
    let mut cursor_stmt = ledger
        .db
        .prepare("SELECT voucher,net FROM processed ORDER BY voucher,seq")
        .map_err(sql_error)?;
    let mut cursor = cursor_stmt.query([]).map_err(sql_error)?;
    let mut key: Option<String> = None;
    let mut balance = 0.0_f64;
    let mut index: usize = 0;
    let mut reject = ledger
        .db
        .prepare("INSERT INTO rejected VALUES(?1)")
        .map_err(sql_error)?;
    while let Some(record) = cursor.next().map_err(sql_error)? {
        if index % 1000 == 0 {
            check_cancel(cancel)?;
            crate::resource_budget::check_available()?;
            let current = if ledger.count == 0 {
                830
            } else {
                830 + index.saturating_mul(140) / ledger.count
            };
            progress("prepare", current.min(970), 1000, "正在校验凭证借贷平衡…");
        }
        index += 1;
        let next: String = record.get(0).map_err(sql_error)?;
        if key.as_ref() != Some(&next) {
            if let Some(ref key) = key {
                if balance.abs() > 0.01 {
                    reject.execute([key]).map_err(sql_error)?;
                }
            }
            key = Some(next);
            balance = 0.0;
        }
        balance += record.get::<_, f64>(1).map_err(sql_error)?;
    }
    if let Some(ref key) = key {
        if balance.abs() > 0.01 {
            reject.execute([key]).map_err(sql_error)?;
        }
    }
    drop(cursor);
    drop(cursor_stmt);
    drop(reject);
    progress("prepare", 975, 1000, "正在清理不完整凭证并完成索引…");
    ledger.db.execute_batch("DELETE FROM processed WHERE candidate=1 AND voucher IN (SELECT voucher FROM rejected); DROP TABLE rejected; COMMIT;").map_err(sql_error)?;
    let count = ledger
        .db
        .query_row("SELECT COUNT(*) FROM processed", [], |r| r.get::<_, i64>(0))
        .map_err(sql_error)? as usize;
    progress("prepare", 990, 1000, "凭证索引整理完成，正在保存分析缓存…");
    Ok(DiskLedger {
        count,
        convention,
        selected_convention: Cell::new(convention),
        ..ledger
    })
}

#[derive(Default)]
struct Vote {
    dr: f64,
    cr: f64,
    raw: f64,
    hd: bool,
    hc: bool,
}
impl Vote {
    fn finish(&self, e: &mut SignEvidence) {
        e.total_vouchers += 1;
        if !self.hd || !self.hc {
            e.one_sided += 1;
        } else if (self.dr - self.cr).abs() < 0.01 && self.dr.abs() + self.cr.abs() > 0.01 {
            e.unsigned_votes += 1;
        } else if self.raw.abs() < 0.01 {
            e.signed_votes += 1;
        } else {
            e.unbalanced += 1;
        }
    }
}

impl DiskLedger {
    fn entity_is_unit(&self, selected: bool, cancel: &AtomicBool) -> Result<bool, AppError> {
        let Some(ref name) = self.mapping.entity else {
            return Ok(false);
        };
        // The shared engine inspects the first 10,000 rows. Only retain the
        // entity column for those rows, never their wide transaction payload.
        let sql = if selected {
            "SELECT entity FROM processed WHERE voucher IN (SELECT voucher FROM selected) ORDER BY seq LIMIT 10000"
        } else {
            "SELECT entity FROM processed ORDER BY seq LIMIT 10000"
        };
        let mut statement = self.db.prepare(sql).map_err(sql_error)?;
        let mut cursor = statement.query([]).map_err(sql_error)?;
        let mut samples = Vec::new();
        while let Some(record) = cursor.next().map_err(sql_error)? {
            check_cancel(cancel)?;
            samples.push(vec![record.get::<_, String>(0).map_err(sql_error)?]);
        }
        Ok(ledger_mapping::column_is_measurement_unit(
            std::slice::from_ref(name),
            &samples,
            0,
        ))
    }
    pub fn evidence_selected(&self, cancel: &AtomicBool) -> Result<SignEvidence, AppError> {
        self.evidence(true, cancel)
    }
    fn evidence(&self, selected: bool, cancel: &AtomicBool) -> Result<SignEvidence, AppError> {
        let scheme = AmountColumns::new(&self.table.headers, &self.mapping).scheme();
        let mut evidence = ledger_mapping::je_sign_evidence_single(0);
        evidence.scheme = scheme;
        evidence.convention = None;
        evidence.note = None;
        let key_column = if self.entity_is_unit(selected, cancel)? {
            "signkey_noentity"
        } else {
            "signkey"
        };
        let filter = if selected {
            "WHERE voucher IN (SELECT voucher FROM selected)"
        } else {
            ""
        };
        let mut statement=self.db.prepare(&format!("SELECT {key_column},dr,cr,raw,hd,hc,pos,neg FROM processed {filter} ORDER BY {key_column},seq")).map_err(sql_error)?;
        let mut cursor = statement.query([]).map_err(sql_error)?;
        let mut key: Option<String> = None;
        let mut vote = Vote::default();
        let mut positive = 0_i64;
        let mut negative = 0_i64;
        let mut index = 0;
        while let Some(record) = cursor.next().map_err(sql_error)? {
            if index % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            index += 1;
            let next: String = record.get(0).map_err(sql_error)?;
            if key.as_ref() != Some(&next) {
                if key.is_some() {
                    vote.finish(&mut evidence);
                }
                key = Some(next);
                vote = Vote::default();
            }
            vote.dr += record.get::<_, f64>(1).map_err(sql_error)?;
            vote.cr += record.get::<_, f64>(2).map_err(sql_error)?;
            vote.raw += record.get::<_, f64>(3).map_err(sql_error)?;
            vote.hd |= record.get::<_, bool>(4).map_err(sql_error)?;
            vote.hc |= record.get::<_, bool>(5).map_err(sql_error)?;
            positive += record.get::<_, i64>(6).map_err(sql_error)?;
            negative += record.get::<_, i64>(7).map_err(sql_error)?;
        }
        if key.is_some() {
            vote.finish(&mut evidence);
        }
        if scheme == "single" {
            return Ok(ledger_mapping::je_sign_evidence_single(
                evidence.total_vouchers,
            ));
        }
        evidence.convention = if evidence.signed_votes > evidence.unsigned_votes {
            Some(SignConvention::Signed)
        } else if evidence.unsigned_votes > evidence.signed_votes {
            Some(SignConvention::Unsigned)
        } else if evidence.signed_votes > 0 {
            None
        } else if positive == 0 && negative == 0 {
            Some(SignConvention::Unsigned)
        } else if negative > positive {
            Some(SignConvention::Signed)
        } else if positive > negative {
            Some(SignConvention::Unsigned)
        } else {
            None
        };
        evidence.note = Some(format!(
            "磁盘全量判定：已带符号 {} 票，借贷符号一样 {} 票；列级证据正向 {}、负向 {}。",
            evidence.signed_votes, evidence.unsigned_votes, positive, negative
        ));
        Ok(evidence)
    }
    /// Select whole vouchers. Exclusions are intentionally independent: they
    /// never delete the counterparty lines of a selected voucher.
    pub fn select(&self, targets: &[String], cancel: &AtomicBool) -> Result<usize, AppError> {
        check_cancel(cancel)?;
        self.db.execute_batch("DROP TABLE IF EXISTS temp.selected; CREATE TEMP TABLE selected(voucher TEXT PRIMARY KEY) WITHOUT ROWID; DROP TABLE IF EXISTS temp.targets; CREATE TEMP TABLE targets(account TEXT PRIMARY KEY) WITHOUT ROWID;").map_err(sql_error)?;
        let mut normalized = 0;
        for target in targets {
            let target = normalize_account_text(target);
            if !target.is_empty() {
                self.db
                    .execute("INSERT OR IGNORE INTO targets VALUES(?1)", [target])
                    .map_err(sql_error)?;
                normalized += 1;
            }
        }
        // Avoid one uninterruptible INSERT..SELECT over millions of rows. The
        // cursor provides cancellation/resource checkpoints; the PK performs
        // the same voucher de-duplication on disk.
        let transaction = self.db.unchecked_transaction().map_err(sql_error)?;
        let sql = if normalized == 0 {
            "SELECT voucher FROM processed ORDER BY seq"
        } else {
            "SELECT p.voucher FROM processed p JOIN targets t ON t.account=p.account_norm"
        };
        let mut scan = transaction.prepare(sql).map_err(sql_error)?;
        let mut cursor = scan.query([]).map_err(sql_error)?;
        let mut insert = transaction
            .prepare("INSERT OR IGNORE INTO selected VALUES(?1)")
            .map_err(sql_error)?;
        let mut scanned = 0usize;
        while let Some(row) = cursor.next().map_err(sql_error)? {
            if scanned % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            insert
                .execute([row.get::<_, String>(0).map_err(sql_error)?])
                .map_err(sql_error)?;
            scanned += 1;
        }
        drop(insert);
        drop(cursor);
        drop(scan);
        transaction.commit().map_err(sql_error)?;
        check_cancel(cancel)?;
        Ok(self
            .db
            .query_row(
                "SELECT COUNT(*) FROM processed WHERE voucher IN (SELECT voucher FROM selected)",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(sql_error)? as usize)
    }
    /// Legacy analysis re-detects the sign on the selected rows. Preparation's
    /// balance cleaning must precede this and must never be repeated here.
    pub fn set_selected_convention(&self, convention: SignConvention) -> Result<(), AppError> {
        self.selected_convention.set(convention);
        Ok(())
    }
    pub(super) fn selected_net_column(&self) -> &'static str {
        if self.selected_convention.get() == SignConvention::Signed {
            "raw"
        } else {
            "unsigned"
        }
    }
    pub fn visit_selected(
        &self,
        cancel: &AtomicBool,
        mut visit: impl FnMut(Vec<String>, f64) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.visit_query(&format!("SELECT r.data,p.{} FROM processed p JOIN raw_cache.rows r ON r.rowid=p.seq+1 WHERE p.voucher IN (SELECT voucher FROM selected) ORDER BY p.seq",self.selected_net_column()),cancel,&mut visit)
    }
    fn visit_selected_marked(
        &self,
        cancel: &AtomicBool,
        mut visit: impl FnMut(Vec<String>, f64, bool) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut statement=self.db.prepare(&format!("SELECT r.data,p.{},EXISTS(SELECT 1 FROM detail_loss l WHERE l.voucher=p.voucher) FROM processed p JOIN raw_cache.rows r ON r.rowid=p.seq+1 WHERE p.voucher IN (SELECT voucher FROM selected) ORDER BY p.seq",self.selected_net_column())).map_err(sql_error)?;
        let mut cursor = statement.query([]).map_err(sql_error)?;
        let mut index = 0usize;
        while let Some(record) = cursor.next().map_err(sql_error)? {
            if index % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            index += 1;
            let text: String = record.get(0).map_err(sql_error)?;
            let row = serde_json::from_str(&text).map_err(|e| {
                error(
                    "LEDGER_CACHE_FAILED",
                    "磁盘凭证明细损坏。",
                    Some(e.to_string()),
                )
            })?;
            visit(
                row,
                record.get(1).map_err(sql_error)?,
                record.get(2).map_err(sql_error)?,
            )?;
        }
        Ok(())
    }
    fn visit_query(
        &self,
        sql: &str,
        cancel: &AtomicBool,
        visit: &mut impl FnMut(Vec<String>, f64) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut statement = self.db.prepare(sql).map_err(sql_error)?;
        let mut cursor = statement.query([]).map_err(sql_error)?;
        let mut index = 0;
        while let Some(record) = cursor.next().map_err(sql_error)? {
            if index % 1000 == 0 {
                check_cancel(cancel)?;
                crate::resource_budget::check_available()?;
            }
            index += 1;
            let text: String = record.get(0).map_err(sql_error)?;
            let row = serde_json::from_str(&text).map_err(|e| {
                error(
                    "LEDGER_CACHE_FAILED",
                    "磁盘凭证明细损坏。",
                    Some(e.to_string()),
                )
            })?;
            visit(row, record.get(1).map_err(sql_error)?)?;
        }
        Ok(())
    }
    pub fn visit_excluded(
        &self,
        excludes: &[String],
        cancel: &AtomicBool,
        mut visit: impl FnMut(Vec<String>, f64) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.db.execute_batch("DROP TABLE IF EXISTS temp.excludes;CREATE TEMP TABLE excludes(account TEXT PRIMARY KEY) WITHOUT ROWID;").map_err(sql_error)?;
        for account in excludes {
            let account = normalize_account_text(account);
            if !account.is_empty() {
                self.db
                    .execute("INSERT OR IGNORE INTO excludes VALUES(?1)", [account])
                    .map_err(sql_error)?;
            }
        }
        self.visit_query("SELECT r.data,p.net FROM processed p JOIN raw_cache.rows r ON r.rowid=p.seq+1 WHERE p.account_norm IN (SELECT account FROM excludes) ORDER BY p.seq",cancel,&mut visit)
    }

    /// Write selected complete-voucher detail without collecting rows in RAM.
    /// Naming and UTF-8 BOM match `write_kanzhang_csv_suite`.
    pub fn write_selected_csv(
        &self,
        base: &Path,
        headers: &[String],
        rows_per_part: usize,
        mark_loss_transfer: bool,
        progress: Progress<'_>,
        cancel: &AtomicBool,
    ) -> Result<DetailExport, AppError> {
        use std::io::Write;

        let total = self
            .db
            .query_row(
                "SELECT COUNT(*) FROM processed WHERE voucher IN (SELECT voucher FROM selected)",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(sql_error)? as usize;
        let per_part = rows_per_part.max(1);
        let parts = total.max(1).div_ceil(per_part);
        let parent = base.parent().unwrap_or(Path::new("."));
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let output_path = |part: usize| {
            if parts == 1 {
                parent.join(format!("{stem}_凭证明细.csv"))
            } else {
                parent.join(format!("{stem}_凭证明细_Part{}.csv", part + 1))
            }
        };

        let mut paths = Vec::with_capacity(parts);
        let mut pending = Vec::<(PathBuf, PathBuf)>::with_capacity(parts);
        let mut final_path = output_path(0);
        let mut partial = partial_path(&final_path);
        let mut file = File::create(&partial).map_err(io_error)?;
        file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
        if mark_loss_transfer {
            self.db.execute_batch("DROP TABLE IF EXISTS temp.detail_loss;CREATE TEMP TABLE detail_loss(voucher TEXT PRIMARY KEY) WITHOUT ROWID;INSERT INTO detail_loss SELECT DISTINCT voucher FROM processed WHERE account LIKE '%本年利润%' OR account LIKE '%未分配利润%';").map_err(sql_error)?;
        }
        let output_headers = if mark_loss_transfer {
            std::iter::once("【损益结转】".to_owned())
                .chain(headers.iter().cloned())
                .collect::<Vec<_>>()
        } else {
            headers.to_vec()
        };
        // The large CSV cache preserves each source record's physical width.
        // Merged CSV files can therefore contain records that omit different
        // numbers of trailing empty fields even though the normalized header
        // covers the widest record. Pad those fields during streaming export
        // so the detail file remains rectangular without rebuilding the cache.
        let mut writer = Some(csv::WriterBuilder::new().flexible(true).from_writer(file));
        writer
            .as_mut()
            .unwrap()
            .write_record(&output_headers)
            .map_err(csv_error)?;
        let mut written = 0usize;
        let mut last_progress = Instant::now();
        let mut write_row = |mut row: Vec<String>, loss: bool| -> Result<(), AppError> {
            if written > 0 && written % per_part == 0 {
                writer.as_mut().unwrap().flush().map_err(io_error)?;
                drop(writer.take());
                pending.push((partial.clone(), final_path.clone()));
                let part = written / per_part;
                final_path = output_path(part);
                partial = partial_path(&final_path);
                let mut next = File::create(&partial).map_err(io_error)?;
                next.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
                writer = Some(csv::WriterBuilder::new().flexible(true).from_writer(next));
                writer
                    .as_mut()
                    .unwrap()
                    .write_record(&output_headers)
                    .map_err(csv_error)?;
            }
            if row.len() < headers.len() {
                row.resize(headers.len(), String::new());
            }
            if mark_loss_transfer {
                row.insert(
                    0,
                    if loss {
                        "损益结转".into()
                    } else {
                        String::new()
                    },
                );
            }
            writer
                .as_mut()
                .unwrap()
                .write_record(row)
                .map_err(csv_error)?;
            written += 1;
            if last_progress.elapsed() >= Duration::from_millis(500) {
                progress(
                    "detail",
                    written,
                    total,
                    &format!("正在流式写出凭证明细：{} / {} 行…", written, total),
                );
                last_progress = Instant::now();
            }
            Ok(())
        };
        let result = if mark_loss_transfer {
            self.visit_selected_marked(cancel, |row, _, loss| write_row(row, loss))
        } else {
            self.visit_selected(cancel, |row, _| write_row(row, false))
        };
        if let Err(err) = result {
            let _ = fs::remove_file(&partial);
            for (part, _) in &pending {
                let _ = fs::remove_file(part);
            }
            return Err(err);
        }
        writer.as_mut().unwrap().flush().map_err(io_error)?;
        drop(writer.take());
        pending.push((partial, final_path));
        for (partial, final_path) in pending {
            if let Err(err) = replace_file(&partial, &final_path) {
                let _ = fs::remove_file(&partial);
                return Err(err);
            }
            paths.push(final_path);
        }
        progress("detail", total, total, "凭证明细已写出。");
        Ok(DetailExport {
            paths,
            rows: written,
        })
    }

    pub fn write_excluded_csv(
        &self,
        base: &Path,
        headers: &[String],
        excludes: &[String],
        cancel: &AtomicBool,
    ) -> Result<Option<PathBuf>, AppError> {
        use std::io::Write;
        if excludes
            .iter()
            .all(|v| normalize_account_text(v).is_empty())
        {
            return Ok(None);
        }
        let parent = base.parent().unwrap_or(Path::new("."));
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let path = parent.join(format!("{stem}_剔除明细.csv"));
        let partial = partial_path(&path);
        let mut file = File::create(&partial).map_err(io_error)?;
        file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
        let mut writer = csv::WriterBuilder::new().flexible(true).from_writer(file);
        writer.write_record(headers).map_err(csv_error)?;
        let mut rows = 0usize;
        let result = self.visit_excluded(excludes, cancel, |mut row, _| {
            if row.len() < headers.len() {
                row.resize(headers.len(), String::new());
            }
            writer.write_record(row).map_err(csv_error)?;
            rows += 1;
            Ok(())
        });
        if let Err(err) = result {
            let _ = fs::remove_file(&partial);
            return Err(err);
        }
        writer.flush().map_err(io_error)?;
        drop(writer);
        if rows == 0 {
            let _ = fs::remove_file(&partial);
            return Ok(None);
        }
        replace_file(&partial, &path)?;
        Ok(Some(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn fixture() -> (DiskLedger, PathBuf) {
        let root = std::env::temp_dir().join(format!("disk-ledger-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let headers = vec!["凭证号".into(), "科目".into(), "借方".into(), "贷方".into()];
        let rows: [Vec<String>; 4] = [
            vec!["001".into(), "现金".into(), "100".into(), "".into()],
            vec!["001".into(), "收入".into(), "".into(), "100".into()],
            vec!["002".into(), "银行".into(), "40".into(), "".into()],
            vec!["002".into(), "费用".into(), "".into(), "40".into()],
        ];
        let db = Connection::open("").unwrap();
        db.execute_batch("CREATE TABLE processed(seq INTEGER PRIMARY KEY,voucher TEXT,account TEXT,account_norm TEXT,net REAL,raw REAL,unsigned REAL); ATTACH DATABASE ':memory:' AS raw_cache; CREATE TABLE raw_cache.rows(data TEXT NOT NULL)").unwrap();
        for (seq, row) in rows.iter().enumerate() {
            db.execute(
                "INSERT INTO raw_cache.rows VALUES(?1)",
                [serde_json::to_string(row).unwrap()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO processed VALUES(?1,?2,?3,?3,?4,?4,?4)",
                params![
                    seq as i64,
                    row[0],
                    normalize_account_text(&row[1]),
                    if seq % 2 == 0 { 100.0 } else { -100.0 }
                ],
            )
            .unwrap();
        }
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_name: vec!["科目".into()],
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let table = Table {
            path: root.join("source.csv"),
            sheet: "CSV".into(),
            headers,
            rows: Vec::new(),
            sheets: Vec::new(),
            encoding: Some("UTF-8".into()),
            delimiter: Some(','),
        };
        (
            DiskLedger {
                db,
                table,
                count: rows.len(),
                convention: SignConvention::Unsigned,
                selected_convention: Cell::new(SignConvention::Unsigned),
                mapping,
            },
            root,
        )
    }

    #[test]
    fn prepared_cache_reuses_indexes_and_reads_rows_from_raw_cache() {
        let root =
            std::env::temp_dir().join(format!("disk-ledger-cache-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("source.csv");
        fs::write(
            &input,
            "凭证号,科目,借方,贷方\n001,现金,100,0\n001,收入,0,100\n002,银行,40,0\n002,费用,0,40\n",
        )
        .unwrap();
        let source = SourceParams {
            input_path: input.to_string_lossy().into_owned(),
            sheet: None,
            header_row: 1,
        };
        let cancel = AtomicBool::new(false);
        let cache = large_csv::load(&source, &|_, _, _, _| {}, &cancel).unwrap();
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_name: vec!["科目".into()],
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let key = prepared_key(&cache, &mapping, None, 1).unwrap();
        let prepared_path = cache_path("kanzhang-ledger", &key)
            .unwrap()
            .with_extension("sqlite");
        let _ = fs::remove_file(&prepared_path);

        let first_messages = RefCell::new(Vec::new());
        let first = prepare(
            &cache,
            &mapping,
            None,
            1,
            &|_, _, _, message| first_messages.borrow_mut().push(message.to_owned()),
            &cancel,
        )
        .unwrap();
        assert_eq!(first.count, 4);
        let data_columns: i64 = first
            .db
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('processed') WHERE name='data'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(data_columns, 0, "分析缓存不应重复保存整行 JSON");
        drop(first);

        let second_messages = RefCell::new(Vec::new());
        let second = prepare(
            &cache,
            &mapping,
            None,
            1,
            &|_, _, _, message| second_messages.borrow_mut().push(message.to_owned()),
            &cancel,
        )
        .unwrap();
        assert!(
            second_messages
                .borrow()
                .iter()
                .any(|message| message.contains("已复用凭证分析缓存"))
        );
        second.select(&["收入".into()], &cancel).unwrap();
        second
            .set_selected_convention(SignConvention::Unsigned)
            .unwrap();
        let mut accounts = Vec::new();
        second
            .visit_selected(&cancel, |row, _| {
                accounts.push(row[1].clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(accounts, ["现金", "收入"]);

        drop(second);
        let raw_path = cache.path.clone();
        drop(cache);
        let _ = fs::remove_file(prepared_path);
        let _ = fs::remove_file(raw_path);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selecting_one_account_returns_the_complete_voucher_in_source_order() {
        let (ledger, root) = fixture();
        let cancel = AtomicBool::new(false);
        assert_eq!(ledger.select(&["收入".into()], &cancel).unwrap(), 2);
        let mut result = Vec::new();
        ledger
            .visit_selected(&cancel, |row, net| {
                result.push((row, net));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            result
                .iter()
                .map(|(row, _)| row[1].as_str())
                .collect::<Vec<_>>(),
            ["现金", "收入"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_amount_error_identifies_the_cell_for_the_user() {
        let headers = vec!["凭证号".into(), "金额".into()];
        let row = vec!["001".into(), "无法识别".into()];
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            amount: Some("金额".into()),
            ..Default::default()
        };
        let err = validate_disk_amount_row(&headers, &row, &mapping, 41).unwrap_err();
        assert_eq!(err.code, "KANZHANG_AMOUNT_VALUE_INVALID");
        assert_eq!(
            err.user_message,
            "金额列「金额」第42行的值“无法识别”无法解析为数值，请修正后重试。"
        );
    }

    #[test]
    fn selected_csv_is_split_atomically_with_a_header_in_every_part() {
        let (ledger, root) = fixture();
        let cancel = AtomicBool::new(false);
        ledger.select(&[], &cancel).unwrap();
        let output = ledger
            .write_selected_csv(
                &root.join("结果.csv"),
                &ledger.table.headers,
                2,
                true,
                &|_, _, _, _| {},
                &cancel,
            )
            .unwrap();
        assert_eq!(output.rows, 4);
        assert_eq!(output.paths.len(), 2);
        for path in &output.paths {
            let bytes = fs::read(path).unwrap();
            assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
            let text = String::from_utf8_lossy(&bytes[3..]);
            assert!(text.starts_with("【损益结转】,凭证号,科目,借方,贷方"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_csv_pads_missing_trailing_fields_from_merged_sources() {
        let (ledger, root) = fixture();
        let short_row = vec!["001", "现金", "100"];
        ledger
            .db
            .execute(
                "UPDATE raw_cache.rows SET data=?1 WHERE rowid=1",
                [serde_json::to_string(&short_row).unwrap()],
            )
            .unwrap();
        let cancel = AtomicBool::new(false);
        ledger.select(&[], &cancel).unwrap();
        let output = ledger
            .write_selected_csv(
                &root.join("结果.csv"),
                &ledger.table.headers,
                100,
                true,
                &|_, _, _, _| {},
                &cancel,
            )
            .unwrap();

        let bytes = fs::read(&output.paths[0]).unwrap();
        let mut reader = csv::Reader::from_reader(&bytes[3..]);
        let records = reader.records().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(reader.headers().unwrap().len(), 5);
        assert_eq!(records[0].len(), 5);
        assert_eq!(records[0].get(4), Some(""));
        fs::remove_dir_all(root).unwrap();
    }
}
