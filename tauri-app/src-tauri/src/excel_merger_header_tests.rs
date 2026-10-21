fn preview_position_plan(preview: &Value) -> Value {
    json!({
        "templatePath": preview["template"]["path"],
        "templateHeaders": preview["template"]["headers"],
        "rememberAliases": [],
        "assignments": preview["rows"].as_array().unwrap().iter().map(|row| json!({
            "path": row["path"], "sheet": row["sheet"],
            "headerRow": row["detection"]["headerRow"],
            "headerRowsCount": row["detection"]["headerRowsCount"],
            "headers": row["headers"],
            "columns": row["headers"].as_array().unwrap().iter().enumerate().map(|(source, _)|
                json!({"source": source, "target": source, "reason": "按原列顺序"})
            ).collect::<Vec<_>>()
        })).collect::<Vec<_>>()
    })
}

#[test]
fn header_structure_auto_baseline_skips_non_tables_but_explicit_bad_sheet_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let input = root.path().join("混合工作簿.xlsx");
    let mut book = Workbook::new();
    book.add_worksheet().set_name("空页").unwrap();
    let params = book.add_worksheet();
    params.set_name("参数").unwrap();
    for (r, (key, value)) in [
        ("测算期间", "2025-01-01 至 2025-12-31".to_string()),
        ("取数方式", "按确认的口径取原始账户明细并保留各科目发生额，取得余额后逐项复核取数与计算依据，不把说明文字作为业务字段".to_string()),
        ("复核依据", "保留原始凭证及核算说明，所有未明确的参数均需要核对原始资料以后才能确认，避免错误套用其他账户的口径进行计算".to_string()),
    ].iter().enumerate() {
        params.write_string(r as u32,0,*key).unwrap();
        params.write_string(r as u32,1,value).unwrap();
    }
    let data = book.add_worksheet();
    data.set_name("数据").unwrap();
    data.write_string(0,0,"日期").unwrap().write_string(0,1,"金额").unwrap();
    data.write_string(1,0,"2025-01-01").unwrap().write_number(1,1,10).unwrap();
    book.save(&input).unwrap();
    let preview = match_preview(&json!({"inputPaths":[input],"sheetAction":"merge_all"})).unwrap();
    assert_eq!(preview["template"]["sheet"],"数据");
    assert_eq!(preview["rows"][0]["detection"]["kind"],"empty");
    assert_eq!(preview["rows"][1]["detection"]["kind"],"key_value");
    assert_eq!(match_preview(&json!({"inputPaths":[input],"sheetAction":"merge_all","templateSheet":"参数"})).unwrap_err().code,"HEADER_TEMPLATE_UNREADABLE");
}

