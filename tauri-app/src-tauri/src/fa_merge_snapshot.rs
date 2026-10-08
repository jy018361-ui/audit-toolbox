//! `fa.match` 匹配结果的磁盘快照：导出直接复用「开始匹配」那一次的合并
//! 结果，不再重新读表、重新配对。
//!
//! 流程契约：匹配之后改了输入/映射/补充清单，应回第一步重新匹配（按钮
//! 变为「重新开始匹配」）。因此快照按「文件对身份」（两份主文件的规范
//! 路径＋大小＋修改时间）为键取最近一次匹配，导出时命中即复用；指纹
//! （合并相关参数＋文件身份）不一致也不回退重算——保证导出套表与第一步
//! 展示的统计永远同源，只在完成消息里提示「其后有改动，建议重新匹配」。
//!
//! 快照内容：合并行（来源/匹配值/b 列/e 列/extra JSON）写 snappy Parquet，
//! 统计与生效参数写 JSON sidecar。期初/期末两张表本体不进快照，加载时经
//! [`crate::fa_table_cache`] 原路取回并逐位比对表头防错配。任何一步走不通
//! 都视为快照不可用，调用方退回现场合并；写入尽力而为，失败不影响本次
//! 匹配。`.parquet`/`.json` 扩展名都在看账缓存的清扫清单里，随容量保护
//! 一起淘汰。

use std::{collections::BTreeMap, fs, fs::File, path::{Path, PathBuf}, time::Instant};

use polars::prelude::*;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::fa::{Cell, JoinedRow, MergeResult, Table};

/// 参与指纹与「导出生效参数」回放的合并相关字段。表日、输出路径、展示名
/// 等属于导出阶段的设置，始终用导出时的当前值。
const MERGE_PARAM_FIELDS: &[&str] = &[
    "beginPath",
    "beginSheet",
    "beginHeaderRow",
    "endPath",
    "endSheet",
    "endHeaderRow",
    "beginKeys",
    "endKeys",
    "beginMapping",
    "endMapping",
    "beginOriginalValue",
    "endOriginalValue",
    "beginDepreciation",
    "endDepreciation",
    "removeSpaces",
    "caseSensitive",
    "additionSupplement",
    "disposalSupplement",
];

pub(crate) struct LoadedSnapshot {
    pub(crate) result: MergeResult,
    /// 白名单字段换成快照里的匹配时取值、其余保持当前值的导出生效参数。
    pub(crate) effective_params: Value,
    /// 合并相关参数与上次匹配是否逐位一致；不一致只提示，不回退重算。
    pub(crate) matches_current: bool,
}

/// 把 merge() 会读到的参数字段挑出来，作为指纹与回放的载体。
fn merge_params_subset(params: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(object) = params.as_object() {
        for field in MERGE_PARAM_FIELDS {
            if let Some(value) = object.get(*field) {
                out.insert((*field).to_owned(), value.clone());
            }
        }
    }
    out
}

fn file_identity(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    Some(format!(
        "{}|{}|{}",
        fs::canonicalize(path).ok()?.to_string_lossy(),
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs()
    ))
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 文件对身份：两份主文件任何一份被替换或改动（大小/修改时间变化），
/// 都视作另一对文件，快照自然失效。
fn pair_key(params: &Value) -> Option<String> {
    let begin = file_identity(Path::new(params.get("beginPath")?.as_str()?))?;
    let end = file_identity(Path::new(params.get("endPath")?.as_str()?))?;
    Some(hash_text(&format!("{begin}\n{end}")))
}

/// 合并相关参数＋相关文件身份的指纹：判定「导出时的配置」与「上次匹配
/// 时的配置」是否逐位一致。
fn fingerprint(params: &Value) -> Option<String> {
    let subset = merge_params_subset(params);
    let mut material = serde_json::to_string(&subset).ok()?;
    for field in ["additionSupplement", "disposalSupplement"] {
        if let Some(path) = subset
            .get(field)
            .and_then(|config| config.get("path"))
            .and_then(Value::as_str)
        {
            if let Some(identity) = file_identity(Path::new(path)) {
                material.push('\n');
                material.push_str(&identity);
            }
        }
    }
    Some(hash_text(&material))
}

fn snapshot_dir() -> Option<PathBuf> {
    Some(crate::tabular::cache_root().ok()?.join("fa-merge").join("v1"))
}

fn extra_to_json(row: &JoinedRow) -> String {
    let items: Vec<Value> = row
        .extra
        .iter()
        .map(|(key, cell)| match cell {
            Cell::Text(text) => json!({"k": key, "v": text}),
            Cell::Number(number) => json!({"k": key, "n": number}),
        })
        .collect();
    serde_json::to_string(&Value::Array(items)).unwrap_or_default()
}

fn extra_from_json(text: &str) -> BTreeMap<String, Cell> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else {
        return BTreeMap::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let key = item.get("k")?.as_str()?.to_owned();
            let cell = match item.get("n").and_then(Value::as_f64) {
                Some(number) => Cell::Number(number),
                None => Cell::Text(item.get("v").and_then(Value::as_str).unwrap_or_default().to_owned()),
            };
            Some((key, cell))
        })
        .collect()
}

