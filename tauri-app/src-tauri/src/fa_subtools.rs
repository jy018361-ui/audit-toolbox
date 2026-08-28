//! 固定资产子工具：折旧测算（fa_dep_calc）与折旧政策对比（fa_policy_compare）。
//!
//! 两个工具都是 fa.rs 主流程的 **copy 而非 cut**：文件读取、字段建议、折旧测算
//! 公式块、"折旧期间"对比逻辑全部复用 fa.rs 的实现。本模块只新增两条精简流程
//! （单文件折旧测算导出、两期政策对比导出）、单文件 LLM 字段复核，以及税法
//! 最低折旧年限参考表。fa_list 主工具的行为不因本模块发生任何变化。

use chrono::Local;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, FormatUnderline, Url, Workbook};
use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;
use crate::fa;

/// 折旧测算的字段角色：(映射键名, LLM 角色名)。
/// 与主工具 file2（期末）侧的角色一致，但只保留单文件测算需要的 8 项——
/// 新增方式/新增日期属于两表匹配场景，折旧测算用不到。
const DEP_ROLES: [(&str, &str); 8] = [
    ("category", "category"),
    ("name", "name"),
    ("originalValue", "original_value"),
    ("depreciation", "depreciation"),
    ("startDate", "date"),
    ("life", "life"),
    ("residualRate", "residual"),
    ("currentYearDep", "current_year_dep"),
];

/// 折旧测算导出的固定列。列名刻意与 `append_depreciation_formulas` 要求的
/// 六个公式源表头（入账开始日期/使用寿命(月)/残值率/原值/累计折旧/本年折旧）
/// 完全一致，使公式块结构性必然命中，而不是靠巧合。
const DEP_SHEET_HEADERS: [&str; 8] = [
    "类别",
    "名称",
    "原值",
    "累计折旧",
    "入账开始日期",
    "使用寿命(月)",
    "残值率",
    "本年折旧",
];

/// 公式块必需的映射角色（中文标签用于报错文案）。
const DEP_REQUIRED_ROLES: [(&str, &str); 6] = [
    ("startDate", "入账开始日期"),
    ("life", "使用寿命"),
    ("originalValue", "原值"),
    ("depreciation", "累计折旧"),
    ("residualRate", "残值率"),
    ("currentYearDep", "本年折旧"),
];

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fa.dep_inspect" => dep_inspect(params),
        "fa.dep_review" => dep_review(params),
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
    progress: fa::Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let result = match method {
        "fa.dep_export" => dep_export(params, progress, cancel, pause),
        "fa.policy_export" => policy_export(params, progress, cancel, pause),
        _ => {
            return Err(error(
                "METHOD_NOT_FOUND",
                "未找到 Rust FA List 任务。",
                Some(method.into()),
            ));
        }
    };
    pause.wait()?;
    result
}

/// `fa.dep_inspect`：读取单份期末清单，返回结构预览与 8 角色的建议映射。
/// 形状与 `fa.supplement_inspect` 一致（headers/preview/sheets/…），前端可
/// 复用同一套预览与映射 UI。
fn dep_inspect(params: Value) -> Result<Value, AppError> {
    let path = fa::required_path(&params, "path")?;
    let table = fa::load_table(
        &path,
        params.get("sheet").and_then(Value::as_str),
        fa::optional_header(&params, "headerRow")?,
        true,
    )?;
    let suggested = fa::suggest_mapping(&table);
    let mut mapping = Map::new();
    for (mapping_key, _) in DEP_ROLES {
        if let Some(value) = suggested.get(mapping_key) {
            mapping.insert(mapping_key.to_owned(), value.clone());
        }
    }
    let mut result = fa::table_inspection(&table)
        .as_object()
        .cloned()
        .unwrap_or_default();
    result.insert("suggestedMapping".into(), Value::Object(mapping));
    result.insert("engine".into(), json!("rust-fa"));
    Ok(Value::Object(result))
}

/// `fa.dep_review`：单文件 LLM 字段复核。载荷刻意沿用 `file2` 这个键名——
/// 期末清单在主工具里就是 file2，`sanitize_llm_review_item`（按表头校验建议
/// 列存在性）与 `local_unmapped_suggestions`（本地规则兜底）因此零改动复用。
fn dep_review(params: Value) -> Result<Value, AppError> {
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
    let path = fa::required_path(&params, "path")?;
    let table = fa::load_table(
        &path,
        params.get("sheet").and_then(Value::as_str),
        fa::optional_header(&params, "headerRow")?,
        false,
    )?;
    let mapping = params.get("mapping").cloned().unwrap_or(json!({}));
    let payload = dep_llm_payload(&table, &mapping);
    let system = "你是固定资产折旧测算字段映射复核助手。只能使用 payload.file2.headers 中的原始列名，不得虚构。返回严格 JSON：{suggestions:[{role,file_side,suggested_column,confidence,action,reason}],fieldReviews:[{role,current_mapping,suggested_mapping,confidence,action,reason}]}。suggested_mapping 必须是 JSON 对象，例如 {\"file2\":\"资产原值\"}，禁止返回字符串或说明文字。角色仅 category/name/original_value/depreciation/date/life/residual/current_year_dep；file_side 固定为 file2；action 只能 fill/review/keep。必须逐项检查 payload.file2.unmappedRoles；若 headers 中存在可映射列，必须对该角色返回 action=fill 的建议，不能因表头规整就宣称全部映射正确。payload 中的 unmappedCandidates 是本地规则识别出的高可信候选，应优先复核并在合理时采用。只有所有已映射及未映射角色均已检查且确实无需调整时，才返回空数组。";
    let content = fa::request_fa_llm(&settings, system, &payload.to_string())?;
    let parsed = fa::parse_llm_json(&content).ok_or_else(|| {
        error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的 FA 映射 JSON。",
            None,
        )
    })?;
    Ok(dep_finalize_review(parsed, payload))
}

/// 单文件版 `main_llm_side_payload`：固定 8 角色，产 `file2` 一侧。
fn dep_llm_payload(table: &fa::Table, mapping: &Value) -> Value {
    let suggested = fa::suggest_mapping(table);
    let current = mapping.as_object();
    let mut unmapped_roles = Vec::new();
    let mut unmapped_candidates = Vec::new();
    for (mapping_key, role) in DEP_ROLES {
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
        "file2": {
            "headers": table.headers,
            "samples": fa::sample_columns(table),
            "mapping": mapping,
            "unmappedRoles": unmapped_roles,
            "unmappedCandidates": unmapped_candidates,
        }
    })
}

/// 与 fa.rs 的 `llm_item_targets` 相同（6 行小函数，不值得跨模块开放）。
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

/// 单文件版的适用性过滤：角色必须在 8 角色白名单内；`file_side` 缺省归一为
/// file2，其余丢弃；`suggested_mapping` 中的 file1 键剔除。
fn dep_review_item_is_applicable(item: &mut Value) -> bool {
    let role = item.get("role").and_then(Value::as_str).unwrap_or("");
    if !DEP_ROLES.iter().any(|(_, llm_role)| *llm_role == role) {
        return false;
    }
    match item.get_mut("file_side") {
        Some(Value::String(side)) if side == "file2" => {}
        Some(Value::String(_)) => return false,
        Some(other) => *other = json!("file2"),
        None => {}
    }
    if let Some(mapping) = item
        .get_mut("suggested_mapping")
        .and_then(Value::as_object_mut)
    {
        mapping.remove("file1");
    }
    true
}

