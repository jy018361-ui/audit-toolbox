//! FA 整表读取的稳定 Parquet 磁盘缓存。
//!
//! `fa.match` / `fa.export` 等 worker 每轮都把期初、期末两张大表完整解析一遍
//! （实测期初 40 秒、期末 121 秒，一轮会话还要读两遍）。本模块给
//! [`crate::fa::load_table`] 的整表读取加一层与看账（`tabular::load_ts_cached`）
//! 同款的磁盘缓存：
//!
//! * 缓存键 = 规范路径 + 文件大小 + 修改时间 + 目标表 + 标题行（含 choose_best
//!   位与格式盐），源文件一动键即失效；
//! * 表体（全字符串列）写 snappy Parquet，元数据（表名、可见表清单、标题行、
//!   行数）写同名 `.json` sidecar；两者都走临时文件＋改名原子落盘，写失败静默
//!   跳过，不影响本次返回；
//! * 未显式给标题行时，自动判定结果记在 `.header` 记事里（键为工作簿身份＋
//!   表名）。记事只由一次真实的整读写入，因此缓存命中路径与整读路径的标题行
//!   逐位一致；`.header` 扩展名在 `tabular::cache_entries` 的清扫清单里，跟着
//!   看账缓存一起按周淘汰；
//! * 缓存损坏（Parquet 或 sidecar 读不动、元数据对不上键）即删即重建，绝不让
//!   坏缓存挡住读取；目录超 2GB 时按 mtime 淘汰最老的条目回到 1.5GB 以下。
//!
//! 行为契约：同输入同输出。任何一步走不通（文本文件、无法唯一定表、缓存目录
//! 不可用）都原样透传 [`crate::fa::load_table`]，错误形态也以透传结果为准。
//!
//! 与任务口径的一处实现偏差：题目要求「未命中整读也传显式标题行」，但自动
//! 判定标题行在没有记事的冷读时无法先知——用前缀表预判又可能与全量矩阵的
//! 判定漂移。这里冷读保持原始参数（显式表＋原始标题行，即自动判定），用真实
//! 结果落记事，之后所有读取（命中键计算与未命中整读）都传显式表＋记事标题行，
//! 逐位一致性由「记事 = 真实整读的判定结果」保证，比前缀预判更严。

use std::{
    collections::HashMap,
    fs,
    fs::File,
    path::{Path, PathBuf},
    time::SystemTime,
};

use calamine::{Reader, open_workbook_auto};
use polars::prelude::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::fa::{self, Table};

/// fa-tables 缓存的容量红线：写入后超过 2GB 开始淘汰，回到 1.5GB 以下为止。
const CACHE_SOFT_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const CACHE_HARD_TARGET: u64 = 3 * 512 * 1024 * 1024;

/// 整表读取入口：语义与 [`crate::fa::load_table`] 完全一致（同输入同输出），
/// 只是先查磁盘缓存。文本文件（CSV 等）不做缓存，直接透传。
pub(crate) fn load_table_cached(
    path: &Path,
    sheet: Option<&str>,
    header: Option<usize>,
    choose_best: bool,
) -> Result<Table, AppError> {
    if crate::spreadsheet_input::is_text(path) || !path.is_file() {
        return fa::load_table(path, sheet, header, choose_best);
    }
    // 目标表：参数给了就用（fa::load_table 对同一参数的分流结果唯一确定，
    // 连隐藏表名被回退的场景也自洽）；没给才解析——choose_best 时要求自动
    // 选表能唯一收敛，收敛不了（要整表逐张打分）就放弃缓存。
    let target = match sheet.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => name.to_owned(),
        None => match resolve_target_sheet(path, header, choose_best) {
            Some(name) => name,
            None => return fa::load_table(path, sheet, header, choose_best),
        },
    };
    // 标题行：显式给的直接进键；没给的查自动判定记事。记事缺失（首次读取）
    // 时按原始参数整读（显式表＋自动判定），用真实结果补记事并落缓存。
    let header_row = match header {
        Some(row) => row,
        None => match read_header_memo(path, &target, choose_best) {
            Some(row) => row,
            None => {
                let table = fa::load_table(path, Some(&target), None, choose_best)?;
                write_header_memo(path, &target, choose_best, table.header_row);
                store_cache(path, &target, table.header_row, choose_best, &table);
                return Ok(table);
            }
        },
    };
    let Some((parquet, sidecar)) = cache_paths(path, &target, header_row, choose_best) else {
        return fa::load_table(path, sheet, header, choose_best);
    };
    if let Some(table) = read_cache(path, &target, header_row, &parquet, &sidecar) {
        return Ok(table);
    }
    let table = fa::load_table(path, Some(&target), Some(header_row), choose_best)?;
    store_cache(path, &target, header_row, choose_best, &table);
    Ok(table)
}

