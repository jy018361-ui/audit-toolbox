use super::*;
use serde_json::json;

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn unified_automatic_repeated_physical_columns_remain_distinct() {
    let headers = strings(&["科目名称", "科目名称", "凭证号", "凭证号", "借方金额"]);
    let got = suggest_roles("je", &headers);
    assert_eq!(got.get(&0), Some(&"accountName"));
    assert_eq!(got.get(&1), Some(&"accountName"));
    assert_eq!(got.get(&2), Some(&"id"));
    assert_eq!(got.get(&3), Some(&"id"));
    assert_eq!(got.get(&4), Some(&"functionalDebit"));
}

#[test]
fn unified_automatic_conflict_fallback_respects_all_array_columns() {
    let mut mapping = json!({"accountName":["名称1", "名称2", "名称3"],
        "accountCode":"名称1", "auxiliary":"名称2"})
    .as_object()
    .unwrap()
    .clone();
    let candidate = |column: &str, score: f64| (column.to_owned(), score, Vec::new(), Vec::new());
    let candidates = BTreeMap::from([
        (
            "accountName".into(),
            vec![
                candidate("名称1", 0.99),
                candidate("名称2", 0.99),
                candidate("名称3", 0.99),
            ],
        ),
        (
            "accountCode".into(),
            vec![
                candidate("名称1", 0.90),
                candidate("名称3", 0.80),
                candidate("科目编码", 0.70),
            ],
        ),
        (
            "auxiliary".into(),
            vec![
                candidate("名称2", 0.90),
                candidate("名称3", 0.80),
                candidate("弱线索", 0.30),
            ],
        ),
    ]);
    resolve_mapping_column_conflicts("tb", &candidates, &mut mapping);
    assert_eq!(mapping["accountName"], json!(["名称1", "名称2", "名称3"]));
    assert_eq!(mapping["accountCode"], "科目编码");
    assert!(
        !mapping.contains_key("auxiliary"),
        "不能复用数组第三列或弱候选"
    );
    let first = mapping.clone();
    resolve_mapping_column_conflicts("tb", &candidates, &mut mapping);
    assert_eq!(mapping, first, "公共收口应幂等");
}

#[test]
fn unified_automatic_oracle_requires_group_and_prunes_empty_columns() {
    let headers = strings(&[
        "Begin Balance (Entered)",
        "Begin Balance (Accounted)",
        "End Balance (Entered)",
        "End Balance (Accounted)",
        "Period Net (Accounted Dr)",
    ]);
    let mut mapping = json!({"accountCode":"Begin Balance (Accounted)",
        "period":"Period Net (Accounted Dr)", "auxiliary":["保留维度", "End Balance (Accounted)"]})
    .as_object()
    .unwrap()
    .clone();
    let initial = mapping.clone();
    complete_entered_accounted_tb_mapping(&headers[..3], &[], &mut mapping);
    assert_eq!(mapping, initial, "不成组时不能推定完整 Oracle 口径");
    let rows = vec![strings(&["100", "700", "110", "", "140"])];
    complete_entered_accounted_tb_mapping(&headers, &rows, &mut mapping);
    assert_eq!(
        mapping["openingFunctionalAmount"],
        "Begin Balance (Accounted)"
    );
    assert_eq!(mapping["auxiliary"], json!(["保留维度"]));
    assert!(!mapping.contains_key("accountCode"));
    assert!(!mapping.contains_key("period"));
    assert!(
        !mapping.contains_key("closingFunctionalAmount"),
        "全空列仍须待确认"
    );
    mapping.insert("currencyText".into(), json!("Begin Balance (Accounted)"));
    complete_entered_accounted_tb_mapping(&headers, &rows, &mut mapping);
    assert_eq!(
        mapping["currencyText"], "Begin Balance (Accounted)",
        "共享线索指针不参与排他裁决"
    );
}

#[test]
fn unified_automatic_auxiliary_requires_identity_and_values() {
    let headers = strings(&["科目编码", "科目名称", "账户", "文本", "期末余额"]);
    let rows = vec![
        strings(&["1002", "银行存款", "银行甲", "银行甲", "100"]),
        strings(&["1002", "银行存款", "银行乙", "银行乙", "120"]),
    ];
    let roles: BTreeMap<_, _> = suggest_roles_with_data("tb", &headers, &rows)
        .into_iter()
        .collect();
    assert_eq!(roles.get(&2), Some(&"auxiliary"));
    assert_eq!(roles.get(&3), Some(&"auxiliary"));
    let je: BTreeMap<_, _> = suggest_roles_with_data("je", &headers, &rows)
        .into_iter()
        .collect();
    assert_ne!(je.get(&3), Some(&"auxiliary"), "JE 文本须留给摘要");
    for value in ["", "123.45", "借", "2026-08-31"] {
        let rows = vec![strings(&["1002", "银行存款", value, "", "100"])];
        let roles: BTreeMap<_, _> = suggest_roles_with_data("tb", &headers, &rows)
            .into_iter()
            .collect();
        assert_ne!(roles.get(&2), Some(&"auxiliary"), "无效维度: {value}");
    }
    assert!(auxiliary_dimension_candidates("tb", &headers, &rows, &BTreeMap::new()).is_empty());
}

