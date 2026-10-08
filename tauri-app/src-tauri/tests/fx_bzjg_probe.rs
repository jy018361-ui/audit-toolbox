//! 只读诊断：北重精工（只标外币的币种列，81 行 80 空白 + 1 行 USD）在
//! 汇兑损益曾报「TB 第2行币种无法标准化」。按 2026-09-19 用户定案修复后
// 回放：空白=本位币行、货币性认不出默认本位币，不再拦截。
//!
//! ```text
//! set CARGO_TARGET_DIR=target-zcode
//! cargo test --test fx_bzjg_probe -- --ignored --nocapture
//! ```

use serde_json::Value;

const PARAMS_DUMP: &str = "../outputs/fx_bzjg_failed_job_params.json";

#[test]
#[ignore]
fn replay_beizhong_after_currency_relax() {
    let params: Value =
        serde_json::from_str(&std::fs::read_to_string(PARAMS_DUMP).unwrap()).unwrap();
    match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params) {
        Ok(value) => {
            println!(
                "preview 成功，键 = {:?}",
                value
                    .as_object()
                    .map(|o| o.keys().cloned().collect::<Vec<_>>())
            );
            if let Some(summary) = value.get("summary") {
                println!(
                    "summary = {}",
                    serde_json::to_string_pretty(summary).unwrap_or_default()
                );
            }
        }
        Err(err) => println!("preview 失败: {err:?}"),
    }
}
