//! Native FA List kernel.
//!
//! This module deliberately owns the entire deterministic FA workflow.  The
//! webview passes paths and mappings; files never transit through JSON.

use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Datelike, Local, Months, NaiveDate};
use reqwest::blocking::Client;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;

pub(crate) type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

#[derive(Clone, Debug)]
pub(crate) struct Table {
    pub(crate) path: PathBuf,
    pub(crate) sheet: Option<String>,
    pub(crate) sheets: Vec<String>,
    pub(crate) header_row: usize,
    pub(crate) headers: Vec<String>,
    pub(crate) rows: Vec<Vec<String>>,
}

#[derive(Clone, Debug)]
struct JoinedRow {
    begin: Option<Vec<String>>,
    end: Option<Vec<String>>,
    source: &'static str,
    match_value: String,
    extra: BTreeMap<String, Cell>,
}

#[derive(Clone, Debug)]
enum Cell {
    Text(String),
    Number(f64),
}

/// `fa_subtools` 以不透明引用消费合并结果（折旧政策对比复用折旧期间逻辑），
/// 字段保持模块私有。
#[derive(Clone, Debug)]
pub(crate) struct MergeResult {
    begin: Table,
    end: Table,
    rows: Vec<JoinedRow>,
    begin_keys: Vec<String>,
    end_keys: Vec<String>,
    duplicate_values: usize,
    duplicate_rows: usize,
    unmatched_addition: Vec<Vec<String>>,
    unmatched_disposal: Vec<Vec<String>>,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fa.inspect" => inspect(params),
        "fa.supplement_inspect" => supplement_inspect(params),
        "fa.review" => llm_review(params, false),
        "fa.supplement_review" => llm_review(params, true),
        // FA 子工具的短任务在独立模块实现，但分发契约保持在这里：未知
        // 方法仍然必须报 METHOD_NOT_FOUND。
        "fa.dep_inspect" | "fa.dep_review" => crate::fa_subtools::call(method, params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust FA List 方法。",
            Some(method.into()),
        )),
    }
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    match method {
        "fa.tbje_preview" | "fa.tbje_export" => {
            return crate::fa_tbje::run_job(method, params, progress, cancel, pause);
        }
        "fa.match" | "fa.preview" => {
            let result = preview(params, progress, cancel, pause);
            pause.wait()?;
            result
        }
        "fa.export" => {
            let result = export(params, progress, cancel, pause);
            pause.wait()?;
            result
        }
        "fa.dep_export" | "fa.policy_export" => {
            let result = crate::fa_subtools::run_job(method, params, progress, cancel, pause);
            pause.wait()?;
            result
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust FA List 任务。",
            Some(method.into()),
        )),
    }
}

fn inspect(params: Value) -> Result<Value, AppError> {
    let begin_path = required_path(&params, "beginPath")?;
    let end_path = required_path(&params, "endPath")?;
    let begin = load_table(
        &begin_path,
        params.get("beginSheet").and_then(Value::as_str),
        optional_header(&params, "beginHeaderRow")?,
        true,
    )?;
    let end = load_table(
        &end_path,
        params.get("endSheet").and_then(Value::as_str),
        optional_header(&params, "endHeaderRow")?,
        true,
    )?;
    let mut bm = suggest_mapping(&begin);
    let mut em = suggest_mapping(&end);
    // 本年折旧、新增方式和新增日期都是期末（file2）属性。
    // 期初文件中的同名或近义列不参与当期新增分析，也不应进入
    // UI/LLM 复核候选，否则会把期初的资本化日期误当成当期新增日期。
    for role in ["currentYearDep", "additionMethod", "additionDate"] {
        bm.insert(role.into(), Value::Null);
    }
    extend_composite_key(&mut bm, &em);
    extend_composite_key(&mut em, &bm);
    Ok(json!({
        "begin": table_inspection(&begin), "end": table_inspection(&end),
        "suggestedMapping":{"begin":bm,"end":em}, "engine":"rust-fa"
    }))
}

fn extend_composite_key(mapping: &mut Map<String, Value>, peer: &Map<String, Value>) {
    let key = mapping
        .get("matchKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let name = mapping.get("name").and_then(Value::as_str).unwrap_or("");
    let peer_key = peer.get("matchKey").and_then(Value::as_str).unwrap_or("");
    let peer_name = peer.get("name").and_then(Value::as_str).unwrap_or("");
    let mut keys = Vec::new();
    if !key.is_empty() {
        keys.push(Value::String(key.into()));
    }
    if !key.is_empty()
        && !peer_key.is_empty()
        && !name.is_empty()
        && !peer_name.is_empty()
        && name != key
    {
        keys.push(Value::String(name.into()));
    }
    mapping.insert("matchKeys".into(), Value::Array(keys));
}

fn supplement_inspect(params: Value) -> Result<Value, AppError> {
    let path = required_path(&params, "path")?;
    let table = load_table(
        &path,
        params.get("sheet").and_then(Value::as_str),
        optional_header(&params, "headerRow")?,
        false,
    )?;
    let mut mapping = suggest_mapping(&table);
    let references = strings(params.get("referenceKeys"));
    // A header resemblance is not evidence that two ledgers use the same ID:
    // client exports often contain several columns all named like an asset
    // code.  When the primary ledger is available, prove the correspondence
    // from values instead.  Addition is checked against file2 and disposal
    // against file1 by the caller.
    let reference_table = params
        .get("referencePath")
        .and_then(Value::as_str)
        .filter(|path| !path.trim().is_empty())
        .map(|path| {
            load_table(
                Path::new(path),
                params.get("referenceSheet").and_then(Value::as_str),
                optional_header(&params, "referenceHeaderRow")?,
                false,
            )
        })
        .transpose()?;
    let exact_sample_match = reference_table.is_some() && !references.is_empty();
    let mut keys = reference_table
        .as_ref()
        .map(|reference| infer_supplement_keys_by_samples(&table, reference, &references))
        .unwrap_or_default();

    // Compatibility fallback for API callers that do not provide the primary
    // workbook.  Once real reference values were supplied, a failed proof must
    // remain empty for manual/LLM review instead of silently reverting to a
    // header guess.
    if !exact_sample_match {
        for reference in &references {
            let nr = normalize_header(&reference);
            let exact = table
                .headers
                .iter()
                .find(|h| normalize_header(h) == nr)
                .cloned();
            let candidate = exact.or_else(|| {
                if looks_like_id(&reference) {
                    mapping
                        .get("matchKey")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                } else if looks_like_name(&reference) {
                    mapping
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                } else {
                    table
                        .headers
                        .iter()
                        .find(|h| {
                            normalize_header(h).contains(&nr) || nr.contains(&normalize_header(h))
                        })
                        .cloned()
                }
            });
            if let Some(candidate) = candidate {
                if !keys.contains(&candidate) {
                    keys.push(candidate);
                }
            }
        }
    }
    if keys.is_empty() && !exact_sample_match {
        for name in ["matchKey", "name"] {
            if let Some(value) = mapping.get(name).and_then(Value::as_str) {
                if !keys.iter().any(|item| item == value) {
                    keys.push(value.into());
                }
            }
        }
    }
    let keys_verified = exact_sample_match && keys.len() == references.len();
    mapping.insert("matchKeys".into(), json!(keys));
    mapping.insert("matchKeysVerified".into(), json!(keys_verified));
    let mut result = table_inspection(&table)
        .as_object()
        .cloned()
        .unwrap_or_default();
    result.insert("suggestedMapping".into(), Value::Object(mapping));
    result.insert("engine".into(), json!("rust-fa"));
    Ok(Value::Object(result))
}

/// Establish a one-to-one mapping from the primary ledger's configured keys to
/// supplement columns using values, not header wording.
///
/// For each candidate supplement column we take exactly three non-blank data
/// samples.  A candidate is accepted only when all three values occur verbatim
/// (under the same harmless trim/case/Excel-`.0` normalization used by the
/// merger) in one configured key column of the primary ledger.  Every primary
/// key must be proved and every supplement column may be used once; otherwise
/// no partial composite key is returned.
fn infer_supplement_keys_by_samples(
    supplement: &Table,
    reference: &Table,
    reference_keys: &[String],
) -> Vec<String> {
    if supplement.rows.len() < 3 {
        return Vec::new();
    }
    // Use three representative data rows (head/middle/tail).  This is stable
    // across repeated reviews while avoiding the bias of checking only the
    // first few records, which are often one batch copied from the same source.
    let sample_rows = [0usize, supplement.rows.len() / 2, supplement.rows.len() - 1];
    let Some(reference_indexes) = reference_keys
        .iter()
        .map(|key| reference.headers.iter().position(|header| header == key))
        .collect::<Option<Vec<_>>>()
    else {
        return Vec::new();
    };
    let reference_values = reference_indexes
        .iter()
        .map(|index| {
            reference
                .rows
                .iter()
                .map(|row| normalize_key(cell(row, *index), true, false))
                .filter(|value| !value.is_empty())
                .collect::<HashSet<_>>()
        })
        .collect::<Vec<_>>();
    let mut used = HashSet::new();
    let mut result = Vec::with_capacity(reference_keys.len());
    for (reference_position, reference_key) in reference_keys.iter().enumerate() {
        let mut candidates = supplement
            .headers
            .iter()
            .enumerate()
            .filter(|(column, _)| !used.contains(column))
            .filter_map(|(column, header)| {
                let samples = supplement
                    .rows
                    .iter()
                    .enumerate()
                    .filter(|(row, _)| sample_rows.contains(row))
                    .map(|(_, row)| normalize_key(cell(row, column), true, false))
                    .collect::<Vec<_>>();
                if samples.len() != 3
                    || !samples
                        .iter()
                        .all(|value| reference_values[reference_position].contains(value))
                {
                    return None;
                }
                let exact_header =
                    usize::from(normalize_header(header) == normalize_header(reference_key));
                let semantic_header = usize::from(
                    (looks_like_id(header) && looks_like_id(reference_key))
                        || (looks_like_name(header) && looks_like_name(reference_key)),
                );
                let distinct_samples = samples.iter().collect::<HashSet<_>>().len();
                Some((
                    exact_header,
                    semantic_header,
                    distinct_samples,
                    std::cmp::Reverse(column),
                    column,
                    header.clone(),
                ))
            })
            .collect::<Vec<_>>();
        candidates.sort_unstable_by(|a, b| b.cmp(a));
        let Some((_, _, _, _, column, header)) = candidates.into_iter().next() else {
            return Vec::new();
        };
        used.insert(column);
        result.push(header);
    }
    result
}

fn llm_review(params: Value, supplement: bool) -> Result<Value, AppError> {
    let settings = params
        .get("__settings")
        .and_then(|value| value.get("llm"))
        .or_else(|| params.get("__llmOptions"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let enabled = settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return Ok(
            json!({"engine":"rust-fa","enabled":false,"passed":true,"autoApplied":[],"fieldReviews":[],
            "message":"工具箱 LLM 未启用，已使用 Rust 内置字段规则。"}),
        );
    }
    let payload = if supplement {
        supplement_llm_payload(&params)?
    } else {
        main_llm_payload(&params)?
    };
    let system = if supplement {
        "你是固定资产审计补充清单映射复核助手。只能使用 payload.headers 中的原始列名。返回严格 JSON：{suggestions:[{role,file_side,suggested_column,confidence,action,reason}],fieldReviews:[{role,current_mapping,suggested_mapping,confidence,action,reason}],matchReview:{status,confidence,action,reasons,suggested_file1_columns,suggested_file2_columns,suggestion_reason}}。suggested_mapping 必须是 JSON 对象，例如 {\"file1\":\"新增方式\"}，禁止返回字符串。新增清单角色仅 addition_method/addition_date，file_side=file1；处置清单角色仅 disposal_method/disposal_date/disposal_orig/disposal_dep，file_side=file2。action 只能 fill/review/keep。"
    } else {
        "你是固定资产清单字段和组合匹配键复核助手。只能使用 payload 中对应文件 headers 的原始列名，不得虚构。返回严格 JSON：{suggestions:[{role,file_side,suggested_column,confidence,action,reason}],fieldReviews:[{role,current_mapping,suggested_mapping,confidence,action,reason}],matchReview:{status,confidence,action,reasons,suggested_file1_columns,suggested_file2_columns,suggestion_reason}}。suggested_mapping 必须是 JSON 对象，例如 {\"file1\":\"期末原值\",\"file2\":\"资产原值\"}，禁止返回字符串或说明文字。角色仅 category/name/original_value/depreciation/date/life/residual/current_year_dep/addition_method/addition_date；file_side 仅 file1/file2；其中 current_year_dep/addition_method/addition_date 仅适用于 file2，禁止为 file1 建议或复核这三个角色；action 只能 fill/review/keep。必须逐项检查 payload.file1/file2.unmappedRoles；若 headers 中存在可映射列，必须对该角色返回 action=fill 的建议，不能因两个文件表头一致、样例一致或匹配键正确就宣称全部映射正确。payload 中的 unmappedCandidates 是本地规则识别出的高可信候选，应优先复核并在合理时采用。已映射角色同样必须逐项核对：不得仅凭列名相似判定无需调整，必须结合 samples 中该列的样例核对数据形态——类别列应为少量重复的分类文本，原值/折旧/残值率应为数值，日期列为日期，寿命为月数；若当前映射列的形态不符且 headers 中另有形态更符合的列，必须返回 action=review 的 fieldReviews 建议。payload 中的 suspectMappings 是本地规则发现的疑似错配，必须优先复核。只有所有已映射及未映射角色均已检查且确实无需调整时，才返回空数组并令 matchReview.action=keep。"
    };
    let content = request_fa_llm(&settings, system, &payload.to_string())?;
    let parsed = parse_llm_json(&content).ok_or_else(|| {
        error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的 FA 映射 JSON。",
            None,
        )
    })?;
    Ok(finalize_llm_review(parsed, payload, supplement))
}

fn finalize_llm_review(parsed: Value, payload: Value, supplement: bool) -> Value {
    let mut suggestions = parsed
        .get("suggestions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            sanitize_llm_review_item(&mut item, &payload);
            llm_review_item_is_applicable(&mut item, supplement).then_some(item)
        })
        .collect::<Vec<_>>();
    let mut auto = Vec::new();
    let mut reviews = parsed
        .get("fieldReviews")
        .or_else(|| parsed.get("field_reviews"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            sanitize_llm_review_item(&mut item, &payload);
            llm_review_item_is_applicable(&mut item, supplement).then_some(item)
        })
        .collect::<Vec<_>>();
    for fallback in local_unmapped_suggestions(&payload) {
        let role = fallback.get("role").and_then(Value::as_str).unwrap_or("");
        let side = fallback
            .get("file_side")
            .and_then(Value::as_str)
            .unwrap_or("");
        let already_reviewed = suggestions
            .iter()
            .chain(reviews.iter())
            .any(|item| llm_item_targets(item, role, side));
        if !already_reviewed {
            suggestions.push(fallback);
        }
    }
    // 本地类别错配检测：LLM 漏报时兜底注入，confidence 0.9 + action review
    // 会走下方分流进入 fieldReviews，由前端自动应用并进变更清单（可撤销）。
    // supplement payload 没有该字段，自然跳过。
    for fallback in payload
        .get("suspectMappings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = fallback.get("role").and_then(Value::as_str).unwrap_or("");
        let side = fallback
            .get("file_side")
            .and_then(Value::as_str)
            .unwrap_or("");
        let already_reviewed = suggestions
            .iter()
            .chain(reviews.iter())
            .any(|item| llm_item_targets(item, role, side));
        if !already_reviewed {
            suggestions.push(fallback);
        }
    }
    for item in suggestions {
        let confidence = item
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let action = item
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("review");
        if confidence >= 0.85 && action == "fill" {
            auto.push(item);
        } else {
            reviews.push(item);
        }
    }
    let match_review=parsed.get("matchReview").or_else(||parsed.get("match_review")).cloned().unwrap_or_else(||json!({"status":"ok","confidence":0.0,"action":"keep","reasons":[],"suggested_file1_columns":[],"suggested_file2_columns":[],"suggestion_reason":""}));
    let match_action = match_review
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("keep");
    let message = if auto.is_empty() && reviews.is_empty() && match_action == "keep" {
        if supplement {
            "补充清单 LLM 复核完成：现有脚本映射无需补充，匹配键已复核。"
        } else {
            "LLM 复核完成：现有脚本映射无需补充，匹配键已复核。"
        }
    } else if supplement {
        "补充清单 LLM 复核完成。"
    } else {
        "LLM 映射复核完成。"
    };
    json!({"engine":"rust-fa","enabled":true,"passed":reviews.is_empty()&&match_action=="keep","message":message,"autoApplied":auto,"fieldReviews":reviews,"matchReview":match_review,"localProfile":payload})
}

fn llm_item_targets(item: &Value, role: &str, side: &str) -> bool {
    if item.get("role").and_then(Value::as_str) != Some(role) {
        return false;
    }
    item.get("file_side").and_then(Value::as_str) == Some(side)
        || item
            .get("suggested_mapping")
            .and_then(Value::as_object)
            .is_some_and(|mapping| mapping.contains_key(side))
}

pub(crate) fn local_unmapped_suggestions(payload: &Value) -> Vec<Value> {
    ["file1", "file2"]
        .into_iter()
        .flat_map(|side| {
            payload
                .get(side)
                .and_then(|value| value.get("unmappedCandidates"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(move |candidate| {
                    let role = candidate.get("role")?.as_str()?;
                    let column = candidate.get("column")?.as_str()?;
                    Some(json!({
                        "role": role,
                        "file_side": side,
                        "suggested_column": column,
                        "confidence": 0.95,
                        "action": "fill",
                        "reason": format!("当前字段未映射；本地字段规则在 {} 中识别到列“{}”。", side, column)
                    }))
                })
        })
        .collect()
}

/// 类别语义列：列名带 类型/类别/分类/大类 的列即使同时长得像"名称"列
/// （如“资产类型描述”），也是类别候选，不按名称列排除。
fn looks_like_category_text(header: &str) -> bool {
    let normalized = normalize_header(header);
    ["类型", "类别", "分类", "大类"]
        .iter()
        .any(|token| normalized.contains(&normalize_header(token)))
}

/// 收集某列的去重值：只扫前 2000 行、最多 200 个去重值，控制大表开销。
/// 列不存在于表头时返回 None。
fn column_value_set(table: &Table, column: &str) -> Option<std::collections::BTreeSet<String>> {
    let index = table
        .headers
        .iter()
        .position(|header| header.trim() == column.trim())?;
    let mut values = std::collections::BTreeSet::new();
    for row in table.rows.iter().take(2000) {
        let text = cell(row, index).trim();
        if !text.is_empty() {
            values.insert(text.to_owned());
            if values.len() >= 200 {
                break;
            }
        }
    }
    Some(values)
}

/// 重叠率 = 交集 / min(|A|,|B|)。任一侧为空集时返回 0（没有证据视为不重叠）。
fn value_overlap_ratio(
    a: &std::collections::BTreeSet<String>,
    b: &std::collections::BTreeSet<String>,
) -> f64 {
    let smaller = a.len().min(b.len());
    if smaller == 0 {
        return 0.0;
    }
    let shared = a.intersection(b).count();
    shared as f64 / smaller as f64
}

fn mapping_column(mapping: Option<&Value>, key: &str) -> Option<String> {
    let column = mapping?.get(key).and_then(Value::as_str)?;
    let trimmed = column.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_owned())
}

fn key_columns(keys: Option<&Value>) -> std::collections::BTreeSet<String> {
    keys.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// 在表里找与基准类别集重叠率最高的替代列。跳过当前列、匹配键列、
/// 编码列（looks_like_id）；名称列（looks_like_name）也跳过，但列名本身
/// 带类别语义的（如“资产类型描述”）除外。重叠率 ≥ 0.5 才算候选。
fn best_replacement_category_column(
    table: &Table,
    current: &str,
    keys: &std::collections::BTreeSet<String>,
    reference: &std::collections::BTreeSet<String>,
) -> Option<(String, f64)> {
    let mut best: Option<(String, f64)> = None;
    for header in &table.headers {
        if header.trim() == current.trim() || keys.contains(header.trim()) {
            continue;
        }
        if looks_like_id(header) || (looks_like_name(header) && !looks_like_category_text(header)) {
            continue;
        }
        let Some(values) = column_value_set(table, header) else {
            continue;
        };
        let ratio = value_overlap_ratio(&values, reference);
        if ratio >= 0.5
            && best
                .as_ref()
                .is_none_or(|(_, best_ratio)| ratio > *best_ratio)
        {
            best = Some((header.clone(), ratio));
        }
    }
    best
}

/// 本地"类别疑似错配"检测：存量固定资产的类别取值跨年不变，两期清单的
/// 类别列去重值应当高度重叠。当前类别列与对侧几乎不重叠、且本文件里
/// 存在与对侧高度重叠的替代列时，产出一条 review 建议交由复核链路呈现。
/// 阈值从保守（重叠 < 0.2 才触发、替代列 ≥ 0.5 才算候选、基准去重值
/// 至少 3 个），宁可漏报不可误报。
fn local_category_mismatch_suggestions(
    begin: &Table,
    begin_mapping: Option<&Value>,
    begin_keys: Option<&Value>,
    end: &Table,
    end_mapping: Option<&Value>,
    end_keys: Option<&Value>,
) -> Vec<Value> {
    let mut result = Vec::new();
    let (Some(begin_col), Some(end_col)) = (
        mapping_column(begin_mapping, "category"),
        mapping_column(end_mapping, "category"),
    ) else {
        return result;
    };
    let (Some(begin_values), Some(end_values)) = (
        column_value_set(begin, &begin_col),
        column_value_set(end, &end_col),
    ) else {
        return result;
    };
    if begin_values.len() < 3 {
        return result;
    }
    if value_overlap_ratio(&end_values, &begin_values) < 0.2 {
        let end_keys = key_columns(end_keys);
        if let Some((column, _)) =
            best_replacement_category_column(end, &end_col, &end_keys, &begin_values)
        {
            result.push(json!({
                "role": "category",
                "file_side": "file2",
                "suggested_column": column,
                "confidence": 0.9,
                "action": "review",
                "reason": format!("期初与期末当前类别列取值几乎不重叠，而“{column}”与期初类别高度一致，疑似期末类别映射错列。")
            }));
        }
    }
    // 对称检查期初侧：期末类别集做基准，期初文件里找替代列。
    if end_values.len() >= 3 && value_overlap_ratio(&begin_values, &end_values) < 0.2 {
        let begin_keys = key_columns(begin_keys);
        if let Some((column, _)) =
            best_replacement_category_column(begin, &begin_col, &begin_keys, &end_values)
        {
            result.push(json!({
                "role": "category",
                "file_side": "file1",
                "suggested_column": column,
                "confidence": 0.9,
                "action": "review",
                "reason": format!("期初与期末当前类别列取值几乎不重叠，而“{column}”与期末类别高度一致，疑似期初类别映射错列。")
            }));
        }
    }
    result
}

pub(crate) fn sanitize_llm_review_item(item: &mut Value, payload: &Value) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    if let Some(raw) = object.get("suggested_mapping").cloned() {
        object.insert(
            "suggested_mapping".into(),
            Value::Object(normalize_llm_mapping(&raw, payload)),
        );
    }
    let side = object
        .get("file_side")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let column = object
        .get("suggested_column")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let (Some(side), Some(column)) = (side, column) {
        let headers = payload_headers(payload, &side);
        if !headers.is_empty() && resolve_payload_header(payload, &side, &column).is_none() {
            object.insert("confidence".into(), json!(0.0));
            object.insert("action".into(), json!("review"));
            object.remove("suggested_column");
        }
    }
}

fn llm_review_item_is_applicable(item: &mut Value, supplement: bool) -> bool {
    let role = item.get("role").and_then(Value::as_str).unwrap_or("");
    if supplement {
        return match role {
            "addition_method" | "addition_date" => item
                .get("file_side")
                .and_then(Value::as_str)
                .is_none_or(|side| side == "file1"),
            "disposal_method" | "disposal_date" | "disposal_orig" | "disposal_dep" => item
                .get("file_side")
                .and_then(Value::as_str)
                .is_none_or(|side| side == "file2"),
            _ => true,
        };
    }
    if matches!(
        role,
        "current_year_dep" | "addition_method" | "addition_date"
    ) {
        if item
            .get("file_side")
            .and_then(Value::as_str)
            .is_some_and(|side| side == "file1")
        {
            return false;
        }
        if item
            .get("suggested_mapping")
            .and_then(Value::as_object)
            .is_some_and(|mapping| mapping.contains_key("file1") && !mapping.contains_key("file2"))
        {
            return false;
        }
        if let Some(mapping) = item
            .get_mut("suggested_mapping")
            .and_then(Value::as_object_mut)
        {
            mapping.remove("file1");
        }
    }
    true
}

fn normalize_llm_mapping(raw: &Value, payload: &Value) -> Map<String, Value> {
    let mut result = Map::new();
    match raw {
        Value::Object(values) => {
            for side in ["file1", "file2"] {
                if let Some(column) = values.get(side).and_then(Value::as_str) {
                    let headers = payload_headers(payload, side);
                    if headers.is_empty() {
                        result.insert(side.into(), Value::String(column.trim().to_owned()));
                    } else if let Some(header) = resolve_payload_header(payload, side, column) {
                        result.insert(side.into(), Value::String(header));
                    }
                }
            }
        }
        Value::String(text) => {
            let lower = text.to_ascii_lowercase();
            for side in ["file1", "file2"] {
                let Some(start) = lower.find(side) else {
                    continue;
                };
                let after = &text[start + side.len()..];
                let end = ["file1", "file2"]
                    .into_iter()
                    .filter(|candidate| *candidate != side)
                    .filter_map(|candidate| after.to_ascii_lowercase().find(candidate))
                    .min()
                    .unwrap_or(after.len());
                let segment = &after[..end];
                if let Some(header) = payload_headers(payload, side)
                    .into_iter()
                    .filter(|header| segment.contains(header))
                    .max_by_key(|header| header.chars().count())
                {
                    result.insert(side.into(), Value::String(header));
                }
            }
        }
        _ => {}
    }
    result
}

fn payload_headers(payload: &Value, side: &str) -> Vec<String> {
    payload
        .get(side)
        .and_then(|value| value.get("headers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn resolve_payload_header(payload: &Value, side: &str, candidate: &str) -> Option<String> {
    let normalized = normalize_header(candidate);
    payload_headers(payload, side)
        .into_iter()
        .find(|header| normalize_header(header) == normalized)
}

fn main_llm_payload(params: &Value) -> Result<Value, AppError> {
    let begin = load_table(
        &required_path(params, "beginPath")?,
        params.get("beginSheet").and_then(Value::as_str),
        optional_header(params, "beginHeaderRow")?,
        false,
    )?;
    let end = load_table(
        &required_path(params, "endPath")?,
        params.get("endSheet").and_then(Value::as_str),
        optional_header(params, "endHeaderRow")?,
        false,
    )?;
    let suspect_mappings = local_category_mismatch_suggestions(
        &begin,
        params.get("beginMapping"),
        params.get("beginKeys"),
        &end,
        params.get("endMapping"),
        params.get("endKeys"),
    );
    Ok(json!({
        "file1": main_llm_side_payload(
            &begin,
            params.get("beginMapping"),
            params.get("beginKeys"),
            false,
        ),
        "file2": main_llm_side_payload(
            &end,
            params.get("endMapping"),
            params.get("endKeys"),
            true,
        ),
        "suspectMappings": suspect_mappings
    }))
}

fn main_llm_side_payload(
    table: &Table,
    mapping: Option<&Value>,
    keys: Option<&Value>,
    include_file2_only: bool,
) -> Value {
    let suggested = suggest_mapping(table);
    let roles = [
        ("category", "category", false),
        ("name", "name", false),
        ("originalValue", "original_value", false),
        ("depreciation", "depreciation", false),
        ("startDate", "date", false),
        ("life", "life", false),
        ("residualRate", "residual", false),
        ("currentYearDep", "current_year_dep", true),
        ("additionMethod", "addition_method", true),
        ("additionDate", "addition_date", true),
    ];
    let current = mapping.and_then(Value::as_object);
    let mut unmapped_roles = Vec::new();
    let mut unmapped_candidates = Vec::new();
    for (mapping_key, role, file2_only) in roles {
        if file2_only && !include_file2_only {
            continue;
        }
        let mapped = current
            .and_then(|values| values.get(mapping_key))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        if mapped {
            continue;
        }
        unmapped_roles.push(Value::String(role.to_owned()));
        if let Some(column) = suggested.get(mapping_key).and_then(Value::as_str) {
            unmapped_candidates.push(json!({"role": role, "column": column}));
        }
    }
    json!({
        "headers": table.headers,
        "samples": sample_columns(table),
        "mapping": mapping,
        "keys": keys,
        "unmappedRoles": unmapped_roles,
        "unmappedCandidates": unmapped_candidates,
    })
}
fn supplement_llm_payload(params: &Value) -> Result<Value, AppError> {
    let mut payload = Map::new();
    for (name, label) in [("addition", "file1"), ("disposal", "file2")] {
        if let Some(config) = params.get(name).filter(|v| v.get("path").is_some()) {
            let table = load_supplement(config)?;
            payload.insert(label.into(),json!({"headers":table.headers,"samples":sample_columns(&table),"mapping":config,"keys":config.get("keys")}));
        }
    }
    payload.insert(
        "beginKeys".into(),
        params.get("beginKeys").cloned().unwrap_or(json!([])),
    );
    payload.insert(
        "endKeys".into(),
        params.get("endKeys").cloned().unwrap_or(json!([])),
    );
    Ok(Value::Object(payload))
}
pub(crate) fn sample_columns(table: &Table) -> Value {
    let mut map = Map::new();
    for (i, h) in table.headers.iter().enumerate() {
        let values = table
            .rows
            .iter()
            .map(|r| cell(r, i))
            .filter(|v| !v.trim().is_empty())
            .take(5)
            .collect::<Vec<_>>();
        map.insert(h.clone(), json!(values));
    }
    Value::Object(map)
}

pub(crate) fn request_fa_llm(config: &Value, prompt: &str, text: &str) -> Result<String, AppError> {
    let api_type = config
        .get("apiType")
        .or_else(|| config.get("api_type"))
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let base = config
        .get("baseUrl")
        .or_else(|| config.get("base_url"))
        .and_then(Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(error(
            "LLM_URL_INVALID",
            "LLM Base URL 必须使用 HTTP 或 HTTPS。",
            None,
        ));
    }
    let secret_name = if api_type == "dify_chat" {
        "dify_api_key"
    } else {
        "llm_api_key"
    };
    let key = config
        .get("api_key")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            keyring::Entry::new("AuditToolbox", secret_name)
                .ok()
                .and_then(|e| e.get_password().ok())
        })
        .ok_or_else(|| {
            error(
                "LLM_KEY_MISSING",
                "工具箱已启用 LLM，但没有找到 API Key。",
                None,
            )
        })?;
    let timeout = config
        .get("timeout")
        .and_then(Value::as_u64)
        // FA 复核是全工具箱最重的一次 LLM 调用，默认值按它来定。
        .unwrap_or(120)
        .clamp(10, 600);
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| {
            error(
                "LLM_NETWORK_FAILED",
                "无法创建 LLM 网络请求。",
                Some(e.to_string()),
            )
        })?;
    if api_type == "dify_chat" {
        let url = if base.ends_with("/chat-messages") {
            base.into()
        } else {
            format!("{base}/chat-messages")
        };
        let response=client.post(url).bearer_auth(key).json(&json!({"inputs":{},"query":format!("{prompt}\n\n{text}"),"response_mode":"blocking","user":"audit-toolbox-fa"})).send().map_err(|e| llm_network(e, timeout))?;
        let value = read_llm_response(response, "Dify FA 映射复核失败。", timeout)?;
        return Ok(value
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned());
    }
    let url = if base.ends_with("/chat/completions") {
        base.into()
    } else {
        format!("{base}/chat/completions")
    };
    let mut request = client.post(url);
    let auth_mode = config
        .get("authMode")
        .or_else(|| config.get("auth_mode"))
        .and_then(Value::as_str)
        .unwrap_or("bearer");
    if auth_mode == "raw" {
        request = request.header("Authorization", key);
    } else {
        request = request.bearer_auth(key);
    }
    // 旧版每次结构化调用都发这两个参数，迁移时漏掉了，代价是推理型模型
    // （用户实测的 DeepSeek 就是）会先跑一大段思维链再吐 JSON，几十秒过去
    // 请求已经超时；返回的内容也常带着解释文字，解析同样容易失败。
    let json_prompt = crate::audipick::json_response_prompt(base, prompt);
    let system_prompt = json_prompt.as_deref().unwrap_or(prompt);
    let mut body = json!({
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "temperature": 0,
        "messages": [{"role":"system","content":system_prompt},{"role":"user","content":text}],
        "thinking": {"type": if thinking_enabled(config) { "enabled" } else { "disabled" }},
    });
    if json_prompt.is_some() {
        body["response_format"] = json!({"type": "json_object"});
    }
    let response = request
        .json(&body)
        .send()
        .map_err(|e| llm_network(e, timeout))?;
    let value = read_llm_response(response, "LLM FA 映射复核失败。", timeout)?;
    Ok(value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}
fn fa_llm_error_message(value: &Value) -> String {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("远程服务返回错误")
        .chars()
        .take(300)
        .collect()
}
pub(crate) fn parse_llm_json(content: &str) -> Option<Value> {
    let text = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        serde_json::from_str(&text[start..=end]).ok()
    })
}
/// 结构化任务默认关闭思维链：这些调用要的是一段 JSON，不是推理过程。
/// 旧版无条件下发该字段，只有用户显式打开"思考模式"时才置为 enabled。
fn thinking_enabled(config: &Value) -> bool {
    config
        .get("thinking_enabled")
        .or_else(|| config.get("thinkingEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn llm_network(e: reqwest::Error, timeout: u64) -> AppError {
    // reqwest 把超时、连接失败和响应体解码失败都归到同一类错误，
    // 用户看到的只是一句"网络请求失败"，无从判断该调超时还是查代理。
    //
    // 超时提示必须带上当前生效的秒数：只说"可以调大"而不说现在是多少，
    // 用户改完设置也无法判断到底生效没有。
    let message = if e.is_timeout() {
        format!(
            "LLM 请求超时（当前设置 {timeout} 秒）。FA 映射复核要把所有列名和样例值发给模型，耗时明显长于连接测试；请在设置中把超时秒数调大后保存再重试。"
        )
    } else if e.is_connect() {
        "无法连接 LLM 服务，请检查 Base URL、代理和网络。".to_owned()
    } else {
        "LLM FA 映射复核网络请求失败。".to_owned()
    };
    error("LLM_NETWORK_FAILED", message, Some(e.to_string()))
}

fn body_snippet(body: &str) -> String {
    let text: String = body.trim().chars().take(300).collect();
    if text.is_empty() {
        "响应体为空".into()
    } else {
        text
    }
}

/// 先取文本，再判状态，最后解析 JSON。
///
/// 直接 `response.json()` 会把网关返回的 HTML 错误页、限流的纯文本提示和被截断
/// 的响应，统统变成一句 "error decoding response body"；而且原来是先解析后判状态，
/// 非 2xx 且响应体不是 JSON 时永远走不到报 HTTP 状态那一行，真正的服务端信息全丢了。
fn read_llm_response(
    response: reqwest::blocking::Response,
    label: &str,
    timeout: u64,
) -> Result<Value, AppError> {
    let status = response.status();
    let body = response.text().map_err(|e| llm_network(e, timeout))?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .as_ref()
            .map(fa_llm_error_message)
            .unwrap_or_else(|_| body_snippet(&body));
        return Err(error(
            "LLM_REQUEST_FAILED",
            label,
            Some(format!("HTTP {status}：{detail}")),
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        error(
            "LLM_RESPONSE_INVALID",
            "LLM 返回的内容不是有效 JSON，可能被网关、代理或安全设备改写。",
            Some(format!("{e}；响应开头：{}", body_snippet(&body))),
        )
    })
}

fn preview(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let result = merge(&params, progress, &cancel)?;
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("preview", 4, 4, "匹配预览完成");
    let counts = result.rows.iter().fold([0usize; 3], |mut acc, row| {
        match row.source {
            "两文件都有" => acc[0] += 1,
            "仅文件1" => acc[1] += 1,
            _ => acc[2] += 1,
        }
        acc
    });
    // 明细前 N 行对核对没有帮助：审计员要看的是期初→期末的增减变动是否
    // 对得上，所以预览直接给变动汇总（与导出的固定资产变动汇总表同一份
    // 行定义，数值为数字，由前端按千分位渲染）。
    let (categories, lines, _noise) = build_summary_lines(&result, &params, true);
    let summary_rows = lines
        .iter()
        .map(|line| {
            json!({"section": line.section, "item": line.item,
                "values": line.values.iter().map(|v| round_money(*v)).collect::<Vec<_>>()})
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "engine":"rust-fa", "message":format!("完全外连接完成，共 {} 行。", result.rows.len()),
        "stats":{"rows":result.rows.len(),"both":counts[0],"beginOnly":counts[1],"endOnly":counts[2],
            "duplicates":{"hasDuplicates":result.duplicate_values>0,"duplicateValueCount":result.duplicate_values,"duplicateRowCount":result.duplicate_rows},
            "unmatchedAddition":result.unmatched_addition.len(),"unmatchedDisposal":result.unmatched_disposal.len()},
        "summary":{"columns":categories,"rows":summary_rows}
    }))
}

fn export(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let result = merge(&params, progress, &cancel)?;
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("export", 3, 4, "正在生成 FA List、变动清单、汇总与透视表");
    let output = output_path(&params, &result.end.path)?;
    if output
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.eq_ignore_ascii_case("csv"))
        .unwrap_or(false)
    {
        pause.wait()?;
        write_csv(&output, &result, strings(params.get("selectedColumns")))?;
    } else {
        pause.wait()?;
        write_xlsx(&output, &result, &params, &cancel)?;
    }
    let mut export_message = "FA List 导出完成".to_owned();
    if !result.unmatched_addition.is_empty() || !result.unmatched_disposal.is_empty() {
        let path = output
            .parent()
            .unwrap_or(Path::new("."))
            .join("[未匹配资产变动清单].xlsx");
        pause.wait()?;
        write_unmatched(&path, &result, &cancel)?;
        export_message.push_str("；已生成未匹配资产变动清单");
    }
    let warnings = correction_warnings(&result, &params);
    if !warnings.is_empty() {
        export_message.push_str("===CORRECTION_WARNINGS===");
        export_message.push_str(&warnings.join("\n"));
    }
    check_cancel(&cancel)?;
    progress("completed", 4, 4, "FA List 导出完成");
    Ok(
        json!({"engine":"rust-fa","message":"完全外连接完成。","exportMessage":export_message,
        "rows":result.rows.len(),"columns":result_columns(&result,true).len(),"outputPaths":[output.to_string_lossy()]}),
    )
}