#[test]
fn unified_automatic_oracle_and_auxiliary_cross_tool_memory_disk() {
    let dir = tempfile::tempdir().unwrap();
    for (name, csv) in [
        (
            "oracle",
            concat!(
                "Company,Code Combination,Account Description,Currency Code,Begin Balance (Entered),Begin Balance (Accounted),Period Net (Entered Dr),Period Net (Entered Cr),Period Net (Accounted Dr),Period Net (Accounted Cr),End Balance (Entered),End Balance (Accounted)\n",
                "甲公司,100201,银行存款-美元,USD,100,700,20,10,140,70,110,770\n",
                "甲公司,200101,短期借款-美元,USD,-100,-700,10,20,70,140,-110,-770\n"
            ),
        ),
        (
            "auxiliary",
            "科目编码,科目名称,账户,财务项目,期初余额,期末余额\n1002,银行存款,银行甲,项目甲,100,120\n1002,银行存款,银行乙,项目乙,200,210\n",
        ),
    ] {
        let path = dir.path().join(format!("{name}.csv"));
        std::fs::write(&path, csv).unwrap();
        for disk in [false, true] {
            for (tool, inspection) in inspections(&path, disk) {
                let mapping = inspection["suggestedMapping"].as_object().unwrap();
                if name == "oracle" {
                    for (role, column) in [
                        ("accountCode", "Code Combination"),
                        ("openingFunctionalAmount", "Begin Balance (Accounted)"),
                        ("closingFunctionalAmount", "End Balance (Accounted)"),
                        ("periodFunctionalDebit", "Period Net (Accounted Dr)"),
                        ("periodFunctionalCredit", "Period Net (Accounted Cr)"),
                    ] {
                        assert_eq!(
                            mapping.get(role),
                            Some(&json!(column)),
                            "{tool} disk={disk} {role}: {mapping:?}"
                        );
                    }
                    assert!(!mapping.contains_key("period"), "发生额不能充当期间");
                } else {
                    assert_eq!(
                        mapped_column_names(mapping, "auxiliary"),
                        strings(&["账户", "财务项目"]),
                        "{tool} disk={disk}"
                    );
                    assert!(!has_manual_auxiliary_mapping(mapping, "auxiliary"));
                }
            }
        }
    }
}

fn inspections(path: &std::path::Path, disk: bool) -> Vec<(&'static str, Value)> {
    let mut plan = crate::disk_table::ReadPlan::default();
    plan.add(path, disk);
    let _guard = plan.enter();
    let params = json!({"kind":"tb", "source":{
        "inputPath":path, "sheet":"", "headerRow":1, "headerDepth":1
    }});
    [
        (
            "借款",
            crate::loan_interest::call("loan.inspect", params.clone()),
        ),
        (
            "存款及FA",
            crate::deposit_interest::call("deposit.inspect_tb", params.clone()),
        ),
        ("汇兑及TBJE", crate::fx::call("fx.inspect_tb", params)),
    ]
    .into_iter()
    .map(|(name, result)| {
        (
            name,
            result.unwrap_or_else(|error| panic!("{name}: {error:?}")),
        )
    })
    .collect()
}

#[test]
fn direction_pair_generic_and_explicit_columns_are_complete() {
    for names in [
        ["借/贷", "借/贷_2"],
        ["方向 Dr/Cr", "方向 Dr/Cr_2"],
        ["期初方向", "期末方向"],
        ["期末方向", "期初方向"],
    ] {
        let headers = strings(&["科目编码", names[0], "期初余额", names[1], "期末余额"]);
        let expected = if names[0] == "期末方向" {
            (3, 1)
        } else {
            (1, 3)
        };
        let roles = suggest_roles("tb", &headers);
        assert_eq!(
            roles.get(&expected.0),
            Some(&"openingDirection"),
            "{names:?}"
        );
        assert_eq!(
            roles.get(&expected.1),
            Some(&"closingDirection"),
            "{names:?}"
        );
        // 最终组装曾将一侧遗漏或错误共享，公共收口同样须恢复正确物理列。
        for initial in [
            json!({"openingDirection":names[0]}),
            json!({
                "openingDirection":names[0], "closingDirection":names[0]
            }),
        ] {
            let mut mapping = initial.as_object().unwrap().clone();
            align_tb_direction_pair(&headers, &[], &mut mapping);
            assert_eq!(mapping["openingDirection"], headers[expected.0]);
            assert_eq!(mapping["closingDirection"], headers[expected.1]);
        }
        let je = suggest_roles("je", &headers);
        assert!(
            !je.values()
                .any(|role| matches!(*role, "openingDirection" | "closingDirection"))
        );
    }
}

