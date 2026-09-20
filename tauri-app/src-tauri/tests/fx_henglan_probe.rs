//! 只读诊断：复现 03_恒澜重工 汇兑损益样例的「TB 与 JE 口径核对」报错与
//! fx.preview 进程异常退出。参数取自本机 task_history 中真实失败任务
//! （job b4462ef1…，已转储为 outputs/fx_failed_job_params.json）原样回放。
//!
//! ```text
//! set CARGO_TARGET_DIR=target-zcode
//! cargo test --test fx_henglan_probe -- --ignored --nocapture
//! ```

use serde_json::{Value, json};

const PARAMS_DUMP: &str = "../outputs/fx_failed_job_params.json";

#[test]
#[ignore]
fn probe_alignment_then_preview() {
    let params: Value =
        serde_json::from_str(&std::fs::read_to_string(PARAMS_DUMP).expect("缺少失败任务参数转储"))
            .expect("参数转储不是合法 JSON");
    let je_source = params["jeSource"].clone();
    let tb_source = params["tbSource"].clone();

    // 1) 识别：确认引擎加载出的表头到底含不含换行、与映射字符串是否一致。
    let je_inspected =
        audit_toolbox_lib::engine_call_for_test("fx.inspect_je", json!({"source": je_source}))
            .expect("fx.inspect_je 应当成功");
    let tb_inspected =
        audit_toolbox_lib::engine_call_for_test("fx.inspect_tb", json!({"source": tb_source}))
            .expect("fx.inspect_tb 应当成功");
    println!(
        "JE headers = {}",
        serde_json::to_string(&je_inspected["headers"]).unwrap()
    );
    println!(
        "TB headers = {}",
        serde_json::to_string(&tb_inspected["headers"]).unwrap()
    );
    println!(
        "JE suggested = {}",
        serde_json::to_string(&je_inspected["suggestedMapping"]).unwrap()
    );
    println!(
        "TB suggested = {}",
        serde_json::to_string(&tb_inspected["suggestedMapping"]).unwrap()
    );

    // 2) 口径核对：原样回放失败任务中的映射。
    let align = audit_toolbox_lib::engine_call_for_test(
        "ledger.check_mapping_alignment",
        json!({
            "jeSource": je_source, "jeMapping": params["jeMapping"],
            "tbSource": tb_source, "tbMapping": params["tbMapping"],
        }),
    )
    .expect("口径核对应当能执行");
    println!(
        "alignment = {}",
        serde_json::to_string_pretty(&align).unwrap()
    );

    // 3) 预览测算：完整回放，观察是否出现进程级崩溃（panic=abort 在
    //    release 下表现为「Excel 数据处理进程异常退出」；debug 下 panic
    //    会被测试捕获并打印具体位置）。
    println!("--- 开始 fx.preview 原样回放 ---");
    let result = audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params);
    match result {
        Ok(value) => {
            let summary = json!({
                "keys": value.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()),
                "error": value.get("error"),
            });
            println!(
                "preview 完成 = {}",
                serde_json::to_string_pretty(&summary).unwrap()
            );
        }
        Err(err) => {
            println!(
                "preview 返回业务错误 = {}",
                serde_json::to_string(&err).unwrap_or_default()
            );
        }
    }
}
