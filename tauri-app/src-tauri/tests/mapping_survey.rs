//! 逐份跑真实样例的表头识别与映射，把 coding 侧的结论打印出来供人工验收。
//!
//! 这是一条**调查用**测试，默认不跑（`#[ignore]`），因为它依赖本机的样例目录：
//!
//! ```text
//! cargo test --test mapping_survey -- --ignored --nocapture
//! ```
//!
//! 样例目录可用环境变量覆盖：`LEDGER_SAMPLES`（分号分隔多个目录）。

use std::path::{Path, PathBuf};

fn sample_dirs() -> Vec<PathBuf> {
    if let Ok(value) = std::env::var("LEDGER_SAMPLES") {
        return value.split(';').map(PathBuf::from).collect();
    }
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    vec![
        PathBuf::from(&home).join("科目余额表与序时账测试集"),
        PathBuf::from(&home).join("Downloads/审计工具箱/audit-toolbox-main/汇兑损益测试资料"),
    ]
}

/// 文件名里带 TB / 科目余额 的当科目余额表，其余当序时账。
fn kind_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("tb") || name.contains("科目余额") || name.contains("科目餘額") {
        "tb"
    } else {
        "je"
    }
}

fn describe(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(all) => all
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(" ＋ "),
        other => other.to_string(),
    }
}

/// 工具自己导出的底稿不是账表，扫它没有意义——映射结果只会是噪声。
fn is_tool_output(name: &str) -> bool {
    const MARKS: &[&str] = &["审计测算_", "根因修复验证", "测算结果", "_底稿", "底稿_"];
    MARKS.iter().any(|mark| name.contains(mark))
}

