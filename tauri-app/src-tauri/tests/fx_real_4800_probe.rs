//! 只读诊断：4800 全年真实样例（26,314 张凭证）跑完整测算，输出汇总、
//! 分类分布、未实现滚动与质量提示分布，供口径改动后的人工核对。
//!
//! ```text
//! cargo test --test fx_real_4800_probe -- --ignored --nocapture
//! ```

use std::path::PathBuf;

fn dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料")
}

#[test]
#[ignore]
fn probe_4800_full_year() {
    let base = dir();
    let je = base.join("4800_JE_2025.01-12.xlsx");
    let tb = base.join("TB-4800.xlsx");
    assert!(je.exists() && tb.exists(), "样例缺失");

    let insp = |path: &PathBuf, method: &str| {
        audit_toolbox_lib::engine_call_for_test(
            method,
            serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
        )
        .expect("inspect 应当成功")
    };
    let tb_i = insp(&tb, "fx.inspect_tb");
    let je_i = insp(&je, "fx.inspect_je");
    println!(
        "JE sheet={} headerRow={} headerDepth={}",
        je_i["sheet"], je_i["headerRow"], je_i["headerDepth"]
    );
    println!(
        "JE 表头: {}",
        serde_json::to_string(&je_i["headers"]).unwrap_or_default()
    );
    println!(
        "JE 映射: {}",
        serde_json::to_string(&je_i["suggestedMapping"]).unwrap()
    );
    println!(
        "TB 映射: {}",
        serde_json::to_string(&tb_i["suggestedMapping"]).unwrap()
    );
    println!("TB uniformCurrency = {}", tb_i["uniformCurrency"]);

    let mut je_map = je_i["suggestedMapping"].clone();
    let headers = je_i["headers"].as_array().cloned().unwrap_or_default();
    let has = |name: &str| {
        headers
            .iter()
            .any(|h| h.as_str().map(|v| v == name).unwrap_or(false))
    };
    if has("唯一码") {
        je_map["id"] = serde_json::json!(["唯一码"]);
    }
    let currency = tb_i["uniformCurrency"]
        .as_str()
        .unwrap_or("USD")
        .to_string();
    // JE 的公司代码列值为 4800（entity_for 优先取映射列，fixedEntity 只在
    // 缺列时兜底），本位币必须按真实公司代码配键，否则回退 CNY 会把
    // 美元余额全部当外币重估（上一轮探针实测踩坑）。
    let entity_code = je_i["preview"][0][1]
        .as_str()
        .unwrap_or("4800")
        .trim()
        .to_string();
    println!("公司代码 = {entity_code}，本位币 = {currency}");
    let mut entity_currencies = serde_json::Map::new();
    entity_currencies.insert(entity_code.clone(), serde_json::json!(currency));
    let params = serde_json::json!({
        "mode": "combined",
        "fixedEntity": entity_code,
        "entityCurrencies": entity_currencies,
        "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "balanceSheetDate": "2025-12-31",
        "tbSource": {
            "inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"],
            "headerRow": tb_i["headerRow"], "headerDepth": tb_i["headerDepth"],
        },
        "jeSource": {
            "inputPath": je.to_string_lossy(), "sheet": je_i["sheet"],
            "headerRow": je_i["headerRow"], "headerDepth": je_i["headerDepth"],
        },
        "tbMapping": tb_i["suggestedMapping"],
        "jeMapping": je_map,
    });
    let t0 = std::time::Instant::now();
    let v = match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params) {
        Ok(v) => v,
        Err(e) => {
            println!(
                "失败：{}",
                format!("{e:?}").chars().take(1200).collect::<String>()
            );
            return;
        }
    };
    println!("测算耗时 {:?}", t0.elapsed());

    println!(
        "== summary\n{}",
        serde_json::to_string_pretty(&v["summary"]).unwrap_or_default()
    );

    let controls = v["classificationControls"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    println!("== classificationControls 共 {} 条", controls.len());
    let mut by_class = std::collections::BTreeMap::<String, usize>::new();
    let mut by_status = std::collections::BTreeMap::<String, usize>::new();
    let mut by_reason = std::collections::BTreeMap::<String, usize>::new();
    let mut booked_by_class = std::collections::BTreeMap::<String, f64>::new();
    for item in &controls {
        let class = item["classification"].as_str().unwrap_or("?").to_string();
        *by_class.entry(class.clone()).or_default() += 1;
        *by_status
            .entry(
                item["measurementStatus"]
                    .as_str()
                    .unwrap_or("(空)")
                    .to_string(),
            )
            .or_default() += 1;
        *by_reason
            .entry(
                item["reviewReason"]
                    .as_str()
                    .unwrap_or("(空)")
                    .chars()
                    .take(30)
                    .collect::<String>(),
            )
            .or_default() += 1;
        *booked_by_class.entry(class).or_insert_with(|| 0.0) +=
            item["bookedFxGainLoss"].as_f64().unwrap_or(0.0);
    }
    println!("   按分类: {by_class:?}");
    println!("   按测算状态: {by_status:?}");
    println!("   按复核原因: {by_reason:?}");
    println!("   按分类的账面汇兑损益合计: {booked_by_class:?}");
    // FX_PENDING=1：逐张列待确认凭证（盘类别用）。
    if std::env::var("FX_PENDING").ok().as_deref() == Some("1") {
        let pending: Vec<&serde_json::Value> = controls
            .iter()
            .filter(|item| item["classification"].as_str() == Some("待确认"))
            .collect();
        println!("== 待确认凭证明细 共 {} 张", pending.len());
        for item in &pending {
            println!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                item["date"].as_str().unwrap_or(""),
                item["voucherType"].as_str().unwrap_or(""),
                item["systemCategory"].as_str().unwrap_or(""),
                item["patternLabel"].as_str().unwrap_or(""),
                item["bookedFxGainLoss"],
                item["summary"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(36)
                    .collect::<String>(),
                item["voucherId"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(28)
                    .collect::<String>(),
            );
        }
        println!("== 借贷科目组合分布（待确认）");
        let mut by_pattern = std::collections::BTreeMap::<String, (usize, f64)>::new();
        for item in &pending {
            let key = item["patternLabel"].as_str().unwrap_or("?").to_string();
            let entry = by_pattern.entry(key).or_insert((0, 0.0));
            entry.0 += 1;
            entry.1 += item["bookedFxGainLoss"].as_f64().unwrap_or(0.0);
        }
        for (pattern, (count, amount)) in by_pattern {
            println!("   {count:>3} 张 {amount:>14.2}  {pattern}");
        }
    }

    if let Some(revals) = v["clientRevaluationVouchers"].as_array() {
        println!("== 客户重估凭证（认领为未实现）共 {} 张", revals.len());
    }

    if let Some(all) = v["unrealizedBalanceRollforward"].as_array() {
        let mut total = 0.0;
        let mut suggested = 0.0;
        for item in all {
            total += item["unrealizedGainLoss"].as_f64().unwrap_or(0.0);
            suggested += item["suggestedAdjustment"].as_f64().unwrap_or(0.0);
        }
        println!(
            "== 未实现余额滚动 {} 行，unrealizedGainLoss 合计 {total:.2}，suggestedAdjustment 合计 {suggested:.2}",
            all.len()
        );
        let mut top: Vec<&serde_json::Value> = all
            .iter()
            .filter(|item| item["unrealizedGainLoss"].as_f64().unwrap_or(0.0).abs() > 0.01)
            .collect();
        top.sort_by_key(|item| -(item["unrealizedGainLoss"].as_f64().unwrap_or(0.0).abs() as i64));
        println!("   金额前 10 行：");
        for item in top.into_iter().take(10) {
            println!(
                "   {} {} {} 月末重估损益 {} 建议调整 {}",
                item["entity"].as_str().unwrap_or("?"),
                item["account"].as_str().unwrap_or("?"),
                item["currency"].as_str().unwrap_or("?"),
                item["unrealizedGainLoss"],
                item["suggestedAdjustment"],
            );
        }
        // 金额最大的一行打全字段，便于定位是哪个成分（期初、发生额、汇率）放大。
        if let Some(all) = v["unrealizedBalanceRollforward"].as_array() {
            if let Some(biggest) = all
                .iter()
                .max_by_key(|item| item["unrealizedGainLoss"].as_f64().unwrap_or(0.0).abs() as i64)
            {
                println!(
                    "== 金额最大滚动行全字段\n{}",
                    serde_json::to_string_pretty(biggest).unwrap_or_default()
                );
            }
            // 按科目全年汇总，看集中度
            let mut by_account = std::collections::BTreeMap::<String, f64>::new();
            for item in all {
                *by_account
                    .entry(
                        item["account"]
                            .as_str()
                            .unwrap_or("?")
                            .chars()
                            .take(40)
                            .collect::<String>(),
                    )
                    .or_insert_with(|| 0.0) += item["unrealizedGainLoss"].as_f64().unwrap_or(0.0);
            }
            let mut ranked: Vec<(String, f64)> = by_account.into_iter().collect();
            ranked.sort_by_key(|(_, value)| -(value.abs() as i64));
            println!("== 未实现全年按科目净额（前 10）");
            for (account, value) in ranked.into_iter().take(10) {
                println!("   {value:>18.2}  {account}");
            }
        }
    }

    if let Some(all) = v["dataQuality"].as_array() {
        println!("== dataQuality 共 {} 条", all.len());
        let mut by_type = std::collections::BTreeMap::<(String, String), usize>::new();
        for item in all {
            let key = (
                item["type"].as_str().unwrap_or("?").to_string(),
                item["severity"].as_str().unwrap_or("?").to_string(),
            );
            *by_type.entry(key).or_default() += 1;
        }
        let mut lines: Vec<String> = by_type
            .into_iter()
            .map(|((t, s), c)| format!("   [{s}] {t} × {c}"))
            .collect();
        lines.sort();
        for line in lines {
            println!("{line}");
        }
    }

    println!(
        "== 勾稽\n{}",
        serde_json::to_string_pretty(&v["reconciliation"]).unwrap_or_default()
    );
    if let Some(issues) = v["balanceRollforwardValidation"]["issues"].as_array() {
        println!("== 余额滚动校验问题 {} 条（前 5 条）", issues.len());
        for item in issues.iter().take(5) {
            println!(
                "   {}",
                serde_json::to_string(item)
                    .unwrap_or_default()
                    .chars()
                    .take(400)
                    .collect::<String>()
            );
        }
    }
}