/// 单文件版 `finalize_llm_review`：同一套 sanitize → 适用性过滤 → 本地兜底 →
/// 0.85+fill 自动应用分流；matchReview 固定 keep（单文件没有匹配键），保证
/// 前端复用主工具的复核 UI 时不走匹配键分支。
fn dep_finalize_review(parsed: Value, payload: Value) -> Value {
    let mut suggestions = parsed
        .get("suggestions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            fa::sanitize_llm_review_item(&mut item, &payload);
            dep_review_item_is_applicable(&mut item).then_some(item)
        })
        .collect::<Vec<_>>();
    let mut reviews = parsed
        .get("fieldReviews")
        .or_else(|| parsed.get("field_reviews"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|mut item| {
            fa::sanitize_llm_review_item(&mut item, &payload);
            dep_review_item_is_applicable(&mut item).then_some(item)
        })
        .collect::<Vec<_>>();
    for mut fallback in fa::local_unmapped_suggestions(&payload) {
        if !dep_review_item_is_applicable(&mut fallback) {
            continue;
        }
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
    let mut auto = Vec::new();
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
    let message = if auto.is_empty() && reviews.is_empty() {
        "LLM 复核完成：现有脚本映射无需补充。"
    } else {
        "折旧测算 LLM 复核完成。"
    };
    json!({
        "engine": "rust-fa",
        "enabled": true,
        "passed": reviews.is_empty(),
        "message": message,
        "autoApplied": auto,
        "fieldReviews": reviews,
        "matchReview": {
            "status": "ok",
            "confidence": 1,
            "action": "keep",
            "reasons": ["单文件工具，无匹配键需要复核"],
            "suggested_file1_columns": [],
            "suggested_file2_columns": [],
            "suggestion_reason": ""
        },
        "localProfile": payload
    })
}

/// `fa.dep_export`：单份期末清单 → 单页"折旧测算"工作簿（映射列 + 活公式块）。
fn dep_export(
    params: Value,
    progress: fa::Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let path = fa::required_path(&params, "path")?;
    let balance_sheet_date = params
        .get("balanceSheetDate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if fa::parse_fa_date(&balance_sheet_date).is_none() {
        return Err(error(
            "FA_DEP_DATE_INVALID",
            "请填写资产负债表日期（格式 YYYY-MM-DD）。",
            Some(balance_sheet_date),
        ));
    }
    progress("load", 0, 3, "正在读取期末固定资产清单");
    let table = fa::load_table(
        &path,
        params.get("sheet").and_then(Value::as_str),
        fa::optional_header(&params, "headerRow")?,
        false,
    )?;
    pause.wait()?;
    // 前置校验：公式块依赖六个映射列。fa.rs 的公式块在表头不齐时会静默跳过，
    // 专用工具必须在导出前把缺失说清楚，而不是产出一个没有测算列的"成功"文件。
    let mapping = params.get("mapping").cloned().unwrap_or(json!({}));
    let column_of = |role: &str| -> Option<usize> {
        mapping
            .get(role)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .and_then(|header| table.headers.iter().position(|x| x == header))
    };
    let mapped_header = |role: &str| -> Option<&str> {
        mapping
            .get(role)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
    };
    let mut missing: Vec<&str> = Vec::new();
    let mut stale: Vec<String> = Vec::new();
    for (role, label) in DEP_REQUIRED_ROLES {
        match (mapped_header(role), column_of(role)) {
            (Some(_), Some(_)) => {}
            (Some(header), None) => stale.push(header.to_owned()),
            (None, _) => missing.push(label),
        }
    }
    if !stale.is_empty() {
        return Err(error(
            "FA_DEP_MAPPING_STALE",
            format!(
                "映射的列“{}”已不在清单表头中，请重新读取文件并确认映射。",
                stale.join("”“")
            ),
            None,
        ));
    }
    if !missing.is_empty() {
        return Err(error(
            "FA_DEP_MAPPING_REQUIRED",
            format!("折旧测算需要先映射以下字段：{}。", missing.join("、")),
            None,
        ));
    }
    let category_index = column_of("category");
    let name_index = column_of("name");
    let original_index = column_of("originalValue");
    let depreciation_index = column_of("depreciation");
    let start_index = column_of("startDate");
    let life_index = column_of("life");
    let residual_index = column_of("residualRate");
    let current_index = column_of("currentYearDep");
    // 使用寿命按整列判定年→月换算（与主工具 life_scale_for_column 同口径）。
    let life_scale = life_index
        .and_then(|index| mapped_header("life").map(|header| (index, header)))
        .map(|(index, header)| {
            let values = table
                .rows
                .iter()
                .filter_map(|row| fa::parse_life_cell(fa::cell(row, index)))
                .collect::<Vec<_>>();
            fa::life_scale_for_column(header, &values)
        })
        .unwrap_or(1.0);
    // 残值率归一：表头明示"残值"（金额列）时除以原值，其余按比率归一——
    // 与主工具 mapped_residual_rate 的判定逐字一致。必须写小数：写表器对
    // 残值率列套 0.00% 格式，写 5 会显示成 500%。
    let residual_is_amount = {
        let normalized = fa::normalize_header(mapped_header("residualRate").unwrap_or(""));
        (normalized.contains("残值") && !normalized.contains("残值率"))
            || normalized.contains("residualvalue")
            || normalized.contains("salvagevalue")
    };
    progress("export", 1, 3, "正在生成折旧测算表");
    let mut rows = Vec::with_capacity(table.rows.len());
    for (row_index, row) in table.rows.iter().enumerate() {
        if row_index % 256 == 0 {
            fa::check_cancel(&cancel)?;
        }
        let original = original_index
            .map(|index| fa::number(fa::cell(row, index)))
            .unwrap_or(0.0);
        let depreciation = depreciation_index
            .map(|index| fa::number(fa::cell(row, index)).abs())
            .unwrap_or(0.0);
        let residual = residual_index
            .map(|index| {
                let raw = fa::number(fa::cell(row, index));
                if residual_is_amount && original.abs() > f64::EPSILON {
                    raw / original
                } else {
                    fa::residual_rate(raw, original)
                }
            })
            .unwrap_or(0.0);
        let life_months = life_index
            .map(|index| match fa::parse_life_cell(fa::cell(row, index)) {
                Some(value) if value > 0.0 => value * life_scale,
                _ => 0.0,
            })
            .unwrap_or(0.0);
        rows.push(vec![
            category_index
                .map(|index| fa::cell(row, index).trim().to_owned())
                .unwrap_or_default(),
            name_index
                .map(|index| fa::cell(row, index).trim().to_owned())
                .unwrap_or_default(),
            fa::display_number(original),
            fa::display_number(depreciation),
            start_index
                .map(|index| fa::display_date(fa::cell(row, index)))
                .unwrap_or_default(),
            fa::display_number(life_months),
            fa::display_number(residual),
            current_index
                .map(|index| fa::number(fa::cell(row, index)))
                .map(fa::display_number)
                .unwrap_or_else(|| "0".into()),
        ]);
    }
    let output = subtool_output_path(&params, &table.path, "折旧测算")?;
    let mut wb = Workbook::new();
    let header = header_format();
    fa::write_string_sheet_labelled(
        &mut wb,
        "折旧测算",
        &DEP_SHEET_HEADERS,
        &rows,
        &header,
        Some(&balance_sheet_date),
        Some(&cancel),
        None,
    )?;
    pause.wait()?;
    save_workbook(&mut wb, &output, &cancel)?;
    fa::check_cancel(&cancel)?;
    progress("completed", 3, 3, "折旧测算导出完成。");
    Ok(json!({
        "engine": "rust-fa",
        "message": "折旧测算导出完成。",
        "rows": rows.len(),
        "outputPaths": [output.to_string_lossy()],
    }))
}

/// `fa.policy_export`：期初+期末合并 → 单工作簿两页（折旧政策对比 + 税法参考）。
/// 匹配、映射与"折旧期间"的对比逻辑全部走 fa.rs 同一条代码路径；两表检查与
/// LLM 复核由前端直接复用现有 `fa.inspect` / `fa.review`，本方法只做导出。
fn policy_export(
    params: Value,
    progress: fa::Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let result = fa::merge(&params, progress, &cancel)?;
    pause.wait()?;
    fa::check_cancel(&cancel)?;
    progress("export", 3, 4, "正在生成折旧政策对比与税法参考");
    let end_path = fa::required_path(&params, "endPath")?;
    let output = subtool_output_path(&params, &end_path, "折旧政策对比")?;
    let mut wb = Workbook::new();
    let header = header_format();
    fa::write_depreciation_period_sheet(
        &mut wb,
        &result,
        &params,
        &header,
        &cancel,
        "折旧政策对比",
    )?;
    fa::check_cancel(&cancel)?;
    write_tax_reference_sheet(&mut wb, &header)?;
    pause.wait()?;
    save_workbook(&mut wb, &output, &cancel)?;
    fa::check_cancel(&cancel)?;
    progress("completed", 4, 4, "折旧政策对比导出完成。");
    Ok(json!({
        "engine": "rust-fa",
        "message": "折旧政策对比导出完成。",
        "outputPaths": [output.to_string_lossy()],
    }))
}

/// 官方政策库链接（国家税务总局政策法规库，2026-08 逐条核对可访问）。
const TAX_URL_IMPLEMENTING_REGULATIONS: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c100010/c5194417/content.html";
const TAX_URL_CAISHUI_2012_27: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5204290/content.html";
const TAX_URL_CAISHUI_2018_54: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202450/content.html";
/// 2023 年第 37 号公告未单独出现在总局法规库检索里，链接用上海局政策库页面。
const TAX_URL_ANNOUNCEMENT_2023_37: &str =
    "https://shanghai.chinatax.gov.cn/zcfw/zcfgk/qysds/202309/t468599.html";
const TAX_URL_CAISHUI_2014_75: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5204014/content.html";
const TAX_URL_ANNOUNCEMENT_2019_66: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5202306/content.html";
const TAX_URL_ANNOUNCEMENT_2014_64: &str =
    "https://fgk.chinatax.gov.cn/zcfgk/c100012/c5194499/content.html";
/// 财税〔2015〕106 号（四领域加速折旧）未入总局法规库检索，链接用广东局政策文件页。
/// 注意文号是 106：常被误写为 116（116 号是技术转让所得文件）。
const TAX_URL_CAISHUI_2015_106: &str = "https://guangdong.chinatax.gov.cn/gdsw/zjfg/2015-10/08/content_b250576dc1c04b02b212041a32dac263.shtml";

/// 实施条例第六十条：固定资产五类最低折旧年限。
const TAX_TEXT_ARTICLE_60: &str = "除国务院财政、税务主管部门另有规定外，固定资产计算折旧的最低年限如下：（一）房屋、建筑物，为20年；（二）飞机、火车、轮船、机器、机械和其他生产设备，为10年；（三）与生产经营活动有关的器具、工具、家具等，为5年；（四）飞机、火车、轮船以外的运输工具，为4年；（五）电子设备，为3年。";
/// 实施条例第六十七条：无形资产摊销。
const TAX_TEXT_ARTICLE_67: &str = "无形资产按照直线法计算的摊销费用，准予扣除。无形资产的摊销年限不得低于10年。作为投资或者受让的无形资产，有关法律规定或者合同约定了使用年限的，可以按照规定或者约定的使用年限分期摊销。外购商誉的支出，在企业整体转让或者清算时，准予扣除。";
/// 财税〔2012〕27 号第七条：外购软件。
const TAX_TEXT_CS27_ARTICLE_7: &str = "企业外购的软件，凡符合固定资产或无形资产确认条件的，可以按照固定资产或无形资产进行核算，其折旧或摊销年限可以适当缩短，最短可为2年（含）。";
/// 财税〔2012〕27 号第八条：集成电路生产设备。
const TAX_TEXT_CS27_ARTICLE_8: &str =
    "集成电路生产企业的生产设备，经主管税务机关核准，其折旧年限可以适当缩短，最短可为3年（含）。";
/// 财税〔2018〕54 号第一条：500 万元以下设备器具一次性扣除。
const TAX_TEXT_CS54_ARTICLE_1: &str = "企业在2018年1月1日至2020年12月31日期间新购进的设备、器具，单位价值不超过500万元的，允许一次性计入当期成本费用在计算应纳税所得额时扣除，不再分年度计算折旧；单位价值超过500万元的，仍按企业所得税法实施条例、《财政部 国家税务总局关于完善固定资产加速折旧企业所得税政策的通知》（财税〔2014〕75号）、《财政部 国家税务总局关于进一步完善固定资产加速折旧企业所得税政策的通知》（财税〔2015〕116号）等相关规定执行。本通知所称设备、器具，是指除房屋、建筑物以外的固定资产。";
/// 实施条例第五十九条：直线法折旧与预计净残值（残值率两期对比的政策依据）。
const TAX_TEXT_ARTICLE_59: &str = "固定资产按照直线法计算的折旧，准予扣除。企业应当自固定资产投入使用月份的次月起计算折旧；停止使用的固定资产，应当自停止使用月份的次月起停止计算折旧。企业应当根据固定资产的性质和使用情况，合理确定固定资产的预计净残值。固定资产的预计净残值一经确定，不得变更。";
/// 实施条例第六十四条：生产性生物资产最低折旧年限。
const TAX_TEXT_ARTICLE_64: &str = "生产性生物资产计算折旧的最低年限如下：（一）林木类生产性生物资产，为10年；（二）畜类生产性生物资产，为3年。";
/// 实施条例第九十八条：加速折旧的一般规定（60% 底线与两种加速方法）。
const TAX_TEXT_ARTICLE_98: &str = "企业所得税法第三十二条规定的可以采取缩短折旧年限或者加速折旧方法的固定资产，包括：（一）由于技术进步等原因，确需加速折旧的固定资产；（二）常年处于强震动、高腐蚀状态的固定资产。采取缩短折旧年限方法的，最低折旧年限不得低于本条例第六十条规定折旧年限的60%；采取加速折旧方法的，可以采取双倍余额递减法或者年数总和法。";
/// 财税〔2014〕75 号第一条：六大行业加速折旧与小微研发共用仪器设备一次性扣除。
const TAX_TEXT_CS75_ARTICLE_1: &str = "对生物药品制造业，专用设备制造业，铁路、船舶、航空航天和其他运输设备制造业，计算机、通信和其他电子设备制造业，仪器仪表制造业，信息传输、软件和信息技术服务业等六个行业的企业2014年1月1日后新购进的固定资产，允许缩短折旧年限或采取加速折旧方法。对上述行业的小型微利企业2014年1月1日后新购进的研发和生产经营共用的仪器、设备，单位价值不超过100万元的，允许一次性计入当期成本费用在计算应纳税所得额时扣除，不再分年度计算折旧。";
/// 财税〔2014〕75 号第二条：专门用于研发的仪器设备 ≤100 万元一次性扣除。
const TAX_TEXT_CS75_ARTICLE_2: &str = "所有行业企业2014年1月1日后新购进的专门用于研发的仪器、设备，单位价值不超过100万元的，允许一次性计入当期成本费用在计算应纳税所得额时扣除，不再分年度计算折旧；单位价值超过100万元的，可缩短折旧年限或采取加速折旧方法。";
/// 财税〔2014〕75 号第三条：≤5000 元固定资产一次性扣除（长期有效）。
const TAX_TEXT_CS75_ARTICLE_3: &str = "对所有行业企业持有的单位价值不超过5000元的固定资产，允许一次性计入当期成本费用在计算应纳税所得额时扣除，不再分年度计算折旧。";
/// 2019 年第 66 号公告第一条：加速折旧行业范围扩大至全部制造业。
const TAX_TEXT_ANNOUNCEMENT_2019_66: &str = "自2019年1月1日起，适用《财政部 国家税务总局关于完善固定资产加速折旧企业所得税政策的通知》（财税〔2014〕75号）和《财政部 国家税务总局关于进一步完善固定资产加速折旧企业所得税政策的通知》（财税〔2015〕106号）规定固定资产加速折旧优惠的行业范围，扩大至全部制造业领域。";
/// 国家税务总局公告 2014 年第 64 号第四条：购置已使用过固定资产的最低折旧年限。
const TAX_TEXT_ANNOUNCEMENT_2014_64: &str = "企业购置已使用过的固定资产，其最低折旧年限不得低于实施条例规定的最低折旧年限减去已使用年限后剩余年限的60%。最低折旧年限一经确定，一般不得变更。";

/// 税法最低折旧/摊销年限静态参考表的一行。
/// 依据：《企业所得税法实施条例》第五十九条（净残值一经确定不得变更）、
/// 第六十条（固定资产五类最低年限）、第六十四条（生产性生物资产）、第六十七条
/// （无形资产摊销不低于 10 年）、第九十八条（加速折旧 60% 底线）；财税〔2012〕
/// 27 号第七条（外购软件最短 2 年）与第八条（集成电路生产设备最短 3 年）；
/// 财税〔2018〕54 号第一条及 2023 年第 37 号公告（500 万元以下一次性扣除，
/// 延续至 2027-12-31）；财税〔2014〕75 号（研发设备 100 万/5000 元一次性扣除、
/// 六大行业加速折旧）；2019 年第 66 号公告（加速折旧扩大至全部制造业）；
/// 国家税务总局公告 2014 年第 64 号（已使用过固定资产按剩余年限 60% 定最低年限）。
struct TaxReferenceRow {
    /// A 资产类别。
    category: &'static str,
    /// B 最低折旧/摊销年限。
    minimum: &'static str,
    /// C 法规依据：同文号的连续行纵向合并成一个可点击单元格。
    regulation: &'static str,
    /// C 列挂的官方原文链接（同一文号的合并区只挂首行一次）。
    url: &'static str,
    /// D 条款：同文号同条款的连续行纵向合并。
    article: &'static str,
    /// E 政策原文：该条款与折旧/摊销年限直接相关的原文。
    text: &'static str,
    /// F 备注。
    note: &'static str,
    /// F 备注挂的链接（如 54 号政策延续公告），空则写纯文本。
    note_url: &'static str,
}

const TAX_REFERENCE_ROWS: [TaxReferenceRow; 18] = [
    // ——《企业所得税法实施条例》块（C 列整体合并）——
    TaxReferenceRow {
        category: "房屋、建筑物",
        minimum: "20年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十条",
        text: TAX_TEXT_ARTICLE_60,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "飞机、火车、轮船、机器、机械和其他生产设备",
        minimum: "10年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十条",
        text: TAX_TEXT_ARTICLE_60,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "与生产经营活动有关的器具、工具、家具等",
        minimum: "5年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十条",
        text: TAX_TEXT_ARTICLE_60,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "飞机、火车、轮船以外的运输工具",
        minimum: "4年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十条",
        text: TAX_TEXT_ARTICLE_60,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "电子设备",
        minimum: "3年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十条",
        text: TAX_TEXT_ARTICLE_60,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "无形资产",
        minimum: "摊销年限不得低于10年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十七条",
        text: TAX_TEXT_ARTICLE_67,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "林木类生产性生物资产",
        minimum: "10年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十四条",
        text: TAX_TEXT_ARTICLE_64,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "畜类生产性生物资产",
        minimum: "3年",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第六十四条",
        text: TAX_TEXT_ARTICLE_64,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "固定资产预计净残值",
        minimum: "由企业合理确定，税法未规定统一比例",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第五十九条",
        text: TAX_TEXT_ARTICLE_59,
        note: "与折旧政策对比页的残值率两期对比联动：预计净残值一经确定不得变更",
        note_url: "",
    },
    TaxReferenceRow {
        category: "确需加速折旧的固定资产（技术进步、常年强震动高腐蚀）",
        minimum: "缩短折旧年限最低不得低于法定年限的60%，或采用双倍余额递减法/年数总和法",
        regulation: "《企业所得税法实施条例》",
        url: TAX_URL_IMPLEMENTING_REGULATIONS,
        article: "第九十八条",
        text: TAX_TEXT_ARTICLE_98,
        note: "",
        note_url: "",
    },
    // ——财税〔2012〕27号块——
    TaxReferenceRow {
        category: "外购软件（符合固定资产或无形资产确认条件）",
        minimum: "折旧或摊销年限最短可为2年（含2年）",
        regulation: "财税〔2012〕27号",
        url: TAX_URL_CAISHUI_2012_27,
        article: "第七条",
        text: TAX_TEXT_CS27_ARTICLE_7,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "集成电路生产企业的生产设备",
        minimum: "折旧年限最短可为3年（含3年）",
        regulation: "财税〔2012〕27号",
        url: TAX_URL_CAISHUI_2012_27,
        // 27 号文里外购软件是第七条、集成电路生产设备是第八条，此前两行都写
        // 第七条是引错条款。
        article: "第八条",
        text: TAX_TEXT_CS27_ARTICLE_8,
        note: "",
        note_url: "",
    },
    // ——财税〔2018〕54号块——
    TaxReferenceRow {
        category: "单位价值不超过500万元的新购进设备、器具",
        minimum: "允许一次性计入当期成本费用在计算应纳税所得额时扣除",
        regulation: "财税〔2018〕54号",
        url: TAX_URL_CAISHUI_2018_54,
        article: "第一条",
        text: TAX_TEXT_CS54_ARTICLE_1,
        note: "政策延续至2027年12月31日（财政部 税务总局公告2023年第37号）",
        note_url: TAX_URL_ANNOUNCEMENT_2023_37,
    },
    // ——财税〔2014〕75号块——
    TaxReferenceRow {
        category: "六大行业小型微利企业研发与生产经营共用的仪器、设备（单位价值≤100万元）",
        minimum: "允许一次性计入当期成本费用在计算应纳税所得额时扣除",
        regulation: "财税〔2014〕75号",
        url: TAX_URL_CAISHUI_2014_75,
        article: "第一条",
        text: TAX_TEXT_CS75_ARTICLE_1,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "专门用于研发的仪器、设备（单位价值≤100万元，全行业）",
        minimum: "允许一次性计入当期成本费用在计算应纳税所得额时扣除",
        regulation: "财税〔2014〕75号",
        url: TAX_URL_CAISHUI_2014_75,
        article: "第二条",
        text: TAX_TEXT_CS75_ARTICLE_2,
        note: "",
        note_url: "",
    },
    TaxReferenceRow {
        category: "单位价值不超过5000元的固定资产（全行业，长期有效）",
        minimum: "允许一次性计入当期成本费用在计算应纳税所得额时扣除",
        regulation: "财税〔2014〕75号",
        url: TAX_URL_CAISHUI_2014_75,
        article: "第三条",
        text: TAX_TEXT_CS75_ARTICLE_3,
        note: "",
        note_url: "",
    },
    // ——2019年第66号公告：制造业加速折旧——
    TaxReferenceRow {
        category: "制造业企业新购进的固定资产（2019年起全部制造业领域）",
        minimum: "可缩短折旧年限或加速折旧；缩短后不得低于法定最低年限的60%（财税〔2014〕75号第四条）",
        regulation: "财政部 税务总局公告2019年第66号",
        url: TAX_URL_ANNOUNCEMENT_2019_66,
        article: "第一条",
        text: TAX_TEXT_ANNOUNCEMENT_2019_66,
        note: "行业范围演进：财税〔2014〕75号（六大行业）→财税〔2015〕106号（轻工、纺织、机械、汽车四领域）→全部制造业",
        note_url: TAX_URL_CAISHUI_2015_106,
    },
    // ——2014年第64号公告：已使用过的固定资产——
    TaxReferenceRow {
        category: "购置的已使用过的固定资产",
        minimum: "最低折旧年限不得低于（法定最低年限－已使用年限）×60%",
        regulation: "国家税务总局公告2014年第64号",
        url: TAX_URL_ANNOUNCEMENT_2014_64,
        article: "第四条",
        text: TAX_TEXT_ANNOUNCEMENT_2014_64,
        note: "",
        note_url: "",
    },
];

/// 把连续"同组"的行折叠成 (首行, 末行) 区间——同文号/同条款纵向合并的分组依据。
fn consecutive_runs<T>(rows: &[T], same_group: impl Fn(&T, &T) -> bool) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut start = 0;
    while start < rows.len() {
        let mut end = start + 1;
        while end < rows.len() && same_group(&rows[end], &rows[start]) {
            end += 1;
        }
        runs.push((start, end - 1));
        start = end;
    }
    runs
}

