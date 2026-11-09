//! 四套原始JE的只读冒烟探针；显式忽略，需样例文件与汇率覆盖。
//! cargo test --manifest-path src-tauri/Cargo.toml --test fx_revised_fixtures_probe -- --ignored --nocapture

use serde_json::json;
use std::path::PathBuf;
use calamine::{open_workbook_auto, Reader};

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
        if folder == "金蝶" {
            println!("金蝶原始自动识别（未修改映射）：{}", mapping);
            assert!(mapping.get("foreignAmount").is_none(), "余额(原币)不得映射为分录金额");
            assert!(mapping.get("functionalAmount").is_none(), "余额(本位币)不得映射为分录金额");
            for role in ["foreignDebit", "foreignCredit", "functionalDebit", "functionalCredit"] {
                assert!(mapping.get(role).is_some(), "金蝶借贷发生额必须保留：{role}");
            }
        }
        if folder == "用友" { mapping["id"] = json!(["凭证字号"]); }
        if folder == "Oracle" {
            mapping["id"] = json!(["JE Batch Name","JE Name"]);
            mapping["entity"] = json!("Company");
            mapping["accountCode"] = json!("Code Combination");
        }
        println!("{folder} 映射：{}", mapping);
        let result = audit_toolbox_lib::engine_call_for_test("fx.preview_probe", json!({
            "probeRevision":"four-fixtures-realized-abc-v18",
            "mode":"realized","fixedEntity":entity,"entityCurrencies":currencies,
            "accountRoles": inspected["accountRoleSuggestions"],
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
        match folder {
            "用友" => assert_eq!(value["summary"]["realizedEvents"], 15,
                "旧版 34 腿中，17 腿同币种结清及 2 腿本位币直付新外币预付款退出 A/B/C"),
            "金蝶" => assert_eq!(value["summary"]["realizedEvents"], 6,
                "旧版 20 腿中，14 腿同币种外币债权债务结清退出 A/B/C"),
            "SAP" => assert_eq!(value["summary"]["realizedEvents"], 3,
                "旧版 22 腿中，19 腿同币种外币债权债务结清退出 A/B/C"),
            "Oracle" => assert_eq!(value["summary"]["realizedEvents"], 0,
                "旧版 33 腿中，32 腿同币种结清及 US01 FXREVAL-0630 异常混合凭证退出 A/B/C"),
            _ => unreachable!(),
        }
        let tb_source = root.join(folder).join(tb_filename);
        let tb = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_tb", json!({"source":{"inputPath":tb_source}})
        ).unwrap();
        let mut tb_mapping = tb["suggestedMapping"].clone();
        if folder == "金蝶" {
            assert_eq!(tb_mapping["ytdFunctionalDebit"], "本期发生-借方(本位币金额)");
            assert_eq!(tb_mapping["ytdFunctionalCredit"], "本期发生-贷方(本位币金额)");
            assert_eq!(tb["formMatches"][0]["complete"], true);
        }
        if folder == "Oracle" {
            tb_mapping["accountCode"] = json!("Code Combination");
            tb_mapping["entity"] = json!("Company");
        }
        let mut combined_params = json!({
            "probeRevision":"four-fixtures-realized-abc-v18",
            "mode":"combined","fixedEntity":entity,"entityCurrencies":currencies,
            "accountRoles": inspected["accountRoleSuggestions"],
            "reportStart":"2026-01-01","reportEnd":"2026-06-30",
            "balanceSheetDate":"2026-06-30",
            "jeSource":{"inputPath":source,"sheet":inspected["sheet"],
                        "headerRow":inspected["headerRow"],"headerDepth":1},
            "jeMapping":mapping,
            "tbSource":{"inputPath":tb_source,"sheet":tb["sheet"],
                        "headerRow":tb["headerRow"],"headerDepth":tb["headerDepth"]},
            "tbMapping":tb_mapping,
        });
        let combined = audit_toolbox_lib::engine_call_for_test("fx.preview_probe", combined_params.clone());
        let combined = combined.unwrap_or_else(|error| panic!("{folder} 组合测算未通过：{error:?}"));
        println!("{folder} 组合测算：已实现腿{}、月度余额{}、正式可用{}；质量记录{}",
            combined["summary"]["realizedEvents"], combined["summary"]["unrealizedRows"],
            combined["summary"]["formalMeasurementAvailable"],
            combined["dataQuality"].as_array().map(Vec::len).unwrap_or(0));
        println!("{folder} 分主体测算与账面比较：{}", combined["summary"]["entitySummaries"]);
        if folder == "Oracle" {
            let summaries = combined["summary"]["entitySummaries"].as_array().unwrap();
            assert_eq!(summaries.len(), 2);
            assert!(combined["summary"]["auditFxGainLoss"].is_null(), "不同本位币不得输出混合合计");
            for (entity, currency, audit, book) in [
                ("SZ01", "CNY", 76664.21, -19025.97),
                ("US01", "USD", 732.5020276692054, -364.0),
            ] {
                let item = summaries.iter().find(|item| item["entity"] == entity).unwrap();
                assert_eq!(item["functionalCurrency"], currency);
                assert!((item["auditFxGainLoss"].as_f64().unwrap() - audit).abs() < 0.01);
                assert!((item["tbFxGainLoss"].as_f64().unwrap() - book).abs() < 0.01);
                assert!((item["difference"].as_f64().unwrap() - (audit - book)).abs() < 0.01);
            }
        }
        if combined["summary"]["formalMeasurementAvailable"] == false {
            println!("{folder} 正式测算门槛：{}", combined["summary"]["formalMeasurementGateReasons"]);
        }
        if folder == "SAP" {
            let actual = combined["summary"]["realizedGainLoss"].as_f64().unwrap();
            let unrealized = combined["summary"]["unrealizedAdjustment"].as_f64().unwrap();
            assert!((actual + 130859.29184701713).abs() < 0.01);
            assert!((unrealized - 50601.97384701739).abs() < 0.01);
        }
        let output = std::env::temp_dir().join(format!("fx-fixture-{folder}-{}-abc-v18.xlsx", std::process::id()));
        combined_params["outputPath"] = json!(output);
        let export = audit_toolbox_lib::engine_call_for_test("fx.export_probe", combined_params);
        if combined["summary"]["formalMeasurementAvailable"] == false {
            assert!(export.is_err(), "{folder} 正式门槛未通过时不得生成审计底稿");
        } else {
            export.unwrap_or_else(|error| panic!("{folder} 底稿导出失败：{error:?}"));
            assert!(output.is_file(), "{folder} 导出文件不存在");
            let mut book = open_workbook_auto(&output).unwrap();
            let conclusion = book.worksheet_range("审计结论").unwrap();
            assert!(!conclusion.is_empty(), "{folder} 审计结论页为空");
            let realized_sheet = book.sheet_names().iter().any(|name| name == "已实现汇兑损益测算");
            assert_eq!(realized_sheet, combined["summary"]["realizedEvents"].as_u64().unwrap_or(0) > 0,
                "{folder} 已实现明细页只在存在 A/B/C 测算事件时生成");
            let monthly_compact = book.worksheet_range("未实现月度测算").unwrap();
            assert!(!monthly_compact.is_empty(), "{folder} 月度余额表为空");
            assert!(book.sheet_names().iter().any(|name| name == "客户与审计汇率比较"),
                "{folder} 必须保留客户与审计汇率比较页");
            assert!(book.sheet_names().len() <= 5, "{folder} 底稿不得新增无用工作表");
            if folder == "用友" {
                let realized = book.worksheet_range("已实现汇兑损益测算").unwrap();
                let text = realized.rows().flatten().map(ToString::to_string).collect::<Vec<_>>();
                assert!(!text.iter().any(|cell| cell.contains("记-0041") || cell.contains("记-0094")),
                    "本位币直付日元预付款已不属于 A/B/C，不应出现在已实现明细");
            }
            if folder == "Oracle" {
                let text = conclusion.rows().flatten().map(ToString::to_string).collect::<Vec<_>>();
                assert!(text.iter().any(|cell| cell == "SZ01"));
                assert!(text.iter().any(|cell| cell == "US01"));
                assert!(text.iter().any(|cell| cell == "CNY"));
                assert!(text.iter().any(|cell| cell == "USD"));
            }
            drop(book);
            std::fs::remove_file(output).unwrap();
        }
    }
}