/// 自动选表的目标表名解析，口径与 `fa::load_table` 的候选分流完全一致：
/// 可见表清单（整本隐藏时退回全部）→ choose_best 时走 fa_sheet_pick 的
/// 记事／轻量打分 → 否则首张可见表。打不开工作簿或自动选表收敛不到唯一
/// 一张时返回 None，调用方放弃缓存。
fn resolve_target_sheet(
    path: &Path,
    header: Option<usize>,
    choose_best: bool,
) -> Option<String> {
    let mut workbook = open_workbook_auto(path).ok()?;
    let visible: Vec<String> = workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| sheet.visible == calamine::SheetVisible::Visible)
        .map(|sheet| sheet.name.clone())
        .collect();
    let sheets = if visible.is_empty() {
        workbook.sheet_names().to_vec()
    } else {
        visible
    };
    if sheets.is_empty() {
        return None;
    }
    if choose_best {
        let candidates = crate::fa_sheet_pick::auto_sheet_candidates(path, &sheets, header);
        return match candidates.len() {
            1 => candidates.into_iter().next(),
            _ => None,
        };
    }
    Some(sheets[0].clone())
}

/// 工作簿身份（规范路径＋大小＋修改时间）。
fn file_identity(path: &Path) -> Option<(PathBuf, u64, u128)> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    Some((
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf()),
        meta.len(),
        modified,
    ))
}

/// 缓存键：工作簿身份＋表名＋标题行＋choose_best 位。choose_best 只在目标表
/// 可能被自动选表回退改写时影响内容（指定了不在可见表里的表名），一并入键
/// 杜绝同键异容。
fn cache_key(
    path: &Path,
    sheet: &str,
    header_row: usize,
    choose_best: bool,
) -> Option<String> {
    let (canonical, len, modified) = file_identity(path)?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(len.to_le_bytes());
    hasher.update(modified.to_le_bytes());
    hasher.update(sheet.as_bytes());
    hasher.update(header_row.to_le_bytes());
    hasher.update([(choose_best as u8)]);
    hasher.update(b"fa-table-cache-v1");
    Some(hex::encode(hasher.finalize()))
}

/// 自动标题行记事的键：工作簿身份＋表名＋choose_best 位。
fn header_memo_key(path: &Path, sheet: &str, choose_best: bool) -> Option<String> {
    let (canonical, len, modified) = file_identity(path)?;
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(len.to_le_bytes());
    hasher.update(modified.to_le_bytes());
    hasher.update(sheet.as_bytes());
    hasher.update([(choose_best as u8)]);
    hasher.update(b"fa-table-header-memo-v1");
    Some(hex::encode(hasher.finalize()))
}

fn cache_dir() -> Option<PathBuf> {
    Some(
        crate::tabular::cache_root()
            .ok()?
            .join("fa-tables")
            .join("v1"),
    )
}

/// 表体 Parquet 与元数据 sidecar 的落盘路径（同键同名，扩展名不同）。
fn cache_paths(
    path: &Path,
    sheet: &str,
    header_row: usize,
    choose_best: bool,
) -> Option<(PathBuf, PathBuf)> {
    let key = cache_key(path, sheet, header_row, choose_best)?;
    let dir = cache_dir()?;
    Some((
        dir.join(format!("{key}.parquet")),
        dir.join(format!("{key}.json")),
    ))
}

fn header_memo_path(path: &Path, sheet: &str, choose_best: bool) -> Option<PathBuf> {
    let key = header_memo_key(path, sheet, choose_best)?;
    Some(cache_dir()?.join(format!("{key}.header")))
}

fn read_header_memo(path: &Path, sheet: &str, choose_best: bool) -> Option<usize> {
    let memo = header_memo_path(path, sheet, choose_best)?;
    let text = fs::read_to_string(memo).ok()?;
    let row = text.trim().parse::<usize>().ok()?;
    (row >= 1).then_some(row)
}