pub(crate) fn merge(
    params: &Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<MergeResult, AppError> {
    let begin_path = required_path(params, "beginPath")?;
    let end_path = required_path(params, "endPath")?;
    let begin_keys = required_strings(
        params,
        "beginKeys",
        "FA_KEY_REQUIRED",
        "请至少选择一个期初匹配列。",
    )?;
    let end_keys = required_strings(
        params,
        "endKeys",
        "FA_KEY_REQUIRED",
        "请至少选择一个期末匹配列。",
    )?;
    if begin_keys.len() != end_keys.len() {
        return Err(error(
            "FA_KEY_COUNT_MISMATCH",
            "期初和期末匹配列数量必须一致。",
            None,
        ));
    }
    progress("load", 0, 4, "正在读取期初固定资产清单");
    let begin = load_table(
        &begin_path,
        params.get("beginSheet").and_then(Value::as_str),
        optional_header(params, "beginHeaderRow")?,
        false,
    )?;
    check_cancel(cancel)?;
    progress("load", 1, 4, "正在读取期末固定资产清单");
    let end = load_table(
        &end_path,
        params.get("endSheet").and_then(Value::as_str),
        optional_header(params, "endHeaderRow")?,
        false,
    )?;
    validate_keys(&begin, &begin_keys)?;
    validate_keys(&end, &end_keys)?;
    check_cancel(cancel)?;
    progress("match", 2, 4, "正在执行多键全外连接");
    let remove_spaces = params
        .get("removeSpaces")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let case_sensitive = params
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mode = params
        .get("handleDuplicates")
        .and_then(Value::as_str)
        .unwrap_or("pivot");
    let bi = key_indexes(&begin, &begin_keys);
    let ei = key_indexes(&end, &end_keys);
    let begin_groups = grouped_rows(&begin, &bi, remove_spaces, case_sensitive);
    let end_groups = grouped_rows(&end, &ei, remove_spaces, case_sensitive);
    // Match pandas' stable outer-join order: keep the first occurrence order
    // from file1, then append keys which only occur in file2.  Sorting keys
    // here made duplicate-card displays jump around between the old and new UI.
    let mut keys = ordered_group_keys(&begin, &bi, remove_spaces, case_sensitive);
    let mut seen = keys.iter().cloned().collect::<HashSet<_>>();
    for key in ordered_group_keys(&end, &ei, remove_spaces, case_sensitive) {
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    }
    let mut rows = Vec::new();
    let mut duplicate_values = 0;
    let mut duplicate_rows = 0;
    for (key_index, key) in keys.into_iter().enumerate() {
        if key_index % 1024 == 0 {
            check_cancel(cancel)?;
        }
        let mut left = begin_groups.get(&key).cloned().unwrap_or_default();
        let mut right = end_groups.get(&key).cloned().unwrap_or_default();
        if left.len() > 1 || right.len() > 1 {
            duplicate_values += 1;
            duplicate_rows += left.len() + right.len();
        }
        if mode == "keep_first" {
            left.truncate(1);
            right.truncate(1);
        }
        if mode == "keep_last" {
            if left.len() > 1 {
                left = vec![*left.last().unwrap()];
            }
            if right.len() > 1 {
                right = vec![*right.last().unwrap()];
            }
        }
        let count = left.len().max(right.len());
        for pos in 0..count {
            let l = left.get(pos).map(|i| begin.rows[*i].clone());
            let r = right.get(pos).map(|i| end.rows[*i].clone());
            let source = match (l.is_some(), r.is_some()) {
                (true, true) => "两文件都有",
                (true, false) => "仅文件1",
                _ => "仅文件2",
            };
            rows.push(JoinedRow {
                begin: l,
                end: r,
                source,
                match_value: if key.starts_with("__BLANK__") {
                    String::new()
                } else {
                    key.replace("|||", " | ")
                },
                extra: BTreeMap::new(),
            });
        }
    }
    // The legacy exporter emitted 合并数据 / 新增清单 / 处置清单 ordered by the
    // match key, so file2-only cards sit next to the file1 cards sharing their
    // asset id instead of being appended in a block at the end.  Sort is
    // stable, so duplicate keys keep the order they were paired in.  FA List
    // follows this same merged order to preserve the legacy workbook contract.
    rows.sort_by(|a, b| {
        a.match_value
            .replace(" | ", "|||")
            .cmp(&b.match_value.replace(" | ", "|||"))
    });
    let mut result = MergeResult {
        begin,
        end,
        rows,
        begin_keys,
        end_keys,
        duplicate_values,
        duplicate_rows,
        unmatched_addition: Vec::new(),
        unmatched_disposal: Vec::new(),
    };
    add_change_columns(&mut result, params);
    apply_supplements(&mut result, params, cancel)?;
    Ok(result)
}

fn add_change_columns(result: &mut MergeResult, params: &Value) {
    let begin_mapping = params.get("beginMapping").and_then(Value::as_object);
    let end_mapping = params.get("endMapping").and_then(Value::as_object);
    let mapped = |side: Option<&Map<String, Value>>, role: &str| {
        side.and_then(|m| m.get(role))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let begin_original = params
        .get("beginOriginalValue")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| mapped(begin_mapping, "originalValue"));
    let end_original = params
        .get("endOriginalValue")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| mapped(end_mapping, "originalValue"));
    let begin_dep = params
        .get("beginDepreciation")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| mapped(begin_mapping, "depreciation"));
    let end_dep = params
        .get("endDepreciation")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| mapped(end_mapping, "depreciation"));
    let bi_original = begin_original
        .as_ref()
        .and_then(|v| result.begin.headers.iter().position(|h| h == v));
    let ei_original = end_original
        .as_ref()
        .and_then(|v| result.end.headers.iter().position(|h| h == v));
    let bi_dep = begin_dep
        .as_ref()
        .and_then(|v| result.begin.headers.iter().position(|h| h == v));
    let ei_dep = end_dep
        .as_ref()
        .and_then(|v| result.end.headers.iter().position(|h| h == v));
    for row in &mut result.rows {
        if bi_original.is_some() || ei_original.is_some() {
            let before = bi_original
                .and_then(|i| row.begin.as_ref().map(|r| number(cell(r, i))))
                .unwrap_or(0.0);
            let after = ei_original
                .and_then(|i| row.end.as_ref().map(|r| number(cell(r, i))))
                .unwrap_or(0.0);
            let change = before - after;
            row.extra.insert("原值变动".into(), Cell::Number(change));
            row.extra.insert(
                "原值变动类型".into(),
                Cell::Text(change_type(change, "原值")),
            );
        }
        if bi_dep.is_some() || ei_dep.is_some() {
            let before = bi_dep
                .and_then(|i| row.begin.as_ref().map(|r| number(cell(r, i))))
                .unwrap_or(0.0);
            let after = ei_dep
                .and_then(|i| row.end.as_ref().map(|r| number(cell(r, i))))
                .unwrap_or(0.0);
            let change = before - after;
            row.extra
                .insert("累计折旧变动".into(), Cell::Number(change));
            row.extra.insert(
                "累计折旧变动类型".into(),
                Cell::Text(change_type(change, "累计折旧")),
            );
        }
    }
}

fn change_type(change: f64, label: &str) -> String {
    if change > 0.000_001 {
        format!("{label}减少")
    } else if change < -0.000_001 {
        format!("{label}增加")
    } else {
        format!("{label}不变")
    }
}

fn apply_supplements(
    result: &mut MergeResult,
    params: &Value,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let valid = result
        .rows
        .iter()
        .map(|r| canonical_display_key(&r.match_value))
        .collect::<HashSet<_>>();
    if let Some(config) = params.get("additionSupplement").filter(|v| {
        v.get("path")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    }) {
        let table = load_supplement(config)?;
        let keys = strings(config.get("keys"));
        validate_keys(&table, &keys)?;
        let key_i = key_indexes(&table, &keys);
        let method = index_opt(&table, config.get("method"));
        let date = index_opt(&table, config.get("date"));
        let mut grouped: BTreeMap<String, (Vec<String>, Vec<String>)> = BTreeMap::new();
        for (row_index, row) in table.rows.iter().enumerate() {
            if row_index % 1024 == 0 {
                check_cancel(cancel)?;
            }
            let key = row_key(row, &key_i, true, false);
            if key.is_empty() {
                continue;
            }
            if !valid.contains(&key) {
                result.unmatched_addition.push(row.clone());
                continue;
            }
            let e = grouped.entry(key).or_default();
            if let Some(i) = method {
                push_unique(&mut e.0, cell(row, i));
            }
            if let Some(i) = date {
                push_unique(&mut e.1, cell(row, i));
            }
        }
        for row in &mut result.rows {
            if let Some((methods, dates)) = grouped.get(&canonical_display_key(&row.match_value)) {
                if !methods.is_empty() {
                    row.extra
                        .insert("新增方式_辅助_文件2".into(), Cell::Text(methods.join("；")));
                }
                if !dates.is_empty() {
                    row.extra
                        .insert("新增时间_辅助_文件2".into(), Cell::Text(dates.join("；")));
                }
            }
        }
    }
    if let Some(config) = params.get("disposalSupplement").filter(|v| {
        v.get("path")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    }) {
        let table = load_supplement(config)?;
        let keys = strings(config.get("keys"));
        validate_keys(&table, &keys)?;
        let key_i = key_indexes(&table, &keys);
        let method = index_opt(&table, config.get("method"));
        let date = index_opt(&table, config.get("date"));
        let original = index_opt(&table, config.get("originalValue"));
        let dep = index_opt(&table, config.get("depreciation"));
        let mut grouped: BTreeMap<String, (Vec<String>, Vec<String>, Option<f64>, Option<f64>)> =
            BTreeMap::new();
        for (row_index, row) in table.rows.iter().enumerate() {
            if row_index % 1024 == 0 {
                check_cancel(cancel)?;
            }
            let key = row_key(row, &key_i, true, false);
            if key.is_empty() {
                continue;
            }
            if !valid.contains(&key) {
                result.unmatched_disposal.push(row.clone());
                continue;
            }
            let e = grouped.entry(key).or_default();
            if let Some(i) = method {
                push_unique(&mut e.0, cell(row, i));
            }
            if let Some(i) = date {
                push_unique(&mut e.1, cell(row, i));
            }
            if let Some(i) = original {
                let value = cell(row, i);
                if !value.trim().is_empty() {
                    *e.2.get_or_insert(0.0) += number(value).abs();
                }
            }
            if let Some(i) = dep {
                let value = cell(row, i);
                if !value.trim().is_empty() {
                    *e.3.get_or_insert(0.0) += number(value).abs();
                }
            }
        }
        for row in &mut result.rows {
            if let Some((methods, dates, original, dep)) =
                grouped.get(&canonical_display_key(&row.match_value))
            {
                if !methods.is_empty() {
                    row.extra
                        .insert("处置方式_辅助_文件1".into(), Cell::Text(methods.join("；")));
                }
                if !dates.is_empty() {
                    row.extra
                        .insert("处置时间_辅助_文件1".into(), Cell::Text(dates.join("；")));
                }
                if let Some(original) = original {
                    row.extra
                        .insert("处置原值_辅助_文件1".into(), Cell::Number(*original));
                }
                if let Some(dep) = dep {
                    row.extra
                        .insert("处置折旧_辅助_文件1".into(), Cell::Number(*dep));
                }
            }
        }
    }
    Ok(())
}

fn load_supplement(config: &Value) -> Result<Table, AppError> {
    let path = required_path(config, "path")?;
    load_table(
        &path,
        config.get("sheet").and_then(Value::as_str),
        optional_header(config, "headerRow")?,
        false,
    )
}

pub(crate) fn table_inspection(table: &Table) -> Value {
    json!({"path":table.path.to_string_lossy(),"kind":if table.sheets.is_empty(){"text"}else{"excel"},"sheets":table.sheets,"selectedSheet":table.sheet,"displayName":match &table.sheet{Some(s)=>format!("{} & {}",table.path.file_name().unwrap_or_default().to_string_lossy(),s),None=>table.path.file_name().unwrap_or_default().to_string_lossy().into_owned()},"detectedHeaderRow":table.header_row,"headerMode":"auto","headers":table.headers,"preview":table.rows.iter().take(12).collect::<Vec<_>>(),"dimensions":{"rows":table.rows.len(),"columns":table.headers.len()}})
}

pub(crate) fn suggest_mapping(table: &Table) -> Map<String, Value> {
    let h = &table.headers;
    let mut m = Map::new();
    let rules: [(&str, &[&str]); 16] = [
        (
            "matchKey",
            &[
                "固定资产编号",
                "固定资产编码",
                "资产卡片编号",
                "资产卡片编码",
                "资产编号",
                "资产编码",
                "卡片编号",
                "卡片编码",
                "卡片号",
                "coding",
                "code",
                "assetid",
                "assetnumber",
            ],
        ),
        (
            "category",
            &[
                "资产类别",
                "资产大类",
                "固定资产类别",
                "资产类型描述",
                "资产类型",
                "资产分类",
                "类别",
                "大类",
            ],
        ),
        (
            "name",
            &[
                "固定资产名称",
                "资产名称",
                "资产描述",
                "设备名称",
                "description",
                "assetname",
            ],
        ),
        (
            "originalValue",
            &[
                "原值",
                "资产原值",
                "期末原值",
                "原值(期末)",
                "originalcost",
                "cost",
            ],
        ),
        (
            "depreciation",
            &["累计折旧", "期末累计折旧", "accumulateddepreciation"],
        ),
        (
            "startDate",
            &[
                "入账日期",
                "入账时间",
                "开始日期",
                "开始使用日期",
                "开始使用时间",
                "使用日期",
                "使用时间",
                "启用日期",
                "启用时间",
                "投用日期",
                "投用时间",
                "购置日期",
                "取得日期",
                "资本化日期",
                "inservicedate",
            ],
        ),
        (
            "life",
            &[
                "使用寿命",
                "使用寿命(月)",
                "预计使用期间数",
                "使用年限",
                "计划使用年",
                "预计使用年限",
                "usefullife",
            ],
        ),
        (
            "residualRate",
            &[
                "残值率",
                "预计残值率",
                "净残值率",
                "预计净残值率",
                "残值比例",
                "净残值比例",
                "residualrate",
                "残值",
                "预计残值",
                "净残值",
                "预计净残值",
                "residualvalue",
                "salvagevalue",
            ],
        ),
        (
            "currentYearDep",
            &[
                "本年折旧",
                "本期折旧",
                "当年折旧",
                "currentyeardepreciation",
            ],
        ),
        (
            "additionMethod",
            &[
                "新增方式",
                "增加方式",
                "取得方式",
                "资产来源",
                "新增来源",
                "变动方式",
                "变动类型",
                "additionmethod",
            ],
        ),
        (
            "additionDate",
            &[
                "新增时间",
                "新增日期",
                "增加时间",
                "增加日期",
                "资本化日期",
                "入账日期",
                "additiondate",
            ],
        ),
        (
            "disposalMethod",
            &["处置方式", "减少方式", "disposalmethod"],
        ),
        ("disposalDate", &["处置日期", "减少日期", "disposaldate"]),
        (
            "disposalOriginal",
            &["处置原值", "减少原值", "原值减少", "处置成本"],
        ),
        (
            "disposalDepreciation",
            &["处置折旧", "减少折旧", "累计折旧处置", "累计折旧减少"],
        ),
        ("unused", &[]),
    ];
    for (role, terms) in rules.into_iter().filter(|(r, _)| *r != "unused") {
        let value = if role == "matchKey" {
            pick_match_header(table, terms)
        } else {
            pick_header(h, terms, false)
        };
        m.insert(role.into(), value.map(Value::String).unwrap_or(Value::Null));
    }
    m
}

/// 词表之外的三层兜底，取自旧版 `mapping_rules.score_match_id`。
///
/// 旧版除了逐字匹配 9 个中文词，还认三种模式："含资产/卡片语境 + 含编号类字样"、
/// 单独含"编号"、单独含"编码"。迁移时这三层被砍掉，像 `资产序号`、`设备编号`
/// 这类没进词表、但一眼就是资产标识的列名直接不算候选，用户只能手工指定匹配键。
///
/// 分档排在词表命中之后（精确 ~1000 > 包含 ~700 > 这里 400/300/280），
/// 保证已被测试锁定的词表优先级不受影响。
fn fallback_id_score(normalized: &str) -> Option<f64> {
    if normalized.is_empty() {
        return None;
    }
    let has_asset_context = ["固定资产", "资产", "卡片"]
        .iter()
        .any(|token| normalized.contains(token));
    let has_id_token = ["编号", "编码", "代码", "号码", "号"]
        .iter()
        .any(|token| normalized.contains(token));
    if has_asset_context && has_id_token {
        return Some(400.0);
    }
    if normalized.contains("编号") {
        return Some(300.0);
    }
    if normalized.contains("编码") {
        return Some(280.0);
    }
    None
}

fn pick_match_header(table: &Table, terms: &[&str]) -> Option<String> {
    let wanted = terms
        .iter()
        .map(|v| normalize_header(v))
        .collect::<Vec<_>>();
    table
        .headers
        .iter()
        .enumerate()
        .filter(|(_, header)| !is_forbidden_id(header))
        .filter_map(|(index, header)| {
            let raw_normalized = normalize_header(header);
            let normalized = raw_normalized
                .rsplit_once('.')
                .filter(|(_, suffix)| suffix.chars().all(|ch| ch.is_ascii_digit()))
                .map(|(base, _)| base.to_owned())
                .unwrap_or(raw_normalized);
            let header_score = wanted
                .iter()
                .position(|term| normalized == *term)
                .map(|p| 1000.0 - p as f64)
                .or_else(|| {
                    wanted
                        .iter()
                        .position(|term| !term.is_empty() && normalized.contains(term))
                        .map(|p| 700.0 - p as f64)
                })
                .or_else(|| fallback_id_score(&normalized))?;
            let values = table
                .rows
                .iter()
                .map(|row| cell(row, index).trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if values.is_empty() {
                return Some((header_score, index, header.clone()));
            }
            let unique = values.iter().copied().collect::<HashSet<_>>().len() as f64;
            let unique_ratio = unique / values.len() as f64;
            let coverage = values.len() as f64 / table.rows.len().max(1) as f64;
            // A repeated company/zero code must lose to a true card ID even
            // when Excel has made the latter header unique as `资产编码.1`.
            Some((
                header_score + unique_ratio * 100.0 + coverage * 10.0,
                index,
                header.clone(),
            ))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0).then_with(|| b.1.cmp(&a.1)))
        .map(|(_, _, header)| header)
}

fn pick_header(headers: &[String], terms: &[&str], id: bool) -> Option<String> {
    let wanted = terms
        .iter()
        .map(|v| normalize_header(v))
        .collect::<Vec<_>>();
    for exact in [true, false] {
        for header in headers {
            let n = normalize_header(header);
            if id && is_forbidden_id(header) {
                continue;
            }
            if wanted.iter().any(|term| {
                if exact {
                    n == *term
                } else {
                    !term.is_empty() && n.contains(term)
                }
            }) {
                return Some(header.clone());
            }
        }
    }
    None
}
fn is_forbidden_id(v: &str) -> bool {
    [
        "公司", "分类", "类别", "大类", "描述", "名称", "原值", "折旧", "净值", "金额", "日期",
        "时间", "年限", "寿命",
    ]
    .iter()
    .any(|x| v.contains(x))
}
fn looks_like_id(v: &str) -> bool {
    !is_forbidden_id(v)
        && [
            "编号",
            "编码",
            "代码",
            "卡片号",
            "assetid",
            "code",
            "coding",
        ]
        .iter()
        .any(|x| normalize_header(v).contains(&normalize_header(x)))
}
fn looks_like_name(v: &str) -> bool {
    [
        "资产名称",
        "固定资产名称",
        "名称",
        "资产描述",
        "描述",
        "assetname",
        "description",
    ]
    .iter()
    .any(|x| normalize_header(v).contains(&normalize_header(x)))
}

fn sheet_name_affinity(path: &Path, sheet: &str) -> i32 {
    let normalized = normalize_header(sheet);
    let mut score = if matches!(
        normalized.as_str(),
        "data" | "sheet" | "sheet1" | "工作表" | "工作表1"
    ) {
        -3
    } else {
        0
    };
    if ["固定资产", "资产明细", "长期资产", "falist"]
        .iter()
        .any(|token| normalized.contains(token))
    {
        score += 3;
    }

    // When one workbook carries several years of schedules, prefer the sheet
    // whose date token agrees with the workbook name.  For example the sample
    // `长期资产明细20241231.xlsx` contains Data, `固定资产明细23年`
    // and `固定资产明细 241231`; choosing the generic first sheet adds
    // 846 stale cards and turns them into false disposals.
    let sheet_digits = sheet
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    let path_digits = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    if sheet_digits.len() >= 4 && path_digits.contains(&sheet_digits) {
        score += 4;
    }
    score
}

pub(crate) fn load_table(
    path: &Path,
    requested_sheet: Option<&str>,
    header: Option<usize>,
    choose_best: bool,
) -> Result<Table, AppError> {
    if !path.is_file() {
        return Err(error(
            "FILE_NOT_FOUND",
            "选择的文件不存在。",
            Some(path.to_string_lossy().into_owned()),
        ));
    }
    if crate::spreadsheet_input::is_text(path.as_ref()) {
        return load_csv(path, header);
    }
    let mut workbook = open_workbook_auto(path).map_err(|e| {
        error(
            "FA_LOAD_FAILED",
            "无法读取固定资产文件。",
            Some(e.to_string()),
        )
    })?;
    // 隐藏工作表往往是上一版底稿或中间过程表。旧版的工作表下拉只列可见表，
    // 用户根本选不到；新版把它们一并纳入自动选表候选后，一张字段更齐全的
    // 隐藏旧表就可能被选中，而界面上没有任何迹象表明用的不是当前表。
    let visible = workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| sheet.visible == calamine::SheetVisible::Visible)
        .map(|sheet| sheet.name.clone())
        .collect::<Vec<_>>();
    let sheets = if visible.is_empty() {
        // 整本都被标记为隐藏时不能把用户挡死，退回全部工作表。
        workbook.sheet_names().to_vec()
    } else {
        visible
    };
    if sheets.is_empty() {
        return Err(error("FA_LOAD_FAILED", "工作簿没有工作表。", None));
    }
    let candidates = if let Some(sheet) = requested_sheet.filter(|s| sheets.iter().any(|v| v == *s))
    {
        vec![sheet.to_owned()]
    } else if choose_best {
        sheets.clone()
    } else {
        vec![sheets[0].clone()]
    };
    let mut best: Option<(i32, String, usize, Vec<Vec<String>>)> = None;
    for (pos, sheet) in candidates.iter().enumerate() {
        let range = workbook
            .worksheet_range(sheet)
            .map_err(|e| error("FA_LOAD_FAILED", "无法读取工作表。", Some(e.to_string())))?;
        let matrix = range
            .rows()
            .map(|r| r.iter().map(data_string).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let hi = header
            .map(|v| v.saturating_sub(1))
            .unwrap_or_else(|| detect_header(&matrix));
        let headers = unique_headers(matrix.get(hi).cloned().unwrap_or_default());
        let mapping = suggest_mapping(&Table {
            path: path.into(),
            sheet: Some(sheet.clone()),
            sheets: vec![],
            header_row: hi + 1,
            headers: headers.clone(),
            rows: vec![],
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
        let take = best.as_ref().is_none_or(|b| score > b.0);
        if take {
            best = Some((score, sheet.clone(), hi, matrix));
        }
    }
    let (_, sheet, hi, matrix) = best.unwrap();
    let headers = unique_headers(matrix.get(hi).cloned().unwrap_or_default());
    let width = headers.len();
    let rows = matrix
        .into_iter()
        .skip(hi + 1)
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .map(|mut r| {
            r.resize(width, String::new());
            r.truncate(width);
            r
        })
        .collect();
    Ok(Table {
        path: path.into(),
        sheet: Some(sheet),
        sheets,
        header_row: hi + 1,
        headers,
        rows,
    })
}

fn load_csv(path: &Path, header: Option<usize>) -> Result<Table, AppError> {
    let matrix = crate::spreadsheet_input::read_rows(path)?;
    let hi = header
        .map(|v| v.saturating_sub(1))
        .unwrap_or_else(|| detect_header(&matrix));
    let headers = unique_headers(matrix.get(hi).cloned().unwrap_or_default());
    let width = headers.len();
    let rows = matrix
        .into_iter()
        .skip(hi + 1)
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .map(|mut r| {
            r.resize(width, String::new());
            r.truncate(width);
            r
        })
        .collect();
    Ok(Table {
        path: path.into(),
        sheet: None,
        sheets: vec![],
        header_row: hi + 1,
        headers,
        rows,
    })
}

fn detect_header(rows: &[Vec<String>]) -> usize {
    rows.iter()
        .take(20)
        .enumerate()
        .max_by_key(|(_, r)| {
            let nonempty = r.iter().filter(|v| !v.trim().is_empty()).count();
            let keywords = r
                .iter()
                .filter(|v| {
                    [
                        "编号", "编码", "名称", "类别", "原值", "折旧", "寿命", "日期",
                    ]
                    .iter()
                    .any(|x| v.contains(x))
                })
                .count();
            nonempty + keywords * 4
        })
        .map(|(i, _)| i)
        .unwrap_or(0)
}
fn unique_headers(row: Vec<String>) -> Vec<String> {
    let mut counts = HashMap::new();
    row.into_iter()
        .enumerate()
        .map(|(i, v)| {
            let base = if v.trim().is_empty() {
                format!("Unnamed: {i}")
            } else {
                v.trim().to_owned()
            };
            let n = counts.entry(base.clone()).or_insert(0usize);
            let out = if *n == 0 {
                base.clone()
            } else {
                format!("{base}.{n}")
            };
            *n += 1;
            out
        })
        .collect()
}
fn data_string(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(v) => v.trim().to_owned(),
        Data::Float(v) if v.fract().abs() < f64::EPSILON => format!("{v:.0}"),
        Data::Float(v) => v.to_string(),
        Data::Int(v) => v.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v.to_string(),
        Data::DateTimeIso(v) | Data::DurationIso(v) => v.clone(),
        Data::Error(v) => format!("{v:?}"),
    }
}

fn grouped_rows(
    table: &Table,
    indexes: &[usize],
    remove_spaces: bool,
    case_sensitive: bool,
) -> BTreeMap<String, Vec<usize>> {
    let mut groups = BTreeMap::new();
    let mut blank = 0;
    for (i, row) in table.rows.iter().enumerate() {
        let mut key = row_key(row, indexes, remove_spaces, case_sensitive);
        if key.replace("|||", "").is_empty() {
            blank += 1;
            key = format!("__BLANK__{blank:012}");
        }
        groups.entry(key).or_insert_with(Vec::new).push(i);
    }
    groups
}
fn ordered_group_keys(
    table: &Table,
    indexes: &[usize],
    remove_spaces: bool,
    case_sensitive: bool,
) -> Vec<String> {
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    let mut blank = 0;
    for row in &table.rows {
        let mut key = row_key(row, indexes, remove_spaces, case_sensitive);
        if key.replace("|||", "").is_empty() {
            blank += 1;
            key = format!("__BLANK__{blank:012}");
        }
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    }
    keys
}
fn row_key(row: &[String], indexes: &[usize], remove_spaces: bool, case_sensitive: bool) -> String {
    indexes
        .iter()
        .map(|i| normalize_key(cell(row, *i), remove_spaces, case_sensitive))
        .collect::<Vec<_>>()
        .join("|||")
}
fn normalize_key(value: &str, remove_spaces: bool, case_sensitive: bool) -> String {
    let mut v = value.trim().replace('\u{3000}', " ");
    if let Some(date) = normalized_date_component(&v) {
        return date;
    }
    if remove_spaces {
        v.retain(|c| !c.is_whitespace());
    }
    if !case_sensitive {
        v = v.to_uppercase();
    }
    if let Some(stripped) = v.strip_suffix(".0").filter(|s| s.parse::<i128>().is_ok()) {
        v = stripped.into();
    }
    v
}

fn normalized_date_component(value: &str) -> Option<String> {
    if value.len() < 8 || (!value.contains('-') && !value.contains('/')) {
        return None;
    }
    let date = value
        .split_whitespace()
        .next()
        .unwrap_or(value)
        .replace('/', "-");
    let parts = date.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    let year = parts[0].parse::<u32>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let day = parts[2].parse::<u32>().ok()?;
    ((1900..=9999).contains(&year) && (1..=12).contains(&month) && (1..=31).contains(&day))
        .then(|| format!("{year:04}-{month:02}-{day:02}"))
}

fn canonical_display_key(value: &str) -> String {
    value
        .split(" | ")
        .map(|part| normalize_key(part, true, false))
        .collect::<Vec<_>>()
        .join("|||")
}
fn validate_keys(table: &Table, keys: &[String]) -> Result<(), AppError> {
    let missing = keys
        .iter()
        .filter(|k| !table.headers.contains(k))
        .cloned()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(error(
            "FA_MATCH_FAILED",
            format!("匹配列不存在：{}", missing.join("、")),
            None,
        ))
    }
}
fn key_indexes(table: &Table, keys: &[String]) -> Vec<usize> {
    keys.iter()
        .filter_map(|k| table.headers.iter().position(|h| h == k))
        .collect()
}

/// "2024固定资产卡片02.xlsx & Sheet1" — how the legacy exporter labelled which
/// workbook/sheet a column came from.  Reviewers use it to tell the two periods
/// apart at a glance, which a bare "期初"/"期末" suffix does not do.
fn side_label(params: &Value, side: u8) -> String {
    let (path_key, sheet_key) = if side == 1 {
        ("beginPath", "beginSheet")
    } else {
        ("endPath", "endSheet")
    };
    let file = params
        .get(path_key)
        .and_then(Value::as_str)
        .and_then(|p| Path::new(p).file_name())
        .and_then(|s| s.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if side == 1 {
                "文件1".into()
            } else {
                "文件2".into()
            }
        });
    match params.get(sheet_key).and_then(Value::as_str) {
        Some(sheet) if !sheet.trim().is_empty() => format!("{file} & {sheet}"),
        _ => file,
    }
}