#[test]
fn direction_pair_empty_second_column_must_not_share_first() {
    let headers = strings(&[
        "方向",
        "期初余额",
        "本期借方",
        "本期贷方",
        "方向_2",
        "期末余额",
    ]);
    let rows = [
        ["贷", "180000", "300000", "360000", "", "240000"],
        ["贷", "300000", "195000", "195000", "", "300000"],
        ["贷", "100000", "0", "50000", "", "150000"],
    ]
    .map(|row| strings(&row))
    .to_vec();
    let mut mapping = json!({"openingDirection":"方向", "openingFunctionalAmount":"期初余额",
        "periodFunctionalDebit":"本期借方", "periodFunctionalCredit":"本期贷方",
        "closingFunctionalAmount":"期末余额"})
    .as_object()
    .unwrap()
    .clone();
    align_tb_direction_pair(&headers, &rows, &mut mapping);
    assert!(
        mapping.get("closingDirection").is_none(),
        "独立期末列缺值不能退回共享: {mapping:?}"
    );
    mapping.insert("closingDirection".into(), json!("方向"));
    align_tb_direction_pair(&headers, &rows, &mut mapping);
    assert!(
        mapping.get("closingDirection").is_none(),
        "已有错误共享也不能掩盖独立期末列缺值"
    );
    let suggestions = suggest_roles_with_data("tb", &headers, &rows);
    assert!(!suggestions.values().any(|role| *role == "closingDirection"));
}

#[test]
fn direction_pair_cross_tool_inspection_agrees_in_memory_and_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("方向列.csv");
    std::fs::write(&path, concat!(
        "科目代码,科目名称,借/贷,年初余额,借方发生额,贷方发生额,借/贷,期末余额,借方累计发生额,贷方累计发生额\n",
        "2001000130,短期借款-兴业银行-700万,平,0,700000,7000000,贷,6300000,700000,7000000\n",
        "2501000001,长期借款-银行甲,贷,100,30,40,贷,110,30,40\n",
        "2501000002,长期借款-银行乙,借,10,0,30,贷,20,0,30\n"
    )).unwrap();
    for disk in [false, true] {
        for (tool, inspection) in inspections(&path, disk) {
            assert_eq!(
                inspection["suggestedMapping"]["openingDirection"], "借/贷",
                "{tool} 磁盘={disk}"
            );
            assert_eq!(
                inspection["suggestedMapping"]["closingDirection"], "借/贷_2",
                "{tool} 磁盘={disk}"
            );
        }
    }
}

#[test]
#[ignore = "人工核查同一原件和子工具映射补丁差异，需设置 MAPPING_CONSISTENCY_OUTPUT"]
fn mapping_consistency_audit_probe() {
    let out = std::path::PathBuf::from(
        std::env::var_os("MAPPING_CONSISTENCY_OUTPUT").expect("设置输出目录"),
    );
    std::fs::create_dir_all(&out).unwrap();
    let mut report = serde_json::Map::new();
    if let Some(path) = std::env::var_os("MAPPING_CONSISTENCY_ORIGINAL_TB") {
        for disk in [false, true] {
            let results = inspections(std::path::Path::new(&path), disk);
            for (tool, inspection) in results {
                assert_eq!(inspection["suggestedMapping"]["openingDirection"], "借/贷");
                assert_eq!(
                    inspection["suggestedMapping"]["closingDirection"],
                    "借/贷_2"
                );
                report.insert(
                    format!("原件-{tool}-disk{disk}"),
                    inspection["suggestedMapping"].clone(),
                );
            }
        }
    }
    for (name, csv) in [
        (
            "Oracle-Entered-Accounted",
            concat!(
                "Company,Code Combination,Account Description,Currency Code,Begin Balance (Entered),Begin Balance (Accounted),Period Net (Entered Dr),Period Net (Entered Cr),Period Net (Accounted Dr),Period Net (Accounted Cr),End Balance (Entered),End Balance (Accounted)\n",
                "甲公司,100201,银行存款-美元,USD,100,700,20,10,140,70,110,770\n",
                "甲公司,200101,短期借款-美元,USD,-100,-700,10,20,70,140,-110,-770\n"
            ),
        ),
        (
            "辅助本地别名",
            concat!(
                "科目编码,科目名称,账户,期初余额,期末余额\n",
                "1002,银行存款,银行甲,100,120\n",
                "1002,银行存款,银行乙,200,210\n"
            ),
        ),
    ] {
        let path = out.join(format!("{name}.csv"));
        std::fs::write(&path, csv).unwrap();
        let headers = strings(&csv.lines().next().unwrap().split(',').collect::<Vec<_>>());
        let rows = csv
            .lines()
            .skip(1)
            .map(|line| strings(&line.split(',').collect::<Vec<_>>()))
            .collect::<Vec<_>>();
        let mut public = serde_json::Map::new();
        for (index, role) in suggest_roles_with_data("tb", &headers, &rows) {
            public.insert(role.to_string(), json!(headers[index]));
        }
        report.insert(format!("{name}-公共初判"), json!(public));
        for (tool, inspection) in inspections(&path, false) {
            report.insert(
                format!("{name}-{tool}"),
                inspection["suggestedMapping"].clone(),
            );
        }
    }
    std::fs::write(
        out.join("跨工具映射对照.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}
