//! Complete JE metadata without materializing a full-width business row cache.
use super::*;
use std::time::Instant;

#[derive(Serialize, Deserialize)]
struct Snapshot {
    key: String,
    row_count: usize,
    accounts: BTreeSet<String>,
    entities: BTreeSet<String>,
    combinations: BTreeSet<(String, String)>,
    currencies: BTreeSet<String>,
    years: BTreeSet<i32>,
    latest_date: Option<NaiveDate>,
    currency_details: BTreeMap<String, Value>,
}

impl Snapshot {
    fn apply(self, response: &mut Value) -> Option<NaiveDate> {
        response["rowCount"] = json!(self.row_count);
        response["accounts"] = json!(self.accounts);
        response["accountsLeaf"] = response["accounts"].clone();
        response["entities"] = json!(self.entities);
        response["entityAccounts"] = json!(
            self.combinations
                .into_iter()
                .map(|(entity, account)| json!({"entity":entity,"account":account}))
                .collect::<Vec<_>>()
        );
        response["currencies"] = json!(self.currencies);
        response["accountCurrencyDetails"] = json!(self.currency_details);
        response["dataYears"] = json!(self.years);
        response["suggestedBalanceSheetDate"] = json!(
            self.latest_date
                .map(|date| format!("{}-12-31", date.year()))
        );
        response["metadataComplete"] = json!(true);
        response["sampledPreview"] = json!(false);
        self.latest_date
    }
}

pub(super) fn key(
    source: &SourceSpec,
    headers: &[String],
    mapping: &Map<String, Value>,
    formatter: &str,
) -> Result<String, AppError> {
    let source_key = crate::disk_table::fingerprint(
        Path::new(&source.input_path),
        &source.sheet,
        source.header_row,
        source.header_depth,
    )?;
    // Tools have different account display rules; their snapshots must never mix.
    Ok(cache_hash(&json!([
        "complete-je-v1",
        source_key,
        headers,
        mapping,
        formatter
    ])))
}

pub(super) fn cache_path(key: &str) -> Option<PathBuf> {
    Some(
        crate::tabular::cache_root()
            .ok()?
            .join("je-catalog/v1")
            .join(format!("{key}.catalog")),
    )
}