/// Rewrites an internal "_期初"/"_期末" column key into the legacy display
/// header.  The internal keys stay as they are so the row JSON keeps working.
fn display_header(column: &str, params: &Value) -> String {
    if let Some(base) = column.strip_suffix("_期初") {
        format!("{base}_{}", side_label(params, 1))
    } else if let Some(base) = column.strip_suffix("_期末") {
        format!("{base}_{}", side_label(params, 2))
    } else {
        column.to_owned()
    }
}

/// Source column name for a mapped role, labelled with its workbook — the
/// header form the pivot and depreciation sheets use.
fn mapped_display_header(params: &Value, side: u8, role: &str, fallback: &str) -> String {
    match mapped_header(params, side, role) {
        Some(header) => format!("{header}_{}", side_label(params, side)),
        None => fallback.to_owned(),
    }
}

fn result_columns(r: &MergeResult, formatted: bool) -> Vec<String> {
    let left = if formatted { "期初" } else { "文件1" };
    let right = if formatted { "期末" } else { "文件2" };
    let mut columns = r
        .begin
        .headers
        .iter()
        .map(|h| format!("{h}_{left}"))
        .chain(r.end.headers.iter().map(|h| format!("{h}_{right}")))
        .collect::<Vec<_>>();
    columns.extend(["数据来源".into(), "匹配列".into()]);
    let extras = r
        .rows
        .iter()
        .flat_map(|row| row.extra.keys().cloned())
        .collect::<BTreeSet<_>>();
    columns.extend(extras.into_iter().map(|v| {
        if formatted {
            v.replace("_文件1", "_期初").replace("_文件2", "_期末")
        } else {
            v
        }
    }));
    columns
}
fn row_json(result: &MergeResult, row: &JoinedRow, formatted: bool) -> Value {
    let left = if formatted { "期初" } else { "文件1" };
    let right = if formatted { "期末" } else { "文件2" };
    let mut map = Map::new();
    for (i, h) in result.begin.headers.iter().enumerate() {
        map.insert(
            format!("{h}_{left}"),
            json!(row.begin.as_ref().map(|r| cell(r, i)).unwrap_or("")),
        );
    }
    for (i, h) in result.end.headers.iter().enumerate() {
        map.insert(
            format!("{h}_{right}"),
            json!(row.end.as_ref().map(|r| cell(r, i)).unwrap_or("")),
        );
    }
    map.insert("数据来源".into(), json!(row.source));
    map.insert("匹配列".into(), json!(row.match_value));
    for (k, v) in &row.extra {
        let key = if formatted {
            k.replace("_文件1", "_期初").replace("_文件2", "_期末")
        } else {
            k.clone()
        };
        map.insert(
            key,
            match v {
                Cell::Text(v) => json!(v),
                Cell::Number(v) => json!(v),
            },
        );
    }
    Value::Object(map)
}

fn write_csv(path: &Path, result: &MergeResult, selected: Vec<String>) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let all = result_columns(result, true);
    let columns = if selected.is_empty() {
        all
    } else {
        all.into_iter().filter(|v| selected.contains(v)).collect()
    };
    let mut file = fs::File::create(path).map_err(io_error)?;
    file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().from_writer(file);
    writer.write_record(&columns).map_err(csv_error)?;
    for row in &result.rows {
        let value = row_json(result, row, true);
        writer
            .write_record(columns.iter().map(|c| json_cell(value.get(c))))
            .map_err(csv_error)?;
    }
    writer.flush().map_err(io_error)
}

/// Parses a merged-data cell as a quantity, or returns None if it must stay
/// text.  Source cells all arrive as strings, so without this the whole 合并数据
/// sheet is text and no column can be summed in Excel.
///
/// Leading zeros mean the value is an identifier, not a number: asset code
/// "0002" and supplier id "0000103657" would become 2 and 103657.  The legacy
/// exporter did exactly that and lost the codes.
/// Identifier columns stay text even when they happen to hold only digits.
/// An asset code written as a number no longer matches the text code in the
/// other workpapers a VLOOKUP is pointed at, and long codes render in
/// scientific notation.
fn is_identifier_header(header: &str) -> bool {
    let lower = header.to_lowercase();
    ["编码", "编号", "代码", "卡片号", "code", "coding", "id"]
        .iter()
        .any(|term| lower.contains(term))
}

fn numeric_text(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unsigned = trimmed.strip_prefix(['-', '+']).unwrap_or(trimmed);
    if unsigned.len() > 1 && unsigned.starts_with('0') && !unsigned.starts_with("0.") {
        return None;
    }
    trimmed.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Header fill used by the legacy exporter.  Kept as a constant because the
/// guide sheet, the business sheets and the summary sheet must all match.
pub(crate) const LEGACY_HEADER_FILL: &str = "#E9EEF5";

/// Grey tint applied to every file2 (期末) column on 合并数据.
const LEGACY_FILE2_FILL: &str = "#E6E6E6";

/// Above this many rows the depreciation formula block is written as a short
/// template instead of for every row.
///
/// Legacy used 5000 because generating the formula strings in Python was itself
/// slow.  Rust writes the full block for ~12k rows in +10% wall time, so the
/// limit is raised well past normal FA List sizes.  It is not removed: the cost
/// that remains is Excel's, not ours — the two month-count columns are 700-900
/// character EDATE/DATEVALUE/MIN/MAX nests that Excel recalculates on every
/// open and every edit.  At 12k rows that is ~104k formulas and a 30 MB sheet;
/// at 500k rows it would be millions, and the workbook stops opening at all.
const DEPRECIATION_FORMULA_ROW_LIMIT: usize = 20_000;
const DEPRECIATION_FORMULA_SAMPLE_ROWS: usize = 10;

/// Money rendering for every amount the exporter writes: thousands separator,
/// no decimals.  Only the *display* is rounded — the cell keeps the full value
/// (formulas already round to fen where the business口径 requires it), so
/// downstream SUM/差异 arithmetic is unaffected.
const MONEY_NUMBER_FORMAT: &str = "#,##0";

/// Legacy column width: longest of the **first 10 data rows** plus 2, clamped.
/// The header is deliberately not considered — that is what the legacy
/// exporter did, and it keeps long headers like "本年应计提折旧月份" from
/// widening a column of three-digit numbers.  Detail-heavy sheets cap at 26 to
/// stay compact, the rest at 45.  `autofit()` used to scan every row and
/// produced 74-wide asset-name columns.
/// Displayed length of a cell for width purposes.  Legacy measured numbers as
/// they render (thousands-separated, no decimals) rather than as the raw
/// string, so a column of "1563427.22" sizes to "1,563,427".
fn legacy_display_len(value: &str, header: &str) -> usize {
    // Identifier and date columns are written as text, so they measure as text:
    // an asset code 1100000 must not be sized as "1,100,000".
    if is_identifier_header(header) || header.contains("日期") || header.contains("时间") {
        return value.chars().count();
    }
    let is_percent =
        header.contains("残值率") || header.contains("比例") || header.contains("百分比");
    match value.parse::<f64>() {
        Ok(v) if is_percent => format!("{:.2}%", v * 100.0).chars().count(),
        Ok(v) => {
            let digits = format!("{:.0}", v.abs());
            let separators = digits.len().saturating_sub(1) / 3;
            digits.len() + separators + usize::from(v < 0.0)
        }
        Err(_) => value.chars().count(),
    }
}

fn legacy_column_width(sheet: &str, longest: usize) -> f64 {
    let max_width = if matches!(
        sheet,
        "合并数据" | "数据透视表" | "折旧期间" | "折旧政策对比"
    ) {
        26.0
    } else {
        45.0
    };
    (longest as f64 + 2.0).clamp(8.0, max_width)
}

/// Whether a column reads as numeric, judged on its first rows.  Used to decide
/// how widely to measure it: money columns are measured over every row so a
/// large figure further down cannot render as ###, while text columns keep the
/// legacy 10-row sample so one long asset name does not widen the sheet.
fn column_reads_numeric<'a>(values: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = false;
    for value in values.take(10).filter(|v| !v.trim().is_empty()) {
        seen = true;
        if numeric_text(value).is_none() {
            return false;
        }
    }
    seen
}

fn write_xlsx(
    path: &Path,
    result: &MergeResult,
    params: &Value,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let partial = path.with_extension("xlsx.partial");
    let mut wb = Workbook::new();
    let columns = result_columns(result, true);
    let header = Format::new()
        .set_bold()
        .set_background_color(LEGACY_HEADER_FILL)
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    write_guide_sheets(&mut wb, params)?;
    for name in ["合并数据"] {
        let ws = wb.add_worksheet();
        ws.set_name(name).map_err(xlsx_error)?;
        // Legacy tinted every file2 column grey so the two periods are
        // distinguishable while scrolling a 46-column sheet.
        let file2_column = columns
            .iter()
            .map(|h| h.ends_with("_期末"))
            .collect::<Vec<_>>();
        let header_file2 = Format::new()
            .set_bold()
            .set_background_color(LEGACY_FILE2_FILL)
            .set_border(FormatBorder::Thin)
            .set_align(FormatAlign::Left);
        let money = Format::new().set_num_format(MONEY_NUMBER_FORMAT);
        let file2_text = Format::new().set_background_color(LEGACY_FILE2_FILL);
        let file2_number = Format::new()
            .set_background_color(LEGACY_FILE2_FILL)
            .set_num_format(MONEY_NUMBER_FORMAT);
        let note_format = Format::new()
            .set_background_color("#F6F6F6")
            .set_border(FormatBorder::Thin)
            .set_text_wrap();
        for (c, h) in columns.iter().enumerate() {
            let fmt = if file2_column[c] {
                &header_file2
            } else {
                &header
            };
            ws.write_string_with_format(0, c as u16, display_header(h, params), fmt)
                .map_err(xlsx_error)?;
            ws.write_string(1, c as u16, merged_field_source(h))
                .map_err(xlsx_error)?;
        }
        let detail_rows = result
            .rows
            .iter()
            .filter(|row| row_summary_noise_marker(row).is_none())
            .collect::<Vec<_>>();
        let date_column = columns
            .iter()
            .map(|h| h.contains("日期") || h.contains("时间"))
            .collect::<Vec<_>>();
        let identifier_column = columns
            .iter()
            .map(|h| is_identifier_header(h))
            .collect::<Vec<_>>();
        // Decide numeric columns from a sample of the head rather than holding
        // the whole sheet in memory (these files run to a million rows).  Each
        // cell is still validated when written, so a stray non-numeric value
        // further down falls back to text instead of being mangled.
        let mut numeric_column = columns
            .iter()
            .enumerate()
            .map(|(c, _)| !date_column[c] && !identifier_column[c])
            .collect::<Vec<_>>();
        for row in detail_rows.iter().take(1000) {
            let value = row_json(result, row, true);
            for (c, h) in columns.iter().enumerate() {
                if numeric_column[c] {
                    if let Some(Value::String(text)) = value.get(h) {
                        if !text.trim().is_empty() && numeric_text(text).is_none() {
                            numeric_column[c] = false;
                        }
                    }
                }
            }
        }
        let mut widest = vec![0usize; columns.len()];
        for (r, row) in detail_rows.iter().enumerate() {
            check_cancel(cancel)?;
            let value = row_json(result, row, true);
            for (c, h) in columns.iter().enumerate() {
                let cell = value.get(h);
                let excel_row = (r + 2) as u32;
                // Measure what actually lands in the cell: a date column holds
                // "2023-06-27" even though the source value is the serial 45104.
                if r < 10 || numeric_column[c] {
                    let rendered = match cell {
                        Some(Value::String(text)) if date_column[c] => display_date(text),
                        other => json_cell(other),
                    };
                    widest[c] = widest[c].max(legacy_display_len(&rendered, h));
                }
                let tint = if file2_column[c] {
                    Some(if numeric_column[c] {
                        &file2_number
                    } else {
                        &file2_text
                    })
                } else {
                    None
                };
                match cell {
                    Some(Value::String(text)) if date_column[c] => {
                        let rendered = display_date(text);
                        match tint {
                            Some(fmt) => {
                                ws.write_string_with_format(excel_row, c as u16, rendered, fmt)
                            }
                            None => ws.write_string(excel_row, c as u16, rendered),
                        }
                        .map_err(xlsx_error)?;
                    }
                    Some(Value::String(text)) if numeric_column[c] => {
                        match (numeric_text(text), tint) {
                            (Some(number), Some(fmt)) => {
                                ws.write_number_with_format(excel_row, c as u16, number, fmt)
                            }
                            (Some(number), None) => {
                                ws.write_number_with_format(excel_row, c as u16, number, &money)
                            }
                            (None, Some(fmt)) => {
                                ws.write_string_with_format(excel_row, c as u16, text, fmt)
                            }
                            (None, None) => ws.write_string(excel_row, c as u16, text),
                        }
                        .map_err(xlsx_error)?;
                    }
                    _ => match tint {
                        Some(fmt) => ws
                            .write_string_with_format(excel_row, c as u16, json_cell(cell), fmt)
                            .map(|_| ())
                            .map_err(xlsx_error)?,
                        None => write_json_cell(ws, excel_row, c as u16, cell)?,
                    },
                }
            }
        }
        ws.set_freeze_panes(2, 0).map_err(xlsx_error)?;
        if !columns.is_empty() {
            ws.autofilter(
                0,
                0,
                detail_rows.len() as u32 + 1,
                columns.len().saturating_sub(1) as u16,
            )
            .map_err(xlsx_error)?;
        }
        let note_row = detail_rows.len() as u32 + 3;
        let info = sheet_explanation(name);
        let note = format!("{} 信息来源：{} 重点关注：{}", info.0, info.1, info.2);
        ws.write_string_with_format(note_row, 0, "本表说明", &header)
            .map_err(xlsx_error)?;
        ws.merge_range(note_row, 1, note_row, 3, &note, &note_format)
            .map_err(xlsx_error)?;
        // Widths from a sample of the data: autofit walked all 15k rows and
        // produced 50+ wide columns for asset names.
        for c in 0..columns.len() {
            ws.set_column_width(c as u16, legacy_column_width(name, widest[c]))
                .map_err(xlsx_error)?;
        }
        ws.set_row_height(1, 22).map_err(xlsx_error)?;
        ws.set_row_height(note_row - 1, 8).map_err(xlsx_error)?;
        ws.set_row_height(note_row, 72).map_err(xlsx_error)?;
    }
    // Sheet creation order *is* the tab order in the workbook; see SHEET_ORDER.
    write_pivot_sheet(&mut wb, result, params, &header, cancel)?;
    check_cancel(cancel)?;
    write_summary_sheet(&mut wb, result, params, &header)?;
    check_cancel(cancel)?;
    write_business_sheets(&mut wb, result, params, &header, cancel)?;
    check_cancel(cancel)?;
    write_depreciation_period_sheet(&mut wb, result, params, &header, cancel, "折旧期间")?;
    check_cancel(cancel)?;
    if fa_llm_enabled(params) {
        write_llm_analysis(&mut wb, result, params)?;
    }
    write_anomaly_sheet(&mut wb, result, params, &header, cancel)?;
    wb.save(&partial).map_err(xlsx_error)?;
    if let Err(cancelled) = check_cancel(cancel) {
        let _ = fs::remove_file(&partial);
        return Err(cancelled);
    }
    replace_output(&partial, path)
}

/// Returns the summary-noise rows for `write_noise_backup_sheet` to emit later.
fn write_summary_sheet(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
    header: &Format,
) -> Result<Vec<Vec<String>>, AppError> {
    let (headers, rows, noise) = build_extended_summary(result, params);
    let mut begin_categories = BTreeSet::new();
    let mut end_categories = BTreeSet::new();
    for row in result
        .rows
        .iter()
        .filter(|row| row_summary_noise_marker(row).is_none())
    {
        let begin = mapped_text(result, row, params, 1, "category");
        let end = mapped_text(result, row, params, 2, "category");
        if !begin.trim().is_empty()
            && mapped_number(result, row, params, 1, "originalValue").abs() > 0.005
        {
            begin_categories.insert(begin);
        }
        if !end.trim().is_empty()
            && mapped_number(result, row, params, 2, "originalValue").abs() > 0.005
        {
            end_categories.insert(end);
        }
    }
    let ws = wb.add_worksheet();
    ws.set_name("固定资产变动汇总表").map_err(xlsx_error)?;
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, h, header)
            .map_err(xlsx_error)?;
        let source = match c {
            0 | 1 => "变动项目",
            2 => "计算",
            _ if begin_categories.contains(h) && end_categories.contains(h) => "期初&期末分类",
            _ if begin_categories.contains(h) => "期初分类",
            _ if end_categories.contains(h) => "期末分类",
            _ => "类别来源待确认",
        };
        ws.write_string(1, c as u16, source).map_err(xlsx_error)?;
    }
    // The 合计 column is a live =SUM() across the category columns, as in the
    // legacy sheet: a hard-coded total silently goes stale the moment anyone
    // edits a category cell while tying the schedule out.
    let money_format = Format::new().set_num_format(MONEY_NUMBER_FORMAT);
    // A 列是分组合并后的项目名称：横向靠左方便扫读，纵向居中避免
    // 多行合并区域的标题沉在底部。
    let section_format = header
        .clone()
        .set_align(FormatAlign::Left)
        .set_align(FormatAlign::VerticalCenter);
    let last_category_col = xlsx_col(headers.len().saturating_sub(1));
    for (r, row) in rows.iter().enumerate() {
        let excel_row = r + 3;
        for (c, value) in row.iter().enumerate() {
            if c == 2 && headers.len() > 3 {
                ws.write_formula_with_format(
                    (r + 2) as u32,
                    2,
                    format!("=SUM(D{excel_row}:{last_category_col}{excel_row})").as_str(),
                    &money_format,
                )
                .map_err(xlsx_error)?;
            } else if c >= 2 {
                ws.write_number_with_format((r + 2) as u32, c as u16, number(value), &money_format)
                    .map_err(xlsx_error)?;
            } else {
                ws.write_string((r + 2) as u32, c as u16, value)
                    .map_err(xlsx_error)?;
            }
        }
    }
    let mut section_start = 0usize;
    while section_start < rows.len() {
        let section = rows[section_start].first().cloned().unwrap_or_default();
        let mut section_end = section_start;
        while section_end + 1 < rows.len()
            && rows[section_end + 1]
                .first()
                .is_some_and(|value| value == &section)
        {
            section_end += 1;
        }
        if section_end > section_start {
            ws.merge_range(
                section_start as u32 + 2,
                0,
                section_end as u32 + 2,
                0,
                &section,
                &section_format,
            )
            .map_err(xlsx_error)?;
        }
        section_start = section_end + 1;
    }
    ws.set_freeze_panes(2, 2).map_err(xlsx_error)?;
    let note_row = rows.len() as u32 + 3;
    let note_format = Format::new()
        .set_background_color("#F6F6F6")
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    ws.write_string_with_format(note_row, 0, "本表说明", header)
        .map_err(xlsx_error)?;
    let info = sheet_explanation("固定资产变动汇总表");
    let note = format!("{} 信息来源：{} 重点关注：{}", info.0, info.1, info.2);
    if headers.len() >= 4 {
        ws.merge_range(note_row, 1, note_row, 3, &note, &note_format)
            .map_err(xlsx_error)?;
    }
    ws.set_row_height(note_row - 1, 8).map_err(xlsx_error)?;
    ws.set_row_height(note_row, 72).map_err(xlsx_error)?;
    // Legacy geometry for this sheet: the 科目/项目 labels need room, the rest
    // follow their content.
    for c in 0..headers.len() {
        let width = match c {
            0 => 14.0,
            1 => 30.0,
            2 => 16.0,
            _ => legacy_column_width(
                "固定资产变动汇总表",
                rows.iter()
                    .filter_map(|r| r.get(c))
                    .map(|v| legacy_display_len(v, headers[c].as_str()))
                    .max()
                    .unwrap_or(0),
            ),
        };
        ws.set_column_width(c as u16, width).map_err(xlsx_error)?;
    }
    Ok(noise)
}

/// Written last so the legacy sheet order is preserved; the rows come from
/// `write_summary_sheet`, which is what identifies the noise in the first place.
fn write_noise_backup_sheet(
    wb: &mut Workbook,
    noise: Vec<Vec<String>>,
    header: &Format,
) -> Result<(), AppError> {
    let backup = if noise.is_empty() {
        vec![vec![
            "未发现汇总干扰行".into(),
            String::new(),
            String::new(),
            "未发现需要从明细口径剔除的合计/小计/total 行。".into(),
        ]]
    } else {
        noise
    };
    write_string_sheet(
        wb,
        "汇总备查",
        &["来源页签", "资产类别", "原始行号", "行内容"],
        &backup,
        header,
        None,
        None,
    )
}

#[derive(Default, Clone)]
struct CategoryMovement {
    begin_original: f64,
    additions: BTreeMap<String, f64>,
    disposals: BTreeMap<String, f64>,
    /// Net original value moved in (+) or out (-) by cards whose category
    /// changed between the two periods.
    reclass_original: f64,
    end_original: f64,
    begin_dep: f64,
    /// Closing accumulated depreciation less opening accumulated depreciation,
    /// before the separately presented reclassification line.
    dep_change_total: f64,
    /// Accumulated depreciation carried out with structurally identified
    /// disposals, split by disposal method.  Legacy presents these as positive
    /// secondary detail below the net movement row.
    disposal_dep: BTreeMap<String, f64>,
    reclass_dep: f64,
    end_dep: f64,
}

fn is_summary_noise(value: &str) -> bool {
    let normalized = value.trim().to_lowercase().replace(' ', "");
    normalized.is_empty()
        || ["合计", "小计", "总计", "subtotal", "total"]
            .iter()
            .any(|word| normalized == *word || normalized.ends_with(word))
}

/// Client workbooks routinely carry a per-category subtotal row and a grand
/// total row.  The legacy exporter dropped them from every detail sheet (they
/// were kept only in the 汇总备查 backup); leaving them in makes FA List longer
/// than the card count and roughly doubles any column total.
fn values_are_summary_noise(values: &[String]) -> bool {
    values
        .iter()
        .any(|value| !value.trim().is_empty() && is_summary_noise(value))
}

fn row_summary_noise_marker(row: &JoinedRow) -> Option<String> {
    row.begin
        .iter()
        .chain(row.end.iter())
        .flat_map(|values| values.iter())
        .find(|value| is_summary_noise(value) && !value.trim().is_empty())
        .cloned()
}

/// The match key may be built from several columns; the exporter joins them
/// with " | " for the 匹配列 column.  固定资产编号 is the sheet's primary key,
/// so it must carry only the first segment — leaking the whole composite key
/// makes the column useless for lookups against the original cards.
fn primary_key_segment(match_value: &str) -> String {
    match_value
        .split(" | ")
        .next()
        .unwrap_or(match_value)
        .trim()
        .to_owned()
}

fn method_parts(value: Option<String>, fallback: &str) -> Vec<String> {
    let value = value.unwrap_or_else(|| fallback.to_owned());
    let mut parts = value
        .split(['；', ';', '、', ','])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        parts.push(fallback.to_owned());
    }
    parts
}

/// 汇总行的数值态：section（原值／累计折旧／净值）＋项目＋按类别顺序的金额。
/// 导出 Excel 的固定资产变动汇总表与合并预览共用同一份行定义和零行过滤，
/// 两边看到的合计永远一致。
struct SummaryLine {
    section: String,
    item: String,
    values: Vec<f64>,
}

/// `short_labels` 为真时，期初期末行直接叫「期初原值／期末原值」；导出底稿
/// 沿用旧版写法，把来源工作簿名拼进项目名（`side_label`）。
fn build_summary_lines(
    result: &MergeResult,
    params: &Value,
    short_labels: bool,
) -> (Vec<String>, Vec<SummaryLine>, Vec<Vec<String>>) {
    let mut movements: BTreeMap<String, CategoryMovement> = BTreeMap::new();
    // Legacy preserves the category order in the merged schedule instead of
    // alphabetically sorting Chinese labels.
    let mut categories = Vec::<String>::new();
    let mut add_method_order = Vec::<String>::new();
    let mut disposal_method_order = Vec::<String>::new();
    let mut noise = Vec::new();
    for row in &result.rows {
        let begin_category = mapped_text(result, row, params, 1, "category");
        let end_category = mapped_text(result, row, params, 2, "category");
        let category = nonempty(end_category.clone())
            .or_else(|| nonempty(begin_category.clone()))
            .unwrap_or_else(|| "未分类".into());
        if is_summary_noise(&category) || row_summary_noise_marker(row).is_some() {
            noise.push(vec![
                row.source.into(),
                category,
                row.match_value.clone(),
                format!(
                    "合计/小计/空分类行未纳入变动汇总{}",
                    row_summary_noise_marker(row)
                        .map(|value| format!("（识别标识：{value}）"))
                        .unwrap_or_default()
                ),
            ]);
            continue;
        }
        // The opening balance has to stay on the opening category, otherwise a
        // card reclassified during the year silently moves its opening amount
        // too and the 期初余额 row no longer ties to last year's signed report.
        // Cards that did move are reconciled by an explicit 重分类 row below.
        let begin_key = nonempty(begin_category.clone())
            .or_else(|| nonempty(end_category.clone()))
            .unwrap_or_else(|| "未分类".into());
        let end_key = nonempty(end_category.clone())
            .or_else(|| nonempty(begin_category.clone()))
            .unwrap_or_else(|| "未分类".into());
        for key in [&begin_key, &end_key] {
            if !categories.contains(key) {
                categories.push(key.clone());
            }
        }
        let reclassified = nonempty(begin_category.clone()).is_some()
            && nonempty(end_category.clone()).is_some()
            && begin_category != end_category;
        let begin_original = mapped_number(result, row, params, 1, "originalValue");
        let end_original = mapped_number(result, row, params, 2, "originalValue");
        let begin_dep = mapped_number(result, row, params, 1, "depreciation");
        let end_dep = mapped_number(result, row, params, 2, "depreciation");
        {
            let opening = movements.entry(begin_key.clone()).or_default();
            opening.begin_original += begin_original;
            opening.begin_dep += begin_dep;
            if reclassified {
                opening.reclass_original -= begin_original;
                opening.reclass_dep -= begin_dep;
            }
        }
        {
            let closing = movements.entry(end_key.clone()).or_default();
            closing.end_original += end_original;
            closing.end_dep += end_dep;
            if reclassified {
                closing.reclass_original += begin_original;
                closing.reclass_dep += begin_dep;
            }
        }
        // Movements belong to the category the card ends the year in; for a
        // disposal 期末类别 is blank and end_key falls back to 期初类别.
        let movement = movements.entry(end_key).or_default();
        let original_change = end_original - begin_original;
        if original_change > 0.005 {
            let methods = method_parts(
                extra_text(row, "新增方式_辅助_文件2")
                    .or_else(|| nonempty(mapped_text(result, row, params, 2, "additionMethod"))),
                "未标注新增方式",
            );
            let share = original_change / methods.len() as f64;
            for method in methods {
                if !add_method_order.contains(&method) {
                    add_method_order.push(method.clone());
                }
                *movement.additions.entry(method).or_default() += share;
            }
        } else if original_change < -0.005 {
            let methods = method_parts(
                extra_text(row, "处置方式_辅助_文件1")
                    .or_else(|| nonempty(mapped_text(result, row, params, 1, "disposalMethod"))),
                "未标注处置方式",
            );
            let share = -original_change / methods.len() as f64;
            let allocated_dep = if begin_original.abs() > f64::EPSILON {
                begin_dep.abs() * ((-original_change) / begin_original.abs()).min(1.0)
            } else {
                begin_dep.abs()
            };
            let dep_share = allocated_dep / methods.len() as f64;
            for method in methods {
                if !disposal_method_order.contains(&method) {
                    disposal_method_order.push(method.clone());
                }
                *movement.disposals.entry(method.clone()).or_default() += share;
                *movement.disposal_dep.entry(method).or_default() += dep_share;
            }
        }
        let dep_delta = end_dep - begin_dep;
        if dep_delta.abs() > 0.005 {
            movement.dep_change_total += dep_delta;
        }
    }
    if let Some(index) = categories.iter().position(|category| category == "未分类") {
        let unclassified = categories.remove(index);
        categories.push(unclassified);
    }
    let add_methods = add_method_order;
    let disposal_methods = disposal_method_order;
    // Legacy only splits depreciation disposal rows that carry an explicit
    // method.  An unlabelled disposal remains in the catch-all non-disposal
    // line, even though its original-value reduction is still shown separately.
    let dep_methods = disposal_methods
        .iter()
        .filter(|method| method.as_str() != "未标注处置方式")
        .cloned()
        .collect::<Vec<_>>();
    let has_non_disposal_dep = categories.iter().any(|c| {
        let m = &movements[c];
        let disposed = dep_methods
            .iter()
            .map(|method| *m.disposal_dep.get(method).unwrap_or(&0.0))
            .sum::<f64>();
        (-m.dep_change_total - disposed).abs() > 0.005
    });
    let mut rows = Vec::new();
    let mut add_row = |section: &str, item: String, values: Vec<f64>| {
        if values.iter().all(|v| v.abs() <= 0.005)
            && !["期初余额", "期末余额", "年初余额", "年末余额"].contains(&item.as_str())
        {
            return;
        }
        rows.push(SummaryLine {
            section: section.to_owned(),
            item,
            values,
        });
    };
    let begin_label = if short_labels {
        "期初".to_owned()
    } else {
        side_label(params, 1)
    };
    let end_label = if short_labels {
        "期末".to_owned()
    } else {
        side_label(params, 2)
    };
    let begin_dep_item = format!(
        "{begin_label}{}",
        mapped_header(params, 1, "depreciation").unwrap_or_else(|| "累计折旧".into())
    );
    let end_dep_item = format!(
        "{end_label}{}",
        mapped_header(params, 2, "depreciation").unwrap_or_else(|| "累计折旧".into())
    );
    add_row(
        "原值",
        format!("{begin_label}原值"),
        categories
            .iter()
            .map(|c| movements[c].begin_original)
            .collect(),
    );
    add_row(
        "原值",
        "原值增加".into(),
        categories
            .iter()
            .map(|c| movements[c].additions.values().sum())
            .collect(),
    );
    for method in &add_methods {
        add_row(
            "原值",
            format!("——其中-{method}"),
            categories
                .iter()
                .map(|c| *movements[c].additions.get(method).unwrap_or(&0.0))
                .collect(),
        );
    }
    add_row(
        "原值",
        "原值减少".into(),
        categories
            .iter()
            .map(|c| movements[c].disposals.values().sum())
            .collect(),
    );
    for method in &disposal_methods {
        add_row(
            "原值",
            format!("——其中-{method}"),
            categories
                .iter()
                .map(|c| *movements[c].disposals.get(method).unwrap_or(&0.0))
                .collect(),
        );
    }
    add_row(
        "原值",
        "原值重分类".into(),
        categories
            .iter()
            .map(|c| movements[c].reclass_original)
            .collect(),
    );
    add_row(
        "原值",
        format!("{end_label}原值"),
        categories
            .iter()
            .map(|c| movements[c].end_original)
            .collect(),
    );
    add_row(
        "累计折旧",
        begin_dep_item,
        categories.iter().map(|c| movements[c].begin_dep).collect(),
    );
    add_row(
        "累计折旧",
        "累计折旧变动净额".into(),
        categories
            .iter()
            .map(|c| movements[c].dep_change_total)
            .collect(),
    );
    for method in &dep_methods {
        add_row(
            "累计折旧",
            format!("——其中-{method}"),
            categories
                .iter()
                .map(|c| *movements[c].disposal_dep.get(method).unwrap_or(&0.0))
                .collect(),
        );
    }
    if has_non_disposal_dep {
        add_row(
            "累计折旧",
            "——其中-非处置变动（含计提折旧）".into(),
            categories
                .iter()
                .map(|c| {
                    let m = &movements[c];
                    let labelled_disposals = dep_methods
                        .iter()
                        .map(|method| *m.disposal_dep.get(method).unwrap_or(&0.0))
                        .sum::<f64>();
                    -m.dep_change_total - labelled_disposals
                })
                .collect(),
        );
    }
    add_row(
        "累计折旧",
        "累计折旧重分类".into(),
        categories
            .iter()
            .map(|c| movements[c].reclass_dep)
            .collect(),
    );
    add_row(
        "累计折旧",
        end_dep_item,
        categories.iter().map(|c| movements[c].end_dep).collect(),
    );
    // Same absolute-value rule as the FA List sheet: a ledger that books
    // accumulated depreciation as a negative number must not inflate net value.
    add_row(
        "净值(NBV)",
        "年初余额".into(),
        categories
            .iter()
            .map(|c| movements[c].begin_original - movements[c].begin_dep.abs())
            .collect(),
    );
    add_row(
        "净值(NBV)",
        "年末余额".into(),
        categories
            .iter()
            .map(|c| movements[c].end_original - movements[c].end_dep.abs())
            .collect(),
    );
    (categories, rows, noise)
}

