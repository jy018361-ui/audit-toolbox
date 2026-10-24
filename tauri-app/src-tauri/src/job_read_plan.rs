//! 文件任务的读取模式与监控使用同一计划；批量任务按实际逐组工作集规划。
use crate::disk_table::{self, ReadPlan};
use serde_json::Value;
use std::path::PathBuf;

struct Source {
    path: PathBuf,
    sheet: Option<String>,
}

impl Source {
    fn from(value: &Value) -> Option<Self> {
        let path = PathBuf::from(value.get("inputPath").or_else(|| value.get("path"))?.as_str()?);
        if !path.is_file() { return None; }
        Some(Self { path, sheet:value.get("sheet").and_then(Value::as_str)
            .filter(|sheet| !sheet.trim().is_empty()).map(str::to_owned) })
    }

    fn direct(params: &Value, path: &str, sheet: &str) -> Option<Self> {
        Self::from(&serde_json::json!({"path":params.get(path)?, "sheet":params.get(sheet)}))
    }
}

fn decide(sources: &[&Source], factor: u64) -> bool {
    !sources.is_empty() && disk_table::should_use_disk_for_sheets(&sources.iter()
        .map(|source| (source.path.as_path(), source.sheet.as_deref())).collect::<Vec<_>>(), factor)
}

fn add(plan: &mut ReadPlan, sources: &[&Source], disk: bool) {
    for source in sources { plan.add(&source.path, disk); }
}

fn ledger_group(plan: &mut ReadPlan, params: &Value, factor: u64) {
    let tb = params.get("tbSource").and_then(Source::from);
    let je = params.get("jeSource").and_then(Source::from);
    let sources = tb.iter().chain(je.iter()).collect::<Vec<_>>();
    let forced = params["__largeJeDiskMode"].as_bool() == Some(true);
    let joint = forced || decide(&sources, factor);
    // TB 的完整层级分析另有四倍工作集，不能只监控 JE 的联合倍率。
    if let Some(tb) = &tb { add(plan, &[tb], joint || decide(&[tb], 4)); }
    if let Some(je) = &je { add(plan, &[je], joint || decide(&[je], 1)); }
}