/// 估算按列宽折行后的行数：非 ASCII 字符按 2 个宽度单位计（Excel 列宽单位≈一个半角字符）。
fn wrapped_lines(text: &str, column_width: f64) -> usize {
    let units: f64 = text
        .chars()
        .map(|ch| if ch.is_ascii() { 1.0 } else { 2.0 })
        .sum();
    let per_line = (column_width - 2.0).max(4.0);
    (units / per_line).ceil() as usize
}

/// 写"税法最低折旧年限参考"页。
///
/// 不走 `write_string_sheet_labelled`：那套写表器面向"每列一个数据来源"的动态
/// 表，给本页整行盖了名不副实的"法规原文"标注，而表里其实没有原文。本页用
/// 专用写表器满足三个诉求：
/// - C 列法规依据挂政策库官方链接（同文号纵向合并，点击打开原文）；
/// - D 条款 + E 政策原文：同文号同条款纵向合并，E 列填条款原文；
/// - F 备注（54 号延续公告也可点击）。
fn write_tax_reference_sheet(wb: &mut Workbook, header: &Format) -> Result<(), AppError> {
    const HEADERS: [&str; 6] = [
        "资产类别",
        "最低折旧/摊销年限",
        "法规依据",
        "条款",
        "政策原文",
        "备注",
    ];
    const LABELS: [&str; 6] = [
        "税法统一规定",
        "税法统一规定",
        "点击可打开官方原文",
        "条款编号",
        "法规条款原文",
        "补充说明",
    ];
    const WIDTHS: [f64; 6] = [30.0, 26.0, 24.0, 10.0, 64.0, 36.0];
    let first_data_row = 2u32;
    let ws = wb.add_worksheet();
    ws.set_name("税法最低折旧年限参考").map_err(xlsx_error)?;
    let source_format = Format::new()
        .set_italic()
        .set_font_color("#374151")
        .set_background_color("#F7F8FA")
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left);
    let cell_format = Format::new()
        .set_border(FormatBorder::Thin)
        .set_text_wrap()
        .set_align(FormatAlign::Left)
        .set_align(FormatAlign::VerticalCenter);
    let link_format = cell_format
        .clone()
        .set_font_color("#0563C1")
        .set_underline(FormatUnderline::Single);
    let note_format = Format::new()
        .set_background_color("#F6F6F6")
        .set_border(FormatBorder::Thin)
        .set_text_wrap();
    for (c, (name, label)) in HEADERS.iter().zip(LABELS.iter()).enumerate() {
        ws.write_string_with_format(0, c as u16, *name, header)
            .map_err(xlsx_error)?;
        ws.write_string_with_format(1, c as u16, *label, &source_format)
            .map_err(xlsx_error)?;
    }
    let rows = &TAX_REFERENCE_ROWS;
    for (index, row) in rows.iter().enumerate() {
        let r = first_data_row + index as u32;
        ws.write_string_with_format(r, 0, row.category, &cell_format)
            .map_err(xlsx_error)?;
        ws.write_string_with_format(r, 1, row.minimum, &cell_format)
            .map_err(xlsx_error)?;
        if row.note.is_empty() {
            ws.write_string_with_format(r, 5, "", &cell_format)
                .map_err(xlsx_error)?;
        } else if row.note_url.is_empty() {
            ws.write_string_with_format(r, 5, row.note, &cell_format)
                .map_err(xlsx_error)?;
        } else {
            let url = Url::new(row.note_url).set_text(row.note);
            ws.write_url_with_format(r, 5, url, &link_format)
                .map_err(xlsx_error)?;
        }
    }
    // C 列：同文号纵向合并，首格挂官方链接（合并区只保留首格的值与链接）。
    for (start, end) in consecutive_runs(rows, |a, b| a.regulation == b.regulation) {
        let r1 = first_data_row + start as u32;
        let r2 = first_data_row + end as u32;
        let url = Url::new(rows[start].url).set_text(rows[start].regulation);
        if r2 > r1 {
            ws.merge_range(r1, 2, r2, 2, rows[start].regulation, &link_format)
                .map_err(xlsx_error)?;
        }
        ws.write_url_with_format(r1, 2, url, &link_format)
            .map_err(xlsx_error)?;
    }
    // 行高：先按各行 A/B/F 自身内容定基准，再按 E 列原文的折行需求把总高度
    // 均摊进对应合并区——合并单元格 Excel 不会自动调整行高。
    let mut heights: Vec<f64> = rows
        .iter()
        .map(|row| {
            let own = [
                wrapped_lines(row.category, WIDTHS[0]),
                wrapped_lines(row.minimum, WIDTHS[1]),
                wrapped_lines(row.note, WIDTHS[5]),
            ]
            .into_iter()
            .filter(|lines| *lines > 0)
            .max()
            .unwrap_or(1);
            (own as f64 * 15.0 + 11.0).max(26.0)
        })
        .collect();
    for (start, end) in consecutive_runs(rows, |a, b| {
        a.regulation == b.regulation && a.article == b.article
    }) {
        let r1 = first_data_row + start as u32;
        let r2 = first_data_row + end as u32;
        if r2 > r1 {
            ws.merge_range(r1, 3, r2, 3, rows[start].article, &cell_format)
                .map_err(xlsx_error)?;
            ws.merge_range(r1, 4, r2, 4, rows[start].text, &cell_format)
                .map_err(xlsx_error)?;
        } else {
            ws.write_string_with_format(r1, 3, rows[start].article, &cell_format)
                .map_err(xlsx_error)?;
            ws.write_string_with_format(r1, 4, rows[start].text, &cell_format)
                .map_err(xlsx_error)?;
        }
        let needed = wrapped_lines(rows[start].text, WIDTHS[4]) as f64 * 15.0 + 12.0;
        let per_row = (needed / (end - start + 1) as f64).ceil();
        for r in r1..=r2 {
            heights[(r - first_data_row) as usize] =
                (heights[(r - first_data_row) as usize]).max(per_row);
        }
    }
    for (index, height) in heights.iter().enumerate() {
        ws.set_row_height(first_data_row + index as u32, *height)
            .map_err(xlsx_error)?;
    }
    ws.set_freeze_panes(2, 0).map_err(xlsx_error)?;
    for (c, width) in WIDTHS.iter().enumerate() {
        ws.set_column_width(c as u16, *width).map_err(xlsx_error)?;
    }
    // 本表说明与主套表同款：标签 + 灰底合并正文，上方留一条窄空行。
    let note_row = first_data_row + rows.len() as u32 + 1;
    ws.set_row_height(note_row - 1, 8.0).map_err(xlsx_error)?;
    ws.write_string_with_format(note_row, 0, "本表说明", header)
        .map_err(xlsx_error)?;
    let note = "列示税法规定的固定资产、无形资产与生产性生物资产最低折旧/摊销年限、加速折旧底线及一次性扣除政策，供折旧政策对比参考。 信息来源：《企业所得税法实施条例》第五十九条、第六十条、第六十四条、第六十七条、第九十八条；财税〔2012〕27号；财税〔2014〕75号；财政部 税务总局公告2019年第66号；国家税务总局公告2014年第64号；财税〔2018〕54号及延续公告（点击“法规依据”列可打开官方原文）。 重点关注：政策适用期间以有效文件为准，请结合折旧政策对比页使用。";
    ws.merge_range(note_row, 1, note_row, 4, note, &note_format)
        .map_err(xlsx_error)?;
    ws.set_row_height(note_row, 72.0).map_err(xlsx_error)?;
    Ok(())
}