#[test]
#[ignore = "需指定 HEADER_STRUCTURE_NATIVE_ROOT，核对用户三份原件的每张工作表与两种实际导出"]
fn header_structure_user_three_workbooks_all_sheets_and_raw_export() {
    let root = PathBuf::from(std::env::var("HEADER_STRUCTURE_NATIVE_ROOT").unwrap());
    let inputs = ["FA_TBJE_20261020_201129.xlsx", "存款利息收入测算_20261020_200843.xlsx", "20251231科目余额表.xlsx"].map(|n| root.join(n));
    let preview = match_preview(&json!({"inputPaths": inputs, "sheetAction":"merge_all"})).unwrap();
    assert_eq!(preview["template"]["detection"]["headerRow"], 0);
    assert_eq!(preview["template"]["detection"]["headerRowsCount"], 2);
    let rows = preview["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 13);
    for row in rows {
        let sheet = row["sheet"].as_str().unwrap();
        match sheet {
            "固定资产汇总变动表" => {
                assert_eq!(row["detection"]["headerRowsCount"], 2);
                assert_eq!(row["headers"][2], "合计-计算");
                assert_eq!(row["preview"][0][0], "原值");
            },
            "参数与口径" => {
                assert_eq!(row["detection"]["kind"], "key_value");
                assert_eq!(row["detection"]["headerRowsCount"], 0);
                assert_eq!(row["preview"][0][0], "测算期间");
                assert!(row["matches"].as_array().unwrap().iter().all(|m| m["target"].is_null()));
            },
            "Sheet2" => {
                assert_eq!(row["detection"]["kind"], "empty");
                assert_eq!(row["headers"].as_array().unwrap().len(), 0);
                assert_eq!(row["detection"]["needsReview"], false);
            },
            "Sheet1" => {
                assert_eq!(row["detection"]["headerRowsCount"], 2);
                assert_eq!(row["headers"][4], "期初余额-借方");
                assert_eq!(row["headers"][11], "期末余额-贷方");
            },
            _ => assert_eq!(row["detection"]["headerRowsCount"], 1, "{sheet}"),
        }
        assert_eq!(row["detection"]["headerRow"], 0, "{sheet}");
        if !matches!(sheet, "Sheet2" | "参数与口径") {
            let path = PathBuf::from(row["path"].as_str().unwrap());
            let source = crate::fx::SourceSpec { input_path: path.to_string_lossy().into_owned(), sheet: sheet.into(), header_row: 0, header_depth: 0 };
            let regular = crate::fx::load_fx_table(&source).unwrap();
            let bounded = crate::fx::load_fx_bounded_inspection(&source, &path).unwrap();
            assert_eq!((regular.header_row,regular.header_depth),(1,row["detection"]["headerRowsCount"].as_u64().unwrap() as usize), "{sheet}");
            assert_eq!((bounded.header_row,bounded.header_depth),(regular.header_row,regular.header_depth), "{sheet}");
            assert_eq!(bounded.headers,regular.headers,"{sheet}");
        }
    }
    let mut plan = preview_position_plan(&preview);
    let width = rows.iter().map(|r| r["headers"].as_array().unwrap().len()).max().unwrap();
    let headers = plan["templateHeaders"].as_array_mut().unwrap();
    while headers.len() < width { headers.push(json!(format!("列{}",headers.len()+1))); }
    let output = tempfile::tempdir().unwrap();
    let mut exported = Vec::new();
    for format in ["csv", "xlsx"] {
        let path = output.path().join(format!("three.{format}"));
        let mut params = base_params(&inputs, &path);
        params["outputFormat"] = json!(format);
        params["headerMatching"] = plan.clone();
        params["sheetAction"] = json!("merge_all");
        test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
        let actual = if format == "csv" { crate::spreadsheet_input::read_rows(&path).unwrap() } else { read_merged_sheet(&path, "Merged") };
        let mut expected = Vec::new();
        for row in rows {
            let path = PathBuf::from(row["path"].as_str().unwrap());
            let sheet = row["sheet"].as_str().unwrap();
            let mut book = open_workbook_auto(&path).unwrap();
            let all = display_rows(&physical_cell_rows(&book.worksheet_range(sheet).unwrap(), None));
            let skip = row["detection"]["headerRow"].as_u64().unwrap() as usize + row["detection"]["headerRowsCount"].as_u64().unwrap() as usize;
            expected.extend(all.into_iter().skip(skip).filter(|r| r.iter().any(|v| !v.is_empty())));
        }
        assert_eq!(actual.len(),expected.len()+1,"{format}");
        for (got,want) in actual.iter().skip(1).zip(expected) {
            assert_eq!(&got[2..2+want.len()],want,"{format}");
        }
        exported.push(json!({"format":format,"bodyRows":actual.len()-1,"allRowsPreserved":true}));
    }
    if let Ok(path) = std::env::var("HEADER_STRUCTURE_REPORT") {
        let sheets = rows.iter().map(|row| json!({"file":file_name(Path::new(row["path"].as_str().unwrap())),"sheet":row["sheet"],"detection":row["detection"],"headers":row["headers"]})).collect::<Vec<_>>();
        fs::write(path,serde_json::to_vec_pretty(&json!({"sheets":sheets,"exports":exported})).unwrap()).unwrap();
    }
}

#[test]
fn header_regression_text_xls_snapshot_checks_selected_row_and_still_rejects_changes() {
    let root = std::env::temp_dir().join(format!("merge-header-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    // GBK 文本伪装 XLS；实际表头在第 3 行，空白物理记录必须保留。
    let input = root.join("序时账2026.9.xls");
    let text = "公司序时账\r\n\r\n日期,凭证号,摘要,借方金额,贷方金额\r\n2026-09-01,记-001,期初余额,558.75,0\r\n2026-09-02,记-002,采购,0,558.75\r\n";
    fs::write(&input, GBK.encode(text).0.as_ref()).unwrap();
    let preview = match_preview(&json!({"inputPaths": [input]})).unwrap();
    assert_eq!(preview["template"]["detection"]["headerRow"], 2);
    assert_eq!(preview["template"]["detection"]["headerRowsCount"], 1);
    for format in ["xlsx", "csv"] {
        let output = root.join(format!("out.{format}"));
        let mut params = base_params(&[input.clone()], &output);
        params["outputFormat"] = json!(format);
        params["headerMatching"] = preview_position_plan(&preview);
        test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
        let rows = if format == "xlsx" { read_merged_sheet(&output, "Merged") }
            else { crate::spreadsheet_input::read_rows(&output).unwrap() };
        assert_eq!(rows.len(), 3);
        assert_eq!(&rows[1][2..], &["2026-09-01", "记-001", "期初余额", "558.75", "0"]);
    }
    fs::write(&input, GBK.encode(&text.replace("借方金额", "原币金额")).0.as_ref()).unwrap();
    let output = root.join("changed.xlsx");
    let mut params = base_params(&[input], &output);
    params["headerMatching"] = preview_position_plan(&preview);
    let err = test_merge(params, Arc::new(AtomicBool::new(false))).unwrap_err();
    assert_eq!(err.code, "HEADER_PLAN_STALE");
    assert!(!output.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn header_regression_physical_offsets_empty_labels_merged_groups_and_first_data_survive() {
    let root = std::env::temp_dir().join(format!("merge-header-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    for case in 0..5 {
        let input = root.join(format!("case{case}.xlsx"));
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        let (row, col, depth) = match case {
            0 => (3u32, 0u16, 1), // 顶部空行
            1 => (2, 2, 1),      // 顶部空行＋左侧空列
            2 => (0, 0, 1),      // 中间及末尾空表头，正文有值
            3 => (1, 0, 2),      // 整行合并标题＋横向分组
            _ => (0, 0, 2),      // 纵向身份列＋横向金额分组
        };
        let headers = ["日期", "凭证号", "摘要", "借方金额", "贷方金额", "备注"];
        if case >= 3 {
            if case == 3 { sheet.merge_range(0, 0, 0, 5, "序时账", &Format::new()).unwrap(); }
            sheet.merge_range(row, 0, row + 1, 0, "日期", &Format::new()).unwrap();
            sheet.merge_range(row, 1, row + 1, 1, "凭证号", &Format::new()).unwrap();
            sheet.merge_range(row, 2, row + 1, 2, "摘要", &Format::new()).unwrap();
            sheet.merge_range(row, 3, row, 4, "金额", &Format::new()).unwrap();
            sheet.write_string(row + 1, 3, "借方").unwrap();
            sheet.write_string(row + 1, 4, "贷方").unwrap();
            sheet.merge_range(row, 5, row + 1, 5, "备注", &Format::new()).unwrap();
        } else {
            for (c, header) in headers.iter().enumerate() {
                if case != 2 || (c != 2 && c != 5) {
                    sheet.write_string(row, col + c as u16, *header).unwrap();
                }
            }
        }
        let data = ["2026-09-01", "记-001", "期初余额", "558.75", "0", "末列数据"];
        for (c, value) in data.iter().enumerate() {
            sheet.write_string(row + depth, col + c as u16, *value).unwrap();
        }
        book.save(&input).unwrap();
        let preview = match_preview(&json!({"inputPaths": [input]})).unwrap();
        assert_eq!(preview["template"]["detection"]["headerRow"], row, "case{case}");
        assert_eq!(preview["template"]["detection"]["headerRowsCount"], depth, "case{case}");
        if case == 2 {
            assert_eq!(preview["template"]["headers"][2], "列3");
            assert_eq!(preview["template"]["headers"][5], "列6");
        }
        for format in ["xlsx", "csv"] {
            let output = root.join(format!("case{case}-out.{format}"));
            let mut params = base_params(&[input.clone()], &output);
            params["outputFormat"] = json!(format);
            params["headerMatching"] = preview_position_plan(&preview);
            test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
            let rows = if format == "xlsx" { read_merged_sheet(&output, "Merged") }
                else { crate::spreadsheet_input::read_rows(&output).unwrap() };
            assert_eq!(rows.len(), 2, "case{case} {format}");
            assert_eq!(&rows[1][2 + col as usize..], data, "case{case} {format}");
        }
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore = "使用 MERGER_HEADER_NATIVE_CASES 指定原件与独立预期，不修改原件"]
fn header_regression_native_special_tbje_preview_and_export() {
    let cases: Value = serde_json::from_slice(&fs::read(std::env::var("MERGER_HEADER_NATIVE_CASES").unwrap()).unwrap()).unwrap();
    let root = PathBuf::from(std::env::var("MERGER_HEADER_NATIVE_OUTPUT").unwrap());
    fs::create_dir_all(&root).unwrap();
    let mut reports = Vec::new();
    for (index, case) in cases.as_array().unwrap().iter().enumerate() {
        let input = PathBuf::from(case["path"].as_str().unwrap());
        let preview = match_preview(&json!({"inputPaths": [input]})).unwrap();
        let detection = &preview["template"]["detection"];
        assert_eq!(detection["headerRow"], case["headerRow"], "{}", input.display());
        assert_eq!(detection["headerRowsCount"], case["headerRowsCount"], "{}", input.display());
        let raw: Vec<Vec<String>> = serde_json::from_value(preview["template"]["rawRows"].clone()).unwrap();
        let shared = crate::fx::infer_public_header_layout(&raw);
        assert_eq!((detection["headerRow"].as_u64().unwrap() as usize + 1,
            detection["headerRowsCount"].as_u64().unwrap() as usize), shared);
        let mut source_book = open_workbook_auto(&input).unwrap();
        let sheet = preview["rows"][0]["sheet"].as_str().unwrap();
        let range = source_book.worksheet_range(sheet).unwrap();
        let all = physical_cell_rows(&range, None);
        let skip = shared.0 - 1 + shared.1;
        let expected = all.iter().skip(skip).filter(|row| row.iter().any(|cell| !cell.display().is_empty()))
            .map(|row| row.iter().map(Cell::display).collect::<Vec<_>>()).collect::<Vec<_>>();
        let mut results = Vec::new();
        for format in ["xlsx", "csv"] {
            let output = root.join(format!("native-{index}.{format}"));
            let mut params = base_params(&[input.clone()], &output);
            params["outputFormat"] = json!(format);
            params["headerMatching"] = preview_position_plan(&preview);
            test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
            let rows = if format == "xlsx" { read_merged_sheet(&output, "Merged") }
                else { crate::spreadsheet_input::read_rows(&output).unwrap() };
            assert_eq!(rows.len(), expected.len() + 1, "{} {format}", input.display());
            assert_eq!(&rows[1][2..], expected[0], "首条正文：{} {format}", input.display());
            assert_eq!(&rows.last().unwrap()[2..], expected.last().unwrap(), "末条正文：{} {format}", input.display());
            for (actual, source) in rows.iter().skip(1).zip(&expected) {
                assert_eq!(&actual[2..], source, "逐行原列数据：{} {format}", input.display());
            }
            results.push(json!({"format": format, "dataRows": expected.len(), "firstAndLastRowPreserved": true}));
        }
        reports.push(json!({"path": input, "label": case["label"], "detection": detection, "sharedPathMatches": true, "exports": results}));
    }
    fs::write(root.join("native-report.json"), serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
}