fn survey_one(path: &Path) {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if name.starts_with("~$") || is_tool_output(&name) {
        return;
    }
    let kind = kind_of(&name);
    let params = serde_json::json!({"source": {"inputPath": path.to_string_lossy()}});
    let method = if kind == "tb" {
        "fx.inspect_tb"
    } else {
        "fx.inspect_je"
    };
    println!("\n══════ {name}  [{}]", kind.to_uppercase());
    let result = match audit_toolbox_lib::engine_call_for_test(method, params) {
        Ok(v) => v,
        Err(e) => {
            println!("  读取失败：{e:?}");
            return;
        }
    };
    println!(
        "  Sheet={} 标题行={} 表头层数={} 行数={}",
        result["sheet"].as_str().unwrap_or("?"),
        result["headerRow"],
        result["headerDepth"],
        result["rowCount"]
    );
    let headers: Vec<String> = result["headers"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter_map(|x| x.as_str())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mapping = result["suggestedMapping"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    // 反查：每一列落到了哪个角色，没落上的也要看见。
    let mut by_column: Vec<(String, String)> =
        headers.iter().map(|h| (h.clone(), String::new())).collect();
    for (role, value) in &mapping {
        for column in describe(value).split(" ＋ ") {
            if let Some(slot) = by_column.iter_mut().find(|(h, _)| h == column) {
                if slot.1.is_empty() {
                    slot.1 = role.clone();
                } else {
                    slot.1 = format!("{} / {role}", slot.1);
                }
            }
        }
    }
    for (header, role) in &by_column {
        let shown = header.replace('\n', " ");
        if role.is_empty() {
            println!("    {shown:<34} —");
        } else {
            println!("    {shown:<34} {role}");
        }
    }
    // 形态判定：完整命中还是缺列，映射面板与调查输出保持同一口径。
    if let Some(matches) = result["formMatches"].as_array() {
        if let Some(best) = matches.first() {
            let id = best["form"].as_str().unwrap_or("?");
            let label = best["label"].as_str().unwrap_or("");
            if best["complete"].as_bool() == Some(true) {
                println!("  [形态] 完整命中 {id}（{label}）");
            } else {
                let missing: Vec<&str> = best["missing"]
                    .as_array()
                    .map(|all| all.iter().filter_map(|x| x.as_str()).collect())
                    .unwrap_or_default();
                let partial: Vec<&str> = best["partialOptional"]
                    .as_array()
                    .map(|all| all.iter().filter_map(|x| x.as_str()).collect())
                    .unwrap_or_default();
                println!(
                    "  [形态] 未完整命中：最接近 {id}（{label}），缺 {missing:?}，可选槽半拉子 {partial:?}"
                );
            }
        }
    }
}

/// 对单份样例跑 LLM 映射复核，打印模型提出的 changes 供人工与 coding 结论对照。
fn review_one(path: &Path, kind: &str) {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let params = serde_json::json!({"source": {"inputPath": path.to_string_lossy()}});
    let method = if kind == "tb" {
        "fx.inspect_tb"
    } else {
        "fx.inspect_je"
    };
    let Ok(inspection) = audit_toolbox_lib::engine_call_for_test(method, params) else {
        println!("  {name}: inspect 失败，跳过 LLM 复核");
        return;
    };
    let payload = serde_json::json!({
        "headers": inspection["headers"],
        "sampleRows": inspection["preview"],
        "hardcodedCandidates": inspection["mappingCandidates"],
        "currentMapping": inspection["suggestedMapping"],
    });
    println!("\n──── LLM 复核 {name}");
    match audit_toolbox_lib::engine_call_for_test(
        "ledger.review_mapping",
        serde_json::json!({ "kind": kind, "payload": payload }),
    ) {
        Ok(value) => {
            let changes: Vec<&serde_json::Value> = value
                .get("changes")
                .and_then(|c| c.as_array())
                .map(|all| all.iter().collect())
                .unwrap_or_default();
            if changes.is_empty() {
                println!("  （无修改建议）");
            } else {
                for change in changes {
                    println!(
                        "  {} {}→{} 置信{}：{}",
                        change["role"].as_str().unwrap_or("?"),
                        change["currentColumn"].as_str().unwrap_or("(空)"),
                        change["suggestedColumn"].as_str().unwrap_or("?"),
                        change["confidence"].as_f64().unwrap_or(0.0),
                        change["reason"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(80)
                            .collect::<String>(),
                    );
                }
            }
        }
        Err(e) => println!("  LLM 复核失败：{e:?}"),
    }
}

#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_real_samples() {
    let mut seen = 0usize;
    for dir in sample_dirs() {
        if !dir.is_dir() {
            println!("（跳过不存在的目录：{}）", dir.display());
            continue;
        }
        println!("\n########## {}", dir.display());
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "xlsx" || x == "xls"))
            .collect();
        files.sort();
        for path in files {
            survey_one(&path);
            seen += 1;
        }
    }
    assert!(seen > 0, "一份样例都没找到，请设置 LEDGER_SAMPLES");
}

/// 对样例目录逐份跑 LLM 映射复核（需要本机已配置并启用 LLM）。
///
/// ```text
/// cargo test --test mapping_survey survey_llm_review -- --ignored --nocapture
/// ```
///
/// 只扫 LEDGER_SAMPLES 的第一个目录，避免大范围消耗 API 额度。
#[test]
#[ignore = "调用外部 LLM，产生费用，手工调查用"]
fn survey_llm_review() {
    let dirs = sample_dirs();
    let Some(dir) = dirs.first().filter(|d| d.is_dir()) else {
        panic!("样例目录不存在，请设置 LEDGER_SAMPLES");
    };
    println!("\n########## LLM 复核 {}", dir.display());
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "xlsx" || x == "xls"))
        .collect();
    files.sort();
    let mut seen = 0usize;
    for path in files {
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        if name.starts_with("~$") || is_tool_output(&name) {
            continue;
        }
        // 大文件（几十万行）的 LLM 复核一次就要把 8 行样例发出去，够用；
        // 但调查聚焦表头映射，跳过超大文件节省额度，coding 侧已覆盖。
        if path
            .metadata()
            .map(|m| m.len() > 5_000_000)
            .unwrap_or(false)
        {
            println!("（跳过大文件：{name}）");
            continue;
        }
        review_one(&path, kind_of(&name));
        seen += 1;
    }
    assert!(seen > 0, "一份样例都没找到");
}

