//! 两列模糊匹配的端到端往返（进程内直连，不起 worker 子进程）：
//!
//! 1. 临时目录造 A/B 两个小 xlsx（各 10 行中文公司名：2 对全半角差异、
//!    1 对简称、1 对异地同字号、6 行无关）；
//! 2. `fuzzy.match` 带 `__dbPath`/`__jobId` 跑匹配并落库，断言 summary
//!    计数与行级分级；
//! 3. `fuzzy.save_confirm` → `fuzzy.get_results`（走 engine_call_for_test）
//!    断言确认状态与结果行 roundtrip；
//! 4. `fuzzy.export` 从库读回生成三张 Sheet，读回 xlsx 断言确认标记。

use audit_toolbox_lib::{engine_call_for_test, run_job_for_test};
use calamine::{Reader, open_workbook_auto};
use rust_xlsxwriter::Workbook;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

const A_ROWS: &[&str] = &[
    "ＡＢＣ（上海）有限公司",
    "华辰商贸（北京）有限公司",
    "华为技术有限公司",
    "北京星辰科技有限公司",
    "镇江恒信机械厂",
    "临江测控仪表有限公司",
    "云杉文化传播中心",
    "秦皇岛海港物流有限公司",
    "皖南矿业集团",
    "珠江水利建设有限公司",
];
const B_ROWS: &[&str] = &[
    "ABC(上海)有限公司",
    "华辰商贸(北京)有限公司",
    "华为",
    "上海星辰科技有限公司",
    "紫金有色金属贸易有限公司",
    "岭南纺织印染厂",
    "漠北新能源科技有限公司",
    "沧海渔业捕捞有限公司",
    "昆仑软件开发工作室",
    "天路国际旅行社有限责任公司",
];

fn fixture_book(path: &Path, rows: &[&str]) {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.write_string(0, 0, "公司名称").unwrap();
    for (i, value) in rows.iter().enumerate() {
        worksheet.write_string((i + 1) as u32, 0, *value).unwrap();
    }
    workbook.save(path).unwrap();
}