fn write_header_memo(path: &Path, sheet: &str, choose_best: bool, header_row: usize) {
    let Some(memo) = header_memo_path(path, sheet, choose_best) else {
        return;
    };
    let partial = memo.with_extension("partial");
    if fs::create_dir_all(memo.parent().unwrap_or(Path::new("."))).is_ok()
        && fs::write(&partial, header_row.to_string()).is_ok()
    {
        let _ = crate::tabular::replace_file(&partial, &memo);
    }
}

/// 读缓存：Parquet 载表体、sidecar 补元数据，任何一步失败都视为损坏——删掉
/// 缓存文件返回 None，由调用方整读重建。命中时 touch 一下 Parquet 的 mtime，
/// 让容量保护按「最后使用」而非「写入时间」淘汰。
fn read_cache(
    source: &Path,
    sheet: &str,
    header_row: usize,
    parquet: &Path,
    sidecar: &Path,
) -> Option<Table> {
    if !parquet.is_file() || !sidecar.is_file() {
        return None;
    }
    let started = std::time::Instant::now();
    let load = || -> Option<Table> {
        let meta: Value = serde_json::from_str(&fs::read_to_string(sidecar).ok()?).ok()?;
        if meta.get("sheet").and_then(Value::as_str) != Some(sheet) {
            return None;
        }
        if meta.get("headerRow").and_then(Value::as_u64) != Some(header_row as u64) {
            return None;
        }
        let frame = ParquetReader::new(File::open(parquet).ok()?).finish().ok()?;
        let headers = frame
            .get_column_names()
            .iter()
            .map(|name| name.as_str().to_owned())
            .collect::<Vec<_>>();
        if headers.is_empty() {
            return None;
        }
        let mut rows = Vec::with_capacity(frame.height());
        for index in 0..frame.height() {
            rows.push(
                frame
                    .get_row(index)
                    .ok()?
                    .0
                    .iter()
                    .map(any_to_string)
                    .collect(),
            );
        }
        let sheets = meta
            .get("sheets")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let row_count = meta
            .get("rowCount")
            .and_then(Value::as_u64)
            .unwrap_or(rows.len() as u64) as usize;
        Some(Table {
            path: source.to_path_buf(),
            sheet: Some(sheet.to_owned()),
            sheets,
            header_row,
            headers,
            row_count: row_count.max(rows.len()),
            rows,
        })
    };
    match load() {
        Some(table) => {
            touch(parquet);
            eprintln!(
                "FA 整表缓存命中 {}[{}]（{} 行 x {} 列，载入 {:.1}s）",
                source
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                sheet,
                table.rows.len(),
                table.headers.len(),
                started.elapsed().as_secs_f64()
            );
            Some(table)
        }
        None => {
            let _ = fs::remove_file(parquet);
            let _ = fs::remove_file(sidecar);
            None
        }
    }
}

