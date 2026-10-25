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
    header: impl Into<HeaderOptions>,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(Table, crate::disk_table::DiskTable), AppError> {
    let options = header.into();
    let header = options.row;
    let (selected, mut sheets, prefix) = crate::disk_table::preview_source(
        path,
        sheet,
        header.unwrap_or(0).saturating_add(2).max(200),
    )?;
    if crate::spreadsheet_input::is_text(path) {
        sheets.clear();
    }
    crate::header_detection::require_tabular(&prefix, header.is_none())?;
    let hi = header
        .map(|row| row.saturating_sub(1))
        .unwrap_or_else(|| detect_header(&prefix));
    let depth = options.depth.unwrap_or_else(|| asset_header_depth(&prefix, hi));
    let mut table = finalize_table(
        path,
        (!sheets.is_empty()).then_some(selected.clone()),
        sheets,
        hi,
        prefix,
        0,
        options.depth,
    )?;
    let disk = crate::disk_table::DiskTable::open_fa(
        path,
        Some(&selected),
        hi + 1,
        depth,
        progress,
        cancel,
    )?;
    // 预览窗口之外才出现的无标题尾列也必须进入正式处理，不能被截掉。
    if table.headers.len() < disk.headers.len() {
        let mut headers = table.headers;
        headers.resize(disk.headers.len(), String::new());
        table.headers = unique_headers(headers);
        for row in &mut table.rows {
            row.resize(table.headers.len(), String::new());
        }
    }
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
        HeaderOptions::params(params, "beginHeaderRow", "beginHeaderDepth")?,
        progress,
        cancel,
    )?;
    let (mut end, e) = load_input(
        &end_path,
        params.get("endSheet").and_then(Value::as_str),
        HeaderOptions::params(params, "endHeaderRow", "endHeaderDepth")?,
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
    let mut conn = super::disk_rows::open_with_wait(&path)?;
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
        let conn = super::disk_rows::open_with_wait(path)?;
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
    let mut conn = super::disk_rows::open_with_wait(&path)?;
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
        // joined 必须经写事务自己的连接逐批读（与 edit_disk_rows 同款纪律）：
        // 另开连接读时，本事务灌 valid 的缓存溢写要短暂持排他锁，读连接
        // 立刻 database is locked，几十万行的大清单必撞，界面即报
        // 「磁盘匹配结果读取失败，请重新匹配。」
        let mut after = 0i64;
        loop {
            check_cancel(cancel)?;
            let batch = super::disk_rows::read_batch(&tx, after)?;
            if batch.is_empty() {
                break;
            }
            for (id, row) in batch {
                tx.execute(
                    "INSERT OR IGNORE INTO valid VALUES(?)",
                    [canonical_display_key(&row.match_value)],
                )
                .map_err(db_error)?;
                after = id;
            }
        }
        tx.commit().map_err(db_error)?;
    }
    for (config, disposal) in configs {
        let source = required_path(config, "path")?;
        let (table, input) = load_input(
            &source,
            config.get("sheet").and_then(Value::as_str),
            HeaderOptions::params(config, "headerRow", "headerDepth")?,
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
    super::disk_rows::edit_disk_rows(&path, |conn, row| {
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
    fn disk_fa_matches_and_exports_below_previous_start_budget() {
        for xlsx in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut params = fixture(dir.path(), xlsx);
            let cancel = AtomicBool::new(false);
            let expected = super::super::merge(&params, &|_, _, _, _| {}, &cancel).unwrap();
            let memory_output = dir.path().join("普通.xlsx");
            params["outputPath"] = json!(memory_output);
            let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
            super::super::export(params.clone(), &|_, _, _, _| {}, Arc::new(AtomicBool::new(false)), &pause).unwrap();
            params["__forceDisk"] = json!(true);
            let disk_output = dir.path().join("分批.xlsx");
            params["outputPath"] = json!(disk_output);
            const GIB: u64 = 1024 * 1024 * 1024;
            crate::resource_budget::with_test_memory(crate::resource_budget::MemoryStatus {
                total: 16 * GIB, available: 158 * GIB / 100, commit_available: 8 * GIB,
            }, || {
                let result = super::super::merge(&params, &|_, _, _, _| {}, &cancel).unwrap();
                assert_eq!(joined(&expected), joined(&result));
                result.rows.check().unwrap();
                crate::fa_merge_snapshot::save(&params, &result);
                let loaded = crate::fa_merge_snapshot::load(&params).unwrap();
                assert_eq!(joined(&result), joined(&loaded.result));
                super::super::export(params.clone(), &|_, _, _, _| {}, Arc::new(AtomicBool::new(false)), &pause).unwrap();
            });
            assert_workbooks_equal(&memory_output, &disk_output);
        }
    }

    #[test]
    fn disk_fa_sparse_origin_multilevel_headers_match_prefix_full_and_cache() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("稀疏起点.xlsx");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("资产").unwrap();
        ws.write_string(1, 2, "业务说明").unwrap();
        ws.write_string(2, 1, "表1").unwrap();
        ws.merge_range(2, 2, 2, 6, "固定资产明细清单", &Format::new()).unwrap();
        for (c, header) in ["固定资产类别", "固定资产编号", "固定资产名称", "原值", "累计折旧"].iter().enumerate() {
            ws.write_string(3, (c + 2) as u16, *header).unwrap();
        }
        for (c, value) in ["设备", "0001", "测试设备", "100", "10"].iter().enumerate() {
            ws.write_string(4, (c + 2) as u16, *value).unwrap();
            ws.write_string(6, (c + 2) as u16, *value).unwrap();
        }
        wb.save(&path).unwrap();
        for header in [Some(3), None] {
            let full = load_table(&path, Some("资产"), header, false).unwrap();
            let prefix = crate::fa_sheet_pick::load_prefix_table(&path, Some("资产"), header, false).unwrap();
            let (disk, _) = load_input(&path, Some("资产"), header, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
            assert!(full.headers.iter().any(|h| h == "固定资产明细清单-固定资产编号"));
            assert_eq!(full.header_row, 3);
            assert_eq!(full.headers, prefix.headers);
            assert_eq!(full.headers, disk.headers);
            assert_eq!(full.rows, prefix.rows);
            assert_eq!(full.rows, disk.rows);
            assert_eq!(full.rows.len(), 2);
            for _ in 0..2 {
                let cached = crate::fa_table_cache::load_table_cached(&path, Some("资产"), header, false).unwrap();
                assert_eq!(full.headers, cached.headers);
                assert_eq!(full.rows, cached.rows);
                assert_eq!(full.header_row, cached.header_row);
            }
        }
    }

    #[test]
    fn disk_fa_supplements_survive_writer_cache_spill() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        let name = "长资产名称".repeat(160);
        let mut body = format!("{HEAD}\n");
        for i in 0..2048 {
            body.push_str(&format!("A{i},机器,{name},100,10,2023-01-01,5,5,1\n"));
        }
        for key in ["beginPath", "endPath"] {
            fs::write(params[key].as_str().unwrap(), &body).unwrap();
        }
        params["__forceDisk"] = json!(true);
        let cancel = AtomicBool::new(false);
        // 未选补充清单时也会清理旧辅助字段，必须覆盖同样的读写路径。
        let mut result = super::super::merge(&params, &|_, _, _, _| {}, &cancel).unwrap();
        assert_eq!(result.rows.len(), 2048);
        let addition = dir.path().join("新增.csv");
        fs::write(&addition, "编号,方式\nA0,购入\nA2047,调入\n").unwrap();
        params["additionSupplement"] = json!({"path":addition,"headerRow":1,"keys":["编号"],"method":"方式"});
        apply_supplements(&mut result, &params, &cancel).unwrap();
        let rows = result.rows.iter().collect::<Vec<_>>();
        for (key, method) in [("A0", "购入"), ("A2047", "调入")] {
            let row = rows.iter().find(|row| row.match_value == key).unwrap();
            assert_eq!(row.extra.get("新增方式_辅助_文件2"), Some(&Cell::Text(method.into())));
        }
        assert_eq!(rows.len(), 2048);
        result.rows.check().unwrap();
        drop(rows);
        params.as_object_mut().unwrap().remove("additionSupplement");
        apply_supplements(&mut result, &params, &cancel).unwrap();
        assert!(result.rows.iter().all(|row| !row.extra.contains_key("新增方式_辅助_文件2")));
        result.rows.check().unwrap();
    }

    #[test]
    fn disk_fa_supplement_key_collection_survives_writer_cache_spill() {
        let dir = tempfile::tempdir().unwrap();
        let mut params = fixture(dir.path(), false);
        // 匹配键带长名称且行数过万：valid 表写入必然溢写 16MB 页缓存（用户
        // 现场：近 30 万行、键=FA编号+资产说明+公司，必然触发）。旧实现一边
        // 在写事务里灌 valid、一边另开连接读 joined，撞上排他锁即
        // 「磁盘匹配结果读取失败，请重新匹配。」
        let name = "长资产名称".repeat(200);
        let mut body = format!("{HEAD}\n");
        for i in 0..8192 {
            body.push_str(&format!("A{i},机器,{name},100,10,2023-01-01,5,5,1\n"));
        }
        for key in ["beginPath", "endPath"] {
            fs::write(params[key].as_str().unwrap(), &body).unwrap();
        }
        params["beginKeys"] = json!(["资产编码", "名称"]);
        params["endKeys"] = json!(["资产编码", "名称"]);
        params["__forceDisk"] = json!(true);
        let cancel = AtomicBool::new(false);
        let mut result = super::super::merge(&params, &|_, _, _, _| {}, &cancel).unwrap();
        assert_eq!(result.rows.len(), 8192);
        let disposal = dir.path().join("处置.csv");
        fs::write(&disposal, format!("资产编码,名称,方式\nA1,{name},报废\nA8191,{name},出售\n")).unwrap();
        params["disposalSupplement"] =
            json!({"path":disposal,"headerRow":1,"keys":["资产编码", "名称"],"method":"方式"});
        apply_supplements(&mut result, &params, &cancel).unwrap();
        result.rows.check().unwrap();
        let rows = result.rows.iter().collect::<Vec<_>>();
        for (code, method) in [("A1", "报废"), ("A8191", "出售")] {
            let hit = rows
                .iter()
                .find(|row| {
                    row.begin
                        .as_ref()
                        .is_some_and(|cells| cells.first() == Some(&code.to_string()))
                })
                .unwrap();
            assert_eq!(
                hit.extra.get("处置方式_辅助_文件1"),
                Some(&Cell::Text(method.into()))
            );
        }
    }

    #[test]
    #[ignore = "真实数据重放：AUDIT_FA_SNAPSHOT_REPLAY=快照sqlite，AUDIT_FA_EXPORT_REPLAY=任务库导出的 fa.export 参数 JSON"]
    fn fa_export_replay_real_disk_snapshot_with_supplement() {
        let snapshot = std::path::PathBuf::from(std::env::var("AUDIT_FA_SNAPSHOT_REPLAY").unwrap());
        let params: Value = serde_json::from_str(&fs::read_to_string(
            std::env::var("AUDIT_FA_EXPORT_REPLAY").unwrap(),
        )
        .unwrap())
        .unwrap();
        // 绕过快照键匹配（直接吃现成磁盘结果），只重放出事的那一段：
        // 大体量磁盘结果 + 处置补充清单的 apply_supplements。
        let working = std::env::temp_dir().join(format!(
            "fa-replay-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::copy(&snapshot, &working).unwrap();
        let empty_table = || Table {
            path: PathBuf::new(),
            sheet: None,
            sheets: Vec::new(),
            header_row: 0,
            header_depth: 1,
            headers: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
        };
        let mut result = MergeResult {
            begin: empty_table(),
            end: empty_table(),
            rows: super::super::JoinedRows::open(working).unwrap(),
            begin_keys: Vec::new(),
            end_keys: Vec::new(),
            duplicate_values: 0,
            duplicate_rows: 0,
            unmatched_addition: Vec::new(),
            unmatched_disposal: Vec::new(),
        };
        assert!(result.rows.len() > 100_000, "真实体量（约 29 万行）");
        apply_supplements(&mut result, &params, &AtomicBool::new(false))
            .expect("真实体量下补充清单不得再撞锁");
        result.rows.check().unwrap();
        eprintln!(
            "重放完成：匹配 {} 行，补充未匹配新增 {} / 处置 {} 行",
            result.rows.len(),
            result.unmatched_addition.len(),
            result.unmatched_disposal.len()
        );
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
    header: impl Into<HeaderOptions>,
    choose_best: bool,
) -> Result<Table, AppError> {
    let options = header.into();
    let header = options.row;
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
    let (_, _, prefix) = crate::disk_table::preview_source(
        path, Some(&selected), header.unwrap_or(0).saturating_add(10).max(200),
    )?;
    crate::header_detection::require_tabular(&prefix, header.is_none())?;
    let hi = header.map(|row| row.saturating_sub(1)).unwrap_or_else(|| detect_header(&prefix));
    let mut table = finalize_table(path, (!crate::spreadsheet_input::is_text(path)).then_some(selected.clone()),
        if crate::spreadsheet_input::is_text(path) { Vec::new() } else { sheets },
        hi, prefix, 0, options.depth)?;
    // 不知道完整行数时以多一行表示“仍可能有后续记录”；正式任务才给精确总数。
    if table.rows.len() + hi + table.header_depth >= header.unwrap_or(0).saturating_add(10).max(200) {
        table.row_count = table.rows.len().saturating_add(1);
    }
    if let Some(cache) = crate::disk_table::DiskTable::cached_fa(path, &selected, table.header_row, table.header_depth) {
        table.row_count = cache.row_count;
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
    Ok(columns_containing(table, &[index], sample, normalization)?.contains(&index))
}

/// 一次投影扫描判断所有候选列；优先列命中即停，不创建整表缓存。
pub(super) fn columns_containing(
    table: &Table, indexes: &[usize], sample: &str, normalization: Option<(bool, bool)>,
) -> Result<Vec<usize>, AppError> {
    if indexes.is_empty() || sample.is_empty() { return Ok(Vec::new()); }
    crate::table_read_cache::read(&table.path, "fa-key-evidence-v1",
        &(table.sheet.as_deref(), table.header_row, table.header_depth, indexes, sample, normalization), || {
        let columns: HashSet<usize> = indexes.iter().copied().collect();
        let mut hits = HashSet::new();
        let mut visit = |row: Vec<String>, physical: usize| {
            if physical < table.header_row + table.header_depth { return Ok(()); }
            for &index in indexes {
                let value = match normalization {
                    Some((remove, sensitive)) => normalize_key(cell(&row, index), remove, sensitive),
                    None => normalize_join_key(cell(&row, index)),
                };
                if value == sample { hits.insert(index); }
            }
            if hits.contains(&indexes[0]) { return Err(error("FA_SAMPLE_FOUND", "已找到匹配样例。", None)); }
            Ok(())
        };
        let cancel = AtomicBool::new(false);
        let sheet = table.sheet.as_deref().unwrap_or("CSV");
        let result = if let Some(cache) = crate::disk_table::DiskTable::cached_fa(
            &table.path, sheet, table.header_row, table.header_depth,
        ) {
            cache.visit_columns(&columns, &cancel, &mut visit)
        } else {
            crate::disk_table::for_each_source_row_projected(&table.path, sheet, &columns, &cancel, &mut visit)
        };
        if let Err(error) = result { if error.code != "FA_SAMPLE_FOUND" { return Err(error); } }
        Ok(indexes.iter().copied().filter(|index| hits.contains(index)).collect())
    })
}
