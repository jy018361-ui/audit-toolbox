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