/// 用真实 TB 跑一遍科目角色分类，看哪些科目落到了「未分配」。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_account_roles() {
    let dirs = sample_dirs();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for name in ["TB-3300.xlsx", "TB-4800.xlsx"] {
            let path = dir.join(name);
            if !path.is_file() {
                continue;
            }
            let source = serde_json::json!({"inputPath": path.to_string_lossy()});
            let Ok(inspection) = audit_toolbox_lib::engine_call_for_test(
                "fx.inspect_tb",
                serde_json::json!({"source": source.clone()}),
            ) else {
                continue;
            };
            let mapping = inspection["suggestedMapping"].clone();
            println!("\n══════ {name} 科目角色");
            println!("  accountName 映射到：{}", mapping["accountName"]);
            let Ok(roles) = audit_toolbox_lib::engine_call_for_test(
                "fx.account_roles",
                serde_json::json!({"tbSource": source, "tbMapping": mapping}),
            ) else {
                println!("  分类失败");
                continue;
            };
            let all = roles["accounts"].as_array().cloned().unwrap_or_default();
            let mut unassigned = 0usize;
            let mut by_role: std::collections::BTreeMap<String, usize> = Default::default();
            for item in &all {
                let account = item["account"].as_str().unwrap_or("");
                let role = item["suggestedRole"].as_str().unwrap_or("");
                *by_role.entry(role.to_string()).or_default() += 1;
                if role == "unassigned" {
                    unassigned += 1;
                }
                if role == "unassigned" || account.contains("汇兑") {
                    println!("    [{role}] {account}");
                }
            }
            println!(
                "  共 {} 个科目，未分配 {unassigned} 个；分布 {by_role:?}",
                all.len()
            );
        }
    }
}

/// 对全部原始 TB 打印货币性科目和低置信建议，用于把规则调优与人工基准逐项对照。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_account_role_details() {
    let Some(dir) = sample_dirs().into_iter().find(|path| path.is_dir()) else {
        panic!("样例目录不存在");
    };
    for name in [
        "TB-3300.xlsx",
        "TB-4800.xlsx",
        "Oct+BS+PL+TB.xlsx",
        "科目余额表.xls",
    ] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let source = serde_json::json!({"inputPath": path.to_string_lossy()});
        let inspection = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_tb",
            serde_json::json!({"source": source.clone()}),
        )
        .expect("TB 应当可读取");
        let roles = audit_toolbox_lib::engine_call_for_test(
            "fx.account_roles",
            serde_json::json!({"tbSource": source, "tbMapping": inspection["suggestedMapping"]}),
        )
        .expect("科目应当可分类");
        let all = roles["accounts"].as_array().cloned().unwrap_or_default();
        let mut by_role = std::collections::BTreeMap::<String, usize>::new();
        let mut review = 0usize;
        println!("\n══════ {name} 分类明细");
        for item in &all {
            let account = item["account"].as_str().unwrap_or("");
            let role = item["suggestedRole"].as_str().unwrap_or("");
            *by_role.entry(role.to_owned()).or_default() += 1;
            let needs = item["needsConfirmation"].as_bool().unwrap_or(false);
            if needs {
                review += 1;
            }
            if name.starts_with("Oct")
                || name == "科目余额表.xls"
                || account.contains("保证金")
                || needs
                || matches!(
                    role,
                    "monetary_asset" | "monetary_liability" | "fx_gain_loss"
                )
            {
                println!(
                    "  [{}{}] {}｜{}",
                    role,
                    if needs { "·建议复核" } else { "" },
                    account,
                    item["reason"].as_str().unwrap_or("")
                );
            }
        }
        println!(
            "  合计 {}；建议复核 {}；分布 {by_role:?}",
            all.len(),
            review
        );
    }
}