fn build_extended_summary(
    result: &MergeResult,
    params: &Value,
) -> (Vec<String>, Vec<Vec<String>>, Vec<Vec<String>>) {
    let (categories, lines, noise) = build_summary_lines(result, params, false);
    let mut headers = vec![String::new(), String::new(), "合计".into()];
    headers.extend(categories.iter().cloned());
    let rows = lines
        .into_iter()
        .map(|line| {
            let mut row = vec![
                line.section,
                line.item,
                display_number(round_money(line.values.iter().sum())),
            ];
            row.extend(
                line.values
                    .into_iter()
                    .map(|value| display_number(round_money(value))),
            );
            row
        })
        .collect();
    (headers, rows, noise)
}

fn write_business_sheets(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
    header: &Format,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    // Column order and names follow the legacy sheet: 本年折旧 sits before 净值,
    // and the flag column is 已提足折旧 (not 是否已提足折旧).
    let fa_headers = [
        "资产类别",
        "固定资产编号",
        "固定资产名称",
        "入账开始日期",
        "使用寿命(月)",
        "残值率",
        "原值",
        "累计折旧",
        "本年折旧",
        "净值",
        "已提足折旧",
        "提足折旧时间",
    ];
    let mut fa_rows = Vec::new();
    // Legacy builds FA List from the already merged schedule.  This preserves
    // its grouped/key order while excluding cards that exist only at opening.
    let display_rows = result
        .rows
        .iter()
        .filter(|row| row.end.is_some() && row_summary_noise_marker(row).is_none())
        .filter(|row| !primary_key_segment(&row.match_value).trim().is_empty())
        .cloned()
        .collect::<Vec<_>>();
    let end_life_scale = life_scale(result, params, 2);
    for row in &display_rows {
        check_cancel(cancel)?;
        let original = mapped_number(result, row, params, 2, "originalValue");
        // Many ERP exports carry accumulated depreciation as a negative number.
        // Legacy took the absolute value before computing net book value;
        // subtracting the raw figure turns 100 - (-30) into 130.
        let depreciation = mapped_number(result, row, params, 2, "depreciation").abs();
        let life = mapped_life(result, row, params, 2, end_life_scale);
        let residual = mapped_residual_rate(result, row, params, 2, original);
        let fully = if original.abs() > f64::EPSILON
            && original - depreciation <= original * residual + 0.1
        {
            "是"
        } else {
            "否"
        };
        fa_rows.push(vec![
            mapped_text(result, row, params, 2, "category"),
            primary_key_segment(&row.match_value),
            mapped_text(result, row, params, 2, "name"),
            display_date(&mapped_text(result, row, params, 2, "startDate")),
            display_number(life),
            display_number(residual),
            display_number(original),
            display_number(depreciation),
            display_number(mapped_number(result, row, params, 2, "currentYearDep")),
            display_number(original - depreciation),
            fully.into(),
            depreciation_end_date(&mapped_text(result, row, params, 2, "startDate"), life),
        ]);
    }
    write_string_sheet(
        wb,
        "FA List",
        &fa_headers,
        &fa_rows,
        header,
        params.get("balanceSheetDate").and_then(Value::as_str),
        Some(cancel),
    )?;
    // A blank life is "unknown", not "short": legacy required a parsed value
    // before comparing, so cards with no life stayed out of this sheet instead
    // of dragging the whole ledger into it.
    let short_rows = fa_rows
        .iter()
        .filter(|row| {
            parse_life_cell(row.get(4).map(String::as_str).unwrap_or(""))
                .is_some_and(|life| life > 0.0 && life <= 12.0)
        })
        .cloned()
        .collect::<Vec<_>>();
    if short_rows.is_empty() {
        // An empty grid reads as "not computed"; the legacy sheet said so
        // explicitly in a single 提示 column.
        write_string_sheet(
            wb,
            "≤12月卡片明细",
            &["提示"],
            &[vec![
                "经检查，期末FA LIST中未发现任何≤12月的资产卡片".to_owned(),
            ]],
            header,
            None,
            Some(cancel),
        )?;
    } else {
        write_string_sheet(
            wb,
            "≤12月卡片明细",
            &fa_headers,
            &short_rows,
            header,
            None,
            Some(cancel),
        )?;
    }

    // Legacy order: the computed columns come first, the two manual-entry
    // placeholders last (their headers carry the "?" to mark them as such).
    let supplement_maps = |target: &str, field: &str| {
        params
            .get(target)
            .and_then(|config| config.get(field))
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let addition_method_mapped = supplement_maps("additionSupplement", "method")
        || mapped_header(params, 2, "additionMethod").is_some();
    let addition_date_mapped = supplement_maps("additionSupplement", "date")
        || mapped_header(params, 2, "additionDate").is_some();
    let addition_headers = [
        "资产类别",
        "固定资产编号",
        "固定资产名称",
        "入账开始日期",
        "使用寿命(月)",
        "残值率",
        "增加类型",
        "原值增加",
        if addition_method_mapped {
            "新增方式"
        } else {
            "[新增方式?]"
        },
        if addition_date_mapped {
            "新增时间"
        } else {
            "[新增时间?]"
        },
    ];
    // file2 cards carry 计划使用年 far more often than a month count, so the
    // addition sheet has to run the same year->month conversion FA List does;
    // without it the depreciation formulas divide by 5 instead of 60.
    let addition_rows = result
        .rows
        .iter()
        .filter(|row| row_summary_noise_marker(row).is_none())
        .filter(|row| !primary_key_segment(&row.match_value).trim().is_empty())
        // 变动汇总表 books an addition whenever 期末原值 > 期初原值, so the
        // detail sheet has to use the same net-increase test.  Restricting it
        // to 仅文件2 dropped cards that matched an opening card carrying a zero
        // original value, leaving the detail short of the summary.
        //
        // Presence in the 补充清单 is deliberately NOT a membership test.  It
        // is only a source for the 新增方式/新增时间 columns.  When the
        // supplement is file2 itself — which the UI prefills whenever file2
        // already carries 新增方式 — every card in the ledger carries the
        // auxiliary column, and using it here turned the sheet into a copy of
        // the full FA List instead of the period's additions.
        .filter(|row| {
            mapped_number(result, row, params, 2, "originalValue")
                - mapped_number(result, row, params, 1, "originalValue")
                > 0.005
        })
        .map(|row| {
            vec![
                mapped_text(result, row, params, 2, "category"),
                primary_key_segment(&row.match_value),
                mapped_text(result, row, params, 2, "name"),
                display_date(&mapped_text(result, row, params, 2, "startDate")),
                display_number(mapped_life(result, row, params, 2, end_life_scale)),
                display_number(mapped_residual_rate(
                    result,
                    row,
                    params,
                    2,
                    mapped_number(result, row, params, 2, "originalValue"),
                )),
                // Mirrors 减少类型 on the disposal sheet: the question is whether
                // the increase is a brand-new card or an uplift on an existing
                // one, not whether the date falls inside the period.  Dating the
                // label off 新增时间 (usually blank) stamped every row 本期新增.
                if mapped_number(result, row, params, 1, "originalValue").abs() > 0.005 {
                    "原值修改".into()
                } else {
                    "非原值修改".into()
                },
                // Net increase, not the full ending original value: an uplift on
                // an existing card only adds the delta.  For 仅文件2 rows 期初 is
                // zero, so this stays the full amount.
                display_number(
                    (mapped_number(result, row, params, 2, "originalValue")
                        - mapped_number(result, row, params, 1, "originalValue"))
                    .max(0.0),
                ),
                extra_text(row, "新增方式_辅助_文件2")
                    .or_else(|| nonempty(mapped_text(result, row, params, 2, "additionMethod")))
                    .unwrap_or_else(|| {
                        if addition_method_mapped {
                            String::new()
                        } else {
                            "[新增方式?]".into()
                        }
                    }),
                extra_text(row, "新增时间_辅助_文件2")
                    .or_else(|| nonempty(mapped_text(result, row, params, 2, "additionDate")))
                    .map(|value| display_date(&value))
                    .unwrap_or_else(|| {
                        if addition_date_mapped {
                            String::new()
                        } else {
                            "[新增时间?]".into()
                        }
                    }),
            ]
        })
        .collect::<Vec<_>>();
    write_string_sheet(
        wb,
        "新增清单_BKD",
        &addition_headers,
        &addition_rows,
        header,
        None,
        Some(cancel),
    )?;
    check_cancel(cancel)?;

    let disposal_method_mapped = supplement_maps("disposalSupplement", "method")
        || mapped_header(params, 1, "disposalMethod").is_some();
    let disposal_date_mapped = supplement_maps("disposalSupplement", "date")
        || mapped_header(params, 1, "disposalDate").is_some();
    let disposal_original_mapped = supplement_maps("disposalSupplement", "originalValue");
    let disposal_headers = [
        "资产类别",
        "固定资产编号",
        "固定资产名称",
        "入账开始日期",
        "使用寿命(月)",
        "残值率",
        "原值减少",
        "年初累计折旧",
        "本年折旧",
        "净值",
        "减少类型",
        if disposal_method_mapped {
            "处置方式"
        } else {
            "[处置方式?]"
        },
        if disposal_date_mapped {
            "处置时间"
        } else {
            "[处置时间?]"
        },
        if disposal_original_mapped {
            "处置原值"
        } else {
            "[处置原值?]"
        },
        "处置折旧",
    ];
    let begin_life_scale = life_scale(result, params, 1);
    let disposal_rows = result
        .rows
        .iter()
        .filter(|row| row_summary_noise_marker(row).is_none())
        .filter(|row| !primary_key_segment(&row.match_value).trim().is_empty())
        .filter(|row| {
            mapped_number(result, row, params, 1, "originalValue")
                - mapped_number(result, row, params, 2, "originalValue")
                > 0.005
        })
        .enumerate()
        .map(|(row_index, row)| {
            let opening_original = mapped_number(result, row, params, 1, "originalValue");
            let ending_original = mapped_number(result, row, params, 2, "originalValue");
            let decrease = (opening_original - ending_original).abs();
            let opening_dep = mapped_number(result, row, params, 1, "depreciation");
            let allocated_dep =
                if opening_original.abs() > f64::EPSILON && ending_original.abs() > f64::EPSILON {
                    opening_dep.abs() * (decrease / opening_original.abs()).min(1.0)
                } else {
                    opening_dep.abs()
                };
            let disposal_dep = extra_number(row, "处置折旧_辅助_文件1");
            vec![
                mapped_text(result, row, params, 1, "category"),
                primary_key_segment(&row.match_value),
                mapped_text(result, row, params, 1, "name"),
                display_date(&mapped_text(result, row, params, 1, "startDate")),
                display_number(mapped_life(result, row, params, 1, begin_life_scale)),
                display_number(mapped_residual_rate(
                    result,
                    row,
                    params,
                    1,
                    opening_original,
                )),
                display_number(decrease),
                display_number(allocated_dep),
                format!("=O{}-H{}", row_index + 3, row_index + 3),
                display_number(decrease - allocated_dep),
                if ending_original.abs() > 0.005 {
                    "原值修改".into()
                } else {
                    "非原值修改".into()
                },
                extra_text(row, "处置方式_辅助_文件1")
                    .or_else(|| nonempty(mapped_text(result, row, params, 1, "disposalMethod")))
                    .unwrap_or_else(|| {
                        if disposal_method_mapped {
                            String::new()
                        } else {
                            "[处置方式?]".into()
                        }
                    }),
                extra_text(row, "处置时间_辅助_文件1")
                    .or_else(|| nonempty(mapped_text(result, row, params, 1, "disposalDate")))
                    .map(|value| display_date(&value))
                    .unwrap_or_else(|| {
                        if disposal_date_mapped {
                            String::new()
                        } else {
                            "[处置时间?]".into()
                        }
                    }),
                extra_number(row, "处置原值_辅助_文件1")
                    .map(display_number)
                    .unwrap_or_else(|| {
                        if disposal_original_mapped {
                            String::new()
                        } else {
                            "[处置原值?]".into()
                        }
                    }),
                // 处置折旧优先保留补充清单的账面数；匹配不到时用公式
                // 引用本行年初累计折旧。这样默认本年折旧为 0，同时保留
                // Excel 可追溯关系。Some(0) 是有效账面值，不能当作缺失覆盖。
                disposal_dep
                    .map(display_number)
                    .unwrap_or_else(|| format!("=H{}", row_index + 3)),
            ]
        })
        .collect::<Vec<_>>();
    write_string_sheet(
        wb,
        "处置清单_BKD",
        &disposal_headers,
        &disposal_rows,
        header,
        params.get("balanceSheetDate").and_then(Value::as_str),
        Some(cancel),
    )?;
    check_cancel(cancel)?;
    Ok(())
}

fn write_pivot_sheet(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
    header: &Format,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let (headers, rows) = build_pivot(result, params);
    write_string_sheet_labelled(
        wb,
        "数据透视表",
        &headers.iter().map(String::as_str).collect::<Vec<_>>(),
        &rows,
        header,
        None,
        Some(cancel),
        Some(&side_label(params, 2)),
    )
}

pub(crate) fn write_depreciation_period_sheet(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
    header: &Format,
    cancel: &AtomicBool,
    sheet_name: &str,
) -> Result<(), AppError> {
    // Legacy titled the paired columns with the mapped source column of each
    // workbook, and spelled the formula out in the last header.
    let headers = [
        mapped_display_header(params, 1, "category", "期初资产类别"),
        mapped_display_header(params, 2, "category", "期末资产类别"),
        mapped_display_header(params, 1, "life", "期初使用寿命(月)"),
        mapped_display_header(params, 2, "life", "期末使用寿命(月)"),
        mapped_display_header(params, 1, "residualRate", "期初残值率"),
        mapped_display_header(params, 2, "residualRate", "期末残值率"),
        mapped_display_header(params, 1, "originalValue", "期初原值"),
        mapped_display_header(params, 2, "originalValue", "期末原值"),
        "判断结果".to_owned(),
        "影响当年金额".to_owned(),
        "计算过程=年末原值*(1-年末残值率)/年末寿命-年末原值*(1-年初残值率)/年初寿命".to_owned(),
    ];
    write_string_sheet_labelled(
        wb,
        sheet_name,
        &headers.iter().map(String::as_str).collect::<Vec<_>>(),
        &build_depreciation_period(result, params),
        header,
        None,
        Some(cancel),
        Some(&side_label(params, 2)),
    )
}

fn write_anomaly_sheet(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
    header: &Format,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    write_string_sheet(
        wb,
        "异常清单",
        &[
            "异常类型",
            "原始行号",
            "资产类别",
            "资产编码",
            "资产名称",
            "期末原值",
            "处理方式",
            "行内容",
        ],
        &build_anomalies(result, params),
        header,
        None,
        Some(cancel),
    )
}

/// Parse a useful-life cell.  ERP exports write the unit inline — Kingdee ships
/// "60期", others "60个月" / "60月份" — and the plain `number()` parser returns
/// 0 for every one of them.  That zero then wipes the whole depreciation block
/// (月折旧额, 应计提月份, 测算折旧, 提足折旧时间) and drags every card into
/// ≤12月卡片明细.  Mirrors legacy `parse_life_months_value`: 年 is deliberately
/// absent from the suffix list, because legacy left "5年" unparsed rather than
/// guess a month count from it.
pub(crate) fn parse_life_cell(value: &str) -> Option<f64> {
    let cleaned = value
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',' && *c != '，')
        .collect::<String>();
    let cleaned = cleaned.trim_matches(|c| "'`‘’“”\"\u{feff}\u{200b}\u{200c}\u{200d}".contains(c));
    if cleaned.is_empty() {
        return None;
    }
    if matches!(
        cleaned.to_lowercase().as_str(),
        "nan" | "none" | "null" | "<na>"
    ) {
        return None;
    }
    if let Ok(parsed) = cleaned.parse::<f64>() {
        return Some(parsed);
    }
    let normalized = cleaned
        .replace('（', "(")
        .replace('）', ")")
        .replace('個', "个")
        .replace("个月", "月")
        .replace("月份", "月")
        .replace("期数", "期");
    let normalized = normalized.trim_matches(|c| "()[]【】".contains(c));
    let body = normalized.strip_prefix('第').unwrap_or(normalized);
    let lower = body.to_lowercase();
    for suffix in ["月", "期", "months", "month", "m"] {
        if let Some(head) = lower.strip_suffix(suffix) {
            return head.parse::<f64>().ok();
        }
    }
    None
}

/// Whether a life column is stored in years and has to be multiplied by 12.
///
/// Legacy decided this **once per column** from the header name and the column's
/// value profile.  A per-row "value <= 50 means years" rule looks equivalent but
/// is not: it turns a genuine 12-month tooling column into 144 months, and it
/// reacts differently to two cards in the same column.
pub(crate) fn life_scale_for_column(header: &str, values: &[f64]) -> f64 {
    let name = header
        .replace("_文件1", "")
        .replace("_文件2", "")
        .to_lowercase();
    if name.contains('月') || name.contains("month") {
        return 1.0;
    }
    const YEAR_MARKERS: [&str; 13] = [
        "使用年限",
        "折旧年限",
        "预计年限",
        "计划使用年",
        "预计使用年",
        "使用寿命年",
        "寿命年",
        "年限",
        "寿命(年)",
        "寿命（年）",
        "(年)",
        "（年）",
        "year",
    ];
    if YEAR_MARKERS.iter().any(|marker| name.contains(marker)) {
        return 12.0;
    }
    let positive = values
        .iter()
        .copied()
        .filter(|value| *value > 0.0)
        .collect::<Vec<_>>();
    if positive.is_empty() {
        return 1.0;
    }
    let max = positive.iter().copied().fold(f64::MIN, f64::max);
    // Anything that looks like a month count on its face (a 60/120/240 term, or
    // simply a value no year term reaches) is left alone.
    const TYPICAL_MONTHS: [i64; 5] = [36, 48, 60, 120, 240];
    if max > 70.0
        || positive
            .iter()
            .any(|value| TYPICAL_MONTHS.contains(&(value.round() as i64)))
    {
        return 1.0;
    }
    // Otherwise convert only on strong evidence: every value a whole number, all
    // of them common year terms, and none of them a value that reads equally
    // well as months (12/18/24).  Legacy stayed put on anything weaker and only
    // raised a warning.
    if max >= 30.0 || !positive.iter().all(|v| (v - v.round()).abs() < 1e-6) {
        return 1.0;
    }
    const TYPICAL_YEARS: [i64; 9] = [3, 4, 5, 6, 8, 10, 15, 20, 25];
    const AMBIGUOUS_MONTHS: [i64; 3] = [12, 18, 24];
    let rounded = positive
        .iter()
        .map(|v| v.round() as i64)
        .collect::<BTreeSet<_>>();
    if rounded.iter().all(|v| TYPICAL_YEARS.contains(v))
        && !rounded.iter().any(|v| AMBIGUOUS_MONTHS.contains(v))
    {
        12.0
    } else {
        1.0
    }
}

/// The year->month factor for one side's mapped life column, decided once from
/// the whole column.
fn life_scale(result: &MergeResult, params: &Value, side: u8) -> f64 {
    let Some(header) = mapped_header(params, side, "life") else {
        return 1.0;
    };
    let table = if side == 1 {
        &result.begin
    } else {
        &result.end
    };
    let Some(index) = table.headers.iter().position(|h| h == &header) else {
        return 1.0;
    };
    let values = table
        .rows
        .iter()
        .filter_map(|row| parse_life_cell(cell(row, index)))
        .collect::<Vec<_>>();
    life_scale_for_column(&header, &values)
}

/// One card's useful life in months, 0 when the cell is blank or unparseable.
fn mapped_life(result: &MergeResult, row: &JoinedRow, params: &Value, side: u8, scale: f64) -> f64 {
    match parse_life_cell(&mapped_text(result, row, params, side, "life")) {
        Some(value) if value > 0.0 => value * scale,
        _ => 0.0,
    }
}

pub(crate) fn parse_fa_date(value: &str) -> Option<NaiveDate> {
    let text = value
        .trim()
        .split([' ', 'T'])
        .next()
        .unwrap_or("")
        .replace(['年', '月'], "-")
        .replace('日', "")
        .replace('.', "-");
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%d/%m/%Y", "%m/%d/%Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(&text, format) {
            return Some(date);
        }
    }
    if let Ok(serial) = text.parse::<f64>() {
        return NaiveDate::from_ymd_opt(1899, 12, 30)?
            .checked_add_signed(chrono::Duration::days(serial as i64));
    }
    None
}

/// ERP card exports routinely store 资本化日期 / 入账开始日期 as a raw Excel
/// serial ("45104").  Detail sheets must show a real date: the serial is
/// unreadable, and writing it lands in the numeric branch of
/// `write_string_sheet`, which then stamps it with the money format.
/// Anything that is not a recognisable date is passed through untouched, so
/// placeholders like "[新增时间?]" survive.
pub(crate) fn display_date(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // parse_fa_date reads any bare number as an Excel serial.  Only accept that
    // reading inside a plausible business range (1927..2119), so a life of "5"
    // years does not become 1900-01-04.  8-digit forms such as 20230627 are
    // real dates and are left to the format parsers below.
    if trimmed.len() < 8 {
        if let Ok(serial) = trimmed.parse::<f64>() {
            if !(10_000.0..=80_000.0).contains(&serial) {
                return trimmed.to_owned();
            }
        }
    }
    match parse_fa_date(trimmed) {
        Some(date) if (1900..=2100).contains(&date.year()) => date.format("%Y-%m-%d").to_string(),
        _ => trimmed.to_owned(),
    }
}

