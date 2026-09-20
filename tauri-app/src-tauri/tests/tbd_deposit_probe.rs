//! TBD-YTD 存款漏户诊断探针：对比 deposit.inspect_tb 的科目目录与
//! deposit.preview_probe 的存款户清单，定位 1020107 等户在哪一步丢失。
//!
//! ```text
//! set CARGO_TARGET_DIR=target-golden
//! TBD=c:/Users/lenovo/Downloads/TBJE黄金测试/1_原始件/03_微信原始件/TBD-YTD-全量.xlsx \
//! cargo test --test tbd_deposit_probe -- --ignored --nocapture
//! ```

use serde_json::{json, Value};

#[test]
#[ignore]
fn tbd_deposit_coverage_probe() {
    let tb = std::env::var("TBD").expect("设 TBD 环境变量指向 TBD-YTD-全量.xlsx");

    // ① inspect 的科目目录（折叠前工具能看到的科目宇宙）
    let inspect = match audit_toolbox_lib::engine_call_for_test(
        "deposit.inspect_tb",
        json!({ "source": { "inputPath": tb } }),
    ) {
        Ok(v) => v,
        Err(e) => panic!("inspect 失败: {e:?}"),
    };
    let accounts = inspect["accounts"].as_array().cloned().unwrap_or_default();
    println!("inspect accounts: {}", accounts.len());
    let in_inspect: Vec<String> = accounts
        .iter()
        .filter_map(|a| Some(a["code"].as_str()?.to_string()))
        .collect();
    let _ = &in_inspect;
    for a in &accounts {
        let text = format!("{a}");
        if text.contains("1020107") || text.contains("16904") || text.contains("1020102") {
            println!("  inspect 对象: {}", text.chars().take(240).collect::<String>());
        }
    }

    // ② preview 的存款户
    let preview = match audit_toolbox_lib::engine_call_for_test(
        "deposit.preview_probe",
        json!({
            "tbSource": { "inputPath": tb },
            "tbMapping": inspect["suggestedMapping"].clone(),
            "reportStart": "2026-01-01",
            "reportEnd": "2026-12-31",
        }),
    ) {
        Ok(v) => v,
        Err(e) => panic!("preview 失败: {e:?}"),
    };
    let rows = preview["rows"].as_array().cloned().unwrap_or_default();
    println!("preview deposit rows: {}", rows.len());
    for r in &rows {
        println!(
            "  key={:?} account={:?} cur={:?} tier={:?} opening={}",
            r["key"].as_str().unwrap_or(""),
            r["account"].as_str().unwrap_or("").chars().take(48).collect::<String>(),
            r["currency"].as_str().unwrap_or(""),
            r["tier"].as_str().unwrap_or(""),
            r["openingBalance"].as_f64().unwrap_or(0.0),
        );
    }

    // ③ 逐代码统计 TB 行：用 loan 的末级清单对照（tb_rows 由主流程另存），
    // 这里直接从 inspect 的目录里找这些代码的行，比对 preview 缺谁。
    let mut preview_codes = std::collections::BTreeSet::new();
    for r in &rows {
        if let Some(k) = r["key"].as_str() {
            for seg in k.split('|') {
                let seg = seg.trim();
                if seg.chars().filter(|c| c.is_ascii_digit()).count() >= 4 {
                    preview_codes.insert(seg.to_string());
                }
            }
        }
    }
    println!("preview 命中的编码段: {preview_codes:?}");
}