/// 量一下 36 万行的序时账到底慢在哪：读文件、建行记录、逐行取值各占多少。
///
/// ```text
/// cargo test --release --test mapping_survey bench_large_journal -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机大样例，性能调查用"]
fn bench_ledger_cache() {
    use std::time::Instant;
    for dir in sample_dirs() {
        let path = dir.join("4800_JE_2025.01-12.xlsx");
        if !path.is_file() {
            continue;
        }
        let params = serde_json::json!({
            "inputPath": path.to_string_lossy(),
            "headerRow": 1,
        });
        // 第一次读要解析源文件并写缓存；后面每一步都该命中缓存。
        let t0 = Instant::now();
        let first = audit_toolbox_lib::engine_call_for_test("kanzhang.inspect", params.clone())
            .expect("首次读取应当成功");
        let cold = t0.elapsed();
        let t1 = Instant::now();
        audit_toolbox_lib::engine_call_for_test("kanzhang.inspect", params.clone())
            .expect("二次读取应当成功");
        let warm = t1.elapsed();
        println!(
            "
══════ 看账读取缓存 · {}",
            path.display()
        );
        println!(
            "  行数 {} 列数 {}",
            first["dimensions"]["rows"],
            first["headers"].as_array().map(|a| a.len()).unwrap_or(0)
        );
        println!("  首次（解析源文件＋写缓存）: {cold:?}");
        println!("  再次（命中缓存）        : {warm:?}");
        if warm < cold {
            let ratio = cold.as_secs_f64() / warm.as_secs_f64().max(1e-9);
            println!("  提速 {ratio:.1}×");
        }
        return;
    }
    println!("（没找到 4800_JE 样例）");
}

#[test]
#[ignore = "依赖本机大样例，性能调查用"]
fn bench_large_journal() {
    use std::time::Instant;
    let dirs = sample_dirs();
    for dir in dirs {
        let path = dir.join("4800_JE_2025.01-12.xlsx");
        if !path.is_file() {
            continue;
        }
        let t0 = Instant::now();
        let inspection = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_je",
            serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
        )
        .expect("inspect 应当成功");
        println!("  inspect（含读表样本）: {:?}", t0.elapsed());
        println!(
            "    行数 {} 列数 {}",
            inspection["rowCount"],
            inspection["headers"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0)
        );
        return;
    }
    println!("（没找到 4800_JE 样例）");
}

/// 拿真实的 3300 / 4800 跑一遍映射校验，把拦下测算的具体理由打出来。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_validate() {
    for dir in sample_dirs() {
        if !dir.is_dir() {
            continue;
        }
        for (tb_name, je_name) in [
            ("TB-3300.xlsx", "3300_JE_2025.01-12.xlsx"),
            ("TB-4800.xlsx", "4800_JE_2025.01-12.xlsx"),
        ] {
            let tb_path = dir.join(tb_name);
            let je_path = dir.join(je_name);
            if !tb_path.is_file() || !je_path.is_file() {
                continue;
            }
            println!("\n══════ {tb_name} + {je_name}");
            let mut params = serde_json::Map::new();
            for (kind, path, src_key, map_key) in [
                ("tb", &tb_path, "tbSource", "tbMapping"),
                ("je", &je_path, "jeSource", "jeMapping"),
            ] {
                let source = serde_json::json!({"inputPath": path.to_string_lossy()});
                let inspection = audit_toolbox_lib::engine_call_for_test(
                    &format!("fx.inspect_{kind}"),
                    serde_json::json!({"source": source.clone()}),
                )
                .expect("inspect 应当成功");
                params.insert(src_key.into(), source);
                params.insert(map_key.into(), inspection["suggestedMapping"].clone());
            }
            params.insert("mode".into(), serde_json::json!("combined"));
            params.insert("reportEnd".into(), serde_json::json!("2025-12-31"));
            params.insert("fixedEntity".into(), serde_json::json!("3300"));
            match audit_toolbox_lib::engine_call_for_test(
                "fx.validate_mapping",
                serde_json::Value::Object(params),
            ) {
                Ok(v) => {
                    let list = |k: &str| {
                        v[k].as_array()
                            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>())
                            .unwrap_or_default()
                    };
                    for e in list("errors") {
                        println!("  [错误] {e}");
                    }
                    for w in list("warnings") {
                        println!("  [提示] {w}");
                    }
                    if list("errors").is_empty() {
                        println!("  校验通过");
                    }
                }
                Err(e) => println!("  调用失败: {e:?}"),
            }
        }
    }
}

