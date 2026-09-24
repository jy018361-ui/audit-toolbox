//! 真实 JE 样例的智能表头匹配回归（--ignored，常规回归不跑）：
//!
//! ```text
//! cargo test --test header_match_je_probe -- --ignored --nocapture
//! ```
//!
//! 覆盖两步：`match_preview`（表头识别 + 匹配建议，打印给人核对）与
//! `merge_probe`（按「全部按建议执行」计划真实合并），并对合并结果读回
//! 验证表头行、匹配日志与行数。样例缺省取「汇兑损益测试资料」里的三份
//! JE（3300 / 4800 / JE+YTD+OCT）与 demo-upload 的演示序时账，
//! 可用 `HEADER_MATCH_JE_DIR` 覆盖目录。

use std::path::PathBuf;

use serde_json::{Value, json};

fn base_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HEADER_MATCH_JE_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../汇兑损益测试资料")
}

fn call(method: &str, params: Value) -> Value {
    audit_toolbox_lib::engine_call_for_test(method, params).expect("探针调用应当成功")
}

/// 把 preview 的机器建议原样固化成「全部按建议执行」的合并计划：
/// 未匹配列保留为独立列（安全兜底），不丢弃任何数据。
fn plan_from_preview(preview: &Value) -> Value {
    let template = &preview["template"];
    let assignments = preview["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let columns = row["matches"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(source, m)| {
                    json!({
                        "source": source,
                        "target": m["target"],
                        "discard": false,
                        "manual": false,
                        "reason": m["reason"],
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "path": row["path"],
                "sheet": row["sheet"],
                "headerRow": row["detection"]["headerRow"],
                "headerRowsCount": row["detection"]["headerRowsCount"],
                "headers": row["headers"],
                "columns": columns,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "templatePath": template["path"],
        "templateHeaders": template["headers"],
        "rememberAliases": [],
        "assignments": assignments,
    })
}

fn read_sheet(path: &std::path::Path, sheet: &str) -> Vec<Vec<String>> {
    let mut workbook = calamine::open_workbook_auto(path).expect("打开合并结果");
    use calamine::Reader;
    workbook
        .worksheet_range(sheet)
        .unwrap_or_else(|_| panic!("缺少 Sheet：{sheet}"))
        .rows()
        .map(|row| {
            row.iter()
                .map(|cell| match cell {
                    calamine::Data::String(v) => v.clone(),
                    calamine::Data::Float(v) => v.to_string(),
                    calamine::Data::Int(v) => v.to_string(),
                    calamine::Data::Bool(v) => v.to_string(),
                    calamine::Data::DateTime(v) => v.to_string(),
                    calamine::Data::Empty => String::new(),
                    other => other.to_string(),
                })
                .collect()
        })
        .collect()
}

#[test]
#[ignore]
fn je_samples_preview_and_merge() {
    let base = base_dir();
    let samples = [
        base.join("3300_JE_2025.01-12.xlsx"),
        base.join("4800_JE_2025.01-12.xlsx"),
        base.join("JE+YTD+OCT.xlsx"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../demo-upload/演示_JE序时账.xlsx"),
    ];
    for path in &samples {
        assert!(path.exists(), "缺少样例：{}", path.display());
    }

    // 模板缺省取第一个样例；用 HEADER_MATCH_TEMPLATE=文件名 可换模板对照。
    let template_name = std::env::var("HEADER_MATCH_TEMPLATE")
        .unwrap_or_else(|_| "3300_JE_2025.01-12.xlsx".to_string());
    // ── 第一步：识别与匹配建议 ──────────────────────────────
    let preview = call(
        "excel_merger.match_preview",
        json!({
            "inputPaths": samples.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
            "templatePath": base.join(&template_name).to_string_lossy(),
            "sheetAction": "default",
        }),
    );
    let template_headers = preview["template"]["headers"]
        .as_array()
        .expect("模板表头应为数组");
    println!("模板：{}（{} 列）", preview["template"]["name"], template_headers.len());
    for header in template_headers {
        print!("「{}」", header.as_str().unwrap_or(""));
    }
    println!();
    println!(
        "模板表头识别：第 {} 行 · {} 层 · 置信度 {}",
        preview["template"]["detection"]["headerRow"],
        preview["template"]["detection"]["headerRowsCount"],
        preview["template"]["detection"]["confidence"],
    );

    let mut green = 0usize;
    let mut yellow = 0usize;
    let mut red = 0usize;
    for row in preview["rows"].as_array().unwrap() {
        println!(
            "\n── {} / {}（表头识别：第 {} 行 · {} 层 · 置信度 {}{}）",
            row["name"],
            row["sheet"],
            row["detection"]["headerRow"],
            row["detection"]["headerRowsCount"],
            row["detection"]["confidence"],
            if row["detection"]["needsReview"].as_bool().unwrap_or(false) { " · 待人工确认" } else { "" },
        );
        let headers = row["headers"].as_array().unwrap();
        for (index, m) in row["matches"].as_array().unwrap().iter().enumerate() {
            let source = headers[index].as_str().unwrap_or("");
            if m["target"].is_null() {
                red += 1;
                println!("  红  「{source}」→ 未匹配（保留独立列）");
                continue;
            }
            let idx = m["target"].as_u64().unwrap_or(u64::MAX) as usize;
            let name = template_headers
                .get(idx)
                .and_then(Value::as_str)
                .unwrap_or("");
            let confidence = m["confidence"].as_f64().unwrap_or(0.0);
            if confidence >= 0.9 {
                green += 1;
                println!("  绿  「{source}」→「{name}」（{}）", m["reason"]);
            } else {
                yellow += 1;
                println!("  黄  「{source}」→「{name}」（{} · {}）", m["reason"], confidence);
            }
        }
    }
    println!("\n汇总：绿 {green} · 黄 {yellow} · 红 {red}");
    assert!(!template_headers.is_empty(), "模板表头识别失败");
    assert_eq!(
        preview["rows"].as_array().unwrap().len(),
        samples.len(),
        "每个样例文件应有一行匹配结果"
    );

    // ── 第二步：全部按建议执行，真实合并 ──────────────────────
    let output = std::env::temp_dir().join(format!(
        "audit-header-je-probe-{}.xlsx",
        uuid::Uuid::new_v4().simple()
    ));
    let mut params = json!({
        "inputPaths": samples.iter().map(|p| p.to_string_lossy()).collect::<Vec<_>>(),
        "outputPath": output.to_string_lossy(),
        "outputFormat": "xlsx",
        "outputMode": "one_sheet",
        "direction": "vertical",
        "sheetAction": "default",
        "addHyperlinks": false,
    });
    params["headerMatching"] = plan_from_preview(&preview);
    let merged = call("excel_merger.merge_probe", params);
    assert_eq!(merged["headerMatching"], json!(true));
    assert!(output.exists(), "合并输出未生成");

    let rows = read_sheet(&output, "Merged");
    assert!(rows.len() > samples.len(), "合并结果应有多行数据，实际 {} 行", rows.len());
    assert_eq!(rows[0][0], "来源文件", "第一行应是表头行");
    assert_eq!(rows[0][1], "来源Sheet");
    assert_eq!(rows[0][2], template_headers[0], "模板列应从第三格开始");
    println!("合并输出 {} 行 × {} 列", rows.len() - 1, rows[0].len());

    let log = read_sheet(&output, "匹配日志");
    assert_eq!(log[0][0], "文件", "匹配日志表头");
    assert_eq!(
        log.len() - 1,
        preview["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["matches"].as_array().unwrap().len())
            .sum::<usize>(),
        "匹配日志应覆盖每个文件的每一列"
    );
    println!("匹配日志 {} 行", log.len() - 1);

    // 对立词护栏：贷方列绝不能并到借方模板列（如果样例里两者都存在）。
    let header = &rows[0];
    if let (Some(debit), Some(credit)) = (
        header.iter().position(|v| v.contains("借方")),
        header.iter().position(|v| v.contains("贷方")),
    ) {
        assert_ne!(debit, credit, "借贷两列必须分开");
    }
    let _ = std::fs::remove_file(&output);
}
