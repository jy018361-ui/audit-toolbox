//! Loan ledger row replay. Segment discovery is a separate complete scan so
//! repeated headers and mixed monetary units keep the existing calculation.
use super::*;
use crate::disk_table::DiskTable;

pub(super) fn applies(params: &Value, spec: &SourceSpec) -> bool {
    (cfg!(test) && params.get("__testDiskLedger").and_then(Value::as_bool) == Some(true))
        || crate::disk_table::should_use_disk(&[Path::new(&spec.input_path)], 1)
}

pub(super) fn open(spec: &SourceSpec, progress: &dyn Fn(&str,usize,usize,&str), cancel: &AtomicBool) -> Result<(Table,DiskTable),AppError> {
    let path = Path::new(&spec.input_path);
    let (sheet,sheets,prefix) = crate::disk_table::preview_source(path,(!spec.sheet.is_empty()).then_some(spec.sheet.as_str()),spec.header_row.saturating_add(32).max(64))?;
    let mut table = finish_ledger_table(spec,path.into(),sheet,sheets,prefix)?;
    let disk = DiskTable::open(path,Some(&table.sheet),table.header_row,table.header_depth,progress,cancel)?;
    while table.headers.len() < disk.headers.len() { table.headers.push(format!("未命名列{}",table.headers.len()+1)); }
    // Keep the ledger-specific headings, including blank and duplicate names.
    table.rows = Vec::new().into();
    Ok((table,disk))
}

fn visit(disk:&DiskTable,cancel:&AtomicBool,mut visitor:impl FnMut(&[String],usize)->Result<(),AppError>)->Result<usize,AppError>{
    let mut index=0;
    disk.visit(cancel,|row,_|{
        if row.iter().any(|s|!s.trim().is_empty()) { visitor(row,index)?;index+=1; }
        Ok(())
    })?;
    Ok(index)
}

pub(super) fn preview(spec:&SourceSpec,offset:usize,limit:usize,cancel:&AtomicBool)->Result<(Table,usize),AppError>{
    let (mut table,disk)=open(spec,&|_,_,_,_|{},cancel)?;
    let mut rows=Vec::new();
    let count=visit(&disk,cancel,|row,index|{ if index>=offset && index<offset.saturating_add(limit){rows.push(row.to_vec());}Ok(())})?;
    table.rows=rows.into();
    Ok((table,count))
}
pub(super) fn inspection_prefix(spec:&SourceSpec)->Result<Table,AppError>{
    let (sheet,sheets,prefix)=crate::disk_table::preview_source(Path::new(&spec.input_path),(!spec.sheet.is_empty()).then_some(spec.sheet.as_str()),spec.header_row.saturating_add(32).max(64))?;
    finish_ledger_table(spec,PathBuf::from(&spec.input_path),sheet,sheets,prefix)
}

