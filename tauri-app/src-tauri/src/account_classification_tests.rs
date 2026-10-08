//! 同码汇总语义必须沿已勾稽的源行关系继承，不能按编码全表扩散。
use crate::{deposit_interest, fx, ledger_mapping, loan_interest};
use serde_json::{Value, json};

const HEADERS: [&str; 6] = ["科目代码", "科目名称", "主体", "币种", "期初余额", "期末余额"];

pub(crate) fn mapping() -> Value {
    json!({"accountCode":"科目代码", "accountName":"科目名称", "entity":"主体",
        "currency":"币种", "openingFunctionalAmount":"期初余额", "closingFunctionalAmount":"期末余额"})
}

pub(crate) fn rows() -> Vec<Vec<String>> {
    [
        ["2001", "短期借款", "A", "CNY", "-300", "-300"],
        ["2001", "甲银行", "A", "CNY", "-100", "-100"],
        ["2001", "乙银行", "A", "CNY", "-200", "-200"],
        ["2001", "应付利息", "B", "CNY", "-30", "-30"],
        ["2001", "甲银行", "B", "CNY", "-10", "-10"],
        ["2001", "乙银行", "B", "CNY", "-20", "-20"],
        ["1999", "银行存款", "A", "CNY", "300", "300"],
        ["1999", "甲户", "A", "CNY", "100", "100"],
        ["1999", "乙户", "A", "CNY", "200", "200"],
        ["1998", "存货-原材料", "A", "CNY", "300", "300"],
        ["1998", "甲户", "A", "CNY", "100", "100"],
        ["1998", "乙户", "A", "CNY", "200", "200"],
        // 没有可勾稽汇总的平行同码、跨主体/币种行不能继承任何前面名称。
        ["1999", "丙户", "B", "CNY", "17", "19"],
        ["1999", "丁户", "A", "USD", "17", "19"],
        ["2503", "租赁负债", "A", "CNY", "-300", "-300"],
        ["2503", "甲合同", "A", "CNY", "-100", "-100"],
        ["2503", "乙合同", "A", "CNY", "-200", "-200"],
        ["660302", "财务费用-借款利息", "A", "CNY", "300", "300"],
        ["660302", "甲机构", "A", "CNY", "100", "100"],
        ["660302", "乙机构", "A", "CNY", "200", "200"],
        ["660310", "财务费用-租赁利息", "A", "CNY", "300", "300"],
        ["660310", "甲机构", "A", "CNY", "100", "100"],
        ["660310", "乙机构", "A", "CNY", "200", "200"],
    ].into_iter().map(|row| row.into_iter().map(str::to_owned).collect()).collect()
}

fn columns(role: &str) -> Vec<String> {
    mapping()[role].as_str().map(|value| vec![value.to_owned()]).unwrap_or_default()
}

pub(crate) fn fixture(rows: &[Vec<String>]) -> (tempfile::TempDir, Value) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("科目.xlsx");
    let mut book = rust_xlsxwriter::Workbook::new();
    let sheet = book.add_worksheet();
    for (column, header) in HEADERS.iter().enumerate() {
        sheet.write_string(0, column as u16, *header).unwrap();
    }
    for (index, row) in rows.iter().enumerate() {
        for (column, value) in row.iter().enumerate() {
            sheet.write_string(index as u32 + 1, column as u16, value).unwrap();
        }
    }
    book.save(&path).unwrap();
    (dir, json!({"inputPath":path,"sheet":"Sheet1","headerRow":1,"headerDepth":1}))
}

#[test]
fn 同码分类语义只沿完整勾稽关系继承且不改变末级掩码() {
    let headers = HEADERS.map(str::to_owned);
    let rows = rows();
    let analysis = ledger_mapping::tb_catalog_classification_analysis(&headers, &rows, &columns);
    assert_eq!(analysis.keep, ledger_mapping::tb_catalog_leaf_mask(&headers, &rows, &columns));
    assert!(!analysis.keep[0]);
    assert_eq!(analysis.contexts[1], "短期借款");
    assert_eq!(analysis.parent_names[1], "短期借款");
    assert_eq!(analysis.parent_names[4], "应付利息");
    assert_eq!(analysis.parent_names[13], "");
    assert_eq!(analysis.contexts[4], "应付利息");
    assert_eq!(analysis.contexts[7], "银行存款");
    assert_eq!(analysis.contexts[10], "存货-原材料");
    assert_eq!(analysis.contexts[12], "");
    assert_eq!(analysis.contexts[13], "");
    // 汇总放在明细之后时仍应按同一已确认关系继承。
    let mut reversed = rows[..3].to_vec();
    reversed.reverse();
    let analysis = ledger_mapping::tb_classification_analysis(&headers, &reversed, &columns);
    assert_eq!(analysis.contexts[..2], ["短期借款", "短期借款"]);
    // 金额不平时不能据同码和相邻位置继承。
    reversed[2][5] = "-301".into();
    assert!(ledger_mapping::tb_classification_analysis(&headers, &reversed, &columns)
        .contexts.iter().all(String::is_empty));
}

