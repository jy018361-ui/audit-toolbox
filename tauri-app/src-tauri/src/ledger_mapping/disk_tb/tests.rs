use super::*;
fn headers() -> Vec<String> {
    [
        "主体",
        "科目编码",
        "科目名称",
        "辅助",
        "币种",
        "级次",
        "期初本位币余额",
        "期末本位币余额",
        "本年累计借方",
        "本年累计贷方",
        "方向",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
fn columns(role: &str) -> Vec<String> {
    let name = match role {
        "entity" => "主体",
        "accountCode" => "科目编码",
        "accountName" => "科目名称",
        "auxiliary" => "辅助",
        "currency" => "币种",
        "openingFunctionalAmount" => "期初本位币余额",
        "closingFunctionalAmount" => "期末本位币余额",
        "ytdFunctionalDebit" => "本年累计借方",
        "ytdFunctionalCredit" => "本年累计贷方",
        "direction" => "方向",
        _ => return vec![],
    };
    vec![name.into()]
}
fn row(
    entity: &str,
    code: &str,
    name: &str,
    aux: &str,
    currency: &str,
    level: &str,
    opening: f64,
    closing: f64,
    debit: f64,
    credit: f64,
    direction: &str,
) -> Vec<String> {
    vec![
        entity.into(),
        code.into(),
        name.into(),
        aux.into(),
        currency.into(),
        level.into(),
        opening.to_string(),
        closing.to_string(),
        debit.to_string(),
        credit.to_string(),
        direction.into(),
    ]
}
fn compare(rows: &[Vec<String>], case: &str) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("TB.csv");
    let headers = headers();
    let mut writer = csv::Writer::from_path(&path).unwrap();
    writer.write_record(&headers).unwrap();
    for r in rows {
        writer.write_record(r).unwrap();
    }
    writer.flush().unwrap();
    let cancel = AtomicBool::new(false);
    let source = DiskTable::open(&path, None, 1, 1, &|_, _, _, _| {}, &cancel).unwrap();
    let a = tb_classification_analysis(&headers, rows, &columns);
    let b = analyze(&source, &columns, true, &|_, _, _, _| {}, &cancel)
        .unwrap()
        .analysis;
    assert_eq!(b.keep, a.keep, "mask {case}");
    assert_eq!(b.contexts, a.contexts, "context {case}");
    assert_eq!(b.parent_names, a.parent_names, "parent {case}");
}
#[test]
fn tb_disk_cross_organization_totals_match_memory_after_local_selection() {
    compare(&[
        row("", "1002", "银行", "", "CNY", "1",30.,120.,100.,10.,"借"),
        row("A", "1002", "银行", "", "CNY", "1",10.,45.,40.,5.,"借"),
        row("B", "1002", "银行", "", "CNY", "1",20.,75.,60.,5.,"借"),
    ],"跨组织完整金额层");
}
#[test]
fn tb_disk_global_rules_keep_original_order_and_classification() {
    let r = |e, c, n, a, cur, l, o, cl, d, cr, dir| row(e, c, n, a, cur, l, o, cl, d, cr, dir);
    let cases = vec![
        vec![
            r(
                "A", "1001", "现金", "", "CNY", "1", 100., 120., 20., 0., "借",
            ),
            r(
                "B", "1001", "现金", "", "CNY", "1", 300., 350., 50., 0., "借",
            ),
            r(
                "A", "100101", "现金1", "", "CNY", "2", 100., 120., 20., 0., "借",
            ),
            r(
                "B", "100101", "现金1", "", "CNY", "2", 300., 350., 50., 0., "借",
            ),
        ],
        vec![
            r(
                "A",
                "1121",
                "应收账款",
                "",
                "CNY",
                "1",
                100.,
                120.,
                20.,
                0.,
                "借",
            ),
            r(
                "A",
                "1121",
                "客户甲",
                "甲",
                "CNY",
                "1",
                40.,
                50.,
                10.,
                0.,
                "借",
            ),
            r(
                "A",
                "1121",
                "客户乙",
                "乙",
                "CNY",
                "1",
                60.,
                70.,
                10.,
                0.,
                "借",
            ),
            r(
                "B",
                "1121",
                "应收账款",
                "",
                "CNY",
                "1",
                10.,
                12.,
                2.,
                0.,
                "借",
            ),
            r(
                "B",
                "1121",
                "客户丙",
                "丙",
                "CNY",
                "1",
                10.,
                12.,
                2.,
                0.,
                "借",
            ),
        ],
        vec![
            r(
                "A",
                "1002",
                "银行存款",
                "",
                "综合本位币",
                "1",
                100.,
                120.,
                20.,
                0.,
                "借",
            ),
            r(
                "A",
                "1002",
                "银行存款",
                "",
                "CNY",
                "1",
                40.,
                50.,
                10.,
                0.,
                "借",
            ),
            r(
                "A",
                "1002",
                "银行存款",
                "",
                "USD",
                "1",
                60.,
                70.,
                10.,
                0.,
                "借",
            ),
            r(
                "B",
                "100201",
                "银行存款1",
                "",
                "CNY",
                "1",
                10.,
                12.,
                2.,
                0.,
                "借",
            ),
        ],
        vec![
            r(
                "A", "2001", "借款", "", "CNY", "1", 100., 120., 0., 20., "贷",
            ),
            r(
                "A", "200101", "借款1", "", "CNY", "2", 100., 120., 0., 20., "贷",
            ),
            r(
                "B", "2001", "借款", "", "CNY", "1", -100., -120., 0., -20., "贷",
            ),
            r(
                "B", "200101", "借款1", "", "CNY", "2", -100., -120., 0., -20., "贷",
            ),
            r(
                "B", "200102", "借款2", "", "CNY", "2", -100., -120., 0., -20., "贷",
            ),
        ],
        vec![
            r("A", "1001", "现金", "", "CNY", "1", 0., 0., 0., 0., "借"),
            r("B", "合计", "合计", "", "CNY", "1", 0., 0., 0., 0., "借"),
            r(
                "A",
                "1001",
                "现金",
                "客户甲",
                "CNY",
                "1",
                10.,
                20.,
                10.,
                0.,
                "借",
            ),
            r(
                "A",
                "1001",
                "现金",
                "客户乙",
                "CNY",
                "1",
                30.,
                40.,
                10.,
                0.,
                "借",
            ),
        ],
    ];
    for (i, rows) in cases.iter().enumerate() {
        compare(rows, &format!("case{i}"));
        let mut reverse = rows.clone();
        reverse.reverse();
        compare(&reverse, &format!("reverse{i}"));
    }
}
#[test]
fn tb_disk_random_interleaved_entities_matches_memory() {
    let mut seed = 17u64;
    for case in 0..24 {
        let mut rows = Vec::new();
        for i in 0..24 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let n = ((seed >> 32) % 5) as f64;
            let e = if seed % 3 == 0 { "A" } else { "B" };
            let code = match (seed >> 8) % 6 {
                0 => "1001",
                1 => "100101",
                2 => "100102",
                3 => "2001",
                4 => "200101",
                _ => "",
            };
            let name = match (seed >> 16) % 4 {
                0 => "现金",
                1 => "客户甲",
                2 => "客户乙",
                _ => "其他",
            };
            rows.push(row(
                e,
                code,
                name,
                if i % 2 == 0 { "甲" } else { "" },
                if i % 5 == 0 { "USD" } else { "CNY" },
                if code.len() > 4 { "2" } else { "1" },
                n * 10.,
                n * 11.,
                n,
                0.,
                "借",
            ));
        }
        compare(&rows, &format!("random{case}"));
    }
}
#[test]
fn tb_disk_whole_group_ignores_estimated_cap_and_keeps_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("预算.csv");
    let mut w = csv::Writer::from_path(&path).unwrap();
    w.write_record(headers()).unwrap();
    w.write_record(row(
        "A", "1001", "现金", "", "CNY", "1", 1., 2., 1., 0., "借",
    ))
    .unwrap();
    w.flush().unwrap();
    let cancel = AtomicBool::new(false);
    let source = DiskTable::open(&path, None, 1, 1, &|_, _, _, _| {}, &cancel).unwrap();
    let result = analyze_with_limit(&source, &columns, true, &|_, _, _, _| {}, &cancel, Some(1)).unwrap();
    assert_eq!(result.analysis.keep, vec![true]);
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(
        analyze(&source, &columns, true, &|_, _, _, _| {}, &cancel)
            .err()
            .unwrap()
            .code,
        "JOB_CANCELLED"
    );
}

#[test]
fn tb_disk_dimension_slices_do_not_depend_on_period_columns() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("TB.csv");
    let mut h = headers();
    h.push("无关字段".into());
    let mut rows = vec![];
    for amount in [35310., 15510., 19800.] {
        let mut r = row("E", "5500010104", "伙食补贴", &format!("部门{amount}"), "CNY", "4", 0., amount, amount, 0., "借");
        r.push("任意内容".into());
        rows.push(r);
    }
    let cols = columns;
    let mut writer = csv::Writer::from_path(&path).unwrap();
    writer.write_record(&h).unwrap();
    for r in &rows { writer.write_record(r).unwrap(); }
    writer.flush().unwrap();
    let cancel = AtomicBool::new(false);
    let source = DiskTable::open(&path, None, 1, 1, &|_,_,_,_| {}, &cancel).unwrap();
    let disk = analyze(&source, &cols, true, &|_,_,_,_| {}, &cancel).unwrap();
    assert_eq!(disk.analysis.keep, vec![true;3]);
    assert_eq!(disk.analysis.keep, tb_leaf_mask(&h, &rows, &cols));
}
