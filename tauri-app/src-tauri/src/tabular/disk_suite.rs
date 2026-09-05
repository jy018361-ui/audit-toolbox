//! Bounded-memory ledger analysis. Detail rows, voucher membership and aggregates
//! remain in SQLite; only one voucher and the minimal classification sets are
//! resident. The latter are guarded by the caller's dynamic memory budget.
use super::disk_ledger::DiskLedger;
use super::*;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) struct DiskSuiteResult {
    pub summary: PivotResult,
    pub loss_count: usize,
    pub voucher_count: usize,
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
    while let Some(record) = cursor.next().map_err(db_error)? {
        if count % 2000 == 0 {
            check_cancel(cancel)?;
            progress(
                "analyze",
                count,
                ledger.count,
                "正在分批汇总凭证和科目，分析索引保存在磁盘…",
            );
        }
        let seq: i64 = record.get(0).map_err(db_error)?;
        let raw: String = record.get(1).map_err(db_error)?;
        guard(raw.len().saturating_mul(4), budget)?;
        let row: Vec<String> = serde_json::from_str(&raw).map_err(json_error)?;
        let id: String = record.get(2).map_err(db_error)?;
        let account: String = record.get(3).map_err(db_error)?;
        let net: f64 = record.get(4).map_err(db_error)?;
        let loss = job.mark_loss_transfer
            && accounts.iter().any(|i| {
                row.get(*i)
                    .is_some_and(|s| s.contains("本年利润") || s.contains("未分配利润"))
            });
        db.execute("INSERT INTO suite_vouchers VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET loss=MAX(loss,excluded.loss)",params![id,seq,loss]).map_err(db_error)?;
        db.execute("INSERT INTO suite_nets VALUES(?1,?2,?3) ON CONFLICT(id,account) DO UPDATE SET net=net+excluded.net",params![id,account,net]).map_err(db_error)?;
        db.execute("INSERT INTO suite_subject VALUES(?1,?2,1) ON CONFLICT(account) DO UPDATE SET net=net+excluded.net,count=count+1",params![account,net]).map_err(db_error)?;
        let direction_value = direction
            .and_then(|i| row.get(i))
            .map(|s| s.trim())
            .unwrap_or("");
        db.execute("INSERT INTO suite_pivot VALUES(?1,?2,?3,?4) ON CONFLICT(id,account,direction) DO UPDATE SET net=net+excluded.net",params![id,account,direction_value,net]).map_err(db_error)?;
        if let Some(month) = config
            .date
            .and_then(|i| row.get(i))
            .and_then(|s| parse_month(s))
        {
            db.execute("INSERT INTO suite_month VALUES(?1,?2,?3,?4) ON CONFLICT(id,month,account) DO UPDATE SET net=net+excluded.net",params![id,month,account,net]).map_err(db_error)?;
        }
        if let Some(value) = summary
            .and_then(|i| row.get(i))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            // Only the first three distinct summaries of each voucher can ever
            // contribute to the original type-summary algorithm.
            db.execute("INSERT OR IGNORE INTO suite_summaries SELECT ?1,?2,?3 WHERE (SELECT COUNT(*) FROM suite_summaries WHERE id=?1)<3",params![id,value,seq]).map_err(db_error)?;
        }
        count += 1;
    }
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
                db.execute("INSERT INTO suite_custom VALUES(?1,?2,?3) ON CONFLICT(rowkey,col) DO UPDATE SET net=net+excluded.net",params![encode(&key)?,col,amount]).map_err(db_error)?;
            }
        }
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
    let mut minimal = Vec::new();
    for candidate in &unique {
        check_cancel(cancel)?;
        if !unique
            .iter()
            .any(|other| other.len() < candidate.len() && other.is_subset(candidate))
        {
            minimal.push(candidate.clone());
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
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    classify(db, strict, budget, cancel)?;
    db.execute_batch("DROP TABLE IF EXISTS suite_group_target; DROP TABLE IF EXISTS suite_group_account;
        DROP TABLE IF EXISTS suite_group_month;
        CREATE TEMP TABLE suite_group_target(grp INTEGER,account TEXT,PRIMARY KEY(grp,account));
        CREATE TEMP TABLE suite_group_account(grp INTEGER,account TEXT,net REAL,PRIMARY KEY(grp,account));
        CREATE TEMP TABLE suite_group_month(grp INTEGER,account TEXT,month TEXT,net REAL,PRIMARY KEY(grp,account,month));").map_err(db_error)?;
    let tx = db.unchecked_transaction().map_err(db_error)?;
    let mut groups = db
        .prepare("SELECT DISTINCT grp FROM suite_members ORDER BY grp")
        .map_err(db_error)?;
    let mut groups = groups.query([]).map_err(db_error)?;
    while let Some(group) = groups.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let grp: i64 = group.get(0).map_err(db_error)?;
        let mut stmt=db.prepare("SELECT s.signs FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq WHERE m.grp=?1 ORDER BY m.seq").map_err(db_error)?;
        let mut rows = stmt.query([grp]).map_err(db_error)?;
        while let Some(row) = rows.next().map_err(db_error)? {
            let signs: BTreeMap<String, i8> =
                serde_json::from_str(&row.get::<_, String>(0).map_err(db_error)?)
                    .map_err(json_error)?;
            for account in signs.keys() {
                db.execute(
                    "INSERT OR IGNORE INTO suite_group_target VALUES(?1,?2)",
                    params![grp, account],
                )
                .map_err(db_error)?;
            }
        }
        db.execute("INSERT INTO suite_group_account SELECT ?1,n.account,SUM(n.net) FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_nets n ON n.id=s.id WHERE m.grp=?1 GROUP BY n.account",[grp]).map_err(db_error)?;
        db.execute("INSERT INTO suite_group_month SELECT ?1,x.account,x.month,SUM(x.net) FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_month x ON x.id=s.id WHERE m.grp=?1 GROUP BY x.account,x.month",[grp]).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
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
    let mut groups = db
        .prepare("SELECT DISTINCT grp FROM suite_members ORDER BY grp")
        .map_err(db_error)?;
    let mut groups = groups.query([]).map_err(db_error)?;
    while let Some(group) = groups.next().map_err(db_error)? {
        check_cancel(cancel)?;
        let grp: i64 = group.get(0).map_err(db_error)?;
        let rep:String=db.query_row("SELECT s.id FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq WHERE m.grp=?1 ORDER BY m.seq LIMIT 1",[grp],|r|r.get(0)).map_err(db_error)?;
        let targets = {
            let mut stmt = db
                .prepare("SELECT account FROM suite_group_target WHERE grp=?1 ORDER BY account")
                .map_err(db_error)?;
            stmt.query_map([grp], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        let mut labels = Vec::new();
        for account in targets {
            // Rank representatives for this target exactly as the BTreeSet in
            // the ordinary implementation: distinct ID, lexical ordering.
            let rank:i64=db.query_row("SELECT COUNT(DISTINCT s.id) FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_group_target t ON t.grp=m.grp WHERE t.account=?1 AND s.id<=?2 AND s.seq=(SELECT MIN(q.seq) FROM suite_members q WHERE q.grp=m.grp)",params![account,rep],|r|r.get(0)).map_err(db_error)?;
            labels.push(format!("{account}-类型{}", rank.max(1)));
        }
        let label = labels.join(" | ");
        let summaries = {
            let mut stmt=db.prepare("SELECT x.value FROM suite_members m JOIN suite_shapes s ON s.seq=m.seq JOIN suite_summaries x ON x.id=s.id WHERE m.grp=?1 GROUP BY x.value ORDER BY MIN(x.seq) LIMIT 3").map_err(db_error)?;
            stmt.query_map([grp], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
                .join(" | ")
        };
        let mut accounts = db
            .prepare("SELECT account,net FROM suite_group_account WHERE grp=?1 ORDER BY account")
            .map_err(db_error)?;
        let mut accounts = accounts.query([grp]).map_err(db_error)?;
        while let Some(account) = accounts.next().map_err(db_error)? {
            let name: String = account.get(0).map_err(db_error)?;
            let net = round_to_cent(account.get(1).map_err(db_error)?);
            let mut output = vec![
                label.clone(),
                display_voucher_key(&rep),
                summaries.clone(),
                name.clone(),
                format_number(net),
            ];
            let mut nonzero = net != 0.0;
            for month in &months {
                let value:Option<f64>=db.query_row("SELECT net FROM suite_group_month WHERE grp=?1 AND account=?2 AND month=?3",params![grp,name,month],|r|r.get(0)).optional().map_err(db_error)?;
                let value = round_to_cent(value.unwrap_or(0.0));
                nonzero |= value != 0.0;
                output.push(format_number(value));
            }
            if nonzero {
                let (sort_head, sort_rank) = type_sort_key(&label);
                db.execute("INSERT INTO suite_output(sheet,sort_head,sort_rank,sort_label,sort_account,rowdata) VALUES(?1,?2,?3,?4,?5,?6)",params![sheet,sort_head,sort_rank,label,name,encode(&output)?]).map_err(db_error)?;
            }
        }
    }
    tx.commit().map_err(db_error)
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
    progress("classify", 0, 2, "正在按原有宽松和严格口径归类凭证…");
    if job.include_voucher_types {
        type_rows(&ledger.db, "凭证类型-宽松", false, budget, cancel)?;
        progress("classify", 1, 2, "正在生成严格凭证类型…");
        type_rows(&ledger.db, "凭证类型-严格", true, budget, cancel)?;
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
    let mut workbook = Workbook::new();
    if job.include_pivot {
        let ws = workbook.add_worksheet_with_constant_memory();
        ws.set_name("凭证").map_err(xlsx_error)?;
        let has_direction: bool = ledger
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM suite_pivot WHERE direction<>'')",
                [],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let directions = if has_direction {
            let mut s=ledger.db.prepare("SELECT DISTINCT direction FROM suite_pivot WHERE direction<>'' ORDER BY direction").map_err(db_error)?;
            s.query_map([], |r| r.get::<_, String>(0))
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
        } else {
            Vec::new()
        };
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
        let pivot_rows_sql = if directions.is_empty() {
            "SELECT DISTINCT id,account FROM suite_pivot ORDER BY id,account"
        } else {
            "SELECT DISTINCT id,account FROM suite_pivot WHERE direction<>'' ORDER BY id,account"
        };
        let mut stmt = ledger.db.prepare(pivot_rows_sql).map_err(db_error)?;
        let mut rows = stmt.query([]).map_err(db_error)?;
        let mut index = 1u32;
        while let Some(row) = rows.next().map_err(db_error)? {
            if index % 2000 == 0 {
                check_cancel(cancel)?;
            }
            let id: String = row.get(0).map_err(db_error)?;
            let account: String = row.get(1).map_err(db_error)?;
            let mut values = vec![display_voucher_key(&id), account.clone()];
            if directions.is_empty() {
                let v: f64 = ledger
                    .db
                    .query_row(
                        "SELECT SUM(net) FROM suite_pivot WHERE id=?1 AND account=?2",
                        params![id, account],
                        |r| r.get(0),
                    )
                    .map_err(db_error)?;
                values.push(format_number(round_to_cent(v)));
            } else {
                for d in &directions {
                    let v:Option<f64>=ledger.db.query_row("SELECT net FROM suite_pivot WHERE id=?1 AND account=?2 AND direction=?3",params![id,account,d],|r|r.get(0)).optional().map_err(db_error)?;
                    values.push(format_number(round_to_cent(v.unwrap_or(0.0))));
                }
            }
            write_row(ws, index, &values, 2)?;
            index += 1;
        }
        ws.set_hidden(true);
    }
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
        for name in ["凭证类型-宽松", "凭证类型-严格"] {
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
        }
    }
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
        let mut stmt = ledger
            .db
            .prepare("SELECT DISTINCT rowkey FROM suite_custom ORDER BY rowkey")
            .map_err(db_error)?;
        let mut rows = stmt.query([]).map_err(db_error)?;
        let mut index = 1u32;
        while let Some(row) = rows.next().map_err(db_error)? {
            check_cancel(cancel)?;
            let key: String = row.get(0).map_err(db_error)?;
            let mut values: Vec<String> = serde_json::from_str(&key).map_err(json_error)?;
            if !config.columns.is_empty() {
                let total: f64 = ledger
                    .db
                    .query_row(
                        "SELECT SUM(net) FROM suite_custom WHERE rowkey=?1",
                        [&key],
                        |r| r.get(0),
                    )
                    .map_err(db_error)?;
                values.push(format_number(total));
            }
            for col in &columns {
                let v: Option<f64> = ledger
                    .db
                    .query_row(
                        "SELECT net FROM suite_custom WHERE rowkey=?1 AND col=?2",
                        params![key, col],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_error)?;
                values.push(format_number(v.unwrap_or(0.0)));
            }
            write_row(ws, index, &values, config.rows.len())?;
            index += 1;
        }
    }
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
    if let Some(value) = llm_analysis.as_ref() {
        write_llm_analysis_sheet(workbook.add_worksheet(), value)?;
    }
    activate_first_visible_sheet(&mut workbook);
    let partial = partial_path(path);
    progress("write", 0, 1, "正在以恒定内存写出看账套表…");
    if let Err(failure) = workbook.save(&partial).map_err(xlsx_error) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    if let Err(failure) = replace_file(&partial, path) {
        let _ = fs::remove_file(&partial);
        return Err(failure);
    }
    progress("write", 1, 1, "看账套表已写出。");
    Ok(DiskSuiteResult {
        summary,
        loss_count,
        voucher_count,
    })
}
