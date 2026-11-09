//! Independent acceptance of the confirmation path against every supplied ledger.
use super::*;

#[test]
fn 确认验收_人工映射原始零金额不被本金或建议列覆盖() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("台账.csv");
    fs::write(&path,"合同编号,借款本金,起始日,到期日,年利率,期初余额,人工年初,新增金额,还款金额,期末余额\n甲,20000000,2025-04-01,2027-03-31,4%,999,0,10000000,2000000,8000000\n").unwrap();
    let p = json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31",
      "ledgerSource":{"source":{"inputPath":path,"headerRow":1,"headerDepth":1,"sheet":""},
      "mapping":{"loanId":"合同编号","principal":"借款本金","startDate":"起始日","endDate":"到期日","rate":"年利率",
      "openingPrincipal":"人工年初","drawdownAmount":"新增金额","repaymentAmount":"还款金额","closingPrincipal":"期末余额"}}});
    let result = prepare_rates(&p).unwrap();
    let row = &result["rows"][0];
    assert_eq!(
        row["opening"], 0.0,
        "显式PBC零不能被合同额或系统建议的期初余额999覆盖"
    );
    assert_eq!(row["added"], 10000000.0);
    assert_eq!(row["reduced"], 2000000.0);
    assert_eq!(row["closing"], 8000000.0);
    for field in ["opening", "added", "reduced", "closing"] {
        assert_eq!(row["amountSources"][field], "PBC");
    }
    assert_eq!(row["repayments"][0]["date"], "2025-12-31");
}

#[test]
fn 确认验收_完整四栏逐格与客户文件原始金额一致() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/借款台账测试集");
    let answers: Value =
        serde_json::from_str(&fs::read_to_string(root.join("标准答案.json")).unwrap()).unwrap();
    let mut checked = 0;
    for spec in answers["files"].as_array().unwrap().iter().filter(|s| {
        s["file"].as_str().unwrap().starts_with("15-")
            || s["file"].as_str().unwrap().starts_with("17-")
    }) {
        let path = root.join(spec["file"].as_str().unwrap());
        let mut book = open_workbook_auto(&path).unwrap();
        let sheet = book.sheet_names()[0].clone();
        let range = book.worksheet_range(&sheet).unwrap();
        let raw: Vec<_> = range.rows().collect();
        let headers = raw[0].iter().map(ToString::to_string).collect::<Vec<_>>();
        let at = |role: &str| {
            headers
                .iter()
                .position(|h| h == spec["mapping"][role].as_str().unwrap())
                .unwrap()
        };
        let p = json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31",
            "ledgerSource":{"source":{"inputPath":path,"sheet":sheet,"headerRow":1,"headerDepth":1},"mapping":spec["mapping"]}});
        let prepared = prepare_rates(&p).unwrap();
        for v in prepared["rows"].as_array().unwrap() {
            let customer = raw
                .iter()
                .skip(1)
                .find(|cells| cells[at("loanId")].to_string() == v["loanId"].as_str().unwrap())
                .unwrap();
            for (field, role) in [
                ("opening", "openingPrincipal"),
                ("added", "drawdownAmount"),
                ("reduced", "repaymentAmount"),
                ("closing", "closingPrincipal"),
            ] {
                let expected = parse_num(&customer[at(role)].to_string());
                assert_eq!(v["amountSources"][field], "PBC");
                assert!(
                    (v[field].as_f64().unwrap_or(0.0) - expected).abs() < 0.005,
                    "{} {} PBC金额与原文件不符",
                    v["loanId"],
                    field
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 100);
}

#[test]
fn 确认验收_空白期末平衡与完全空事件可确认但半填不行() {
    let mut row = LoanRow {
        row_key: "甲".into(),
        loan_id: "甲".into(),
        ..Default::default()
    };
    let mut p = json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31",
      "ledgerInformation":{"甲":{"opening":200.0,"added":0.0,"reduced":200.0,"closing":null,"rateType":"fixed","fixedRate":0.04,"spreadBps":0,
      "additions":[{"date":"","amount":null}],"repayments":[{"date":"2025-06-01","amount":200.0}]}}});
    apply_ledger_confirmation(std::slice::from_mut(&mut row), &p).unwrap();
    assert_eq!(row.closing_principal, 0.0);
    p["ledgerInformation"]["甲"]["opening"] = json!(300.0);
    assert_eq!(
        apply_ledger_confirmation(std::slice::from_mut(&mut row), &p)
            .unwrap_err()
            .code,
        "LOAN_BALANCE_MISMATCH"
    );
    p["ledgerInformation"]["甲"]["opening"] = json!(200.0);
    p["ledgerInformation"]["甲"]["additions"][0]["amount"] = json!(100.0);
    assert_eq!(
        apply_ledger_confirmation(std::slice::from_mut(&mut row), &p)
            .unwrap_err()
            .code,
        "LOAN_EVENT_DATE_INVALID"
    );
}

