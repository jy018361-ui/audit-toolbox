use super::*;
use std::cell::Cell;

#[test]
fn correction_check_keeps_original_source_counts_amounts_years_and_noise_exclusion() {
    let (mut result, mut params) = deep_export_fixture(&["3", "5", "0"]);
    for table in [&mut result.begin, &mut result.end] {
        table.headers[5] = "使用年限".into();
        table.headers[6] = "残值".into();
    }
    for side in ["beginMapping", "endMapping"] {
        params[side]["life"] = json!("使用年限");
        params[side]["residualRate"] = json!("残值");
    }
    for (index, residual) in ["50", "5", "0"].into_iter().enumerate() {
        result.end.rows[index][6] = residual.into();
    }
    result.end.rows[1][3] = "0".into();
    let mut total = result.end.rows[0].clone();
    total[1] = "合计".into();
    result.end.rows.push(total);
    result.begin.rows = result.end.rows.clone();
    // JoinedRow 仍是原夹具数据，故这些断言也保证没有错误地改为按匹配后行统计。
    let warnings = correction_warnings(&result, &params);
    assert_eq!(warnings.len(), 6, "{warnings:?}");
    for period in ["期初", "期末"] {
        let side = warnings.iter().filter(|text|text.contains(period)).collect::<Vec<_>>();
        assert_eq!(side.len(), 3);
        assert!(side.iter().any(|text|text.contains("1 张卡片") && text.contains("按残值金额除以原值")));
        assert!(side.iter().any(|text|text.contains("1 张卡片的残值率大于 1")));
        assert!(side.iter().any(|text|text.contains("2 张卡片的“使用年限”按年换算为月")));
    }
    params["beginMapping"] = json!({});
    params["endMapping"] = json!({});
    assert!(correction_warnings(&result, &params).is_empty());
}

#[test]
fn correction_check_supports_cancellation_and_monotonic_progress() {
    let (mut result, params) = deep_export_fixture(&vec!["12"; 6000]);
    result.begin.rows = result.end.rows.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let last = Cell::new(0usize);
    let events = Cell::new(0usize);
    let progress = |phase: &str, current: usize, total: usize, message: &str| {
        assert_eq!(phase, "check");
        assert_eq!(total, 100);
        assert!(current >= last.get());
        last.set(current); events.set(events.get()+1);
        if message.contains("4096 / 6000") { cancel.store(true, Ordering::Relaxed); }
    };
    let error = correction_warnings_with_progress(&result, &params, &progress, &cancel, &PauseCheckpoint::unpaused(cancel.clone())).unwrap_err();
    assert_eq!(error.code, "JOB_CANCELLED");
    assert!(events.get() >= 3);
    assert!(last.get() < 59);
}

#[test]
fn policy_export_decodes_wide_disk_rows_once_and_writer_needs_no_source() {
    let (mut result, params) = deep_export_fixture(&vec!["12"; 6000]);
    let expected = build_depreciation_period(&result, &params).unwrap();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("政策明细.sqlite");
    let mut db = rusqlite::Connection::open(&source).unwrap();
    db.execute_batch("CREATE TABLE joined(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE life(side INTEGER,col TEXT,value REAL); INSERT INTO life VALUES(1,'寿命(月)',12),(2,'寿命(月)',12);").unwrap();
    let tx = db.transaction().unwrap();
    for row in result.rows.iter() {
        tx.execute("INSERT INTO joined(data) VALUES(?)", [serde_json::to_string(&*row).unwrap()]).unwrap();
    }
    tx.commit().unwrap();
    drop(db);
    result.rows = disk_rows::JoinedRows::open(source.clone()).unwrap();
    let before = disk_rows::decoded_rows();
    let cancel = Arc::new(AtomicBool::new(false));
    let pause = PauseCheckpoint::unpaused(cancel.clone());
    let prepared = crate::fa_subtools::prepare_policy_export(&result, &params, &cancel, &pause).unwrap();
    assert_eq!(disk_rows::decoded_rows() - before, 6000);
    assert_eq!(prepared.base_rows, expected);
    drop(result);
    assert!(!source.exists());
    let mut wb = Workbook::new();
    crate::fa_subtools::write_depreciation_period_tax_sheet(&mut wb, &params, &Format::new(), &cancel, "折旧政策对比", &prepared).unwrap();
    let output = root.path().join("政策.xlsx");
    wb.save(&output).unwrap();
    let mut book = open_workbook_auto(output).unwrap();
    assert!(book.worksheet_range("折旧政策对比").unwrap().used_cells().any(|(_, _, value)| value.to_string() == "设备"));
}