fn cell_text(value: &calamine::Data) -> String {
    match value {
        calamine::Data::Empty => String::new(),
        calamine::Data::String(s) => s.clone(),
        calamine::Data::Float(n) => {
            if n.fract() == 0.0 {
                format!("{n:.0}")
            } else {
                n.to_string()
            }
        }
        calamine::Data::Int(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn sheet_rows(path: &Path, sheet: &str) -> Vec<Vec<String>> {
    let mut book = open_workbook_auto(path).expect("打开导出的 xlsx");
    book.worksheet_range(sheet)
        .expect("读取 Sheet")
        .rows()
        .map(|r| r.iter().map(cell_text).collect())
        .collect()
}

fn level_of(result: &Value, i: usize) -> &str {
    result["rows"][i]["level"].as_str().unwrap()
}

#[test]
fn fuzzy_match_confirm_export_roundtrip() {
    let root: PathBuf = std::env::temp_dir().join(format!(
        "fuzzy-roundtrip-{}-{}",
        std::process::id(),
        uuid_like()
    ));
    fs::create_dir_all(&root).unwrap();
    let a_path = root.join("a侧.xlsx");
    let b_path = root.join("b侧.xlsx");
    let db_path = root.join("results.db");
    let output_path = root.join("两列匹配导出.xlsx");
    fixture_book(&a_path, A_ROWS);
    fixture_book(&b_path, B_ROWS);

    // fuzzy.inspect 是 engine_call_for_test 放行的只读方法，顺带验证。
    let inspection = engine_call_for_test(
        "fuzzy.inspect",
        json!({"source": {"inputPath": a_path.to_string_lossy()}}),
    )
    .expect("inspect 应成功");
    assert_eq!(inspection["rowCount"], A_ROWS.len());
    assert_eq!(inspection["suggestedMapping"]["column"], "公司名称");

    // 1) fuzzy.match：进程内直连（run_job_for_test），注入临时结果库。
    let job_id = "roundtrip-job-1";
    let result = run_job_for_test(
        "fuzzy.match",
        json!({
            "sourceA": {"inputPath": a_path.to_string_lossy(), "column": "公司名称"},
            "sourceB": {"inputPath": b_path.to_string_lossy(), "column": "公司名称"},
            "matchType": "company",
            "__dbPath": db_path.to_string_lossy(),
            "__jobId": job_id,
        }),
    )
    .expect("fuzzy.match 应成功");
    assert_eq!(result["summary"]["rowsA"], A_ROWS.len());
    assert_eq!(result["summary"]["rowsB"], B_ROWS.len());
    assert_eq!(result["summary"]["autoCount"], 3, "两对全半角 + 一对简称");
    assert_eq!(result["summary"]["suspectCount"], 1, "异地同字号应降级疑似");
    assert_eq!(result["summary"]["unmatchedCount"], 6);
    assert_eq!(result["summary"]["invalidCount"], 0);
    assert_eq!(level_of(&result, 0), "auto");
    assert_eq!(level_of(&result, 1), "auto");
    assert_eq!(level_of(&result, 2), "auto", "简称（字号包含）应自动匹配");
    assert_eq!(level_of(&result, 3), "suspect", "异地同字号必须人工确认");
    for i in 4..A_ROWS.len() {
        assert_eq!(level_of(&result, i), "unmatched", "无关行 {i} 不应匹配");
    }

    // 2) save_confirm：采纳异地对的候选（aIndex 4 ↔ bIndex 4）。
    let saved = engine_call_for_test(
        "fuzzy.save_confirm",
        json!({
            "jobId": job_id,
            "__dbPath": db_path.to_string_lossy(),
            "confirmations": [{"aIndex": 4, "bIndex": 4, "action": "accept"}],
        }),
    )
    .expect("save_confirm 应成功");
    assert_eq!(saved["saved"], true);

    // 3) get_results：行级结果、summary 与确认状态全部取回。
    let back = engine_call_for_test(
        "fuzzy.get_results",
        json!({"jobId": job_id, "__dbPath": db_path.to_string_lossy()}),
    )
    .expect("get_results 应成功");
    assert_eq!(
        back["rows"].as_array().unwrap().len(),
        A_ROWS.len(),
        "结果行数应与 A 侧一致"
    );
    // 临时库没有 task_history → summary 走行级统计重建路径。
    assert_eq!(back["summary"]["rowsA"], A_ROWS.len());
    assert_eq!(back["summary"]["autoCount"], 3);
    assert_eq!(back["summary"]["suspectCount"], 1);
    assert_eq!(back["summary"]["unmatchedCount"], 6);
    let confirmations = back["confirmations"].as_array().unwrap();
    assert_eq!(confirmations.len(), 1);
    assert_eq!(confirmations[0]["aIndex"], 4);
    assert_eq!(confirmations[0]["bIndex"], 4);
    assert_eq!(confirmations[0]["action"], "accept");
    let suspect_row = &back["rows"][3];
    assert_eq!(suspect_row["aValue"].as_str().unwrap(), "北京星辰科技有限公司");
    assert_eq!(
        suspect_row["matches"][0]["bValue"].as_str().unwrap(),
        "上海星辰科技有限公司"
    );

    // 4) fuzzy.export：从结果库读回并叠加确认状态。
    let exported = run_job_for_test(
        "fuzzy.export",
        json!({
            "jobId": job_id,
            "outputPath": output_path.to_string_lossy(),
            "__dbPath": db_path.to_string_lossy(),
        }),
    )
    .expect("fuzzy.export 应成功");
    let outputs = exported["outputPaths"].as_array().unwrap();
    assert_eq!(outputs.len(), 1, "worker 事件协议要 outputPaths 数组");
    assert!(output_path.is_file());

    let mut names = open_workbook_auto(&output_path).unwrap().sheet_names().to_vec();
    names.sort();
    assert_eq!(names, vec!["全部结果", "未匹配清单", "疑似确认记录"]);
    let all_rows = sheet_rows(&output_path, "全部结果");
    // 表头 + 每行至少占 1 行（有候选按候选数展开）≥ 10 行数据。
    assert!(all_rows.len() >= 11, "全部结果应至少含表头+10 行：{}", all_rows.len());
    let accepted = all_rows
        .iter()
        .find(|r| r.len() > 11 && r[1] == "4")
        .expect("应含 A 行号 4 的导出行");
    assert_eq!(accepted[11], "已确认", "采纳的候选应带确认标记：{accepted:?}");
    let auto_row = all_rows
        .iter()
        .find(|r| r.len() > 11 && r[1] == "1")
        .expect("应含 A 行号 1 的导出行");
    assert_eq!(auto_row[11], "未确认");
    let suspect_sheet = sheet_rows(&output_path, "疑似确认记录");
    assert_eq!(suspect_sheet.len(), 2, "疑似 Sheet 应只有表头 + 1 行：{suspect_sheet:?}");
    assert_eq!(suspect_sheet[1][5], "疑似匹配");
    let unmatched_sheet = sheet_rows(&output_path, "未匹配清单");
    assert_eq!(unmatched_sheet.len(), 7, "未匹配清单应为表头 + 6 行：{unmatched_sheet:?}");

    let _ = fs::remove_dir_all(root);
}

/// 不引入 uuid 依赖：时间戳 + 进程内计数拼一个够用的随机目录名。
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}
