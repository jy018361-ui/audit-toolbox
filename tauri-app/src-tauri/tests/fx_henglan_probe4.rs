//! 只读诊断：金标样例在币种硬校验下的表现，对照恒澜样例判断规则边界。
use serde_json::{json, Value};

fn inspect(method: &str, path: &str) -> Value {
    audit_toolbox_lib::engine_call_for_test(
        method,
        json!({"source": {"inputPath": path}}),
    )
    .expect("inspect 应当成功")
}

#[test]
#[ignore]
fn probe_golden_currency_rule() {
    let base = "C:/Users/lenovo/Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料";
    let tb = inspect("fx.inspect_tb", &format!("{base}/科目余额表.xls"));
    let je = inspect("fx.inspect_je", &format!("{base}/序时账-1.xlsx"));
    println!("金标 TB currency 建议 = {}", serde_json::to_string(&tb["suggestedMapping"]["currency"]).unwrap());
    println!("金标 TB currencyText 建议 = {}", serde_json::to_string(&tb["suggestedMapping"]["currencyText"]).unwrap());
    println!("金标 JE currency 建议 = {}", serde_json::to_string(&je["suggestedMapping"]["currency"]).unwrap());
    let mut params = json!({
        "mode": "combined",
        "fixedEntity": "",
        "tbSource": {"inputPath": format!("{base}/科目余额表.xls"), "sheet": tb["sheet"], "headerRow": tb["headerRow"], "headerDepth": tb["headerDepth"]},
        "tbMapping": tb["suggestedMapping"],
        "jeSource": {"inputPath": format!("{base}/序时账-1.xlsx"), "sheet": je["sheet"], "headerRow": je["headerRow"], "headerDepth": je["headerDepth"]},
        "jeMapping": je["suggestedMapping"],
        "entityCurrencies": tb["entityCurrencies"],
    });
    if params["entityCurrencies"].as_object().map(|o| o.is_empty()).unwrap_or(true) {
        params["entityCurrencies"] = json!({"": "CNY"});
    }
    match audit_toolbox_lib::engine_call_for_test("fx.validate_currency_mapping", params) {
        Ok(v) => println!("金标 validate = {}", serde_json::to_string(&v).unwrap()),
        Err(e) => println!("金标 validate 出错 = {e:?}"),
    }
}