fn deep_export_fixture(lives: &[&str]) -> (MergeResult, Value) {
    let headers = ["编号", "类别", "名称", "原值", "累计折旧", "寿命(月)", "残值率", "启用日期"];
    let table = || Table { path: PathBuf::from("测试清单.xlsx"), sheet: None, sheets: Vec::new(),
        header_row: 0, header_depth: 1, headers: headers.map(str::to_owned).to_vec(), rows: Vec::new(), row_count: lives.len() };
    let rows = lives.iter().enumerate().map(|(i, life)| JoinedRow {
        begin: None,
        end: Some(vec![format!("A{i:05}"), "设备".into(), "长名称设备".repeat(30), "1000".into(), "100".into(), life.to_string(), "0.05".into(), "2024-01-01".into()]),
        source: "仅文件2", match_value: format!("A{i:05}"), extra: BTreeMap::new(),
    }).collect::<Vec<_>>();
    let mut result = MergeResult { begin: table(), end: table(), rows: rows.into(), begin_keys: vec!["编号".into()], end_keys: vec!["编号".into()],
        duplicate_values: 0, duplicate_rows: 0, unmatched_addition: Vec::new(), unmatched_disposal: Vec::new() };
    result.end.rows = result.rows.iter().map(|row|row.end.clone().unwrap()).collect();
    let mapping = json!({"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"启用日期"});
    (result, json!({"beginMapping":mapping,"endMapping":mapping,"balanceSheetDate":"2025-12-31","__settings":{"llm":{"enabled":false}}}))
}

#[test]
fn borrowed_mapping_keeps_fallback_missing_side_and_original_storage() {
    let (result, mut params) = deep_export_fixture(&["12"]);
    let row = &result.rows[0];
    let text = mapped_text_ref(&result, row, &params, 2, "originalValue");
    assert_eq!(text, "1000");
    assert_eq!(text.as_ptr(), row.end.as_ref().unwrap()[3].as_ptr());
    assert_eq!(mapped_number(&result, row, &params, 2, "originalValue"), 1000.0);
    assert_eq!(mapped_text_ref(&result, row, &params, 1, "originalValue"), "");
    params["endMapping"]["originalValue"] = Value::Null;
    params["endOriginalValue"] = json!("累计折旧");
    assert_eq!(mapped_header(&params, 2, "originalValue").as_deref(), Some("累计折旧"));
    assert_eq!(mapped_number(&result, row, &params, 2, "originalValue"), 100.0);
    params["endMapping"]["originalValue"] = json!("不存在的字段");
    assert_eq!(mapped_text_ref(&result, row, &params, 2, "originalValue"), "");
    assert_eq!(mapped_number(&result, row, &params, 2, "originalValue"), 0.0);
}

#[test]
fn short_life_sheet_reuses_fa_values_with_spill_and_boundary_filter() {
    for (lives, expected_ids) in [
        (vec!["12"; 2000], (0..2000).map(|i|format!("A{i:05}")).collect::<Vec<_>>()),
        (vec!["", "0", "-1", "0.5", "12", "12.000001", "60期"], vec!["A00003".into(),"A00004".into()]),
    ] {
        let (result, params) = deep_export_fixture(&lives);
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("套表.xlsx");
        let mut book = Workbook::new();
        write_business_sheets(&mut book, &result, &params, &Format::new(), &AtomicBool::new(false)).unwrap();
        book.save(&output).unwrap();
        let mut book = open_workbook_auto(&output).unwrap();
        let fa = book.worksheet_range("FA List").unwrap();
        let short = book.worksheet_range("≤12月卡片明细").unwrap();
        let fa_values = fa.rows().skip(2).take(lives.len()).map(|row| row[..12].to_vec()).collect::<Vec<_>>();
        let selected = short.rows().skip(2).take(expected_ids.len()).map(|row| row[..12].to_vec()).collect::<Vec<_>>();
        assert_eq!(selected.iter().map(|row| row[1].to_string()).collect::<Vec<_>>(), expected_ids);
        for row in selected {
            assert_eq!(&row, fa_values.iter().find(|other| other[1] == row[1]).unwrap());
        }
    }
}

#[test]
fn summary_category_sources_match_previous_independent_scan() {
    let (mut result, params) = deep_export_fixture(&["12", "60", "60", "60", "60"]);
    for (index, (category, amount)) in [("共享", "100"), ("仅期末", "-50"), ("零余额", "0"), ("合计", "999"), ("", "20")].into_iter().enumerate() {
        let row = &mut result.rows.iter_mut().nth(index).unwrap();
        row.end.as_mut().unwrap()[1] = category.into();
        row.end.as_mut().unwrap()[3] = amount.into();
        if index == 0 { row.begin = row.end.clone(); }
    }
    let mut expected = [BTreeSet::new(), BTreeSet::new()];
    for row in result.rows.iter().filter(|row|row_summary_noise_marker(row).is_none()) {
        for side in [1, 2] {
            let category = mapped_text(&result, &row, &params, side, "category");
            if !category.trim().is_empty() && mapped_number(&result, &row, &params, side, "originalValue").abs() > 0.005 {
                expected[(side-1) as usize].insert(category);
            }
        }
    }
    let mut actual = [BTreeSet::new(), BTreeSet::new()];
    assert_eq!(build_extended_summary_with_sources(&result, &params, Some(&mut actual)), build_extended_summary(&result, &params));
    assert_eq!(actual, expected);
    let anomalies = row_anomalies(&result, &params, 1, &result.rows[1]);
    assert!(!anomalies.is_empty());
    assert!(anomalies.iter().all(|anomaly| anomaly[7] == result.rows[1].end.as_ref().unwrap().join(" | ")));
}

#[test]
fn merged_projection_preserves_json_cells_and_collision_order() {
    let table = |headers: &[&str]| Table {
        path: PathBuf::from("投影测试.xlsx"), sheet: None, sheets: Vec::new(),
        header_row: 0, header_depth: 1, headers: headers.iter().map(|h| h.to_string()).collect(),
        rows: Vec::new(), row_count: 0,
    };
    let row = JoinedRow {
        begin: Some(["00123", "旧名称", "新名称", "45104", "1234.56"].map(str::to_owned).to_vec()),
        end: Some(["0002", "0", "2025-12-31"].map(str::to_owned).to_vec()),
        source: "两文件都有", match_value: "00123 | 设备".into(), extra: BTreeMap::new(),
    };
    let mut variants = vec![row.clone()];
    let mut extras = row.clone();
    extras.extra = BTreeMap::from([
        ("名称_文件1".into(), super::Cell::Text("被覆盖".into())),
        ("名称_期初".into(), super::Cell::Text("最终名称".into())),
        ("数据来源".into(), super::Cell::Text("补充来源".into())),
        ("新增金额_文件2".into(), super::Cell::Number(123.45)),
        ("特殊金额_文件1".into(), super::Cell::Number(f64::NAN)),
        ("负零".into(), super::Cell::Number(-0.0)),
    ]);
    variants.push(extras);
    let mut missing = row.clone();
    missing.begin = None;
    missing.end = Some(vec!["缺列".into()]);
    variants.push(missing);
    let result = MergeResult {
        begin: table(&["资产编码", "名称", "名称", "启用日期", "原值"]),
        end: table(&["资产编码", "原值", "启用日期"]),
        rows: variants.clone().into(), begin_keys: Vec::new(), end_keys: Vec::new(),
        duplicate_values: 0, duplicate_rows: 0, unmatched_addition: Vec::new(), unmatched_disposal: Vec::new(),
    };
    let columns = result_columns(&result, true);
    let projection = MergedProjection::new(&result, &columns);
    for row in &variants {
        let old = row_json(&result, row, true);
        let projected = projection.project(row);
        for (column, value) in columns.iter().zip(projected) {
            let actual = match value {
                MergedCell::Text(v) => Some(json!(v)),
                MergedCell::Number(v) => Some(json!(v)),
                MergedCell::Null => Some(Value::Null),
                MergedCell::Missing => None,
            };
            assert_eq!(actual.as_ref(), old.get(column), "列：{column}");
            assert_eq!(value.rendered(), json_cell(old.get(column)));
        }
    }
    let values = projection.project(&row);
    let MergedCell::Text(text) = values[0] else { panic!("编号必须保持文本") };
    assert_eq!(text.as_ptr(), row.begin.as_ref().unwrap()[0].as_ptr());
}

#[test]
fn stream_export_generates_each_source_row_once_and_keeps_formula_policy() {
    let headers = ["入账开始日期", "使用寿命(月)", "残值率", "原值", "累计折旧", "本年折旧"];
    for (name, count) in [("新增清单_BKD", 0), ("新增清单_BKD", 12), ("FA List", 0), ("FA List", 12), ("FA List", 20_001), ("折旧测算", 12)] {
        let calls = Cell::new(0usize);
        let generated = Cell::new(0usize);
        let mut wb = Workbook::new();
        write_string_sheet_stream(&mut wb, name, &headers, || {
            calls.set(calls.get() + 1);
            (0..count).map(|_| {
                generated.set(generated.get() + 1);
                Ok(vec!["2024-01-01", "60", "0.05", "1000", "200", "190"].into_iter().map(str::to_owned).collect())
            })
        }, &Format::new(), Some("2025-12-31"), None, None).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(generated.get(), count);
        let path = std::env::temp_dir().join(format!("fa-once-{}.xlsx", uuid::Uuid::new_v4().simple()));
        wb.save(&path).unwrap();
        let mut book = open_workbook_auto(&path).unwrap();
        let values = book.worksheet_range(name).unwrap();
        assert_eq!(values.get_value(((count + 3) as u32, 0)).map(ToString::to_string).as_deref(), Some("本表说明"));
        if name == "FA List" || name == "折旧测算" {
            let formula_rows = if count > DEPRECIATION_FORMULA_ROW_LIMIT { 10 } else { count };
            let formulas = book.worksheet_formula(name).unwrap();
            assert_eq!(formulas.used_cells().filter(|(_, _, f)| !f.is_empty()).count(), formula_rows * 8);
            if count > DEPRECIATION_FORMULA_ROW_LIMIT {
                assert!(values.used_cells().any(|(_, _, v)| v.to_string().contains("共 20001 行")));
            }
        }
        drop(book);
        fs::remove_file(path).unwrap();
    }
}

#[test]
fn stream_export_propagates_late_errors_and_initial_cancellation() {
    for name in ["新增清单_BKD", "FA List"] {
        let mut wb = Workbook::new();
        let failure = write_string_sheet_stream(&mut wb, name, &["资产编码"], || {
            (0..300).map(|i| if i == 299 { Err(error("SOURCE_BROKEN", "源数据读取失败", None)) } else { Ok(vec![i.to_string()]) })
        }, &Format::new(), None, None, None).unwrap_err();
        assert_eq!(failure.code, "SOURCE_BROKEN");
        let cancelled = AtomicBool::new(true);
        let calls = Cell::new(0usize);
        let failure = write_string_sheet_stream(&mut wb, name, &["资产编码"], || {
            calls.set(calls.get() + 1);
            std::iter::empty()
        }, &Format::new(), None, Some(&cancelled), None).unwrap_err();
        assert_eq!(failure.code, "JOB_CANCELLED");
        assert_eq!(calls.get(), 0);
    }
}

#[test]
fn formula_limit_boundary_preserves_last_full_row() {
    let headers = ["入账开始日期", "使用寿命(月)", "残值率", "原值", "累计折旧", "本年折旧"];
    for count in [20_000, 20_001] {
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        append_depreciation_formulas_chunk(ws, "FA List", &headers, count, "2025-12-31", &Format::new(), &Format::new(), None, 19_999..20_000, true).unwrap();
        let path = std::env::temp_dir().join(format!("fa-limit-{}.xlsx", uuid::Uuid::new_v4().simple()));
        wb.save(&path).unwrap();
        let mut book = open_workbook_auto(&path).unwrap();
        let formulas = book.worksheet_formula("Sheet1").unwrap();
        assert_eq!(formulas.used_cells().filter(|(_, _, f)| !f.is_empty()).count(), if count == 20_000 { 8 } else { 0 });
        drop(book);
        fs::remove_file(path).unwrap();
    }
}

/// A reproducible export-only benchmark. Inputs must be disposable copies:
/// JoinedRows owns/removes its SQLite file when the test finishes.
#[test]
#[ignore = "需设置 AUDIT_FA_EXPORT_BENCH_REQUEST，使用独立模拟数据目录"]
fn export_performance_probe_from_prepared_rows() {
    let request_path = PathBuf::from(std::env::var("AUDIT_FA_EXPORT_BENCH_REQUEST").unwrap());
    let root = fs::canonicalize(request_path.parent().unwrap()).unwrap();
    let request: Value = serde_json::from_slice(&fs::read(&request_path).unwrap()).unwrap();
    let input = root.join("joined.bench.sqlite");
    assert_eq!(fs::canonicalize(&input).unwrap().parent(), Some(root.as_path()));
    let table = |key: &str| {
        let value = &request[key];
        Table {
            path: PathBuf::from(value["path"].as_str().unwrap()),
            sheet: value["sheet"].as_str().map(str::to_owned),
            sheets: strings(value.get("sheets")),
            header_row: value["headerRow"].as_u64().unwrap_or(0) as usize,
            header_depth: value["headerDepth"].as_u64().unwrap_or(1) as usize,
            headers: strings(value.get("headers")),
            rows: Vec::new(),
            row_count: value["rowCount"].as_u64().unwrap_or(0) as usize,
        }
    };
    let params = &request["params"];
    let result = MergeResult {
        begin: table("beginTable"), end: table("endTable"),
        rows: JoinedRows::open(input).unwrap(),
        begin_keys: strings(params.get("beginKeys")), end_keys: strings(params.get("endKeys")),
        duplicate_values: 0, duplicate_rows: 0,
        unmatched_addition: Vec::new(), unmatched_disposal: Vec::new(),
    };
    assert_eq!(result.rows.len(), request["expectedRows"].as_u64().unwrap() as usize);
    let output = root.join("FA_导出性能测试.xlsx");
    let started = std::time::Instant::now();
    let last = std::cell::RefCell::new(String::new());
    let timings = write_xlsx_with_progress(&output, &result, params, &AtomicBool::new(false), None, None,
        &|_, current, total, message| {
            if last.borrow().as_str() != message {
                eprintln!("[导出基准] {:.3}s {current}/{total} {message}", started.elapsed().as_secs_f64());
                *last.borrow_mut() = message.to_owned();
            }
        }).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    result.rows.check().unwrap();
    let columns = result_columns(&result, true);
    let report = json!({"case":request["case"],"profile":"debug-unoptimized", "rows":result.rows.len(),
        "inputColumns":[result.begin.headers.len(),result.end.headers.len()],"mergedColumns":columns,
        "seconds":seconds,"stages":timings,"outputBytes":fs::metadata(&output).unwrap().len(),
        "outputPath":output,"expected":request["expected"]});
    fs::write(root.join("timings.json"), serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("[导出基准] 完成：{} 行，{seconds:.3}s，{} 字节", result.rows.len(), report["outputBytes"]);
}
