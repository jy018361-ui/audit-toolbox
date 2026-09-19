//! 只读诊断：上海君屹样例（TB 表头为未替换的模板占位符 {NAME}编号/名称）
//! 在存款利息工具里报「序时账中没有任何行匹配到 TB 的货币资金科目」。
//! 逐步复现：识别 → 建议映射 → 完整测算 → 变体对照（无辅助核算映射）。
//!
//! ```text
//! set CARGO_TARGET_DIR=target-zcode
//! cargo test --test deposit_junyi_probe -- --ignored --nocapture
//! ```

use audit_toolbox_lib::engine_call_for_test;
use serde_json::{json, Value};

const BASE: &str = "C:/Users/lenovo/Downloads/TBJE黄金测试/1_原始件/01_TBJEPBC";
const TB: &str = "2-上海君屹科目余额表202606.xls";
const JE: &str = "2-上海君屹-序时账202601-202606.xlsx";

fn inspect(kind: &str, path: &str) -> Value {
    engine_call_for_test(
        &format!("deposit.inspect_{kind}"),
        json!({"source": {"inputPath": path}}),
    )
    .expect("inspect 应当成功")
}

fn preview(params: Value) {
    match engine_call_for_test("deposit.preview_probe", params) {
        Ok(value) => {
            println!("preview 成功");
            println!(
                "summary = {}",
                serde_json::to_string_pretty(&value["summary"]).unwrap_or_default()
            );
        }
        Err(err) => {
            println!("preview 失败: {err:?}");
        }
    }
}

#[test]
#[ignore]
fn probe_junyi_matching() {
    let tb = inspect("tb", &format!("{BASE}/{TB}"));
    let je = inspect("je", &format!("{BASE}/{JE}"));
    println!("TB sheet={} headerRow={} depth={}", tb["sheet"], tb["headerRow"], tb["headerDepth"]);
    println!("TB headers = {}", serde_json::to_string(&tb["headers"]).unwrap());
    println!("TB suggested = {}", serde_json::to_string(&tb["suggestedMapping"]).unwrap());
    println!("JE suggested = {}", serde_json::to_string(&je["suggestedMapping"]).unwrap());
    if let Some(roles) = tb["suggestedAccountRoles"].as_object() {
        let deposit_roles: Vec<_> = roles
            .iter()
            .filter(|(_, v)| v.as_str() == Some("deposit") || v.as_str() == Some("cash_on_hand"))
            .take(8)
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        println!("TB suggestedAccountRoles（货币资金类前 8）: {deposit_roles:?}");
        println!("TB suggestedAccountRoles 总数 = {}", roles.len());
    }

    // 用户现场：LLM 复核把 TB 科目编码补映射到字面列名「{NAME}编号」。
    let mut tb_map = tb["suggestedMapping"].clone();
    if tb_map.get("accountCode").is_none() {
        tb_map["accountCode"] = json!("{NAME}编号");
        tb_map["accountName"] = json!(["{NAME}名称"]);
    }
    // JE 的日期列表头是「会有」（文件自带写法），建议映射认不出，靠 LLM
    // 复核补映射——还原用户现场。
    let mut je_map = je["suggestedMapping"].clone();
    if je_map.get("date").is_none() {
        je_map["date"] = json!("会有");
    }

    println!("--- 变体 A：两侧建议映射（TB 补 {{NAME}} 编号/名称）---");
    preview(json!({
        "reportStart": "2026-01-01", "reportEnd": "2026-06-30",
        "dayBasis": "month12",
        "tbSource": {"inputPath": format!("{BASE}/{TB}")},
        "tbMapping": tb_map,
        "jeSource": {"inputPath": format!("{BASE}/{JE}")},
        "jeMapping": je_map,
    }));

    println!("--- 变体 B：去掉两侧 auxiliary 映射 ---");
    let mut tb_map_b = tb_map.clone();
    tb_map_b.as_object_mut().unwrap().remove("auxiliary");
    let mut je_map_b = je_map.clone();
    je_map_b.as_object_mut().unwrap().remove("auxiliary");
    preview(json!({
        "reportStart": "2026-01-01", "reportEnd": "2026-06-30",
        "dayBasis": "month12",
        "tbSource": {"inputPath": format!("{BASE}/{TB}")},
        "tbMapping": tb_map_b,
        "jeSource": {"inputPath": format!("{BASE}/{JE}")},
        "jeMapping": je_map_b,
    }));

    println!("--- 变体 C1：TB 辅助核算映射到 {{NAME}}名称_2（复核联动后的现场）---");
    let mut tb_map_c = tb_map.clone();
    tb_map_c["auxiliary"] = json!(["{NAME}名称_2"]);
    preview(json!({
        "reportStart": "2026-01-01", "reportEnd": "2026-06-30",
        "dayBasis": "month12",
        "tbSource": {"inputPath": format!("{BASE}/{TB}")},
        "tbMapping": tb_map_c,
        "jeSource": {"inputPath": format!("{BASE}/{JE}")},
        "jeMapping": je_map,
    }));

    println!("--- 变体 C2：TB 辅助核算映射到 {{NAME}}编号_2＋{{NAME}}名称_2 ---");
    let mut tb_map_d = tb_map.clone();
    tb_map_d["auxiliary"] = json!(["{NAME}编号_2", "{NAME}名称_2"]);
    preview(json!({
        "reportStart": "2026-01-01", "reportEnd": "2026-06-30",
        "dayBasis": "month12",
        "tbSource": {"inputPath": format!("{BASE}/{TB}")},
        "tbMapping": tb_map_d,
        "jeSource": {"inputPath": format!("{BASE}/{JE}")},
        "jeMapping": je_map,
    }));

    let run_with = |label: &str, tb_aux: Value, je_aux: Value| {
        println!("--- {label} ---");
        let mut tb_mapping = tb_map.clone();
        tb_mapping["auxiliary"] = tb_aux;
        let mut je_mapping = je_map.clone();
        je_mapping["auxiliary"] = je_aux;
        preview(json!({
            "reportStart": "2026-01-01", "reportEnd": "2026-06-30",
            "dayBasis": "month12",
            "tbSource": {"inputPath": format!("{BASE}/{TB}")},
            "tbMapping": tb_mapping,
            "jeSource": {"inputPath": format!("{BASE}/{JE}")},
            "jeMapping": je_mapping,
        }));
    };
    run_with(
        "变体 D：TB 辅助={{NAME}}名称_2，JE 辅助=银行核算名称",
        json!(["{NAME}名称_2"]),
        json!(["银行核算名称"]),
    );
    run_with(
        "变体 E：TB 辅助={{NAME}}名称_2，JE 辅助=往来单位名称＋银行核算名称",
        json!(["{NAME}名称_2"]),
        json!(["往来单位名称", "银行核算名称"]),
    );
    run_with(
        "变体 F：TB 辅助={{NAME}}编号_2，JE 辅助=往来单位名称",
        json!(["{NAME}编号_2"]),
        json!(["往来单位名称"]),
    );
}