#[test]
fn 确认验收_无合同日期默认事件明确说明截止日来源() {
    let row = LoanRow {
        row_key: "甲".into(),
        loan_id: "甲".into(),
        opening_principal: 200.0,
        additions: 100.0,
        reductions: 50.0,
        closing_principal: 250.0,
        ..Default::default()
    };
    let p = json!({"mode":"ledger","reportStart":"2025-01-01","reportEnd":"2025-12-31"});
    let rows = ledger_confirmation_defaults(&[row], &p).unwrap();
    for kind in ["additions", "repayments"] {
        assert_eq!(rows[0][kind][0]["date"], "2025-12-31");
        assert_eq!(rows[0][kind][0]["basis"], "按测算截止日默认");
    }
}

#[test]
fn 确认验收_十八份台账两个截止日默认事件与逐日计息() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/借款台账测试集");
    let spec: Value =
        serde_json::from_str(&fs::read_to_string(root.join("标准答案.json")).unwrap()).unwrap();
    let mut failures = vec![];
    let mut checked = 0;
    let mut unbalanced = 0;
    for year in [2025, 2026] {
        let start = NaiveDate::from_ymd_opt(year, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(year, 12, 31).unwrap();
        for file in spec["files"].as_array().unwrap() {
            let name = file["file"].as_str().unwrap();
            let mut p = json!({"mode":"ledger", "reportStart":start.to_string(),"reportEnd":end.to_string(),
                "ledgerSource":{"source":{"inputPath":root.join(name),"sheet":file["sheet"],"headerRow":file["expectHeaderRow"],"headerDepth":1},"mapping":file["mapping"]}});
            let defaults =
                prepare_rates(&p).unwrap_or_else(|e| panic!("{name}/{year}: {}", e.user_message));
            let parsed = calculate_ledger(&p).unwrap();
            for v in defaults["rows"].as_array().unwrap() {
                let id = v["loanId"].as_str().unwrap();
                let tag = format!("{name}/{year}/{id}");
                for (kind, amount) in [("additions", "added"), ("repayments", "reduced")] {
                    let events = v[kind].as_array().unwrap();
                    let sum: f64 = events.iter().map(|e| e["amount"].as_f64().unwrap()).sum();
                    if (sum - v[amount].as_f64().unwrap()).abs() > 0.005 {
                        failures.push(format!("{tag} {kind}默认明细不平"));
                    }
                    for e in events {
                        let d = parse_date(e["date"].as_str().unwrap()).unwrap();
                        if d < start || d > end {
                            failures.push(format!("{tag} 默认日期{d}超报告期"));
                        }
                    }
                }
                for field in ["opening", "added", "reduced", "closing"] {
                    if !["PBC", "推算"].contains(&v["amountSources"][field].as_str().unwrap_or(""))
                    {
                        failures.push(format!("{tag} {field}无金额来源"));
                    }
                }
                let opening = v["opening"].as_f64().unwrap();
                let closing = v["closing"].as_f64().unwrap_or(0.0);
                if (opening + v["added"].as_f64().unwrap()
                    - v["reduced"].as_f64().unwrap()
                    - closing)
                    .abs()
                    > 0.005
                {
                    unbalanced += 1;
                    println!("原始四栏不平保留复核: {tag}");
                    continue;
                }
                // Independent linear contribution: opening for every day, each event through cutoff.
                let mut expected = opening * ((end - start).num_days() + 1) as f64;
                for (kind, sign) in [("additions", 1.0), ("repayments", -1.0)] {
                    for e in v[kind].as_array().unwrap() {
                        let d = parse_date(e["date"].as_str().unwrap()).unwrap();
                        expected += sign
                            * e["amount"].as_f64().unwrap()
                            * ((end - d).num_days() + 1) as f64;
                    }
                }
                let mut confirmed = v.clone();
                // Isolate timing and principal from missing or floating source rate quality.
                confirmed["rateType"] = json!("fixed");
                confirmed["fixedRate"] = json!(0.04);
                confirmed["spreadBps"] = json!(0.0);
                let key = v["rowKey"].as_str().unwrap();
                p["ledgerInformation"] = json!({key:confirmed});
                let mut row = parsed.iter().find(|r| r.row_key == key).unwrap().clone();
                match calculate_interest(std::slice::from_mut(&mut row), &p) {
                    Ok(()) => {
                        checked += 1;
                        if (row.principal_days - expected).abs() > 0.01 {
                            failures.push(format!(
                                "{tag} 本金天数 {} != {expected}",
                                row.principal_days
                            ));
                        }
                        if (row.calculated_interest - expected * 0.04 / 365.0).abs() > 0.01 {
                            failures.push(format!("{tag} 利息未按确认后的本金天数与固定利率计算"));
                        }
                    }
                    Err(e) => failures.push(format!(
                        "{tag} 默认平衡数据不能确认: {} {}",
                        e.code, e.user_message
                    )),
                }
            }
        }
    }
    println!(
        "确认验收: 18份×2截止日，{checked} 笔逐日计息通过，{unbalanced} 笔原始四栏不平保留复核"
    );
    assert!(checked > 500);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