/// 匹配完成后落快照：尽力而为，任何失败都静默放弃（不影响本次匹配）。
pub(crate) fn save(params: &Value, result: &MergeResult) {
    let Some(dir) = snapshot_dir() else { return };
    let Some(key) = pair_key(params) else { return };
    let Some(print) = fingerprint(params) else { return };
    let started = Instant::now();
    let height = result.rows.len();
    let mut columns = vec![
        Column::new(
            "source".into(),
            result.rows.iter().map(|row| row.source.to_owned()).collect::<Vec<_>>(),
        ),
        Column::new(
            "match_value".into(),
            result.rows.iter().map(|row| row.match_value.clone()).collect::<Vec<_>>(),
        ),
        Column::new(
            "extra".into(),
            result.rows.iter().map(extra_to_json).collect::<Vec<_>>(),
        ),
    ];
    for index in 0..result.begin.headers.len() {
        columns.push(Column::new(
            format!("b{index}").into(),
            result
                .rows
                .iter()
                .map(|row| {
                    row.begin
                        .as_ref()
                        .and_then(|cells| cells.get(index).cloned())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>(),
        ));
    }
    for index in 0..result.end.headers.len() {
        columns.push(Column::new(
            format!("e{index}").into(),
            result
                .rows
                .iter()
                .map(|row| {
                    row.end
                        .as_ref()
                        .and_then(|cells| cells.get(index).cloned())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>(),
        ));
    }
    let Ok(mut frame) = DataFrame::new(height, columns) else {
        return;
    };
    let parquet = dir.join(format!("{key}.parquet"));
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let partial = parquet.with_extension("parquet.partial");
    let _ = fs::remove_file(&partial);
    let Ok(mut file) = File::create(&partial) else { return };
    if ParquetWriter::new(&mut file)
        .with_compression(ParquetCompression::Snappy)
        .finish(&mut frame)
        .is_err()
    {
        let _ = fs::remove_file(&partial);
        return;
    }
    if crate::tabular::replace_file(&partial, &parquet).is_err() {
        let _ = fs::remove_file(&partial);
        return;
    }
    let sidecar = dir.join(format!("{key}.json"));
    let meta = json!({
        "fingerprint": print,
        "mergeParams": Value::Object(merge_params_subset(params)),
        "beginKeys": result.begin_keys,
        "endKeys": result.end_keys,
        "duplicateValues": result.duplicate_values,
        "duplicateRows": result.duplicate_rows,
        "unmatchedAddition": result.unmatched_addition,
        "unmatchedDisposal": result.unmatched_disposal,
        "beginTable": table_meta(&result.begin),
        "endTable": table_meta(&result.end),
    });
    let sidecar_partial = sidecar.with_extension("json.partial");
    if fs::write(&sidecar_partial, meta.to_string()).is_ok() {
        let _ = crate::tabular::replace_file(&sidecar_partial, &sidecar);
    }
    eprintln!(
        "FA 匹配快照写入（{} 行 x {} 列，落盘 {:.1}s）",
        result.rows.len(),
        result.begin.headers.len() + result.end.headers.len(),
        started.elapsed().as_secs_f64()
    );
}

fn table_meta(table: &Table) -> Value {
    json!({
        "path": table.path.to_string_lossy(),
        "sheet": table.sheet,
        "headerRow": table.header_row,
        "headers": table.headers,
    })
}

fn strings_column(frame: &DataFrame, name: &str) -> Option<Vec<String>> {
    let series = frame.column(name).ok()?;
    let chunked = series.str().ok()?.clone();
    Some(
        (0..series.len())
            .map(|index| chunked.get(index).unwrap_or_default().to_owned())
            .collect(),
    )
}

fn string_list(meta: &Value, field: &str) -> Option<Vec<String>> {
    Some(
        meta.get(field)?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    )
}

fn string_matrix(meta: &Value, field: &str) -> Option<Vec<Vec<String>>> {
    meta.get(field)?
        .as_array()?
        .iter()
        .map(|row| {
            row.as_array().map(|cells| {
                cells
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
        })
        .collect()
}

fn load_table_from_meta(meta: &Value) -> Option<Table> {
    let path = Path::new(meta.get("path")?.as_str()?);
    let sheet = meta.get("sheet").and_then(Value::as_str);
    let header = meta
        .get("headerRow")
        .and_then(Value::as_u64)
        .map(|row| row as usize);
    let table = crate::fa_table_cache::load_table_cached(path, sheet, header, false).ok()?;
    let headers = string_list(meta, "headers")?;
    if table.headers != headers {
        // 表头对不上说明源文件结构已变（缓存层自洽但内容换了），快照作废。
        return None;
    }
    Some(table)
}

/// 导出前取最近一次匹配的快照：没有（换了文件对、首次使用、快照损坏）
/// 返回 None，由调用方现场合并。
pub(crate) fn load(params: &Value) -> Option<LoadedSnapshot> {
    let dir = snapshot_dir()?;
    let key = pair_key(params)?;
    let parquet = dir.join(format!("{key}.parquet"));
    let sidecar = dir.join(format!("{key}.json"));
    if !parquet.is_file() || !sidecar.is_file() {
        return None;
    }
    let started = Instant::now();
    let meta: Value = serde_json::from_str(&fs::read_to_string(&sidecar).ok()?).ok()?;
    let frame = ParquetReader::new(File::open(&parquet).ok()?).finish().ok()?;
    let source_column = strings_column(&frame, "source")?;
    let match_column = strings_column(&frame, "match_value")?;
    let extra_column = strings_column(&frame, "extra")?;
    let begin = load_table_from_meta(meta.get("beginTable")?)?;
    let end = load_table_from_meta(meta.get("endTable")?)?;
    let begin_width = begin.headers.len();
    let end_width = end.headers.len();
    let mut begin_cells = Vec::with_capacity(begin_width);
    for index in 0..begin_width {
        begin_cells.push(strings_column(&frame, &format!("b{index}"))?);
    }
    let mut end_cells = Vec::with_capacity(end_width);
    for index in 0..end_width {
        end_cells.push(strings_column(&frame, &format!("e{index}"))?);
    }
    let rows = source_column
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let source = match source.as_str() {
                "两文件都有" => "两文件都有",
                "仅文件1" => "仅文件1",
                _ => "仅文件2",
            };
            let begin_row = (source != "仅文件2").then(|| {
                (0..begin_width)
                    .map(|column| begin_cells[column][index].clone())
                    .collect()
            });
            let end_row = (source != "仅文件1").then(|| {
                (0..end_width)
                    .map(|column| end_cells[column][index].clone())
                    .collect()
            });
            JoinedRow {
                begin: begin_row,
                end: end_row,
                source,
                match_value: match_column[index].clone(),
                extra: extra_from_json(&extra_column[index]),
            }
        })
        .collect();
    let result = MergeResult {
        begin,
        end,
        rows,
        begin_keys: string_list(&meta, "beginKeys")?,
        end_keys: string_list(&meta, "endKeys")?,
        duplicate_values: meta.get("duplicateValues")?.as_u64()? as usize,
        duplicate_rows: meta.get("duplicateRows")?.as_u64()? as usize,
        unmatched_addition: string_matrix(&meta, "unmatchedAddition").unwrap_or_default(),
        unmatched_disposal: string_matrix(&meta, "unmatchedDisposal").unwrap_or_default(),
    };
    let mut effective = params.clone();
    let stored = meta.get("mergeParams")?.as_object()?.clone();
    if let Some(object) = effective.as_object_mut() {
        for field in MERGE_PARAM_FIELDS {
            match stored.get(*field) {
                Some(value) => {
                    object.insert((*field).to_owned(), value.clone());
                }
                None => {
                    object.remove(*field);
                }
            }
        }
    }
    let matches_current =
        meta.get("fingerprint")?.as_str()? == fingerprint(params)?.as_str();
    eprintln!(
        "FA 匹配快照命中（{} 行，载入 {:.1}s，与当前配置{}）",
        result.rows.len(),
        started.elapsed().as_secs_f64(),
        if matches_current { "一致" } else { "不一致" }
    );
    Some(LoadedSnapshot {
        result,
        effective_params: effective,
        matches_current,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn write_csv(path: &Path, header: &str, rows: &[&str]) {
        let mut text = String::from(header);
        for row in rows {
            text.push('\n');
            text.push_str(row);
        }
        fs::write(path, text).unwrap();
    }

    fn params(begin: &Path, end: &Path) -> Value {
        json!({
            "beginPath": begin.to_string_lossy(),
            "endPath": end.to_string_lossy(),
            "beginKeys": ["编号"],
            "endKeys": ["编号"],
            "beginMapping": {"originalValue": "原值"},
            "endMapping": {"originalValue": "原值"},
        })
    }

    fn merge(params: &Value) -> crate::fa::MergeResult {
        crate::fa::merge(params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap()
    }

    #[test]
    fn snapshot_roundtrip_and_param_replay() {
        let dir = tempfile::tempdir().unwrap();
        let begin = dir.path().join("期初.csv");
        let end = dir.path().join("期末.csv");
        write_csv(&begin, "编号,原值", &["A1,100", "A2,200"]);
        write_csv(&end, "编号,原值", &["A1,120", "B1,80"]);
        let mut params = params(&begin, &end);
        let result = merge(&params);
        save(&params, &result);

        let loaded = load(&params).unwrap();
        assert!(loaded.matches_current);
        assert_eq!(loaded.result.rows.len(), result.rows.len());
        assert_eq!(
            loaded
                .result
                .rows
                .iter()
                .map(|row| (row.source, row.match_value.clone()))
                .collect::<Vec<_>>(),
            result
                .rows
                .iter()
                .map(|row| (row.source, row.match_value.clone()))
                .collect::<Vec<_>>()
        );
        // 行体逐列回放一致（含仅单侧的行）。
        for (restored, origin) in loaded.result.rows.iter().zip(result.rows.iter()) {
            assert_eq!(restored.begin, origin.begin);
            assert_eq!(restored.end, origin.end);
            assert_eq!(restored.extra, origin.extra);
        }

        // 匹配后改映射、不重新匹配：导出仍复用上次匹配，且生效参数回到
        // 匹配时的取值（与第一步统计同源），只标记配置不一致。
        params["endMapping"]["originalValue"] = json!("原值2");
        let loaded = load(&params).unwrap();
        assert!(!loaded.matches_current);
        assert_eq!(
            loaded.effective_params["endMapping"]["originalValue"],
            json!("原值")
        );
    }

    #[test]
    fn snapshot_invalidates_for_new_pair_or_edited_file() {
        let dir = tempfile::tempdir().unwrap();
        let begin = dir.path().join("期初.csv");
        let end = dir.path().join("期末.csv");
        let other = dir.path().join("另一期末.csv");
        write_csv(&begin, "编号,原值", &["A1,100"]);
        write_csv(&end, "编号,原值", &["A1,120"]);
        write_csv(&other, "编号,原值", &["A1,120"]);
        let result = merge(&params(&begin, &end));
        save(&params(&begin, &end), &result);

        // 换期末文件：另一对文件，无快照。
        assert!(load(&params(&begin, &other)).is_none());
        // 原文件被续写：文件身份变化，快照作废。
        write_csv(&end, "编号,原值", &["A1,120", "A2,40"]);
        assert!(load(&params(&begin, &end)).is_none());
    }
}
