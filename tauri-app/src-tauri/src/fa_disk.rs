//! 固定资产两期清单磁盘连接。重复键按原内核逐序号配对，绝不扩大为笛卡尔积。
use super::disk_rows::db_error;
use super::*;
use rusqlite::{Connection, params};
struct WorkingGuard {
    path: PathBuf,
    armed: bool,
}
impl Drop for WorkingGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn exec_sql(conn: &Connection, sql: &str, cancel: &AtomicBool) -> Result<(), AppError> {
    let done = AtomicBool::new(false);
    let interrupt = conn.get_interrupt_handle();
    let result = std::thread::scope(|scope| {
        let done = &done;
        scope.spawn(move || {
            while !done.load(Ordering::Relaxed) {
                if cancel.load(Ordering::Relaxed) {
                    interrupt.interrupt();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let result = conn.execute_batch(sql);
        done.store(true, Ordering::Relaxed);
        result
    });
    check_cancel(cancel)?;
    result.map_err(db_error)
}

pub(crate) fn load_input(
    path: &Path,
    sheet: Option<&str>,
    header: Option<usize>,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(Table, crate::disk_table::DiskTable), AppError> {
    let (selected, mut sheets, prefix) = crate::disk_table::preview_source(
        path,
        sheet,
        header.unwrap_or(0).saturating_add(2).max(200),
    )?;
    if crate::spreadsheet_input::is_text(path) {
        sheets.clear();
    }
    let hi = header
        .map(|row| row.saturating_sub(1))
        .unwrap_or_else(|| detect_header(&prefix));
    let depth = asset_header_depth(&prefix, hi);
    let mut table = finalize_table(
        path,
        (!sheets.is_empty()).then_some(selected.clone()),
        sheets,
        hi,
        prefix,
        0,
    );
    let disk = crate::disk_table::DiskTable::open_fa(
        path,
        Some(&selected),
        hi + 1,
        depth,
        progress,
        cancel,
    )?;
    table.row_count = disk.row_count;
    Ok((table, disk))
}

pub(super) fn merge(
    params: &Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
    begin_keys: Vec<String>,
    end_keys: Vec<String>,
) -> Result<MergeResult, AppError> {
    let begin_path = required_path(params, "beginPath")?;
    let end_path = required_path(params, "endPath")?;
    progress("load", 0, 4, "正在将两期资产清单分批写入磁盘");
    let (mut begin, b) = load_input(
        &begin_path,
        params.get("beginSheet").and_then(Value::as_str),
        optional_header(params, "beginHeaderRow")?,
        progress,
        cancel,
    )?;
    let (mut end, e) = load_input(
        &end_path,
        params.get("endSheet").and_then(Value::as_str),
        optional_header(params, "endHeaderRow")?,
        progress,
        cancel,
    )?;
    validate_keys(&begin, &begin_keys)?;
    validate_keys(&end, &end_keys)?;
    let root = crate::tabular::cache_root()?.join("fa-merge").join("v2");
    fs::create_dir_all(&root).map_err(io_error)?;
    let stamp = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = root.join(format!("working-{}-{stamp}.sqlite", std::process::id()));
    let mut cleanup = WorkingGuard {
        path: path.clone(),
        armed: true,
    };
    let estimate = crate::disk_table::estimated_resident_bytes(&begin_path)
        .unwrap_or(0)
        .saturating_add(crate::disk_table::estimated_resident_bytes(&end_path).unwrap_or(0));
    crate::resource_budget::check_disk_space(&root, estimate)?;
    let mut conn = Connection::open(&path).map_err(db_error)?;
    exec_sql(
        &conn,
        "PRAGMA temp_store=FILE; PRAGMA cache_size=-16384; PRAGMA journal_mode=DELETE; CREATE TABLE source(side INTEGER,seq INTEGER,k TEXT,display TEXT,data TEXT); CREATE TABLE life(side INTEGER,col TEXT,value REAL,PRIMARY KEY(side,col,value)); CREATE TABLE joined(id INTEGER PRIMARY KEY,data TEXT NOT NULL);",
        cancel,
    )?;
    let remove = params
        .get("removeSpaces")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let sensitive = params
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    for (side, table, input, keys) in [(1, &begin, &b, &begin_keys), (2, &end, &e, &end_keys)] {
        let indices = key_indexes(table, keys);
        let life_header = mapped_header(params, side, "life");
        let life_index = life_header
            .as_ref()
            .and_then(|h| table.headers.iter().position(|c| c == h));
        let tx = conn.transaction().map_err(db_error)?;
        let mut blanks = 0usize;
        let mut seq = 0usize;
        input.visit(cancel, |row, _| {
            if row.iter().all(|cell| cell.trim().is_empty()) {
                return Ok(());
            }
            let mut row = row.to_vec();
            row.resize(table.headers.len(), String::new());
            row.truncate(table.headers.len());
            let mut key = row_key(&row, &indices, remove, sensitive);
            let display = legacy_row_key(&row, &indices, remove, sensitive);
            if key.replace("|||", "").is_empty() {
                blanks += 1;
                key = format!("__BLANK__{blanks:012}");
            }
            if let (Some(i), Some(h)) = (life_index, life_header.as_ref()) {
                if let Some(v) = parse_life_cell(cell(&row, i)).filter(|v| !v.is_nan()) {
                    tx.execute(
                        "INSERT OR IGNORE INTO life VALUES(?,?,?)",
                        params![side, h, v],
                    )
                    .map_err(db_error)?;
                }
            }
            tx.execute(
                "INSERT INTO source VALUES(?,?,?,?,?)",
                params![
                    side,
                    seq,
                    key,
                    display,
                    serde_json::to_string(&row).unwrap()
                ],
            )
            .map_err(db_error)?;
            seq += 1;
            Ok(())
        })?;
        tx.commit().map_err(db_error)?;
    }
    begin.rows.clear();
    end.rows.clear();
    begin.row_count = conn
        .query_row("SELECT COUNT(*) FROM source WHERE side=1", [], |r| r.get(0))
        .map_err(db_error)?;
    end.row_count = conn
        .query_row("SELECT COUNT(*) FROM source WHERE side=2", [], |r| r.get(0))
        .map_err(db_error)?;
    exec_sql(
        &conn,
        "CREATE INDEX source_key ON source(side,k,seq); CREATE TABLE keys AS SELECT k,display,side,seq FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY k ORDER BY side,seq) first FROM source) WHERE first=1; CREATE UNIQUE INDEX keys_key ON keys(k);",
        cancel,
    )?;
    let (duplicate_values,duplicate_rows)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(n),0) FROM (SELECT k,SUM(n) n FROM (SELECT k,side,COUNT(*) n FROM source GROUP BY k,side) GROUP BY k HAVING MAX(n)>1)",[],|r|Ok((r.get::<_,usize>(0)?,r.get::<_,usize>(1)?))).map_err(db_error)?;
    let mode = params
        .get("handleDuplicates")
        .and_then(Value::as_str)
        .unwrap_or("pivot");
    let direction = if mode == "keep_last" { "DESC" } else { "ASC" };
    exec_sql(
        &conn,
        &format!(
            "CREATE TABLE ranked AS SELECT *,ROW_NUMBER() OVER(PARTITION BY side,k ORDER BY seq {direction}) pos FROM source; CREATE INDEX ranked_key ON ranked(side,k,pos);"
        ),
        cancel,
    )?;
    let filter = if matches!(mode, "keep_first" | "keep_last") {
        " AND pos=1"
    } else {
        ""
    };
    exec_sql(
        &conn,
        &format!(
            "CREATE TABLE pairs AS WITH b AS (SELECT * FROM ranked WHERE side=1{filter}),e AS (SELECT * FROM ranked WHERE side=2{filter}) SELECT b.k,b.pos,b.data b,e.data e FROM b LEFT JOIN e ON b.k=e.k AND b.pos=e.pos UNION ALL SELECT e.k,e.pos,NULL,e.data FROM e LEFT JOIN b ON b.k=e.k AND b.pos=e.pos WHERE b.k IS NULL;"
        ),
        cancel,
    )?;
    progress("match", 2, 4, "正在按原有匹配顺序分批生成资产变动");
    let tx = conn.transaction().map_err(db_error)?;
    {
        let mut stmt=tx.prepare("SELECT p.b,p.e,CASE WHEN SUBSTR(p.k,1,9)='__BLANK__' THEN '' ELSE REPLACE(k.display,'|||',' | ') END display FROM pairs p JOIN keys k ON k.k=p.k ORDER BY REPLACE(CASE WHEN SUBSTR(p.k,1,9)='__BLANK__' THEN '' ELSE REPLACE(k.display,'|||',' | ') END,' | ','|||') COLLATE BINARY,k.side,k.seq,p.pos").map_err(db_error)?;
        let mut cursor = stmt.query([]).map_err(db_error)?;
        let mut seq = 0usize;
        while let Some(record) = cursor.next().map_err(db_error)? {
            if seq % 256 == 0 {
                check_cancel(cancel)?;
            }
            let left: Option<String> = record.get(0).map_err(db_error)?;
            let right: Option<String> = record.get(1).map_err(db_error)?;
            let source = match (left.is_some(), right.is_some()) {
                (true, true) => "两文件都有",
                (true, false) => "仅文件1",
                _ => "仅文件2",
            };
            let row = JoinedRow {
                begin: left.map(|v| serde_json::from_str(&v).unwrap()),
                end: right.map(|v| serde_json::from_str(&v).unwrap()),
                source,
                match_value: record.get(2).map_err(db_error)?,
                extra: BTreeMap::new(),
            };
            tx.execute(
                "INSERT INTO joined VALUES(?,?)",
                params![seq + 1, serde_json::to_string(&row).unwrap()],
            )
            .map_err(db_error)?;
            seq += 1;
        }
    }
    tx.commit().map_err(db_error)?;
    exec_sql(
        &conn,
        "DROP TABLE pairs; DROP TABLE ranked; DROP TABLE keys; PRAGMA optimize;",
        cancel,
    )?;
    drop(conn);
    let mut result = MergeResult {
        begin,
        end,
        rows: JoinedRows::open(path)?,
        begin_keys,
        end_keys,
        duplicate_values,
        duplicate_rows,
        unmatched_addition: Vec::new(),
        unmatched_disposal: Vec::new(),
    };
    cleanup.armed = false;
    add_change_columns(&mut result, params, cancel)?;
    apply_supplements(&mut result, params, cancel)?;
    Ok(result)
}

pub(super) fn life_scale(rows: &JoinedRows, header: &str, side: u8) -> Option<f64> {
    let path = rows.path()?;
    let value = (|| -> Result<f64, AppError> {
        let conn = Connection::open(path).map_err(db_error)?;
        let mut stmt = conn
            .prepare("SELECT value FROM life WHERE side=? AND col=?")
            .map_err(db_error)?;
        let values = stmt
            .query_map(params![side, header], |row| row.get::<_, f64>(0))
            .map_err(db_error)?;
        let mut stats = LifeScaleStats::default();
        for value in values {
            stats.push(value.map_err(db_error)?);
        }
        Ok(stats.scale(header))
    })();
    match value {
        Ok(scale) => Some(scale),
        Err(error) => {
            rows.record_error(error.user_message);
            Some(1.0)
        }
    }
}

pub(crate) struct SourceIter {
    conn: Option<Connection>,
    after: i64,
    buffer: std::collections::VecDeque<(i64, Vec<String>)>,
    error: Option<AppError>,
    done: bool,
    side: Option<u8>,
    unmatched: bool,
}
impl SourceIter {
    pub(crate) fn open(path: &Path) -> Self {
        match Connection::open(path) {
            Ok(conn) => Self {
                conn: Some(conn),
                after: 0,
                buffer: Default::default(),
                error: None,
                done: false,
                side: None,
                unmatched: false,
            },
            Err(e) => Self {
                conn: None,
                after: 0,
                buffer: Default::default(),
                error: Some(db_error(e)),
                done: false,
                side: None,
                unmatched: false,
            },
        }
    }
}
impl SourceIter {
    pub(super) fn source(path: &Path, side: u8) -> Self {
        let mut iter = Self::open(path);
        iter.side = Some(side);
        iter.after = -1;
        iter
    }
    pub(super) fn unmatched(path: &Path, disposal: bool) -> Self {
        let mut iter = Self::source(path, if disposal { 2 } else { 1 });
        iter.unmatched = true;
        iter
    }
}
impl Iterator for SourceIter {
    type Item = Result<Vec<String>, AppError>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Some(error) = self.error.take() {
            self.done = true;
            return Some(Err(error));
        }
        if self.buffer.is_empty() && !self.done {
            let loaded = (|| -> Result<Vec<(i64, Vec<String>)>, AppError> {
                let conn = self.conn.as_ref().unwrap();
                let query = if self.unmatched {
                    if self.side == Some(1) {
                        "SELECT id,data FROM unmatched WHERE side=1 AND id>? ORDER BY id LIMIT 256"
                    } else {
                        "SELECT id,data FROM unmatched WHERE side=2 AND id>? ORDER BY id LIMIT 256"
                    }
                } else {
                    match self.side {
                        Some(1) => {
                            "SELECT seq,data FROM source WHERE side=1 AND seq>? ORDER BY seq LIMIT 256"
                        }
                        Some(_) => {
                            "SELECT seq,data FROM source WHERE side=2 AND seq>? ORDER BY seq LIMIT 256"
                        }
                        None => "SELECT id,data FROM rows WHERE id>? ORDER BY id LIMIT 256",
                    }
                };
                let mut stmt = conn.prepare(query).map_err(db_error)?;
                let mut cursor = stmt.query([self.after]).map_err(db_error)?;
                let limit = crate::resource_budget::budget()?.batch_bytes / 4;
                let mut bytes = 0u64;
                let mut output = Vec::new();
                while let Some(row) = cursor.next().map_err(db_error)? {
                    let data: String = row.get(1).map_err(db_error)?;
                    let estimated = (data.len() as u64).saturating_mul(3).saturating_add(512);
                    if bytes.saturating_add(estimated) > limit && !output.is_empty() { break; }
                    if output.is_empty() { crate::resource_budget::check_available_if_managed()?; }
                    bytes += estimated;
                    output.push((
                        row.get(0).map_err(db_error)?,
                        serde_json::from_str(&data).map_err(|e| {
                            error(
                                "FA_DISK_DATA_INVALID",
                                "固定资产磁盘数据损坏，请重新读取。",
                                Some(e.to_string()),
                            )
                        })?,
                    ));
                }
                Ok(output)
            })();
            match loaded {
                Ok(batch) => {
                    self.done = batch.is_empty();
                    self.buffer.extend(batch);
                }
                Err(error) => {
                    self.done = true;
                    return Some(Err(error));
                }
            }
        }
        self.buffer.pop_front().map(|(id, row)| {
            self.after = id;
            Ok(row)
        })
    }
}

pub(super) fn apply_supplements(
    result: &mut MergeResult,
    params: &Value,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let path = result.rows.path().unwrap().to_path_buf();
    result.unmatched_addition.clear();
    result.unmatched_disposal.clear();
    let mut conn = Connection::open(&path).map_err(db_error)?;
    conn.execute_batch("DROP TABLE IF EXISTS valid; DROP TABLE IF EXISTS supplement_text; DROP TABLE IF EXISTS supplement_amount; DROP TABLE IF EXISTS unmatched; CREATE TABLE unmatched(id INTEGER PRIMARY KEY,side INTEGER,data TEXT); CREATE INDEX unmatched_side ON unmatched(side,id); CREATE TABLE valid(k TEXT PRIMARY KEY); CREATE TABLE supplement_text(id INTEGER PRIMARY KEY,k TEXT,field TEXT,value TEXT,UNIQUE(k,field,value)); CREATE INDEX supplement_text_key ON supplement_text(k,field,id); CREATE TABLE supplement_amount(k TEXT,field TEXT,value REAL,PRIMARY KEY(k,field));").map_err(db_error)?;
    let configs = [("additionSupplement", false), ("disposalSupplement", true)]
        .into_iter()
        .filter_map(|(name, disposal)| {
            params
                .get(name)
                .filter(|v| {
                    v.get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|p| !p.is_empty())
                })
                .map(|v| (v, disposal))
        })
        .collect::<Vec<_>>();
    if !configs.is_empty() {
        let tx = conn.transaction().map_err(db_error)?;
        for (i, row) in result.rows.iter().enumerate() {
            if i % 256 == 0 {
                check_cancel(cancel)?;
            }
            tx.execute(
                "INSERT OR IGNORE INTO valid VALUES(?)",
                [canonical_display_key(&row.match_value)],
            )
            .map_err(db_error)?;
        }
        result.rows.check()?;
        tx.commit().map_err(db_error)?;
    }
    for (config, disposal) in configs {
        let source = required_path(config, "path")?;
        let (table, input) = load_input(
            &source,
            config.get("sheet").and_then(Value::as_str),
            optional_header(config, "headerRow")?,
            &|_, _, _, _| {},
            cancel,
        )?;
        let keys = strings(config.get("keys"));
        validate_keys(&table, &keys)?;
        let indices = key_indexes(&table, &keys);
        let method = index_opt(&table, config.get("method"));
        let date = index_opt(&table, config.get("date"));
        let original = index_opt(&table, config.get("originalValue"));
        let dep = index_opt(&table, config.get("depreciation"));
        let tx = conn.transaction().map_err(db_error)?;
        input.visit(cancel,|row,_|{
            let mut row=row.to_vec();row.resize(table.headers.len(),String::new());row.truncate(table.headers.len());
            let key=row_key(&row,&indices,true,false);if key.is_empty(){return Ok(());}
            let valid=tx.query_row("SELECT EXISTS(SELECT 1 FROM valid WHERE k=?)",[&key],|r|r.get::<_,bool>(0)).map_err(db_error)?;
            if !valid {tx.execute("INSERT INTO unmatched(side,data) VALUES(?,?)",params![if disposal {2}else{1},serde_json::to_string(&row).unwrap()]).map_err(db_error)?;return Ok(()); }
            for (index,field) in [(method,if disposal {"处置方式_辅助_文件1"} else {"新增方式_辅助_文件2"}),(date,if disposal {"处置时间_辅助_文件1"} else {"新增时间_辅助_文件2"})] {
                if let Some(index)=index {let value=cell(&row,index).trim();if !value.is_empty(){tx.execute("INSERT OR IGNORE INTO supplement_text(k,field,value) VALUES(?,?,?)",params![key,field,value]).map_err(db_error)?;}}
            }
            if disposal {for(index,field) in [(original,"处置原值_辅助_文件1"),(dep,"处置折旧_辅助_文件1")] {if let Some(index)=index {let value=cell(&row,index);if !value.trim().is_empty(){tx.execute("INSERT INTO supplement_amount VALUES(?,?,?) ON CONFLICT(k,field) DO UPDATE SET value=value+excluded.value",params![key,field,number(value).abs()]).map_err(db_error)?;}}}}
            Ok(())
        })?;
        tx.commit().map_err(db_error)?;
    }
    result.rows.try_edit(|row| {
        check_cancel(cancel)?;
        for field in ["新增方式_辅助_文件2","新增时间_辅助_文件2","处置方式_辅助_文件1","处置时间_辅助_文件1","处置原值_辅助_文件1","处置折旧_辅助_文件1"] {row.extra.remove(field);}
        let key=canonical_display_key(&row.match_value);
        let mut stmt=conn.prepare("SELECT field,GROUP_CONCAT(value,'；') FROM (SELECT field,value FROM supplement_text WHERE k=? ORDER BY id) GROUP BY field").map_err(db_error)?;
        let texts=stmt.query_map([&key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(db_error)?;
        for value in texts {let (field,value)=value.map_err(db_error)?;row.extra.insert(field,Cell::Text(value));}
        let mut stmt=conn.prepare("SELECT field,value FROM supplement_amount WHERE k=?").map_err(db_error)?;
        let numbers=stmt.query_map([&key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,f64>(1)?))).map_err(db_error)?;
        for value in numbers {let (field,value)=value.map_err(db_error)?;row.extra.insert(field,Cell::Number(value));}
        Ok(())
    })?;
    conn.execute_batch("DROP TABLE valid;DROP TABLE supplement_text;DROP TABLE supplement_amount;")
        .map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader;
    const HEAD: &str = "资产编码,类别,名称,原值,累计折旧,入账开始日期,使用年限,残值率,本年折旧";
    fn fixture(root: &Path, xlsx: bool) -> Value {
        let begin = [
            "A2,电子,设备乙,200,-20,2024-01-01,5,5,10",
            "A1,机器,设备甲,100,10,2023-01-01,3,5,5",
            "A1,机器,设备甲重复,150,15,2023-01-01,3,5,5",
            ",机器,空键甲,20,2,2023-01-01,5,5,1",
            "001009,电子,前导零,90,9,2023-01-01,5,5,3",
        ];
        let end = [
            "A1,机器,设备甲,120,15,2023-01-01,3,5,5",
            "A1,机器,设备甲重复,180,20,2023-01-01,4,5,5",
            "A1,机器,设备甲多出,50,0,2025-01-01,4,5,1",
            "A3,电子,新设备,80,0,2025-06-01,5,5,1",
            ",机器,空键乙,30,3,2023-01-01,5,5,2",
            "1009,电子,前导零,90,10,2023-01-01,5,5,3",
        ];
        let extension = if xlsx { "xlsx" } else { "csv" };
        let mut paths = Vec::new();
        for (name, rows) in [("期初", begin.as_slice()), ("期末", end.as_slice())] {
            let path = root.join(format!("{name}.{extension}"));
            if xlsx {
                let mut wb = Workbook::new();
                let ws = wb.add_worksheet();
                ws.set_name("资产").unwrap();
                for (r, text) in std::iter::once(HEAD)
                    .chain(rows.iter().copied())
                    .enumerate()
                {
                    for (c, value) in text.split(',').enumerate() {
                        ws.write_string(r as u32, c as u16, value).unwrap();
                    }
                }
                wb.save(&path).unwrap();
            } else {
                fs::write(
                    &path,
                    std::iter::once(HEAD)
                        .chain(rows.iter().copied())
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
                .unwrap();
            }
            paths.push(path);
        }
        let mapping = json!({"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","startDate":"入账开始日期","life":"使用年限","residualRate":"残值率","currentYearDep":"本年折旧"});
        json!({"beginPath":paths[0],"endPath":paths[1],"beginHeaderRow":1,"endHeaderRow":1,"beginKeys":["资产编码"],"endKeys":["资产编码"],"beginMapping":mapping,"endMapping":mapping,"balanceSheetDate":"2025-12-31","__settings":{"llm":{"enabled":false}}})
    }
    fn joined(result: &MergeResult) -> Vec<Value> {
        result
            .rows
            .iter()
            .map(|row| serde_json::to_value(&*row).unwrap())
            .collect()
    }
    fn assert_workbooks_equal(left: &Path, right: &Path) {
        let mut a = open_workbook_auto(left).unwrap();
        let mut b = open_workbook_auto(right).unwrap();
        assert_eq!(a.sheet_names(), b.sheet_names());
        for name in a.sheet_names().to_vec() {
            assert_eq!(
                a.worksheet_range(&name).unwrap(),
                b.worksheet_range(&name).unwrap(),
                "数据页 {name}"
            );
            assert_eq!(
                a.worksheet_formula(&name).unwrap(),
                b.worksheet_formula(&name).unwrap(),
                "公式页 {name}"
            );
        }
    }
    #[test]
    fn disk_fa_join_matches_memory_duplicates_order_policy_supplements_and_export() {
        for xlsx in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut params = fixture(dir.path(), xlsx);
            let addition = dir.path().join("新增.csv");
            let disposal = dir.path().join("处置.csv");
            fs::write(&addition,"编号,方式,时间\nA3,购入,2025-06-01\nA3,购入,2025-06-01\nA3,调入,2025-07-01\nX9,无匹配,2025-01-01").unwrap();
            fs::write(&disposal,"编号,方式,时间,原值,折旧\nA2,报废,2025-08-01,100,0\nA2,出售,2025-09-01,100,0\nY9,无匹配,2025-01-01,1,0").unwrap();
            params["additionSupplement"] = json!({"path":addition,"headerRow":1,"keys":["编号"],"method":"方式","date":"时间"});
            params["disposalSupplement"] = json!({"path":disposal,"headerRow":1,"keys":["编号"],"method":"方式","date":"时间","originalValue":"原值","depreciation":"折旧"});
            for mode in ["pivot", "keep_first", "keep_last"] {
                params["handleDuplicates"] = json!(mode);
                params["__forceDisk"] = json!(false);
                let memory =
                    super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false))
                        .unwrap();
                assert!(memory.rows.path().is_none());
                params["__forceDisk"] = json!(true);
                let disk = super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false))
                    .unwrap();
                assert!(disk.rows.path().is_some());
                assert!(disk.begin.rows.is_empty());
                assert!(disk.end.rows.is_empty());
                assert_eq!(
                    joined(&memory),
                    joined(&disk),
                    "{extension} {mode}",
                    extension = if xlsx { "xlsx" } else { "csv" }
                );
                assert_eq!(match_statistics(&memory), match_statistics(&disk));
                assert_eq!(
                    build_depreciation_period(&memory, &params),
                    build_depreciation_period(&disk, &params)
                );
                assert_eq!(
                    build_extended_summary(&memory, &params),
                    build_extended_summary(&disk, &params)
                );
                assert_eq!(build_pivot(&memory, &params), build_pivot(&disk, &params));
                assert_eq!(
                    build_anomalies(&memory, &params),
                    build_anomalies(&disk, &params)
                );
                assert_eq!(
                    correction_warnings(&memory, &params),
                    correction_warnings(&disk, &params)
                );
                assert_eq!(
                    unmatched_rows(&memory, false)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap(),
                    unmatched_rows(&disk, false)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                );
                assert_eq!(
                    unmatched_rows(&memory, true)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap(),
                    unmatched_rows(&disk, true)
                        .collect::<Result<Vec<_>, _>>()
                        .unwrap()
                );
                if mode == "pivot" {
                    let a = dir.path().join("内存.xlsx");
                    let b = dir.path().join("磁盘.xlsx");
                    write_xlsx(&a, &memory, &params, &AtomicBool::new(false)).unwrap();
                    write_xlsx(&b, &disk, &params, &AtomicBool::new(false)).unwrap();
                    assert_workbooks_equal(&a, &b);
                    crate::fa_merge_snapshot::save(&params, &disk);
                    let snapshot = crate::fa_merge_snapshot::load(&params).unwrap();
                    assert!(snapshot.result.rows.path().is_some());
                    assert_eq!(joined(&snapshot.result), joined(&disk));
                    let mut replay = snapshot.result;
                    let mut without = params.clone();
                    without["additionSupplement"] = Value::Null;
                    without["disposalSupplement"] = Value::Null;
                    super::super::apply_supplements(&mut replay, &without, &AtomicBool::new(false))
                        .unwrap();
                    assert!(replay.unmatched_addition.is_empty());
                    assert!(
                        replay
                            .rows
                            .iter()
                            .all(|row| !row.extra.contains_key("处置折旧_辅助_文件1"))
                    );
                }
                disk.rows.check().unwrap();
            }
        }
    }
    #[test]
    fn disk_fa_failed_csv_preserves_existing_output_and_removes_partial() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        params["__forceDisk"] = json!(true);
        let result =
            super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let conn = Connection::open(result.rows.path().unwrap()).unwrap();
        conn.execute("UPDATE joined SET data='{broken' WHERE id=1", [])
            .unwrap();
        drop(conn);
        let output = dir.path().join("result.csv");
        fs::write(&output, "已存在的报告").unwrap();
        assert!(write_csv(&output, &result, Vec::new()).is_err());
        assert_eq!(fs::read_to_string(&output).unwrap(), "已存在的报告");
        assert!(!output.with_extension("csv.partial").exists());
    }
    #[test]
    fn disk_fa_pivot_dense_output_continues_above_old_estimated_cap() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        let count = 300;
        let records = (0..count)
            .map(|i| format!("A{i:05},电子,资产{i},100,10,2024-01-01,5,5,1"))
            .collect::<Vec<_>>()
            .join("\n");
        for side in ["beginPath", "endPath"] {
            fs::write(params[side].as_str().unwrap(), format!("{HEAD}\n{records}")).unwrap();
        }
        params["__forceDisk"] = json!(true);
        params["pivotConfig"] = json!({"rows":["match"],"columns":["match"]});
        let result =
            super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let (headers, rows) = build_pivot(&result, &params);
        result.rows.check().unwrap();
        assert_eq!(rows.len(), count + 1); // 完整数据行＋公式合计行。
        assert!(headers.len() > count);
        assert_eq!(rows.iter().flat_map(|row| &row[1..]).filter(|v| v.parse::<f64>().is_ok_and(|n| n != 0.0)).count(), count * 4);
    }
    #[test]
    fn disk_fa_life_metadata_failure_cannot_fall_back_to_an_empty_preview() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        params["__forceDisk"] = json!(true);
        let result =
            super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let conn = Connection::open(result.rows.path().unwrap()).unwrap();
        conn.execute_batch("DROP TABLE life").unwrap();
        drop(conn);
        assert!(life_scale(&result.rows, "使用年限", 1).is_some());
        assert_eq!(result.rows.check().unwrap_err().code, "FA_DISK_READ_FAILED");
    }

    #[test]
    fn disk_fa_cursor_crosses_multiple_batches_without_losing_or_reordering_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        for side in ["beginPath", "endPath"] {
            let rows = (0..700)
                .map(|i| format!("A{:04},电子,资产{i},100,10,2024-01-01,5,5,1", 699 - i))
                .collect::<Vec<_>>();
            fs::write(
                params[side].as_str().unwrap(),
                format!("{HEAD}\n{}", rows.join("\n")),
            )
            .unwrap();
        }
        let memory =
            super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        params["__forceDisk"] = json!(true);
        let disk = super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(disk.rows.len(), 700);
        assert_eq!(joined(&memory), joined(&disk));
        assert_eq!(
            build_depreciation_period(&memory, &params),
            build_depreciation_period(&disk, &params)
        );
        disk.rows.check().unwrap();
    }

    #[test]
    fn disk_fa_xlsx_preserves_numeric_dates_and_trimmed_source_strings() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), true);
        let input = PathBuf::from(params["endPath"].as_str().unwrap());
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("资产").unwrap();
        for (c, value) in HEAD.split(',').enumerate() {
            ws.write_string(0, c as u16, value).unwrap();
        }
        for (c, value) in [" A1 ", "机器", " 设备甲 ", "100", "10", "", "5", "5", "1"]
            .iter()
            .enumerate()
        {
            ws.write_string(1, c as u16, *value).unwrap();
        }
        ws.write_datetime_with_format(
            1,
            5,
            &rust_xlsxwriter::ExcelDateTime::from_ymd(2024, 1, 1).unwrap(),
            &Format::new().set_num_format("yyyy-mm-dd"),
        )
        .unwrap();
        wb.save(&input).unwrap();
        let memory =
            super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        params["__forceDisk"] = json!(true);
        let disk = super::super::merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(joined(&memory), joined(&disk));
    }
}