/// 存款利息对同一批 TB/JE 的识别情况，看它与汇兑损益是否同口径。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_deposit() {
    for dir in sample_dirs() {
        if !dir.is_dir() {
            continue;
        }
        for name in ["TB-3300.xlsx", "TB-4800.xlsx"] {
            let path = dir.join(name);
            if !path.is_file() {
                continue;
            }
            let Ok(v) = audit_toolbox_lib::engine_call_for_test(
                "deposit.inspect_tb",
                serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
            ) else {
                println!("\n══════ {name}：deposit.inspect 调用失败");
                continue;
            };
            let m = v["suggestedMapping"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            println!("\n══════ {name} 存款利息的 TB 映射");
            let mut roles: Vec<&String> = m.keys().collect();
            roles.sort();
            for role in roles {
                println!("    {role:<28} {}", m[role]);
            }
            let roles_map = v["suggestedAccountRoles"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let mut by_role: std::collections::BTreeMap<&str, usize> = Default::default();
            for value in roles_map.values() {
                *by_role.entry(value.as_str().unwrap_or("?")).or_default() += 1;
            }
            println!("    科目角色分布 {by_role:?}");
        }
    }
}

/// 用真实的 4800 TB＋JE 跑一遍余额滚动校验，把失配明细打出来。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_rollforward() {
    for dir in sample_dirs() {
        let tb = dir.join("TB-4800.xlsx");
        let je = dir.join("4800_JE_2025.01-12.xlsx");
        if !tb.is_file() || !je.is_file() {
            continue;
        }
        let insp = |path: &PathBuf, method: &str| {
            audit_toolbox_lib::engine_call_for_test(
                method,
                serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
            )
            .expect("inspect 应当成功")
        };
        let tb_i = insp(&tb, "fx.inspect_tb");
        let je_i = insp(&je, "fx.inspect_je");
        let params = serde_json::json!({
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31",
            "tbSource": {"inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"], "headerRow": tb_i["headerRow"], "headerDepth": 1},
            "jeSource": {"inputPath": je.to_string_lossy(), "sheet": je_i["sheet"], "headerRow": je_i["headerRow"], "headerDepth": 1},
            "tbMapping": tb_i["suggestedMapping"],
            "jeMapping": je_i["suggestedMapping"],
        });
        println!(
            "
══════ 4800 TB+JE 余额滚动校验"
        );
        println!(
            "  JE 映射 direction={} functionalAmount={}",
            je_i["suggestedMapping"]["direction"], je_i["suggestedMapping"]["functionalAmount"]
        );
        if let Ok(sc) = audit_toolbox_lib::engine_call_for_test(
            "fx.sign_probe",
            serde_json::json!({
                "source": {"inputPath": je.to_string_lossy(), "sheet": je_i["sheet"], "headerRow": je_i["headerRow"], "headerDepth": 1},
                "mapping": je_i["suggestedMapping"],
            }),
        ) {
            println!("  JE 符号口径判定：{sc}");
        }
        match audit_toolbox_lib::engine_call_for_test("fx.rollforward_check", params) {
            Ok(v) => println!("  通过：{}", serde_json::to_string(&v).unwrap_or_default()),
            Err(e) => {
                let shown: String = format!("{e:?}").chars().take(1600).collect();
                println!("  {shown}");
            }
        }
        return;
    }
    println!("（没找到 4800 样例）");
}

