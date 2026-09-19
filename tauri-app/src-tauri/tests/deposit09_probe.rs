//! 只读诊断：09 号样例（用友式序时账，年/月/日三列中实际只有「月、日」两列，
//! 年份只写在标题行「期间: 2025.01-20」）报「序时账中没有任何行匹配到 TB
//! 的货币资金科目」。参数取自 13:01 失败任务原样回放，再做日期映射对照。
//!
//! ```text
//! set CARGO_TARGET_DIR=target-zcode
//! cargo test --test deposit09_probe -- --ignored --nocapture
//! ```

use audit_toolbox_lib::engine_call_for_test;
use serde_json::{json, Value};

const PARAMS_DUMP: &str = "../outputs/deposit09_failed_job_params.json";

fn preview(label: &str, params: Value) {
    println!("--- {label} ---");
    match engine_call_for_test("deposit.preview_probe", params) {
        Ok(value) => {
            let s = &value["summary"];
            println!(
                "preview 成功 accountCount={} monthlySource={} calculatedInterest={:?}",
                s["accountCount"], s["monthlySource"], s["calculatedInterest"].as_f64()
            );
        }
        Err(err) => println!("preview 失败: {err:?}"),
    }
}

#[test]
#[ignore]
fn probe_09_date_variants() {
    let params: Value =
        serde_json::from_str(&std::fs::read_to_string(PARAMS_DUMP).unwrap()).unwrap();

    // 1) 用户现场原样回放。
    preview("原样回放（date=年-月 单列）", params.clone());

    // 2) 对照：date 收「年-月＋年-日」两列（月＋日，年份由报告期兜底）。
    let mut fixed = params.clone();
    fixed["jeMapping"]["date"] = json!(["年-月", "年-日"]);
    preview("date=[年-月, 年-日]（月份＋日期两列）", fixed);

    // 3) 旁证：把报告期缩到一个月，看单列纯月份是否全军覆没与月份无关。
    let mut narrow = params.clone();
    narrow["reportStart"] = json!("2025-01-01");
    narrow["reportEnd"] = json!("2025-01-31");
    preview("原样映射＋报告期缩到一月", narrow);
}
