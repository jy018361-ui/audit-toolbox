//! 四套原始JE的只读冒烟探针；显式忽略，需样例文件与汇率覆盖。
//! cargo test --manifest-path src-tauri/Cargo.toml --test fx_revised_fixtures_probe -- --ignored --nocapture

use serde_json::json;
use std::path::PathBuf;

#[test]
#[ignore]
fn fx_four_fixture_classification_probe() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap().join("tests/fixtures/汇率损益测试集");
    for (folder, filename, tb_filename, entity, currencies) in [
        ("用友", "用友_序时账.xlsx", "用友_科目余额表.xlsx", "E", json!({"E":"CNY"})),
        ("金蝶", "金蝶_序时账.xlsx", "金蝶_科目余额表.xlsx", "E", json!({"E":"CNY"})),
        ("SAP", "SAP_凭证明细.xlsx", "SAP_科目余额表.xlsx", "E", json!({"E":"CNY"})),
        ("Oracle", "Oracle_总账凭证明细.xlsx", "Oracle_科目余额表.xlsx", "SZ01", json!({"SZ01":"CNY","US01":"USD"})),
    ] {
        let source = root.join(folder).join(filename);
        assert!(source.exists(), "缺少样例：{}", source.display());
        let inspected = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_je", json!({"source":{"inputPath":source}})
        ).unwrap();
        let mut mapping = inspected["suggestedMapping"].clone();
        if folder == "用友" { mapping["id"] = json!(["凭证字号"]); }
        if folder == "金蝶" { mapping["id"] = json!(["凭证字","凭证号"]); }
        if folder == "金蝶" {
            mapping.as_object_mut().unwrap().remove("foreignAmount");
            mapping.as_object_mut().unwrap().remove("functionalAmount");
        }
        if folder == "Oracle" {
            mapping["id"] = json!(["JE Batch Name","JE Name"]);
            mapping["entity"] = json!("Company");
            mapping["accountCode"] = json!("Code Combination");
        }
        println!("{folder} 映射：{}", mapping);
        let result = audit_toolbox_lib::engine_call_for_test("fx.preview_probe", json!({
            "probeRevision":"four-fixtures-combined-2",
            "mode":"realized","fixedEntity":entity,"entityCurrencies":currencies,
            "accountRoles": if folder == "SAP" { json!({"100101":"cash","100102":"cash","100103":"cash"}) } else { json!({}) },
            "reportStart":"2026-01-01","reportEnd":"2026-06-30",
            "balanceSheetDate":"2026-06-30",
            "jeSource":{"inputPath":source,"sheet":inspected["sheet"],
                        "headerRow":inspected["headerRow"],"headerDepth":1},
            "jeMapping":mapping,
        }));
        let value = result.unwrap_or_else(|error| panic!("{folder} 探针失败：{error:?}"));
        println!("{folder} 已实现测算腿：{}；凭证问题：{}",
            value["summary"]["realizedEvents"],
            value["dataQuality"].as_array().map(Vec::len).unwrap_or(0));
        if folder == "SAP" {
            assert_eq!(value["summary"]["realizedEvents"], 22, "SAP 三张无损益行结汇应进入已实现测算");
        }
        let tb_source = root.join(folder).join(tb_filename);
        let tb = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_tb", json!({"source":{"inputPath":tb_source}})
        ).unwrap();
        let mut tb_mapping = tb["suggestedMapping"].clone();
        if folder == "Oracle" {
            tb_mapping["accountCode"] = json!("Code Combination");
            tb_mapping["entity"] = json!("Company");
        }
        let combined = audit_toolbox_lib::engine_call_for_test("fx.preview_probe", json!({
            "probeRevision":"four-fixtures-combined-2",
            "mode":"combined","fixedEntity":entity,"entityCurrencies":currencies,
            "accountRoles": if folder == "SAP" { json!({"100101":"cash","100102":"cash","100103":"cash"}) } else { json!({}) },
            "reportStart":"2026-01-01","reportEnd":"2026-06-30",
            "balanceSheetDate":"2026-06-30",
            "jeSource":{"inputPath":source,"sheet":inspected["sheet"],
                        "headerRow":inspected["headerRow"],"headerDepth":1},
            "jeMapping":mapping,
            "tbSource":{"inputPath":tb_source,"sheet":tb["sheet"],
                        "headerRow":tb["headerRow"],"headerDepth":if folder == "金蝶" { 2 } else { 1 }},
            "tbMapping":tb_mapping,
        }));
        let combined = combined.unwrap_or_else(|error| panic!("{folder} 组合测算未通过：{error:?}"));
        println!("{folder} 组合测算：已实现腿{}、月度余额{}、正式可用{}；质量记录{}",
            combined["summary"]["realizedEvents"], combined["summary"]["unrealizedRows"],
            combined["summary"]["formalMeasurementAvailable"],
            combined["dataQuality"].as_array().map(Vec::len).unwrap_or(0));
        if combined["summary"]["formalMeasurementAvailable"] == false {
            println!("{folder} 正式测算门槛：{}", combined["summary"]["formalMeasurementGateReasons"]);
        }
        if folder == "SAP" {
            assert_eq!(combined["summary"]["realizedEvents"], 22);
        }
    }
}