pub(super) fn calculate(params:&Value,progress:&dyn Fn(&str,usize,usize,&str),cancel:&AtomicBool)->Result<Vec<LoanRow>,AppError>{
    let (spec,mapping)=source_config(params,"ledgerSource")?;
    let mapping=normalize_loan_mapping(mapping);
    let (mut table,disk)=open(&spec,progress,cancel)?;
    let contract_mode=matches!(loan_form(&mapping).as_deref(),Some("A")|Some("B"));
    let mut segment_count=1_usize;
    if contract_mode {
        visit(&disk,cancel,|row,index|{
            if index>0 && repeated_header(row,table.headers.len()).is_some(){segment_count+=1;}
            Ok(())
        })?;
    }
    let multi=segment_count>1;
    let period=if contract_mode{Some((date(params,"reportStart")?,date(params,"reportEnd")?))}else{None};
    let overrides=rate_overrides(params);
    let mut mapping=mapping;
    let mut segment=1_usize;let mut segment_start=0_usize;
    let mut out=Vec::new();
    visit(&disk,cancel,|row,index|{
        if index%256==0{
            if cancel.load(Ordering::Relaxed){return Err(error("JOB_CANCELLED","任务已取消。",None));}
            crate::resource_budget::check_available_if_managed()?;
            progress("read",index,disk.row_count,"正在从磁盘分批解析借款台账…");
        }
        if contract_mode && index>0 {
            if let Some(headers)=repeated_header(row,table.headers.len()){
                table.headers=headers;
                mapping=suggest(&table.headers,"ledger");
                segment+=1;segment_start=index+1;
                return Ok(());
            }
        }
        table.rows=vec![row.to_vec()].into();
        if segment == 1 {
            let issues=ledger_mapping::mapped_amount_parse_issues("loan",&table.headers,&table.rows,&|role|mapped_names(&mapping,"loan",role));
            if let Some(issue)=issues.first(){return Err(error("AMOUNT_VALUE_INVALID",format!("LEDGER金额列「{}」第{}行的值“{}”无法解析为数值，请修正后重试。",issue.column,table.header_row+table.header_depth+index,issue.value.chars().take(80).collect::<String>()),None));}
        }
        if let Some(period)=period{
            if !mapping.contains_key("principal"){return Ok(());}
            let unit=if multi {unit_factor(mapping.get("principal").and_then(Value::as_str).unwrap_or(""))}else{1.0};
            contract_rows(&table,&mapping,unit,segment,multi,index,index.saturating_sub(segment_start),&overrides,period,&mut out);
        }else{
            let mut local=params.clone();
            local["ledgerRateOverrides"]=params.get("ledgerRateOverrides").and_then(Value::as_array)
                .and_then(|all|all.get(index)).map(|v|json!([v])).unwrap_or_else(||json!([]));
            match calculate_ledger_table(&local,&table,&mapping){
                Ok(mut rows)=>out.append(&mut rows),
                Err(e) if e.code=="NO_LOANS"=>{},
                Err(e)=>return Err(e),
            }
        }
        Ok(())
    })?;
    if out.is_empty(){return Err(error("NO_LOANS","未从借款台账识别到可测算的借款。",None));}
    Ok(out)
}
fn repeated_header(row:&[String],width:usize)->Option<Vec<String>>{
    let nonempty=row.iter().filter(|v|!v.trim().is_empty()).count();
    let hits=row.iter().filter(|v|header_cell_hit(v)).count();
    if hits<3 || nonempty<3 || hits*2<nonempty{return None;}
    let headers=padded_headers(row,width);
    suggest(&headers,"ledger").contains_key("principal").then_some(headers)
}