/// 写缓存：表体写 snappy Parquet、元数据写 sidecar，临时文件＋改名原子落盘。
/// 任何失败都静默跳过（本次读取结果不受影响），最后做一次容量保护。
fn store_cache(
    source: &Path,
    sheet: &str,
    header_row: usize,
    choose_best: bool,
    table: &Table,
) {
    if table.headers.is_empty() {
        // 空表头没有可缓存的结构（0 列也表达不了行数），直接放弃。
        return;
    }
    let Some((parquet, sidecar)) = cache_paths(source, sheet, header_row, choose_best) else {
        return;
    };
    let started = std::time::Instant::now();
    let columns = table
        .headers
        .iter()
        .enumerate()
        .map(|(index, name)| {
            Column::new(
                name.clone().into(),
                table
                    .rows
                    .iter()
                    .map(|row| row.get(index).map(String::as_str).unwrap_or_default())
                    .collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    let mut frame = match DataFrame::new(table.rows.len(), columns) {
        Ok(frame) => frame,
        Err(_) => return,
    };
    if write_parquet(&parquet, &mut frame).is_err() {
        return;
    }
    let meta = json!({
        "sheet": sheet,
        "sheets": table.sheets,
        "headerRow": header_row,
        "rowCount": table.row_count,
    });
    let partial = sidecar.with_extension("json.partial");
    if fs::create_dir_all(sidecar.parent().unwrap_or(Path::new("."))).is_ok()
        && fs::write(&partial, meta.to_string()).is_ok()
    {
        let _ = crate::tabular::replace_file(&partial, &sidecar);
    }
    eprintln!(
        "FA 整表缓存写入 {}[{}]（{} 行 x {} 列，落盘 {:.1}s）",
        source
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        sheet,
        table.rows.len(),
        table.headers.len(),
        started.elapsed().as_secs_f64()
    );
    enforce_capacity(&parquet);
}

fn write_parquet(target: &Path, frame: &mut DataFrame) -> Result<(), ()> {
    fs::create_dir_all(target.parent().unwrap_or(Path::new("."))).map_err(|_| ())?;
    let partial = target.with_extension("parquet.partial");
    let _ = fs::remove_file(&partial);
    let mut file = File::create(&partial).map_err(|_| ())?;
    match ParquetWriter::new(&mut file)
        .with_compression(ParquetCompression::Snappy)
        .finish(frame)
    {
        Ok(_) => {
            if crate::tabular::replace_file(&partial, target).is_err() {
                let _ = fs::remove_file(&partial);
                return Err(());
            }
            Ok(())
        }
        Err(_) => {
            let _ = fs::remove_file(&partial);
            Err(())
        }
    }
}

fn any_to_string(value: &AnyValue<'_>) -> String {
    match value {
        AnyValue::Null => String::new(),
        AnyValue::String(value) => (*value).to_owned(),
        _ => value.to_string(),
    }
}

fn touch(path: &Path) {
    let _ = fs::File::options()
        .append(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now()));
}

/// 容量保护：fa-tables 目录（含 v1 子目录）超过 2GB 时按 mtime 从老到新整组
/// 删除（同键的 .parquet 与 .json 成对，游离的 .header 记事自成一组），回到
/// 1.5GB 以下为止；刚写入的条目不删。
fn enforce_capacity(just_written: &Path) {
    let Some(root) = cache_dir() else {
        return;
    };
    let Some(parent) = root.parent().map(Path::to_path_buf) else {
        return;
    };
    struct Entry {
        parquet: Option<PathBuf>,
        json: Option<PathBuf>,
        used: SystemTime,
        size: u64,
    }
    let mut groups: HashMap<String, Entry> = HashMap::new();
    let scan = |dir: &Path, groups: &mut HashMap<String, Entry>| {
        for entry in fs::read_dir(dir).ok().into_iter().flatten().flatten() {
            let path = entry.path();
            if !matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("parquet") | Some("json") | Some("header")
            ) {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let is_parquet = path.extension().and_then(|v| v.to_str()) == Some("parquet");
            let is_json = path.extension().and_then(|v| v.to_str()) == Some("json");
            let entry = groups.entry(stem.to_owned()).or_insert(Entry {
                parquet: None,
                json: None,
                used,
                size: 0,
            });
            if is_parquet {
                entry.parquet = Some(path.clone());
            } else if is_json {
                entry.json = Some(path.clone());
            }
            entry.used = entry.used.min(used);
            entry.size += meta.len();
        }
    };
    scan(&parent, &mut groups);
    scan(&root, &mut groups);
    let mut total: u64 = groups.values().map(|entry| entry.size).sum();
    if total <= CACHE_SOFT_LIMIT {
        return;
    }
    let mut ordered = groups.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|(_, entry)| entry.used);
    for (_, entry) in ordered {
        if total <= CACHE_HARD_TARGET {
            break;
        }
        if entry.parquet.as_deref() == Some(just_written)
            || entry.json.as_deref() == Some(just_written)
        {
            continue;
        }
        for path in [entry.parquet, entry.json].into_iter().flatten() {
            let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_xlsxwriter::Workbook;

    /// 两张可见表的卡片清单：首张「FA卡片」带一行标题（自动标题行判定应落在
    /// 第 2 行），次张「汇总」是陪跑表。
    fn card_workbook(path: &Path, data_rows: usize) {
        let mut workbook = Workbook::new();
        let cards = workbook.add_worksheet();
        cards.set_name("FA卡片").unwrap();
        cards.write(0, 0, "固定资产卡片清单").unwrap();
        let headers = [
            "资产编号",
            "资产类别",
            "资产名称",
            "原值",
            "累计折旧",
            "开始使用日期",
        ];
        for (column, header) in headers.iter().enumerate() {
            cards.write(1, column as u16, *header).unwrap();
        }
        for row in 1..=data_rows as u32 {
            cards.write(row + 1, 0, format!("A{row}")).unwrap();
            cards.write(row + 1, 1, "电子设备").unwrap();
            cards.write(row + 1, 2, format!("服务器{row}")).unwrap();
            cards.write(row + 1, 3, 1000).unwrap();
            cards.write(row + 1, 4, 200).unwrap();
            cards.write(row + 1, 5, "2024-01-01").unwrap();
        }
        let summary = workbook.add_worksheet();
        summary.set_name("汇总").unwrap();
        summary.write(0, 0, "合计").unwrap();
        summary.write(0, 1, "金额").unwrap();
        summary.write(1, 0, "原值合计").unwrap();
        summary.write(1, 1, 123).unwrap();
        workbook.save(path).unwrap();
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 清掉这次测试落下的全部缓存产物（表体、sidecar、自动标题行记事）。
    fn cleanup_cache(path: &Path, sheet: &str, header_row: Option<usize>, choose_best: bool) {
        if let Some(row) = header_row {
            if let Some((parquet, sidecar)) = cache_paths(path, sheet, row, choose_best) {
                let _ = fs::remove_file(parquet);
                let _ = fs::remove_file(sidecar);
            }
        }
        if let Some(memo) = header_memo_path(path, sheet, choose_best) {
            let _ = fs::remove_file(memo);
        }
    }

    fn assert_same_table(cached: &Table, direct: &Table) {
        assert_eq!(cached.path, direct.path);
        assert_eq!(cached.sheet, direct.sheet);
        assert_eq!(cached.sheets, direct.sheets);
        assert_eq!(cached.header_row, direct.header_row);
        assert_eq!(cached.headers, direct.headers);
        assert_eq!(cached.rows, direct.rows);
        assert_eq!(cached.row_count, direct.row_count);
    }

    /// 同一 xlsx 两次经 load_table_cached：第一次落缓存（Parquet＋sidecar＋自动
    /// 标题行记事都在），第二次命中。命中证明用 fa_sheet_pick 同款手法：把缓存
    /// 改写成一份合法但内容不同的 Parquet，第二次读取原样读回，说明没有再碰
    /// 源工作簿。
    #[test]
    fn second_load_hits_disk_cache() {
        let dir = fresh_dir("fa-table-cache-hit");
        let path = dir.join("卡片清单.xlsx");
        card_workbook(&path, 4);
        let first = load_table_cached(&path, None, None, false).unwrap();
        assert_eq!(first.sheet.as_deref(), Some("FA卡片"));
        assert_eq!(first.header_row, 2);
        assert_eq!(first.rows.len(), 4);
        let (parquet, sidecar) =
            cache_paths(&path, "FA卡片", first.header_row, false).unwrap();
        assert!(parquet.is_file(), "缓存 Parquet 应已生成");
        assert!(sidecar.is_file(), "缓存 sidecar 应已生成");
        let memo = header_memo_path(&path, "FA卡片", false).unwrap();
        assert_eq!(fs::read_to_string(&memo).unwrap().trim(), "2");

        // 把缓存替换成一份合法但完全不同的小表，第二次读取若命中就应原样读回。
        let columns = vec![Column::new(
            "缓存命中".into(),
            vec!["来自缓存"],
        )];
        let mut frame = DataFrame::new(1, columns).unwrap();
        write_parquet(&parquet, &mut frame).unwrap();
        fs::write(
            &sidecar,
            json!({
                "sheet": "FA卡片",
                "sheets": first.sheets,
                "headerRow": first.header_row,
                "rowCount": 1,
            })
            .to_string(),
        )
        .unwrap();
        let second = load_table_cached(&path, None, None, false).unwrap();
        assert_eq!(second.headers, vec!["缓存命中".to_owned()]);
        assert_eq!(second.rows, vec![vec!["来自缓存".to_owned()]]);

        cleanup_cache(&path, "FA卡片", Some(first.header_row), false);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 缓存损坏（Parquet 或 sidecar 被写坏）时调用仍成功，缓存被删除重建，
    /// 重建结果与直接整读一致。
    #[test]
    fn corrupt_cache_is_deleted_and_rebuilt() {
        let dir = fresh_dir("fa-table-cache-corrupt");
        let path = dir.join("坏缓存.xlsx");
        card_workbook(&path, 3);
        let first = load_table_cached(&path, Some("FA卡片"), Some(2), false).unwrap();
        let (parquet, sidecar) =
            cache_paths(&path, "FA卡片", first.header_row, false).unwrap();
        assert!(parquet.is_file() && sidecar.is_file());

        // Parquet 写坏：读得回正确数据，且缓存文件被重建（不再是垃圾字节）。
        fs::write(&parquet, b"not a parquet file at all").unwrap();
        let second = load_table_cached(&path, Some("FA卡片"), Some(2), false).unwrap();
        assert_same_table(&second, &first);
        assert_ne!(fs::read(&parquet).unwrap(), b"not a parquet file at all".to_vec());

        // sidecar 写坏：同样恢复。
        fs::write(&sidecar, b"{ broken json").unwrap();
        let third = load_table_cached(&path, Some("FA卡片"), Some(2), false).unwrap();
        assert_same_table(&third, &first);
        let rebuilt = fs::read_to_string(&sidecar).unwrap();
        assert!(rebuilt.contains("FA卡片"), "sidecar 应已重建");

        cleanup_cache(&path, "FA卡片", Some(first.header_row), false);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 源文件一动（mtime 或内容）旧键即失效：新键未命中走整读并重新落缓存，
    /// 内容变化能被读到。
    #[test]
    fn source_change_invalidates_old_key() {
        let dir = fresh_dir("fa-table-cache-invalidate");
        let path = dir.join("改源.xlsx");
        card_workbook(&path, 4);
        let first = load_table_cached(&path, None, None, false).unwrap();
        let old = cache_paths(&path, "FA卡片", first.header_row, false).unwrap();

        // 只动 mtime：键变化，新键的缓存不存在，读取仍成功并重新落缓存。
        let future = SystemTime::now() + std::time::Duration::from_secs(10);
        let handle = fs::File::options().write(true).open(&path).unwrap();
        handle.set_modified(future).unwrap();
        drop(handle);
        let shifted = cache_paths(&path, "FA卡片", first.header_row, false).unwrap();
        assert_ne!(old.0, shifted.0, "mtime 变化后键必须变化");
        assert!(!shifted.0.exists());
        let second = load_table_cached(&path, None, None, false).unwrap();
        assert_same_table(&second, &first);
        assert!(shifted.0.is_file(), "新键的缓存应已生成");

        // 内容变化（行数增加，大小与 mtime 随之改变）：读到的就是新内容。
        card_workbook(&path, 7);
        let third = load_table_cached(&path, None, None, false).unwrap();
        assert_eq!(third.rows.len(), 7);

        cleanup_cache(&path, "FA卡片", Some(first.header_row), false);
        cleanup_cache(&path, "FA卡片", Some(second.header_row), false);
        cleanup_cache(&path, "FA卡片", Some(third.header_row), false);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 缓存与不缓存的 Table 结果一致性：自动选表＋自动标题行、显式表＋显式
    /// 标题行、choose_best 自动选表三种口径下，首次（透传整读落缓存）与二次
    /// （命中缓存）都与直接 fa::load_table 逐项相等。
    #[test]
    fn cached_matches_direct_load_for_all_param_shapes() {
        let dir = fresh_dir("fa-table-cache-parity");
        let path = dir.join("一致性.xlsx");
        card_workbook(&path, 5);

        for (sheet, header, choose_best) in [
            (None, None, false),
            (Some("FA卡片"), None, false),
            (Some("FA卡片"), Some(2), false),
            (None, None, true),
        ] {
            let direct = fa::load_table(&path, sheet, header, choose_best).unwrap();
            let cold = load_table_cached(&path, sheet, header, choose_best).unwrap();
            assert_same_table(&cold, &direct);
            let warm = load_table_cached(&path, sheet, header, choose_best).unwrap();
            assert_same_table(&warm, &direct);
            let resolved = direct.sheet.clone().unwrap_or_default();
            cleanup_cache(&path, &resolved, Some(direct.header_row), choose_best);
            if header.is_none() {
                cleanup_cache(&path, &resolved, None, choose_best);
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
