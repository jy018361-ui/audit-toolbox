use super::*;

fn fixture(path: &Path) {
    let mut book = Workbook::new();
    let sheet = book.add_worksheet();
    sheet.set_name("资产").unwrap();
    for (r, row) in [
        ["卡片编号", "账面价值", "账面价值"],
        ["卡片编号", "资产原值", "累计折旧"],
        ["A001", "1000", "200"],
        ["A002", "2000", "400"],
        ["A003", "3000", "600"],
    ].iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            sheet.write_string(r as u32, c as u16, *value).unwrap();
        }
    }
    book.save(path).unwrap();
}

#[test]
fn explicit_header_depth_is_identical_in_full_prefix_cached_and_disk_reads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("资产.xlsx");
    fixture(&path);
    let cancel = AtomicBool::new(false);
    for depth in [1, 2, 1, 2] {
        let options = HeaderOptions { row: Some(1), depth: Some(depth) };
        let full = load_table(&path, Some("资产"), options, false).unwrap();
        assert_eq!(full.header_depth, depth);
        assert_eq!(full.rows.len(), 5 - depth);
        assert_eq!(full.rows[0][0], if depth == 1 { "卡片编号" } else { "A001" });
        let prefix = crate::fa_sheet_pick::load_prefix_table(&path, Some("资产"), options, false).unwrap();
        let cached = crate::fa_table_cache::load_table_cached(&path, Some("资产"), options, false).unwrap();
        let (disk_preview, disk) = disk::load_input(&path, Some("资产"), options, &|_, _, _, _| {}, &cancel).unwrap();
        let mut disk_rows = Vec::new();
        disk.visit(&cancel, |row, _| { disk_rows.push(row.to_vec()); Ok(()) }).unwrap();
        for table in [&prefix, &cached, &disk_preview] {
            assert_eq!(table.header_depth, depth);
            assert_eq!(table.headers, full.headers);
            assert_eq!(table.rows, full.rows);
        }
        assert_eq!(disk_rows, full.rows);
        let reviewed = load_review_table(&path, Some("资产"), options, false).unwrap();
        assert_eq!(reviewed.headers, full.headers);
        assert_eq!(reviewed.rows, full.rows);
    }
}

#[test]
fn header_depth_reaches_inspection_worker_matching_and_snapshot_restore() {
    let dir = tempfile::tempdir().unwrap();
    let begin = dir.path().join("期初.xlsx");
    let end = dir.path().join("期末.xlsx");
    fixture(&begin);
    fixture(&end);
    let mut params = json!({
        "beginPath": begin, "endPath": end, "beginSheet":"资产", "endSheet":"资产",
        "beginHeaderRow":1, "endHeaderRow":1, "beginHeaderDepth":2, "endHeaderDepth":2,
    });
    let inspected = call("fa.inspect", params.clone()).unwrap();
    for side in ["begin", "end"] {
        assert_eq!(inspected[side]["headerDepth"], 2);
        assert_eq!(inspected[side]["preview"][0][0], "A001");
    }
    let key = inspected["begin"]["headers"][0].clone();
    params["beginKeys"] = json!([key]);
    params["endKeys"] = params["beginKeys"].clone();
    params["__forceDisk"] = json!(false);
    for disk in [false, true] {
        params["__forceDisk"] = json!(disk);
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = run_job("fa.match", params.clone(), &|_, _, _, _| {}, cancel, &pause).unwrap();
        assert_eq!(result["stats"]["rows"], 3);
        assert_eq!(result["stats"]["both"], 3);
        let snapshot = crate::fa_merge_snapshot::load(&params).unwrap();
        assert_eq!(snapshot.result.begin.header_depth, 2);
        assert_eq!(snapshot.result.end.header_depth, 2);
        assert!(snapshot.matches_current);
        let mut changed = params.clone();
        changed["beginHeaderDepth"] = json!(1);
        let previous = crate::fa_merge_snapshot::load(&changed).unwrap();
        assert!(!previous.matches_current);
        assert_eq!(previous.effective_params["beginHeaderDepth"], 2);
    }
    let dep = call("fa.dep_inspect", json!({"path":begin,"sheet":"资产","headerRow":1,"headerDepth":2})).unwrap();
    assert_eq!(dep["headerDepth"], 2);
    let supplement = call("fa.supplement_inspect", json!({"path":end,"sheet":"资产","headerRow":1,"headerDepth":2})).unwrap();
    assert_eq!(supplement["headerDepth"], 2);
}

#[test]
fn invalid_header_depth_is_reported_instead_of_silently_ignored() {
    for depth in [json!(3), json!(-1), json!("2")] {
        let err = HeaderOptions::params(&json!({"headerDepth":depth}), "headerRow", "headerDepth").unwrap_err();
        assert_eq!(err.code, "INVALID_PARAMS");
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("短表.csv");
    fs::write(&path, "编号,原值\n").unwrap();
    let err = load_table(&path, None, HeaderOptions { row: Some(1), depth: Some(2) }, false).unwrap_err();
    assert!(err.user_message.contains("表头层数"));
}