/// 用真实 4800 跑完整测算，看未实现测算的余额基础是否完整。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_unrealized() {
    for dir in sample_dirs() {
        let tb = dir.join("TB-4800.xlsx");
        let je = dir.join("4800_JE_2025.01-12.xlsx");
        if !tb.is_file() || !je.is_file() {
            continue;
        }
        let insp = |path: &PathBuf, method: &str| {
            audit_toolbox_lib::engine_call_for_test(
                method,
                serde_json::json!({"source": {"inputPath": path.to_string_lossy()}}),
            )
            .expect("inspect 应当成功")
        };
        let tb_i = insp(&tb, "fx.inspect_tb");
        let je_i = insp(&je, "fx.inspect_je");
        let params = serde_json::json!({
            "mode": "combined",
            // 与前端同口径：本位币取 TB 判出的 uniformCurrency 预填值。
            // 直接调后端而不传这一项，会落到默认的 CNY，全表科目都被当成外币。
            "entityCurrencies": {"4800": tb_i["uniformCurrency"].as_str().unwrap_or("CNY")},
            "reportStart": "2025-01-01", "reportEnd": "2025-12-31", "balanceSheetDate": "2025-12-31",
            "tbSource": {"inputPath": tb.to_string_lossy(), "sheet": tb_i["sheet"], "headerRow": tb_i["headerRow"], "headerDepth": 1},
            "jeSource": {"inputPath": je.to_string_lossy(), "sheet": je_i["sheet"], "headerRow": je_i["headerRow"], "headerDepth": 1},
            "tbMapping": tb_i["suggestedMapping"],
            "jeMapping": je_i["suggestedMapping"],
        });
        println!(
            "
══════ 4800 完整测算"
        );
        println!(
            "  TB uniformCurrency（本位币预填值）= {}",
            tb_i["uniformCurrency"]
        );
        println!(
            "  TB functionalCurrency 映射到 = {}",
            tb_i["suggestedMapping"]["functionalCurrency"]
        );
        println!(
            "  TB currency 映射到 = {}",
            tb_i["suggestedMapping"]["currency"]
        );
        match audit_toolbox_lib::engine_call_for_test("fx.preview_probe", params) {
            Ok(v) => {
                let s = &v["summary"];
                println!(
                    "  未实现缺少TB余额基础的键数: {}",
                    s["unrealizedMissingBalanceKeys"]
                );
                println!("  余额基础完整: {}", s["unrealizedBalanceBasisComplete"]);
                println!("  已实现: {}", s["realizedGainLoss"]);
                println!("  未实现: {}", s["unrealizedAdjustment"]);
                println!("  TB汇兑损益: {}", s["tbFxGainLoss"]);
                println!("  差异率: {}", s["differenceRatio"]);
                println!(
                    "  滚动校验通过: {} 失配 {}",
                    s["rollforwardPassed"], s["rollforwardIssueCount"]
                );
                // 缺少 TB 余额基础的账户明细
                if let Some(q) = v["dataQuality"].as_array() {
                    let mut shown = 0;
                    for item in q {
                        if item["type"] == "未实现测算缺少TB余额基础" && shown < 6 {
                            println!(
                                "    缺基础: {} / {} / {}",
                                item["entity"], item["account"], item["currency"]
                            );
                            shown += 1;
                        }
                    }
                }
                // 分类分布：看自动分类生效没有
                if let Some(c) = v["classificationControls"].as_array() {
                    let mut counts = std::collections::BTreeMap::<String, usize>::new();
                    for item in c {
                        *counts
                            .entry(item["classification"].as_str().unwrap_or("?").into())
                            .or_default() += 1;
                    }
                    println!("  凭证分类分布: {counts:?}");
                }
            }
            Err(e) => println!(
                "  失败：{}",
                format!("{e:?}").chars().take(400).collect::<String>()
            ),
        }
        return;
    }
    println!("（没找到 4800 样例）");
}

