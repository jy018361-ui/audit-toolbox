//! 诊断探针：验证「绝对值＋单一方向列」三种摆位（01 前置 / 02 中置 / 03 表尾）
//! 下建议映射的方向列归属与 TB 自身勾稽结果。
//!
//! 走前端真实链路：`fx.inspect_tb` 取建议映射（含 align_tb_direction_pair 改判），
//! 再把建议映射原样交给 `fx.validate_mapping`（mode=unrealized，只上 TB），
//! 输出「TB 自身勾稽」告警。环境变量 TB_DIR 指向测试集目录，缺省指向
//! TBJE 黄金测试集；文件不存在时跳过，常规回归不受影响。

use serde_json::{Value, json};

fn run(method: &str, params: Value) -> Result<Value, String> {
    audit_toolbox_lib::engine_call_for_test(method, params).map_err(|e| format!("{e:?}"))
}

#[test]
fn 方向列摆位与tb自身勾稽诊断() {
    let dir = std::env::var("TB_DIR").unwrap_or_else(|_| {
        r"C:\Users\lenovo\Downloads\TBJE黄金测试\1_原始件\02_测试集".to_owned()
    });
    for name in [
        "01-北重精工_TB科目余额表.xlsx",
        "02-泓源化工_TB科目余额表.xlsx",
        "03-陇能建设_TB科目余额表.xlsx",
        "07-南嶺實業香港_TB科目余额表.xlsx",
        "08-启澜咨询_TB科目余额表.xlsx",
    ] {
        let path = format!("{dir}\\{name}");
        if !std::path::Path::new(&path).exists() {
            println!("跳过（文件不存在）: {path}");
            continue;
        }
        let inspect =
            run("fx.inspect_tb", json!({ "source": { "inputPath": path } })).expect("inspect 失败");
        let mapping = &inspect["suggestedMapping"];
        println!("===== {name}");
        println!(
            "  headerRow={} depth={} sheet={}",
            inspect["headerRow"], inspect["headerDepth"], inspect["sheet"]
        );
        println!(
            "  建议映射 openingDirection={:?}  closingDirection={:?}",
            mapping.get("openingDirection"),
            mapping.get("closingDirection")
        );
        let source = json!({
            "inputPath": path,
            "sheet": inspect["sheet"].clone(),
            "headerRow": inspect["headerRow"].clone(),
            "headerDepth": inspect["headerDepth"].clone(),
        });
        let validate = run(
            "fx.validate_mapping",
            json!({
                "mode": "unrealized",
                "reportEnd": "2025-12-31",
                "tbSource": source,
                "tbMapping": mapping.clone(),
            }),
        )
        .expect("validate 失败");
        for w in validate["warnings"].as_array().into_iter().flatten() {
            let text = w.as_str().unwrap_or("");
            if text.contains("勾稽") || text.contains("方向") {
                println!("  WARN: {text}");
            }
        }
        for e in validate["errors"].as_array().into_iter().flatten() {
            println!("  ERR : {}", e.as_str().unwrap_or(""));
        }
        if validate["errors"].as_array().is_none_or(|a| a.is_empty()) {
            println!("  valid={}", validate["valid"]);
        }
        // 借款工具链路：科目目录里借款科目的期初/期末（贷方为正）。
        if name.starts_with("03") {
            let mut loan_inspect = run(
                "loan.inspect",
                json!({ "kind": "tb", "source": { "inputPath": path } }),
            )
            .expect("loan.inspect 失败");
            // 借款工具对该双层表头自动识别成 depth=1，这里按 fx 的识别结果
            // 显式传 3/2，等价于用户在第一步手工修正表头。
            loan_inspect["headerRow"] = json!(3);
            loan_inspect["headerDepth"] = json!(2);
            let accounts = run(
                "loan.tb_accounts",
                json!({
                    "tbSource": {
                        "source": {
                            "inputPath": path,
                            "sheet": loan_inspect["sheet"].clone(),
                            "headerRow": loan_inspect["headerRow"].clone(),
                            "headerDepth": loan_inspect["headerDepth"].clone(),
                        },
                        // 借款自动识别对双层表头判成 depth=1、建议映射为空，
                        // 这里用 fx 侧 3/2 识别出的映射，等价于用户第一步确认。
                        "mapping": mapping.clone(),
                    },
                }),
            )
            .expect("loan.tb_accounts 失败");
            let rows = accounts["accounts"].as_array().cloned().unwrap_or_default();

            let mut opening_total = 0.0;
            let mut closing_total = 0.0;
            for account in &rows {
                let code = account["code"].as_str().unwrap_or("");
                if code.starts_with("2001") || code.starts_with("2501") || code.starts_with("2231") {
                    let opening = account["opening"].as_f64().unwrap_or(0.0);
                    let closing = account["closing"].as_f64().unwrap_or(0.0);
                    opening_total += opening;
                    closing_total += closing;
                    println!(
                        "  LOAN {} {} opening={} closing={}",
                        code,
                        account["name"].as_str().unwrap_or(""),
                        opening,
                        closing
                    );
                }
            }
            println!("  LOAN 借款本金合计 期初={opening_total} 期末={closing_total}");
        }
    }
}
