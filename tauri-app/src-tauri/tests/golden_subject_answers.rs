//! 科目分类黄金对比（判官计划）批量采集探针：对 TB 清单逐份采集借款利息／
//! 存款利息／汇兑损益三个工具引擎的科目分类输出，并导出不含引擎建议的
//! 「中性科目清单」供判官子代理独立判定。环境变量驱动，未设置时立即通过，
//! 不影响常规测试：
//!
//!   SUBJ_TASKS = 分号分隔的任务表，每条 `路径|输出目录[|表头行|表头层级|映射JSON|工作表]`
//!                （后三项可选：模拟用户在第一步人工修正表头与列映射）
//!   SUBJ_START / SUBJ_END = 存款测算期间兜底值（缺省时优先用引擎建议表日）
//!
//! 每份产出：loan.json、deposit.json、fx_roles.json、tb_rows.json、
//! loan_inspect.json / fx_inspect_tb.json / deposit_inspect_tb.json（表头识别
//! 快照）与 采集完成.flag（断点续跑：已有 flag 的份直接跳过）。单个工具失败
//! 不中断，失败结果以 {"error": …} 落盘。

use serde_json::{json, Map, Value};
use std::path::PathBuf;

fn try_run(method: &str, params: Value) -> Result<Value, String> {
    audit_toolbox_lib::engine_call_for_test(method, params).map_err(|e| format!("{e:?}"))
}

fn dump(out_dir: &PathBuf, name: &str, value: &Value) {
    std::fs::write(out_dir.join(name), serde_json::to_vec_pretty(value).unwrap())
        .unwrap_or_else(|e| panic!("写出 {name}: {e}"));
}

/// 人工修正的列映射（条目第 5 段 JSON），合并覆盖到建议映射上。
fn merged(suggested: &Value, manual: &Value) -> Value {
    let mut map = suggested.as_object().cloned().unwrap_or_default();
    if let Some(manual) = manual.as_object() {
        for (key, value) in manual {
            map.insert(key.clone(), value.clone());
        }
    }
    Value::Object(map)
}

