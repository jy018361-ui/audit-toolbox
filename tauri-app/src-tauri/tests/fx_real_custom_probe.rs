//! 只读诊断：任意本地真实样例跑完整测算，输出汇总、分类分布、未实现滚动
//! 与质量提示分布，供口径改动后的人工核对。文件与参数用环境变量注入：
//!
//! ```text
//! set FX_JE=C:\...\序时账-1.xlsx
//! set FX_TB=C:\...\科目余额表.xls
//! set FX_RUN=1                （缺省 0 = 仅体检不测算）
//! set FX_START=2025-01-01     （可选）
//! set FX_END=2025-12-31       （可选）
//! set FX_CCY=CNY              （可选，本位币；缺省取 TB 的 uniformCurrency）
//! cargo test --test fx_real_custom_probe -- --ignored --nocapture
//! ```

use std::path::PathBuf;

fn env_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料")
}

#[test]
#[ignore]
fn probe_custom_dataset() {
    let base = env_dir();
    let je_name = std::env::var("FX_JE").unwrap_or_else(|_| "序时账-1.xlsx".to_string());
    let tb_name = std::env::var("FX_TB").unwrap_or_else(|_| "科目余额表.xls".to_string());
    let je = base.join(&je_name);
    let tb = base.join(&tb_name);
    assert!(je.exists(), "缺少 JE：{}", je.display());
    assert!(tb.exists(), "缺少 TB：{}", tb.display());

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
        "JE {} sheet={} headerRow={} headerDepth={}",
        je_name,
        je_i["sheet"],
        je_i["headerRow"],
        je_i["headerDepth"]
    );
    println!(
        "JE 表头: {}",
        serde_json::to_string(&je_i["headers"]).unwrap_or_default()
    );
    println!(
        "JE 映射: {}",
        serde_json::to_string(&je_i["suggestedMapping"]).unwrap()
    );
    if let Some(preview) = je_i["preview"].as_array() {
        println!("JE 前 3 行：");
        for row in preview.iter().take(3) {
            println!("   {}", serde_json::to_string(row).unwrap_or_default());
        }
    }
    println!(
        "TB {} sheet={} headerRow={} headerDepth={} uniformCurrency={}",
        tb_name,
        tb_i["sheet"],
        tb_i["headerRow"],
        tb_i["headerDepth"],
        tb_i["uniformCurrency"]
    );
    println!(
        "TB 表头: {}",
        serde_json::to_string(&tb_i["headers"]).unwrap_or_default()
    );
    println!(
        "TB 映射: {}",
        serde_json::to_string(&tb_i["suggestedMapping"]).unwrap()
    );
    if let Some(preview) = tb_i["preview"].as_array() {
        println!("TB 前 3 行：");
        for row in preview.iter().take(3) {
            println!("   {}", serde_json::to_string(row).unwrap_or_default());
        }
    }
    if let Some(cols) = tb_i["foreignCurrencyColumns"].as_array() {
        println!(
            "TB 外币列: {}",
            serde_json::to_string(cols).unwrap_or_default()
        );
    }
    if std::env::var("FX_RUN").ok().as_deref() != Some("1") {
        println!("FX_RUN != 1，仅体检，结束。");
        return;
    }

    let mut je_map = je_i["suggestedMapping"].clone();
    let tb_map = tb_i["suggestedMapping"].clone();
    // 用友导出的凭证号（记-0001）每月重复，必须用含日期的唯一码当凭证标识，
    // 否则跨月同号凭证会被并成一张，凭证结构识别全错。
    let je_headers = je_i["headers"].as_array().cloned().unwrap_or_default();
    if je_headers
        .iter()
        .any(|h| h.as_str() == Some("唯一码"))
    {
        je_map["id"] = serde_json::json!(["唯一码"]);
    }
    // 公司代码：优先从 JE 预览行的映射列取值；取不到就退回 TB 的 entity 映射值。
    let mut entity_code = String::new();
    if let Some(cols) = je_map["entity"].as_array() {
        let idx = cols[0]
            .as_str()
            .and_then(|name| je_i["headers"].as_array().map(|h| h.iter().position(|x| x == name)))
            .and_then(|p| p);
        if let (Some(preview), Some(idx)) = (je_i["preview"].as_array(), idx) {
            if let Some(value) = preview.first().and_then(|r| r.get(idx)).and_then(Value::as_str) {
                entity_code = value.trim().to_string();
            }
        }
    } else if let Some(value) = je_map["entity"].as_str() {
        let idx = je_i["headers"]
            .as_array()
            .and_then(|h| h.iter().position(|x| x.as_str() == Some(value)));
        if let (Some(preview), Some(idx)) = (je_i["preview"].as_array(), idx) {
            if let Some(value) = preview.first().and_then(|r| r.get(idx)).and_then(Value::as_str) {
                entity_code = value.trim().to_string();
            }
        }
    }
    if entity_code.is_empty() {
        if let Some(value) = tb_map["entity"].as_str() {
            let idx = tb_i["headers"]
                .as_array()
                .and_then(|h| h.iter().position(|x| x.as_str() == Some(value)));
            if let (Some(preview), Some(idx)) = (tb_i["preview"].as_array(), idx) {
                if let Some(v) = preview.first().and_then(|r| r.get(idx)).and_then(Value::as_str) {
                    entity_code = v.trim().to_string();
                }
            }
        }
    }
    if entity_code.is_empty() {
        // 两边都没有主体列时必须给固定主体，否则映射校验直接拦截
        // （主体为空时首行数据就会报「匹配ID存在空值」）。
        entity_code = std::env::var("FX_ENTITY").unwrap_or_else(|_| "本公司".to_string());
    }
    let currency = std::env::var("FX_CCY")
        .ok()
        .or_else(|| {
            tb_i["uniformCurrency"]
                .as_str()
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| "CNY".to_string());
    println!("公司代码 = {entity_code}，本位币 = {currency}");
    let mut entity_currencies = serde_json::Map::new();
    if !entity_code.is_empty() {
        entity_currencies.insert(entity_code.clone(), serde_json::json!(currency));
    }
    let mut params = serde_json::json!({
        "mode": "combined",
        "tbSource": {
            "inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"],
            "headerRow": tb_i["headerRow"], "headerDepth": tb_i["headerDepth"],
        },
        "jeSource": {
            "inputPath": je.to_string_lossy(), "sheet": je_i["sheet"],
            "headerRow": je_i["headerRow"], "headerDepth": je_i["headerDepth"],
        },
        "tbMapping": tb_map,
        "jeMapping": je_map,
        "entityCurrencies": entity_currencies,
    });
    if !entity_code.is_empty() {
        params["fixedEntity"] = serde_json::json!(entity_code);
    }
    if let Ok(start) = std::env::var("FX_START") {
        params["reportStart"] = serde_json::json!(start);
    }
    if let Ok(end) = std::env::var("FX_END") {
        params["reportEnd"] = serde_json::json!(end);
        params["balanceSheetDate"] = serde_json::json!(end);
    }
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
        *booked_by_class
            .entry(class)
            .or_insert_with(|| 0.0)
            += item["bookedFxGainLoss"].as_f64().unwrap_or(0.0);
    }
    println!("   按分类: {by_class:?}");
    println!("   按测算状态: {by_status:?}");
    println!("   按复核原因: {by_reason:?}");
    println!("   按分类的账面汇兑损益合计: {booked_by_class:?}");

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
        top.sort_by_key(|item| {
            -(item["unrealizedGainLoss"].as_f64().unwrap_or(0.0).abs() as i64)
        });
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
                .or_insert_with(|| 0.0)
                += item["unrealizedGainLoss"].as_f64().unwrap_or(0.0);
        }
        let mut ranked: Vec<(String, f64)> = by_account.into_iter().collect();
        ranked.sort_by_key(|(_, value)| -(value.abs() as i64));
        println!("== 未实现全年按科目净额（前 10）");
        for (account, value) in ranked.into_iter().take(10) {
            println!("   {value:>18.2}  {account}");
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

use serde_json::Value;
