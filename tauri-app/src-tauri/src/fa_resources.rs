//! FA 分阶段资源策略：估算只决定处理方式，不能用匹配倍率阻塞交互读取。
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy)]
pub(crate) enum Phase {
    Read,
    Match,
    Export,
}

impl Phase {
    fn factor(self) -> u64 {
        match self {
            // 读取源表不创建连接索引及合并行；匹配仍计入两期表与中间结果。
            Self::Read => 1,
            Self::Match => 12,
            // 旧快照载入会物化明细；磁盘快照自身按批次读取。
            Self::Export => 4,
        }
    }
}

pub(crate) fn uses_disk(sources: &[(&Path, Option<&str>)], phase: Phase) -> bool {
    crate::disk_table::should_use_disk_for_sheets(sources, phase.factor())
}

pub(crate) fn pair_uses_disk(params: &Value, phase: Phase) -> bool {
    let sources = [("beginPath", "beginSheet"), ("endPath", "endSheet")]
        .into_iter()
        .filter_map(|(path, sheet)| {
            Some((
                Path::new(params.get(path)?.as_str()?),
                params.get(sheet).and_then(Value::as_str),
            ))
        })
        .collect::<Vec<_>>();
    let supplements = ["additionSupplement", "disposalSupplement"].into_iter()
        .filter_map(|key| params.get(key)).filter_map(|source| Some((
            Path::new(source.get("inputPath").or_else(|| source.get("path"))?.as_str()?),
            source.get("sheet").and_then(Value::as_str),
        ))).collect::<Vec<_>>();
    uses_disk(&sources, phase) || supplements.iter().any(|source| uses_disk(&[*source], Phase::Read))
}

/// 导出快照无效时仍可能重新匹配；调度保护覆盖这个分支，业务阶段各自分流。
pub(crate) fn job_uses_disk(method: &str, params: &Value) -> bool {
    let phase = match method {
        "fa.match" | "fa.preview" | "fa.export" | "fa.policy_export" => Phase::Match,
        _ => Phase::Read,
    };
    if method.starts_with("fa.dep_") {
        let Some(path) = params.get("path").and_then(Value::as_str) else {
            return false;
        };
        if !Path::new(path).is_file() {
            return false;
        }
        return uses_disk(
            &[(Path::new(path), params.get("sheet").and_then(Value::as_str))],
            Phase::Read,
        );
    }
    if !["beginPath", "endPath"].iter().any(|key| {
        params
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|path| Path::new(path).is_file())
    }) {
        return false;
    }
    pair_uses_disk(params, phase)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn fa_resource_read_match_and_export_plan_separately() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("清单.csv");
        // 50 MiB 文本：源表估算300MiB，导出1200MiB，连接3600MiB。
        std::fs::File::create(&path)
            .unwrap()
            .set_len(50 * 1024 * 1024)
            .unwrap();
        crate::resource_budget::with_test_memory(
            crate::resource_budget::MemoryStatus {
                total: 16 * GIB,
                available: 45 * GIB / 10,
                commit_available: 8 * GIB,
            },
            || {
                let sources = [(path.as_path(), None)];
                assert!(!uses_disk(&sources, Phase::Read));
                assert!(uses_disk(&sources, Phase::Match));
                assert!(!uses_disk(&sources, Phase::Export));
                let params = json!({"beginPath":path,"endPath":path,"path":path});
                assert!(!job_uses_disk("fa.inspect", &params));
                assert!(job_uses_disk("fa.match", &params));
                // 导出无法复用快照时，调度仍覆盖重新匹配的实际压力保护。
                assert!(job_uses_disk("fa.export", &params));
                assert!(!job_uses_disk("fa.dep_export", &params));
            },
        );
    }
}