fn collect(tb: &str, out_dir: &PathBuf, header_row: Option<u32>, header_depth: Option<u32>, mapping: &Value, sheet: Option<&str>) {
    std::fs::create_dir_all(out_dir).expect("创建输出目录");
    // 三个工具都先走各自的表头识别，再把建议映射原样带回科目分类调用，
    // 与前端「第一步识别 → 第二步科目确认」的真实链路一致。表头行／层级
    // 默认用工具自动识别，条目里给了人工修正值才覆盖。
    let mut source = json!({ "inputPath": tb });
    if let Some(row) = header_row {
        source["headerRow"] = json!(row);
    }
    if let Some(depth) = header_depth {
        source["headerDepth"] = json!(depth);
    }
    if let Some(name) = sheet {
        source["sheet"] = json!(name);
    }
    let fallback_start = std::env::var("SUBJ_START").unwrap_or_else(|_| "2026-01-01".into());
    let fallback_end = std::env::var("SUBJ_END").unwrap_or_else(|_| "2026-12-31".into());

    // ── 借款利息：loan.inspect → loan.tb_accounts ──
    let mut loan_rows: Option<Vec<Value>> = None;
    let mut balance_date: Option<String> = None;
    match try_run("loan.inspect", json!({ "kind": "tb", "source": source })) {
        Err(err) => dump(out_dir, "loan.json", &json!({ "error": err })),
        Ok(loan_inspect) => {
            source["sheet"] = loan_inspect["sheet"].clone();
            source["headerRow"] = loan_inspect["headerRow"].clone();
            source["headerDepth"] = loan_inspect["headerDepth"].clone();
            dump(out_dir, "loan_inspect.json", &loan_inspect);
            // 存款测算期间优先用引擎建议的资产负债表日。
            balance_date = loan_inspect["suggestedBalanceSheetDate"]
                .as_str()
                .map(str::to_owned);
            match try_run(
                "loan.tb_accounts",
                json!({
                    "tbSource": {
                        "source": source,
                        "mapping": merged(&loan_inspect["suggestedMapping"], mapping)
                    }
                }),
            ) {
                Err(err) => dump(out_dir, "loan.json", &json!({ "error": err })),
                Ok(loan) => {
                    loan_rows = loan["accounts"].as_array().cloned();
                    dump(out_dir, "loan.json", &loan);
                }
            }
        }
    }

    // ── 汇兑损益：fx.inspect_tb → fx.account_roles ──
    match try_run("fx.inspect_tb", json!({ "source": source })) {
        Err(err) => dump(out_dir, "fx_roles.json", &json!({ "error": err })),
        Ok(fx_inspect) => {
            dump(out_dir, "fx_inspect_tb.json", &fx_inspect);
            match try_run(
                "fx.account_roles",
                json!({
                    "tbSource": source,
                    "tbMapping": merged(&fx_inspect["suggestedMapping"], mapping)
                }),
            ) {
                Err(err) => dump(out_dir, "fx_roles.json", &json!({ "error": err })),
                Ok(fx_roles) => dump(out_dir, "fx_roles.json", &fx_roles),
            }
        }
    }

    // ── 存款利息：deposit.inspect_tb → deposit.preview_probe ──
    let end = balance_date.clone().unwrap_or(fallback_end);
    let start = format!("{}-01-01", &end[..4]);
    match try_run("deposit.inspect_tb", json!({ "source": source })) {
        Err(err) => dump(out_dir, "deposit.json", &json!({ "error": err })),
        Ok(dep_inspect) => {
            dump(out_dir, "deposit_inspect_tb.json", &dep_inspect);
            match try_run(
                "deposit.preview_probe",
                json!({
                    "tbSource": source,
                    "tbMapping": merged(&dep_inspect["suggestedMapping"], mapping),
                    "reportStart": start,
                    "reportEnd": end,
                }),
            ) {
                Err(err) => dump(out_dir, "deposit.json", &json!({ "error": err })),
                Ok(deposit) => dump(out_dir, "deposit.json", &deposit),
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
        out_dir,
        "tb_rows.json",
        &json!({ "source": tb, "rows": rows }),
    );
    std::fs::write(out_dir.join("采集完成.flag"), b"ok").expect("写 flag");
    println!("采集完成：{tb}（中性科目 {} 行）", rows.len());
}

#[test]
fn collect_subject_tool_answers_batch() {
    let Ok(tasks) = std::env::var("SUBJ_TASKS") else {
        return;
    };
    for entry in tasks.split(';').filter(|s| !s.trim().is_empty()) {
        let parts: Vec<&str> = entry.split('|').collect();
        if parts.is_empty() || parts[0].trim().is_empty() {
            eprintln!("跳过非法条目: {entry}");
            continue;
        }
        let tb = parts[0].trim();
        let out_dir = PathBuf::from(
            parts
                .get(1)
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .unwrap_or("."),
        );
        if out_dir.join("采集完成.flag").exists() {
            println!("SKIP {tb}");
            continue;
        }
        let header_row = parts.get(2).and_then(|s| s.trim().parse::<u32>().ok());
        let header_depth = parts.get(3).and_then(|s| s.trim().parse::<u32>().ok());
        let mapping: Value = parts
            .get(4)
            .and_then(|s| serde_json::from_str(s.trim()).ok())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let sheet = parts.get(5).map(|s| s.trim()).filter(|s| !s.is_empty());
        let started = std::time::Instant::now();
        let tb_name = PathBuf::from(tb)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| tb.to_string());
        println!("开始采集 {tb_name} …");
        collect(tb, &out_dir, header_row, header_depth, &mapping, sheet);
        println!("完成 {tb_name}，用时 {:.0}s", started.elapsed().as_secs_f32());
    }
}