fn read_cache(key: &str, limit: u64) -> Option<Snapshot> {
    let path = cache_path(key)?;
    if fs::metadata(&path).ok()?.len() > limit {
        return None;
    }
    // Bound the read as well as the stat, in case another process replaces the file.
    let mut bytes = Vec::new();
    std::io::Read::take(fs::File::open(&path).ok()?, limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > limit {
        return None;
    }
    let snapshot: Snapshot = serde_json::from_slice(&bytes).ok()?;
    if snapshot.key != key {
        return None;
    }
    let _ = fs::File::options()
        .append(true)
        .open(path)
        .and_then(|file| file.set_modified(std::time::SystemTime::now()));
    Some(snapshot)
}

fn write_cache(snapshot: &Snapshot, limit: u64) {
    let Some(path) = cache_path(&snapshot.key) else {
        return;
    };
    let Ok(bytes) = serde_json::to_vec(snapshot) else {
        return;
    };
    if bytes.len() as u64 > limit {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let partial = parent.join(format!("{}.partial", uuid::Uuid::new_v4()));
    if fs::write(&partial, bytes).is_ok() {
        let _ = crate::tabular::replace_file(&partial, &path);
    }
    let _ = fs::remove_file(partial);
}

pub(super) fn complete(
    source: &SourceSpec,
    headers: &[String],
    mapping: &Map<String, Value>,
    formatter: &str,
    response: &mut Value,
    account_of: impl Fn(&[String]) -> String,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
) -> Result<Option<NaiveDate>, AppError> {
    let check = || {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        crate::resource_budget::check_available_if_managed()
    };
    check()?;
    let limit = (crate::resource_budget::budget()?.worker_bytes / 8).min(64 * 1024 * 1024);
    let identity = key(source, headers, mapping, formatter)?;
    if let Some(snapshot) = read_cache(&identity, limit) {
        check()?;
        if key(source, headers, mapping, formatter)? != identity {
            return Err(error(
                "SOURCE_CHANGED",
                "读取期间源文件发生变化，请重新读取。",
                None,
            ));
        }
        progress(
            "je_catalog",
            snapshot.row_count,
            snapshot.row_count,
            "已复用完整序时账目录。",
        );
        return Ok(snapshot.apply(response));
    }
    let columns = |role| {
        mapped_cols(mapping, role)
            .iter()
            .filter_map(|column| ledger_mapping::header_index(headers, column))
            .collect::<Vec<_>>()
    };
    let entity_columns = columns("entity");
    let date_columns = columns("date");
    let currency_columns = columns("currency");
    let functional_currency_columns = columns("functionalCurrency");
    let selected = mapping
        .iter()
        .filter(|(role, _)| {
            matches!(
                ledger_mapping::migrate_role_name("je", role),
                "accountCode"
                    | "accountName"
                    | "account"
                    | "entity"
                    | "date"
                    | "currency"
                    | "functionalCurrency"
            )
        })
        .flat_map(|(role, _)| columns(role))
        .collect::<HashSet<_>>();
    let mut snapshot = Snapshot {
        key: identity,
        row_count: 0,
        accounts: BTreeSet::new(),
        entities: BTreeSet::new(),
        combinations: BTreeSet::new(),
        currencies: BTreeSet::new(),
        years: BTreeSet::new(),
        latest_date: None,
        currency_details: BTreeMap::new(),
    };
    let mut currency_tally = BTreeMap::new();
    let mut tick = Instant::now();
    let first_data = source.header_row.saturating_add(source.header_depth);
    let mut last_physical = 0;
    progress("je_catalog", 0, 0, "正在完整识别序时账科目、主体及期间…");
    crate::disk_table::for_each_source_row_projected(
        Path::new(&source.input_path),
        &source.sheet,
        &selected,
        cancel,
        |mut row, physical| {
            last_physical = physical;
            if physical < first_data {
                return Ok(());
            }
            snapshot.row_count += 1;
            row.resize(row.len().max(headers.len()), String::new());
            let text = |indexes: &[usize]| {
                indexes
                    .iter()
                    .filter_map(|index| row.get(*index))
                    .map(|v| v.trim())
                    .find(|v| !v.is_empty())
                    .unwrap_or("")
            };
            let entity = text(&entity_columns);
            if !entity.is_empty() { snapshot.entities.insert(entity.to_owned()); }
            let account = account_of(&row);
            tally_account_currency(
                &mut currency_tally,
                &account,
                text(&currency_columns),
                text(&functional_currency_columns),
            );
            if !account.is_empty() && !ledger_mapping::is_report_footer_value(&account) {
                snapshot.accounts.insert(account.clone());
                let entity = if entity.is_empty() {
                    DEFAULT_ENTITY
                } else {
                    entity
                };
                snapshot.combinations.insert((entity.to_owned(), account.clone()));
            }
            let currency = text(&currency_columns);
            if !currency.is_empty() { snapshot.currencies.insert(currency.to_owned()); }
            for index in &date_columns {
                if let Some(date) = row.get(*index).and_then(|value| parse_date(value)) {
                    snapshot.years.insert(date.year());
                    snapshot.latest_date = Some(
                        snapshot
                            .latest_date
                            .map_or(date, |current| current.max(date)),
                    );
                }
            }
            if physical % 256 == 0 {
                check()?;
            }
            if tick.elapsed().as_millis() >= 500 {
                progress(
                    "je_catalog",
                    snapshot.row_count,
                    0,
                    &format!("已完整识别 {} 行序时账…", snapshot.row_count),
                );
                tick = Instant::now();
            }
            Ok(())
        },
    )?;
    check()?;
    if last_physical + 1 < first_data {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    if key(source, headers, mapping, formatter)? != snapshot.key {
        return Err(error(
            "SOURCE_CHANGED",
            "读取期间源文件发生变化，请重新读取。",
            None,
        ));
    }
    snapshot.currency_details = finish_account_currency_tally(currency_tally);
    write_cache(&snapshot, limit);
    progress(
        "je_catalog",
        snapshot.row_count,
        snapshot.row_count,
        "序时账完整目录识别完成。",
    );
    Ok(snapshot.apply(response))
}
