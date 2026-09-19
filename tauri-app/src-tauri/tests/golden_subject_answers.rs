//! 科目分类黄金对比（判官计划）采集探针：对指定 TB 采集借款利息／存款利息／
//! 汇兑损益三个工具引擎的科目分类输出，并导出一份不含引擎建议的「中性科目
//! 清单」供判官子代理独立判定。与 golden_tool_answers（表头映射）同款环境
//! 变量驱动，未设置时立即通过，不影响常规测试：
//!
//!   SUBJ_TB    = TB 文件路径
//!   SUBJ_OUT   = JSON 输出目录
//!   SUBJ_START = 存款测算期间开始（如 2026-01-01）
//!   SUBJ_END   = 存款测算期间结束（如 2026-06-30）
//!   SUBJ_HEADER_ROW / SUBJ_HEADER_DEPTH = 可选，人工修正后的表头行／层级
//!     （模拟用户在工具第一步发现识别错误后的手工修正；不设则全自动）
//!   SUBJ_MAPPING_JSON = 可选，人工补充的列映射（JSON，如
//!     {"accountCode":"{NAME}编号"}，合并覆盖到各工具的建议映射上）
//!
//! 产出：loan.json（借款科目预选）、deposit.json（存款户与利息收入）、
//! fx_roles.json（汇兑科目类别）、tb_rows.json（中性科目清单），以及三个工具
//! 的表头识别快照（*_inspect.json，诊断表头行识别用）。单个工具失败不中断
//! 其他工具，失败结果以 {"error": …} 落盘。

use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn try_run(method: &str, params: Value) -> Result<Value, String> {
    audit_toolbox_lib::engine_call_for_test(method, params).map_err(|e| format!("{e:?}"))
}

fn dump(out_dir: &PathBuf, name: &str, value: &Value) {
    std::fs::write(out_dir.join(name), serde_json::to_vec_pretty(value).unwrap())
        .unwrap_or_else(|e| panic!("写出 {name}: {e}"));
}

/// 人工修正的列映射（SUBJ_MAPPING_JSON），合并覆盖到建议映射上。
fn merged(suggested: &Value) -> Value {
    let mut map = suggested.as_object().cloned().unwrap_or_default();
    let manual: Map<String, Value> = std::env::var("SUBJ_MAPPING_JSON")
        .ok()
        .filter(|x| !x.trim().is_empty())
        .and_then(|x| serde_json::from_str(&x).ok())
        .and_then(|v: Value| v.as_object().cloned())
        .unwrap_or_default();
    for (key, value) in manual {
        map.insert(key, value);
    }
    Value::Object(map)
}

#[test]
fn collect_subject_tool_answers() {
    let Ok(tb) = std::env::var("SUBJ_TB") else {
        return;
    };
    let out_dir = PathBuf::from(std::env::var("SUBJ_OUT").unwrap_or_else(|_| ".".into()));
    std::fs::create_dir_all(&out_dir).expect("创建输出目录");
    let start = std::env::var("SUBJ_START").unwrap_or_else(|_| "2026-01-01".into());
    let end = std::env::var("SUBJ_END").unwrap_or_else(|_| "2026-12-31".into());

    // 三个工具都先走各自的表头识别，再把建议映射原样带回科目分类调用，
    // 与前端「第一步识别 → 第二步科目确认」的真实链路一致。表头行／层级
    // 保持工具自动识别的结果，不人工修正。
    let mut source = json!({ "inputPath": tb });
    if let Ok(row) = std::env::var("SUBJ_HEADER_ROW") {
        source["headerRow"] = json!(row.parse::<u32>().unwrap_or(1));
    }
    if let Ok(depth) = std::env::var("SUBJ_HEADER_DEPTH") {
        source["headerDepth"] = json!(depth.parse::<u32>().unwrap_or(1));
    }

    // ── 借款利息：loan.inspect → loan.tb_accounts ──
    let mut loan_rows: Option<Vec<Value>> = None;
    match try_run("loan.inspect", json!({ "kind": "tb", "source": source })) {
        Err(err) => dump(&out_dir, "loan.json", &json!({ "error": err })),
        Ok(loan_inspect) => {
            source["sheet"] = loan_inspect["sheet"].clone();
            source["headerRow"] = loan_inspect["headerRow"].clone();
            source["headerDepth"] = loan_inspect["headerDepth"].clone();
            dump(&out_dir, "loan_inspect.json", &loan_inspect);
            match try_run(
                "loan.tb_accounts",
                json!({
                    "tbSource": {
                        "source": source,
                        "mapping": merged(&loan_inspect["suggestedMapping"])
                    }
                }),
            ) {
                Err(err) => dump(&out_dir, "loan.json", &json!({ "error": err })),
                Ok(loan) => {
                    loan_rows = loan["accounts"].as_array().cloned();
                    dump(&out_dir, "loan.json", &loan);
                }
            }
        }
    }

    // ── 汇兑损益：fx.inspect_tb → fx.account_roles ──
    match try_run("fx.inspect_tb", json!({ "source": source })) {
        Err(err) => dump(&out_dir, "fx_roles.json", &json!({ "error": err })),
        Ok(fx_inspect) => {
            dump(&out_dir, "fx_inspect_tb.json", &fx_inspect);
            match try_run(
                "fx.account_roles",
                json!({ "tbSource": source, "tbMapping": merged(&fx_inspect["suggestedMapping"]) }),
            ) {
                Err(err) => dump(&out_dir, "fx_roles.json", &json!({ "error": err })),
                Ok(fx_roles) => dump(&out_dir, "fx_roles.json", &fx_roles),
            }
        }
    }

    // ── 存款利息：deposit.inspect_tb → deposit.preview_probe ──
    match try_run("deposit.inspect_tb", json!({ "source": source })) {
        Err(err) => dump(&out_dir, "deposit.json", &json!({ "error": err })),
        Ok(dep_inspect) => {
            dump(&out_dir, "deposit_inspect_tb.json", &dep_inspect);
            match try_run(
                "deposit.preview_probe",
                json!({
                    "tbSource": source,
                    "tbMapping": merged(&dep_inspect["suggestedMapping"]),
                    "reportStart": start,
                    "reportEnd": end,
                }),
            ) {
                Err(err) => dump(&out_dir, "deposit.json", &json!({ "error": err })),
                Ok(deposit) => dump(&out_dir, "deposit.json", &deposit),
            }
        }
    }

    // ── 中性科目清单：借款工具的末级科目行去掉预选结论与理由 ──
    let rows: Vec<Value> = loan_rows
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            json!({
                "key": row["key"],
                "code": row["code"],
                "name": row["name"],
                "account": row["account"],
                "opening": row["opening"],
                "closing": row["closing"],
            })
        })
        .collect();
    dump(
        &out_dir,
        "tb_rows.json",
        &json!({ "source": tb, "rows": rows }),
    );

    println!(
        "采集完成：中性科目 {} 行（loan 建议随 loan.json，失败时含 error）",
        rows.len(),
    );
}