/// 只读：看 TB 的本位币预填值判出来没有。
#[test]
#[ignore = "依赖本机样例目录，手工调查用"]
fn survey_uniform_currency() {
    for dir in sample_dirs() {
        let tb = dir.join("TB-4800.xlsx");
        if !tb.is_file() {
            continue;
        }
        let v = audit_toolbox_lib::engine_call_for_test(
            "fx.inspect_tb",
            serde_json::json!({"source": {"inputPath": tb.to_string_lossy()}}),
        )
        .expect("inspect 应当成功");
        println!(
            "
══════ TB-4800 本位币识别"
        );
        println!("  uniformCurrency（前端预填值）= {}", v["uniformCurrency"]);
        println!(
            "  functionalCurrency 映射列   = {}",
            v["suggestedMapping"]["functionalCurrency"]
        );
        println!(
            "  currency 映射列             = {}",
            v["suggestedMapping"]["currency"]
        );
        println!(
            "  currencyText 映射列         = {}",
            v["suggestedMapping"]["currencyText"]
        );
        return;
    }
    println!("（没找到 TB-4800）");
}

/// 跑一遍真实 4800 TB＋JE 的完整测算，把「未覆盖账面金额」拆开看是哪些凭证、
/// 为什么没进测算，以及 TB 勾稽与余额滚动校验的结论。
///
/// ```text
/// cargo test --release --test mapping_survey survey_4800_preview -- --ignored --nocapture
/// ```
#[test]
#[ignore = "依赖本机样例目录与汇率缓存，手工调查用"]
fn survey_4800_preview() {
    use std::collections::BTreeMap;
    let Some(dir) = sample_dirs().into_iter().find(|d| d.join("TB-4800.xlsx").is_file()) else {
        println!("（没找到 TB-4800 样例）");
        return;
    };
    let tb_path = dir.join("TB-4800.xlsx");
    let je_path = dir.join("4800_JE_2025.01-12.xlsx");
    let mut params = serde_json::Map::new();
    let mut accounts: Vec<String> = Vec::new();
    for (kind, path, src_key, map_key) in [
        ("tb", &tb_path, "tbSource", "tbMapping"),
        ("je", &je_path, "jeSource", "jeMapping"),
    ] {
        let source = serde_json::json!({"inputPath": path.to_string_lossy()});
        let inspection = audit_toolbox_lib::engine_call_for_test(
            &format!("fx.inspect_{kind}"),
            serde_json::json!({"source": source.clone()}),
        )
        .expect("inspect 应当成功");
        params.insert(src_key.into(), source);
        params.insert(map_key.into(), inspection["suggestedMapping"].clone());
        for a in inspection["accounts"].as_array().into_iter().flatten() {
            if let Some(a) = a.as_str() {
                accounts.push(a.to_owned());
            }
        }
    }
    params.insert("mode".into(), serde_json::json!("combined"));
    params.insert("reportStart".into(), serde_json::json!("2025-01-01"));
    params.insert("reportEnd".into(), serde_json::json!("2025-12-31"));
    params.insert("fixedEntity".into(), serde_json::json!("4800"));
    params.insert(
        "entityCurrencies".into(),
        serde_json::json!({"4800": "USD"}),
    );
    let result = match audit_toolbox_lib::engine_call_for_test(
        "fx.preview_probe",
        serde_json::Value::Object(params),
    ) {
        Ok(v) => v,
        Err(e) => {
            println!("测算失败：{e:?}");
            return;
        }
    };
    println!("\n══════ 4800 测算摘要");
    if let Some(summary) = result["summary"].as_object() {
        let mut keys: Vec<&String> = summary.keys().collect();
        keys.sort();
        for key in keys {
            println!("    {key:<38} {}", summary[key]);
        }
    }
    println!("\n══════ 未覆盖凭证（classificationControls）");
    let controls = result["classificationControls"].as_array().cloned().unwrap_or_default();
    println!("  共 {} 条", controls.len());
    let mut by_class: BTreeMap<String, (usize, f64)> = Default::default();
    let mut by_status: BTreeMap<String, usize> = Default::default();
    let mut by_category: BTreeMap<String, (usize, f64)> = Default::default();
    for item in &controls {
        let booked = item["bookedFxGainLoss"].as_f64().unwrap_or(0.0);
        let e = by_class
            .entry(item["classification"].as_str().unwrap_or("?").to_owned())
            .or_default();
        e.0 += 1;
        e.1 += booked;
        *by_status
            .entry(item["measurementStatus"].as_str().unwrap_or("?").to_owned())
            .or_default() += 1;
        let c = by_category
            .entry(item["systemCategory"].as_str().unwrap_or("?").to_owned())
            .or_default();
        c.0 += 1;
        c.1 += booked;
    }
    println!("  按分类：");
    for (k, (n, amount)) in &by_class {
        println!("    {k:<24} {n:>5} 张   账面 {amount:>18.2}");
    }
    println!("  按测算状态：");
    for (k, n) in &by_status {
        println!("    {k:<52} {n:>5} 张");
    }
    println!("  按系统归因：");
    for (k, (n, amount)) in &by_category {
        println!("    {k:<24} {n:>5} 张   账面 {amount:>18.2}");
    }
    println!("  前 3 条样例：");
    for item in controls.iter().take(3) {
        println!("    {}", serde_json::to_string(item).unwrap_or_default());
    }
    println!("\n══════ 客户重估凭证识别");
    let crv = result["clientRevaluationVouchers"].as_array().cloned().unwrap_or_default();
    println!("  clientRevaluationVouchers 共 {} 条", crv.len());
    for item in crv.iter().take(3) {
        println!("    {}", serde_json::to_string(item).unwrap_or_default());
    }
    println!("\n══════ TB 勾稽 reconciliation");
    println!("  {}", serde_json::to_string_pretty(&result["reconciliation"]).unwrap_or_default().chars().take(3000).collect::<String>());
    println!("\n══════ 余额滚动校验 balanceRollforwardValidation");
    let brv = &result["balanceRollforwardValidation"];
    println!("  passed={} issues={}",
        brv["passed"], brv["issues"].as_array().map(|a| a.len()).unwrap_or(0));
    for item in brv["issues"].as_array().into_iter().flatten().take(5) {
        println!("    {}", serde_json::to_string(item).unwrap_or_default());
    }
    println!("\n══════ validation（映射与数据质量校验）");
    println!("  {}", serde_json::to_string_pretty(&result["validation"]).unwrap_or_default().chars().take(2000).collect::<String>());
    println!("\n══════ dataQuality 前 10 类");
    let mut quality_types: BTreeMap<String, usize> = Default::default();
    for item in result["dataQuality"].as_array().into_iter().flatten() {
        *quality_types
            .entry(format!("{}/{}",
                item["type"].as_str().unwrap_or("?"),
                item["severity"].as_str().unwrap_or("?")))
            .or_default() += 1;
    }
    for (k, n) in quality_types.iter().take(10) {
        println!("    {k:<44} {n:>6}");
    }
    println!("
══════ TB 粒度不足清单（界面会显著提示这一块）");
    for item in result["tbGranularityBlocked"].as_array().into_iter().flatten() {
        println!("    [{}] {}  币种 {}",
            item["type"].as_str().unwrap_or("?"),
            item["account"].as_str().unwrap_or(""),
            item["currencies"]);
    }
    println!("
══════ 被隔离的科目明细");
    for item in result["dataQuality"].as_array().into_iter().flatten() {
        if item["severity"].as_str() == Some("隔离") {
            println!("    [{}] 第{}行 {}",
                item["type"].as_str().unwrap_or("?"),
                item["row"],
                item["account"].as_str().unwrap_or(""));
        }
    }
}
