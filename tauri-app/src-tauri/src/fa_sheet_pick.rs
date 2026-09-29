//! FA 清单的自动选表与轻量读取：前缀打分、选表记事、前缀表与定向抽列。
//!
//! `fa::load_table` 的自动选表旧路会把每张可见工作表整表物化后再打分；
//! 一本 27 万行×83 列的期末清单加上陪跑表，仅"挑哪张表"就要付出几千万
//! 单元格的解析。这里换成一视图与整表完全一致的判据（复用
//! [`auto_sheet_judge`]），只把"读多少行"从整表缩到表头窗口：
//!
//! * 记事命中 → 直接用上一次选中的表；
//! * xlsx/xlsm → 每张可见表流式解出前 [`AUTO_SHEET_PREFIX_ROWS`] 行打分，
//!   胜出的表也只读前 [`PREFIX_ROWS`] 行（结构层：表头、样例、映射建议）；
//! * xls/ods、zip 结构不认识、或没有任何表认出角色 → 退回 `fa::load_table`
//!   的整表扫描，选表结论不因轻量化而漂移。
//!
//! 需要全量数据的判断（匹配键预碰撞、补充清单键推断）通过定向抽列补深：
//! 流式扫一遍目标工作表，只保留指定列的值，其余即读即弃，不整表物化。
//! 选表结论与前缀结构都按工作簿身份记在缓存目录（`.sheet` 扩展名，跟
//! 着看账的缓存清扫淘汰），同一文件再次打开免解压。

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::AppError;
use crate::fa::{
    Table, asset_header_depth, asset_headers, detect_header, finalize_table, normalize_join_key,
    sheet_name_affinity, suggest_mapping,
};

/// 轻量打分只解每张可见表的前 N 行。取 20 与 [`detect_header`] 的扫描窗口
/// 对齐：表头落在第 11~20 行的工作簿（标题、单位信息先行）必须能在前缀里
/// 被认出，再少会让这类文件静默退回整表扫描，再多对打分没有贡献。
const AUTO_SHEET_PREFIX_ROWS: usize = 20;

/// 结构层（表头探测、多层表头、样例值）保留的行数。覆盖 20 行探测窗口
/// 之外再留足样例余量；超过该窗口的成员判断走定向抽列补深。
pub(crate) const PREFIX_ROWS: usize = 200;

/// 与 `fa::load_table` 旧路同码：读取环节的失败一律 `FA_LOAD_FAILED`，
/// 不重试，详情带底层原因。
fn load_error(message: impl Into<String>, detail: Option<String>) -> AppError {
    crate::fa::error("FA_LOAD_FAILED", message, detail)
}

/// 单张工作表的自动选表判定。前缀打分与整表打分共用这一份判据：轻量化
/// 换的是"读多少行"，不是"怎么判断"。
pub(crate) struct AutoSheetJudgement {
    pub(crate) score: i32,
    pub(crate) header_row: usize,
    pub(crate) mapped: i32,
}

pub(crate) fn auto_sheet_judge(
    path: &Path,
    sheet: &str,
    pos: usize,
    matrix: &[Vec<String>],
    header: Option<usize>,
) -> AutoSheetJudgement {
    let hi = header
        .map(|v| v.saturating_sub(1))
        .unwrap_or_else(|| detect_header(matrix));
    let headers = asset_headers(matrix, hi);
    let mapping = suggest_mapping(&Table {
        path: path.into(),
        sheet: Some(sheet.to_owned()),
        sheets: vec![],
        header_row: hi + 1,
        headers,
        rows: vec![],
        row_count: 0,
    });
    let mapped = mapping.values().filter(|v| v.is_string()).count() as i32;
    let core = [
        "matchKey",
        "category",
        "name",
        "originalValue",
        "depreciation",
    ]
    .iter()
    .filter(|k| mapping.get(**k).is_some_and(Value::is_string))
    .count() as i32;
    let penalty = if ["合计", "汇总", "summary", "pivot"]
        .iter()
        .any(|t| sheet.to_lowercase().contains(t))
    {
        5
    } else {
        0
    };
    let score = mapped * 2
        + core * 4
        + if mapping.get("matchKey").is_some_and(Value::is_string) {
            6
        } else {
            0
        }
        - penalty
        + sheet_name_affinity(path, sheet)
        - pos as i32;
    AutoSheetJudgement {
        score,
        header_row: hi,
        mapped,
    }
}

// —— zip/XML 小工具与 fx.rs 的同名机制保持一致（那里属汇兑/看账的活跃
// 改动区，不宜新增依赖），FA 侧自持一份精简版：只认共享字符串与明文值，
// 不做样式与日期换算——选表打分与键判断只看文本标签与原值。 ——

fn fa_xml_attribute(fragment: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=\"");
    fragment
        .split_once(&marker)
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(value, _)| fa_xml_decode(value))
}

