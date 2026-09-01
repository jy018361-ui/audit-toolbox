//! 只读诊断：看逐科目币种检测的结果与依据来源。
//!
//! ```text
//! cargo test --test fx_currency_probe -- --ignored --nocapture
//! ```

use std::path::PathBuf;

#[test]
#[ignore]
fn probe_account_currencies() {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let base =
        PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料");
    for (name, method) in [
        ("TB-3300.xlsx", "fx.inspect_tb"),
        ("3300_JE_2025.01-12.xlsx", "fx.inspect_je"),
        ("TB-4800.xlsx", "fx.inspect_tb"),
        ("科目余额表.xls", "fx.inspect_tb"),
        ("序时账-1.xlsx", "fx.inspect_je"),
        ("4800_JE_2025.01-12.xlsx", "fx.inspect_je"),
    ] {
        let path = base.join(name);
        if !path.is_file() {
            continue;
        }
        let Ok(v) = audit_toolbox_lib::engine_call_for_test(
            method,
            serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
        ) else {
            println!("── {name}: inspect 失败");
            continue;
        };
        let details = v["accountCurrencyDetails"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut by_source = std::collections::BTreeMap::<String, usize>::new();
        for (_, d) in &details {
            *by_source
                .entry(d["source"].as_str().unwrap_or("?").into())
                .or_default() += 1;
        }
        println!(
            "\n══════ {name}  科目数 {}  依据分布 {:?}",
            details.len(),
            by_source
        );
        // 重点看「退回本位币列」的——这些就是需要人工指定的
        let mut shown = 0;
        for (account, d) in &details {
            if d["needsConfirmation"].as_bool().unwrap_or(false) && shown < 8 {
                println!(
                    "  需确认: {account} -> {} (seen {})",
                    d["detected"], d["seen"]
                );
                shown += 1;
            }
        }
        // 多币种科目
        let mut multi = 0;
        for (account, d) in &details {
            let n = d["seen"].as_array().map(|a| a.len()).unwrap_or(0);
            if n > 1 && multi < 5 {
                println!(
                    "  多币种: {account} -> 主 {} / 全部 {}",
                    d["detected"], d["seen"]
                );
                multi += 1;
            }
        }
        // 截图里那两个银行科目
        for (account, d) in &details {
            if account.contains("100200002")
                || account.contains("10020002")
                || account.contains("2241170003")
                || account.contains("1002990001")
            {
                println!(
                    "  样例: {account} -> {} 依据 {} seen {} / 科目文本 {} / 币种列 {}",
                    d["detected"], d["source"], d["seen"], d["textDetected"], d["columnSeen"]
                );
            }
        }
    }
}

/// 科目分类面板列的是 TB ∪ JE 的科目名。两边拼法不同就会让同一个科目
/// 出现两行，用户得选两次——币种覆盖已按科目编码回退，但界面上仍是重复的。
#[test]
#[ignore]
fn probe_account_name_alignment() {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let base =
        PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料");
    for (tb_name, je_name) in [
        ("TB-4800.xlsx", "4800_JE_2025.01-12.xlsx"),
        ("科目余额表.xls", "序时账-1.xlsx"),
    ] {
        let tb = base.join(tb_name);
        let je = base.join(je_name);
        if !tb.is_file() || !je.is_file() {
            continue;
        }
        let read = |path: &PathBuf, method: &str| -> Vec<String> {
            audit_toolbox_lib::engine_call_for_test(
                method,
                serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
            )
            .ok()
            .and_then(|v| v["accounts"].as_array().cloned())
            .map(|all| {
                all.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
        };
        let tb_accounts = read(&tb, "fx.inspect_tb");
        let je_accounts = read(&je, "fx.inspect_je");
        let code = |account: &str| account.split_whitespace().next().unwrap_or("").to_owned();
        let tb_codes: std::collections::BTreeSet<_> = tb_accounts.iter().map(|a| code(a)).collect();
        let je_codes: std::collections::BTreeSet<_> = je_accounts.iter().map(|a| code(a)).collect();
        let exact: std::collections::BTreeSet<_> = tb_accounts
            .iter()
            .filter(|a| je_accounts.contains(a))
            .collect();
        println!(
            "
══════ {tb_name} ×  {je_name}
  TB {} 个 / JE {} 个 / 科目编码交集 {} 个 / 全名完全相同 {} 个",
            tb_accounts.len(),
            je_accounts.len(),
            tb_codes.intersection(&je_codes).count(),
            exact.len()
        );
        for account in tb_accounts.iter().take(2) {
            println!("  TB 样例: {account}");
        }
        for account in je_accounts.iter().take(2) {
            println!("  JE 样例: {account}");
        }
    }
}
