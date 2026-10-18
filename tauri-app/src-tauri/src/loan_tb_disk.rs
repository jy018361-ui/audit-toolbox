//! 借款 TB 的完整行访问器。所有正文扫描和随机代表行读取均使用同一磁盘源。
use super::*;
use crate::fx::tb_replay::FxTbRows;
thread_local! {static CANCEL:std::cell::RefCell<Option<Arc<AtomicBool>>>=const{std::cell::RefCell::new(None)};}
pub(super) struct Guard;
impl Guard {
    pub(super) fn begin(cancel: Arc<AtomicBool>) -> Self {
        CANCEL.with(|slot| *slot.borrow_mut() = Some(cancel));
        Self
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        CANCEL.with(|slot| *slot.borrow_mut() = None);
    }
}
pub(super) fn active() -> Arc<AtomicBool> {
    CANCEL
        .with(|slot| slot.borrow().clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)))
}
pub(super) struct TbInput {
    table: Table,
    pub(super) input: FxTbRows,
}
impl std::ops::Deref for TbInput {
    type Target = Table;
    fn deref(&self) -> &Table {
        &self.table
    }
}
impl TbInput {
    pub(super) fn open(
        params: &Value,
        catalog: bool,
    ) -> Result<(Self, Map<String, Value>, ledger_mapping::TbLeafAnalysis), AppError> {
        let (spec, mapping) = source_config(params, "tbSource")?;
        let mut normalized = mapping.clone();
        for (role, _) in ledger_mapping::role_labels("tb") {
            let columns = mapped_names(&mapping, "tb", role);
            if !columns.is_empty() {
                normalized.insert(role.into(), json!(columns));
            }
        }
        if !mapped_names(&mapping, "tb", "loanId").is_empty() {
            normalized.insert(
                "auxiliary".into(),
                json!(mapped_names(&mapping, "tb", "loanId")),
            );
        }
        let fx_spec = crate::fx::SourceSpec {
            input_path: spec.input_path,
            sheet: spec.sheet,
            header_row: spec.header_row,
            header_depth: spec.header_depth,
        };
        let mut paths = vec![Path::new(&fx_spec.input_path)];
        let je = source_config(params, "jeSource")
            .ok()
            .map(|(source, _)| source);
        if let Some(je) = &je {
            paths.push(Path::new(&je.input_path));
        }
        let force = params
            .get("__forceDiskTb")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || crate::disk_table::should_use_disk(&paths, 4);
        let input = FxTbRows::open_controlled(&fx_spec, &normalized, catalog, force, &active())?;
        let table = Table {
            path: input.path.clone(),
            sheet: input.sheet.clone(),
            sheets: input.sheets.clone(),
            header_row: input.header_row,
            header_depth: input.header_depth,
            headers: input.headers.clone(),
            rows: LoanTableRows::Shared(input.table.clone()),
        };
        let mut analysis = input.leaf_analysis(&normalized);
        input.validate_amounts(&normalized, "TB", Some(&analysis.keep))?;
        if catalog {
            if let Some(disk) = &input.analysis {
                disk.visit_entity_groups(
                    &input.headers,
                    &|role| mapped_names(&mapping, "tb", role),
                    &active(),
                    |rows, ids, group, _| {
                        let group = ledger_mapping::tb_catalog_from_analysis(
                            &input.headers,
                            rows,
                            &|role| mapped_names(&mapping, "tb", role),
                            group,
                        );
                        for (id, keep) in ids.iter().zip(group.keep) {
                            if *id > 0 {
                                analysis.keep[*id - 1] = keep;
                            }
                        }
                        Ok(())
                    },
                )?;
            } else {
                analysis = ledger_mapping::tb_catalog_from_analysis(
                    &input.headers,
                    &input.rows,
                    &|role| mapped_names(&mapping, "tb", role),
                    analysis,
                );
            }
        }
        Ok((Self { table, input }, mapping, analysis))
    }
    pub(super) fn visit(
        &self,
        mut visitor: impl FnMut(&[String], usize) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.input
            .visit(&active(), |row, index| visitor(row.values(), index))
    }
    pub(super) fn row(&self, index: usize) -> Result<Vec<String>, AppError> {
        if let Some(disk) = &self.input.disk {
            let source_row = self.header_row + self.header_depth + index;
            let text: String = disk
                .connection()
                .query_row("SELECT data FROM rows WHERE id=?", [source_row], |row| {
                    row.get(0)
                })
                .map_err(|e| {
                    error(
                        "TB_DISK_READ_FAILED",
                        "借款余额表行读取失败，请重新读取。",
                        Some(e.to_string()),
                    )
                })?;
            let mut values: Vec<String> = serde_json::from_str(&text).map_err(|e| {
                error(
                    "TB_DISK_DATA_INVALID",
                    "借款余额表磁盘数据损坏，请重新读取。",
                    Some(e.to_string()),
                )
            })?;
            values.resize(self.headers.len(), String::new());
            Ok(values)
        } else {
            self.rows
                .get(index)
                .cloned()
                .ok_or_else(|| error("TB_ROW_MISSING", "借款余额表行已不存在，请重新读取。", None))
        }
    }
    pub(super) fn self_signed(&self, mapping: &Map<String, Value>, prefix: &str) -> bool {
        self.input
            .analysis
            .as_ref()
            .and_then(|analysis| analysis.self_signed.get(prefix))
            .copied()
            .unwrap_or_else(|| {
                ledger_mapping::balance_self_signed(
                    &self.headers,
                    &self.rows,
                    &|role| mapped_names(mapping, "tb", role),
                    prefix,
                )
            })
    }
    pub(super) fn convention(
        &self,
        mapping: &Map<String, Value>,
    ) -> ledger_mapping::SignConvention {
        self.input
            .analysis
            .as_ref()
            .map(|analysis| analysis.convention)
            .unwrap_or_else(|| tb_sign_convention(self, mapping))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write(path: &Path, rows: &[&str], xlsx: bool) {
        if xlsx {
            let mut wb = Workbook::new();
            let ws = wb.add_worksheet();
            ws.set_name("数据").unwrap();
            for (r, row) in rows.iter().enumerate() {
                for (c, value) in row.split(',').enumerate() {
                    ws.write_string(r as u32, c as u16, value).unwrap();
                }
            }
            wb.save(path).unwrap();
        } else {
            fs::write(path, rows.join("\n")).unwrap();
        }
    }
    #[test]
    fn loan_disk_tb_inspection_has_complete_late_entities_accounts_and_years() {
        for xlsx in [false, true] {
            let dir =
                std::env::temp_dir().join(format!("loan-tb-inspect-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut data =
                String::from("主体,科目编码,科目名称,期间,期初余额,本年借方,本年贷方,期末余额\n");
            for i in 0..220 {
                data.push_str(&format!("A,1001{i:04},现金{i},2025,1,0,0,1\n"));
            }
            data.push_str("晚出现公司,2001,短期借款,2027,100,0,10,90\n");
            let path = dir.join(if xlsx { "tb.xlsx" } else { "tb.csv" });
            if xlsx {
                let mut book = rust_xlsxwriter::Workbook::new();
                let ws = book.add_worksheet();
                ws.set_name("余额表").unwrap();
                for (r, line) in data.lines().enumerate() {
                    for (c, value) in line.split(',').enumerate() {
                        ws.write_string(r as u32, c as u16, value).unwrap();
                    }
                }
                book.save(&path).unwrap();
            } else {
                std::fs::write(&path, data).unwrap();
            }
            let mut params =
                json!({"kind":"tb","source":{"inputPath":path,"headerRow":1,"headerDepth":1}});
            let memory = inspect(&params).unwrap();
            params["__forceDiskTb"] = json!(true);
            let disk = inspect(&params).unwrap();
            for field in [
                "headers",
                "preview",
                "rowCount",
                "headerRow",
                "headerDepth",
                "suggestedMapping",
                "dataYears",
                "suggestedBalanceSheetDate",
                "entities",
                "entityAccounts",
                "metadataComplete",
                "sampledPreview",
            ] {
                assert_eq!(memory[field], disk[field], "{field}");
            }
            assert!(
                disk["entities"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("晚出现公司"))
            );
            assert_eq!(disk["dataYears"], json!([2025, 2027]));
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn loan_disk_tb_matches_memory_catalog_rates_expense_folds_and_interest() {
        for xlsx in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let ext = if xlsx { "xlsx" } else { "csv" };
            let tb = dir.path().join(format!("TB.{ext}"));
            let je = dir.path().join(format!("JE.{ext}"));
            let mut tb_rows = vec!["主体,编码,科目,借款,期初贷,期末贷,本年借方,本年贷方"];
            tb_rows.extend(std::iter::repeat_n("甲公司,1001,库存现金,,0,0,0,0", 220));
            tb_rows.extend([
                "甲公司,2001,短期借款,工行贷款,1000000,1100000,0,100000",
                "甲公司,6603,财务费用-利息支出,,0,0,30000,0",
                "乙公司,2001,短期借款,建行贷款,2000000,1800000,200000,0",
                "乙公司,6603,财务费用-利息支出,,0,0,40000,0",
            ]);
            write(&tb, &tb_rows, xlsx);
            write(
                &je,
                &[
                    "主体,编码,科目,借款,日期,借方,贷方",
                    "甲公司,2001,短期借款,工行贷款,2025-07-01,0,100000",
                    "乙公司,2001,短期借款,建行贷款,2025-06-01,200000,0",
                ],
                xlsx,
            );
            let mut params = json!({"mode":"tb","reportStart":"2025-01-01","reportEnd":"2025-12-31","loanAccounts":["2001"],"interestExpenseAccounts":["6603"],
                "tbSource":{"source":{"inputPath":tb,"sheet":if xlsx{"数据"}else{"CSV"},"headerRow":1,"headerDepth":1},"mapping":{"entity":"主体","accountCode":"编码","accountName":"科目","loanId":"借款","openingFunctionalCredit":"期初贷","closingFunctionalCredit":"期末贷","ytdFunctionalDebit":"本年借方","ytdFunctionalCredit":"本年贷方"}},
                "jeSource":{"source":{"inputPath":je,"sheet":if xlsx{"数据"}else{"CSV"},"headerRow":1,"headerDepth":1},"mapping":{"entity":"主体","accountCode":"编码","accountName":"科目","loanId":"借款","date":"日期","functionalDebit":"借方","functionalCredit":"贷方"}},
                "rateRows":[{"entity":"甲公司","loanId":"工行贷款","rateType":"fixed","fixedRate":0.0365},{"entity":"乙公司","loanId":"建行贷款","rateType":"fixed","fixedRate":0.04}],
                "auxiliaryLink":{"groups":[{"entity":"甲公司","account":"2001","reviewVerified":true,"column":"借款"},{"entity":"乙公司","account":"2001","reviewVerified":true,"column":"借款"}]}});
            let catalog = tb_accounts(&params).unwrap();
            let rates = prepare_rates(&params).unwrap();
            let expense = booked_interest_expense(&params).unwrap();
            let mut memory =
                calculate_tb_impl(&params, &|_, _, _, _| {}, &AtomicBool::new(false), false)
                    .unwrap();
            calculate_interest(&mut memory, &params).unwrap();
            params["__forceDiskTb"] = json!(true);
            let (input, _, _) = TbInput::open(&params, false).unwrap();
            assert!(input.input.disk.is_some());
            assert!(input.rows.len() <= 200);
            assert!(
                input
                    .rows
                    .iter()
                    .all(|row| !row.iter().any(|value| value == "短期借款"))
            );
            assert_eq!(catalog, tb_accounts(&params).unwrap());
            assert_eq!(rates, prepare_rates(&params).unwrap());
            let disk_expense = booked_interest_expense(&params).unwrap();
            assert_eq!(expense.amount, disk_expense.amount);
            assert_eq!(expense.details, disk_expense.details);
            let mut disk =
                calculate_tb_impl(&params, &|_, _, _, _| {}, &AtomicBool::new(false), false)
                    .unwrap();
            calculate_interest(&mut disk, &params).unwrap();
            assert_eq!(
                serde_json::to_value(&memory).unwrap(),
                serde_json::to_value(&disk).unwrap()
            );
            params["rateText"] = json!("借款,利率\n工行贷款,3.65%\n建行贷款,4%");
            let matched = match_rates(&params).unwrap();
            params["__forceDiskTb"] = json!(false);
            assert_eq!(matched, match_rates(&params).unwrap());
        }
    }
}

impl TbInput {
    pub(super) fn reanalyze(
        &self,
        mapping: &Map<String, Value>,
    ) -> Result<ledger_mapping::TbLeafAnalysis, AppError> {
        if let Some(disk) = &self.input.disk {
            Ok(ledger_mapping::disk_tb::analyze(
                disk,
                &|role| mapped_names(mapping, "tb", role),
                false,
                &|_, _, _, _| {},
                &active(),
            )?
            .analysis)
        } else {
            Ok(ledger_mapping::TbLeafAnalysis {
                keep: ledger_mapping::tb_leaf_mask(&self.headers, &self.rows, &|role| {
                    mapped_names(mapping, "tb", role)
                }),
                contexts: Vec::new(),
                parent_names: Vec::new(),
            })
        }
    }
    pub(super) fn reconcile_domain(
        &self,
        role: &str,
        tm: &mut Map<String, Value>,
        je: &Table,
        jm: &mut Map<String, Value>,
    ) -> Result<(), AppError> {
        if self.input.disk.is_none() {
            ledger_mapping::reconcile_key_domains(
                role,
                &self.headers,
                &self.rows,
                tm,
                &je.headers,
                &je.rows,
                jm,
            );
            return Ok(());
        }
        let columns = |mapping: &Map<String, Value>| match mapping.get(role) {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(v)) => v
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        let tcols = columns(tm);
        let jcols = columns(jm);
        if tcols.is_empty() || jcols.is_empty() {
            return Ok(());
        }
        let tis = tcols
            .iter()
            .filter_map(|c| ledger_mapping::header_index(&self.headers, c))
            .collect::<Vec<_>>();
        let jis = jcols
            .iter()
            .filter_map(|c| ledger_mapping::header_index(&je.headers, c))
            .collect::<Vec<_>>();
        let jvalues = je
            .rows
            .iter()
            .flat_map(|row| jis.iter().filter_map(|i| row.get(*i)))
            .map(|v| crate::fa::normalize_join_key(v))
            .filter(|v| !v.is_empty())
            .collect::<BTreeSet<_>>();
        if jvalues.is_empty() {
            return Ok(());
        }
        let mut any = false;
        let mut hit = false;
        let mut candidate = None;
        self.visit(|row, _| {
            for i in &tis {
                let v =
                    crate::fa::normalize_join_key(row.get(*i).map(String::as_str).unwrap_or(""));
                any |= !v.is_empty();
                hit |= jvalues.contains(&v);
            }
            for (i, v) in row.iter().enumerate() {
                if !tcols.contains(&self.headers[i])
                    && jvalues.contains(&crate::fa::normalize_join_key(v))
                {
                    candidate = Some(candidate.map_or(i, |old: usize| old.min(i)));
                }
            }
            Ok(())
        })?;
        if !any || hit {
            return Ok(());
        }
        if let Some(i) = candidate {
            tm.insert(role.into(), json!(self.headers[i]));
            return Ok(());
        }
        // JE 已在内存时，反向候选的值域可直接查磁盘逐列，不收集 TB 全量字符串。
        let mut hits = BTreeSet::<usize>::new();
        let je_values = je
            .rows
            .iter()
            .flat_map(|row| {
                row.iter()
                    .enumerate()
                    .filter(|(i, _)| !jis.contains(i))
                    .map(|(i, v)| (crate::fa::normalize_join_key(v), i))
            })
            .filter(|(v, _)| !v.is_empty())
            .fold(
                HashMap::<String, BTreeSet<usize>>::new(),
                |mut map, (v, i)| {
                    map.entry(v).or_default().insert(i);
                    map
                },
            );
        self.visit(|row, _| {
            for i in &tis {
                if let Some(indices) = je_values.get(&crate::fa::normalize_join_key(
                    row.get(*i).map(String::as_str).unwrap_or(""),
                )) {
                    hits.extend(indices.iter().copied());
                }
            }
            Ok(())
        })?;
        if let Some(i) = hits.first() {
            jm.insert(role.into(), json!(je.headers[*i]));
        } else {
            tm.remove(role);
            jm.remove(role);
        }
        Ok(())
    }
}
