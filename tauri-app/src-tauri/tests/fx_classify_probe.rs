//! 只读诊断：跑「序时账-1 ＋ 科目余额表」这份样例，看凭证分类到底判成了什么。
//!
//! ```text
//! cargo test --test fx_classify_probe -- --ignored --nocapture
//! ```

use std::path::PathBuf;

fn dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料")
}

#[test]
#[ignore]
fn probe_xu_shi_zhang_1() {
    let base = dir();
    let tb = base.join("科目余额表.xls");
    let je = base.join("序时账-1.xlsx");
    assert!(tb.exists() && je.exists(), "样例缺失");

    let insp = |path: &PathBuf, method: &str| {
        audit_toolbox_lib::engine_call_for_test(
            method,
            serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
        )
        .expect("inspect 应当成功")
    };
    let tb_i = insp(&tb, "fx.inspect_tb");
    let je_i = insp(&je, "fx.inspect_je");
    println!("JE 映射: {}", serde_json::to_string(&je_i["suggestedMapping"]).unwrap());
    println!("TB uniformCurrency = {}", tb_i["uniformCurrency"]);

    // 前端上唯一码才是凭证号；自动建议落到「凭证号数」会跨月重号。
    let mut je_map = je_i["suggestedMapping"].clone();
    je_map["id"] = serde_json::json!(["唯一码"]);
    let params = serde_json::json!({
        "mode": "combined",
        "fixedEntity": "E",
        "entityCurrencies": {"E": "CNY"},
        "reportStart": "2024-01-01", "reportEnd": "2024-12-31", "balanceSheetDate": "2024-12-31",
        "tbSource": {"inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"], "headerRow": tb_i["headerRow"], "headerDepth": 1},
        "jeSource": {"inputPath": je.to_string_lossy(), "sheet": je_i["sheet"], "headerRow": je_i["headerRow"], "headerDepth": 1},
        "tbMapping": tb_i["suggestedMapping"],
        "jeMapping": je_map,
    });
    let v = match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params) {
        Ok(v) => v,
        Err(e) => {
            println!("失败：{}", format!("{e:?}").chars().take(600).collect::<String>());
            return;
        }
    };

    if let Some(o) = v.as_object() {
        println!("顶层字段: {:?}", o.keys().collect::<Vec<_>>());
    }
    println!("summary: {}", serde_json::to_string(&v["summary"]).unwrap_or_default().chars().take(1500).collect::<String>());
    println!("classification 条数: {}", v["classification"].as_array().map(|a| a.len()).unwrap_or(0));
    if let Some(a) = v["classification"].as_array() {
        for item in a.iter().take(4) {
            println!("  cls {}", serde_json::to_string(item).unwrap_or_default().chars().take(400).collect::<String>());
        }
    }
    println!("voucherDetail 条数: {}", v["voucherDetail"].as_array().map(|a| a.len()).unwrap_or(0));
    println!("── dataQuality");
    if let Some(a) = v["dataQuality"].as_array() {
        for item in a.iter().take(10) {
            println!("  {}", serde_json::to_string(item).unwrap_or_default().chars().take(420).collect::<String>());
        }
    }
    println!("── unrealizedBalanceRollforward 前 6 行");
    if let Some(a) = v["unrealizedBalanceRollforward"].as_array() {
        println!("  共 {} 行", a.len());
        for item in a.iter().take(6) {
            println!("  {}", serde_json::to_string(item).unwrap_or_default().chars().take(900).collect::<String>());
        }
    }
    let controls = v["classificationControls"].as_array().cloned().unwrap_or_default();
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for item in &controls {
        *counts.entry(item["classification"].as_str().unwrap_or("?").into()).or_default() += 1;
    }
    println!("凭证分类分布: {counts:?}");

    // 截图里那一组：借 10020002/10020007，贷 66030003
    println!("── 含 66030003 的凭证明细（前 12 条）");
    let mut shown = 0;
    for item in &controls {
        let text = serde_json::to_string(item).unwrap_or_default();
        if text.contains("66030003") && shown < 12 {
            println!("  {}", text.chars().take(700).collect::<String>());
            shown += 1;
        }
    }
    println!("共 {} 条控制项", controls.len());

    // 角色判定：这两个银行科目被认成什么
    for account in ["10020002 招商银行-美元资本金（2301）", "66030003 汇兑损益"] {
        println!("角色查询 {account}");
    }
    if let Some(roles) = v["accountRoles"].as_array() {
        for r in roles.iter().take(0) { println!("{r}"); }
    }
}