fn depreciation_end_date(start: &str, months: f64) -> String {
    if months <= 0.0 {
        return String::new();
    }
    parse_fa_date(start)
        .and_then(|date| date.checked_add_months(Months::new(months.round() as u32)))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn period_label(date: &str, params: &Value, current: &str, outside: &str) -> String {
    let bs = params
        .get("balanceSheetDate")
        .or_else(|| params.get("balance_sheet_date"))
        .and_then(Value::as_str)
        .and_then(parse_fa_date);
    let event = parse_fa_date(date);
    match (event, bs) {
        (Some(e), Some(b)) if e.year() == b.year() => current.into(),
        (Some(_), Some(_)) => outside.into(),
        _ => current.into(),
    }
}

pub(crate) fn residual_rate(raw: f64, original: f64) -> f64 {
    if raw.abs() <= f64::EPSILON {
        0.0
    } else if raw > 100.0 && original.abs() > f64::EPSILON {
        raw / original
    } else if raw > 1.0 {
        raw / 100.0
    } else {
        raw
    }
}

/// Normalize the mapped residual field to a decimal rate.  The legacy
/// workflow accepts both a rate column and a monetary residual-value column.
/// A header that explicitly says residual *value* must be divided by original
/// cost even when every value is below 100; relying only on a `> 100` sample
/// heuristic silently turns a value such as 4 on an 80-cost asset into 4%
/// instead of the correct 5%.
fn mapped_residual_rate(
    result: &MergeResult,
    row: &JoinedRow,
    params: &Value,
    side: u8,
    original: f64,
) -> f64 {
    let raw = mapped_number(result, row, params, side, "residualRate");
    let header = mapped_header(params, side, "residualRate")
        .unwrap_or_default()
        .to_lowercase();
    let normalized = normalize_header(&header);
    let explicitly_amount = (normalized.contains("残值") && !normalized.contains("残值率"))
        || normalized.contains("residualvalue")
        || normalized.contains("salvagevalue");
    if explicitly_amount && original.abs() > f64::EPSILON {
        raw / original
    } else {
        residual_rate(raw, original)
    }
}

/// Residual rate and useful life are silently rewritten during export (a `5`
/// becomes `0.05`, `3` years becomes `36` months, a monetary 残值 column is
/// divided by原值).  Legacy popped a dialog for each of these asking the user to
/// verify the exported sheets; report them so the change is at least visible.
fn correction_warnings(result: &MergeResult, params: &Value) -> Vec<String> {
    let mut warnings = Vec::new();
    // 残值率/寿命纠偏对期初、期末两侧都会发生（折旧期间表两侧都要用），警告
    // 逐侧统计并带上期初/期末前缀——只写「残值率纠偏」用户无从知道该核对
    // 哪份清单。
    for side in [1u8, 2u8] {
        let period = if side == 1 { "期初" } else { "期末" };
        let table = if side == 1 {
            &result.begin
        } else {
            &result.end
        };
        let mut residual_scaled = 0usize;
        let mut residual_from_amount = 0usize;
        let mut life_converted = 0usize;
        let residual_header = mapped_header(params, side, "residualRate")
            .unwrap_or_default()
            .to_lowercase();
        let normalized_residual = normalize_header(&residual_header);
        let residual_is_amount = (normalized_residual.contains("残值")
            && !normalized_residual.contains("残值率"))
            || normalized_residual.contains("residualvalue")
            || normalized_residual.contains("salvagevalue");
        let life_header = mapped_header(params, side, "life").unwrap_or_default();
        // Warn on the same column-level decision the export actually applies, so
        // the message cannot claim a conversion that never happened (or stay silent
        // about one that did).
        let life_in_years = life_scale(result, params, side) > 1.0;
        for values in &table.rows {
            if values_are_summary_noise(values) {
                continue;
            }
            let row = JoinedRow {
                begin: if side == 1 {
                    Some(values.clone())
                } else {
                    None
                },
                end: if side == 2 {
                    Some(values.clone())
                } else {
                    None
                },
                source: if side == 1 {
                    "仅文件1"
                } else {
                    "仅文件2"
                },
                match_value: String::new(),
                extra: BTreeMap::new(),
            };
            let original = mapped_number(result, &row, params, side, "originalValue");
            let raw_residual = mapped_number(result, &row, params, side, "residualRate");
            if residual_is_amount
                && original.abs() > f64::EPSILON
                && raw_residual.abs() > f64::EPSILON
            {
                residual_from_amount += 1;
            } else if raw_residual > 1.0 {
                residual_scaled += 1;
            }
            if life_in_years
                && parse_life_cell(&mapped_text(result, &row, params, side, "life"))
                    .is_some_and(|life| life > 0.0)
            {
                life_converted += 1;
            }
        }
        if residual_from_amount > 0 {
            warnings.push(format!(
                "【{period}·残值率纠偏】{residual_from_amount} 张卡片的“{residual_header}”按残值金额除以原值换算成残值率，{}",
                if side == 2 {
                    "请确认导出的 FA List 与新增清单_BKD 中的残值率是否正确。"
                } else {
                    "请确认导出的折旧期间等底稿中的期初残值率是否正确。"
                }
            ));
        }
        if residual_scaled > 0 {
            warnings.push(format!(
                "【{period}·残值率纠偏】{residual_scaled} 张卡片的残值率大于 1，已按百分数换算（例如 5 视作 5%），请确认导出结果。"
            ));
        }
        if life_converted > 0 {
            warnings.push(format!(
                "【{period}·使用寿命纠偏】{life_converted} 张卡片的“{life_header}”按年换算为月（乘以 12），请确认导出的使用寿命是否正确。"
            ));
        }
    }
    warnings
}

#[derive(Default)]
struct DepGroup {
    begin_original: f64,
    end_original: f64,
    begin_residual_amount: f64,
    end_residual_amount: f64,
}

fn build_depreciation_period(result: &MergeResult, params: &Value) -> Vec<Vec<String>> {
    let begin_life_scale = life_scale(result, params, 1);
    let end_life_scale = life_scale(result, params, 2);
    #[derive(Clone)]
    struct Input {
        begin_category: String,
        end_category: String,
        begin_life: i64,
        end_life: i64,
        begin_original: f64,
        end_original: f64,
        begin_residual: f64,
        end_residual: f64,
        begin_category_inferred: bool,
    }
    let normalize_category = |value: String| {
        let value = value.trim().to_owned();
        let upper = value.to_uppercase().replace(' ', "");
        if matches!(
            upper.as_str(),
            "" | "未分类"
                | "N/A"
                | "#N/A"
                | "#N/AN/A"
                | "<NA>"
                | "NA"
                | "NAN"
                | "NONE"
                | "NULL"
                | "-"
                | "--"
        ) {
            String::new()
        } else {
            value
        }
    };
    let mut inputs = result
        .rows
        .iter()
        .map(|row| {
            let begin_original = mapped_number(result, row, params, 1, "originalValue");
            let end_original = mapped_number(result, row, params, 2, "originalValue");
            Input {
                begin_category: normalize_category(mapped_text(result, row, params, 1, "category")),
                end_category: normalize_category(mapped_text(result, row, params, 2, "category")),
                begin_life: mapped_life(result, row, params, 1, begin_life_scale).round() as i64,
                end_life: mapped_life(result, row, params, 2, end_life_scale).round() as i64,
                begin_original,
                end_original,
                begin_residual: mapped_residual_rate(result, row, params, 1, begin_original),
                end_residual: mapped_residual_rate(result, row, params, 2, end_original),
                begin_category_inferred: false,
            }
        })
        .collect::<Vec<_>>();

    // Match the legacy A/B/C/D fallback rules before grouping.  Closing-only
    // cards join an existing opening category/life group when that combination
    // already exists; genuinely new categories remain visible as 未分类 -> 类别.
    let start_categories = inputs
        .iter()
        .filter(|i| !i.begin_category.is_empty() && i.begin_original.abs() > 0.005)
        .map(|i| i.begin_category.clone())
        .collect::<BTreeSet<_>>();
    let start_category_lives = inputs
        .iter()
        .filter(|i| {
            !i.begin_category.is_empty() && i.begin_life != 0 && i.begin_original.abs() > 0.005
        })
        .map(|i| (i.begin_category.clone(), i.begin_life))
        .collect::<BTreeSet<_>>();
    for input in &mut inputs {
        if input.begin_category.is_empty()
            && !input.end_category.is_empty()
            && start_categories.contains(&input.end_category)
        {
            input.begin_category = input.end_category.clone();
            input.begin_category_inferred = true;
        }
        if input.begin_original.abs() <= 0.005
            && input.begin_category_inferred
            && input.begin_life == 0
            && input.end_life != 0
            && start_category_lives.contains(&(input.begin_category.clone(), input.end_life))
        {
            input.begin_life = input.end_life;
        }
    }
    let mut closing_by_opening = BTreeMap::<(String, i64), (String, i64)>::new();
    for input in &inputs {
        if !input.begin_category.is_empty() && !input.end_category.is_empty() {
            closing_by_opening
                .entry((input.begin_category.clone(), input.begin_life))
                .or_insert_with(|| (input.end_category.clone(), input.end_life));
        }
    }
    for input in &mut inputs {
        if input.end_category.is_empty() && !input.begin_category.is_empty() {
            if let Some((category, life)) =
                closing_by_opening.get(&(input.begin_category.clone(), input.begin_life))
            {
                input.end_category = category.clone();
                input.end_life = *life;
            }
        }
        if input.begin_life == 0 && input.end_life != 0 && input.begin_original.abs() > 0.005 {
            input.begin_life = input.end_life;
        }
        if input.end_life == 0 && input.begin_life != 0 && input.end_original.abs() > 0.005 {
            input.end_life = input.begin_life;
        }
    }

    let mut groups: BTreeMap<(String, String, i64, i64), DepGroup> = BTreeMap::new();
    for input in inputs {
        let key = (
            input.begin_category,
            input.end_category,
            input.begin_life,
            input.end_life,
        );
        let group = groups.entry(key).or_default();
        group.begin_original += input.begin_original;
        group.end_original += input.end_original;
        group.begin_residual_amount += input.begin_original * input.begin_residual;
        group.end_residual_amount += input.end_original * input.end_residual;
    }
    let mut prepared = groups
        .into_iter()
        .filter_map(
            |((mut begin_category, mut end_category, mut begin_life, mut end_life), g)| {
                let begin_rate = if g.begin_original.abs() > f64::EPSILON {
                    g.begin_residual_amount / g.begin_original
                } else {
                    0.0
                };
                let end_rate = if g.end_original.abs() > f64::EPSILON {
                    g.end_residual_amount / g.end_original
                } else {
                    0.0
                };
                // Old sheet removes rows where C/D/E are all zero.
                if begin_life == 0 && end_life == 0 && begin_rate.abs() <= f64::EPSILON {
                    return None;
                }
                if g.begin_original.abs() <= 0.005 {
                    begin_life = 0;
                }
                if g.end_original.abs() <= 0.005 {
                    end_life = 0;
                }
                if end_category.is_empty() && !begin_category.is_empty() {
                    end_category = begin_category.clone();
                    end_life = begin_life;
                }
                if begin_category.is_empty() && end_category.is_empty() {
                    begin_category = "未分类".into();
                    end_category = "未分类".into();
                } else {
                    if begin_category.is_empty() {
                        begin_category = "未分类".into();
                    }
                    if end_category.is_empty() {
                        end_category = "未分类".into();
                    }
                }
                Some((
                    begin_category,
                    end_category,
                    begin_life,
                    end_life,
                    begin_rate,
                    end_rate,
                    g,
                ))
            },
        )
        .collect::<Vec<_>>();

    let mut starting_lives = BTreeMap::<String, BTreeSet<i64>>::new();
    for (begin_category, end_category, begin_life, _, _, _, g) in &prepared {
        if g.begin_original.abs() <= 0.005 || *begin_life == 0 {
            continue;
        }
        for category in [begin_category, end_category] {
            if category != "未分类" {
                starting_lives
                    .entry(category.clone())
                    .or_default()
                    .insert(*begin_life);
            }
        }
    }
    prepared
        .drain(..)
        .map(
            |(begin_category, end_category, begin_life, end_life, begin_rate, end_rate, g)| {
                let new_at_end = g.begin_original.abs() <= 0.005 && g.end_original.abs() > 0.005;
                let any_zero = g.begin_original.abs() <= 0.005 || g.end_original.abs() <= 0.005;
                let life_exists = new_at_end
                    && [begin_category.as_str(), end_category.as_str()]
                        .iter()
                        .filter(|category| **category != "未分类")
                        .any(|category| {
                            starting_lives
                                .get(*category)
                                .is_some_and(|lives| lives.contains(&end_life))
                        });
                let end_only_category = begin_category == "未分类" && end_category != "未分类";
                let residual_conflict = begin_rate.abs() > f64::EPSILON
                    && end_rate.abs() > f64::EPSILON
                    && (begin_rate - end_rate).abs() > 0.005;
                let mut status = if begin_life == end_life {
                    "一致"
                } else {
                    "不一致"
                };
                if residual_conflict {
                    status = "不一致";
                }
                if any_zero && !new_at_end {
                    status = "一致";
                }
                if new_at_end {
                    status = if life_exists { "一致" } else { "不一致" };
                }
                if end_only_category {
                    status = "待确认";
                }
                let calculation_begin_life = if new_at_end && begin_life == 0 {
                    end_life
                } else {
                    begin_life
                };
                let impact = if status == "不一致" && end_life != 0 && calculation_begin_life != 0
                {
                    g.end_original * (1.0 - end_rate) / end_life as f64
                        - g.end_original * (1.0 - begin_rate) / calculation_begin_life as f64
                } else {
                    0.0
                };
                let process = if status == "不一致" && end_life != 0 && calculation_begin_life != 0
                {
                    format!(
                        "{:.2}*(1-{:.4})/{:.4}-{:.2}*(1-{:.4})/{:.4}={:.2}",
                        g.end_original,
                        end_rate,
                        end_life as f64,
                        g.end_original,
                        begin_rate,
                        calculation_begin_life as f64,
                        impact
                    )
                } else {
                    String::new()
                };
                vec![
                    begin_category,
                    end_category,
                    if begin_life == 0 && g.begin_original.abs() > 0.005 {
                        String::new()
                    } else {
                        begin_life.to_string()
                    },
                    end_life.to_string(),
                    display_precise_number(begin_rate),
                    display_precise_number(end_rate),
                    display_number(round_money(g.begin_original)),
                    display_number(round_money(g.end_original)),
                    status.into(),
                    display_precise_number(impact),
                    process,
                ]
            },
        )
        .collect()
}

fn generic_field_value(
    result: &MergeResult,
    row: &JoinedRow,
    params: &Value,
    field: &str,
) -> String {
    match field {
        "category" | "资产类别" => {
            if row.end.is_some() {
                mapped_text(result, row, params, 2, "category")
            } else {
                mapped_text(result, row, params, 1, "category")
            }
        }
        // Crossing the two sides is what makes a reclassification visible:
        // 期末=运输工具 against 期初=运输设备 shows where the balance moved.
        // A card present on one side only takes that side's category on both
        // axes — labelling the missing side 未分类 split every category into
        // two rows and doubled the sheet without adding information.
        "beginCategory" | "期初资产类别" => {
            let begin = mapped_text(result, row, params, 1, "category");
            nonempty(begin).unwrap_or_else(|| mapped_text(result, row, params, 2, "category"))
        }
        "endCategory" | "期末资产类别" => {
            let end = mapped_text(result, row, params, 2, "category");
            nonempty(end).unwrap_or_else(|| mapped_text(result, row, params, 1, "category"))
        }
        "name" | "资产名称" => {
            if row.end.is_some() {
                mapped_text(result, row, params, 2, "name")
            } else {
                mapped_text(result, row, params, 1, "name")
            }
        }
        "source" | "数据来源" => row.source.into(),
        "match" | "匹配列" => row.match_value.clone(),
        _ => {
            let value = row_json(result, row, true);
            json_cell(value.get(field))
        }
    }
}

fn generic_numeric_value(
    result: &MergeResult,
    row: &JoinedRow,
    params: &Value,
    field: &str,
) -> f64 {
    match field {
        "beginOriginal" | "期初原值" => mapped_number(result, row, params, 1, "originalValue"),
        "endOriginal" | "期末原值" => mapped_number(result, row, params, 2, "originalValue"),
        "beginDepreciation" | "期初累计折旧" => {
            mapped_number(result, row, params, 1, "depreciation")
        }
        "endDepreciation" | "期末累计折旧" => {
            mapped_number(result, row, params, 2, "depreciation")
        }
        _ => number(&generic_field_value(result, row, params, field)),
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Maps a pivot field name onto the legacy display header (mapped source column
/// + workbook label).  Unknown fields keep their own name.
fn pivot_value_header(field: &str, params: &Value) -> String {
    let (side, role) = match field {
        "期初资产类别" | "beginCategory" => (1, "category"),
        "期末资产类别" | "endCategory" | "资产类别" | "category" => (2, "category"),
        "期初原值" | "beginOriginal" => (1, "originalValue"),
        "期末原值" | "endOriginal" => (2, "originalValue"),
        "期初累计折旧" | "beginDepreciation" => (1, "depreciation"),
        "期末累计折旧" | "endDepreciation" => (2, "depreciation"),
        _ => return field.to_owned(),
    };
    mapped_display_header(params, side, role, field)
}

fn build_pivot(result: &MergeResult, params: &Value) -> (Vec<String>, Vec<Vec<String>>) {
    let config = params.get("pivotConfig").unwrap_or(&Value::Null);
    let mut row_fields = string_array(config.get("rows"))
        .into_iter()
        .chain(string_array(params.get("pivotRows")))
        .collect::<Vec<_>>();
    let column_fields = string_array(config.get("columns"))
        .into_iter()
        .chain(string_array(params.get("pivotColumns")))
        .collect::<Vec<_>>();
    // Default layout mirrors the legacy sheet: 期末 × 期初 category cross-tab
    // over both original value and accumulated depreciation.  Collapsing it to
    // a single 资产类别 column hid every reclassification, and dropping the
    // depreciation pair left the sheet unable to explain the movement table.
    if row_fields.is_empty() {
        row_fields.push("期末资产类别".into());
        row_fields.push("期初资产类别".into());
    }
    let value_specs = config
        .get("values")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            vec![
                json!({"field":"期末原值","agg":"sum"}),
                json!({"field":"期初原值","agg":"sum"}),
                json!({"field":"期末累计折旧","agg":"sum"}),
                json!({"field":"期初累计折旧","agg":"sum"}),
            ]
        });
    #[derive(Default)]
    struct Agg {
        count: usize,
        sum: f64,
        min: f64,
        max: f64,
        initialized: bool,
    }
    let mut groups: BTreeMap<(Vec<String>, Vec<String>, usize), Agg> = BTreeMap::new();
    let mut row_keys = BTreeSet::new();
    let mut column_keys = BTreeSet::new();
    // Grand-total / subtotal rows carried by the source cards must not become
    // a pivot category of their own; leaving them in double-counts the sheet.
    for row in result
        .rows
        .iter()
        .filter(|row| row_summary_noise_marker(row).is_none())
    {
        let rk = row_fields
            .iter()
            .map(|f| {
                let value = generic_field_value(result, row, params, f);
                if value.trim().is_empty() {
                    "未分类".into()
                } else {
                    value
                }
            })
            .collect::<Vec<_>>();
        let ck = column_fields
            .iter()
            .map(|f| generic_field_value(result, row, params, f))
            .collect::<Vec<_>>();
        row_keys.insert(rk.clone());
        column_keys.insert(ck.clone());
        for (spec_index, spec) in value_specs.iter().enumerate() {
            let field = spec
                .get("field")
                .and_then(Value::as_str)
                .unwrap_or("期末原值");
            let value = generic_numeric_value(result, row, params, field);
            let entry = groups
                .entry((rk.clone(), ck.clone(), spec_index))
                .or_default();
            entry.count += 1;
            entry.sum += value;
            if !entry.initialized {
                entry.min = value;
                entry.max = value;
                entry.initialized = true
            } else {
                entry.min = entry.min.min(value);
                entry.max = entry.max.max(value);
            }
        }
    }
    let mut headers = row_fields
        .iter()
        .map(|f| pivot_value_header(f, params))
        .collect::<Vec<_>>();
    let column_keys = if column_fields.is_empty() {
        vec![Vec::new()]
    } else {
        column_keys.into_iter().collect::<Vec<_>>()
    };
    let specs = value_specs
        .iter()
        .map(|spec| {
            (
                spec.get("field")
                    .and_then(Value::as_str)
                    .unwrap_or("期末原值")
                    .to_owned(),
                spec.get("agg")
                    .and_then(Value::as_str)
                    .unwrap_or("sum")
                    .to_lowercase(),
            )
        })
        .collect::<Vec<_>>();
    let mut seen_headers = HashMap::<String, usize>::new();
    for (field, agg) in &specs {
        for ck in &column_keys {
            let column_label = ck
                .iter()
                .map(|value| {
                    if value.trim().is_empty() {
                        "未分类"
                    } else {
                        value
                    }
                })
                .collect::<Vec<_>>()
                .join("_");
            // Legacy titled the value columns with the mapped source column and
            // its workbook ("原值(期末)_2025固定资产卡片02.xlsx & 2512") and only
            // appended the aggregation when several were mixed.
            let label = pivot_value_header(field, params);
            let uniform_agg = specs.iter().all(|(_, a)| a == agg);
            let base = if column_fields.is_empty() {
                if uniform_agg {
                    label
                } else {
                    format!("{label}_{agg}")
                }
            } else if uniform_agg {
                column_label
            } else {
                format!("{label}_{agg}_{column_label}")
            };
            let count = seen_headers.entry(base.clone()).or_default();
            headers.push(if *count == 0 {
                base
            } else {
                format!("{base}_{}", *count)
            });
            *count += 1;
        }
    }
    let aggregate_value = |value: Option<&Agg>, agg: &str| -> f64 {
        let Some(value) = value else { return 0.0 };
        match agg {
            "count" => value.count as f64,
            "mean" | "average" => {
                if value.count == 0 {
                    0.0
                } else {
                    value.sum / value.count as f64
                }
            }
            "min" => value.min,
            "max" => value.max,
            _ => value.sum,
        }
    };
    let mut rows = row_keys
        .into_iter()
        .map(|rk| {
            let mut output = rk.clone();
            for (spec_index, (_field, agg)) in specs.iter().enumerate() {
                for ck in &column_keys {
                    let value =
                        aggregate_value(groups.get(&(rk.clone(), ck.clone(), spec_index)), agg);
                    let value = round_money(value);
                    output.push(if value.abs() < f64::EPSILON {
                        "0".into()
                    } else {
                        display_number(value)
                    });
                }
            }
            output
        })
        // A group whose every measure is zero carries no information; it only
        // exists because some card had a blank category on both sides, and it
        // reads on the sheet as a real 未分类 balance of nil.  Legacy never
        // produced such a line.
        .filter(|output| {
            output[row_fields.len()..]
                .iter()
                .any(|value| number(value).abs() > f64::EPSILON)
        })
        .collect::<Vec<_>>();
    // Trailing 合计 row: the legacy sheet carried one, and without it the
    // reader has to sum a dozen categories by hand to tie to the movement
    // table.  Written as =SUM over the category rows, the way legacy did, so
    // the total stays traceable in Excel instead of being a frozen number.
    // Summed over categories only — averages/min/max are not additive, so those
    // aggregations get a blank instead of a misleading number.
    if !rows.is_empty() {
        let first_data_row = 3;
        let last_data_row = rows.len() + 2;
        let mut total = vec!["合计".to_owned()];
        total.resize(row_fields.len(), String::new());
        for (index, header_index) in (row_fields.len()..headers.len()).enumerate() {
            let agg = &specs[index / column_keys.len().max(1)].1;
            if matches!(agg.as_str(), "sum" | "count") {
                let column = xlsx_col(header_index);
                total.push(format!(
                    "=SUM({column}{first_data_row}:{column}{last_data_row})"
                ));
            } else {
                total.push(String::new());
            }
        }
        rows.push(total);
    }
    (headers, rows)
}

fn build_anomalies(result: &MergeResult, params: &Value) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for (row_index, row) in result.rows.iter().enumerate() {
        for side in [1, 2] {
            if (side == 1 && row.begin.is_none()) || (side == 2 && row.end.is_none()) {
                continue;
            }
            let life =
                parse_life_cell(&mapped_text(result, row, params, side, "life")).unwrap_or(0.0);
            let residual = mapped_number(result, row, params, side, "residualRate");
            let original = mapped_number(result, row, params, side, "originalValue");
            let depreciation = mapped_number(result, row, params, side, "depreciation");
            let category = mapped_text(result, row, params, side, "category");
            let name = mapped_text(result, row, params, side, "name");
            let raw = if side == 1 {
                row.begin.as_ref()
            } else {
                row.end.as_ref()
            }
            .map(|values| values.join(" | "))
            .unwrap_or_default();
            let mut push = |kind: &str, action: &str| {
                rows.push(vec![
                    kind.into(),
                    (row_index + 2).to_string(),
                    category.clone(),
                    row.match_value.clone(),
                    name.clone(),
                    display_number(if side == 2 { original } else { 0.0 }),
                    action.into(),
                    raw.clone(),
                ]);
            };
            if mapped_header(params, side, "life").is_some() && life < 0.0 {
                push(
                    "使用寿命异常",
                    &format!("文件{side} 使用寿命为负数，保留原值待复核。"),
                );
            }
            if mapped_header(params, side, "residualRate").is_some() && residual < 0.0 {
                push(
                    "残值率异常",
                    &format!("文件{side} 残值率/残值为负数，保留原值待复核。"),
                );
            }
            if mapped_header(params, side, "originalValue").is_some() && original < -0.005 {
                push(
                    "原值异常",
                    &format!("文件{side} 原值为负数，保留原值待复核。"),
                );
            }
            if mapped_header(params, side, "depreciation").is_some()
                && (depreciation < -0.005 || (original >= 0.0 && depreciation > original + 0.01))
            {
                push(
                    "累计折旧异常",
                    &format!("文件{side} 累计折旧为负或大于原值，保留原值待复核。"),
                );
            }
        }
    }
    if rows.is_empty() {
        rows.push(vec![
            "未发现异常".into(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            "未发现需要列入异常清单的记录。".into(),
            String::new(),
        ]);
    }
    rows
}

fn write_string_sheet(
    wb: &mut Workbook,
    name: &str,
    headers: &[&str],
    rows: &[Vec<String>],
    header: &Format,
    balance_sheet_date: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<(), AppError> {
    write_string_sheet_labelled(
        wb,
        name,
        headers,
        rows,
        header,
        balance_sheet_date,
        cancel,
        None,
    )
}

/// `end_label` is the file2 workbook label ("2025清单.xls & Sheet1").  The pivot
/// and depreciation-period sheets title their columns with the source column
/// plus that label — no literal "期末" — so without it every column on those two
/// sheets gets annotated 期初, which on an audit schedule reads as a claim about
/// where the figure came from.
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_string_sheet_labelled(
    wb: &mut Workbook,
    name: &str,
    headers: &[&str],
    rows: &[Vec<String>],
    header: &Format,
    balance_sheet_date: Option<&str>,
    cancel: Option<&AtomicBool>,
    end_label: Option<&str>,
) -> Result<(), AppError> {
    // Legacy rendered every amount as #,##0 and sized columns off that same
    // rendering.  Keeping two decimals here while measuring widths as integers
    // is what produced ### in the money columns.
    let number_format = Format::new().set_num_format(MONEY_NUMBER_FORMAT);
    let integer_format = Format::new().set_num_format(MONEY_NUMBER_FORMAT);
    let percent_format = Format::new().set_num_format("0.00%");
    let source_format = Format::new()
        .set_italic()
        .set_font_color("#374151")
        .set_background_color("#F7F8FA")
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    let note_format = Format::new()
        .set_background_color("#F6F6F6")
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let ws = wb.add_worksheet();
    ws.set_name(name).map_err(xlsx_error)?;
    for (c, h) in headers.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, header)
            .map_err(xlsx_error)?;
        ws.write_string_with_format(
            1,
            c as u16,
            field_source_for_header(name, h, c, end_label),
            &source_format,
        )
        .map_err(xlsx_error)?;
    }
    let numeric_column = (0..headers.len())
        .map(|c| column_reads_numeric(rows.iter().filter_map(|r| r.get(c)).map(String::as_str)))
        .collect::<Vec<_>>();
    let mut widest = vec![0usize; headers.len()];
    for (r, row) in rows.iter().enumerate() {
        if r % 256 == 0 {
            if let Some(cancel) = cancel {
                check_cancel(cancel)?;
            }
        }
        for (c, value) in row.iter().enumerate() {
            let header = headers.get(c).copied().unwrap_or("");
            if c < widest.len() && (r < 10 || numeric_column[c]) {
                widest[c] = widest[c].max(legacy_display_len(value, header));
            }
            // A date column must stay textual even when the source handed us a
            // bare Excel serial: writing it as a number stamps the money format
            // on it and the sheet shows "45,104.00" instead of a date.
            let is_date = header.contains("日期") || header.contains("时间");
            match value.parse::<f64>() {
                Ok(number) if !is_date && !is_identifier_header(header) => {
                    let format = if header.contains("残值率")
                        || header.contains("比例")
                        || header.contains("百分比")
                    {
                        &percent_format
                    } else if header.contains("月份")
                        || header.contains("寿命")
                        || header.contains("数量")
                    {
                        &integer_format
                    } else {
                        &number_format
                    };
                    ws.write_number_with_format((r + 2) as u32, c as u16, number, format)
                        .map_err(xlsx_error)?;
                }
                // A total row hands us "=SUM(C3:C10)".  Writing that as text
                // shows the formula instead of the figure and, worse, leaves the
                // reader unable to see that the total really is the column.
                _ if value.starts_with('=') && value.len() > 1 => {
                    ws.write_formula_with_format(
                        (r + 2) as u32,
                        c as u16,
                        value.as_str(),
                        &number_format,
                    )
                    .map_err(xlsx_error)?;
                }
                _ => {
                    ws.write_string((r + 2) as u32, c as u16, value)
                        .map_err(xlsx_error)?;
                }
            }
        }
    }
    let mapped_disposal_measurement = name == "处置清单_BKD"
        && headers.iter().any(|header| *header == "处置时间")
        && headers.iter().any(|header| *header == "处置原值")
        && headers.iter().any(|header| *header == "处置折旧");
    if name == "FA List" || name == "折旧测算" || mapped_disposal_measurement {
        append_depreciation_formulas(
            ws,
            name,
            headers,
            rows.len(),
            balance_sheet_date.unwrap_or("2099-12-31"),
            header,
            &source_format,
        )?;
    }
    ws.set_freeze_panes(2, 0).map_err(xlsx_error)?;
    if !headers.is_empty() {
        ws.autofilter(
            0,
            0,
            rows.len() as u32 + 1,
            headers.len().saturating_sub(1) as u16,
        )
        .map_err(xlsx_error)?;
    }
    let note_row = rows.len() as u32 + 3;
    ws.write_string_with_format(note_row, 0, "本表说明", header)
        .map_err(xlsx_error)?;
    let info = sheet_explanation(name);
    let note = format!("{} 信息来源：{} 重点关注：{}", info.0, info.1, info.2);
    if headers.len() >= 4 {
        ws.merge_range(note_row, 1, note_row, 3, &note, &note_format)
            .map_err(xlsx_error)?;
    } else {
        // Even a one-column exception sheet still needs the explanation body.
        // Writing it in B preserves the standard "本表说明 | 正文" contract
        // instead of leaving a dangling label with no source or review guidance.
        ws.write_string_with_format(note_row, 1, &note, &note_format)
            .map_err(xlsx_error)?;
    }
    // Legacy geometry: explicit widths from the content (autofit ran away on
    // long asset names), a taller source row, a thin spacer above the note and
    // a deep note row so the wrapped text is readable.
    for c in 0..headers.len() {
        ws.set_column_width(c as u16, legacy_column_width(name, widest[c]))
            .map_err(xlsx_error)?;
    }
    ws.set_row_height(1, 22).map_err(xlsx_error)?;
    ws.set_row_height(note_row - 1, 8).map_err(xlsx_error)?;
    ws.set_row_height(note_row, 72).map_err(xlsx_error)?;
    Ok(())
}

fn header_is_end_side(header: &str, end_label: Option<&str>) -> bool {
    header.contains("期末")
        || end_label.is_some_and(|label| !label.is_empty() && header.ends_with(label))
}

fn field_source_for_header(
    sheet: &str,
    header: &str,
    column: usize,
    end_label: Option<&str>,
) -> &'static str {
    if sheet == "LLM分析" {
        return "工具计算/LLM辅助";
    }
    match sheet {
        "FA List" | "≤12月卡片明细" => match header {
            "已提足折旧" | "提示" => "逻辑判断",
            "净值" | "提足折旧时间" => "计算",
            "使用寿命(月)" | "残值率" => "期末映射/换算",
            _ => "取自期末卡片",
        },
        "新增清单_BKD" => {
            if header.contains('?') {
                "人工补充"
            } else if matches!(header, "新增方式" | "新增时间") {
                "取自新增补充清单"
            } else if header == "增加类型" {
                "逻辑判断"
            } else if header == "原值增加" {
                "计算"
            } else if matches!(header, "使用寿命(月)" | "残值率") {
                "期末映射/换算"
            } else {
                "取自期末卡片"
            }
        }
        "处置清单_BKD" => match header {
            h if h.contains('?') => "人工补充",
            "处置方式" | "处置时间" | "处置原值" => "取自处置补充清单",
            "处置折旧" => "补充清单/缺失时引用年初累计折旧",
            "减少类型" => "逻辑判断",
            "原值减少" | "年初累计折旧" | "本年折旧" | "净值" => "计算",
            "使用寿命(月)" | "残值率" => "期初映射/换算",
            _ => "取自期初卡片",
        },
        // These two sheets title their columns with the mapped source column plus
        // the workbook label ("原值原币_2025清单.xls & 2025年固资清单") — the words
        // 期初/期末 never appear — so the workbook label is what tells the two
        // sides apart.  Without it every column was annotated 期初, which on an
        // audit schedule reads as a false claim about where the figure came from.
        "数据透视表" => {
            if header.contains("数据来源") || header.contains("匹配") || header.contains("变动类型")
            {
                "逻辑判断"
            } else if header_is_end_side(header, end_label) {
                "根据期末卡片聚合"
            } else {
                "根据期初卡片聚合"
            }
        }
        "折旧期间" | "折旧政策对比" => {
            if header.contains("判断") {
                return "逻辑判断";
            }
            if header.contains("影响") || header.contains("计算过程") {
                return "计算";
            }
            if header_is_end_side(header, end_label) {
                "根据期末卡片聚合"
            } else {
                "根据期初卡片聚合"
            }
        }
        "折旧测算" => match header {
            "使用寿命(月)" | "残值率" => "期末映射/换算",
            _ => "取自期末清单",
        },
        // 税法最低折旧年限参考：fa_subtools::write_tax_reference_sheet 专用写表器
        // 负责（含政策原文列与官方链接），不再经过本函数。
        "异常清单" => match header {
            "资产类别" | "资产编码" | "资产名称" | "期末原值" => "取自期末卡片",
            "原始行号" | "行内容" => "取自合并数据",
            _ => "逻辑判断",
        },
        _ if header.contains("差异") || header.contains("影响") || header.contains("计算过程") => {
            "计算"
        }
        _ if header.contains("类型") || header.contains("方式") || header.contains("判断") => {
            "逻辑判断"
        }
        _ => {
            let _ = column;
            "根据期初/期末卡片聚合"
        }
    }
}

fn xlsx_col(mut index: usize) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    out
}

fn append_depreciation_formulas(
    ws: &mut rust_xlsxwriter::Worksheet,
    sheet_name: &str,
    headers: &[&str],
    row_count: usize,
    balance_sheet_date: &str,
    header_format: &Format,
    source_format: &Format,
) -> Result<(), AppError> {
    let required = if matches!(sheet_name, "FA List" | "折旧测算") {
        [
            "入账开始日期",
            "使用寿命(月)",
            "残值率",
            "原值",
            "累计折旧",
            "本年折旧",
        ]
    } else {
        [
            "入账开始日期",
            "使用寿命(月)",
            "残值率",
            "原值减少",
            "年初累计折旧",
            "本年折旧",
        ]
    };
    let Some(indexes) = required
        .iter()
        .map(|h| headers.iter().position(|v| v == h))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(());
    };
    // FA List 保持旧版 N..U 列位（至少 12 列起步）；处置清单_BKD 同理 15 列。
    // 折旧测算页固定 8 列映射字段，公式块紧随其后（中间保留一格间隔列）。
    let start = match sheet_name {
        "FA List" => headers.len().max(12) + 1,
        "处置清单_BKD" => headers.len().max(15) + 1,
        _ => headers.len() + 1,
    };
    let output = [
        "月折旧额",
        "本年应计提折旧月份",
        "累计折旧月份",
        "测算的当年折旧",
        "测算的累计折旧",
        "账面本年折旧",
        "差异_本年折旧",
        "差异_累计折旧",
    ];
    // The six money columns of the block (offsets 0/3/4/5/6/7 — on FA List these
    // land in N and Q..U).  They are located by offset, never by a hard-coded
    // letter: the block starts after the sheet's own headers, so on a sheet with
    // more than 12 columns the same fields shift right.  Offsets 1 and 2 are
    // month counts and keep their own rendering.
    const MONEY_OFFSETS: [usize; 6] = [0, 3, 4, 5, 6, 7];
    let money_format = Format::new().set_num_format(MONEY_NUMBER_FORMAT);
    for (offset, name) in output.iter().enumerate() {
        ws.write_string_with_format(0, (start + offset) as u16, *name, header_format)
            .map_err(xlsx_error)?;
        ws.write_string_with_format(1, (start + offset) as u16, "计算", source_format)
            .map_err(xlsx_error)?;
    }
    let d = xlsx_col(indexes[0]);
    let life = xlsx_col(indexes[1]);
    let residual = xlsx_col(indexes[2]);
    let original = xlsx_col(indexes[3]);
    let accumulated = xlsx_col(indexes[4]);
    let current = xlsx_col(indexes[5]);
    let disposal_sheet = sheet_name == "处置清单_BKD";
    let accumulated_comparison = if disposal_sheet {
        headers
            .iter()
            .position(|header| *header == "处置折旧")
            .map(xlsx_col)
            .unwrap_or_else(|| accumulated.clone())
    } else {
        accumulated.clone()
    };
    let formula_cols = (0..8).map(|i| xlsx_col(start + i)).collect::<Vec<_>>();
    let cutoff_col = headers.iter().position(|h| *h == "处置时间").map(xlsx_col);
    // Legacy capped the formula block on large sheets: writing 12k live array
    // formulas makes Excel crawl on open.  Past the limit only a template block
    // is written and the user fills down if they want the rest.
    let formula_rows = if row_count <= DEPRECIATION_FORMULA_ROW_LIMIT {
        row_count
    } else {
        row_count.min(DEPRECIATION_FORMULA_SAMPLE_ROWS)
    };
    for r in 0..formula_rows {
        let excel_row = r + 3;
        let cutoff = cutoff_col
            .as_ref()
            .map(|col| {
                format!(
                    "IF({col}{excel_row}=\"\",DATEVALUE(\"{balance_sheet_date}\"),IF(ISNUMBER({col}{excel_row}),{col}{excel_row},DATEVALUE(SUBSTITUTE({col}{excel_row},\".\",\"-\"))))"
                )
            })
            .unwrap_or_else(|| format!("DATEVALUE(\"{balance_sheet_date}\")"));
        let rate = format!(
            "IF({residual}{excel_row}=\"\",0,IF({residual}{excel_row}>1,{residual}{excel_row}/100,{residual}{excel_row}))"
        );
        // Legacy intersected three windows — the asset's own depreciation life,
        // the audited year, and the balance-sheet (or disposal) date — instead
        // of just measuring the months since acquisition.  Counting elapsed
        // months and clamping to 12 reports a full year of depreciation for
        // assets that finished depreciating years ago, which fills the whole
        // 差异_本年折旧 column with phantom differences.
        // Excel receives dates from many accounting exports as text (notably
        // `2022.12.29`). YEAR/MONTH on that text returns #VALUE!, which then
        // poisons every downstream depreciation formula. Coerce both true
        // Excel dates and dot-delimited text before doing date arithmetic.
        let start_date = format!(
            "IF(ISNUMBER({d}{excel_row}),{d}{excel_row},DATEVALUE(SUBSTITUTE({d}{excel_row},\".\",\"-\")))"
        );
        let dep_start = format!("EDATE(DATE(YEAR({start_date}),MONTH({start_date}),1),1)");
        let dep_end = format!("EDATE({dep_start},{life}{excel_row}-1)");
        let bs_month = format!(
            "DATE(YEAR(DATEVALUE(\"{balance_sheet_date}\")),MONTH(DATEVALUE(\"{balance_sheet_date}\")),1)"
        );
        let effective = format!("MIN({bs_month},DATE(YEAR({cutoff}),MONTH({cutoff}),1))");
        let year_start = format!("DATE(YEAR(DATEVALUE(\"{balance_sheet_date}\")),1,1)");
        let period_end = format!("MIN({dep_end},{effective})");
        let current_start = format!("MAX({dep_start},{year_start})");
        let months_current = format!(
            "(YEAR({period_end})-YEAR({current_start}))*12+MONTH({period_end})-MONTH({current_start})+1"
        );
        let months_accumulated = format!(
            "(YEAR({period_end})-YEAR({dep_start}))*12+MONTH({period_end})-MONTH({dep_start})+1"
        );
        let unusable = format!("OR({d}{excel_row}=\"\",{life}{excel_row}<=0)");
        // 月折旧额 must land as a number on every single row.  The old fallback
        // was the empty string "", which Excel stores as *text*: the column then
        // mixed numbers and text, and any 后续公式 the reviewer wrote over it
        // (差异, 小计, 乘算) either silently skipped those rows or returned
        // #VALUE!.  Cards with no life / no original value now read 0 —
        // "没有折旧" is the honest figure and it stays arithmetic-safe.
        let monthly_depreciation =
            format!("=IFERROR(ROUND({original}{excel_row}*(1-{rate})/{life}{excel_row},2),0)");
        let measured_current = format!(
            "=IF(OR(LEN({}{excel_row})=0,LEN({}{excel_row})=0),\"\",ROUND({}{excel_row}*{}{excel_row},2))",
            formula_cols[0], formula_cols[1], formula_cols[0], formula_cols[1]
        );
        let measured_accumulated = format!(
            "=IF(OR(LEN({}{excel_row})=0,LEN({}{excel_row})=0),\"\",ROUND({}{excel_row}*{}{excel_row},2))",
            formula_cols[0], formula_cols[2], formula_cols[0], formula_cols[2]
        );
        let formulas = [
            monthly_depreciation,
            format!(
                "=IFERROR(IF({unusable},0,MAX(0,IF({period_end}<{current_start},0,{months_current}))),0)"
            ),
            format!(
                "=IFERROR(IF({unusable},0,MAX(0,IF({period_end}<{dep_start},0,{months_accumulated}))),0)"
            ),
            // ROUND to fen: the monthly figure is already rounded, but months
            // multiply the residual float error up into visible long decimals.
            measured_current,
            measured_accumulated,
            format!("={current}{excel_row}"),
            format!(
                "={}{excel_row}-{}{excel_row}",
                formula_cols[5], formula_cols[3]
            ),
            format!(
                "={accumulated_comparison}{excel_row}-{}{excel_row}",
                formula_cols[4]
            ),
        ];
        for (offset, formula) in formulas.iter().enumerate() {
            if MONEY_OFFSETS.contains(&offset) {
                ws.write_formula_with_format(
                    r as u32 + 2,
                    (start + offset) as u16,
                    formula.as_str(),
                    &money_format,
                )
                .map_err(xlsx_error)?;
            } else {
                ws.write_formula(r as u32 + 2, (start + offset) as u16, formula.as_str())
                    .map_err(xlsx_error)?;
            }
        }
    }
    if formula_rows < row_count {
        // Parked one column past the block, not in 月折旧额: that column has to
        // stay purely numeric so the reviewer can compute over it.
        ws.write_string(
            formula_rows as u32 + 2,
            (start + output.len()) as u16,
            format!(
                "【导出提速】{sheet_name} 共 {row_count} 行，超过 {DEPRECIATION_FORMULA_ROW_LIMIT} 行，折旧测算公式仅写入前 {formula_rows} 行；如需全量计算，请在 Excel 中选中上方公式向下填充。"
            ),
        )
        .map_err(xlsx_error)?;
    }
    Ok(())
}
fn mapped_header(params: &Value, side: u8, role: &str) -> Option<String> {
    let key = if side == 1 {
        "beginMapping"
    } else {
        "endMapping"
    };
    params
        .get(key)
        .and_then(Value::as_object)
        .and_then(|m| m.get(role))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            let key = match (role, side) {
                ("originalValue", 1) => "beginOriginalValue",
                ("originalValue", 2) => "endOriginalValue",
                ("depreciation", 1) => "beginDepreciation",
                ("depreciation", 2) => "endDepreciation",
                _ => return None,
            };
            params.get(key).and_then(Value::as_str).map(str::to_owned)
        })
}
fn mapped_text(
    result: &MergeResult,
    row: &JoinedRow,
    params: &Value,
    side: u8,
    role: &str,
) -> String {
    let Some(header) = mapped_header(params, side, role) else {
        return String::new();
    };
    let (table, data) = if side == 1 {
        (&result.begin, row.begin.as_ref())
    } else {
        (&result.end, row.end.as_ref())
    };
    let Some(index) = table.headers.iter().position(|h| h == &header) else {
        return String::new();
    };
    data.map(|r| cell(r, index).to_owned()).unwrap_or_default()
}
fn mapped_number(
    result: &MergeResult,
    row: &JoinedRow,
    params: &Value,
    side: u8,
    role: &str,
) -> f64 {
    number(&mapped_text(result, row, params, side, role))
}
/// Round to fen for sheets that only ever hold money.  Summing 15k floats
/// leaves noise like 3015186049.229984 and residual rows of 1.1e-05, which read
/// as real (if tiny) balances on an audit schedule.
fn round_money(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub(crate) fn display_number(value: f64) -> String {
    if value.abs() < f64::EPSILON {
        "0".into()
    } else if value.fract().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.6}").trim_end_matches('0').to_owned()
    }
}

