//! 验收：4800 真实样例上，当前工作区的测算状态与币种覆盖是否生效。
//!
//! ```text
//! cargo test --test fx_currency_override -- --ignored --nocapture
//! ```

use std::path::PathBuf;

#[test]
#[ignore]
fn measure_4800() {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let base =
        PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料");
    let tb = base.join("TB-4800.xlsx");
    let je = base.join("4800_JE_2025.01-12.xlsx");
    if !tb.is_file() || !je.is_file() {
        println!("样例缺失，跳过");
        return;
    }
    let insp = |path: &PathBuf, method: &str| {
        audit_toolbox_lib::engine_call_for_test(
            method,
            serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
        )
        .expect("inspect 应当成功")
    };
    let tb_i = insp(&tb, "fx.inspect_tb");
    let je_i = insp(&je, "fx.inspect_je");
    let params = serde_json::json!({
        "mode": "combined",
        "entityCurrencies": {"4800": tb_i["uniformCurrency"].as_str().unwrap_or("CNY")},
        "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "balanceSheetDate": "2025-12-31",
        "tbSource": {"inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"], "headerRow": tb_i["headerRow"], "headerDepth": 1},
        "jeSource": {"inputPath": je.to_string_lossy(), "sheet": je_i["sheet"], "headerRow": je_i["headerRow"], "headerDepth": 1},
        "tbMapping": tb_i["suggestedMapping"],
        "jeMapping": je_i["suggestedMapping"],
    });
    let v = match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params) {
        Ok(v) => v,
        Err(e) => {
            println!(
                "失败：{}",
                format!("{e:?}").chars().take(400).collect::<String>()
            );
            return;
        }
    };
    let s = &v["summary"];
    println!(
        "缺余额基础 {} / TB粒度不足 {} / 未实现 {} / 已实现 {} / TB汇兑损益 {} / 差异率 {}",
        s["unrealizedMissingBalanceKeys"],
        s["tbGranularityBlockedCount"],
        s["unrealizedAdjustment"],
        s["realizedGainLoss"],
        s["tbFxGainLoss"],
        s["differenceRatio"]
    );
    if let Some(all) = v["tbGranularityBlocked"].as_array() {
        println!("TB粒度不足清单 {} 条：", all.len());
        for item in all.iter().take(12) {
            println!(
                "  {}",
                serde_json::to_string(item)
                    .unwrap_or_default()
                    .chars()
                    .take(240)
                    .collect::<String>()
            );
        }
    }
}