pub(super) fn load_review(
    path: &Path,
    sheet: Option<&str>,
    header: Option<usize>,
    choose_best: bool,
) -> Result<Table, AppError> {
    let (mut selected, mut sheets, _) = crate::disk_table::preview_source(path, sheet, 0)?;
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm"))
    {
        let mut zip =
            zip::ZipArchive::new(fs::File::open(path).map_err(io_error)?).map_err(|e| {
                error(
                    "FA_LOAD_FAILED",
                    "无法读取工作簿目录。",
                    Some(e.to_string()),
                )
            })?;
        let entry = zip.by_name("xl/workbook.xml").map_err(|e| {
            error(
                "FA_LOAD_FAILED",
                "无法读取工作簿目录。",
                Some(e.to_string()),
            )
        })?;
        let mut reader = quick_xml::Reader::from_reader(std::io::BufReader::new(entry));
        let mut buf = Vec::new();
        let mut visible = Vec::new();
        loop {
            match reader.read_event_into(&mut buf).map_err(|e| {
                error(
                    "FA_LOAD_FAILED",
                    "无法读取工作簿目录。",
                    Some(e.to_string()),
                )
            })? {
                quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e)
                    if e.local_name().as_ref() == b"sheet" =>
                {
                    let mut name = None;
                    let mut shown = true;
                    for attr in e.attributes().flatten() {
                        let value = String::from_utf8_lossy(&attr.value).into_owned();
                        match attr.key.local_name().as_ref() {
                            b"name" => {
                                name = quick_xml::escape::unescape(&value)
                                    .ok()
                                    .map(|v| v.into_owned())
                            }
                            b"state" => shown = value == "visible",
                            _ => {}
                        }
                    }
                    if shown {
                        if let Some(name) = name {
                            visible.push(name);
                        }
                    }
                }
                quick_xml::events::Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        if !visible.is_empty() {
            sheets = visible;
        }
    }
    if choose_best && sheet.filter(|s| !s.is_empty()).is_none() && sheets.len() > 1 {
        let mut best = None;
        for (pos, name) in sheets.iter().enumerate() {
            let (_, _, prefix) = crate::disk_table::preview_source(path, Some(name), 200)?;
            let judgement =
                crate::fa_sheet_pick::auto_sheet_judge(path, name, pos, &prefix, header);
            if best
                .as_ref()
                .is_none_or(|(score, _)| judgement.score > *score)
            {
                best = Some((judgement.score, name.clone()));
            }
        }
        if let Some((_, name)) = best {
            selected = name;
        }
    }
    let (mut table, _) = load_input(
        path,
        Some(&selected),
        header,
        &|_, _, _, _| {},
        &AtomicBool::new(false),
    )?;
    if !crate::spreadsheet_input::is_text(path) {
        table.sheets = sheets;
    }
    Ok(table)
}
pub(super) fn column_contains(table: &Table, index: usize, sample: &str) -> Result<bool, AppError> {
    column_contains_inner(table, index, sample, None)
}
pub(super) fn column_contains_normalized(
    table: &Table,
    index: usize,
    sample: &str,
    remove_spaces: bool,
    case_sensitive: bool,
) -> Result<bool, AppError> {
    column_contains_inner(table, index, sample, Some((remove_spaces, case_sensitive)))
}
fn column_contains_inner(
    table: &Table,
    index: usize,
    sample: &str,
    normalization: Option<(bool, bool)>,
) -> Result<bool, AppError> {
    let (_, disk) = load_input(
        &table.path,
        table.sheet.as_deref(),
        Some(table.header_row),
        &|_, _, _, _| {},
        &AtomicBool::new(false),
    )?;
    let mut found = false;
    let result = disk.visit(&AtomicBool::new(false), |row, _| {
        if match normalization {
            Some((remove, sensitive)) => normalize_key(cell(row, index), remove, sensitive),
            None => normalize_join_key(cell(row, index)),
        } == sample
        {
            found = true;
            return Err(error("FA_SAMPLE_FOUND", "已找到匹配样例。", None));
        }
        Ok(())
    });
    if let Err(error) = result {
        if error.code != "FA_SAMPLE_FOUND" {
            return Err(error);
        }
    }
    Ok(found)
}
