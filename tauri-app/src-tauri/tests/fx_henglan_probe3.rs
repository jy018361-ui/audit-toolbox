//! 只读诊断：把失败任务里的空格版映射改写成与实际表头一致的换行版后，
//! 口径核对与预览测算应当都能通过——反向证明根因唯一。
use serde_json::{json, Value};

const PARAMS_DUMP: &str = "../outputs/fx_failed_job_params.json";

fn squashed(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, ' ' | '\n' | '\r' | '\t'))
        .collect::<String>()
        .to_lowercase()
}

fn remap(mapping: &Value, headers: &[String]) -> Value {
    let mut out = mapping.clone();
    if let Some(object) = out.as_object_mut() {
        for (_, column) in object.iter_mut() {
            match column {
                Value::String(name) => {
                    if let Some(hit) = headers.iter().find(|h| squashed(h) == squashed(name)) {
                        *column = Value::String(hit.clone());
                    }
                }
                Value::Array(items) => {
                    for item in items.iter_mut() {
                        if let Some(name) = item.as_str() {
                            if let Some(hit) =
                                headers.iter().find(|h| squashed(h) == squashed(name))
                            {
                                *item = Value::String(hit.clone());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

#[test]
#[ignore]
fn probe_with_corrected_headers() {
    let params: Value =
        serde_json::from_str(&std::fs::read_to_string(PARAMS_DUMP).unwrap()).unwrap();
    let je_source = params["jeSource"].clone();
    let tb_source = params["tbSource"].clone();
    let headers_of = |method: &str, source: &Value| {
        audit_toolbox_lib::engine_call_for_test(
            method,
            json!({"source": source}),
        )
        .expect("inspect 应当成功")["headers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    let je_headers = headers_of("fx.inspect_je", &je_source);
    let tb_headers = headers_of("fx.inspect_tb", &tb_source);
    let je_mapping = remap(&params["jeMapping"], &je_headers);
    let tb_mapping = remap(&params["tbMapping"], &tb_headers);
    println!(
        "改写后 JE accountCode = {}",
        je_mapping["accountCode"]
    );

    let align = audit_toolbox_lib::engine_call_for_test(
        "ledger.check_mapping_alignment",
        json!({
            "jeSource": je_source, "jeMapping": je_mapping,
            "tbSource": tb_source, "tbMapping": tb_mapping,
        }),
    )
    .expect("口径核对应当能执行");
    println!("alignment = {}", serde_json::to_string_pretty(&align).unwrap());

    let mut preview = params.clone();
    preview["jeMapping"] = je_mapping;
    preview["tbMapping"] = tb_mapping;
    println!("--- fx.preview 换行版映射回放 ---");
    match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", preview) {
        Ok(value) => println!(
            "preview 完成，键 = {:?}",
            value.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
        ),
        Err(err) => println!("preview 业务错误 = {err:?}"),
    }
}