pub(super) enum RateSource {
    Memory(Table,Map<String,Value>),
    Disk { table:Table, mapping:Map<String,Value>, disk:DiskTable, index:String },
}
fn rate_sql(e:rusqlite::Error)->AppError{error("LOAN_RATE_DISK_FAILED","无法读取利率台账磁盘索引，请检查磁盘后重试。",Some(e.to_string()))}
impl RateSource {
    pub(super) fn open(params:&Value)->Result<Option<Self>,AppError>{
        if params.get("rateLedgerSource").is_none_or(Value::is_null){return Ok(None);}
        let (spec,mapping)=source_config(params,"rateLedgerSource")?;
        if !applies(params,&spec){let (t,m)=source(params,"rateLedgerSource")?;return Ok(Some(Self::Memory(t,m)));}
        let mapping=normalize_loan_mapping(mapping);
        let cancel=AtomicBool::new(false);
        let (table,disk)=open(&spec,&|_,_,_,_|{},&cancel)?;
        let hash=hex::encode(Sha256::digest(serde_json::to_vec(&mapping).map_err(|e|error("INVALID_PARAMS","利率映射无效。",Some(e.to_string())))?));
        let index=format!("loan_rates_{}",&hash[..24]);
        let exists=disk.connection().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",[&index],|row|row.get::<_,bool>(0)).map_err(rate_sql)?;
        if !exists{
            let tx=disk.connection().unchecked_transaction().map_err(rate_sql)?;
            tx.execute_batch(&format!("CREATE TABLE {index}(key TEXT PRIMARY KEY,row INTEGER NOT NULL)")).map_err(rate_sql)?;
            let mut insert=tx.prepare(&format!("INSERT OR IGNORE INTO {index} VALUES (?1,?2)")).map_err(rate_sql)?;
            disk.visit(&cancel,|row,physical|{
                let key=norm(&text(&table,row,&mapping,"loanId"));
                insert.execute(rusqlite::params![key,physical]).map_err(rate_sql)?;Ok(())
            })?;
            drop(insert);tx.commit().map_err(rate_sql)?;
        }
        Ok(Some(Self::Disk{table,mapping,disk,index}))
    }
    pub(super) fn find(&self,id:&str)->Result<Option<(String,Option<f64>,Option<f64>,Option<f64>)>,AppError>{
        let make=|table:&Table,row:&[String],mapping:&Map<String,Value>|{let (fixed,benchmark,bps)=rates(table,row,mapping);(source_rate_type(table,row,mapping),fixed,benchmark,bps)};
        match self{
            Self::Memory(table,mapping)=>Ok(table.rows.iter().find(|row|norm(&text(table,row,mapping,"loanId"))==norm(id)).map(|row|make(table,row,mapping))),
            Self::Disk{table,mapping,disk,index}=>{
                use rusqlite::OptionalExtension;
                let raw:Option<String>=disk.connection().query_row(&format!("SELECT r.data FROM rows r JOIN {index} k ON r.id=k.row WHERE k.key=?1"),[norm(id)],|row|row.get(0)).optional().map_err(rate_sql)?;
                let Some(raw)=raw else{return Ok(None);};
                let row:Vec<String>=serde_json::from_str(&raw).map_err(|e|error("LOAN_RATE_DISK_FAILED","利率缓存损坏，请重新读取。",Some(e.to_string())))?;
                Ok(Some(make(table,&row,mapping)))
            }
        }
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn loan_disk_ledger_keeps_segment_units_generated_ids_overrides_and_rows(){
        let dir=tempfile::tempdir().unwrap();let input=dir.path().join("借款.csv");
        fs::write(&input,"贷款方,本金（万元）,执行利率,开始日,到期日\n甲银行,100,3.5,2024-01-01,2026-12-31\n甲银行,200,4,2024-01-01,2026-12-31\n贷款方,本金（千元）,执行利率,开始日,到期日\n乙银行,300,4.5,2024-01-01,2026-12-31\n").unwrap();
        let params=json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31","ledgerSource":{"source":{"inputPath":input,"sheet":"CSV","headerRow":1,"headerDepth":1},"mapping":{"lender":"贷款方","principal":"本金（万元）","rate":"执行利率","startDate":"开始日","endDate":"到期日"}}});
        let memory=calculate_ledger(&params).unwrap();
        let disk=calculate(&params,&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        assert_eq!(serde_json::to_value(&memory).unwrap(),serde_json::to_value(&disk).unwrap());
        for (left,right) in memory.iter().zip(&disk){assert_eq!(left.source_cells,right.source_cells);assert_eq!(left.source_unit,right.source_unit);}
    }
    #[test]
    fn loan_disk_movement_and_rate_lookup_keep_first_duplicate_and_preview_offsets(){
        let dir=tempfile::tempdir().unwrap();let input=dir.path().join("变动.csv");
        fs::write(&input,"借款编号,期初本金,新增金额,归还金额,期末本金,执行利率\nA,100,20,10,110,3.5\n\nB,200,0,20,180,4\n").unwrap();
        let params=json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31","ledgerSource":{"source":{"inputPath":input,"headerRow":1,"headerDepth":1},"mapping":{"loanId":"借款编号","openingPrincipal":"期初本金","drawdownAmount":"新增金额","repaymentAmount":"归还金额","closingPrincipal":"期末本金","fixedRate":"执行利率"}},"ledgerRateOverrides":[null,{"rateType":"floating","spreadBps":25}]});
        let memory=calculate_ledger(&params).unwrap();
        let disk=calculate(&params,&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        assert_eq!(serde_json::to_value(memory).unwrap(),serde_json::to_value(disk).unwrap());
        let spec=SourceSpec{input_path:input.to_string_lossy().into_owned(),sheet:String::new(),header_row:1,header_depth:1};
        let (page,count)=preview(&spec,1,1,&AtomicBool::new(false)).unwrap();
        assert_eq!(count,2);assert_eq!(page.rows[0][0],"B");
        let rates=dir.path().join("利率.csv");fs::write(&rates,"借款编号,固定利率\nA,3.5\nA,4.5\nB,5\n").unwrap();
        let request=json!({"__testDiskLedger":true,"rateLedgerSource":{"source":{"inputPath":rates,"headerRow":1,"headerDepth":1},"mapping":{"loanId":"借款编号","fixedRate":"固定利率"}}});
        let source=RateSource::open(&request).unwrap().unwrap();
        let found=source.find("A").unwrap().unwrap();assert_eq!(found.1,Some(0.035));assert!(source.find("C").unwrap().is_none());
    }
}