fn display_precise_number(value: f64) -> String {
    if value.abs() < f64::EPSILON {
        "0".into()
    } else {
        value.to_string()
    }
}
fn extra_text(row: &JoinedRow, key: &str) -> Option<String> {
    match row.extra.get(key) {
        Some(Cell::Text(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}
fn extra_number(row: &JoinedRow, key: &str) -> Option<f64> {
    match row.extra.get(key) {
        Some(Cell::Number(value)) => Some(*value),
        _ => None,
    }
}
fn nonempty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}
fn merged_field_source(header: &str) -> &'static str {
    if header.contains("新增") && header.contains("辅助_") {
        "取自新增补充清单"
    } else if header.contains("处置") && header.contains("辅助_") {
        "取自处置补充清单"
    } else if header.contains("辅助_") {
        "取自补充清单"
    } else if header.ends_with("_文件2") || header.ends_with("期末") {
        "取自期末卡片"
    } else if header.ends_with("_文件1") || header.ends_with("期初") {
        "取自期初卡片"
    } else if header.contains("数据来源") || header.contains("匹配") || header.contains("类型")
    {
        "逻辑判断"
    } else {
        "计算"
    }
}

/// Verbatim from the legacy exporter's `_sheet_explanation` table — the wording
/// is what reviewers read on every sheet, so it is copied rather than rephrased.
fn sheet_explanation(name: &str) -> (&'static str, &'static str, &'static str) {
    match name {
        "合并数据" => (
            "把期初卡片与期末卡片按映射字段和匹配键合并，保留两侧原始字段并生成差异判断。",
            "file1 映射字段为期初卡片，file2 映射字段为期末卡片；差异列由工具逻辑生成。",
            "关注匹配列、仅存在某一侧、原值变动、累计折旧变动及其变动类型。",
        ),
        "数据透视表" => (
            "按资产类别汇总期初与期末原值、累计折旧。",
            "根据合并数据中的期初卡片和期末卡片字段聚合。",
            "关注类别映射是否一致，以及期初/期末金额是否能与明细相互勾稽。",
        ),
        "固定资产变动汇总表" => (
            "按资产类别展示原值、累计折旧和净值的期初、增加、减少、重分类及期末情况。",
            "根据期初卡片、期末卡片、新增清单和处置清单聚合计算；类别来源按期初/期末映射字段判定。",
            "关注大额增加、减少、重分类，以及合计/小计/total 噪音类别是否已剔除。",
        ),
        "FA List" => (
            "以期末卡片为基础形成固定资产明细，并附带折旧测算字段。",
            "基础字段取自期末卡片，测算和差异字段由计算。",
            "关注折旧差异、疑似费用化或基础字段缺失。",
        ),
        "≤12月卡片明细" => (
            "筛选使用寿命≤12个月的期末固定资产卡片明细。",
            "取自期末卡片。",
            "关注使用寿命、入账日期、原值和折旧字段是否完整准确。",
        ),
        "新增清单_BKD" => (
            "列示本期新增固定资产，辅助核对新增金额、入账日期和新增方式。",
            "根据期末卡片和期初卡片差异逻辑生成，部分字段需人工补充或来自映射字段。",
            "关注新增日期是否属于本期、增加类型是否合理、是否存在汇总行干扰。",
        ),
        "处置清单_BKD" => (
            "列示本期减少或处置固定资产，辅助核对处置金额、折旧和处置方式。",
            "根据期初卡片和期末卡片差异逻辑生成，处置信息优先来自映射字段。",
            "关注减少类型、处置方式、处置时间和处置金额是否完整一致。",
        ),
        "折旧期间" => (
            "按类别、寿命和残值率比较期初与期末折旧参数，测算当年折旧影响。",
            "根据期初卡片和期末卡片字段聚合，并由工具计算影响金额。",
            "关注判断结果为不一致、待确认或影响金额较大的项目。",
        ),
        "折旧政策对比" => (
            "按类别、寿命和残值率比较期初与期末折旧政策，测算当年折旧影响。",
            "根据期初卡片和期末卡片字段聚合，并由工具计算影响金额。",
            "关注判断结果为不一致、待确认或影响金额较大的项目，并与税法最低折旧年限参考页对照。",
        ),
        "折旧测算" => (
            "以期末固定资产清单为基础生成折旧测算表，逐卡重算月折旧额与累计折旧。",
            "基础字段取自上传的期末清单；测算与差异字段由 Excel 公式实时计算。",
            "关注入账开始日期与使用寿命的完整性，以及测算折旧与账面折旧的差异。",
        ),
        // 税法最低折旧年限参考：说明文字由 fa_subtools::write_tax_reference_sheet
        // 内联维护（含官方原文链接提示），不再经过本函数。
        "LLM分析" => (
            "将套表中的关键变动和异常以文字方式汇总。",
            "变动金额、笔数和示例由工具根据套表结果计算；LLM 仅用于辅助表述，需结合底稿和原始卡片复核。",
            "关注总体变动、大额明细示例、异常新增、疑似费用化和人工复核提示。",
        ),
        "异常清单" => (
            "保留从固定资产变动汇总表计算口径中剔除的异常明细。",
            "来自合并数据中期末原值有金额但数据来源为空的记录。",
            "复核匹配键、资产次级编号、日期格式及补行来源，确认是否应归入新增或其他变动。",
        ),
        _ => (
            "原始套表页。",
            "根据固定资产卡片和工具逻辑生成。",
            "结合字段来源行和底部说明复核。",
        ),
    }
}

/// Sheet order as the legacy exporter emitted it.  Business sheets are written
/// in this order so the workbook opens the way reviewers are used to; 汇总备查
/// is Rust-only and trails the legacy set.
const SHEET_ORDER: [&str; 11] = [
    "01_套表地图",
    "合并数据",
    "数据透视表",
    "固定资产变动汇总表",
    "FA List",
    "≤12月卡片明细",
    "新增清单_BKD",
    "处置清单_BKD",
    "折旧期间",
    "LLM分析",
    "异常清单",
];

fn write_guide_sheets(wb: &mut Workbook, params: &Value) -> Result<(), AppError> {
    let header = Format::new()
        .set_bold()
        .set_background_color(LEGACY_HEADER_FILL)
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    let mut sheets = SHEET_ORDER
        .iter()
        .filter(|name| !matches!(**name, "01_套表地图" | "LLM分析"))
        .copied()
        .collect::<Vec<_>>();
    if fa_llm_enabled(params) {
        // Keep the map listing in the same order the sheets appear in.
        let at = sheets
            .iter()
            .position(|n| *n == "异常清单")
            .unwrap_or(sheets.len());
        sheets.insert(at, "LLM分析");
    }
    let ws = wb.add_worksheet();
    ws.set_name("01_套表地图").map_err(xlsx_error)?;
    for (c, h) in ["页签", "本表作用", "信息来源"].iter().enumerate() {
        ws.write_string_with_format(0, c as u16, *h, &header)
            .map_err(xlsx_error)?;
    }
    for (r, name) in sheets.iter().enumerate() {
        let info = sheet_explanation(name);
        ws.write_string((r + 1) as u32, 0, *name)
            .map_err(xlsx_error)?;
        ws.write_string((r + 1) as u32, 1, info.0)
            .map_err(xlsx_error)?;
        ws.write_string((r + 1) as u32, 2, info.1)
            .map_err(xlsx_error)?;
    }
    // Legacy widths/heights for the map sheet.
    for (c, width) in [(0u16, 24.0), (1, 52.0), (2, 64.0)] {
        ws.set_column_width(c, width).map_err(xlsx_error)?;
    }
    ws.set_row_height(0, 24).map_err(xlsx_error)?;
    for r in 1..=sheets.len() as u32 {
        ws.set_row_height(r, 42).map_err(xlsx_error)?;
    }
    ws.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    Ok(())
}

fn fa_llm_enabled(params: &Value) -> bool {
    params
        .get("__settings")
        .and_then(|v| v.get("llm"))
        .or_else(|| params.get("__llmOptions"))
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn money(value: f64) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let cents = format!("{:.2}", value.abs());
    let (int_part, frac) = cents.split_once('.').unwrap_or((cents.as_str(), "00"));
    let mut grouped = String::new();
    for (i, ch) in int_part.chars().enumerate() {
        if i > 0 && (int_part.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{sign}{grouped}.{frac}")
}

/// One card, reduced to what the analysis page needs to describe it.
struct AnalysisItem {
    category: String,
    id: String,
    name: String,
    amount: f64,
    date: String,
}

impl AnalysisItem {
    fn describe(&self) -> String {
        let category = if self.category.trim().is_empty() {
            "未分类"
        } else {
            self.category.trim()
        };
        format!(
            "{category}：{}（{}）{}元",
            self.name.trim(),
            self.id.trim(),
            money(self.amount)
        )
    }
}

fn join_examples(items: &[AnalysisItem], limit: usize) -> String {
    items
        .iter()
        .take(limit)
        .map(AnalysisItem::describe)
        .collect::<Vec<_>>()
        .join("；")
}

/// Names that normally signal repair/maintenance spend rather than a
/// capitalisable asset.  Kept deliberately narrow — this only flags rows for
/// human review, it never changes a number.
const EXPENSE_LIKE_TERMS: [&str; 20] = [
    "办公用品",
    "耗材",
    "硒鼓",
    "墨盒",
    "键盘",
    "鼠标",
    "U盘",
    "移动硬盘",
    "配件",
    "维修",
    "维护",
    "低值",
    "低耗",
    "工装",
    "电话卡",
    "礼品",
    "清洁",
    "安装费",
    "服务费",
    "软件许可",
];

/// The old exporter computed these facts with pandas and used the LLM only to
/// phrase them, so the sheet stayed useful when the model was unreachable.
/// Rust previously shipped the phrasing without ever computing the facts,
/// which left every section as a generic instruction.
fn build_analysis_facts(result: &MergeResult, params: &Value) -> [(&'static str, String); 4] {
    let bs_year = params
        .get("balanceSheetDate")
        .or_else(|| params.get("balance_sheet_date"))
        .and_then(Value::as_str)
        .and_then(parse_fa_date)
        .map(|d| d.year());

    let (mut begin_original, mut end_original) = (0.0, 0.0);
    let (mut begin_dep, mut end_dep) = (0.0, 0.0);
    let mut additions: Vec<AnalysisItem> = Vec::new();
    let mut disposals: Vec<AnalysisItem> = Vec::new();
    let mut off_period: Vec<AnalysisItem> = Vec::new();
    let mut expense_like: Vec<AnalysisItem> = Vec::new();

    for row in result
        .rows
        .iter()
        .filter(|row| row_summary_noise_marker(row).is_none())
    {
        let begin_value = mapped_number(result, row, params, 1, "originalValue");
        let end_value = mapped_number(result, row, params, 2, "originalValue");
        begin_original += begin_value;
        end_original += end_value;
        begin_dep += mapped_number(result, row, params, 1, "depreciation").abs();
        end_dep += mapped_number(result, row, params, 2, "depreciation").abs();

        let side = if row.end.is_some() { 2 } else { 1 };
        let item = |amount: f64| AnalysisItem {
            category: mapped_text(result, row, params, side, "category"),
            id: primary_key_segment(&row.match_value),
            name: mapped_text(result, row, params, side, "name"),
            amount,
            date: display_date(&mapped_text(result, row, params, side, "startDate")),
        };
        let change = end_value - begin_value;
        // Legacy screens the complete closing FA List for expense-like names,
        // not only cards added in the current period.
        if row.end.is_some()
            && EXPENSE_LIKE_TERMS
                .iter()
                .any(|term| item(0.0).name.contains(term))
        {
            expense_like.push(item(end_value));
        }
        if change > 0.005 {
            let entry = item(change);
            if let (Some(year), Some(started)) = (bs_year, parse_fa_date(&entry.date)) {
                if started.year() != year {
                    off_period.push(item(change));
                }
            }
            additions.push(entry);
        } else if change < -0.005 {
            disposals.push(item(-change));
        }
    }

    let by_amount = |a: &AnalysisItem, b: &AnalysisItem| {
        b.amount
            .partial_cmp(&a.amount)
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    additions.sort_by(by_amount);
    disposals.sort_by(by_amount);
    off_period.sort_by(by_amount);
    // Legacy candidate extraction is FA List order + head(8), not a ranking by
    // amount.  This both fixes the reported count and keeps examples traceable
    // to the displayed schedule.
    expense_like.truncate(8);

    let overview = format!(
        "原值由期初 {} 元变为期末 {} 元，净变动 {} 元；\
         其中本期增加 {} 项合计 {} 元，本期减少 {} 项合计 {} 元。\
         累计折旧由 {} 元变为 {} 元，净值由 {} 元变为 {} 元。",
        money(begin_original),
        money(end_original),
        money(end_original - begin_original),
        additions.len(),
        money(additions.iter().map(|i| i.amount).sum::<f64>()),
        disposals.len(),
        money(disposals.iter().map(|i| i.amount).sum::<f64>()),
        money(begin_dep),
        money(end_dep),
        money(begin_original - begin_dep),
        money(end_original - end_dep),
    );

    let large = if additions.is_empty() && disposals.is_empty() {
        "本期未发现原值增减变动。".to_owned()
    } else {
        let mut parts = Vec::new();
        if !additions.is_empty() {
            parts.push(format!("增加金额前列：{}。", join_examples(&additions, 5)));
        }
        if !disposals.is_empty() {
            parts.push(format!("减少金额前列：{}。", join_examples(&disposals, 5)));
        }
        parts.join(" ")
    };

    let date_note = match bs_year {
        None => "未提供资产负债表日，无法判断新增日期是否属于当期，请手工复核。".to_owned(),
        Some(year) if off_period.is_empty() => {
            format!("本期新增资产的入账日期均落在 {year} 年度，未发现跨期新增。")
        }
        Some(year) => format!(
            "发现 {} 项新增资产的入账日期不属于 {year} 年度，合计 {} 元，示例：{}。请复核是否应计入本期。",
            off_period.len(),
            money(off_period.iter().map(|i| i.amount).sum::<f64>()),
            join_examples(&off_period, 8)
        ),
    };

    let expense_note = if expense_like.is_empty() {
        "未发现资产名称含维修、更换、配件等费用化特征的新增项目。".to_owned()
    } else {
        format!(
            "发现 {} 项资产名称含办公用品、耗材、配件、维修、低值、工装等疑似费用化关键词，合计 {} 元，示例：{}。请结合金额与使用寿命判断是否满足资本化条件。",
            expense_like.len(),
            money(expense_like.iter().map(|i| i.amount).sum::<f64>()),
            join_examples(&expense_like, 8)
        )
    };

    [
        ("总体概述", overview),
        ("大额变动示例", large),
        ("新增日期异常", date_note),
        ("疑似费用化", expense_note),
    ]
}

fn write_llm_analysis(
    wb: &mut Workbook,
    result: &MergeResult,
    params: &Value,
) -> Result<(), AppError> {
    let title = params
        .get("__llmAnalysisMock")
        .and_then(|v| v.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("固定资产套表分析辅助说明");
    let title_fmt = Format::new()
        .set_bold()
        .set_font_size(14.0)
        .set_font_color("#205860")
        .set_align(FormatAlign::Left);
    let heading = Format::new()
        .set_bold()
        .set_font_color("#205860")
        .set_background_color("#E6DDCF")
        .set_align(FormatAlign::Left);
    let wrap = Format::new().set_text_wrap();
    let note_header = Format::new()
        .set_bold()
        .set_background_color(LEGACY_HEADER_FILL)
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    let note_format = Format::new()
        .set_background_color("#F6F6F6")
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    let ws = wb.add_worksheet();
    ws.set_name("LLM分析").map_err(xlsx_error)?;
    ws.write_string_with_format(0, 0, title, &title_fmt)
        .map_err(xlsx_error)?;
    // Keep the source contract visible on row 2 just like every other
    // business sheet.  The figures and examples are deterministic Rust
    // calculations; an LLM may help phrase them but is not their data source.
    ws.write_string(1, 0, "工具计算/LLM辅助")
        .map_err(xlsx_error)?;
    let sections = build_analysis_facts(result, params);
    let mut row = 2;
    for (name, content) in sections {
        ws.write_string_with_format(row, 0, name, &heading)
            .map_err(xlsx_error)?;
        row += 1;
        ws.write_string_with_format(row, 0, name, &wrap)
            .map_err(xlsx_error)?;
        ws.write_string_with_format(row, 1, &content, &wrap)
            .map_err(xlsx_error)?;
        row += 2;
    }
    ws.write_string_with_format(row, 0, "人工复核提示", &heading)
        .map_err(xlsx_error)?;
    ws.write_string_with_format(
        row + 1,
        1,
        "LLM 输出为辅助说明，需结合原始数据人工复核。",
        &wrap,
    )
    .map_err(xlsx_error)?;
    let note_row = row + 3;
    let info = sheet_explanation("LLM分析");
    let note = format!("{} 信息来源：{} 重点关注：{}", info.0, info.1, info.2);
    ws.write_string_with_format(note_row, 0, "本表说明", &note_header)
        .map_err(xlsx_error)?;
    ws.merge_range(note_row, 1, note_row, 3, &note, &note_format)
        .map_err(xlsx_error)?;
    ws.set_row_height(note_row - 1, 8).map_err(xlsx_error)?;
    ws.set_row_height(note_row, 72).map_err(xlsx_error)?;
    ws.set_column_width(0, 24).map_err(xlsx_error)?;
    ws.set_column_width(1, 64).map_err(xlsx_error)?;
    ws.set_column_width(2, 18).map_err(xlsx_error)?;
    ws.set_column_width(3, 18).map_err(xlsx_error)?;
    Ok(())
}

fn write_sheet_map(wb: &mut Workbook) -> Result<(), AppError> {
    let names = wb
        .worksheets()
        .iter()
        .map(|ws| ws.name().to_owned())
        .collect::<Vec<_>>();
    let ws = wb.add_worksheet();
    ws.set_name("01_套表地图").map_err(xlsx_error)?;
    ws.write_string(0, 0, "序号").map_err(xlsx_error)?;
    ws.write_string(0, 1, "工作表").map_err(xlsx_error)?;
    for (i, name) in names.iter().enumerate() {
        ws.write_number((i + 1) as u32, 0, (i + 1) as f64)
            .map_err(xlsx_error)?;
        ws.write_string((i + 1) as u32, 1, name)
            .map_err(xlsx_error)?;
    }
    ws.autofit();
    Ok(())
}
fn write_unmatched(path: &Path, result: &MergeResult, cancel: &AtomicBool) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut wb = Workbook::new();
    let header = Format::new()
        .set_bold()
        .set_background_color(LEGACY_HEADER_FILL)
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    let guide = wb.add_worksheet();
    guide.set_name("说明").map_err(xlsx_error)?;
    guide
        .write_string_with_format(0, 0, "页签", &header)
        .map_err(xlsx_error)?;
    guide
        .write_string_with_format(0, 1, "用途", &header)
        .map_err(xlsx_error)?;
    guide
        .write_string(1, 0, "未匹配新增清单")
        .map_err(xlsx_error)?;
    guide
        .write_string(1, 1, "补充清单中未能匹配期末卡片的新增记录，请复核组合键。")
        .map_err(xlsx_error)?;
    guide
        .write_string(2, 0, "未匹配处置清单")
        .map_err(xlsx_error)?;
    guide
        .write_string(2, 1, "补充清单中未能匹配期初卡片的处置记录，请复核组合键。")
        .map_err(xlsx_error)?;
    guide.autofit();
    for (name, headers, rows) in [
        (
            "未匹配新增清单",
            &result.end.headers,
            &result.unmatched_addition,
        ),
        (
            "未匹配处置清单",
            &result.begin.headers,
            &result.unmatched_disposal,
        ),
    ] {
        let ws = wb.add_worksheet();
        ws.set_name(name).map_err(xlsx_error)?;
        for (c, h) in headers.iter().enumerate() {
            ws.write_string_with_format(0, c as u16, h, &header)
                .map_err(xlsx_error)?;
        }
        for (r, row) in rows.iter().enumerate() {
            if r % 256 == 0 {
                check_cancel(cancel)?;
            }
            for (c, v) in row.iter().enumerate() {
                ws.write_string((r + 1) as u32, c as u16, v)
                    .map_err(xlsx_error)?;
            }
        }
        ws.autofit();
    }
    let partial = path.with_extension("xlsx.partial");
    wb.save(&partial).map_err(xlsx_error)?;
    check_cancel(cancel)?;
    replace_output(&partial, path)
}

pub(crate) fn replace_output(partial: &Path, output: &Path) -> Result<(), AppError> {
    if !output.exists() {
        return fs::rename(partial, output).map_err(io_error);
    }
    let backup = output.with_extension("xlsx.previous");
    if backup.exists() {
        fs::remove_file(&backup).map_err(io_error)?;
    }
    fs::rename(output, &backup).map_err(io_error)?;
    match fs::rename(partial, output) {
        Ok(()) => {
            fs::remove_file(backup).map_err(io_error)?;
            Ok(())
        }
        Err(cause) => {
            let rollback = fs::rename(&backup, output);
            Err(error(
                "FA_EXPORT_FAILED",
                "FA List 输出文件替换失败，已尝试恢复原文件。",
                Some(format!("replace={cause}; rollback={rollback:?}")),
            ))
        }
    }
}
fn write_json_cell(
    ws: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    value: Option<&Value>,
) -> Result<(), AppError> {
    match value {
        Some(Value::Number(v)) => ws
            .write_number(row, col, v.as_f64().unwrap_or_default())
            .map(|_| ())
            .map_err(xlsx_error),
        Some(Value::String(v)) => ws.write_string(row, col, v).map(|_| ()).map_err(xlsx_error),
        Some(v) => ws
            .write_string(row, col, v.to_string())
            .map(|_| ())
            .map_err(xlsx_error),
        None => Ok(()),
    }
}

fn output_path(params: &Value, end: &Path) -> Result<PathBuf, AppError> {
    if let Some(value) = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
    {
        let mut p = PathBuf::from(value);
        if p.extension().is_none() {
            p.set_extension("xlsx");
        }
        Ok(p)
    } else {
        Ok(end.parent().unwrap_or(Path::new(".")).join(format!(
            "FA_List_{}.xlsx",
            Local::now().format("%Y%m%d_%H%M%S")
        )))
    }
}
pub(crate) fn required_path(params: &Value, name: &str) -> Result<PathBuf, AppError> {
    let value = params
        .get(name)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| error("INVALID_PARAMS", format!("缺少参数：{name}"), None))?;
    let path = PathBuf::from(value);
    if !path.is_file() {
        Err(error(
            "FILE_NOT_FOUND",
            "选择的文件不存在。",
            Some(path.to_string_lossy().into_owned()),
        ))
    } else {
        Ok(path)
    }
}
pub(crate) fn optional_header(params: &Value, name: &str) -> Result<Option<usize>, AppError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) if v.trim().is_empty() || v == "auto" || v == "自动" => Ok(None),
        Some(v) => {
            let n = v
                .as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| {
                    error(
                        "FA_HEADER_INVALID",
                        "标题行必须是大于等于 1 的整数，或留空自动识别。",
                        None,
                    )
                })? as usize;
            if n == 0 {
                Err(error(
                    "FA_HEADER_INVALID",
                    "标题行必须是大于等于 1 的整数，或留空自动识别。",
                    None,
                ))
            } else {
                Ok(Some(n))
            }
        }
    }
}
fn required_strings(
    params: &Value,
    name: &str,
    code: &str,
    message: &str,
) -> Result<Vec<String>, AppError> {
    let values = strings(params.get(name));
    if values.is_empty() {
        Err(error(code, message, None))
    } else {
        Ok(values)
    }
}
pub(crate) fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn index_opt(table: &Table, value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_str)
        .and_then(|v| table.headers.iter().position(|h| h == v))
}
pub(crate) fn cell(row: &[String], index: usize) -> &str {
    row.get(index).map(String::as_str).unwrap_or("")
}
pub(crate) fn number(v: &str) -> f64 {
    v.trim()
        .trim_end_matches('%')
        .replace(',', "")
        .parse::<f64>()
        .unwrap_or(0.0)
}
fn push_unique(values: &mut Vec<String>, value: &str) {
    let v = value.trim();
    if !v.is_empty() && !values.iter().any(|x| x == v) {
        values.push(v.into());
    }
}
fn json_cell(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}
pub(crate) fn normalize_header(v: &str) -> String {
    v.chars()
        .filter(|c| !c.is_whitespace() && !"_-()/（）[]【】".contains(*c))
        .flat_map(char::to_lowercase)
        .collect()
}
pub(crate) fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}
fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}
pub(crate) fn io_error(e: std::io::Error) -> AppError {
    if e.raw_os_error() == Some(32) {
        return AppError::new(
            "FA_OUTPUT_IN_USE",
            "输出文件正在被 Excel 或其他程序占用。请关闭该文件后重试，或另存为新文件。",
            true,
            Some(e.to_string()),
        );
    }
    error(
        "FA_IO_FAILED",
        "FA List 文件读写失败。",
        Some(e.to_string()),
    )
}
fn csv_error(e: csv::Error) -> AppError {
    error(
        "FA_EXPORT_FAILED",
        "FA List CSV 导出失败。",
        Some(e.to_string()),
    )
}
fn xlsx_error(e: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "FA_EXPORT_FAILED",
        "FA List 工作簿导出失败。",
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xlsx_entry(path: &Path, entry: &str) -> String {
        use std::io::Read;
        let file = fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut text = String::new();
        archive
            .by_name(entry)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    fn cell_style<'a>(styles: &'a str, sheet: &str, reference: &str) -> &'a str {
        let cell = sheet
            .split(&format!("<c r=\"{reference}\""))
            .nth(1)
            .unwrap_or_else(|| panic!("missing cell {reference}"));
        let style_id = cell
            .split("s=\"")
            .nth(1)
            .and_then(|value| value.split('"').next())
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or_else(|| panic!("missing style for {reference}"));
        let cell_xfs = styles
            .split("<cellXfs")
            .nth(1)
            .and_then(|value| value.split("</cellXfs>").next())
            .expect("missing cellXfs");
        cell_xfs
            .split("<xf")
            .skip(1)
            .nth(style_id)
            .unwrap_or_else(|| panic!("missing xf {style_id}"))
    }

    #[test]
    fn sharing_violation_explains_that_the_output_is_in_use() {
        let err = io_error(std::io::Error::from_raw_os_error(32));
        assert_eq!(err.code, "FA_OUTPUT_IN_USE");
        assert!(err.user_message.contains("占用"));
        assert!(err.retryable);
    }

    fn in_memory_table(headers: &[&str], rows: &[&[&str]]) -> Table {
        Table {
            path: PathBuf::from("fixture.csv"),
            sheet: None,
            sheets: Vec::new(),
            header_row: 1,
            headers: headers.iter().map(|value| (*value).to_owned()).collect(),
            rows: rows
                .iter()
                .map(|row| row.iter().map(|value| (*value).to_owned()).collect())
                .collect(),
        }
    }

    #[test]
    fn supplement_keys_are_proved_by_three_exact_samples_in_reference_key_order() {
        let reference = in_memory_table(
            &["资产编码", "资产名称", "类别"],
            &[
                &["001", "设备甲", "机器"],
                &["002", "设备乙", "办公"],
                &["003", "设备丙", "电子"],
                &["004", "设备丁", "运输"],
            ],
        );
        // Deliberately misleading headers: the proof must come from values and
        // the returned columns must follow the primary ledger's composite-key
        // order rather than supplement column order.
        let supplement = in_memory_table(
            &["名称备注", "数据列", "资产编码", "金额"],
            &[
                &["设备甲", "001.0", "X", "10"],
                &["设备乙", "002", "Y", "20"],
                &["设备丙", "003", "Z", "30"],
            ],
        );
        assert_eq!(
            infer_supplement_keys_by_samples(
                &supplement,
                &reference,
                &["资产编码".into(), "资产名称".into()]
            ),
            ["数据列", "名称备注"]
        );
    }

    #[test]
    fn supplement_key_inference_returns_no_partial_composite_key() {
        let reference = in_memory_table(
            &["编码", "名称"],
            &[&["A1", "甲"], &["A2", "乙"], &["A3", "丙"]],
        );
        let supplement = in_memory_table(
            &["代码", "错误名称"],
            &[&["A1", "甲"], &["A2", "乙"], &["A3", "不存在"]],
        );
        assert!(
            infer_supplement_keys_by_samples(
                &supplement,
                &reference,
                &["编码".into(), "名称".into()]
            )
            .is_empty()
        );
    }

    #[test]
    fn source_row_describes_calculated_and_supplemental_columns_truthfully() {
        assert_eq!(field_source_for_header("FA List", "净值", 9, None), "计算");
        assert_eq!(
            field_source_for_header("FA List", "已提足折旧", 10, None),
            "逻辑判断"
        );
        assert_eq!(
            field_source_for_header("FA List", "提足折旧时间", 11, None),
            "计算"
        );
        assert_eq!(
            field_source_for_header("新增清单_BKD", "原值增加", 7, None),
            "计算"
        );
        assert_eq!(
            field_source_for_header("新增清单_BKD", "新增方式", 8, None),
            "取自新增补充清单"
        );
        assert_eq!(
            field_source_for_header("处置清单_BKD", "年初累计折旧", 7, None),
            "计算"
        );
        assert_eq!(
            field_source_for_header("处置清单_BKD", "处置折旧", 14, None),
            "补充清单/缺失时引用年初累计折旧"
        );
        assert_eq!(
            merged_field_source("处置时间_辅助_文件1"),
            "取自处置补充清单"
        );
        assert_eq!(
            merged_field_source("新增时间_辅助_期末"),
            "取自新增补充清单"
        );
        assert_eq!(merged_field_source("原值_期初"), "取自期初卡片");
        assert_eq!(merged_field_source("原值_期末"), "取自期末卡片");
        assert_eq!(
            field_source_for_header("数据透视表", "数据来源", 1, Some("期末文件")),
            "逻辑判断"
        );
    }

    /// 用本机真实配置打一次 FA 映射复核。
    ///
    /// 默认跳过：需要联网和本机凭据。存在的理由是——迁移时漏发
    /// `thinking` 与 `response_format` 两个参数，导致推理型模型先跑思维链再吐
    /// JSON，请求必然超时；这类问题在离线测试里永远暴露不出来。
    /// 密钥由 keyring 在请求内部读取，不经过测试代码。
    ///
    /// 跑法：cargo test --manifest-path src-tauri/Cargo.toml live_fa_review -- --ignored --nocapture
    #[test]
    #[ignore = "requires the machine's configured LLM endpoint, credentials and network"]
    fn live_fa_review_completes_within_configured_timeout() {
        let dirs = directories::ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
            .expect("data directory");
        let db = dirs.data_local_dir().join("audit-toolbox.db");
        let connection = rusqlite::Connection::open(&db).expect("open settings database");
        let stored: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE key='llm'",
                [],
                |row| row.get(0),
            )
            .expect("本机尚未保存 LLM 配置");
        let llm: Value = serde_json::from_str(&stored).expect("settings json");
        assert_eq!(llm["enabled"], true, "本机 LLM 未启用，无法验收");

        // 与用户实际数据同规模：期初 11 列、期末 29 列，每列 5 个样例值。
        let dir = std::env::temp_dir().join("fa-live-review");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, columns: usize| {
            let headers = (0..columns)
                .map(|i| match i {
                    0 => "资产类别".to_owned(),
                    1 => "卡片编号".to_owned(),
                    2 => "资产名称".to_owned(),
                    3 => "原值".to_owned(),
                    4 => "累计折旧".to_owned(),
                    5 => "开始使用日期".to_owned(),
                    6 => "使用寿命".to_owned(),
                    7 => "残值率".to_owned(),
                    other => format!("其他字段{other}"),
                })
                .collect::<Vec<_>>()
                .join(",");
            let rows = (0..6)
                .map(|r| {
                    (0..columns)
                        .map(|i| match i {
                            0 => "房屋及建筑物".to_owned(),
                            1 => format!("110000{r}"),
                            2 => format!("实验室改造工程{r}"),
                            3 => "1000000".to_owned(),
                            4 => "200000".to_owned(),
                            5 => "2024-01-01".to_owned(),
                            6 => "240".to_owned(),
                            7 => "0.05".to_owned(),
                            _ => format!("值{r}"),
                        })
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .collect::<Vec<_>>()
                .join("\n");
            let path = dir.join(name);
            fs::write(&path, format!("{headers}\n{rows}\n")).unwrap();
            path
        };
        let begin = write("期初.csv", 11);
        let end = write("期末.csv", 29);
        let mapping = json!({
            "category":"资产类别","name":"资产名称","originalValue":"原值",
            "depreciation":"累计折旧","startDate":"开始使用日期","life":"使用寿命",
            "residualRate":"残值率"
        });
        let params = json!({
            "beginPath": begin.to_string_lossy(),
            "endPath": end.to_string_lossy(),
            "beginKeys": ["卡片编号"],
            "endKeys": ["卡片编号"],
            "beginMapping": mapping,
            "endMapping": mapping,
            "__settings": {"llm": llm},
        });

        let started = std::time::Instant::now();
        let result = call("fa.review", params);
        let elapsed = started.elapsed();
        let _ = fs::remove_dir_all(&dir);
        let value = result.unwrap_or_else(|e| {
            panic!(
                "FA 映射复核失败（耗时 {:.1} 秒）：{} / {}",
                elapsed.as_secs_f64(),
                e.user_message,
                e.detail.unwrap_or_default()
            )
        });
        println!(
            "FA 映射复核成功，耗时 {:.1} 秒；enabled={} passed={} 自动应用 {} 项，待复核 {} 项",
            elapsed.as_secs_f64(),
            value["enabled"],
            value["passed"],
            value["autoApplied"].as_array().map(Vec::len).unwrap_or(0),
            value["fieldReviews"].as_array().map(Vec::len).unwrap_or(0),
        );
        assert_eq!(value["enabled"], true);
    }

    #[test]
    fn match_key_falls_back_to_legacy_tiers_beyond_the_term_list() {
        let table = |headers: &[&str]| Table {
            path: "t.csv".into(),
            sheet: None,
            sheets: vec![],
            header_row: 1,
            headers: headers.iter().map(|v| (*v).to_owned()).collect(),
            rows: vec![],
        };
        let terms: &[&str] = &["固定资产编号", "卡片编号", "coding"];

        // 词表里没有"资产序号"，但它含资产语境 + 号，旧版给 700 分能选中。
        assert_eq!(
            pick_match_header(&table(&["资产类别", "资产序号", "原值"]), terms).as_deref(),
            Some("资产序号")
        );
        // 单独含"编号"也是候选。
        assert_eq!(
            pick_match_header(&table(&["资产类别", "设备编号"]), terms).as_deref(),
            Some("设备编号")
        );
        // 禁列优先：含"分类/名称/金额"的列永远不能当匹配键，
        // 即使它同时含"编号"。
        assert_eq!(
            pick_match_header(&table(&["资产分类编号", "卡片编号"]), terms).as_deref(),
            Some("卡片编号")
        );
        assert!(pick_match_header(&table(&["资产分类编号"]), terms).is_none());
        // 词表命中仍然压过兜底。
        assert_eq!(
            pick_match_header(&table(&["资产序号", "固定资产编号"]), terms).as_deref(),
            Some("固定资产编号")
        );
    }

    fn test_preview(params: Value) -> Result<Value, AppError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        preview(params, &|_, _, _, _| {}, cancel, &pause)
    }

    fn test_export(params: Value) -> Result<Value, AppError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        export(params, &|_, _, _, _| {}, cancel, &pause)
    }
    use std::sync::atomic::AtomicBool;

    fn params(dir: &Path) -> Value {
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin,"卡片编号,资产类别,资产名称,原值,累计折旧,使用寿命,残值率,入账开始日期,本年折旧\nA1,机器,甲,100,20,60,5%,2020-01-01,10\nA2,电子,乙,50,30,36,5%,2021-01-01,8\n").unwrap();
        fs::write(&end,"卡片编号,资产类别,资产名称,原值,累计折旧,使用寿命,残值,入账开始日期,本年折旧\nA1,机器,甲,100,40,60,5,2020-01-01,20\nA3,运输,丙,80,8,48,4,2025-01-01,8\n").unwrap();
        // 前端真实负载始终带两侧映射（必填角色未映射时不会发起任务），
        // 汇总/纠偏等后段逻辑都按映射取数；夹具与真实口径保持一致。
        json!({"beginPath":begin,"endPath":end,"beginKeys":["卡片编号"],"endKeys":["卡片编号"],
            "beginMapping":{"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率","startDate":"入账开始日期"},
            "endMapping":{"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值","startDate":"入账开始日期"},
            "outputPath":dir.join("FA_List.xlsx")})
    }
    #[test]
    fn inspect_and_merge_contract() {
        let dir = std::env::temp_dir().join(format!("fa-rust-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let p = params(&dir);
        let inspected = inspect(p.clone()).unwrap();
        assert_eq!(inspected["suggestedMapping"]["end"]["residualRate"], "残值");
        assert!(inspected["suggestedMapping"]["begin"]["currentYearDep"].is_null());
        assert!(inspected["suggestedMapping"]["begin"]["additionMethod"].is_null());
        assert!(inspected["suggestedMapping"]["begin"]["additionDate"].is_null());
        assert_eq!(
            inspected["suggestedMapping"]["end"]["currentYearDep"],
            "本年折旧"
        );
        let output = test_preview(p).unwrap();
        assert_eq!(output["stats"]["both"], 1);
        assert_eq!(output["stats"]["beginOnly"], 1);
        assert_eq!(output["stats"]["endOnly"], 1);
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn mapping_recognizes_time_and_residual_header_variants() {
        let dir = std::env::temp_dir().join(format!("fa-header-alias-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(
            &begin,
            "卡片编码,资产名称,入账时间,预计净残值率\nA1,设备,2021-01-01,5%\n",
        )
        .unwrap();
        fs::write(
            &end,
            "卡片编码,资产名称,开始使用日期,预计残值\nA1,设备,2021-01-01,50\n",
        )
        .unwrap();
        let inspected = inspect(json!({"beginPath":begin,"endPath":end})).unwrap();
        assert_eq!(
            inspected["suggestedMapping"]["begin"]["startDate"],
            "入账时间"
        );
        assert_eq!(
            inspected["suggestedMapping"]["begin"]["residualRate"],
            "预计净残值率"
        );
        assert_eq!(
            inspected["suggestedMapping"]["end"]["startDate"],
            "开始使用日期"
        );
        assert_eq!(
            inspected["suggestedMapping"]["end"]["residualRate"],
            "预计残值"
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn disabled_llm_is_explicit_and_non_blocking() {
        let result = llm_review(json!({"__settings":{"llm":{"enabled":false}}}), false).unwrap();
        assert_eq!(result["enabled"], false);
        assert_eq!(result["passed"], true);
        assert!(result["message"].as_str().unwrap().contains("未启用"));
    }
    #[test]
    fn rerun_review_recovers_a_manually_unmapped_start_date() {
        let dir = std::env::temp_dir().join(format!("fa-llm-unmapped-date-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir);
        p["beginMapping"] = json!({
            "category":"资产类别","name":"资产名称","originalValue":"原值",
            "depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率"
        });
        p["endMapping"] = json!({
            "category":"资产类别","name":"资产名称","originalValue":"原值",
            "depreciation":"累计折旧","life":"使用寿命","residualRate":"残值",
            "currentYearDep":"本年折旧"
        });

        let payload = main_llm_payload(&p).unwrap();
        assert!(
            payload["file1"]["unmappedRoles"]
                .as_array()
                .unwrap()
                .contains(&json!("date"))
        );
        assert!(
            payload["file2"]["unmappedRoles"]
                .as_array()
                .unwrap()
                .contains(&json!("date"))
        );
        assert!(
            payload["file1"]["unmappedCandidates"]
                .as_array()
                .unwrap()
                .contains(&json!({"role":"date","column":"入账开始日期"}))
        );

        // Even if the provider overlooks the explicit missing role and returns
        // a no-op, the same deterministic header rule used by initial inspect
        // must restore the high-confidence suggestion on a manual re-review.
        let reviewed = finalize_llm_review(
            json!({
                "suggestions":[],
                "fieldReviews":[],
                "matchReview":{"action":"keep","reasons":[]}
            }),
            payload,
            false,
        );
        let applied = reviewed["autoApplied"].as_array().unwrap();
        assert!(applied.iter().any(|item| {
            item["role"] == "date"
                && item["file_side"] == "file1"
                && item["suggested_column"] == "入账开始日期"
        }));
        assert!(applied.iter().any(|item| {
            item["role"] == "date"
                && item["file_side"] == "file2"
                && item["suggested_column"] == "入账开始日期"
        }));
        assert!(
            reviewed["message"]
                .as_str()
                .unwrap()
                .contains("映射复核完成")
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn llm_contract_auto_applies_high_confidence_and_preserves_match_review() {
        let value = finalize_llm_review(
            json!({"suggestions":[{"role":"current_year_dep","file_side":"file2","suggested_column":"本年折旧","confidence":0.9,"action":"fill","reason":"字段同义"}],"fieldReviews":[],"matchReview":{"status":"ok","confidence":0.9,"action":"keep","reasons":[],"suggested_file1_columns":["卡片编号"],"suggested_file2_columns":["卡片编号"],"suggestion_reason":""}}),
            json!({}),
            false,
        );
        assert_eq!(value["autoApplied"][0]["role"], "current_year_dep");
        assert_eq!(value["matchReview"]["action"], "keep");
    }
    #[test]
    fn llm_drops_file1_only_current_year_and_addition_roles() {
        let value = finalize_llm_review(
            json!({
                "suggestions":[
                    {"role":"current_year_dep","file_side":"file1","suggested_column":"本年折旧","confidence":0.99,"action":"fill"},
                    {"role":"addition_date","file_side":"file1","suggested_column":"资本化日期","confidence":0.99,"action":"fill"},
                    {"role":"addition_method","file_side":"file2","suggested_column":"资产来源","confidence":0.99,"action":"fill"}
                ],
                "fieldReviews":[{
                    "role":"current_year_dep",
                    "suggested_mapping":{"file1":"本年折旧","file2":"本年折旧"},
                    "confidence":0.7,
                    "action":"review"
                }],
                "matchReview":{"action":"keep"}
            }),
            json!({
                "file1":{"headers":["本年折旧","资本化日期"]},
                "file2":{"headers":["本年折旧","资产来源"]}
            }),
            false,
        );
        assert_eq!(value["autoApplied"].as_array().unwrap().len(), 1);
        assert_eq!(value["autoApplied"][0]["file_side"], "file2");
        assert_eq!(
            value["fieldReviews"][0]["suggested_mapping"],
            json!({"file2":"本年折旧"})
        );
    }
    #[test]
    fn llm_string_mapping_is_safely_normalized_instead_of_split_into_characters() {
        let value = finalize_llm_review(
            json!({
                "suggestions":[],
                "fieldReviews":[{
                    "role":"original_value",
                    "suggested_mapping":"file1: 期末原值；file2: 资产原值",
                    "confidence":0.7,
                    "action":"review",
                    "reason":"两侧均为原值"
                }],
                "matchReview":{"action":"keep"}
            }),
            json!({
                "file1":{"headers":["期末原值"]},
                "file2":{"headers":["资产原值"]}
            }),
            false,
        );
        assert_eq!(
            value["fieldReviews"][0]["suggested_mapping"],
            json!({"file1":"期末原值","file2":"资产原值"})
        );
    }
    #[test]
    fn local_category_mismatch_flags_end_side_when_values_do_not_overlap() {
        let begin = in_memory_table(
            &["coding", "固定资产类别", "固定资产名称"],
            &[
                &["B001", "房屋及建筑物", "冷量台土建工程"],
                &["B002", "机器设备", "高速冲床"],
                &["B003", "运输工具", "商务车"],
                &["B004", "电子设备", "服务器"],
            ],
        );
        let end = in_memory_table(
            &["资产编码", "资产分类", "资产类型描述"],
            &[
                &["E001", "C-01", "房屋及建筑物"],
                &["E002", "C-02", "机器设备"],
                &["E003", "C-03", "运输工具"],
                &["E004", "C-04", "电子设备"],
            ],
        );
        let suggestions = local_category_mismatch_suggestions(
            &begin,
            Some(&json!({"category": "固定资产类别"})),
            Some(&json!(["coding"])),
            &end,
            Some(&json!({"category": "资产分类"})),
            Some(&json!(["资产编码"])),
        );
        assert_eq!(suggestions.len(), 1);
        let item = &suggestions[0];
        assert_eq!(item["role"], "category");
        assert_eq!(item["file_side"], "file2");
        assert_eq!(item["suggested_column"], "资产类型描述");
        assert_eq!(item["action"], "review");
        assert!(
            item["reason"]
                .as_str()
                .unwrap()
                .contains("疑似期末类别映射错列")
        );
    }
    #[test]
    fn local_category_mismatch_keeps_quiet_when_categories_overlap() {
        let begin = in_memory_table(
            &["coding", "固定资产类别"],
            &[
                &["B001", "房屋及建筑物"],
                &["B002", "机器设备"],
                &["B003", "运输工具"],
            ],
        );
        let end = in_memory_table(
            &["资产编码", "资产分类"],
            &[
                &["E001", "房屋及建筑物"],
                &["E002", "机器设备"],
                &["E003", "运输工具"],
            ],
        );
        let suggestions = local_category_mismatch_suggestions(
            &begin,
            Some(&json!({"category": "固定资产类别"})),
            None,
            &end,
            Some(&json!({"category": "资产分类"})),
            None,
        );
        assert!(suggestions.is_empty());
    }
    #[test]
    fn local_category_mismatch_requires_enough_distinct_categories() {
        let begin = in_memory_table(
            &["coding", "固定资产类别"],
            &[&["B001", "房屋及建筑物"], &["B002", "机器设备"]],
        );
        let end = in_memory_table(
            &["资产编码", "资产分类"],
            &[&["E001", "C-01"], &["E002", "C-02"]],
        );
        let suggestions = local_category_mismatch_suggestions(
            &begin,
            Some(&json!({"category": "固定资产类别"})),
            None,
            &end,
            Some(&json!({"category": "资产分类"})),
            None,
        );
        assert!(suggestions.is_empty());
    }
    #[test]
    fn finalize_injects_local_suspect_mapping_when_llm_missed_it() {
        let value = finalize_llm_review(
            json!({"suggestions":[],"fieldReviews":[],"matchReview":{"action":"keep"}}),
            json!({
                "file1":{"headers":["固定资产类别"]},
                "file2":{"headers":["资产分类","资产类型描述"]},
                "suspectMappings":[{
                    "role":"category",
                    "file_side":"file2",
                    "suggested_column":"资产类型描述",
                    "confidence":0.9,
                    "action":"review",
                    "reason":"期初与期末当前类别列取值几乎不重叠，疑似期末类别映射错列。"
                }]
            }),
            false,
        );
        let reviews = value["fieldReviews"].as_array().unwrap();
        assert!(reviews.iter().any(|item| {
            item["role"] == "category"
                && item["file_side"] == "file2"
                && item["suggested_column"] == "资产类型描述"
        }));
    }
    #[test]
    fn finalize_does_not_duplicate_suspect_mapping_llm_already_returned() {
        let value = finalize_llm_review(
            json!({
                "suggestions":[{
                    "role":"category",
                    "file_side":"file2",
                    "suggested_column":"资产类型描述",
                    "confidence":0.9,
                    "action":"review",
                    "reason":"数据形态与类别不符"
                }],
                "fieldReviews":[],
                "matchReview":{"action":"keep"}
            }),
            json!({
                "file1":{"headers":["固定资产类别"]},
                "file2":{"headers":["资产分类","资产类型描述"]},
                "suspectMappings":[{
                    "role":"category",
                    "file_side":"file2",
                    "suggested_column":"资产类型描述",
                    "confidence":0.9,
                    "action":"review",
                    "reason":"本地规则兜底"
                }]
            }),
            false,
        );
        let count = value["fieldReviews"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["role"] == "category" && item["file_side"] == "file2")
            .count();
        assert_eq!(count, 1);
    }
    #[test]
    fn llm_noop_message_matches_ui_contract() {
        let value = finalize_llm_review(
            json!({"suggestions":[],"fieldReviews":[],"matchReview":{"action":"keep"}}),
            json!({}),
            false,
        );
        assert_eq!(
            value["message"],
            "LLM 复核完成：现有脚本映射无需补充，匹配键已复核。"
        );
    }
    #[test]
    fn composite_match_dates_use_one_iso_representation() {
        assert_eq!(
            normalize_key("2025-6-12 08:30:15", false, true),
            "2025-06-12"
        );
        assert_eq!(normalize_key("2025/06/12", false, true), "2025-06-12");
        assert_eq!(display_date("2025.06.12"), "2025-06-12");
        assert_eq!(
            canonical_display_key("1100090.0 | 消声室 | 2025-6-12 00:00:00"),
            "1100090|||消声室|||2025-06-12"
        );
    }
    #[test]
    fn change_type_is_reconciled_from_amount_sign() {
        assert_eq!(change_type(-100.0, "原值"), "原值增加");
        assert_eq!(change_type(200.0, "原值"), "原值减少");
        assert_eq!(change_type(1e-7, "原值"), "原值不变");
    }

    fn parity_fixture(dir: &Path) -> (MergeResult, Value) {
        let begin = dir.join("parity_begin.csv");
        let end = dir.join("parity_end.csv");
        fs::write(&begin,"编号,类别,名称,原值,累计折旧,寿命(月),残值率,处置方式\nA1,机器,甲,100,20,60,5%,\nA2,合计,噪声,999,99,12,5%,\nA3,电子,乙,80,70,12,5%,报废\n").unwrap();
        fs::write(&end,"编号,类别,名称,原值,累计折旧,寿命(月),残值率,新增方式\nA1,机器,甲,130,35,72,6%,购置\nA4,运输,丙,50,5,48,5%,购置\n").unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","disposalMethod":"处置方式"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","additionMethod":"新增方式"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        (result, p)
    }

    #[test]
    fn extended_summary_has_methods_residual_and_noise_backup() {
        let dir = std::env::temp_dir().join(format!("fa-summary-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (result, p) = parity_fixture(&dir);
        let (headers, rows, noise) = build_extended_summary(&result, &p);
        assert!(headers.contains(&"机器".to_owned()));
        assert!(rows.iter().any(|r| r[1] == "——其中-购置"));
        assert!(!rows.iter().any(|r| r[1].contains("新增方式:")));
        assert!(rows.iter().any(|r| r[1] == "累计折旧变动净额"));
        assert!(rows.iter().any(|r| r[1] == "——其中-报废"));
        assert!(
            rows.iter()
                .any(|r| r[1] == "——其中-非处置变动（含计提折旧）")
        );
        assert_eq!(noise.len(), 1);
        assert!(noise[0][1].contains("合计"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn depreciation_period_covers_changed_life_residual_new_and_disposed() {
        let dir = std::env::temp_dir().join(format!("fa-dep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (result, p) = parity_fixture(&dir);
        let rows = build_depreciation_period(&result, &p);
        assert!(
            rows.iter()
                .any(|r| r[0] == "机器" && r[8] == "不一致" && number(&r[9]).abs() > 0.0)
        );
        assert!(rows.iter().any(|r| r[1] == "运输" && r[8] == "待确认"));
        // Legacy treats one-sided opening groups as consistent.
        assert!(rows.iter().any(|r| r[0] == "电子" && r[8] == "一致"));
        // Groups with no value on either side are dropped entirely.
        assert!(
            rows.iter()
                .all(|r| number(&r[6]).abs() > 0.005 || number(&r[7]).abs() > 0.005)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn arbitrary_multidimensional_pivot_supports_multiple_aggs() {
        let dir = std::env::temp_dir().join(format!("fa-pivot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (result, mut p) = parity_fixture(&dir);
        p["pivotConfig"] = json!({"rows":["资产类别","数据来源"],"columns":["资产名称"],"values":[{"field":"期末原值","agg":"sum"},{"field":"期末原值","agg":"count"}]});
        let (headers, rows) = build_pivot(&result, &p);
        // Row dimensions are titled with the mapped source column + workbook.
        assert_eq!(&headers[..2], ["类别_parity_end.csv", "数据来源"]);
        // Value columns are titled with the mapped source column + workbook;
        // the aggregation is appended only because two are mixed here.
        assert!(
            headers
                .iter()
                .any(|value| value == "原值_parity_end.csv_sum_甲")
        );
        assert!(
            headers
                .iter()
                .any(|value| value == "原值_parity_end.csv_count_甲")
        );
        // Wide cross-tab contract: each row key appears once and aggregate
        // names belong to columns, never as repeated long-form data rows.
        // 3 categories + a trailing 合计.  The fixture's 合计 source row is
        // noise and must not become a category of its own — that double-counted
        // every pivot total.
        assert_eq!(rows.len(), 4);
        assert_eq!(rows.last().unwrap()[0], "合计");
        assert!(!rows[..3].iter().any(|r| r[0] == "合计"));
        assert!(rows.iter().all(|row| row.len() == headers.len()));
        assert!(!rows.iter().any(|r| r.iter().any(|v| v == "count")));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 合并数据 held every cell as text, so no column could be summed in
    /// Excel — while asset codes must *not* become numbers or they lose their
    /// leading zeros.
    #[test]
    fn merged_sheet_writes_amounts_as_numbers_but_keeps_codes_as_text() {
        assert_eq!(numeric_text("269327.01"), Some(269327.01));
        assert_eq!(numeric_text("-1200"), Some(-1200.0));
        assert_eq!(numeric_text("0.1"), Some(0.1));
        assert_eq!(numeric_text("0"), Some(0.0));
        // Identifiers, not quantities.
        assert_eq!(numeric_text("0002"), None);
        assert_eq!(numeric_text("0000103657"), None);
        assert_eq!(numeric_text("H201G16005"), None);
        assert_eq!(numeric_text(""), None);
        // Digit-only identifier columns stay text regardless of their values.
        assert!(is_identifier_header("固定资产编号"));
        assert!(is_identifier_header("资产编码.1_期末"));
        assert!(is_identifier_header("coding_期初"));
        assert!(!is_identifier_header("原值_期初"));
        assert!(!is_identifier_header("累计折旧_期末"));

        let dir = std::env::temp_dir().join(format!("fa-merged-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        fs::write(&begin, "编号,名称,类别,原值,累计折旧,寿命(月),残值率,成本中心,入账日期\nA1,甲,机器,100.25,20,60,5%,0002,45104\n").unwrap();
        fs::write(&end, "编号,名称,类别,原值,累计折旧,寿命(月),残值率,成本中心,入账日期\nA1,甲,机器,100.25,30,60,5%,0002,45104\n").unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"入账日期"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"入账日期"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();
        let merged = wb.worksheet_range("合并数据").unwrap();
        let headers = merged
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let data = merged.rows().nth(2).unwrap();
        let at = |name: &str| &data[headers.iter().position(|h| h == name).unwrap()];

        // Headers carry the workbook label, as the legacy sheet did.
        assert_eq!(
            at("原值_b.csv"),
            &calamine::Data::Float(100.25),
            "amount must be written as a number, not text"
        );
        assert!(matches!(
            at("累计折旧_e.csv"),
            calamine::Data::Float(_) | calamine::Data::Int(_)
        ));
        // Leading-zero cost centre survives as text.
        assert_eq!(at("成本中心_b.csv").to_string(), "0002");
        // Date column renders as a date, not the serial.
        assert_eq!(at("入账日期_b.csv").to_string(), "2023-06-27");
        // Digit-only asset ids stay text so lookups against other workpapers
        // still match.
        let fa = wb.worksheet_range("FA List").unwrap();
        assert!(matches!(
            &fa.rows().nth(2).unwrap()[1],
            calamine::Data::String(v) if v == "A1"
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Cards routinely carry 资本化日期 as an Excel serial; the detail sheets
    /// must render a date, not "45,104.00".
    #[test]
    fn excel_serial_dates_are_rendered_as_dates_not_money() {
        assert_eq!(display_date("45104"), "2023-06-27");
        assert_eq!(display_date("2023-06-27 00:00:00"), "2023-06-27");
        assert_eq!(display_date("2023/6/27"), "2023-06-27");
        // Not dates: placeholders and small numbers must survive untouched,
        // otherwise a 5-year life would become 1900-01-04.
        assert_eq!(display_date("[新增时间?]"), "[新增时间?]");
        assert_eq!(display_date("5"), "5");
        assert_eq!(display_date("240"), "240");
        assert_eq!(display_date(""), "");
        // 8-digit compact dates are still dates, not out-of-range serials.
        assert_eq!(display_date("20230627"), "2023-06-27");

        let dir = std::env::temp_dir().join(format!("fa-dates-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率,开始\nA1,甲,机器,100,20,60,5%,45104\n",
        )
        .unwrap();
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率,开始\nA1,甲,机器,100,30,60,5%,45104\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"开始"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"开始"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();
        let fa = wb.worksheet_range("FA List").unwrap();
        assert_eq!(fa.rows().nth(2).unwrap()[3].to_string(), "2023-06-27");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The analysis sheet used to ship four generic instructions with no
    /// numbers in them; the old exporter computed the facts deterministically
    /// and let the LLM only phrase them.
    #[test]
    fn llm_analysis_reports_computed_facts_not_generic_prompts() {
        let dir = std::env::temp_dir().join(format!("fa-facts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率,开始\nA1,甲,机器,1000,200,60,5%,2020-01-05\nA4,测试工装,工具,200,0,60,5%,2020-01-05\n",
        )
        .unwrap();
        // A2 is a current-year addition; A3 is dated outside the period and
        // its name reads like maintenance spend.
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率,开始\nA1,甲,机器,1000,300,60,5%,2020-01-05\nA2,新压机,机器,5000,100,60,5%,2025-03-01\nA3,管路维修,机器,700,10,60,5%,2019-08-01\nA4,测试工装,工具,200,0,60,5%,2020-01-05\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "balanceSheetDate":"2025-12-31",
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"开始"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","startDate":"开始"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let facts = build_analysis_facts(&result, &p);
        let section = |name: &str| {
            facts
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.clone())
                .unwrap()
        };

        let overview = section("总体概述");
        assert!(overview.contains("1,200.00"), "opening total: {overview}");
        assert!(overview.contains("6,900.00"), "closing total: {overview}");
        assert!(overview.contains("5,700.00"), "net change: {overview}");

        let large = section("大额变动示例");
        assert!(large.contains("新压机"), "{large}");
        assert!(large.contains("5,000.00"), "{large}");

        // A3 is dated 2019 against a 2025 balance sheet date.
        let dates = section("新增日期异常");
        assert!(dates.contains("管路维修"), "{dates}");
        assert!(dates.contains("2025"), "{dates}");

        let expense = section("疑似费用化");
        assert!(expense.contains("管路维修"), "{expense}");
        assert!(expense.contains("700.00"), "{expense}");
        // Old analysis scans the complete closing FA List and includes its
        // original 工装 keyword even when the card is not a current-year addition.
        assert!(expense.contains("测试工装"), "{expense}");
        // The clean addition must not be flagged.
        assert!(!expense.contains("新压机"), "{expense}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A card that changes category mid-year must leave its opening balance on
    /// the opening category (so 期初余额 still ties to last year's signed
    /// report) and move across via an explicit 重分类 row.
    #[test]
    fn reclassified_card_keeps_opening_balance_on_its_opening_category() {
        let dir = std::env::temp_dir().join(format!("fa-reclass-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        // R1 moves 运输设备 -> 运输工具; R2 stays put and is disposed of.
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nR1,甲,运输设备,1000,200,60,5%\nR2,乙,运输设备,300,60,60,5%\n",
        )
        .unwrap();
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nR1,甲,运输工具,1000,320,60,5%\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let (headers, rows, _) = build_extended_summary(&result, &p);

        let col = |name: &str| headers.iter().position(|h| h == name).unwrap();
        let cell = |item: &str, category: &str| -> f64 {
            rows.iter()
                .find(|r| r[1] == item)
                .map(|r| number(&r[col(category)]))
                .unwrap_or(0.0)
        };
        let (transport, tool) = ("运输设备", "运输工具");

        let opening = format!(
            "{}{}",
            side_label(&p, 1),
            mapped_header(&p, 1, "originalValue").unwrap()
        );
        let closing = format!(
            "{}{}",
            side_label(&p, 2),
            mapped_header(&p, 2, "originalValue").unwrap()
        );
        // Opening stays whole on 运输设备: 1000 + 300, nothing on 运输工具.
        assert_eq!(cell(&opening, transport), 1300.0);
        assert_eq!(cell(&opening, tool), 0.0);
        // The move is visible as its own row rather than folded into opening.
        assert_eq!(cell("原值重分类", transport), -1000.0);
        assert_eq!(cell("原值重分类", tool), 1000.0);
        // 期初 + 增加 - 减少 + 重分类 = 期末, per category.
        for category in [transport, tool] {
            let derived = cell(&opening, category) + cell("原值增加", category)
                - cell("原值减少", category)
                + cell("原值重分类", category);
            assert!(
                (derived - cell(&closing, category)).abs() < 0.005,
                "{category} does not reconcile: {derived} vs {}",
                cell(&closing, category)
            );
        }
        assert_eq!(cell(&closing, tool), 1000.0);
        assert_eq!(cell(&closing, transport), 0.0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Composite match keys used to leak into 固定资产编号 verbatim
    /// ("A1 | 甲"), file2's 计划使用年 reached 新增清单 unconverted (5 instead
    /// of 60), and 增加类型 was dated off the usually-blank 新增时间 so every
    /// row read 本期新增.
    #[test]
    fn addition_and_disposal_sheets_carry_plain_id_month_life_and_amount_type() {
        let dir = std::env::temp_dir().join(format!("fa-addition-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nA1,甲,机器,100,20,60,5%\n",
        )
        .unwrap();
        // 计划使用年 is a *year* count, and A2 exists only in file2.
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,计划使用年,残值率\nA1,甲,机器,60,25,5,5%\nA2,乙,电子,400,10,5,5%\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,
            "beginKeys":["编号","名称"],"endKeys":["编号","名称"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"计划使用年","residualRate":"残值率"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();
        let mut wb = wb;

        let add = wb.worksheet_range("新增清单_BKD").unwrap();
        let row = add.rows().nth(2).unwrap();
        assert_eq!(
            row[1].to_string(),
            "A2",
            "编号 must not carry the composite key"
        );
        assert_eq!(
            row[4].to_string(),
            "60",
            "计划使用年 5 must become 60 months"
        );
        // Legacy column order: 增加类型 at index 6, then 原值增加, then the two
        // manual-entry placeholders.
        assert_eq!(row[6].to_string(), "非原值修改");
        assert_eq!(row[8].to_string(), "[新增方式?]");

        // A1 keeps a file1 original value, so its increase is an uplift.
        let disposal = wb.worksheet_range("处置清单_BKD").unwrap();
        let row = disposal.rows().nth(2).unwrap();
        assert_eq!(row[1].to_string(), "A1");
        assert_eq!(row[4].to_string(), "60");

        let fa = wb.worksheet_range("FA List").unwrap();
        assert!(
            fa.rows().skip(2).all(|r| !r[1].to_string().contains(" | ")),
            "FA List 固定资产编号 must stay a plain id"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn life_cells_may_carry_their_unit_inline() {
        for (raw, expected) in [
            ("60", Some(60.0)),
            ("60期", Some(60.0)),
            ("60月", Some(60.0)),
            ("60个月", Some(60.0)),
            (" 60 月份 ", Some(60.0)),
            ("60期数", Some(60.0)),
            ("60months", Some(60.0)),
            ("0期", Some(0.0)),
            ("", None),
            ("不适用", None),
        ] {
            assert_eq!(parse_life_cell(raw), expected, "life cell {raw:?}");
        }
        // The unit decision is per column, not per row: a genuine 12-month
        // tooling column must not be multiplied into 144.
        assert_eq!(life_scale_for_column("使用寿命", &[60.0, 120.0, 12.0]), 1.0);
        assert_eq!(life_scale_for_column("使用寿命", &[12.0, 12.0]), 1.0);
        assert_eq!(life_scale_for_column("计划使用年", &[5.0]), 12.0);
        assert_eq!(life_scale_for_column("使用寿命(月)", &[5.0]), 1.0);
        // No header evidence, but every value is a common year term.
        assert_eq!(life_scale_for_column("寿命", &[3.0, 5.0, 10.0]), 12.0);
    }

    /// Kingdee-style exports write 使用寿命 as "60期".  A plain numeric parse
    /// returns 0 for those cells, which blanks 使用寿命(月) and 提足折旧时间 on
    /// every card, zeroes the whole depreciation block, and — because 0 <= 12 —
    /// drags the entire ledger into ≤12月卡片明细.
    #[test]
    fn life_with_a_period_unit_keeps_the_depreciation_block_alive() {
        let dir = std::env::temp_dir().join(format!("fa-life-unit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,使用寿命,残值率,入账日期\nA1,甲,机器,100,20,60期,4%,2020-01-01\nD1,丁,模具,50,10,12期,0,2024-01-01\n",
        )
        .unwrap();
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,使用寿命,残值率,入账日期\nA1,甲,机器,100,25,60期,4%,2020-01-01\nD1,丁,模具,50,20,12期,0,2024-01-01\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,
            "beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率","startDate":"入账日期"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率","startDate":"入账日期"},
            "balanceSheetDate":"2025-12-31"});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();

        let fa = wb.worksheet_range("FA List").unwrap();
        let a1 = fa
            .rows()
            .skip(2)
            .find(|r| r[1].to_string() == "A1")
            .expect("A1 in FA List");
        assert_eq!(a1[4].to_string(), "60", "“60期” must read as 60 months");
        assert_eq!(
            a1[11].to_string(),
            "2025-01-01",
            "提足折旧时间 needs a life to be computable"
        );

        // Only the 12-month card belongs in the short-life sheet.
        let short = wb.worksheet_range("≤12月卡片明细").unwrap();
        let ids = short
            .rows()
            .skip(2)
            .take_while(|r| r[0].to_string() != "本表说明")
            .map(|r| r[1].to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["D1".to_owned()]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The 补充清单 is a source for 新增方式/新增时间, never a membership test.
    /// The UI prefills it with file2 itself whenever file2 already carries
    /// 新增方式, so treating "has an auxiliary column" as "is an addition" turned
    /// 新增清单_BKD into a copy of the whole ledger.
    #[test]
    fn addition_sheet_lists_only_cards_whose_original_value_grew() {
        let dir = std::env::temp_dir().join(format!("fa-add-scope-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        let supplement = dir.join("s.csv");
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nA1,甲,机器,100,20,60,4%\nB1,乙,机器,200,20,60,4%\n",
        )
        .unwrap();
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率,资产来源\nA1,甲,机器,100,25,60,4%,9\nB1,乙,机器,260,30,60,4%,2\nC1,丙,无形资产,80,5,60,4%,2\n",
        )
        .unwrap();
        // The "supplement" covers every card, exactly as the file2 prefill does.
        fs::write(
            &supplement,
            "编号,新增方式,新增日期\nA1,购入,2025-01-01\nB1,购入,2025-02-01\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,
            "beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率","additionMethod":"资产来源"},
            "additionSupplement":{"path":supplement,"keys":["编号"],"method":"新增方式","date":"新增日期"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();
        let add = wb.worksheet_range("新增清单_BKD").unwrap();
        let ids = add
            .rows()
            .skip(2)
            .take_while(|r| r[0].to_string() != "本表说明")
            .map(|r| r[1].to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["B1".to_owned(), "C1".to_owned()],
            "A1 did not grow, so it is not an addition"
        );
        let c1 = add
            .rows()
            .skip(2)
            .find(|row| row[1].to_string() == "C1")
            .unwrap();
        assert_eq!(
            c1[8].to_string(),
            "2",
            "an unmatched supplement card falls back to file2's mapped method"
        );
        let summary = wb.worksheet_range("固定资产变动汇总表").unwrap();
        assert!(
            summary
                .rows()
                .any(|row| row.iter().any(|cell| cell.to_string() == "——其中-2"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Legacy presentation contract: an empty ≤12月 sheet states the result in
    /// words, rows are ordered by match key, and the depreciation formula block
    /// is capped on large sheets.
    #[test]
    fn legacy_presentation_contract() {
        let dir = std::env::temp_dir().join(format!("fa-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("b.csv");
        let end = dir.join("e.csv");
        // B1 exists only in file2 and sorts between A1 and C1 by match key.
        fs::write(
            &begin,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nA1,甲,机器,100,20,60,5%\nC1,丙,机器,300,30,60,5%\n",
        )
        .unwrap();
        fs::write(
            &end,
            "编号,名称,类别,原值,累计折旧,寿命(月),残值率\nA1,甲,机器,100,25,60,5%\nB1,乙,机器,200,10,60,5%\nC1,丙,机器,300,40,60,5%\n",
        )
        .unwrap();
        let p = json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"},
            "endMapping":{"category":"类别","name":"名称","originalValue":"原值","depreciation":"累计折旧","life":"寿命(月)","residualRate":"残值率"}});
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();

        // file2-only B1 sits between A1 and C1, not appended after them.
        assert_eq!(
            result
                .rows
                .iter()
                .map(|r| r.match_value.as_str())
                .collect::<Vec<_>>(),
            vec!["A1", "B1", "C1"]
        );

        let out = dir.join("out.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(&out).unwrap();
        assert!(!wb.sheet_names().contains(&"00_使用说明".to_owned()));

        let short = wb.worksheet_range("≤12月卡片明细").unwrap();
        assert_eq!(short.rows().next().unwrap()[0].to_string(), "提示");
        assert_eq!(
            short.rows().nth(2).unwrap()[0].to_string(),
            "经检查，期末FA LIST中未发现任何≤12月的资产卡片"
        );

        // FA List keeps the legacy column order.
        let fa = wb.worksheet_range("FA List").unwrap();
        let head = fa
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert_eq!(
            &head[6..12],
            [
                "原值",
                "累计折旧",
                "本年折旧",
                "净值",
                "已提足折旧",
                "提足折旧时间"
            ]
        );

        // 合计 column is a live formula, not a baked number.
        let formulas = wb.worksheet_formula("固定资产变动汇总表").unwrap();
        // One SUM per data row (used_cells coordinates are range-relative, so
        // match on the formula text rather than an absolute column index).
        let sums = formulas
            .used_cells()
            .filter(|(_, _, f)| f.starts_with("SUM(D"))
            .count();
        assert_eq!(
            sums,
            build_extended_summary(&result, &p).1.len(),
            "合计 column must hold one live SUM per row"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn depreciation_formula_block_is_capped_on_large_sheets() {
        assert_eq!(DEPRECIATION_FORMULA_ROW_LIMIT, 20_000);
        assert_eq!(DEPRECIATION_FORMULA_SAMPLE_ROWS, 10);
        // Column width never runs away the way autofit did (74 for a name col).
        assert_eq!(legacy_column_width("FA List", 5), 8.0);
        assert_eq!(legacy_column_width("FA List", 19), 21.0);
        assert_eq!(legacy_column_width("FA List", 200), 45.0);
        // Detail-heavy sheets stay compact.
        assert_eq!(legacy_column_width("合并数据", 200), 26.0);
        // Money columns are measured over every row so a large figure further
        // down cannot render as ###; text columns keep the 10-row sample.
        assert!(column_reads_numeric(["1", "2,3", "4"].into_iter()) == false);
        assert!(column_reads_numeric(["100", "200.5", ""].into_iter()));
        assert!(!column_reads_numeric(["0002", "3"].into_iter()));
        assert!(!column_reads_numeric(std::iter::empty()));
    }

    /// Regenerates the real-sample workbook the parity review runs against.
    /// Ignored and env-gated: it needs desensitized client cards that are not
    /// in the repo.  Point FA_SAMPLE_DIR at a folder holding the two 卡片
    /// workbooks, then run with `-- --ignored`.
    #[test]
    #[ignore = "needs FA_SAMPLE_DIR pointing at local sample cards"]
    fn regenerate_sample_export() {
        let Ok(dir) = std::env::var("FA_SAMPLE_DIR") else {
            panic!("set FA_SAMPLE_DIR to the folder holding the sample cards");
        };
        let base = Path::new(&dir);
        let mut p = json!({
            "beginPath": base.join("2024固定资产卡片02.xlsx"),
            "endPath": base.join("2025固定资产卡片02.xlsx"),
            "beginSheet": "Sheet1",
            "endSheet": "2512",
            "beginKeys": ["coding", "固定资产名称"],
            "endKeys": ["资产编码.1", "资产描述"],
            "balanceSheetDate": "2025/12/31",
            // Only gates whether the analysis sheet is written; its content is
            // computed deterministically, so no endpoint is contacted.
            "__settings": {"llm": {"enabled": true}},
            "beginMapping": {"category":"固定资产类别","name":"固定资产名称","startDate":"入账开始日期",
                "life":"使用寿命(月)","residualRate":"残值率","originalValue":"原值","depreciation":"累计折旧"},
            "endMapping": {"category":"资产类型描述","name":"资产描述","startDate":"资本化日期",
                "life":"计划使用年","residualRate":"残值","currentYearDep":"本年折旧",
                "originalValue":"原值(期末)","depreciation":"累计折旧"}
        });
        let supplement = base.join("新增及处置清单_测试样例.xlsx");
        if supplement.is_file() {
            p["additionSupplement"] = json!({
                "path": supplement,
                "sheet": "新增清单",
                "headerRow": 1,
                "keys": ["资产编码_2", "资产描述"],
                "method": "新增方式",
                "date": "资本化日期"
            });
            p["disposalSupplement"] = json!({
                "path": base.join("新增及处置清单_测试样例.xlsx"),
                "sheet": "处置清单",
                "headerRow": 1,
                "keys": ["coding", "固定资产名称"],
                "method": "处置方式",
                "date": "入账开始日期",
                "originalValue": "原值",
                "depreciation": "累计折旧"
            });
        }
        let result = merge(&p, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let out = base.join("新代码修复后-FA_List_Codex.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        println!("wrote {}", out.display());
    }

    #[test]
    fn exporter_writes_source_notes_anomaly_and_freeze_contract() {
        let dir = std::env::temp_dir().join(format!("fa-export-parity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (result, mut p) = parity_fixture(&dir);
        p["__settings"] = json!({"llm":{"enabled":true}});
        let out = dir.join("parity.xlsx");
        write_xlsx(&out, &result, &p, &AtomicBool::new(false)).unwrap();
        let styles = xlsx_entry(&out, "xl/styles.xml");
        let summary = xlsx_entry(&out, "xl/worksheets/sheet4.xml");
        let fa_list = xlsx_entry(&out, "xl/worksheets/sheet5.xml");
        // Every exported tab explicitly carries a left-aligned title/header
        // in A1, including the independently formatted map and LLM sheets.
        for sheet_number in 1..=11 {
            let sheet = xlsx_entry(
                &out,
                format!("xl/worksheets/sheet{sheet_number}.xml").as_str(),
            );
            assert!(
                cell_style(&styles, &sheet, "A1").contains("horizontal=\"left\""),
                "sheet{sheet_number}!A1 should be left aligned"
            );
        }
        assert!(cell_style(&styles, &fa_list, "A2").contains("horizontal=\"left\""));
        let section = cell_style(&styles, &summary, "A3");
        assert!(section.contains("horizontal=\"left\""));
        assert!(section.contains("vertical=\"center\""));
        let mut wb = open_workbook_auto(&out).unwrap();
        let range = wb.worksheet_range("FA List").unwrap();
        assert!(
            range
                .rows()
                .flatten()
                .any(|c| c.to_string().contains("信息来源"))
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn export_contains_contract_sheets() {
        let dir = std::env::temp_dir().join(format!("fa-rust-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir);
        p["beginMapping"] = json!({"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率","startDate":"入账开始日期","currentYearDep":"本年折旧"});
        p["endMapping"] = json!({"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值","startDate":"入账开始日期","currentYearDep":"本年折旧"});
        p["balanceSheetDate"] = json!("2025-12-31");
        p["__settings"] = json!({"llm":{"enabled":true}});
        p["__llmAnalysisMock"] = json!({"title":"模拟 LLM 分析"});
        p["pivotConfig"] = json!({
            "rows":["资产类别"],
            "columns":["数据来源"],
            "values":[
                {"field":"期末原值","agg":"sum"},
                {"field":"期末原值","agg":"count"}
            ]
        });
        let out = test_export(p).unwrap();
        assert_eq!(out["engine"], "rust-fa");
        let mut wb = open_workbook_auto(dir.join("FA_List.xlsx")).unwrap();
        // Tab order must match the legacy workbook exactly (00_使用说明 was
        // dropped; 汇总备查 is Rust-only and trails the legacy set).
        assert_eq!(
            wb.sheet_names(),
            vec![
                "01_套表地图",
                "合并数据",
                "数据透视表",
                "固定资产变动汇总表",
                "FA List",
                "≤12月卡片明细",
                "新增清单_BKD",
                "处置清单_BKD",
                "折旧期间",
                "LLM分析",
                "异常清单",
            ]
        );
        let pivot = wb.worksheet_range("数据透视表").unwrap();
        let pivot_headers = pivot
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(
            pivot_headers
                .iter()
                .any(|header| header == "原值_end.csv_sum_两文件都有")
        );
        assert!(
            pivot_headers
                .iter()
                .any(|header| header == "原值_end.csv_count_仅文件2")
        );
        let anomalies = wb.worksheet_range("异常清单").unwrap();
        assert_eq!(anomalies.get((0, 0)).unwrap().to_string(), "异常类型");
        assert_eq!(anomalies.get((1, 0)).unwrap().to_string(), "逻辑判断");
        assert_eq!(anomalies.get((2, 0)).unwrap().to_string(), "未发现异常");
        let fa_formulas = wb.worksheet_formula("FA List").unwrap();
        // The depreciation block intersects the asset's own depreciation window
        // with the audited year, so it is built from EDATE/YEAR/MONTH rather
        // than a plain elapsed-month count.  Assert the interval is actually
        // bounded by the life, not merely that some date function is present.
        let formulas = fa_formulas
            .rows()
            .flatten()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(formulas.iter().any(|value| value.contains("EDATE")));
        assert!(
            formulas
                .iter()
                .any(|value| value.contains("DATEVALUE(SUBSTITUTE(") && value.contains("ISNUMBER(")),
            "text dates such as 2022.12.29 must be coerced before YEAR/MONTH"
        );
        assert!(
            formulas
                .iter()
                .any(|value| value.contains("MIN(EDATE(EDATE("))
        );
        let disposal = wb.worksheet_range("处置清单_BKD").unwrap();
        assert_eq!(disposal.get((0, 6)).unwrap().to_string(), "原值减少");
        assert_eq!(disposal.get((0, 14)).unwrap().to_string(), "处置折旧");
        let disposal_formulas = wb.worksheet_formula("处置清单_BKD").unwrap();
        // Without a supplement, 处置折旧 remains a traceable formula linked to
        // 年初累计折旧, and 本年折旧 therefore defaults to zero. The optional
        // depreciation-measurement block is still not appended until the other
        // disposal mappings are present.
        let disposal_formulas = disposal_formulas
            .rows()
            .flatten()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        assert!(disposal_formulas.iter().any(|value| value == "O3-H3"));
        assert!(disposal_formulas.iter().any(|value| value == "H3"));
        let llm = wb.worksheet_range("LLM分析").unwrap();
        assert_eq!(llm.get((0, 0)).unwrap().to_string(), "模拟 LLM 分析");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Resolve the format code actually applied to a cell.  rust_xlsxwriter
    /// registers every string number format as a custom `<numFmt>` starting at
    /// id 164, so the id on the `<xf>` has to be looked back up in styles.xml.
    fn cell_number_format(styles: &str, sheet: &str, reference: &str) -> String {
        let xf = cell_style(styles, sheet, reference);
        let id = xf
            .split("numFmtId=\"")
            .nth(1)
            .and_then(|value| value.split('"').next())
            .unwrap_or("0");
        styles
            .split(&format!("<numFmt numFmtId=\"{id}\" formatCode=\""))
            .nth(1)
            .and_then(|value| value.split('"').next())
            .unwrap_or("General")
            .to_owned()
    }

    /// FA List 的折旧测算块占 N..U 八列。六个金额列（月折旧额、测算的当年折旧、
    /// 测算的累计折旧、账面本年折旧、差异_本年折旧、差异_累计折旧）必须是
    /// 千分位、不带小数的数值；月折旧额还必须在算不出来时落成 0 而不是空文本，
    /// 否则用户在导出件上继续写公式会拿到 #VALUE! 或被静默跳过。
    #[test]
    fn depreciation_block_money_columns_are_numeric_thousands() {
        let dir = std::env::temp_dir().join(format!("fa-rust-money-fmt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        // A2 有完整参数，A3 缺使用寿命——后者正是旧版会写出空文本的那一行。
        fs::write(
            &begin,
            "卡片编号,资产类别,资产名称,原值,累计折旧,使用寿命,残值率,入账开始日期,本年折旧\nA2,机器,甲,120000,20000,60,5%,2020-01-01,24000\nA3,电子,乙,3000,0,,5%,2021-01-01,0\n",
        )
        .unwrap();
        fs::write(
            &end,
            "卡片编号,资产类别,资产名称,原值,累计折旧,使用寿命,残值,入账开始日期,本年折旧\nA2,机器,甲,120000,44000,60,5,2020-01-01,24000\nA3,电子,乙,3000,0,,5,2021-01-01,0\n",
        )
        .unwrap();
        let output = dir.join("FA_List.xlsx");
        let p = json!({
            "beginPath":begin,"endPath":end,"beginKeys":["卡片编号"],"endKeys":["卡片编号"],
            "beginMapping":{"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值率","startDate":"入账开始日期","currentYearDep":"本年折旧"},
            "endMapping":{"category":"资产类别","name":"资产名称","originalValue":"原值","depreciation":"累计折旧","life":"使用寿命","residualRate":"残值","startDate":"入账开始日期","currentYearDep":"本年折旧"},
            "balanceSheetDate":"2025-12-31",
            "outputPath":output,"__settings":{"llm":{"enabled":false}}
        });
        test_export(p).unwrap();

        // 先钉住列位：FA List 自身 12 列（A..L），折旧块从 N 起。
        let mut wb = open_workbook_auto(&output).unwrap();
        let fa = wb.worksheet_range("FA List").unwrap();
        for (column, name) in [
            (13usize, "月折旧额"),
            (14, "本年应计提折旧月份"),
            (15, "累计折旧月份"),
            (16, "测算的当年折旧"),
            (17, "测算的累计折旧"),
            (18, "账面本年折旧"),
            (19, "差异_本年折旧"),
            (20, "差异_累计折旧"),
        ] {
            assert_eq!(
                fa.get((0, column)).unwrap().to_string(),
                name,
                "折旧块列位漂移：第 {column} 列应为 {name}"
            );
        }

        let formulas = wb.worksheet_formula("FA List").unwrap();
        // 公式区间从 N3 起，get 是相对坐标，这里按绝对坐标取。
        let monthly = (2u32..4)
            .map(|row| formulas.get_value((row, 13)).unwrap().to_string())
            .collect::<Vec<_>>();
        assert!(
            monthly.iter().all(|f| f.contains("IFERROR(ROUND(")),
            "月折旧额应仍是可追溯公式：{monthly:?}"
        );
        assert!(
            monthly.iter().all(|f| f.ends_with(",0)")),
            "月折旧额算不出来时必须落成数值 0：{monthly:?}"
        );
        assert!(
            !monthly.iter().any(|f| f.contains(",\"\")")),
            "月折旧额不允许回落成空文本：{monthly:?}"
        );

        let styles = xlsx_entry(&output, "xl/styles.xml");
        // 按内容定位 FA List 的 sheet xml：只有它把折旧测算公式写在 N3，
        // 免得工作表增删时测试跟着漂。
        let sheet = {
            use std::io::Read;
            let file = fs::File::open(&output).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            let names = archive
                .file_names()
                .filter(|name| name.starts_with("xl/worksheets/sheet"))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let mut found = None;
            for name in names {
                let mut xml = String::new();
                archive
                    .by_name(&name)
                    .unwrap()
                    .read_to_string(&mut xml)
                    .unwrap();
                let is_fa_list = xml.split("<c r=\"N3\"").nth(1).is_some_and(|cell| {
                    cell.split("</c>")
                        .next()
                        .unwrap_or_default()
                        .contains("IFERROR(ROUND(")
                });
                if is_fa_list {
                    found = Some(xml);
                    break;
                }
            }
            found.expect("FA List worksheet xml")
        };
        for reference in ["N3", "Q3", "R3", "S3", "T3", "U3", "N4", "Q4", "U4"] {
            assert_eq!(
                cell_number_format(&styles, &sheet, reference),
                MONEY_NUMBER_FORMAT,
                "{reference} 应使用千分位且不显示小数"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_omits_llm_analysis_when_global_llm_is_disabled() {
        let dir = std::env::temp_dir().join(format!("fa-rust-no-llm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir);
        p["beginMapping"] = json!({"category":"资产类别","originalValue":"原值"});
        p["endMapping"] = json!({"category":"资产类别","originalValue":"原值"});
        p["__settings"] = json!({"llm":{"enabled":false}});
        test_export(p).unwrap();
        let wb = open_workbook_auto(dir.join("FA_List.xlsx")).unwrap();
        assert!(!wb.sheet_names().contains(&"LLM分析".to_owned()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fa_list_follows_legacy_merged_key_order_through_export() {
        let dir = std::env::temp_dir().join(format!("fa-rust-card-order-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin, "编号,名称,原值\nA,甲,1\nB,乙,2\n").unwrap();
        fs::write(&end, "编号,名称,原值\nB,乙一,2\nA,甲,1\nB,乙二,3\n").unwrap();
        let output = dir.join("ordered.xlsx");
        let p = json!({
            "beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"name":"名称","originalValue":"原值"},
            "endMapping":{"name":"名称","originalValue":"原值"},
            "outputPath":output,"__settings":{"llm":{"enabled":false}}
        });
        test_export(p).unwrap();
        let mut wb = open_workbook_auto(dir.join("ordered.xlsx")).unwrap();
        let fa = wb.worksheet_range("FA List").unwrap();
        let ids = (2..5)
            .map(|row| fa.get((row, 1)).unwrap().to_string())
            .collect::<Vec<_>>();
        let names = (2..5)
            .map(|row| fa.get((row, 2)).unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["A", "B", "B"]);
        assert_eq!(names, ["甲", "乙一", "乙二"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_detects_title_row_and_real_duplicate_id_column() {
        let dir = std::env::temp_dir().join(format!("fa-rust-detect-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.xlsx");
        let end = dir.join("end.xlsx");
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        sheet.write_string(0, 0, "固定资产明细清单").unwrap();
        for (column, header) in ["固定资产类别", "coding", "固定资产名称", "原值", "累计折旧"]
            .iter()
            .enumerate()
        {
            sheet.write_string(1, column as u16, *header).unwrap();
        }
        for (column, value) in ["机器设备", "1100000", "设备甲", "1000", "100"]
            .iter()
            .enumerate()
        {
            sheet.write_string(2, column as u16, *value).unwrap();
        }
        book.save(&begin).unwrap();
        let mut book = Workbook::new();
        let summary = book.add_worksheet();
        summary.set_name("2512合计").unwrap();
        summary.write_string(0, 0, "固定资产汇总表").unwrap();
        let detail = book.add_worksheet();
        detail.set_name("2512").unwrap();
        for (column, header) in [
            "资产分类",
            "资产编码",
            "资产编码",
            "资产描述",
            "原值(期末)",
            "累计折旧",
        ]
        .iter()
        .enumerate()
        {
            detail.write_string(0, column as u16, *header).unwrap();
        }
        for row in 0..3 {
            for (column, value) in [
                "机器设备",
                "0",
                &format!("110000{row}"),
                &format!("设备{row}"),
                "1000",
                "200",
            ]
            .iter()
            .enumerate()
            {
                detail
                    .write_string((row + 1) as u32, column as u16, *value)
                    .unwrap();
            }
        }
        book.save(&end).unwrap();
        let result = inspect(json!({"beginPath":begin,"endPath":end})).unwrap();
        assert_eq!(result["begin"]["detectedHeaderRow"], 2);
        assert_eq!(result["end"]["selectedSheet"], "2512");
        assert_eq!(result["suggestedMapping"]["begin"]["matchKey"], "coding");
        assert_eq!(result["suggestedMapping"]["end"]["matchKey"], "资产编码.1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn automatic_sheet_selection_prefers_named_period_detail_over_generic_data() {
        let dir = std::env::temp_dir().join(format!("fa-sheet-affinity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("长期资产明细20241231.xlsx");
        let mut book = Workbook::new();
        for name in ["Data", "固定资产明细23年", "固定资产明细 241231"] {
            let sheet = book.add_worksheet();
            sheet.set_name(name).unwrap();
            for (column, header) in ["资产编码", "资产类别", "资产名称", "原值", "累计折旧"]
                .iter()
                .enumerate()
            {
                sheet.write_string(0, column as u16, *header).unwrap();
                sheet
                    .write_string(1, column as u16, ["A1", "机器", "甲", "100", "20"][column])
                    .unwrap();
            }
        }
        book.save(&path).unwrap();
        let table = load_table(&path, None, None, true).unwrap();
        assert_eq!(table.sheet.as_deref(), Some("固定资产明细 241231"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "requires the user's long-asset sample workbook"]
    fn real_long_asset_sample_selects_the_2024_detail_sheet() {
        let path = std::env::var_os("FA_LONG_ASSET_SAMPLE").expect("FA_LONG_ASSET_SAMPLE");
        let table = load_table(Path::new(&path), None, None, true).unwrap();
        assert_eq!(table.sheet.as_deref(), Some("固定资产明细 241231"));
        assert_eq!(table.rows.len(), 5_449);
    }

    #[test]
    fn supplements_aggregate_and_report_unmatched() {
        let dir = std::env::temp_dir().join(format!("fa-rust-supp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir);
        let addition = dir.join("addition.csv");
        let disposal = dir.join("disposal.csv");
        fs::write(&addition,"卡片编号,新增方式,新增日期\n a3 ,购置,2026-01-01\nA3,转入,2026-02-01\nX9,购置,2026-03-01\n").unwrap();
        fs::write(&disposal,"卡片编号,处置方式,处置日期,处置原值,处置折旧\nA2,报废,2026-05-01,-200,-50\nA2,出售,2026-06-01,300,70\n").unwrap();
        p["additionSupplement"] =
            json!({"path":addition,"keys":["卡片编号"],"method":"新增方式","date":"新增日期"});
        p["disposalSupplement"] = json!({"path":disposal,"keys":["卡片编号"],"method":"处置方式","date":"处置日期","originalValue":"处置原值","depreciation":"处置折旧"});
        let output = test_preview(p.clone()).unwrap();
        assert_eq!(output["stats"]["unmatchedAddition"], 1);
        assert_eq!(output["stats"]["unmatchedDisposal"], 0);
        // 合并预览不再回传明细行，改回变动汇总（类别为列、数值为数字）。
        let summary_columns = output["summary"]["columns"].as_array().unwrap();
        assert!(summary_columns.iter().any(|c| c.as_str() == Some("运输")));
        assert!(
            output["summary"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["item"] == "期末原值")
        );
        // 补充清单聚合结果直接在合并行上断言（新增方式合并去重、处置金额取绝对值合计）。
        let cancel = Arc::new(AtomicBool::new(false));
        let merged = merge(&p, &|_, _, _, _| {}, &cancel).unwrap();
        let a3 = merged
            .rows
            .iter()
            .find(|row| {
                row.end
                    .as_ref()
                    .is_some_and(|cells| cells.first().map(String::as_str) == Some("A3"))
            })
            .unwrap();
        assert!(matches!(
            a3.extra.get("新增方式_辅助_文件2"),
            Some(Cell::Text(text)) if text == "购置；转入"
        ));
        let a2 = merged
            .rows
            .iter()
            .find(|row| {
                row.begin
                    .as_ref()
                    .is_some_and(|cells| cells.first().map(String::as_str) == Some("A2"))
            })
            .unwrap();
        assert!(matches!(
            a2.extra.get("处置原值_辅助_文件1"),
            Some(Cell::Number(value)) if (*value - 500.0).abs() < 1e-9
        ));
        let mut export_params = params(&dir);
        export_params["additionSupplement"] =
            json!({"path":addition,"keys":["卡片编号"],"method":"新增方式","date":"新增日期"});
        export_params["disposalSupplement"] = json!({"path":disposal,"keys":["卡片编号"],"method":"处置方式","date":"处置日期","originalValue":"处置原值","depreciation":"处置折旧"});
        let exported = test_export(export_params).unwrap();
        assert!(
            exported["exportMessage"]
                .as_str()
                .unwrap()
                .contains("未匹配资产变动清单")
        );
        assert!(dir.join("[未匹配资产变动清单].xlsx").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn disposal_depreciation_keeps_an_explicit_zero_from_the_supplement() {
        let dir =
            std::env::temp_dir().join(format!("fa-rust-zero-disposal-dep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut p = params(&dir);
        p["beginMapping"] = json!({
            "category": "资产类别", "name": "资产名称", "originalValue": "原值",
            "depreciation": "累计折旧", "life": "使用寿命", "residualRate": "残值率",
            "startDate": "入账开始日期", "currentYearDep": "本年折旧"
        });
        p["endMapping"] = json!({
            "category": "资产类别", "name": "资产名称", "originalValue": "原值",
            "depreciation": "累计折旧", "life": "使用寿命", "residualRate": "残值",
            "startDate": "入账开始日期", "currentYearDep": "本年折旧"
        });
        let disposal = dir.join("disposal-zero.csv");
        fs::write(
            &disposal,
            "卡片编号,处置方式,处置日期,处置原值,处置折旧\nA2,报废,2026-05-01,50,0\n",
        )
        .unwrap();
        p["disposalSupplement"] = json!({
            "path": disposal,
            "keys": ["卡片编号"],
            "method": "处置方式",
            "date": "处置日期",
            "originalValue": "处置原值",
            "depreciation": "处置折旧"
        });
        test_export(p).unwrap();

        let mut wb: calamine::Xlsx<_> = calamine::open_workbook(dir.join("FA_List.xlsx")).unwrap();
        let values = wb.worksheet_range("处置清单_BKD").unwrap();
        let row_index = values
            .rows()
            .position(|row| row.get(1).is_some_and(|cell| cell.to_string() == "A2"))
            .unwrap();
        assert_eq!(values.get((row_index, 14)).unwrap().to_string(), "0");
        let formulas = wb.worksheet_formula("处置清单_BKD").unwrap();
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|value| value.to_string() == format!("O{}-H{}", row_index + 1, row_index + 1))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_and_blank_keys_pair_by_occurrence_without_cartesian_growth() {
        let dir = std::env::temp_dir().join(format!("fa-pairing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin, "编号,名称\nA,左1\nA,左2\n,空左1\n,空左2\n").unwrap();
        fs::write(&end, "编号,名称\nA,右1\nA,右2\nA,右3\n,空右1\n").unwrap();
        let result = merge(
            &json!({"beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        // A contributes max(2, 3) rows and blank keys contribute max(2, 1),
        // exactly like the legacy cumcount outer join (never 2*3 rows).
        assert_eq!(result.rows.len(), 5);
        assert_eq!(
            result
                .rows
                .iter()
                .filter(|row| row.source == "两文件都有")
                .count(),
            3
        );
        assert_eq!(
            result
                .rows
                .iter()
                .filter(|row| row.source == "仅文件1")
                .count(),
            1
        );
        assert_eq!(
            result
                .rows
                .iter()
                .filter(|row| row.source == "仅文件2")
                .count(),
            1
        );
        // Blank rows receive occurrence sequence keys (B1/B2) and are not
        // reported as business-key duplicates, matching the Python engine.
        assert_eq!(result.duplicate_values, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn monetary_residual_header_is_divided_by_original_even_below_100() {
        let dir = std::env::temp_dir().join(format!("fa-residual-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin, "编号,原值,残值率\nA,80,5%\n").unwrap();
        fs::write(&end, "编号,原值,残值\nA,80,4\n").unwrap();
        let params = json!({
            "beginPath":begin,"endPath":end,"beginKeys":["编号"],"endKeys":["编号"],
            "beginMapping":{"originalValue":"原值","residualRate":"残值率"},
            "endMapping":{"originalValue":"原值","residualRate":"残值"}
        });
        let result = merge(&params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        let row = &result.rows[0];
        assert!((mapped_residual_rate(&result, row, &params, 1, 80.0) - 0.05).abs() < 1e-9);
        assert!((mapped_residual_rate(&result, row, &params, 2, 80.0) - 0.05).abs() < 1e-9);
        let _ = fs::remove_dir_all(&dir);
    }
}