fn fa_xml_decode(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn fa_zip_open(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, AppError> {
    let file =
        fs::File::open(path).map_err(|e| load_error("无法打开工作簿。", Some(e.to_string())))?;
    zip::ZipArchive::new(file)
        .map_err(|e| load_error("工作簿压缩结构无效。", Some(e.to_string())))
}

fn fa_zip_text(path: &Path, entry: &str) -> Result<String, AppError> {
    use std::io::Read as _;
    let mut archive = fa_zip_open(path)?;
    let mut item = archive
        .by_name(entry)
        .map_err(|e| load_error(format!("工作簿缺少 {entry}。"), Some(e.to_string())))?;
    let mut text = String::new();
    item.read_to_string(&mut text)
        .map_err(|e| load_error(format!("无法读取 {entry}。"), Some(e.to_string())))?;
    Ok(text)
}

/// 工作簿的 Sheet 清单：名称、zip 内的表体入口、是否可见。可见性语义与
/// calamine 的 `sheets_metadata` 过滤对齐（整本隐藏时由调用方退回全部）。
fn fa_xlsx_sheet_states(path: &Path) -> Result<Vec<(String, String, bool)>, AppError> {
    let workbook = fa_zip_text(path, "xl/workbook.xml")?;
    let rels = fa_zip_text(path, "xl/_rels/workbook.xml.rels")?;
    let relationships = rels
        .split("<Relationship ")
        .skip(1)
        .filter_map(|fragment| {
            Some((
                fa_xml_attribute(fragment, "Id")?,
                fa_xml_attribute(fragment, "Target")?,
            ))
        })
        .collect::<HashMap<_, _>>();
    let sheets = workbook
        .split("<sheet ")
        .skip(1)
        .filter_map(|fragment| {
            let name = fa_xml_attribute(fragment, "name")?;
            let relation = fa_xml_attribute(fragment, "r:id")?;
            let target = relationships.get(&relation)?;
            let entry = if let Some(value) = target.strip_prefix("/xl/") {
                format!("xl/{value}")
            } else if target.starts_with("xl/") {
                target.clone()
            } else {
                format!("xl/{}", target.trim_start_matches('/'))
            };
            let visible = match fa_xml_attribute(fragment, "state").as_deref() {
                Some("hidden") | Some("veryHidden") => false,
                _ => true,
            };
            Some((name, entry, visible))
        })
        .collect::<Vec<_>>();
    if sheets.is_empty() {
        return Err(load_error("工作簿中未找到可读取的Sheet。", None));
    }
    Ok(sheets)
}

fn visible_xlsx_sheets(states: &[(String, String, bool)]) -> Vec<String> {
    let visible = states
        .iter()
        .filter(|(_, _, visible)| *visible)
        .map(|(name, _, _)| name.clone())
        .collect::<Vec<_>>();
    if visible.is_empty() {
        states.iter().map(|(name, _, _)| name.clone()).collect()
    } else {
        visible
    }
}

/// 共享字符串表按文件身份只留最近一份：定向抽列会被键预碰撞反复调用，
/// 每次都重解一遍几十 MB 的 sharedStrings 就把省下的时间又赔进去了。
fn shared_strings_cached(path: &Path) -> Vec<String> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<Option<(PathBuf, u64, std::time::SystemTime, Vec<String>)>>,
    > = std::sync::OnceLock::new();
    let identity = fs::metadata(path).ok().and_then(|meta| {
        Some((
            path.canonicalize().unwrap_or_else(|_| path.to_path_buf()),
            meta.len(),
            meta.modified().ok()?,
        ))
    });
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Some(guard) = cache.lock().ok() {
        if let Some((cached_path, len, modified, strings)) = guard.as_ref() {
            if Some((cached_path.clone(), *len, *modified)) == identity {
                return strings.clone();
            }
        }
    }
    let strings = fa_xlsx_shared_strings(path);
    if let (Some(identity), Ok(mut guard)) = (identity, cache.lock()) {
        *guard = Some((identity.0, identity.1, identity.2, strings.clone()));
    }
    strings
}

fn fa_xlsx_shared_strings(path: &Path) -> Vec<String> {
    let Ok(xml) = fa_zip_text(path, "xl/sharedStrings.xml") else {
        return Vec::new();
    };
    xml.split("<si>")
        .skip(1)
        .filter_map(|entry| entry.split_once("</si>").map(|(value, _)| value))
        .map(|entry| {
            entry
                .split("<t")
                .skip(1)
                .filter_map(|run| run.split_once('>'))
                .filter_map(|(_, text)| text.split_once("</t>").map(|(value, _)| value))
                .map(fa_xml_decode)
                .collect::<String>()
        })
        .collect()
}

/// 流式解出一张工作表的前 `row_limit` 行：calamine 的 `worksheet_range` 会
/// 先把整张表解压解析完，几十万行的卡片清单只为选表也要全量付一次账。
/// 块读取会多带回一截后续行，返回前精确截到第 `row_limit` 个行尾，保证
/// 前缀行数可预期。
fn fa_xlsx_prefix(path: &Path, entry: &str, row_limit: usize) -> Result<String, AppError> {
    use std::io::Read as _;
    let mut archive = fa_zip_open(path)?;
    let mut item = archive
        .by_name(entry)
        .map_err(|e| load_error("无法读取工作表。", Some(e.to_string())))?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = item
            .read(&mut buffer)
            .map_err(|e| load_error("无法读取工作表数据。", Some(e.to_string())))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.windows(6).filter(|value| *value == b"</row>").count() >= row_limit {
            break;
        }
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if let Some(cut) = nth_row_end(&text, row_limit) {
        text.truncate(cut);
    }
    Ok(text)
}

/// 第 `n` 个 `</row>` 结束位置的字节偏移（1 基计数）；不足 n 行返回 None。
/// 在 ASCII 结束标签处截断不会切开多字节字符。
fn nth_row_end(text: &str, n: usize) -> Option<usize> {
    let mut searched = 0usize;
    let mut found = 0usize;
    for _ in 0..n {
        let offset = text[searched..].find("</row>")?;
        found = searched + offset + "</row>".len();
        searched = found;
    }
    Some(found)
}

fn fa_xlsx_column_index(reference: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut found = false;
    for character in reference
        .chars()
        .take_while(|value| value.is_ascii_alphabetic())
    {
        value = value * 26 + (character.to_ascii_uppercase() as usize - 'A' as usize + 1);
        found = true;
    }
    found.then_some(value - 1)
}

/// `<c>` 片段里的明文值：优先 `<v>`，其次内联 `<t>`。
fn cell_raw_text(cell_xml: &str) -> &str {
    cell_xml
        .split_once("<v>")
        .and_then(|(_, value)| value.split_once("</v>"))
        .map(|(value, _)| value)
        .or_else(|| {
            cell_xml
                .split("<t")
                .nth(1)
                .and_then(|value| value.split_once('>'))
                .and_then(|(_, value)| value.split_once("</t>"))
                .map(|(value, _)| value)
        })
        .unwrap_or("")
}

fn resolve_cell_value(cell_xml: &str, shared: &[String]) -> String {
    let kind = fa_xml_attribute(cell_xml, "t").unwrap_or_default();
    let raw = cell_raw_text(cell_xml);
    if kind == "s" {
        raw.parse::<usize>()
            .ok()
            .and_then(|index| shared.get(index))
            .cloned()
            .unwrap_or_default()
    } else {
        fa_xml_decode(raw)
    }
}

fn fa_xlsx_prefix_matrix(prefix: &str, shared: &[String]) -> Vec<Vec<String>> {
    let mut sparse: Vec<Vec<(usize, String)>> = Vec::new();
    for fragment in prefix.split("<row ").skip(1) {
        let Some((row_xml, _)) = fragment.split_once("</row>") else {
            break;
        };
        let mut cells = Vec::<(usize, String)>::new();
        for cell in row_xml.split("<c ").skip(1) {
            let Some((cell_xml, _)) = cell.split_once("</c>") else {
                continue;
            };
            let Some(index) = fa_xml_attribute(cell_xml, "r")
                .and_then(|reference| fa_xlsx_column_index(&reference))
            else {
                continue;
            };
            cells.push((index, resolve_cell_value(cell_xml, shared)));
        }
        sparse.push(cells);
    }
    let width = sparse
        .iter()
        .flatten()
        .map(|(index, _)| index + 1)
        .max()
        .unwrap_or(0);
    sparse
        .into_iter()
        .map(|cells| {
            let mut row = vec![String::new(); width];
            for (index, value) in cells {
                if index < width {
                    row[index] = value;
                }
            }
            row
        })
        .collect()
}

/// 工作表声明的总行数（`<dimension ref="A1:XX290552">`）。只作展示规模与
/// “前缀之外还有多少行”的参考，不保证与去空后的实际行数严格相等。
fn fa_xlsx_dimension_rows(prefix: &str) -> usize {
    let Some(fragment) = prefix.split("<dimension ").nth(1) else {
        return 0;
    };
    let Some(reference) = fa_xml_attribute(fragment, "ref") else {
        return 0;
    };
    let end = reference.split(':').next_back().unwrap_or(&reference);
    end.chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

/// 自动选表结论的记事文件：键只有工作簿身份（规范路径、大小、修改时间）
/// 与用户指定的标题行。落在看账缓存目录的 `fa/v1` 子目录并沿用 `.sheet`
/// 扩展名，跟着既有缓存清扫一起淘汰；文件内容一变身份就变，老结论自然
/// 作废。
fn fa_auto_sheet_memo_path(path: &Path, header: Option<usize>) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    hasher.update(header.unwrap_or(0).to_le_bytes());
    hasher.update(b"fa-auto-sheet-v1");
    let key = hex::encode(hasher.finalize());
    Some(
        crate::tabular::cache_root()
            .ok()?
            .join("fa")
            .join("v1")
            .join(format!("{key}.sheet")),
    )
}

fn remembered_fa_sheet(path: &Path, header: Option<usize>, sheets: &[String]) -> Option<String> {
    let memo = fa_auto_sheet_memo_path(path, header)?;
    let remembered = fs::read_to_string(&memo).ok()?.trim().to_owned();
    if remembered.is_empty() || !sheets.contains(&remembered) {
        return None;
    }
    // 命中时把 mtime 推到当前：缓存清扫按"最后使用"淘汰，不 touch 会把
    // 常用结论误当陈货清掉。
    if let Ok(handle) = fs::File::options().write(true).open(&memo) {
        let _ = handle.set_modified(std::time::SystemTime::now());
    }
    Some(remembered)
}

fn remember_fa_sheet(path: &Path, header: Option<usize>, sheet: &str) {
    let Some(memo) = fa_auto_sheet_memo_path(path, header) else {
        return;
    };
    let partial = memo.with_extension("partial");
    if fs::create_dir_all(memo.parent().unwrap_or(Path::new("."))).is_ok()
        && fs::write(&partial, sheet).is_ok()
    {
        let _ = crate::tabular::replace_file(&partial, &memo);
    }
}

/// xlsx/xlsm 的轻量自动选表：每张可见表只解出前 [`AUTO_SHEET_PREFIX_ROWS`]
/// 行，用与整表完全相同的 [`auto_sheet_judge`] 打分。任何表在 zip 结构里
/// 对不上、或没有任何表认出角色（非典型结构）时返回 None，调用方退回
/// 整表扫描重判。
fn lightweight_auto_sheet(
    path: &Path,
    sheets: &[String],
    header: Option<usize>,
) -> Option<String> {
    if !matches!(
        path.extension().and_then(|v| v.to_str()),
        Some("xlsx") | Some("xlsm")
    ) {
        return None;
    }
    let states = fa_xlsx_sheet_states(path).ok()?;
    let shared = shared_strings_cached(path);
    let mut best: Option<(AutoSheetJudgement, String)> = None;
    for (pos, sheet) in sheets.iter().enumerate() {
        let (_, entry, _) = states.iter().find(|(name, _, _)| name == sheet)?;
        let prefix = fa_xlsx_prefix(path, entry, AUTO_SHEET_PREFIX_ROWS).ok()?;
        let matrix = fa_xlsx_prefix_matrix(&prefix, &shared);
        if matrix.is_empty() {
            continue;
        }
        let judgement = auto_sheet_judge(path, sheet, pos, &matrix, header);
        if best
            .as_ref()
            .is_none_or(|(current, _)| judgement.score > current.score)
        {
            best = Some((judgement, sheet.clone()));
        }
    }
    let (judgement, sheet) = best?;
    // 认不出任何角色的结论不可信：不记事，退回整表扫描。
    (judgement.mapped > 0).then_some(sheet)
}

/// 自动选表候选集：记事结论 → 轻量前缀打分 → 全部可见表整表扫描，三级
/// 退让。返回的候选交给 [`crate::fa::load_table`] 既有的整表读取与判分
/// 循环，胜出表的完整读取路径保持原样。
pub(crate) fn auto_sheet_candidates(
    path: &Path,
    sheets: &[String],
    header: Option<usize>,
) -> Vec<String> {
    if sheets.len() <= 1 {
        return sheets.to_vec();
    }
    if let Some(remembered) = remembered_fa_sheet(path, header, sheets) {
        return vec![remembered];
    }
    if let Some(picked) = lightweight_auto_sheet(path, sheets, header) {
        remember_fa_sheet(path, header, &picked);
        return vec![picked];
    }
    sheets.to_vec()
}

/// 前缀结构表（表头、样例、行数规模）的磁盘缓存：键为工作簿身份＋表名＋
/// 标题行，扩展名沿用 `.sheet` 跟随既有清扫。缓存命中时连前缀解压都省掉。
fn prefix_cache_path(path: &Path, sheet: Option<&str>, header: Option<usize>) -> Option<PathBuf> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(meta.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    hasher.update(sheet.unwrap_or("<auto>").as_bytes());
    hasher.update(header.unwrap_or(0).to_le_bytes());
    hasher.update(b"fa-prefix-table-v1");
    let key = hex::encode(hasher.finalize());
    Some(
        crate::tabular::cache_root()
            .ok()?
            .join("fa")
            .join("v1")
            .join(format!("{key}.sheet")),
    )
}

fn load_prefix_cache(path: &Path, sheet: &str, header: Option<usize>) -> Option<Table> {
    let cache = prefix_cache_path(path, Some(sheet), header)?;
    let text = fs::read_to_string(cache).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("sheet").and_then(Value::as_str) != Some(sheet) {
        return None;
    }
    let headers = value
        .get("headers")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if headers.is_empty() {
        return None;
    }
    let rows = value
        .get("rows")?
        .as_array()?
        .iter()
        .filter_map(|row| {
            row.as_array().map(|cells| {
                cells
                    .iter()
                    .map(|cell| cell.as_str().unwrap_or_default().to_owned())
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let sheets = value
        .get("sheets")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !sheets.contains(&sheet.to_owned()) {
        return None;
    }
    let row_count = value
        .get("rowCount")
        .and_then(Value::as_u64)
        .unwrap_or(rows.len() as u64) as usize;
    Some(Table {
        path: path.to_path_buf(),
        sheet: Some(sheet.to_owned()),
        sheets,
        header_row: value.get("headerRow").and_then(Value::as_u64)? as usize,
        headers,
        row_count: row_count.max(rows.len()),
        rows,
    })
}

fn save_prefix_cache(path: &Path, header: Option<usize>, table: &Table) {
    let Some(cache) = prefix_cache_path(path, table.sheet.as_deref(), header) else {
        return;
    };
    let value = serde_json::json!({
        "sheet": table.sheet,
        "sheets": table.sheets,
        "headerRow": table.header_row,
        "headers": table.headers,
        "rows": table.rows,
        "rowCount": table.row_count,
    });
    let partial = cache.with_extension("partial");
    if fs::create_dir_all(cache.parent().unwrap_or(Path::new("."))).is_ok()
        && fs::write(&partial, value.to_string()).is_ok()
    {
        let _ = crate::tabular::replace_file(&partial, &cache);
    }
}

/// 前缀结构表加载：结构层（选表、表头、样例、行数规模）只读目标表前
/// [`PREFIX_ROWS`] 行，整表物化留给真正的合并/导出 worker。任何一步走不
/// 通（非 xlsx、结构不认识、前缀为空）返回 None，由调用方退回整表读取。
pub(crate) fn load_prefix_table(
    path: &Path,
    requested_sheet: Option<&str>,
    header: Option<usize>,
    choose_best: bool,
) -> Option<Table> {
    if !matches!(
        path.extension().and_then(|v| v.to_str()),
        Some("xlsx") | Some("xlsm")
    ) {
        return None;
    }
    let states = fa_xlsx_sheet_states(path).ok()?;
    let sheets = visible_xlsx_sheets(&states);
    if sheets.is_empty() {
        return None;
    }
    let target = requested_sheet
        .filter(|sheet| sheets.iter().any(|known| known == sheet))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if choose_best {
                auto_sheet_candidates(path, &sheets, header)
                    .into_iter()
                    .next()
                    .unwrap_or_default()
            } else {
                sheets[0].clone()
            }
        });
    if target.is_empty() {
        return None;
    }
    if let Some(table) = load_prefix_cache(path, &target, header) {
        return Some(table);
    }
    let (_, entry, _) = states.iter().find(|(name, _, _)| *name == target)?;
    let prefix = fa_xlsx_prefix(path, entry, PREFIX_ROWS).ok()?;
    let shared = shared_strings_cached(path);
    let matrix = fa_xlsx_prefix_matrix(&prefix, &shared);
    if matrix.is_empty() {
        return None;
    }
    let hi = header
        .map(|v| v.saturating_sub(1))
        .unwrap_or_else(|| detect_header(&matrix));
    let depth = asset_header_depth(&matrix, hi);
    let declared = fa_xlsx_dimension_rows(&prefix);
    let row_count = declared.saturating_sub(hi + depth);
    let table = finalize_table(path, Some(target), sheets, hi, matrix, row_count);
    save_prefix_cache(path, header, &table);
    Some(table)
}

/// 流式整表扫一张工作表，只保留目标列集合的值（一次解压，多列同抽）。
/// 不把整张表读进内存：逐块解压，按 `</row>` 边界切片段，非目标列的单元
/// 格即读即弃。
fn xlsx_sheet_columns_values(
    path: &Path,
    entry: &str,
    columns: &[usize],
    shared: &[String],
) -> Option<Vec<Vec<String>>> {
    use std::io::Read as _;
    if columns.is_empty() {
        return Some(Vec::new());
    }
    let wanted: std::collections::HashSet<usize> = columns.iter().copied().collect();
    let mut archive = fa_zip_open(path).ok()?;
    let mut item = archive.by_name(entry).ok()?;
    let mut pending: Vec<u8> = Vec::new();
    let mut chunk = vec![0_u8; 256 * 1024];
    let mut values = vec![Vec::<String>::new(); columns.len()];
    let mut collect = |fragment: &str| {
        for cell in fragment.split("<c ").skip(1) {
            let Some(reference) = fa_xml_attribute(cell, "r") else {
                continue;
            };
            let Some(index) = fa_xlsx_column_index(&reference) else {
                continue;
            };
            if let Some(position) = columns.iter().position(|candidate| *candidate == index) {
                values[position].push(resolve_cell_value(cell, shared));
            }
        }
    };
    loop {
        let count = item.read(&mut chunk).ok()?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&chunk[..count]);
        let mut consumed = 0usize;
        while let Some(offset) = find_subsequence(&pending[consumed..], b"</row>") {
            let end = consumed + offset;
            let fragment = String::from_utf8_lossy(&pending[consumed..end]).into_owned();
            collect(&fragment);
            consumed = end + b"</row>".len();
        }
        if consumed > 0 {
            pending.drain(..consumed);
        }
    }
    if !pending.is_empty() {
        let fragment = String::from_utf8_lossy(&pending).into_owned();
        collect(&fragment);
    }
    let _ = wanted;
    Some(values)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// 键列值域的内存缓存条目：按文件身份＋表名＋列号记一份归一化值集。
/// 深度校验会反复查同一批键列（手工调键每次都要重验），首扫之后必须免扫。
struct DeepColumn {
    key: (PathBuf, u64, std::time::SystemTime, String, usize),
    values: std::sync::Arc<Vec<String>>,
}

static DEEP_COLUMNS: std::sync::OnceLock<
    std::sync::Mutex<Vec<DeepColumn>>,
> = std::sync::OnceLock::new();

fn deep_column_identity(
    table: &Table,
    index: usize,
) -> Option<(PathBuf, u64, std::time::SystemTime, String, usize)> {
    let meta = fs::metadata(&table.path).ok()?;
    Some((
        table.path.canonicalize().unwrap_or_else(|_| table.path.clone()),
        meta.len(),
        meta.modified().ok()?,
        table.sheet.clone()?,
        index,
    ))
}

fn deep_column_cache_path(
    key: &(PathBuf, u64, std::time::SystemTime, String, usize),
) -> Option<PathBuf> {
    let (canonical, len, modified, sheet, index) = key;
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(len.to_le_bytes());
    hasher.update(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .to_le_bytes(),
    );
    hasher.update(sheet.as_bytes());
    hasher.update(index.to_le_bytes());
    hasher.update(b"fa-deep-column-v1");
    let hash = hex::encode(hasher.finalize());
    Some(
        crate::tabular::cache_root()
            .ok()?
            .join("fa")
            .join("v1")
            .join(format!("{hash}.sheet")),
    )
}

/// 取某列的归一化值集（内存 → 磁盘 → 流式整列抽取并落盘），深度成员判断
/// 的统一入口。返回 None 表示该来源不支持补深（非 xlsx 等）。
fn deep_column_values(table: &Table, index: usize) -> Option<std::sync::Arc<Vec<String>>> {
    let key = deep_column_identity(table, index)?;
    let cache = DEEP_COLUMNS.get_or_init(|| std::sync::Mutex::new(Vec::new()));
    if let Ok(mut guard) = cache.lock() {
        if let Some(position) = guard.iter().position(|entry| entry.key == key) {
            let values = std::sync::Arc::clone(&guard[position].values);
            // 挪到队尾当简单 LRU。
            let entry = guard.remove(position);
            guard.push(entry);
            return Some(values);
        }
    }
    let disk_path = deep_column_cache_path(&key);
    let load_from_disk = || -> Option<Vec<String>> {
        let path = disk_path.as_ref()?;
        let text = fs::read_to_string(path).ok()?;
        let parsed: Vec<String> = serde_json::from_str(&text).ok()?;
        (!parsed.is_empty()).then_some(parsed)
    };
    let values: std::sync::Arc<Vec<String>> = match load_from_disk() {
        Some(cached) => std::sync::Arc::new(cached),
        None => {
        if !matches!(
            table.path.extension().and_then(|v| v.to_str()),
            Some("xlsx") | Some("xlsm")
        ) {
            return None;
        }
        let states = fa_xlsx_sheet_states(&table.path).ok()?;
        let (_, entry, _) = states.iter().find(|(name, _, _)| name == &key.3)?;
        let shared = shared_strings_cached(&table.path);
        let started = std::time::Instant::now();
        let values = xlsx_sheet_columns_values(&table.path, entry, &[index], &shared)?
            .pop()?
            .iter()
            .map(|value| normalize_join_key(value))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        eprintln!(
            "FA 深度键校验：抽取 {} 列{}（{} 值，{:.1}s）并落缓存",
            table.path.file_name().unwrap_or_default().to_string_lossy(),
            index,
            values.len(),
            started.elapsed().as_secs_f64()
        );
        if values.is_empty() {
            return None;
        }
        if let Some(path) = &disk_path {
            let partial = path.with_extension("partial");
            if fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).is_ok()
                && fs::write(&partial, serde_json::to_string(&values).unwrap_or_default()).is_ok()
            {
                let _ = crate::tabular::replace_file(&partial, path);
            }
        }
        std::sync::Arc::new(values)
        }
    };
    if let Ok(mut guard) = cache.lock() {
        if guard.len() >= 4 {
            guard.remove(0);
        }
        guard.push(DeepColumn {
            key,
            values: std::sync::Arc::clone(&values),
        });
    }
    Some(values)
}

/// 深度成员判断：为前缀表补一次目标列的全量值域检查，按 `normalize_join_key`
/// 口径比对。首扫流式抽取整列并缓存（内存＋磁盘），之后手工调键等重复
/// 校验瞬时完成。非 xlsx 或找不到表时返回 None（这些来源本来就是整表读的，
/// 前缀未命中即真未命中）。
pub(crate) fn xlsx_column_contains(table: &Table, index: usize, sample: &str) -> Option<bool> {
    if sample.is_empty() {
        return Some(false);
    }
    Some(deep_column_values(table, index)?.iter().any(|value| value == sample))
}

/// 把指定列替换为全量抽取值（其余列留空、行数对齐全量），供补充清单键
/// 推断等需要参照表整列真实值的场合在前缀表上补深。抽取失败返回 None，
/// 由调用方决定是否退整表。
pub(crate) fn deep_patch_columns(table: &Table, indexes: &[usize]) -> Option<Table> {
    let sheet = table.sheet.as_deref()?;
    if !matches!(
        table.path.extension().and_then(|v| v.to_str()),
        Some("xlsx") | Some("xlsm")
    ) {
        return None;
    }
    let states = fa_xlsx_sheet_states(&table.path).ok()?;
    let (_, entry, _) = states.iter().find(|(name, _, _)| *name == sheet)?;
    let shared = shared_strings_cached(&table.path);
    let columns = xlsx_sheet_columns_values(&table.path, entry, indexes, &shared)?;
    let height = columns.iter().map(Vec::len).max().unwrap_or(0);
    let width = table.headers.len();
    let rows = (0..height)
        .map(|row_index| {
            let mut row = vec![String::new(); width];
            for (position, values) in columns.iter().enumerate() {
                let at = indexes[position];
                if at < width {
                    row[at] = values.get(row_index).cloned().unwrap_or_default();
                }
            }
            row
        })
        .collect::<Vec<_>>();
    Some(Table {
        rows,
        row_count: height,
        ..table.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Reader as _, open_workbook_auto};
    use rust_xlsxwriter::Workbook;

    fn decoy_workbook(path: &Path) {
        let mut wb = Workbook::new();
        let summary = wb.add_worksheet();
        summary.set_name("汇总").unwrap();
        summary.write(0, 0, "合计").unwrap();
        summary.write(0, 1, "金额").unwrap();
        summary.write(1, 0, "原值合计").unwrap();
        summary.write(1, 1, 123).unwrap();
        let cards = wb.add_worksheet();
        cards.set_name("FA卡片").unwrap();
        let headers = [
            "资产编号",
            "资产类别",
            "资产名称",
            "原值",
            "累计折旧",
            "开始使用日期",
        ];
        for (col, header) in headers.iter().enumerate() {
            cards.write(0, col as u16, *header).unwrap();
        }
        for row in 1..=4u32 {
            cards.write(row, 0, format!("A{row}")).unwrap();
            cards.write(row, 1, "电子设备").unwrap();
            cards.write(row, 2, format!("服务器{row}")).unwrap();
            cards.write(row, 3, 1000).unwrap();
            cards.write(row, 4, 200).unwrap();
            cards.write(row, 5, "2024-01-01").unwrap();
        }
        let mapping = wb.add_worksheet();
        mapping.set_name("对照").unwrap();
        mapping.write(0, 0, "代码").unwrap();
        mapping.write(0, 1, "名称").unwrap();
        mapping.write(1, 0, "01").unwrap();
        mapping.write(1, 1, "BU1").unwrap();
        wb.save(path).unwrap();
    }

    fn visible_sheets(path: &Path) -> Vec<String> {
        let mut book = open_workbook_auto(path).unwrap();
        book.sheets_metadata()
            .iter()
            .filter(|sheet| sheet.visible == calamine::SheetVisible::Visible)
            .map(|sheet| sheet.name.clone())
            .collect()
    }

    /// 轻量前缀打分选中的表，必须与整表扫描的判分共用同一判据并选中
    /// 卡片表；第一次读取写下记事，第二次读取直接命中记事不再扫描。
    #[test]
    fn auto_sheet_prefix_pick_matches_and_memo_hits() {
        let dir = std::env::temp_dir().join("fa-sheet-pick-memo");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("多表工作簿.xlsx");
        decoy_workbook(&path);
        let sheets = visible_sheets(&path);

        assert_eq!(
            lightweight_auto_sheet(&path, &sheets, None).as_deref(),
            Some("FA卡片")
        );
        let first = crate::fa::load_table(&path, None, None, true).unwrap();
        assert_eq!(first.sheet.as_deref(), Some("FA卡片"));
        assert_eq!(
            first.headers.first().map(String::as_str),
            Some("资产编号")
        );
        let memo = fa_auto_sheet_memo_path(&path, None).unwrap();
        assert!(memo.exists());
        assert_eq!(fs::read_to_string(&memo).unwrap().trim(), "FA卡片");
        let second = crate::fa::load_table(&path, None, None, true).unwrap();
        assert_eq!(second.sheet.as_deref(), Some("FA卡片"));

        let _ = fs::remove_file(&memo);
        if let Some(cache) = prefix_cache_path(&path, first.sheet.as_deref(), None) {
            let _ = fs::remove_file(cache);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有任何表认出角色时轻量路径放弃并退回整表扫描（照旧选第一张），
    /// 且不把这种不可信结论写进记事。
    #[test]
    fn auto_sheet_falls_back_without_memo_when_no_sheet_maps_roles() {
        let dir = std::env::temp_dir().join("fa-sheet-pick-fallback");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("无角色工作簿.xlsx");
        let mut wb = Workbook::new();
        let first = wb.add_worksheet();
        first.set_name("甲").unwrap();
        first.write(0, 0, "甲值").unwrap();
        first.write(1, 0, 1).unwrap();
        let second = wb.add_worksheet();
        second.set_name("乙").unwrap();
        second.write(0, 0, "乙值").unwrap();
        second.write(1, 0, 2).unwrap();
        wb.save(&path).unwrap();

        assert_eq!(
            lightweight_auto_sheet(&path, &visible_sheets(&path), None),
            None
        );
        let table = crate::fa::load_table(&path, None, None, true).unwrap();
        assert_eq!(table.sheet.as_deref(), Some("甲"));
        let memo = fa_auto_sheet_memo_path(&path, None).unwrap();
        assert!(!memo.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 前缀结构表与整表读取在结构层（表头、标题行、数据行、行数）上等价；
    /// 前缀缓存落盘后再次加载直接命中（内容可被外部改写即证明走的是缓存）。
    #[test]
    fn prefix_table_matches_full_load_and_disk_cache_hits() {
        let dir = std::env::temp_dir().join("fa-prefix-table-cache");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("结构等价.xlsx");
        decoy_workbook(&path);

        let full = crate::fa::load_table(&path, None, None, true).unwrap();
        let prefix = load_prefix_table(&path, None, None, true).unwrap();
        assert_eq!(prefix.sheet, full.sheet);
        assert_eq!(prefix.headers, full.headers);
        assert_eq!(prefix.header_row, full.header_row);
        assert_eq!(prefix.rows, full.rows);
        assert!(prefix.row_count >= prefix.rows.len());

        let cache = prefix_cache_path(&path, prefix.sheet.as_deref(), None).unwrap();
        assert!(cache.exists());
        // 改写缓存内容后应原样读回，证明第二次加载没有再解压工作簿。
        let patched = serde_json::json!({
            "sheet": prefix.sheet,
            "sheets": prefix.sheets,
            "headerRow": 1,
            "headers": ["缓存命中"],
            "rows": [["x"]],
            "rowCount": 1,
        });
        fs::write(&cache, patched.to_string()).unwrap();
        let cached = load_prefix_table(&path, None, None, true).unwrap();
        assert_eq!(cached.headers.first().map(String::as_str), Some("缓存命中"));
        let _ = fs::remove_file(&cache);
        let _ = fs::remove_file(fa_auto_sheet_memo_path(&path, None).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 定向抽列要能找到前缀之外的值：目标键值埋在第 250 行（前缀 200 行
    /// 之外），前缀表判未命中、补深后命中；`deep_patch_columns` 把该列全量
    /// 补进前缀表。
    #[test]
    fn deep_column_extraction_reaches_beyond_prefix() {
        let dir = std::env::temp_dir().join("fa-deep-column");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("深列.xlsx");
        let mut wb = Workbook::new();
        let cards = wb.add_worksheet();
        cards.set_name("FA卡片").unwrap();
        cards.write(0, 0, "资产编号").unwrap();
        cards.write(0, 1, "原值").unwrap();
        for row in 1..=300u32 {
            let id: String = if row == 250 {
                "DEEP-ID".to_owned()
            } else {
                format!("A{row}")
            };
            cards.write(row, 0, id).unwrap();
            cards.write(row, 1, 100).unwrap();
        }
        wb.save(&path).unwrap();

        let table = load_prefix_table(&path, None, None, true).unwrap();
        assert!(table.rows.len() <= PREFIX_ROWS);
        assert!(table.row_count > table.rows.len());
        let sample = normalize_join_key("DEEP-ID");
        let column = table.headers.iter().position(|h| h == "资产编号").unwrap();
        assert!(!table
            .rows
            .iter()
            .any(|row| normalize_join_key(&row[column]) == sample));
        // 首次补深走整列抽取并落缓存，第二次（含进程内与磁盘）命中缓存。
        assert_eq!(xlsx_column_contains(&table, column, &sample), Some(true));
        assert_eq!(xlsx_column_contains(&table, column, &sample), Some(true));
        assert_eq!(
            xlsx_column_contains(&table, column, &normalize_join_key("不存在")),
            Some(false)
        );

        let patched = deep_patch_columns(&table, &[column]).unwrap();
        assert!(patched.rows.len() >= 300);
        assert!(patched
            .rows
            .iter()
            .any(|row| normalize_join_key(&row[column]) == sample));

        if let Some(cache) = prefix_cache_path(&path, table.sheet.as_deref(), None) {
            let _ = fs::remove_file(cache);
        }
        if let Some(key) = deep_column_identity(&table, column) {
            if let Some(cache) = deep_column_cache_path(&key) {
                let _ = fs::remove_file(cache);
            }
        }
        let _ = fs::remove_file(fa_auto_sheet_memo_path(&path, None).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 跑法（真机基准，需本地样例）：
    /// cargo test --manifest-path src-tauri/Cargo.toml --lib fa_sheet_pick -- --ignored --nocapture
    /// 环境变量 FA_AUTO_SHEET_BENCH 指向存放真实卡片清单 xlsx 的目录。
    #[test]
    #[ignore = "requires FA_AUTO_SHEET_BENCH pointing at real card workbooks"]
    fn fa_auto_sheet_live_bench() {
        let dir = std::env::var("FA_AUTO_SHEET_BENCH")
            .expect("set FA_AUTO_SHEET_BENCH to a folder of real xlsx card files");
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("xlsx") {
                continue;
            }
            if path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .starts_with("~$")
            {
                continue;
            }
            // 清掉旧记事与前缀缓存测冷启动，再读一次测热启动。
            if let Some(memo) = fa_auto_sheet_memo_path(&path, None) {
                let _ = fs::remove_file(&memo);
            }
            let started = std::time::Instant::now();
            let table = match load_prefix_table(&path, None, None, true) {
                Some(table) => table,
                None => {
                    // 目录里混着非卡片清单（甚至损坏）的 xlsx 很正常：报一声
                    // 跳过，别让一个无关文件中断整轮基准。
                    println!(
                        "{}: 前缀加载不可用，跳过",
                        path.file_name().unwrap().to_string_lossy()
                    );
                    continue;
                }
            };
            let cold = started.elapsed();
            let started = std::time::Instant::now();
            let again = load_prefix_table(&path, None, None, true).unwrap();
            let warm = started.elapsed();
            println!(
                "{}: 前缀表 {}（{} 行 x {} 列，声明 {} 行）冷启 {:.1}s / 缓存命中热启 {:.1}s",
                path.file_name().unwrap().to_string_lossy(),
                table.sheet.clone().unwrap_or_default(),
                table.rows.len(),
                table.headers.len(),
                table.row_count,
                cold.as_secs_f64(),
                warm.as_secs_f64(),
            );
            assert_eq!(table.sheet, again.sheet);
        }
    }
}