fn header_format() -> Format {
    Format::new()
        .set_bold()
        .set_background_color(fa::LEGACY_HEADER_FILL)
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Left)
}

/// 子工具的输出路径：优先用户指定（无扩展名补 xlsx），否则在源文件旁生成
/// `<前缀>_<YYYYMMDD_HHMMSS>.xlsx`——与 fa.rs `output_path` 同一口径。
fn subtool_output_path(params: &Value, source: &Path, prefix: &str) -> Result<PathBuf, AppError> {
    if let Some(value) = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        let mut path = PathBuf::from(value);
        if path.extension().is_none() {
            path.set_extension("xlsx");
        }
        return Ok(path);
    }
    Ok(source.parent().unwrap_or(Path::new(".")).join(format!(
        "{prefix}_{}.xlsx",
        Local::now().format("%Y%m%d_%H%M%S")
    )))
}

/// 原子写出：先写 `.xlsx.partial`，确认未取消后再替换（沿用 fa.rs 的
/// 备份回滚实现），绝不直接覆盖用户文件。
fn save_workbook(wb: &mut Workbook, output: &Path, cancel: &AtomicBool) -> Result<(), AppError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(fa::io_error)?;
    }
    let partial = output.with_extension("xlsx.partial");
    wb.save(&partial).map_err(xlsx_error)?;
    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&partial);
        return fa::check_cancel(cancel);
    }
    fa::replace_output(&partial, output)
}

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

