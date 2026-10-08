//! 黄金测试专用：对指定文件批量调用引擎的表头识别与映射，输出 JSON 工具答案。
//!
//! 用环境变量驱动，未设置时立即通过，不影响常规测试：
//!   `GOLDEN_TASKS` = `je|C:/a.xlsx;tb|C:/b.xls`（分号分隔，`kind|路径`）
//!   `GOLDEN_OUT`   = JSON 输出目录
//! 输出文件已存在的条目自动跳过，可断点续跑。

use std::path::PathBuf;

#[test]
fn golden_tool_answers() {
    let Ok(tasks) = std::env::var("GOLDEN_TASKS") else {
        return;
    };
    let out_dir = PathBuf::from(std::env::var("GOLDEN_OUT").unwrap_or_else(|_| ".".into()));
    std::fs::create_dir_all(&out_dir).expect("创建输出目录");
    for (i, entry) in tasks.split(';').filter(|s| !s.is_empty()).enumerate() {
        let Some((kind, path)) = entry.split_once('|') else {
            eprintln!("跳过非法条目: {entry}");
            continue;
        };
        let p = PathBuf::from(path);
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let safe: String = name
            .chars()
            .map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
            .collect();
        let out = out_dir.join(format!("{i:02}_{safe}.json"));
        if out.exists() {
            println!("SKIP {name}");
            continue;
        }
        let method = match kind.trim() {
            "tb" => "fx.inspect_tb",
            "je" => "fx.inspect_je",
            // FA List 匹配工具／存款利息页走 deposit 本地建议管线，与 fx 分开采。
            "deptb" => "deposit.inspect_tb",
            "depje" => "deposit.inspect_je",
            _ => "fx.inspect_je",
        };
        let params = serde_json::json!({ "source": { "inputPath": path } });
        match audit_toolbox_lib::engine_call_for_test(method, params) {
            Ok(v) => {
                std::fs::write(&out, serde_json::to_vec_pretty(&v).expect("序列化"))
                    .expect("写出工具答案");
                println!("OK {kind} {name}");
            }
            Err(e) => {
                std::fs::write(&out, format!("{{\"error\": \"{e:?}\"}}")).expect("写出错误");
                println!("ERR {name}: {e:?}");
            }
        }
    }
}
