use super::*;
use std::sync::atomic::AtomicBool;

fn headers() -> Vec<String> { ["日期", "凭证号", "科目编码", "科目名称", "借方", "贷方", "摘要"].map(str::to_owned).to_vec() }
fn columns(role: &str) -> Vec<String> {
    match role {
        "date" => vec!["日期".into()], "id" => vec!["凭证号".into()],
        "accountCode" => vec!["科目编码".into()], "accountName" => vec!["科目名称".into()],
        "functionalDebit" => vec!["借方".into()], "functionalCredit" => vec!["贷方".into()],
        "summary" => vec!["摘要".into()], _ => vec![],
    }
}
fn rows() -> Vec<Vec<String>> {
    [
        ["2025-01-01", "记1", "1002", "银行存款", "100", "", "支付合计费用"],
        ["2025-01-01", "记1", "", "", "", "100", ""],
        ["", "记1", "", "", "10", "", ""],
        ["2025-01-01", "", "", "", "20", "", ""],
        ["2025-01-01", "记1", "", "", "", "", ""],
        ["合计", "记1", "", "", "130", "100", ""],
        ["2025-01-02", "记2", "1601", "", "30", "", ""],
    ].into_iter().map(|r| r.map(str::to_owned).to_vec()).collect()
}

#[test]
fn continuation_requires_original_date_and_id_and_amount() {
    let h = headers(); let r = rows(); let rule = LedgerBodyRule::new(&h, &columns);
    assert!(rule.can_fill_account(&r[1]));
    for i in 2..=5 { assert!(!rule.can_fill_account(&r[i]), "row {i}"); }
    let keep = ledger_fill_mask(&h, &r, &columns);
    assert_eq!(keep, vec![true, true, false, false, false, false, true]);
    let mut filled = r.clone();
    let fill = ["date", "id", "accountCode", "accountName", "summary"].into_iter().flat_map(columns).collect::<Vec<_>>();
    let accounts = ["科目编码".into(), "科目名称".into()];
    forward_fill_ledger_identity_columns_skipping(&h, &mut filled, &fill, &accounts, &keep);
    assert_eq!(filled[1][2], "1002");
    assert_eq!(filled[1][3], "银行存款");
    assert_eq!(filled[5], r[5], "合计不接收或传播身份");
    assert_eq!(filled[6][3], "", "新编码不继承上一名称");
    assert_eq!(ledger_post_fill_body_mask(&h, &filled, &columns), keep);
    let mut zero = r[1].clone(); zero[5] = "0".into();
    assert!(rule.can_fill_account(&zero), "零金额可解析，不等于缺金额");
    let mut invalid = r[1].clone(); invalid[0] = "2025-02-30".into();
    assert!(!rule.can_fill_account(&invalid));
}

#[test]
fn manual_auxiliary_does_not_get_repaired_or_removed_on_domain_mismatch() {
    let h = vec!["编码".into(), "核算维度编码".into()];
    let r = vec![vec!["1002".into(), "BANK-A".into()]];
    let mut tb = serde_json::json!({"auxiliary":"核算维度编码","__manualAuxiliary":"{\"auxiliary\":[\"核算维度编码\"]}"}).as_object().unwrap().clone();
    let mut je = serde_json::json!({"auxiliary":"核算维度编码"}).as_object().unwrap().clone();
    let before = tb.clone();
    reconcile_key_domains("auxiliary", &h, &r, &mut tb, &h, &[vec!["1002".into(),"UNRELATED".into()]], &mut je);
    assert_eq!(tb, before);
    tb.remove("__manualAuxiliary");
    assert!(!has_manual_auxiliary_mapping(&tb, "auxiliary"));
}

#[test]
fn continuation_disk_and_memory_have_same_business_rows() {
    let dir = std::env::temp_dir().join(format!("continuation-and-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap(); let path = dir.join("source.csv");
    let mut writer = csv::Writer::from_path(&path).unwrap();
    writer.write_record(headers()).unwrap(); for r in rows() { writer.write_record(r).unwrap(); } writer.flush().unwrap(); drop(writer);
    let mapping = serde_json::json!({"date":"日期","id":["凭证号"],"accountCode":"科目编码","accountName":["科目名称"],"functionalDebit":"借方","functionalCredit":"贷方","summary":"摘要","__signConvention":"unsigned"}).as_object().unwrap().clone();
    let cancel = AtomicBool::new(false);
    let ledger = crate::tabular::open_prepared_disk_ledger_with_sheet(&path, Some("CSV"), 1, 1, &mapping, &|_,_,_,_| {}, &cancel).unwrap();
    let mut actual = Vec::new(); ledger.visit(false, &cancel, |row| { actual.push((row.values[2].clone(),row.values[3].clone(),row.debit,row.credit)); Ok(()) }).unwrap();
    assert_eq!(actual, vec![("1002".into(),"银行存款".into(),100.,0.),("1002".into(),"银行存款".into(),0.,100.),("1601".into(),"".into(),30.,0.)]);
    drop(ledger); std::fs::remove_dir_all(dir).unwrap();
}