pub(super) fn for_job(method: &str, params: &Value) -> Option<ReadPlan> {
    if method.starts_with("loan.") { return crate::loan_interest::job_read_plan(method, params); }
    let mut plan = ReadPlan::default();
    match method {
        // 这些任务只访问牌价/已保存匹配结果，忽略历史任务残留的源表参数。
        "fx.fetch_rates" | "fx.export_rates" | "fuzzy.export" => {},
        "fx.preview" | "fx.export" | "deposit.preview" | "deposit.export"
        | "fa.tbje_preview" | "fa.tbje_export" | "tbje_check.run" | "tbje_check.export" => {
            if params.get("tbSource").is_none() && params.get("jeSource").is_none() { return None; }
            ledger_group(&mut plan, params, if method.starts_with("fa.") { 8 } else { 2 });
        }
        "tbje_check.run_batch" | "tbje_check.export_batch" => {
            let groups = params.get("groups")?.as_array()?;
            // 顺序执行的组不能合并成一个同时驻留的工作集；预检也使用同一组计划。
            for group in groups { ledger_group(&mut plan, group, 2); }
        }
        "fuzzy.match" => {
            if params.get("sourceA").is_none() && params.get("sourceB").is_none() { return None; }
            let a = params.get("sourceA").and_then(Source::from);
            let b = params.get("sourceB").and_then(Source::from);
            let sources = a.iter().chain(b.iter()).collect::<Vec<_>>();
            let disk = params["__forceDisk"].as_bool() == Some(true) || decide(&sources, 2);
            add(&mut plan, &sources, disk);
        }
        "fa.match" | "fa.preview" | "fa.export" | "fa.policy_export" => {
            if params.get("beginPath").is_none() && params.get("endPath").is_none() { return None; }
            let begin = Source::direct(params, "beginPath", "beginSheet");
            let end = Source::direct(params, "endPath", "endSheet");
            let sources = begin.iter().chain(end.iter()).collect::<Vec<_>>();
            let supplements = ["additionSupplement", "disposalSupplement"].into_iter()
                .filter_map(|key| params.get(key).and_then(Source::from)).collect::<Vec<_>>();
            let disk = params["__forceDisk"].as_bool() == Some(true) || decide(&sources, 12)
                || supplements.iter().any(|source| decide(&[source], 1));
            // 大补充表也进入完整磁盘合并，使补充数据沿用逐行读取路径。
            add(&mut plan, &sources, disk);
            for source in &supplements { add(&mut plan, &[source], disk); }
        }
        "fa.dep_export" => {
            let source = Source::direct(params, "path", "sheet")?;
            let disk = params["__forceDisk"].as_bool() == Some(true) || decide(&[&source], 1);
            add(&mut plan, &[&source], disk);
        }
        _ if method.starts_with("kanzhang.") => {
            let source = Source::direct(params, "inputPath", "sheet")?;
            let disk = decide(&[&source], 1);
            add(&mut plan, &[&source], disk);
        }
        _ => return None,
    }
    Some(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resource_budget::{MemoryStatus, with_test_memory};
    use serde_json::json;
    use std::{fs, io::Write, path::Path};
    const GIB: u64 = 1024 * 1024 * 1024;

    fn low() -> MemoryStatus {
        MemoryStatus { total:16*GIB, available:GIB/8, commit_available:GIB/8 }
    }

    fn sparse(path: &Path, mib: u64) {
        fs::File::create(path).unwrap().set_len(mib*1024*1024).unwrap();
    }

    #[test]
    fn table_job_read_plans_exclude_unselected_sheets_for_all_streaming_tools() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("多表.xlsx");
        let mut archive = zip::ZipWriter::new(fs::File::create(&input).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, text) in [
            ("xl/workbook.xml", "<workbook><sheets><sheet name=\"本次\" r:id=\"r1\"/><sheet name=\"其他\" r:id=\"r2\"/></sheets></workbook>"),
            ("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"r1\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"r2\" Target=\"worksheets/sheet2.xml\"/></Relationships>"),
            ("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>"),
        ] {
            archive.start_file(name, options).unwrap();
            archive.write_all(text.as_bytes()).unwrap();
        }
        archive.start_file("xl/worksheets/sheet2.xml", options).unwrap();
        for _ in 0..1024 { archive.write_all(&[b' '; 65536]).unwrap(); }
        archive.finish().unwrap();
        let source = json!({"inputPath":input,"path":input,"sheet":"本次"});
        let params = json!({"tbSource":source,"jeSource":source,
            "sourceA":source,"sourceB":source,"inputPath":input,"path":input,"sheet":"本次",
            "beginPath":input,"endPath":input,"beginSheet":"本次","endSheet":"本次"});
        with_test_memory(low(), || {
            assert!(disk_table::should_use_disk(&[&input], 1));
            for method in ["fx.preview", "fx.export", "deposit.preview", "deposit.export",
                "fa.tbje_preview", "fa.tbje_export", "tbje_check.run", "tbje_check.export",
                "fuzzy.match", "fa.match", "fa.preview", "fa.export", "fa.policy_export", "fa.dep_export",
                "kanzhang.inspect", "kanzhang.accounts", "kanzhang.map", "kanzhang.filter",
                "kanzhang.pivot", "kanzhang.export", "kanzhang.mark_inspect", "kanzhang.mark_export"] {
                let plan = for_job(method, &params).unwrap();
                assert!(!plan.uses_disk(), "{method} 不应被其他Sheet开启暂停保护");
                assert!(!super::super::memory_protected_job(method, &params), "{method}");
                let _guard = plan.enter();
                assert!(!disk_table::should_use_disk(&[&input], 12), "{method} 公共读表应复用普通计划");
            }
        });
    }

    #[test]
    fn table_job_read_plans_include_tb_analysis_and_freeze_across_memory_changes() {
        let dir = tempfile::tempdir().unwrap();
        let tb = dir.path().join("tb.csv");
        let je = dir.path().join("je.csv");
        sparse(&tb, 8);
        fs::write(&je, "日期,科目,借方,贷方\n2026-01-01,1002,1,0\n").unwrap();
        let params = json!({"tbSource":{"inputPath":tb},"jeSource":{"inputPath":je}});
        with_test_memory(low(), || {
            assert!(!disk_table::should_use_disk(&[&tb, &je], 2));
            assert!(disk_table::should_use_disk(&[&tb], 4));
            for method in ["fx.preview", "deposit.preview", "tbje_check.run", "fa.tbje_preview"] {
                let plan = for_job(method, &params).unwrap();
                assert!(plan.uses_disk(), "{method} 必须覆盖实际TB层级分析");
                let _guard = plan.enter();
                with_test_memory(MemoryStatus { total:64*GIB, available:60*GIB, commit_available:60*GIB }, || {
                    assert!(disk_table::should_use_disk(&[&tb], 1), "{method} 不能在启动等待后切回整表读取");
                });
            }
        });
    }

    #[test]
    fn table_job_read_plan_batches_use_per_group_budget_including_preflight() {
        let dir = tempfile::tempdir().unwrap();
        let paths = (0..4).map(|index| {
            let path = dir.path().join(format!("{index}.csv"));
            sparse(&path, 2);
            path
        }).collect::<Vec<_>>();
        let params = json!({"prepareMappings":true,"groups":[
            {"tbSource":{"inputPath":paths[0]},"jeSource":{"inputPath":paths[1]}},
            {"tbSource":{"inputPath":paths[2]},"jeSource":{"inputPath":paths[3]}}
        ]});
        with_test_memory(low(), || {
            assert!(disk_table::should_use_disk(&paths.iter().map(PathBuf::as_path).collect::<Vec<_>>(), 4));
            for method in ["tbje_check.run_batch", "tbje_check.export_batch"] {
                assert!(!for_job(method, &params).unwrap().uses_disk(), "逐组执行不能按整批同时驻留估算");
                assert!(!super::super::memory_protected_job(method, &params));
            }
            sparse(&paths[0], 8);
            assert!(for_job("tbje_check.run_batch", &params).unwrap().uses_disk(), "大表预检继续受暂停恢复控制");
        });
    }

    #[test]
    fn table_job_read_plan_ignores_unused_sources_but_streams_large_fa_supplements() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("清单.csv");
        let large = dir.path().join("补充.csv");
        fs::write(&small, "编号,名称\n1,电脑\n").unwrap();
        sparse(&large, 32);
        let params = json!({"tbSource":{"inputPath":large},"sourceA":{"path":large},
            "beginPath":small,"endPath":small,"additionSupplement":{"path":large}});
        with_test_memory(low(), || {
            for method in ["fx.fetch_rates", "fx.export_rates", "fuzzy.export"] {
                assert!(!for_job(method, &params).unwrap().uses_disk(), "{method} 不读取历史源表");
                assert!(!super::super::memory_protected_job(method, &params));
            }
            let plan = for_job("fa.match", &params).unwrap();
            assert!(plan.uses_disk());
            let _guard = plan.enter();
            assert!(disk_table::should_use_disk(&[&small], 12), "补充表过大时整条FA合并走磁盘");
            assert!(disk_table::should_use_disk(&[&large], 1));
        });
        // TS 当前走完整内存表与Parquet缓存，未宣称已有本模块的分批读取分支。
        assert!(for_job("ts.inspect", &params).is_none());
    }
}