#[test]
fn 同码分类借款和利息继承并保留租赁应付利息排除() {
    let (_dir, source) = fixture(&rows());
    let result = loan_interest::call("loan.tb_accounts", json!({"tbSource":{"source":source,"mapping":mapping()}})).unwrap();
    let accounts = result["accounts"].as_array().unwrap();
    // 同码同名跨主体时既有目录会合并身份；冲突语义保持保守排除。
    assert!(accounts.iter().filter(|row| row["code"] == "2001").all(|row| row["suggestedType"] == "skip"));
    assert!(accounts.iter().filter(|row| row["code"] == "2503").all(|row| row["suggestedType"] == "skip"));
    assert!(accounts.iter().filter(|row| row["code"] == "660302").all(|row| row["suggestedType"] == "interest_expense"));
    assert!(accounts.iter().filter(|row| row["code"] == "660310").all(|row| row["suggestedType"] == "skip"));
    let (_dir, source) = fixture(&rows()[..3]);
    let result = loan_interest::call("loan.tb_accounts", json!({"tbSource":{"source":source,"mapping":mapping()}})).unwrap();
    assert_eq!(result["accounts"].as_array().unwrap().len(), 2);
    assert!(result["accounts"].as_array().unwrap().iter().all(|row| row["suggestedType"] == "loan"));
}

#[test]
fn 同码分类最近编码上级只补展示且主体币种歧义不传播() {
    let headers = HEADERS.map(str::to_owned);
    let rows: Vec<Vec<String>> = [
        ["2001", "短期借款", "A", "CNY", "-500", "-500"],
        ["200101", "一年内到期", "A", "CNY", "-300", "-300"],
        ["20010101", "甲银行", "A", "CNY", "-100", "-100"],
        ["20010102", "乙银行", "A", "CNY", "-200", "-200"],
        ["20010101", "甲银行", "B", "CNY", "-10", "-10"],
        ["20010101", "甲银行", "A", "USD", "-10", "-10"],
    ].into_iter().map(|row| row.into_iter().map(str::to_owned).collect()).collect();
    let analysis = ledger_mapping::tb_classification_analysis(&headers, &rows, &columns);
    assert_eq!(analysis.parent_names[2], "一年内到期");
    assert_eq!(analysis.parent_names[1], "短期借款");
    assert_eq!(analysis.parent_names[4], "");
    assert_eq!(analysis.parent_names[5], "");
    assert!(analysis.contexts.iter().all(String::is_empty));
    assert_eq!(analysis.keep, ledger_mapping::tb_leaf_mask(&headers, &rows, &columns));
}

#[test]
fn 同码分类存款汇兑确认与计算共用语义且保留原始身份() {
    let (_dir, source) = fixture(&rows());
    let inspected = deposit_interest::call("deposit.inspect_tb", json!({"source":source,"mapping":mapping()})).unwrap();
    let review = inspected["reviewAccounts"].as_array().unwrap();
    let cash = review.iter().find(|row| row["account"] == "1999 甲户").unwrap();
    assert_eq!(cash["classificationContext"], "银行存款");
    assert_eq!(cash["parentAccountName"], "银行存款");
    assert_eq!(cash["suggestedDepositRole"], "deposit");
    assert_eq!(cash["suggestedFxRole"], "cash");
    let stock = review.iter().find(|row| row["account"] == "1998 甲户").unwrap();
    assert_eq!(stock["suggestedFxRole"], "non_monetary");
    assert_eq!(inspected["suggestedAccountRoles"]["1999 甲户"], "deposit");
    let fx_inspected = fx::call("fx.inspect_tb", json!({"source":source})).unwrap();
    assert_eq!(fx_inspected["accountRoleSuggestions"]["1999 甲户"], "cash");
    assert_eq!(fx_inspected["accountRoleSuggestions"]["1998 甲户"], "non_monetary");
    let params = json!({"tbSource":source,"tbMapping":mapping(),"reportStart":"2025-01-01","reportEnd":"2025-12-31"});
    let result = crate::engine_call_for_test("deposit.preview_probe", params.clone()).unwrap();
    assert!(result["rows"].as_array().unwrap().iter().any(|row| row["account"] == "1999 甲户"));
    let mut params = params;
    // 单侧 TB 测算没有启用主体匹配键，确认表使用空主体行键。
    params["accountReviewRoles"] = json!({"[\"\",\"1999 甲户\",\"\",\"CNY\"]":"excluded"});
    let result = crate::engine_call_for_test("deposit.preview_probe", params).unwrap();
    assert!(!result["rows"].as_array().unwrap().iter().any(|row| row["account"] == "1999 甲户"));
    assert!(result["rows"].as_array().unwrap().iter().any(|row| row["account"] == "1999 乙户"));
}

#[test]
#[ignore = "需 LEDGER_SAMPLES 指向原始 TBJEPBC 目录"]
fn 同码分类真实01借款五户与05租赁排除验收() {
    let root = std::path::PathBuf::from(std::env::var("LEDGER_SAMPLES").unwrap());
    for (file, loans, interests) in [("01科目余额表（TB）.xls", 5, 1), ("05科目余额表.XLSX", 0, 0)] {
        let inspected = loan_interest::call("loan.inspect", json!({"kind":"tb","source":{"inputPath":root.join(file)}})).unwrap();
        let result = loan_interest::call("loan.tb_accounts", json!({"tbSource":{
            "source":{"inputPath":root.join(file),"sheet":inspected["sheet"],"headerRow":inspected["headerRow"],"headerDepth":inspected["headerDepth"]},
            "mapping":inspected["suggestedMapping"]}})).unwrap();
        let rows = result["accounts"].as_array().unwrap();
        assert_eq!(rows.iter().filter(|row| row["suggestedType"] == "loan").count(), loans, "{file}");
        assert_eq!(rows.iter().filter(|row| row["suggestedType"] == "interest_expense").count(), interests, "{file}");
        if loans > 0 {
            let total = |field| rows.iter().filter(|row| row["suggestedType"] == "loan")
                .map(|row| row[field].as_f64().unwrap()).sum::<f64>();
            assert!((total("opening") - 68_700_000.0).abs() < 0.005);
            assert!((total("closing") - 87_363_652.32).abs() < 0.005);
        }
    }
}
