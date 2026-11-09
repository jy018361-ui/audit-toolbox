use super::*;
use rusqlite::{Connection, params as sql_params};

fn failure(e: impl ToString) -> AppError {
    error("FX_DISK_CACHE", "无法处理汇兑磁盘索引，请检查磁盘空间后重试。", Some(e.to_string()))
}

/// The index stores complete normalized rows and physical source positions.
/// ORDER BY uses SQLite's disk sorter; only one row/voucher enters Rust.
pub(super) struct Replay {
    db: Connection,
    table: Arc<FxTable>,
    large_file_disk_mode: bool,
    _cleanup: Cleanup,
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}
impl Replay {
    pub(super) fn shared(input:&FxJeRows,mapping:&Map<String,Value>,params:&Value,cancel:&AtomicBool)->Result<Rc<Self>,AppError>{
        let metadata=fs::metadata(&input.table.path).map_err(failure)?;
        let key=serde_json::to_string(&json!([fs::canonicalize(&input.table.path).map_err(failure)?,metadata.len(),
            metadata.modified().map_err(failure)?.duration_since(std::time::UNIX_EPOCH).map_err(failure)?.as_nanos().to_string(),
            input.table.sheet,input.table.header_row,input.table.header_depth,mapping,input.disk.is_some(),
            params.get("fixedEntity"),params.get("entityScope"),params.get("__entityKeyEnabled"),
            params.get("__entityCoverage"),params.get("reportEnd")])).map_err(failure)?;
        if let Some(cached)=FX_DISK_REPLAY_CACHE.with(|cache|cache.borrow().as_ref().and_then(|cache|cache.get(&key).cloned())){return Ok(cached);}
        let replay=Rc::new(Self::build(input,mapping,params,cancel)?);
        FX_DISK_REPLAY_CACHE.with(|cache|{if let Some(cache)=cache.borrow_mut().as_mut(){cache.insert(key,Rc::clone(&replay));}});
        Ok(replay)
    }
    pub(super) fn duplicate_source(&self) -> Result<Option<usize>,AppError> {
        use rusqlite::OptionalExtension;
        self.db.query_row("SELECT source FROM (SELECT source,ROW_NUMBER() OVER(PARTITION BY data ORDER BY source) AS occurrence FROM rows) WHERE occurrence=2 ORDER BY source LIMIT 1",[],|row|row.get(0))
            .optional().map_err(failure)
    }
    pub(super) fn build(input: &FxJeRows, mapping: &Map<String, Value>, params: &Value,
        cancel: &AtomicBool) -> Result<Self, AppError> {
        let root = tabular::cache_root()?.join("fx-replay");
        fs::create_dir_all(&root).map_err(failure)?;
        crate::resource_budget::check_disk_space(&root,crate::disk_table::estimated_resident_bytes(&input.table.path)
            .unwrap_or_else(||input.table.row_count as u64*1024))?;
        let path = root.join(format!("{}.sqlite", uuid::Uuid::new_v4()));
        let cleanup=Cleanup(path.clone());
        let mut db = Connection::open(&path).map_err(failure)?;
        db.execute_batch("PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF;
            CREATE TABLE rows(source INTEGER PRIMARY KEY, voucher TEXT NOT NULL, date TEXT, loss_key TEXT NOT NULL, data TEXT NOT NULL);
            CREATE TABLE losses(key TEXT PRIMARY KEY);").map_err(failure)?;
        let tx = db.transaction().map_err(failure)?;
        let end = params.get("reportEnd").and_then(Value::as_str).and_then(parse_date);
        let ids = std::iter::once(first_col(mapping, "date")).flatten().chain(mapped_cols(mapping, "id"))
            .filter_map(|name| ledger_mapping::header_index(&input.table.headers, &name)).collect::<Vec<_>>();
        let account_indexes = account_columns(mapping).iter()
            .filter_map(|name| ledger_mapping::header_index(&input.table.headers, name)).collect::<Vec<_>>();
        let matched = params.pointer("/__entityCoverage/matched").and_then(Value::as_array).map(|values|
            values.iter().filter_map(Value::as_str).map(ledger_mapping::normalized_entity_name).collect::<BTreeSet<_>>());
        input.visit(cancel, |row| {
            let entity = scoped_entity_for(&row, mapping, params, ledger_mapping::EntitySide::Je);
            if matched.as_ref().is_some_and(|values| !values.contains(&ledger_mapping::normalized_entity_name(entity))) { return Ok(()); }
            let loss_key = tabular::voucher_key(row.row, &ids);
            if account_indexes.iter().any(|index| row.row.get(*index).is_some_and(|value| ledger_mapping::is_profit_transfer_account(value))) {
                tx.execute("INSERT OR IGNORE INTO losses VALUES (?1)", [&loss_key]).map_err(failure)?;
            }
            let date = je_date(cell(&row, mapping, "date"), end).map(|date| date.format("%Y-%m-%d").to_string());
            tx.execute("INSERT INTO rows VALUES (?1,?2,?3,?4,?5)", sql_params![row.source_row,
                voucher_id(&row, mapping, params), date, loss_key, serde_json::to_string(row.row).map_err(failure)?]).map_err(failure)?;
            Ok(())
        })?;
        tx.commit().map_err(failure)?;
        db.execute_batch("CREATE INDEX voucher_rows ON rows(voucher,source); CREATE INDEX chronological ON rows(date,source); CREATE INDEX loss_rows ON rows(loss_key);").map_err(failure)?;
        Ok(Self { db, table:Arc::clone(&input.table), large_file_disk_mode: input.disk.is_some(), _cleanup:cleanup })
    }

    pub(super) fn visit(&self, condition: &str, order: &str, cancel: &AtomicBool,
        mut visitor: impl FnMut(RowRecord<'_>, bool) -> Result<(), AppError>) -> Result<(), AppError> {
        let query = format!("SELECT source,data,EXISTS(SELECT 1 FROM losses WHERE key=rows.loss_key) FROM rows {condition} ORDER BY {order}");
        let mut stmt = self.db.prepare(&query).map_err(failure)?;
        let mut rows = stmt.query([]).map_err(failure)?;
        let index = Rc::new(self.table.headers.iter().enumerate().map(|(i,h)| (h.as_str(),i)).collect());
        while let Some(row) = rows.next().map_err(failure)? {
            if cancel.load(Ordering::Relaxed)||replay_cancel().load(Ordering::Relaxed) { return Err(error("JOB_CANCELLED", "任务已取消。", None)); }
            let raw: String = row.get(1).map_err(failure)?;
            let values: Vec<String> = serde_json::from_str(&raw).map_err(failure)?;
            visitor(RowRecord { source_row:row.get(0).map_err(failure)?, row:&values, header_index:Rc::clone(&index) }, row.get(2).map_err(failure)?)?;
        }
        Ok(())
    }

    pub(super) fn vouchers(&self, cancel: &AtomicBool,
        mut visitor: impl FnMut(&str, &[RowRecord<'_>], bool) -> Result<(), AppError>) -> Result<(), AppError> {
        let mut stmt = self.db.prepare("SELECT voucher,source,data,EXISTS(SELECT 1 FROM losses WHERE key=rows.loss_key) FROM rows ORDER BY voucher,source").map_err(failure)?;
        let mut cursor = stmt.query([]).map_err(failure)?;
        let mut current = String::new();
        let mut values = Vec::<(usize,Vec<String>)>::new();
        let mut loss = false;
        // 原凭证规则仍需一份独立行视图及临时分类结构，预留其余预算。
        let index = Rc::new(self.table.headers.iter().enumerate().map(|(i,h)| (h.as_str(),i)).collect::<HashMap<_,_>>());
        let mut emit = |id: &str, values: &[(usize,Vec<String>)], loss| {
            let records = values.iter().map(|(source,row)| RowRecord { source_row:*source,
                row,header_index:Rc::clone(&index) }).collect::<Vec<_>>();
            visitor(id, &records, loss)
        };
        while let Some(row) = cursor.next().map_err(failure)? {
            if cancel.load(Ordering::Relaxed)||replay_cancel().load(Ordering::Relaxed) { return Err(error("JOB_CANCELLED", "任务已取消。", None)); }
            let id: String = row.get(0).map_err(failure)?;
            if !values.is_empty() && id != current { emit(&current, &values, loss)?; values.clear(); loss=false; }
            current=id;
            let raw:String=row.get(2).map_err(failure)?;
            if self.large_file_disk_mode && values.len() % 256 == 0 { crate::resource_budget::check_available_if_managed()?; }
            values.push((row.get(1).map_err(failure)?,serde_json::from_str(&raw).map_err(failure)?));
            loss |= row.get::<_,bool>(3).map_err(failure)?;
        }
        if !values.is_empty() { emit(&current,&values,loss)?; }
        Ok(())
    }

    pub(super) fn single_table(&self, rows: &[RowRecord<'_>]) -> SingleTable {
        let mut table = (*self.table).clone();
        table.rows=rows.iter().map(|row| row.row.to_vec()).collect();
        table.row_count=rows.len(); table.sampled=false;
        FX_REPLAY_TABLE.with(|slot| *slot.borrow_mut()=Some((Arc::new(table), rows.iter().map(|row| row.source_row).collect())));
        SingleTable
    }
}

pub(super) fn validate(input: &FxJeRows, mapping: &Map<String,Value>, params:&Value,
    errors:&mut Vec<String>,warnings:&mut Vec<String>) -> Result<(),AppError> {
    let headers=&input.table.headers;
    for (role,_) in mapping.iter().filter(|(role,_)|!role.starts_with("__")) {
        for column in mapped_cols(mapping,role) { if ledger_mapping::header_index(headers,&column).is_none() {errors.push(format!("JE 映射列不存在：{column}"));} }
    }
    for role in ["id","date","accountCode","currency"] {
        let missing=if role=="accountCode" {account_columns(mapping).is_empty()} else {mapped_cols(mapping,role).is_empty()};
        if missing {errors.push(format!("JE 缺少必填字段：{}（{role}）",if role=="accountCode"{"科目编码／科目名称（任一）"}else{chinese_header(role)}));}
    }
    for (prefix,label) in [("foreign","原币"),("functional","本位币")] {
        if !amount_scheme_ok(mapping,prefix){errors.push(format!("JE {label}金额记法不成立，请确认净额或借贷分列的完整映射。"));}
    }
    let mut years=BTreeSet::new();let mut blank=0;let mut invalid=0;let mut bad_amounts=0;
    let mut id_error=false;let mut unit_rows=Vec::new();
    let currency=first_col(mapping,"currency").and_then(|name|ledger_mapping::header_index(headers,&name));
    let entity=first_col(mapping,"entity").and_then(|name|ledger_mapping::header_index(headers,&name));
    let mut unit_headers=vec![String::new()];if let Some(index)=entity {unit_headers[0]=headers[index].clone();}
    let supported=supported_currencies();
    input.visit_body(mapping,&AtomicBool::new(false),|row|{
        if let Some(date)=parse_date(cell(&row,mapping,"date")){years.insert(date.year());}
        let one=vec![row.row.to_vec()];
        for issue in ledger_mapping::mapped_amount_parse_issues("je",headers,&one,&|role|mapped_cols(mapping,role)) {
            if bad_amounts<5 {errors.push(format!("JE 金额列“{}”（{}）第{}行必须解析为数值，实际为“{}”。",issue.column,issue.label,row.source_row,issue.value));}bad_amounts+=1;
        }
        if let Some(index)=currency {let raw=row.row.get(index).map(String::as_str).unwrap_or("").trim();
            if raw.is_empty(){blank+=1;}else if !supported.contains(normalize_currency(raw).as_str()){
                if invalid<5{errors.push(format!("JE 第{}行原币币种“{raw}”无法识别。",row.source_row));}invalid+=1;
            }
        }
        if !id_error && is_je_business_row(&row,mapping) {
            let mut parts=vec![first_col(mapping,"entity").map(|_|cell(&row,mapping,"entity")).unwrap_or_else(||fixed_entity(params)).trim().to_owned(),cell(&row,mapping,"date").trim().to_owned()];
            parts.extend(mapped_cols(mapping,"id").iter().map(|column|row.get(column).unwrap_or("").trim().to_owned()));
            if !parts.iter().skip(1).all(String::is_empty) && parts.iter().any(String::is_empty){errors.push(format!("JE 第{}行匹配ID存在空值",row.source_row));id_error=true;}
        }
        if unit_rows.len()<10000 {if let Some(index)=entity {unit_rows.push(vec![row.row.get(index).cloned().unwrap_or_default()]);}}
        Ok(())
    })?;
    if let Some(index)=entity {if ledger_mapping::entity_column_is_measurement_unit(&unit_headers,&unit_rows,&headers[index]){errors.push(format!("JE 主体字段“{}”的取值是 KG、EA、BOX 等计量单位，不能作为公司/核算主体；请清除或改正主体映射。",headers[index]));}}
    if invalid>5{errors.push(format!("JE 另有{}行原币币种无法识别。",invalid-5));}
    if bad_amounts>5{errors.push(format!("JE 另有{}个金额单元格无法解析为数值。",bad_amounts-5));}
    if blank>0{warnings.push(format!("JE 币种列有{blank}行为空，将按本位币行处理。"));}
    if let Some(year)=params.get("reportEnd").and_then(Value::as_str).and_then(parse_date).map(|date|date.year()){
        if !years.is_empty()&&!years.contains(&year){warnings.push(format!("【期间不一致，请复核】资产负债表日为{year}年，但JE数据期间为{}年；测算继续，结果可能使用了错误年度的数据。",years.iter().map(ToString::to_string).collect::<Vec<_>>().join("、")));}
    }
    let replay=Replay::shared(input,mapping,params,&AtomicBool::new(false))?;
    if let Some(source)=replay.duplicate_source()?{errors.push(format!("JE 存在重复明细行（源文件第{source}行）"));}
    Ok(())
}

pub(super) struct Alignment {
    pub(super) values:BTreeMap<String,Vec<String>>,
    pub(super) identities:Vec<(String,String,String)>,
    pub(super) columns:Vec<(String,HashSet<String>)>,
}
pub(super) fn alignment(input:&FxJeRows,mapping:&Map<String,Value>)->Result<Alignment,AppError>{
    let mut values=BTreeMap::<String,BTreeSet<String>>::new();let mut identities=BTreeSet::new();
    let headers=&input.table.headers;
    let mut columns=vec![Some(HashSet::new());headers.len()];
    let mut scanned=0;
    input.visit(&AtomicBool::new(false),|row|{
        scanned+=1;
        if scanned>100000{return Ok(());}
        for role in ["currency","accountCode","accountName"]{
            let value=mapped_cols(mapping,role).iter().filter_map(|column|row.get(column).map(|value|mapped_account_role_value(value.trim(),column,mapping,role)))
                .map(|value|if role=="accountCode"{ledger_mapping::normalize_account_code(value)}else{value.trim().to_uppercase()})
                .filter(|value|!value.is_empty()).collect::<Vec<_>>().join(" ");
            if !value.is_empty(){values.entry(role.into()).or_default().insert(value);}
        }
        let (code,name)=account_code_and_name(&row,mapping);if !code.is_empty()||!name.is_empty(){identities.insert((String::new(),code,name));}
        for (index,slot) in columns.iter_mut().enumerate(){if let Some(set)=slot{
            if let Some(value)=row.row.get(index).map(|v|v.trim()).filter(|v|!v.is_empty()){set.insert(value.to_uppercase());}
            if set.len()>3000{*slot=None;}
        }}
        Ok(())
    })?;
    Ok(Alignment{values:values.into_iter().map(|(role,values)|(role,values.into_iter().collect())).collect(),
        identities:identities.into_iter().collect(),columns:headers.iter().cloned().zip(columns).filter_map(|(header,set)|
            set.filter(|set|set.len()>=5).map(|set|(header,set))).collect()})
}
pub(super) fn alignment_tb(input:&FxTbRows,mapping:&Map<String,Value>)->Result<Alignment,AppError>{
    let mut values=BTreeMap::<String,BTreeSet<String>>::new();let mut identities=BTreeSet::new();
    let headers=&input.table.headers;
    let mut columns=vec![Some(HashSet::new());headers.len()];
    let mut scanned=0;
    input.visit(&AtomicBool::new(false),|row,_|{
        scanned+=1;
        if scanned>100000{return Ok(());}
        for role in ["currency","accountCode","accountName"]{
            let value=mapped_cols(mapping,role).iter().filter_map(|column|row.get(column).map(|value|mapped_account_role_value(value.trim(),column,mapping,role)))
                .map(|value|if role=="accountCode"{ledger_mapping::normalize_account_code(value)}else{value.trim().to_uppercase()})
                .filter(|value|!value.is_empty()).collect::<Vec<_>>().join(" ");
            if !value.is_empty(){values.entry(role.into()).or_default().insert(value);}
        }
        let (code,name)=account_code_and_name(&row,mapping);if !code.is_empty()||!name.is_empty(){identities.insert((String::new(),code,name));}
        for (index,slot) in columns.iter_mut().enumerate(){if let Some(set)=slot{
            if let Some(value)=row.row.get(index).map(|v|v.trim()).filter(|v|!v.is_empty()){set.insert(value.to_uppercase());}
            if set.len()>3000{*slot=None;}
        }}
        Ok(())
    })?;
    Ok(Alignment{values:values.into_iter().map(|(role,values)|(role,values.into_iter().collect())).collect(),
        identities:identities.into_iter().collect(),columns:headers.iter().cloned().zip(columns).filter_map(|(header,set)|
            set.filter(|set|set.len()>=5).map(|set|(header,set))).collect()})
}

pub(super) fn validate_tb(input:&FxTbRows,mapping:&Map<String,Value>,params:&Value,
    errors:&mut Vec<String>,warnings:&mut Vec<String>)->Result<(),AppError>{
    let mut mapping=mapping.clone();input.ensure_convention(&mut mapping)?;
    let table=&input.table;let headers=&table.headers;
    if let Some(analysis)=&input.analysis{warnings.extend(analysis.currency_warnings.clone());}
    for(role,_)in mapping.iter().filter(|(role,_)|!role.starts_with("__")){
        for column in mapped_cols(&mapping,role){if ledger_mapping::header_index(headers,&column).is_none(){errors.push(format!("TB 映射列不存在：{column}"));}}
    }
    for role in ["accountCode","currency"]{
        if (role=="accountCode"&&account_columns(&mapping).is_empty())||(role!="accountCode"&&mapped_cols(&mapping,role).is_empty()){
            errors.push(format!("TB 缺少必填字段：{}（{role}）",if role=="accountCode"{"科目编码／科目名称（任一）"}else{chinese_header(role)}));
        }
    }
    for(prefix,label)in[("openingForeign","期初原币余额"),("closingForeign","期末原币余额"),("openingFunctional","期初本位币余额"),("closingFunctional","期末本位币余额")]{
        if !amount_scheme_ok(&mapping,prefix){errors.push(format!("TB 缺少必填字段：{label}"));}
    }
    for(a,b)in[("openingForeignAmount","closingForeignAmount"),("openingFunctionalAmount","closingFunctionalAmount")]{
        if first_col(&mapping,a).is_some()&&first_col(&mapping,a)==first_col(&mapping,b){errors.push(format!("TB {a} 与 {b} 不能使用同一列"));}
    }
    let positions=ledger_mapping::roles("tb").iter().filter(|role|{let name=role.name.to_lowercase();name.contains("amount")||name.contains("debit")||name.contains("credit")})
        .flat_map(|role|mapped_cols(&mapping,role.name).into_iter().filter_map(|name|ledger_mapping::header_index(headers,&name).map(|index|(role.label,name,index)))).collect::<Vec<_>>();
    let mut ratios=BTreeMap::<String,(usize,usize)>::new();let mut bad_amounts=0;let mut invalid=0;let mut blanks=0;
    let mut years=BTreeSet::new();let mut keys=HashSet::new();let mut duplicates=0;let mut duplicate_examples=vec![];
    let key_columns=["entity","currency"].into_iter().filter_map(|role|first_col(&mapping,role)).chain(account_columns(&mapping)).chain(mapped_cols(&mapping,"auxiliary")).collect::<Vec<_>>();
    let mut units=BTreeMap::<String,(usize,usize,Vec<String>)>::new();
    let mut foreign_columns=vec![BTreeSet::new();headers.len()];
    input.visit(&replay_cancel(),|row,_|{
        if !row_in_matched_scope(&row,&mapping,params,ledger_mapping::EntitySide::Tb){return Ok(());}
        let one=vec![row.row.to_vec()];
        for issue in ledger_mapping::mapped_amount_parse_issues("tb",headers,&one,&|role|mapped_cols(&mapping,role)){
            if bad_amounts<5{errors.push(format!("TB 金额列“{}”（{}）第{}行必须解析为数值，实际为“{}”。",issue.column,issue.label,row.source_row,issue.value));}bad_amounts+=1;
        }
        for(_,name,index)in &positions {let raw=row.row.get(*index).map(String::as_str).unwrap_or("");if !raw.trim().is_empty()&&!is_placeholder(raw){let item=ratios.entry(name.clone()).or_default();item.0+=1;if strict_number(raw).is_err(){item.1+=1;}}}
        for(index,header)in headers.iter().enumerate(){
            let raw=row.row.get(index).map(String::as_str).unwrap_or("");
            if normalize_header(header).contains("期间"){for token in raw.split(|c:char|!c.is_ascii_digit()){if token.len()==4{if let Ok(year)=token.parse::<i32>(){if(1900..=2200).contains(&year){years.insert(year);}}}}}
            let code=normalize_currency(raw);if supported_currencies().contains(code.as_str())&&code!="CNY"{foreign_columns[index].insert(code);}
        }
        if let Some(column)=first_col(&mapping,"currency") {if ledger_mapping::ledger_junk_mask(headers,&one,&|role|mapped_cols(&mapping,role)).first()==Some(&true){
            let raw=row.get(&column).unwrap_or("").trim();if raw.is_empty(){blanks+=1;}else if !supported_currencies().contains(normalize_currency(raw).as_str()){
                if invalid<5{errors.push(format!("TB 第{}行原币币种“{raw}”无法识别。",row.source_row));}invalid+=1;
            }
        }}
        let mut key=key_columns.iter().map(|column|row.get(column).unwrap_or("").trim()).collect::<Vec<_>>().join("\u{1f}");
        if !key_columns.is_empty()&&mapped_cols(&mapping,"entity").is_empty(){key=format!("{}\u{1f}{key}",fixed_entity(params));}
        if !keys.insert(key){duplicates+=1;if duplicate_examples.len()<3{duplicate_examples.push(row.source_row);}}
        let mut local=(**table).clone();local.rows=one;local.row_count=1;local.header_row=row.source_row.saturating_sub(local.header_depth);
        for unit in tb_self_rollforward(&local,&mapping){let item=units.entry(unit.unit.into()).or_default();item.0+=unit.checked;item.1+=unit.issues.len();for issue in unit.issues.into_iter().take(3-item.2.len()){item.2.push(format!("第{}行（{}，差{:.2}）",issue.source_row,issue.account,issue.difference));}}
        Ok(())
    })?;
    if bad_amounts>5{errors.push(format!("TB 另有 {} 个金额单元格无法解析为数值。",bad_amounts-5));}
    for(column,(count,bad))in ratios{if count>0&&(count-bad)as f64/(count as f64)<0.99{errors.push(format!("TB 关键余额列“{column}”有效数值比例低于99%"));}}
    if invalid>5{errors.push(format!("TB 另有{}行原币币种无法识别。",invalid-5));}if blanks>0{warnings.push(format!("TB 币种列有{blanks}行为空，将按本位币行处理。"));}
    if duplicates>0{warnings.push(format!("TB 有 {duplicates} 行与其他行的余额键相同（主体＋科目＋币种），已按同一余额键合并期初与期末余额；如第{}行。若这些行本应各自独立，请把区分它们的那一列映射为辅助核算。",duplicate_examples.iter().map(ToString::to_string).collect::<Vec<_>>().join("、")));}
    for(unit,(checked,issues,examples))in units{if issues>0{warnings.push(format!("TB 自身勾稽（{unit}口径）：{issues} / {checked}行不满足 期初＋本年累计借方−本年累计贷方＝期末，如{}。请检查期初/期末/借贷方向列是否映射正确或数据是否存在尾差；本提示不拦截测算。",examples.join("、")));}}
    if let Some(year)=params.get("reportEnd").and_then(Value::as_str).and_then(parse_date).map(|date|date.year()){if !years.is_empty()&&!years.contains(&year){warnings.push(format!("【期间不一致，请复核】资产负债表日为{year}年，但TB数据期间为{}年；测算继续，结果可能使用了错误年度的数据。",years.iter().map(ToString::to_string).collect::<Vec<_>>().join("、")));}}
    if foreign_columns.iter().filter(|values|!values.is_empty()).count()>1&&params.get("tbForeignCurrencyConfirmed").and_then(Value::as_bool)!=Some(true){errors.push("TB检测到多个包含非本位币的列，请确认系统预选的外币币种列".into());}
    Ok(())
}
pub(super) struct SingleTable;
impl Drop for SingleTable { fn drop(&mut self) { FX_REPLAY_TABLE.with(|slot| *slot.borrow_mut()=None); } }

pub(super) fn write_details(params:&Value,realized:&[Value],unrealized:&[Value],pending:&[Value],
    translations:&HashMap<String,String>,enabled:bool)->Result<String,AppError>{
    let root=tabular::cache_root()?.join("fx-details");fs::create_dir_all(&root).map_err(failure)?;
    let id=uuid::Uuid::new_v4().to_string();let path=root.join(format!("{id}.sqlite"));
    let mut db=Connection::open(&path).map_err(failure)?;
    db.execute_batch("PRAGMA cache_size=-8192;PRAGMA temp_store=FILE;CREATE TABLE details(voucher TEXT NOT NULL,source INTEGER NOT NULL,data TEXT NOT NULL);CREATE INDEX details_voucher ON details(voucher,source);").map_err(failure)?;
    let tx=db.transaction().map_err(failure)?;
    let result=visit_relevant_voucher_detail(params,realized,unrealized,pending,translations,enabled,|row|{
        tx.execute("INSERT INTO details VALUES (?1,?2,?3)",sql_params![row["voucherId"].as_str().unwrap_or(""),row["sourceRow"].as_u64().unwrap_or(0),serde_json::to_string(&row).map_err(failure)?]).map_err(failure)?;Ok(())
    });
    if let Err(error)=result{drop(tx);drop(db);let _=fs::remove_file(&path);return Err(error);}
    tx.commit().map_err(failure)?;Ok(id)
}
fn detail_db(id:&str)->Result<Connection,AppError>{
    let parsed=uuid::Uuid::parse_str(id).map_err(failure)?;
    let path=tabular::cache_root()?.join("fx-details").join(format!("{parsed}.sqlite"));
    Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(failure)
}
pub(super) fn detail_counts(id:&str)->Result<HashMap<String,usize>,AppError>{
    let db=detail_db(id)?;let mut query=db.prepare("SELECT voucher,COUNT(*) FROM details GROUP BY voucher").map_err(failure)?;
    query.query_map([],|row|Ok((row.get(0)?,row.get(1)?))).map_err(failure)?.collect::<Result<HashMap<_,_>,_>>().map_err(failure)
}
fn detail_query(voucher: Option<&str>) -> &'static str {
    // 可选条件的 OR 会阻断 details(voucher,source) 索引；逐凭证导出不能每次全库过滤排序。
    if voucher.is_some() { "SELECT data FROM details WHERE voucher=?1 ORDER BY source" }
    else { "SELECT data FROM details ORDER BY source" }
}
pub(super) fn visit_details(id:&str,voucher:Option<&str>,visitor:impl FnMut(Value)->Result<(),AppError>)->Result<(),AppError>{
    visit_details_from(&detail_db(id)?, voucher, visitor)
}
fn visit_details_from(db:&Connection,voucher:Option<&str>,mut visitor:impl FnMut(Value)->Result<(),AppError>)->Result<(),AppError>{
    let mut query=db.prepare(detail_query(voucher)).map_err(failure)?;
    let mut rows=if let Some(voucher)=voucher { query.query([voucher]) } else { query.query([]) }.map_err(failure)?;
    while let Some(row)=rows.next().map_err(failure)?{if replay_cancel().load(Ordering::Relaxed){return Err(error("JOB_CANCELLED","任务已取消。",None));}let raw:String=row.get(0).map_err(failure)?;visitor(serde_json::from_str(&raw).map_err(failure)?)?;}Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voucher_detail_export_seeks_index_and_preserves_all_and_single_voucher_order() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE details(voucher TEXT NOT NULL,source INTEGER NOT NULL,data TEXT NOT NULL);CREATE INDEX details_voucher ON details(voucher,source);").unwrap();
        let tx = db.transaction().unwrap();
        for source in (0..12000).rev() {
            let voucher = format!("V{:04}", source % 4000);
            tx.execute("INSERT INTO details VALUES(?1,?2,?3)",sql_params![voucher,source,json!({"voucherId":voucher,"sourceRow":source}).to_string()]).unwrap();
        }
        tx.commit().unwrap();
        let mut old = db.prepare("SELECT data FROM details WHERE (?1 IS NULL OR voucher=?1) ORDER BY source").unwrap();
        let expected = old.query_map(["V0007"], |row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        let old_steps = old.get_status(rusqlite::StatementStatus::FullscanStep);
        assert!(old_steps >= 11999);
        let plan = db.prepare(&format!("EXPLAIN QUERY PLAN {}", detail_query(Some("V0007")))).unwrap()
            .query_map(["V0007"], |row|row.get::<_,String>(3)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        assert!(plan.iter().any(|line|line.contains("SEARCH details USING INDEX details_voucher")), "{plan:?}");
        assert!(!plan.iter().any(|line|line.contains("TEMP B-TREE")), "{plan:?}");
        let mut new = db.prepare(detail_query(Some("V0007"))).unwrap();
        let actual = new.query_map(["V0007"], |row|row.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        assert_eq!(actual, expected);
        assert_eq!(new.get_status(rusqlite::StatementStatus::FullscanStep), 0);
        let mut selected = Vec::new();
        visit_details_from(&db, Some("V0007"), |row| { selected.push(row["sourceRow"].as_u64().unwrap()); Ok(()) }).unwrap();
        assert_eq!(selected, vec![7,4007,8007]);
        let mut all = Vec::new();
        visit_details_from(&db, None, |row| { all.push(row["sourceRow"].as_u64().unwrap()); Ok(()) }).unwrap();
        assert_eq!(all, (0..12000).collect::<Vec<_>>());
        let mut missing = 0;
        visit_details_from(&db, Some("不存在"), |_| { missing+=1; Ok(()) }).unwrap();
        assert_eq!(missing, 0);
        let error = visit_details_from(&db, Some("V0007"), |_| Err(error("DETAIL_VISIT_STOP", "停止读取明细", None))).unwrap_err();
        assert_eq!(error.code, "DETAIL_VISIT_STOP");
    }
    #[test]
    fn fx_disk_replay_matches_complete_vouchers_and_chronological_rollforward() {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("je.csv");
        fs::write(&path,"主体,日期,凭证号,科目,币种,原币,本位币\nE,2025-02-10,2,100201,CNY,0,720\nE,2025-01-10,1,112203,USD,100,700\n\nE,2025-02-10,2,112203,USD,-100,-700\nE,2025-01-10,1,6001,CNY,0,-700\nE,2025-02-10,2,660302,CNY,0,-20\n").unwrap();
        let params=json!({"fixedEntity":"E","reportStart":"2025-01-01","reportEnd":"2025-02-28",
            "jeSource":{"inputPath":path,"headerRow":1,"headerDepth":1},
            "jeMapping":{"entity":"主体","date":"日期","id":["凭证号"],"account":["科目"],"currency":"币种",
                "foreignAmount":"原币","functionalAmount":"本位币","__signConvention":"signed"},
            "accountRoles":{"100201":"cash","112203":"monetary_asset","6001":"non_monetary","660302":"fx_gain_loss"}});
        let mut disk=params.clone();disk["__largeJeDiskMode"]=json!(true);
        let rates=[("2024-12-31",6.9),("2025-01-10",7.0),("2025-01-31",7.1),("2025-02-10",7.2),("2025-02-28",7.3)];
        let snapshot=RateSnapshot{source:"测试".into(),source_url:String::new(),fetched_at:String::new(),response_hash:"disk-replay-test".into(),
            start_date:"2024-12-31".into(),end_date:"2025-02-28".into(),missing:vec![],
            rates:rates.into_iter().flat_map(|(date,amount)|[("USD",amount),("CNY",1.0)].map(|(currency,cny_per_unit)|RatePoint{requested_date:date.into(),published_date:date.into(),currency:currency.into(),cny_per_unit})).collect()};
        let memory=calculate_realized(&params,&snapshot,None).unwrap();
        let disk_result=calculate_realized(&disk,&snapshot,None).unwrap();
        assert_eq!(memory,disk_result);
        assert!(!disk_result.0.is_empty(),"直接收人民币结清外币应收应有已实现测算：{disk_result:#?}");
        let (input,mapping)=FxJeRows::from_params(&disk).unwrap();
        let mut physical=Vec::new();input.visit(&AtomicBool::new(false),|row|{physical.push((row.source_row,account_name(&row,&mapping)));Ok(())}).unwrap();
        assert!(physical.contains(&(5,"112203".into())),"物理空行不可压缩源行号：{physical:#?}");
        let endpoints=vec![json!({"entity":"E","account":"112203","auxiliary":"","currency":"USD",
            "openingForeign":0.0,"openingAuditFunctional":0.0,"openingBookFunctional":0.0,"closingBookFunctional":0.0})];
        let start=parse_date("2025-01-01").unwrap();let end=parse_date("2025-02-28").unwrap();
        let mut mq=vec![];let mut dq=vec![];
        let mm=calculate_monthly_unrealized(&params,&snapshot,start,end,&endpoints,&mut mq,&memory.0,&memory.1).unwrap();
        let dm=calculate_monthly_unrealized(&disk,&snapshot,start,end,&endpoints,&mut dq,&disk_result.0,&disk_result.1).unwrap();
        assert_eq!(mm,dm);assert_eq!(mq,dq);
        let mut mr=memory.0.clone();let mut dr=disk_result.0.clone();
        let mq=rebase_realized_with_monthly_rollforward(&params,&snapshot,&mm,&mut mr,&memory.1).unwrap();
        let dq=rebase_realized_with_monthly_rollforward(&disk,&snapshot,&dm,&mut dr,&disk_result.1).unwrap();
        assert_eq!(mr,dr);assert_eq!(mq,dq);
        assert_eq!(reconcile_fx_gain_loss(&params).unwrap(),reconcile_fx_gain_loss(&disk).unwrap());
        assert_eq!(build_review_bridge(&params,&mr,&mm).unwrap(),build_review_bridge(&disk,&dr,&dm).unwrap());
        let detail=build_relevant_voucher_detail(&params,&mr,&mm,&[],&HashMap::new(),false).unwrap();
        let cache=write_details(&disk,&dr,&dm,&[],&HashMap::new(),false).unwrap();
        let mut disk_detail=Vec::new();visit_details(&cache,None,|row|{disk_detail.push(row);Ok(())}).unwrap();
        assert_eq!(detail,disk_detail);
        let result=json!({"realized":dr,"voucherDetailCache":cache});
        assert!(realized_vouchers_missing_details(&result).is_empty());
        let mut workbook=Workbook::new();write_compact_realized_sheet(&mut workbook,&result,&HashSet::new()).unwrap();
        let output=dir.path().join("disk-workpaper.xlsx");workbook.save(&output).unwrap();
        let mut book=open_workbook_auto(&output).unwrap();
        let sheet=book.worksheet_range("已实现汇兑损益测算").unwrap();
        assert!(sheet.rows().skip(1).any(|row|row.get(3).is_some_and(|value|data_text(value)=="5")),"底稿应保留实际第5行分录");
    }
}