fn xlsx_error(e: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "FA_EXPORT_FAILED",
        "生成 Excel 文件失败。",
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn run_job_quiet(method: &str, params: Value) -> Result<Value, AppError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        run_job(method, params, &|_, _, _, _| {}, cancel, &pause)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn zip_entry(path: &Path, entry: &str) -> String {
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

    /// 按名称定位 sheet 的 zip entry（如 `xl/worksheets/sheet2.xml`）：
    /// workbook.xml 拿 r:id，rels 拿目标文件。
    fn sheet_entry_by_name(path: &Path, name: &str) -> String {
        let workbook = zip_entry(path, "xl/workbook.xml");
        let sheet_fragment = workbook
            .split("<sheet ")
            .find(|fragment| fragment.contains(&format!("name=\"{name}\"")))
            .unwrap_or_else(|| panic!("sheet {name} not found"));
        let rid = sheet_fragment
            .split("r:id=\"")
            .nth(1)
            .and_then(|value| value.split('"').next())
            .unwrap_or_else(|| panic!("sheet {name} has no r:id"));
        let rels = zip_entry(path, "xl/_rels/workbook.xml.rels");
        let target = rels
            .split("<Relationship ")
            .find(|fragment| fragment.contains(&format!("Id=\"{rid}\"")))
            .and_then(|fragment| fragment.split("Target=\"").nth(1))
            .and_then(|value| value.split('"').next())
            .unwrap_or_else(|| panic!("relationship {rid} has no target"));
        if let Some(stripped) = target.strip_prefix("/xl/") {
            stripped.to_owned()
        } else {
            format!("xl/{target}")
        }
    }

    fn sheet_xml_by_name(path: &Path, name: &str) -> String {
        zip_entry(path, &sheet_entry_by_name(path, name))
    }

    /// 工作表超链接的 External 目标只存在 rels 文件里，sheet xml 本身没有。
    fn sheet_hyperlinks_by_name(path: &Path, name: &str) -> String {
        let entry = sheet_entry_by_name(path, name);
        let file = entry.rsplit('/').next().unwrap_or_default();
        zip_entry(path, &format!("xl/worksheets/_rels/{file}.rels"))
    }

    /// 解析 sharedStrings：跨工作簿比对时把 `t="s"` 单元的索引还原成文本。
    fn shared_strings(path: &Path) -> Vec<String> {
        let xml = zip_entry(path, "xl/sharedStrings.xml");
        xml.split("<si>")
            .skip(1)
            .map(|entry| {
                entry
                    .split("</si>")
                    .next()
                    .unwrap_or("")
                    .split("<t")
                    .skip(1)
                    .map(|run| {
                        run.split('>')
                            .nth(1)
                            .and_then(|rest| rest.split('<').next())
                            .unwrap_or("")
                    })
                    .collect::<String>()
            })
            .collect()
    }

    /// 把一行 sheet xml 还原成"列引用=文本"序列（解析共享字符串与数值）。
    fn row_cells_resolved(row_xml: &str, strings: &[String]) -> Vec<String> {
        row_xml
            .split("<c ")
            .skip(1)
            .map(|cell| {
                let col = cell
                    .split("r=\"")
                    .nth(1)
                    .and_then(|rest| rest.split(|c: char| c.is_ascii_digit()).next())
                    .unwrap_or("")
                    .to_owned();
                let raw = cell
                    .split("<v>")
                    .nth(1)
                    .and_then(|value| value.split('<').next())
                    .unwrap_or("");
                let text = if cell.contains("t=\"s\"") {
                    raw.parse::<usize>()
                        .ok()
                        .and_then(|index| strings.get(index).cloned())
                        .unwrap_or_default()
                } else {
                    raw.to_owned()
                };
                format!("{col}={text}")
            })
            .collect()
    }

    const DEP_CSV: &str = "资产类别,资产名称,原值,累计折旧,入账开始日期,使用寿命,残值率,本年折旧\n\
        房屋及建筑物,实验楼A,1000000,200000,2020-01-01,240,5%,10000\n\
        电子设备,服务器B,50000,30000,2023-06-15,,5%,8000\n";

    fn dep_params(dir: &Path) -> Value {
        let source = dir.join("期末清单.csv");
        fs::write(&source, DEP_CSV).unwrap();
        json!({
            "path": source.to_string_lossy(),
            "headerRow": 1,
            "mapping": {
                "category": "资产类别",
                "name": "资产名称",
                "originalValue": "原值",
                "depreciation": "累计折旧",
                "startDate": "入账开始日期",
                "life": "使用寿命",
                "residualRate": "残值率",
                "currentYearDep": "本年折旧"
            },
            "balanceSheetDate": "2025-12-31",
            "outputPath": dir.join("折旧测算.xlsx").to_string_lossy(),
        })
    }

    #[test]
    fn dep_inspect_suggests_dep_mapping_and_drops_irrelevant_roles() {
        let dir = temp_dir("fa-subtools-dep-inspect");
        let source = dir.join("期末清单.csv");
        fs::write(&source, DEP_CSV).unwrap();
        let value = call(
            "fa.dep_inspect",
            json!({"path": source.to_string_lossy(), "headerRow": 1}),
        )
        .unwrap();
        let mapping = &value["suggestedMapping"];
        assert_eq!(mapping["originalValue"], json!("原值"));
        assert_eq!(mapping["startDate"], json!("入账开始日期"));
        assert_eq!(mapping["currentYearDep"], json!("本年折旧"));
        // 主工具 file2 独有的新增角色不属于折旧测算，必须剔除。
        assert!(mapping.get("additionMethod").is_none());
        assert!(mapping.get("additionDate").is_none());
        assert!(mapping.get("matchKey").is_none());
        assert_eq!(value["engine"], json!("rust-fa"));
        assert_eq!(value["dimensions"]["rows"], json!(2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dep_review_disabled_llm_returns_contract_shape() {
        let value = call(
            "fa.dep_review",
            json!({"__settings": {"llm": {"enabled": false}}}),
        )
        .unwrap();
        assert_eq!(value["enabled"], json!(false));
        assert_eq!(value["passed"], json!(true));
        assert!(value["message"].as_str().unwrap().contains("未启用"));
        assert_eq!(value["autoApplied"], json!([]));
        assert_eq!(value["fieldReviews"], json!([]));
    }

    #[test]
    fn dep_review_finalizes_roles_sides_and_local_fallbacks() {
        let dir = temp_dir("fa-subtools-dep-review");
        let source = dir.join("期末清单.csv");
        fs::write(&source, DEP_CSV).unwrap();
        let table = fa::load_table(&source, None, Some(1), false).unwrap();
        let payload = dep_llm_payload(&table, &json!({"category": "资产类别"}));
        let parsed = json!({
            "suggestions": [
                {"role": "life", "file_side": "file2", "suggested_column": "使用寿命", "confidence": 0.9, "action": "fill", "reason": "列名吻合"},
                {"role": "original_value", "file_side": "file1", "suggested_column": "原值", "confidence": 0.9, "action": "fill", "reason": "单文件没有 file1"},
                {"role": "addition_method", "file_side": "file2", "suggested_column": "资产名称", "confidence": 0.99, "action": "fill", "reason": "不属于折旧测算角色"}
            ],
            "fieldReviews": []
        });
        let value = dep_finalize_review(parsed, payload);
        let auto = value["autoApplied"].as_array().unwrap();
        let reviews = value["fieldReviews"].as_array().unwrap();
        // LLM 的 life 建议高把握 fill，直接进自动应用。
        assert!(
            auto.iter()
                .any(|item| item["role"] == json!("life") && item["confidence"] == json!(0.9))
        );
        // file1 侧与 8 角色之外的建议必须被丢弃；其余一律不得携带 file1。
        let allowed = [
            "category",
            "name",
            "original_value",
            "depreciation",
            "date",
            "life",
            "residual",
            "current_year_dep",
        ];
        for item in auto.iter().chain(reviews.iter()) {
            let role = item["role"].as_str().unwrap();
            assert!(allowed.contains(&role), "越权角色进入了复核结果：{role}");
            assert_ne!(item["file_side"], json!("file1"));
        }
        // 未映射且有本地候选的角色由规则兜底（0.95 fill，同样自动应用）；
        // category 已映射，不应再出现兜底。
        assert!(
            auto.iter()
                .any(|item| item["role"] == json!("name") && item["action"] == json!("fill"))
        );
        assert!(!auto.iter().any(|item| item["role"] == json!("category")));
        // matchReview 固定 keep，前端规划器不会进入匹配键分支。
        assert_eq!(value["matchReview"]["action"], json!("keep"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dep_export_writes_measurement_block_with_live_formulas() {
        let dir = temp_dir("fa-subtools-dep-export");
        let params = dep_params(&dir);
        let value = run_job_quiet("fa.dep_export", params).unwrap();
        assert_eq!(value["rows"], json!(2));
        let output = dir.join("折旧测算.xlsx");
        assert!(output.is_file());
        let sheet = sheet_xml_by_name(&output, "折旧测算");
        // 公式块紧跟 8 列映射字段（第 9 列 J 起，中间留一格间隔列）。
        assert!(sheet.contains("r=\"J3\""));
        // 活公式：月折旧额与资产负债表日截止必须真实出现在单元格里。
        assert!(sheet.contains("<f>IFERROR(ROUND(C3"));
        assert!(sheet.contains("DATEVALUE(\"2025-12-31\")"));
        assert!(sheet.contains("EDATE("));
        // 残值率必须写小数（写表器套 0.00% 格式，写 5 会显示 500%）。
        assert!(sheet.contains("<v>0.05</v>"));
        // 使用寿命按整列换算成年月口径：240 月保持 240；缺寿命行写 0。
        assert!(sheet.contains("<v>240</v>"));
        assert!(sheet.contains("<v>0</v>"));
        // 累计折旧取绝对值（ERP 负数口径同主工具）。
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dep_export_caps_formulas_and_writes_notice() {
        let dir = temp_dir("fa-subtools-dep-cap");
        let source = dir.join("期末清单.csv");
        let mut lines = Vec::new();
        lines.push(
            "资产类别,资产名称,原值,累计折旧,入账开始日期,使用寿命,残值率,本年折旧".to_owned(),
        );
        for index in 0..20_001 {
            let accumulated = index % 100;
            lines.push(format!(
                "电子设备,服务器{index},1000,{accumulated},2024-01-01,36,5%,10"
            ));
        }
        fs::write(&source, lines.join("\n")).unwrap();
        let params = json!({
            "path": source.to_string_lossy(),
            "headerRow": 1,
            "mapping": {
                "category": "资产类别",
                "name": "资产名称",
                "originalValue": "原值",
                "depreciation": "累计折旧",
                "startDate": "入账开始日期",
                "life": "使用寿命",
                "residualRate": "残值率",
                "currentYearDep": "本年折旧"
            },
            "balanceSheetDate": "2025-12-31",
        });
        let value = run_job_quiet("fa.dep_export", params).unwrap();
        assert_eq!(value["rows"], json!(20_001));
        let output = value["outputPaths"][0].as_str().unwrap();
        let sheet = sheet_xml_by_name(Path::new(output), "折旧测算");
        // 模板块只写前 10 行公式，且必须出现逐字复用的截断提示。
        assert!(sheet.contains("r=\"J12\""));
        assert!(!sheet.contains("r=\"J13\""));
        assert!(
            zip_entry(Path::new(output), "xl/sharedStrings.xml").contains("【导出提速】折旧测算")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dep_export_validates_mapping_up_front() {
        let dir = temp_dir("fa-subtools-dep-validate");
        let mut params = dep_params(&dir);
        // 残值率与本年折旧缺失 → 中文清单报错；错误先于任何文件写出。
        params["mapping"]["residualRate"] = json!("");
        params["mapping"]["currentYearDep"] = json!("");
        let err = run_job_quiet("fa.dep_export", params).unwrap_err();
        assert_eq!(err.code, "FA_DEP_MAPPING_REQUIRED");
        assert!(err.user_message.contains("残值率"));
        assert!(err.user_message.contains("本年折旧"));
        assert!(!dir.join("折旧测算.xlsx").exists());
        // 映射指向的列已不在表头中 → 提示重新读取，而不是静默跳过公式块。
        let mut stale = dep_params(&dir);
        stale["mapping"]["life"] = json!("已改名的寿命列");
        let err = run_job_quiet("fa.dep_export", stale).unwrap_err();
        assert_eq!(err.code, "FA_DEP_MAPPING_STALE");
        // 资产负债表日期必填且可解析（公式整体以它为截止月）。
        let mut undated = dep_params(&dir);
        undated["balanceSheetDate"] = json!("不是日期");
        let err = run_job_quiet("fa.dep_export", undated).unwrap_err();
        assert_eq!(err.code, "FA_DEP_DATE_INVALID");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dep_export_default_name_sits_beside_source() {
        let dir = temp_dir("fa-subtools-dep-name");
        let mut params = dep_params(&dir);
        params.as_object_mut().unwrap().remove("outputPath");
        let value = run_job_quiet("fa.dep_export", params).unwrap();
        let output = PathBuf::from(value["outputPaths"][0].as_str().unwrap());
        assert_eq!(output.parent().unwrap(), dir.as_path());
        let name = output.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with("折旧测算_") && name.ends_with(".xlsx"),
            "unexpected default name: {name}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_export_writes_period_and_reference_sheets() {
        let dir = temp_dir("fa-subtools-policy");
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin, "编号,类别,名称,原值,累计折旧,寿命(月),残值率\nA1,机器,甲,100,20,60,5%\nA2,电子,乙,80,70,36,5%\n").unwrap();
        fs::write(&end, "编号,类别,名称,原值,累计折旧,寿命(月),残值率\nA1,机器,甲,100,40,72,6%\nA3,运输,丙,50,5,48,5%\n").unwrap();
        let params = json!({
            "beginPath": begin.to_string_lossy(),
            "endPath": end.to_string_lossy(),
            "beginKeys": ["编号"],
            "endKeys": ["编号"],
            "beginMapping": {"category": "类别", "name": "名称", "originalValue": "原值", "depreciation": "累计折旧", "life": "寿命(月)", "residualRate": "残值率"},
            "endMapping": {"category": "类别", "name": "名称", "originalValue": "原值", "depreciation": "累计折旧", "life": "寿命(月)", "residualRate": "残值率"},
            "outputPath": dir.join("折旧政策对比.xlsx").to_string_lossy(),
        });
        let value = run_job_quiet("fa.policy_export", params.clone()).unwrap();
        let output = dir.join("折旧政策对比.xlsx");
        assert!(output.is_file());
        // 工作簿固定两页：折旧政策对比 + 税法最低折旧年限参考。
        let workbook = zip_entry(&output, "xl/workbook.xml");
        assert!(workbook.contains("折旧政策对比"));
        assert!(workbook.contains("税法最低折旧年限参考"));
        let period = sheet_xml_by_name(&output, "折旧政策对比");
        assert!(period.contains("r=\"I3\"")); // 判断结果列有数据行
        // 与主工具导出的"折旧期间"页逐行同源：同一 merge 参数下表头行一致。
        let fa_output = dir.join("FA_List.xlsx");
        let mut fa_params = params.clone();
        fa_params["outputPath"] = json!(fa_output.to_string_lossy());
        crate::fa::run_job(
            "fa.export",
            fa_params,
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false))),
        )
        .unwrap();
        let fa_period = sheet_xml_by_name(&fa_output, "折旧期间");
        let row = |xml: &str, row_ref: &str| -> String {
            xml.split(&format!("<row r=\"{row_ref}\""))
                .nth(1)
                .and_then(|fragment| fragment.split("</row>").next())
                .unwrap_or_default()
                .to_owned()
        };
        let policy_strings = shared_strings(&output);
        let fa_strings = shared_strings(&fa_output);
        // 表头行、来源标注行、首个数据行逐列同源（共享字符串索引按各自工作簿解析）。
        for row_ref in ["1", "2", "3"] {
            let policy_row = row_cells_resolved(&row(&period, row_ref), &policy_strings);
            let fa_row = row_cells_resolved(&row(&fa_period, row_ref), &fa_strings);
            assert!(
                policy_row == fa_row,
                "row {row_ref} diverged:\npolicy: {policy_row:?}\nfa:    {fa_row:?}"
            );
        }
        // 税法参考表：五类固定资产 + 无形资产 + 特殊规定都要在；
        // 政策原文列必须落到条款原文，不能只留条款号。
        let tax = sheet_xml_by_name(&output, "税法最低折旧年限参考");
        let tax_text = format!("{}{}", tax, zip_entry(&output, "xl/sharedStrings.xml"));
        for expected in [
            "房屋、建筑物",
            "电子设备",
            "不得低于10年",
            "财税〔2012〕27号",
            "2027年12月31日",
            "政策原文",
            "固定资产计算折旧的最低年限如下",
            "最短可为2年（含）",
            "最短可为3年（含）",
            // 集成电路生产设备在 27 号文是第八条（此前两行都误写第七条）。
            "第八条",
            // 2026-08-22 补充的加速折旧/一次性扣除/生物资产/净残值政策。
            "第九十八条",
            "60%",
            "5000元",
            "林木类生产性生物资产",
            "制造业领域",
            "已使用过的固定资产",
            "预计净残值",
        ] {
            assert!(tax_text.contains(expected), "税法参考缺少：{expected}");
        }
        // 同文号/同条款纵向合并：实施条例占 C3:C12，第六十条占 D3:D7 与 E3:E7，
        // 生产性生物资产（第六十四条）占 D9:D10 与 E9:E10，27 号文两行占
        // C13:C14（第七/第八条各自不合并），75 号文三行占 C16:C18。
        for merged in [
            "C3:C12", "D3:D7", "E3:E7", "D9:D10", "E9:E10", "C13:C14", "C16:C18",
        ] {
            assert!(
                tax.contains(&format!("ref=\"{merged}\"")),
                "税法参考缺少合并区 {merged}"
            );
        }
        // C 列法规依据挂官方政策库 External 链接，备注里的延续公告、四领域
        // 文件同样可点击。
        let hyperlinks = sheet_hyperlinks_by_name(&output, "税法最低折旧年限参考");
        for url in [
            "fgk.chinatax.gov.cn",
            "shanghai.chinatax.gov.cn",
            "guangdong.chinatax.gov.cn",
        ] {
            assert!(hyperlinks.contains(url), "税法参考缺少官方链接：{url}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_export_requires_match_keys_like_fa_export() {
        let dir = temp_dir("fa-subtools-policy-keys");
        let begin = dir.join("begin.csv");
        let end = dir.join("end.csv");
        fs::write(&begin, "编号,原值\nA1,100\n").unwrap();
        fs::write(&end, "编号,原值\nA1,120\n").unwrap();
        let err = run_job_quiet(
            "fa.policy_export",
            json!({
                "beginPath": begin.to_string_lossy(),
                "endPath": end.to_string_lossy(),
            }),
        )
        .unwrap_err();
        // 走的是 fa::merge 同一条键校验，错误码与文案完全一致。
        assert_eq!(err.code, "FA_KEY_REQUIRED");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_methods_stay_not_found() {
        assert_eq!(
            call("fa.dep_unknown", json!({})).unwrap_err().code,
            "METHOD_NOT_FOUND"
        );
        assert_eq!(
            run_job_quiet("fa.dep_unknown", json!({})).unwrap_err().code,
            "METHOD_NOT_FOUND"
        );
    }
}
