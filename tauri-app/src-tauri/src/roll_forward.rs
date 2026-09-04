//! Native Audit Roll Forward kernel.
//!
//! This module deliberately exposes the same JSON method surface as the legacy
//! Python engine.  It uses `umya-spreadsheet` so an existing template is edited
//! instead of being reconstructed.  That is important for drawings, names,
//! validation rules, merged cells and styles owned by the template.

use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use umya_spreadsheet::{Workbook, Worksheet};
use walkdir::WalkDir;

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

const CONFIG_JSON: &str = include_str!("../../assets/roll-forward/subjects_config.json");

#[derive(Clone, Debug, Deserialize)]
struct CatalogConfig {
    version: String,
    subjects: BTreeMap<String, SubjectConfig>,
}

#[derive(Clone, Debug, Deserialize)]
struct SubjectConfig {
    #[serde(default)]
    code: String,
    #[serde(default)]
    name: String,
    template_file: String,
    #[serde(default)]
    prior_file_pattern: String,
    #[serde(default)]
    prior_file_patterns: Vec<String>,
    lead_sheet: LeadConfig,
    #[serde(default)]
    k01: Option<K01Config>,
    #[serde(default)]
    sub_sheets: Vec<SubSheetConfig>,
}

#[derive(Clone, Debug, Deserialize)]
struct LeadConfig {
    sheet_name: String,
    #[serde(default = "default_header_text")]
    header_search_text: String,
    closing_col: u32,
    opening_col: u32,
    #[serde(default)]
    match_existing_rows_only: bool,
    #[serde(default)]
    total_row_keywords: Vec<String>,
    #[serde(default)]
    clear_current_period_cols: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize)]
struct K01Config {
    #[serde(default)]
    has_k01: bool,
    #[serde(default)]
    sheet_name: String,
    #[serde(default)]
    header_row: u32,
    #[serde(default)]
    opening_balance_rows: Vec<u32>,
    #[serde(default)]
    categories: Vec<K01Category>,
    #[serde(default)]
    roll_forward_groups: Vec<RollForwardGroup>,
}

#[derive(Clone, Debug, Deserialize)]
struct K01Category {
    name: String,
    audit_col: u32,
    book_col: u32,
}

#[derive(Clone, Debug, Deserialize)]
struct RollForwardGroup {
    group: String,
    source_detail: String,
    target_detail: String,
    #[serde(default)]
    value_cols: Vec<u32>,
}

#[derive(Clone, Debug, Deserialize)]
struct SubSheetConfig {
    sheet_name: String,
    #[serde(default = "default_header_text")]
    header_search_text: String,
    #[serde(default)]
    closing_col: u32,
    #[serde(default)]
    opening_col: u32,
    #[serde(default)]
    dynamic_prior_current_to_py: bool,
}

/// Fill applied to every cell the roll forward rewrote or migrated, so the
/// reviewer can find them in the workbook itself.
const HIGHLIGHT_FILL: &str = "FFF2CC";

/// Upper bound on the per-cell change list written into the summary sheet,
/// matching the legacy cap.
const SUMMARY_DETAIL_LIMIT: usize = 1_000;

#[derive(Clone, Debug, Default)]
struct CellChange {
    sheet: String,
    cell: String,
    before: String,
    after: String,
    formula_before: String,
    formula_after: String,
    added: bool,
}

#[derive(Clone, Debug, Default)]
struct WorkbookDiff {
    changed_cells: usize,
    added_cells: usize,
    formula_changes: usize,
    touched_sheets: Vec<String>,
    /// Individual changes, sorted by sheet/row/column and capped at
    /// [`SUMMARY_DETAIL_LIMIT`].  Without this the summary only reported totals
    /// and a reviewer had no way to see *what* was rewritten short of diffing
    /// two workbooks by eye.
    changes: Vec<CellChange>,
    highlighted: Vec<(String, String)>,
}

fn default_header_text() -> String {
    "期末审定数".into()
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "roll_forward.catalog" => catalog(),
        "roll_forward.detect_subjects" => detect_subjects(params),
        "roll_forward.project_export" => project_export(params),
        "roll_forward.cra_parse" | "roll_forward.cra.parse" => cra_parse(params),
        "roll_forward.validate" => validate(params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust Roll Forward 方法。",
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
        "roll_forward.process" => {
            let result = process(params, progress, cancel, pause);
            pause.wait()?;
            result
        }
        "roll_forward.process_companies" => {
            let result = process_companies(params, progress, cancel, pause);
            pause.wait()?;
            result
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust Roll Forward 任务。",
            Some(method.into()),
        )),
    }
}

fn config() -> Result<CatalogConfig, AppError> {
    serde_json::from_str(CONFIG_JSON).map_err(|e| {
        error(
            "ROLL_FORWARD_CONFIG_INVALID",
            "科目配置损坏。",
            Some(e.to_string()),
        )
    })
}

fn catalog() -> Result<Value, AppError> {
    let cfg = config()?;
    let subjects = cfg.subjects.into_iter().map(|(code, item)| {
        let patterns = if item.prior_file_patterns.is_empty() { vec![item.prior_file_pattern] } else { item.prior_file_patterns };
        json!({"code":code,"name":item.name,"templateFile":item.template_file,"priorPatterns":patterns,"hasCra":true})
    }).collect::<Vec<_>>();
    Ok(json!({"version":cfg.version,"subjects":subjects,"engine":"rust"}))
}

fn detect_subjects(params: Value) -> Result<Value, AppError> {
    let source = required_path(&params, "priorPath", "请选择上年底稿路径。")?;
    let files = workbook_files(&source)?;
    let cfg = config()?;
    let mut detected = Vec::new();
    let mut matched = serde_json::Map::new();
    for (code, item) in cfg.subjects {
        let found = files
            .iter()
            .filter(|path| filename_matches(path, &code, &item.name))
            .map(|p| Value::String(p.to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        if !found.is_empty() {
            detected.push(code.clone());
            matched.insert(code, Value::Array(found));
        }
    }
    let message = if detected.is_empty() {
        "未能从上年底稿路径自动识别科目，请手动选择。".into()
    } else {
        format!(
            "已根据上年底稿默认识别科目：{}。请复核后再执行。",
            detected.join(", ")
        )
    };
    Ok(
        json!({"subjects":detected,"matchedFiles":matched,"scannedWorkbookCount":files.len(),"message":message,"engine":"rust"}),
    )
}

fn project_export(params: Value) -> Result<Value, AppError> {
    let project = params
        .get("project")
        .filter(|v| v.is_object())
        .ok_or_else(|| error("INVALID_ARGUMENT", "项目数据格式不正确。", None))?;
    let mut output = required_path(&params, "outputPath", "请选择项目导出路径。")?;
    if !matches!(
        output.extension().and_then(|v| v.to_str()),
        Some("auditproj" | "json")
    ) {
        output.set_extension("auditproj");
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let temporary = output.with_extension("auditproj.partial");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(project).map_err(|e| {
            error(
                "PROJECT_EXPORT_FAILED",
                "项目导出失败。",
                Some(e.to_string()),
            )
        })?,
    )
    .map_err(io_error)?;
    replace_file(&temporary, &output)?;
    Ok(json!({"message":"项目已导出。","outputPaths":[output.to_string_lossy()],"engine":"rust"}))
}

/// Parse the tabular CRA paste format without network or Python.  The parser
/// accepts Excel tabs and plain whitespace and intentionally leaves ambiguous
/// records for manual review instead of guessing.
fn cra_parse(params: Value) -> Result<Value, AppError> {
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| error("INVALID_ARGUMENT", "请粘贴 CRA 表格。", None))?;
    let selected = params
        .get("subjectCodes")
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(Value::as_str).collect::<HashSet<_>>())
        .unwrap_or_default();
    let cfg = config()?;
    let mut records = Vec::new();
    let mut write_count = 0usize;
    let mut current_subject = String::new();
    let mut current_account = String::new();
    let mut pending_assertion = String::new();
    let mut pending_level = String::new();
    let mut header_map = HashMap::<String, usize>::new();
    for (index, line) in text.lines().enumerate() {
        let fields = if line.contains('\t') {
            line.split('\t').map(str::trim).collect::<Vec<_>>()
        } else if line.matches(',').count() >= 3 {
            line.split(',').map(str::trim).collect::<Vec<_>>()
        } else {
            line.split_whitespace()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        };
        let joined = fields.join(" ");
        if joined.is_empty() {
            continue;
        }
        let roles = fields
            .iter()
            .enumerate()
            .filter_map(|(i, v)| {
                let key = normalize(v).to_uppercase();
                if key.contains("科目") || key.contains("账户") {
                    Some(("account".into(), i))
                } else if key.contains("认定") {
                    Some(("assertion".into(), i))
                } else if key.contains("CRA") || key.contains("风险等级") {
                    Some(("cra".into(), i))
                } else if key.contains("比例") || key.contains("THRESHOLD") {
                    Some(("ratio".into(), i))
                } else {
                    None
                }
            })
            .collect::<HashMap<String, usize>>();
        if roles.contains_key("assertion") && roles.contains_key("cra") {
            header_map = roles;
            continue;
        }
        let detected = detect_cra_subject(&joined, &selected, &cfg);
        if !detected.is_empty() {
            current_subject = detected.clone();
            if fields.len() == 1 {
                current_account = joined.clone();
                continue;
            }
        }
        let by_role = |role: &str| {
            header_map
                .get(role)
                .and_then(|i| fields.get(*i))
                .copied()
                .unwrap_or("")
        };
        let mut subject = if detected.is_empty() {
            current_subject.clone()
        } else {
            detected
        };
        let mut account = by_role("account").to_owned();
        if account.is_empty() {
            account = current_account.clone();
        }
        let mut assertion = normalize_cra_assertion(by_role("assertion"))
            .or_else(|| fields.iter().find_map(|v| normalize_cra_assertion(v)))
            .unwrap_or_default();
        let mut cra_level = normalize_cra_level(by_role("cra"))
            .or_else(|| fields.iter().find_map(|v| normalize_cra_level(v)))
            .unwrap_or_default();
        let ratio =
            parse_ratio(by_role("ratio")).or_else(|| fields.iter().find_map(|v| parse_ratio(v)));
        if fields.len() == 1 && ratio.is_none() {
            if !assertion.is_empty() {
                pending_assertion = assertion;
                continue;
            }
            if !cra_level.is_empty() {
                pending_level = cra_level;
                continue;
            }
        }
        if assertion.is_empty() {
            assertion = pending_assertion.clone()
        }
        if cra_level.is_empty() {
            cra_level = pending_level.clone()
        }
        if subject.is_empty() {
            subject = current_subject.clone()
        }
        let applicable = !matches!(cra_level.as_str(), "N/A" | "不适用");
        let ready = !subject.is_empty()
            && !assertion.is_empty()
            && !cra_level.is_empty()
            && (!applicable || ratio.is_some());
        if ready {
            write_count += 1;
            pending_assertion.clear();
            pending_level.clear();
        }
        let range_status = cra_range_status(&subject, &cra_level, ratio);
        records.push(json!({"source_row":index+1,"subject_code":subject,"account":account,"assertion":assertion,"cra_level":cra_level,"ratio":ratio,"applicable":applicable,"range_status":range_status,"raw_text":line,"match_status":if ready{"将写入"}else{"人工复核"}}));
    }
    let issue_count = records.len() - write_count;
    Ok(
        json!({"records":records,"headerOptions":[],"writeCount":write_count,"issueCount":issue_count,"engine":"rust"}),
    )
}

fn detect_cra_subject(joined: &str, selected: &HashSet<&str>, cfg: &CatalogConfig) -> String {
    let upper = joined.to_uppercase();
    selected
        .iter()
        .find(|code| {
            upper
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|v| v.eq_ignore_ascii_case(code))
                || cfg
                    .subjects
                    .get(**code)
                    .is_some_and(|item| joined.contains(&item.name))
        })
        .map(|v| (*v).to_owned())
        .unwrap_or_default()
}
fn cra_range_status(subject: &str, level: &str, ratio: Option<f64>) -> String {
    let Some(value) = ratio else {
        return "未检查（无单一比例）".into();
    };
    let liability = matches!(subject, "M" | "N" | "Q1" | "Uexp" | "UexpVCVD");
    let range = match (liability, level) {
        (false, "Minimal") => Some((0.75, 1.0)),
        (false, "Low") => Some((0.5, 0.75)),
        (false, "Moderate") => Some((0.25, 0.5)),
        (false, "High") => Some((0.1, 0.25)),
        (true, "Minimal") => Some((0.25, 0.5)),
        (true, "Low") => Some((0.15, 0.25)),
        (true, "Moderate") => Some((0.1, 0.15)),
        (true, "High") => Some((0.05, 0.1)),
        _ => None,
    };
    match range {
        Some((low, high)) if value >= low && value <= high => "通过".into(),
        Some((low, high)) => format!("超出建议区间 {:.0}%-{:.0}%", low * 100.0, high * 100.0),
        None => "未检查（CRA等级不适用）".into(),
    }
}

fn normalize_cra_assertion(value: &str) -> Option<String> {
    let key = normalize(value);
    [
        ("存在", "存在"),
        ("完整", "完整性"),
        ("准确", "准确性"),
        ("计价", "计价"),
        ("权利和义务", "权利和义务"),
        ("截止", "截止"),
        ("分类", "分类"),
        ("列报", "列报"),
    ]
    .iter()
    .find(|(needle, _)| key.contains(needle))
    .map(|(_, canonical)| (*canonical).to_owned())
}
fn normalize_cra_level(value: &str) -> Option<String> {
    let key = normalize(value).to_uppercase();
    if matches!(key.as_str(), "N/A" | "NA" | "不适用") {
        Some("N/A".into())
    } else if key.contains("MINIMAL") || key.contains("最低") || key.contains("极低") {
        Some("Minimal".into())
    } else if key.contains("MODERATE") || key.contains("MEDIUM") || key.contains("中") {
        Some("Moderate".into())
    } else if key.contains("HIGH") || key.contains("高") {
        Some("High".into())
    } else if key.contains("LOW") || key.contains("低") {
        Some("Low".into())
    } else {
        None
    }
}

fn validate(params: Value) -> Result<Value, AppError> {
    let template_dir = required_path(&params, "templateDir", "请选择模板目录。")?;
    let prior = required_path(&params, "priorDir", "请选择上年底稿。")?;
    let output = required_path(&params, "outputDir", "请选择输出目录。")?;
    let cfg = config()?;
    let subjects = string_array(&params, "subjectCodes");
    let date = parse_date(params.get("bsDate").and_then(Value::as_str).unwrap_or(""));
    let prior_year = date.map(|d| d.year() - 1);
    let mut unknown = Vec::new();
    let mut missing_templates = Vec::new();
    let mut details = Vec::new();
    for code in &subjects {
        if let Some(item) = cfg.subjects.get(code) {
            let template = crate::spreadsheet_input::prefer_workbook(&template_dir.join(&item.template_file));
            if !template.is_file() {
                missing_templates.push(item.template_file.clone());
            }
            let matched = prior_year.and_then(|year| find_prior_file(&prior, code, year, item));
            details.push(json!({"code":code,"name":item.name,"templatePath":template.to_string_lossy(),"templateReady":template.is_file(),"priorPath":matched.as_ref().map(|v|v.to_string_lossy().into_owned()).unwrap_or_default(),"priorReady":matched.is_some()}));
        } else {
            unknown.push(code.clone());
        }
    }
    let pmte = params
        .get("pmtePath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let company_valid = !params
        .get("companyName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty();
    let output_parent = if output.exists() {
        output.clone()
    } else {
        output.parent().unwrap_or(Path::new(".")).to_owned()
    };
    let output_writable = output_parent.is_dir();
    let prior_ready = prior.exists() && (prior.is_dir() || is_xlsx(&prior));
    let llm_requested = params
        .get("llmEnhanced")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || params
            .get("llmWordingRevision")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let llm = params.get("__llmOptions").and_then(Value::as_object);
    let llm_ready = !llm_requested
        || llm.is_some_and(|v| {
            v.get("enabled").and_then(Value::as_bool) == Some(true)
                && v.get("api_type")
                    .and_then(Value::as_str)
                    .unwrap_or("openai")
                    == "openai"
                && v.get("api_key")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                && v.get("base_url")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                && v.get("model")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
        });
    let valid = !subjects.is_empty()
        && company_valid
        && date.is_some()
        && prior_ready
        && (pmte.is_empty() || Path::new(pmte).is_file())
        && unknown.is_empty()
        && missing_templates.is_empty()
        && details.iter().all(|v| v["priorReady"] == true)
        && output_writable
        && llm_ready;
    Ok(
        json!({"valid":valid,"subjects":subjects,"unknownSubjects":unknown,"missingTemplates":missing_templates,"priorWorkbookCount":workbook_files(&prior).map(|v|v.len()).unwrap_or(0),"dateValid":date.is_some(),"companyValid":company_valid,"pmteReady":pmte.is_empty()||Path::new(pmte).is_file(),"llmRequested":llm_requested,"llmReady":llm_ready,"llmMessage":if !llm_requested{"未启用 LLM 增强。"}else if llm_ready{"全局 LLM 配置已就绪。"}else{"Roll Forward 的 LLM 增强仅支持已配置的 OpenAI 兼容接口，请先在工具箱设置中完成配置。"},"outputWritable":output_writable,"details":details,"outputDir":output.to_string_lossy(),"engine":"rust"}),
    )
}

fn process(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let check = validate(params.clone())?;
    if check["valid"] != true {
        return Err(error(
            "ROLL_FORWARD_INVALID",
            "模板、科目或上年底稿检查未通过。",
            Some(check.to_string()),
        ));
    }
    let cfg = config()?;
    let subjects = string_array(&params, "subjectCodes");
    let template_dir = PathBuf::from(required_string(&params, "templateDir")?);
    let prior = PathBuf::from(required_string(&params, "priorDir")?);
    let output = PathBuf::from(required_string(&params, "outputDir")?);
    let company = required_string(&params, "companyName")?;
    let date = parse_date(params["bsDate"].as_str().unwrap_or("")).unwrap();
    fs::create_dir_all(&output).map_err(io_error)?;
    let mut rows = Vec::new();
    let mut outputs = Vec::new();
    for (index, code) in subjects.iter().enumerate() {
        pause.wait()?;
        check_cancel(&cancel)?;
        progress(
            "process",
            index,
            subjects.len(),
            &format!("[{code}] 正在读取模板和上年底稿"),
        );
        let item = cfg.subjects.get(code).unwrap();
        let prior_path = find_prior_file(&prior, code, date.year() - 1, item).ok_or_else(|| {
            error(
                "ROLL_FORWARD_PRIOR_NOT_FOUND",
                &format!("未找到 {code} 上年底稿。"),
                None,
            )
        })?;
        match process_subject(code,item,&crate::spreadsheet_input::prefer_workbook(&template_dir.join(&item.template_file)),&prior_path,&output,&company,date,&params,&cancel){
            Ok((path,warnings,metadata))=>{outputs.push(path.to_string_lossy().into_owned());rows.push(json!({"subjectCode":code,"success":true,"message":"处理成功","outputPath":path.to_string_lossy(),"warnings":warnings,"metadata":metadata}));}
            Err(err)=>rows.push(json!({"subjectCode":code,"success":false,"message":err.user_message,"outputPath":"","warnings":[],"metadata":{"diagnosticId":err.diagnostic_id}})),
        }
        pause.wait()?;
        progress(
            "process",
            index + 1,
            subjects.len(),
            &format!("[{code}] 处理完成"),
        );
    }
    check_cancel(&cancel)?;
    Ok(json!({"results":rows,"outputPaths":outputs,"engine":"rust"}))
}

fn process_companies(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let companies = params
        .get("companies")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("INVALID_ARGUMENT", "请至少选择一家公司。", None))?
        .clone();
    let mut results = Vec::new();
    let mut outputs = Vec::new();
    for (index, company) in companies.iter().enumerate() {
        pause.wait()?;
        check_cancel(&cancel)?;
        let mut value = params.clone();
        value.as_object_mut().unwrap().remove("companies");
        if let Some(map) = company.as_object() {
            for (k, v) in map {
                value[k] = v.clone();
            }
        }
        let name = value["companyName"]
            .as_str()
            .unwrap_or("未命名公司")
            .to_owned();
        progress(
            "company",
            index,
            companies.len(),
            &format!("[{name}] 开始处理"),
        );
        let result = process(value, progress, cancel.clone(), pause)?;
        outputs.extend(
            result["outputPaths"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        );
        results.push(json!({"companyName":name,"results":result["results"],"outputPaths":result["outputPaths"]}));
        pause.wait()?;
        progress(
            "company",
            index + 1,
            companies.len(),
            &format!("[{name}] 处理完成"),
        );
    }
    Ok(json!({"companies":results,"outputPaths":outputs,"engine":"rust"}))
}

fn process_subject(
    code: &str,
    item: &SubjectConfig,
    template: &Path,
    prior: &Path,
    output_dir: &Path,
    company: &str,
    date: NaiveDate,
    params: &Value,
    cancel: &AtomicBool,
) -> Result<(PathBuf, Vec<String>, Value), AppError> {
    check_cancel_ref(cancel)?;
    let output = output_dir.join(output_filename(&item.template_file, date, company));
    let original_prior = prior;
    let original_template = template;
    let prepared_template = crate::spreadsheet_input::prepare_xlsx(template)?;
    let prepared_prior = crate::spreadsheet_input::prepare_xlsx(prior)?;
    let template = prepared_template.path();
    let prior = prepared_prior.path();
    let partial = output.with_extension("partial.xlsx");
    fs::copy(template, &partial).map_err(io_error)?;
    let result = (|| {
        let mut target = umya_spreadsheet::reader::xlsx::read(&partial).map_err(xlsx_read_error)?;
        let before = workbook_snapshot(&target);
        let source = umya_spreadsheet::reader::xlsx::read(prior).map_err(xlsx_read_error)?;
        let mut warnings = Vec::new();
        let mut copied = 0usize;
        copied += roll_lead(&source, &mut target, &item.lead_sheet, &mut warnings)?;
        if let Some(k01) = item.k01.as_ref().filter(|v| v.has_k01) {
            copied += roll_k01(&source, &mut target, k01, &mut warnings)?;
        }
        for sub in &item.sub_sheets {
            copied += roll_sub_sheet(&source, &mut target, sub, &mut warnings)?;
        }
        copied += roll_subject_specific(
            code,
            &source,
            &mut target,
            params
                .get("rollForwardWording")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            &mut warnings,
        )?;
        copied += roll_date_sensitive_subjects(
            code,
            &source,
            &mut target,
            date,
            params
                .get("rollForwardWording")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            &mut warnings,
        )?;
        let company_info = extract_company_info(
            params.get("pmtePath").and_then(Value::as_str).unwrap_or(""),
            company,
        )?;
        fill_labeled_headers(
            &mut target,
            company,
            date,
            params,
            &company_info,
            &mut warnings,
        );
        let cra = apply_cra_records(
            &mut target,
            code,
            params
                .get("craRecords")
                .and_then(Value::as_array)
                .unwrap_or(&Vec::new()),
            &mut warnings,
        );
        if params
            .get("rollForwardWording")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            copied += roll_wording(&source, &mut target, &mut warnings);
        }
        let diff = workbook_diff(&before, &target);
        if params
            .get("generateSummary")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            add_summary(
                &mut target,
                code,
                &item.name,
                company,
                date,
                original_prior,
                copied,
                &diff,
                &warnings,
            )?;
        }
        check_cancel_ref(cancel)?;
        umya_spreadsheet::writer::xlsx::write(&target, &partial).map_err(xlsx_write_error)?;
        if params
            .get("preserveTemplateDrawings")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            ensure_template_drawing_parts(template, &partial)?;
        }
        if code == "Q1" {
            let images = copy_q1_review_images(prior, &partial)?;
            if images > 0 {
                warnings.push(format!("已从上年底稿迁移 {images} 张 Q1 复核证据图片。"));
            }
        }
        // The prior-year file the engine actually matched is the single most
        // useful thing to be able to check afterwards: a wrong match produces a
        // workbook that looks completely normal.
        Ok((
            warnings,
            json!({"copiedCells":copied,"craWriteCount":cra,"templatePreserved":true,
                "priorPath":original_prior.to_string_lossy(),
                "priorSize":fs::metadata(original_prior).map(|meta| meta.len()).unwrap_or(0),
                "templatePath":original_template.to_string_lossy(),
                "highlightedCells":diff.highlighted.len(),
                "workbookDiff":{"changedCells":diff.changed_cells,"addedCells":diff.added_cells,"formulaChanges":diff.formula_changes,"touchedSheets":diff.touched_sheets}}),
        ))
    })();
    match result {
        Ok((warnings, metadata)) => {
            replace_file(&partial, &output)?;
            Ok((output, warnings, metadata))
        }
        Err(err) => {
            let _ = fs::remove_file(&partial);
            Err(err)
        }
    }
}

fn roll_lead(
    source: &Workbook,
    target: &mut Workbook,
    cfg: &LeadConfig,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Ok(src) = source.get_sheet_by_name(&cfg.sheet_name) else {
        warnings.push(format!("上年底稿缺少 Lead Sheet：{}", cfg.sheet_name));
        return Ok(0);
    };
    let Ok(dst) = target.get_sheet_by_name_mut(&cfg.sheet_name) else {
        return Err(error(
            "ROLL_FORWARD_TEMPLATE_SHEET_MISSING",
            &format!("模板缺少 Lead Sheet：{}", cfg.sheet_name),
            None,
        ));
    };
    let (src_max_col, src_max_row) = src.get_highest_column_and_row();
    let header = if let Some(row) = find_row(src, &cfg.header_search_text, 1, 80) {
        row
    } else if let Some(row) = find_structural_lead_header(src, cfg, src_max_row) {
        warnings.push(format!(
            "{} 表头文字无法识别，已按配置列位和明细结构定位第 {} 行。",
            cfg.sheet_name, row
        ));
        row
    } else {
        return Err(error(
            "ROLL_FORWARD_HEADER_NOT_FOUND",
            &format!("{} 未找到表头 {}", cfg.sheet_name, cfg.header_search_text),
            None,
        ));
    };
    let (_, dst_max_row) = dst.get_highest_column_and_row();
    let max_row = src_max_row.min(dst_max_row);
    let mut copied = 0;
    if cfg.match_existing_rows_only {
        let descriptors = (header + 1..=dst_max_row)
            .filter_map(|r| {
                let key = normalize(
                    &dst.get_cell((3, r))
                        .map(|c| c.get_value().to_string())
                        .unwrap_or_default(),
                );
                (!key.is_empty()).then_some((key, r))
            })
            .collect::<HashMap<_, _>>();
        for r in header + 1..=src_max_row {
            let key = normalize(
                &src.get_cell((3, r))
                    .map(|c| c.get_value().to_string())
                    .unwrap_or_default(),
            );
            if let Some(&dr) = descriptors.get(&key) {
                copied += copy_value(src, dst, cfg.closing_col, r, cfg.opening_col, dr);
            }
        }
    } else {
        for r in header + 1..=max_row {
            if is_end_row(src, r, src_max_col, &cfg.total_row_keywords) {
                break;
            }
            copied += copy_value(src, dst, cfg.closing_col, r, cfg.opening_col, r);
        }
    }
    for col in &cfg.clear_current_period_cols {
        for row in header + 1..=dst_max_row {
            dst.get_cell_mut((*col, row)).set_blank();
        }
    }
    Ok(copied)
}

fn find_structural_lead_header(sheet: &Worksheet, cfg: &LeadConfig, max_row: u32) -> Option<u32> {
    if cfg.closing_col == 0 || cfg.opening_col == 0 {
        return None;
    }
    let has_detail_value = |row: u32| {
        [cfg.closing_col, cfg.opening_col].iter().any(|column| {
            sheet.get_cell((*column, row)).is_some_and(|cell| {
                !cell.get_formula().trim().is_empty()
                    || cell.get_value_number().is_some()
                    || cell
                        .get_value()
                        .replace(',', "")
                        .trim()
                        .parse::<f64>()
                        .is_ok()
            })
        })
    };
    let labeled = (1..=80.min(max_row)).find(|row| {
        let closing_header = sheet
            .get_cell((cfg.closing_col, *row))
            .map(|cell| cell.get_value().trim().to_owned())
            .unwrap_or_default();
        let opening_header = sheet
            .get_cell((cfg.opening_col, *row))
            .map(|cell| cell.get_value().trim().to_owned())
            .unwrap_or_default();
        if closing_header.is_empty()
            || opening_header.is_empty()
            || closing_header.replace(',', "").parse::<f64>().is_ok()
            || opening_header.replace(',', "").parse::<f64>().is_ok()
        {
            return false;
        }
        has_detail_value(*row + 1) || has_detail_value(*row + 2)
    });
    labeled.or_else(|| {
        (2..=80.min(max_row))
            .find(|row| has_detail_value(*row))
            .map(|row| row - 1)
    })
}

fn roll_k01(
    source: &Workbook,
    target: &mut Workbook,
    cfg: &K01Config,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Ok(src) = source.get_sheet_by_name(&cfg.sheet_name) else {
        warnings.push(format!("上年底稿缺少明细表：{}", cfg.sheet_name));
        return Ok(0);
    };
    let Ok(dst) = target.get_sheet_by_name_mut(&cfg.sheet_name) else {
        warnings.push(format!("模板缺少明细表：{}", cfg.sheet_name));
        return Ok(0);
    };
    let mut copied = 0;
    for row in &cfg.opening_balance_rows {
        for category in &cfg.categories {
            copied += copy_value(src, dst, category.audit_col, *row, category.book_col, *row);
        }
    }
    for group in &cfg.roll_forward_groups {
        if let (Some(sr), Some(dr)) = (
            find_group_detail(src, &group.group, &group.source_detail),
            find_group_detail(dst, &group.group, &group.target_detail),
        ) {
            for col in &group.value_cols {
                copied += copy_value(src, dst, *col, sr, *col, dr);
            }
        }
    }
    if cfg.header_row == 0 {
        warnings.push(format!(
            "{} 未配置表头行，已仅处理明确余额映射。",
            cfg.sheet_name
        ));
    }
    Ok(copied)
}

fn roll_sub_sheet(
    source: &Workbook,
    target: &mut Workbook,
    cfg: &SubSheetConfig,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Ok(src) = source.get_sheet_by_name(&cfg.sheet_name) else {
        return Ok(0);
    };
    let Ok(dst) = target.get_sheet_by_name_mut(&cfg.sheet_name) else {
        warnings.push(format!("模板缺少子表：{}", cfg.sheet_name));
        return Ok(0);
    };
    if cfg.dynamic_prior_current_to_py {
        return roll_dynamic_expense(src, dst);
    }
    let header = find_row(src, &cfg.header_search_text, 1, 80).unwrap_or(1);
    let (_, max) = src.get_highest_column_and_row();
    let mut copied = 0;
    if cfg.closing_col > 0 && cfg.opening_col > 0 {
        for row in header + 1..=max {
            copied += copy_value(src, dst, cfg.closing_col, row, cfg.opening_col, row);
        }
    }
    Ok(copied)
}

fn roll_dynamic_expense(src: &Worksheet, dst: &mut Worksheet) -> Result<usize, AppError> {
    let find_header = |sheet: &Worksheet| -> Option<u32> {
        (1..=sheet.get_highest_row().min(100)).find(|row| {
            let text = (1..=sheet.get_highest_column().min(30))
                .map(|col| {
                    normalize(
                        &sheet
                            .get_cell((col, *row))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                })
                .collect::<String>();
            text.contains("科目编码")
                && text.contains("科目名称")
                && (text.contains("上期末审定数") || text.contains("上期审定数"))
        })
    };
    let Some(source_header) = find_header(src) else {
        return Ok(0);
    };
    let Some(target_header) = find_header(dst) else {
        return Ok(0);
    };
    let source_current = find_header_col_keywords(
        src,
        source_header,
        &["本期账面审定数", "本期审定数", "本期数"],
    )
    .ok_or_else(|| {
        error(
            "ROLL_FORWARD_EXPENSE_HEADER",
            "未找到费用底稿本期审定列。",
            None,
        )
    })?;
    let target_py = find_header_col_keywords(
        dst,
        target_header,
        &["上期末审定数", "上期审定数", "上年数", "PY"],
    )
    .ok_or_else(|| {
        error(
            "ROLL_FORWARD_EXPENSE_HEADER",
            "未找到费用底稿上期审定列。",
            None,
        )
    })?;
    let descriptors = ["账套名称/账套编码", "科目编码", "科目名称"]
        .iter()
        .filter_map(|key| {
            Some((
                find_header_col_keywords(src, source_header, &[*key])?,
                find_header_col_keywords(dst, target_header, &[*key])?,
            ))
        })
        .collect::<Vec<_>>();
    if descriptors.len() < 2 {
        return Ok(0);
    }
    let source_total = find_total_after(src, source_header).unwrap_or(src.get_highest_row() + 1);
    let target_total = find_total_after(dst, target_header).unwrap_or(dst.get_highest_row() + 1);
    let records = (source_header + 1..source_total)
        .filter(|row| {
            descriptors.iter().any(|(sc, _)| {
                src.get_cell((*sc, *row))
                    .is_some_and(|v| !v.get_value().is_empty())
            })
        })
        .collect::<Vec<_>>();
    if records.is_empty() {
        return Ok(0);
    }
    let start = target_header + 1;
    let available = target_total - start;
    let extra = (records.len() as u32).saturating_sub(available);
    let formula_source = start.max(target_total.saturating_sub(1));
    if extra > 0 {
        insert_rows_sheet_preserving_validation(dst, target_total, extra);
        let max = dst.get_highest_column().min(30);
        for offset in 0..extra {
            copy_row_within(dst, formula_source, target_total + offset, max);
        }
    }
    let new_total = target_total + extra;
    let headers = [
        ("book", vec!["本期账面数", "账面数"]),
        ("book_adjust", vec!["账面调整"]),
        ("unaudited", vec!["未审数", "未审计数"]),
        ("structure", vec!["结构比"]),
        ("audit_adjust", vec!["审计调整"]),
        ("audited", vec!["本期账面审定数", "本期审定数"]),
        ("py", vec!["上期末审定数", "上期审定数", "上年数", "PY"]),
        ("variance", vec!["变动额", "差异"]),
        ("rate", vec!["变动率"]),
    ]
    .into_iter()
    .filter_map(|(name, keys)| {
        find_header_col_keywords(dst, target_header, &keys).map(|col| (name, col))
    })
    .collect::<HashMap<_, _>>();
    let mut copied = 0;
    for (index, sr) in records.iter().enumerate() {
        let row = start + index as u32;
        if row != formula_source {
            let max = dst.get_highest_column().min(30);
            copy_row_within(dst, formula_source, row, max);
        }
        for (sc, tc) in &descriptors {
            copied += copy_value(src, dst, *sc, *sr, *tc, row);
        }
        copied += copy_value(src, dst, source_current, *sr, target_py, row);
        set_expense_formulas(dst, row, new_total, &headers);
    }
    let last = start + records.len() as u32 - 1;
    set_expense_total_formulas(dst, new_total, start, last, &headers);
    Ok(copied)
}

fn insert_rows_sheet_preserving_validation(sheet: &mut Worksheet, row: u32, amount: u32) {
    if amount == 0 {
        return;
    }
    sheet.insert_new_row(row, amount);
    if let Some(vs) = sheet.get_data_validations_mut() {
        for validation in vs.get_data_validation_list_mut() {
            let raw = validation.get_sequence_of_references().get_sqref();
            let shifted = transform_sqref(&raw, 0, 0, row, amount);
            let refs = validation.get_sequence_of_references_mut();
            refs.remove_range_collection();
            refs.set_sqref(shifted);
        }
    }
}
fn column_letters(col: u32) -> String {
    a1(col, 1).trim_end_matches('1').to_owned()
}
fn set_expense_formulas(sheet: &mut Worksheet, row: u32, total: u32, h: &HashMap<&str, u32>) {
    let col = |k: &str| h.get(k).copied();
    if let (Some(u), Some(b), Some(a)) = (col("unaudited"), col("book"), col("book_adjust")) {
        sheet.get_cell_mut((u, row)).set_formula(format!(
            "{}{}+{}{}",
            column_letters(b),
            row,
            column_letters(a),
            row
        ));
    }
    if let (Some(s), Some(u)) = (col("structure"), col("unaudited")) {
        let l = column_letters(u);
        sheet
            .get_cell_mut((s, row))
            .set_formula(format!("IF(${l}${total}<>0,{l}{row}/${l}${total},\"\")"));
    }
    if let (Some(aud), Some(u), Some(adj)) = (col("audited"), col("unaudited"), col("audit_adjust"))
    {
        sheet.get_cell_mut((aud, row)).set_formula(format!(
            "{}{}+{}{}",
            column_letters(u),
            row,
            column_letters(adj),
            row
        ));
    }
    if let (Some(v), Some(aud), Some(py)) = (col("variance"), col("audited"), col("py")) {
        sheet.get_cell_mut((v, row)).set_formula(format!(
            "{}{}-{}{}",
            column_letters(aud),
            row,
            column_letters(py),
            row
        ));
    }
    if let (Some(rate), Some(py), Some(v)) = (col("rate"), col("py"), col("variance")) {
        let p = column_letters(py);
        let d = column_letters(v);
        sheet
            .get_cell_mut((rate, row))
            .set_formula(format!("IF({p}{row}<>0,{d}{row}/{p}{row},1)"));
    }
}
fn set_expense_total_formulas(
    sheet: &mut Worksheet,
    total: u32,
    start: u32,
    last: u32,
    h: &HashMap<&str, u32>,
) {
    for key in [
        "book",
        "book_adjust",
        "unaudited",
        "structure",
        "audit_adjust",
        "audited",
        "py",
    ] {
        if let Some(col) = h.get(key) {
            let l = column_letters(*col);
            sheet
                .get_cell_mut((*col, total))
                .set_formula(format!("SUM({l}{start}:{l}{last})"));
        }
    }
    set_expense_formulas(sheet, total, total, h);
}

/// `umya-spreadsheet` already shifts cells, formulas, defined names, drawings,
/// merged ranges and conditional formatting.  Data validation sqref is the one
/// worksheet collection it does not currently include, so we explicitly shift
/// it after the workbook-wide insert.
fn insert_rows_preserving_metadata(
    book: &mut Workbook,
    sheet_name: &str,
    row: u32,
    amount: u32,
) -> Result<(), AppError> {
    if amount == 0 {
        return Ok(());
    }
    book.insert_new_row(sheet_name, row, amount);
    let sheet = book.get_sheet_by_name_mut(sheet_name).map_err(|e| {
        error(
            "ROLL_FORWARD_TEMPLATE_SHEET_MISSING",
            "插入行时找不到目标工作表。",
            Some(e.to_string()),
        )
    })?;
    if let Some(validations) = sheet.get_data_validations_mut() {
        for validation in validations.get_data_validation_list_mut() {
            let sqref = validation.get_sequence_of_references().get_sqref();
            let shifted = transform_sqref(&sqref, 0, 0, row, amount);
            let refs = validation.get_sequence_of_references_mut();
            refs.remove_range_collection();
            refs.set_sqref(shifted);
        }
    }
    Ok(())
}

fn insert_cols_preserving_metadata(
    book: &mut Workbook,
    sheet_name: &str,
    col: u32,
    amount: u32,
) -> Result<(), AppError> {
    if amount == 0 {
        return Ok(());
    }
    book.insert_new_column_by_index(sheet_name, col, amount);
    let sheet = book.get_sheet_by_name_mut(sheet_name).map_err(|e| {
        error(
            "ROLL_FORWARD_TEMPLATE_SHEET_MISSING",
            "插入列时找不到目标工作表。",
            Some(e.to_string()),
        )
    })?;
    if let Some(validations) = sheet.get_data_validations_mut() {
        for validation in validations.get_data_validation_list_mut() {
            let sqref = validation.get_sequence_of_references().get_sqref();
            let shifted = transform_sqref(&sqref, col, amount, 0, 0);
            let refs = validation.get_sequence_of_references_mut();
            refs.remove_range_collection();
            refs.set_sqref(shifted);
        }
    }
    Ok(())
}

fn transform_sqref(value: &str, col: u32, col_amount: u32, row: u32, row_amount: u32) -> String {
    value
        .split_whitespace()
        .map(|part| {
            let mut ends = part.split(':');
            let first = ends.next().unwrap_or("");
            let second = ends.next();
            let Some((mut c1, mut r1)) = parse_a1(first) else {
                return part.to_owned();
            };
            let (mut c2, mut r2) = second.and_then(parse_a1).unwrap_or((c1, r1));
            if row_amount > 0 {
                if r1 >= row {
                    r1 += row_amount;
                    r2 += row_amount
                } else if r2 >= row {
                    r2 += row_amount;
                }
            }
            if col_amount > 0 {
                if c1 >= col {
                    c1 += col_amount;
                    c2 += col_amount
                } else if c2 >= col {
                    c2 += col_amount;
                }
            }
            let a = a1(c1, r1);
            let b = a1(c2, r2);
            if second.is_some() {
                format!("{a}:{b}")
            } else {
                a
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
fn parse_a1(value: &str) -> Option<(u32, u32)> {
    let clean = value.replace('$', "");
    let split = clean.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = clean.split_at(split);
    if letters.is_empty() {
        return None;
    }
    let mut col = 0u32;
    for ch in letters.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    Some((col, digits.parse().ok()?))
}
fn a1(mut col: u32, row: u32) -> String {
    let mut letters = String::new();
    while col > 0 {
        let rem = (col - 1) % 26;
        letters.insert(0, char::from_u32('A' as u32 + rem).unwrap());
        col = (col - 1) / 26;
    }
    format!("{letters}{row}")
}

fn roll_subject_specific(
    code: &str,
    source: &Workbook,
    target: &mut Workbook,
    wording: bool,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let mut copied = 0;
    match code {
        "C" => {
            copied += copy_labeled_values(
                source,
                target,
                "C.00 BKD",
                &["开户银行", "账户名称", "银行账号", "账号", "币种"],
            );
            if wording {
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["C.03"],
                    &["截止性测试", "审计说明", "结论"],
                    warnings,
                )?;
            }
        }
        "J1" => {
            if wording {
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["J.00", "J.01", "J.03"],
                    &["Notes", "长期挂账", "账龄", "审计说明", "结论"],
                    warnings,
                )?;
            }
        }
        "Q1" => {
            copied += copy_anchor_sections(
                source,
                target,
                &["Q1.01"],
                &["借款明细", "利息", "合计"],
                warnings,
            )?;
            if wording {
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["Q1.05"],
                    &["限制性条款", "已经触发限制性条款", "Notes"],
                    warnings,
                )?;
            }
        }
        "K1" => {
            copied += roll_k033_policy(source, target, warnings)?;
        }
        "L1" => {
            copied += roll_l103_policy(source, target);
            copied += roll_l1_schedule(source, target, warnings)?;
            copied += rebuild_l1_formulas(source, target);
            if wording {
                copied +=
                    copy_anchor_sections(source, target, &["L1.00"], &["账户变动"], warnings)?;
            }
        }
        "L2" => {
            copied += roll_l2_bkd(source, target, warnings)?;
            if wording {
                copied += roll_l2_lead_expectation(source, target)?;
                copied += roll_l2_all_notes(source, target, warnings)?;
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["L2.00", "L2.01"],
                    &["Notes", "调整汇总表"],
                    warnings,
                )?;
            }
        }
        "N" => {
            copied += roll_n_turnover_analysis(source, target);
            if wording {
                copied += copy_anchor_sections(source, target, &["N.00"], &["分析"], warnings)?;
            }
        }
        "Uexp" => {
            if wording {
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["U.00", "Uexp"],
                    &[
                        "调整汇总表",
                        "在下文中描述我们当期对账户波动的预期",
                        "Notes",
                    ],
                    warnings,
                )?;
                copied += copy_expense_bkd_sections(
                    source,
                    target,
                    &["在下文中描述我们当期对账户波动的预期", "Notes"],
                    warnings,
                )?;
            }
        }
        "UexpVCVD" => {
            if wording {
                copied += copy_anchor_sections(
                    source,
                    target,
                    &["VC.00", "VD.00"],
                    &[
                        "在下文中描述我们当期对账户波动的预期",
                        "波动说明",
                        "ARP波动说明",
                        "调整汇总表",
                    ],
                    warnings,
                )?;
                copied += roll_vcvd_cutoff_table2(source, target, warnings)?;
            }
        }
        _ => {}
    }
    Ok(copied)
}

fn roll_l103_policy(source: &Workbook, target: &mut Workbook) -> usize {
    let Some(src) = matching_sheet(source, "L1.03") else {
        return 0;
    };
    let Some(name) = matching_sheet_name(target, "L1.03") else {
        return 0;
    };
    let mut values = HashMap::<String, (String, String)>::new();
    for row in 1..=src.get_highest_row() {
        let category = src
            .get_cell((2, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let key = normalize(&category);
        if key.is_empty() || key.contains("资产类别") || key.contains("表2") {
            continue;
        }
        let life = src
            .get_cell((3, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let reason = src
            .get_cell((7, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        if !life.is_empty() || !reason.is_empty() {
            values.insert(key, (life, reason));
        }
    }
    let Ok(dst) = target.get_sheet_by_name_mut(&name) else {
        return 0;
    };
    let mut copied = 0;
    for row in 1..=dst.get_highest_row() {
        let key = normalize(
            &dst.get_cell((2, row))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        if let Some((life, reason)) = values.get(&key) {
            if !life.is_empty() {
                dst.get_cell_mut((4, row)).set_value(life);
                copied += 1;
            }
            if !reason.is_empty() {
                dst.get_cell_mut((7, row)).set_value(reason);
                copied += 1;
            }
        }
    }
    copied
}

fn roll_k033_policy(
    source: &Workbook,
    target: &mut Workbook,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Some(src) = matching_sheet(source, "K.03.3") else {
        return Ok(0);
    };
    let Some(name) = matching_sheet_name(target, "K.03.3") else {
        return Ok(0);
    };
    let mut rows = Vec::<(String, String, String)>::new();
    for row in 1..=src.get_highest_row() {
        let category = src
            .get_cell((2, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let life = src
            .get_cell((3, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let residual = src
            .get_cell((4, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let key = normalize(&category);
        if category.is_empty()
            || life.is_empty()
            || ["折旧", "资产类别", "notes", "表1", "公司折旧政策"]
                .iter()
                .any(|v| key.contains(v))
        {
            continue;
        }
        rows.push((category, life, residual));
    }
    if rows.is_empty() {
        return Ok(0);
    }
    let (start, capacity) = {
        let dst = target.get_sheet_by_name(&name).unwrap();
        let mut start = None;
        for row in 1..=dst.get_highest_row() {
            let text = (2..=7)
                .map(|c| {
                    normalize(
                        &dst.get_cell((c, row))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>();
            if text.iter().any(|v| v.contains("折旧政策"))
                && text.iter().any(|v| v.contains("使用寿命"))
            {
                start = Some(row + 1);
                break;
            }
        }
        let start = start.unwrap_or(13);
        let mut capacity = 0;
        for row in start..=dst.get_highest_row() {
            if normalize(
                &dst.get_cell((2, row))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            ) == "notes"
            {
                break;
            }
            if dst.get_cell((5, row)).is_some() {
                capacity += 1;
            }
        }
        (start, capacity)
    };
    if rows.len() as u32 > capacity {
        insert_rows_preserving_metadata(
            target,
            &name,
            start + capacity,
            rows.len() as u32 - capacity,
        )?;
    }
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    for (offset, (category, life, residual)) in rows.iter().enumerate() {
        let row = start + offset as u32;
        dst.get_cell_mut((2, row)).set_value(category);
        dst.get_cell_mut((3, row)).set_blank();
        dst.get_cell_mut((4, row)).set_blank();
        dst.get_cell_mut((6, row)).set_value(life);
        dst.get_cell_mut((7, row)).set_value(residual);
    }
    let notes = (1..=src.get_highest_row())
        .find(|r| {
            normalize(
                &src.get_cell((2, *r))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            ) == "notes"
        })
        .and_then(|r| {
            ((r + 1)..=src.get_highest_row()).find_map(|next| {
                src.get_cell((2, next))
                    .map(|v| v.get_value().to_string())
                    .filter(|v| !v.is_empty())
            })
        });
    if let Some(note) = notes {
        if let Some(row) = (1..=dst.get_highest_row()).find(|r| {
            normalize(
                &dst.get_cell((2, *r))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            ) == "notes"
        }) {
            dst.get_cell_mut((2, row + 1)).set_value(note);
        }
    }
    warnings.push("K.03.3 折旧政策已按原 Python 列位结转，请复核新增行公式。".into());
    Ok(rows.len() * 3)
}

fn roll_n_turnover_analysis(source: &Workbook, target: &mut Workbook) -> usize {
    let Some(src) = matching_sheet(source, "N.00") else {
        return 0;
    };
    let Some(name) = matching_sheet_name(target, "N.00") else {
        return 0;
    };
    let Some(source_section) = find_row(src, "表2应付账款周转率分析", 1, src.get_highest_row())
    else {
        return 0;
    };
    let Ok(dst) = target.get_sheet_by_name_mut(&name) else {
        return 0;
    };
    let Some(target_section) = find_row(dst, "表2应付账款周转率分析", 1, dst.get_highest_row())
    else {
        return 0;
    };
    let target_col = (target_section..=(target_section + 5).min(dst.get_highest_row()))
        .find_map(|row| {
            (1..=dst.get_highest_column().min(12)).find(|col| {
                dst.get_cell((*col, row))
                    .is_some_and(|v| v.get_value().to_uppercase().contains("PY"))
            })
        })
        .unwrap_or(5);
    let mut values = HashMap::<String, u32>::new();
    for row in source_section + 1..=(source_section + 20).min(src.get_highest_row()) {
        let label = normalize(
            &src.get_cell((2, row))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        if !label.is_empty()
            && src
                .get_cell((4, row))
                .is_some_and(|v| !v.get_value().is_empty())
        {
            values.insert(label, row);
        }
    }
    let mut copied = 0;
    for row in target_section + 1..=(target_section + 20).min(dst.get_highest_row()) {
        let label = normalize(
            &dst.get_cell((2, row))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        if let Some(source_row) = values.get(&label) {
            copied += copy_value(src, dst, 4, *source_row, target_col, row);
        }
    }
    copied
}

fn roll_l2_lead_expectation(source: &Workbook, target: &mut Workbook) -> Result<usize, AppError> {
    let Some(src) = matching_sheet(source, "L2.00") else {
        return Ok(0);
    };
    let Some(name) = matching_sheet_name(target, "L2.00") else {
        return Ok(0);
    };
    let Some(header) = (1..=src.get_highest_row().min(40)).find(|r| {
        normalize(
            &src.get_cell((3, *r))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        ) == "账户变动"
    }) else {
        return Ok(0);
    };
    let mut labels = Vec::new();
    let mut details = Vec::new();
    for row in header + 1..=header + 5 {
        let label = src
            .get_cell((3, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        let detail = src
            .get_cell((4, row))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        if !label.is_empty() || !detail.is_empty() {
            labels.push(label);
            details.push(detail);
        }
    }
    if labels.is_empty() {
        return Ok(0);
    }
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    dst.get_cell_mut((3, 14)).set_value("账户变动");
    dst.get_cell_mut((4, 14)).set_value("预期的依据和理由");
    dst.get_cell_mut((3, 15)).set_value(labels.join("\n"));
    dst.get_cell_mut((4, 15)).set_value(details.join("\n"));
    for coordinate in [(3, 14), (4, 14), (3, 15), (4, 15)] {
        dst.get_style_mut(coordinate)
            .set_background_color(HIGHLIGHT_FILL);
    }
    Ok(4)
}

fn copy_expense_bkd_sections(
    source: &Workbook,
    target: &mut Workbook,
    anchors: &[&str],
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let prefixes = source
        .get_sheet_collection()
        .iter()
        .filter(|s| s.get_name().contains("BKD") && s.get_name().contains("财务"))
        .map(|s| s.get_name().to_owned())
        .collect::<Vec<_>>();
    let refs = prefixes.iter().map(String::as_str).collect::<Vec<_>>();
    copy_anchor_sections(source, target, &refs, anchors, warnings)
}

fn roll_vcvd_cutoff_table2(
    source: &Workbook,
    target: &mut Workbook,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Some(src) = source
        .get_sheet_collection()
        .iter()
        .find(|s| s.get_name().contains("01.4") || s.get_name().contains("截止"))
    else {
        return Ok(0);
    };
    let Some(name) = target
        .get_sheet_collection()
        .iter()
        .find(|s| s.get_name().contains("01.4") || s.get_name().contains("截止"))
        .map(|s| s.get_name().to_owned())
    else {
        return Ok(0);
    };
    let Some(source_start) = find_row(src, "表2", 1, src.get_highest_row()) else {
        return Ok(0);
    };
    let source_end = find_row(src, "表3", source_start + 1, src.get_highest_row())
        .map(|v| v - 1)
        .unwrap_or((source_start + 20).min(src.get_highest_row()));
    let (target_start, target_end) = {
        let dst = target.get_sheet_by_name(&name).unwrap();
        let Some(start) = find_row(dst, "表2", 1, dst.get_highest_row()) else {
            return Ok(0);
        };
        let end = find_row(dst, "表3", start + 1, dst.get_highest_row())
            .map(|v| v - 1)
            .unwrap_or((start + 20).min(dst.get_highest_row()));
        (start, end)
    };
    let source_len = source_end - source_start + 1;
    let target_len = target_end - target_start + 1;
    if source_len > target_len {
        insert_rows_preserving_metadata(target, &name, target_end + 1, source_len - target_len)?;
    }
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    let mut copied = 0;
    for offset in 0..source_len {
        for col in 2..=src
            .get_highest_column()
            .min(dst.get_highest_column())
            .min(12)
        {
            let Some(cell) = src.get_cell((col, source_start + offset)) else {
                continue;
            };
            if cell.get_value().is_empty() {
                continue;
            }
            if !cell.get_formula().is_empty() {
                dst.get_cell_mut((col, target_start + offset))
                    .set_formula(cell.get_formula());
            } else {
                dst.get_cell_mut((col, target_start + offset))
                    .set_value(cell.get_value());
            }
            dst.get_style_mut((col, target_start + offset))
                .set_background_color(HIGHLIGHT_FILL);
            copied += 1;
        }
    }
    if copied > 0 {
        warnings.push("VC/VD 截止测试表2已结转并标黄。".into());
    }
    Ok(copied)
}

fn find_header_col_keywords(sheet: &Worksheet, row: u32, keywords: &[&str]) -> Option<u32> {
    (1..=sheet.get_highest_column().min(60)).find(|col| {
        let key = normalize(
            &sheet
                .get_cell((*col, row))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        keywords.iter().any(|v| key.contains(&normalize(v)))
    })
}
fn find_total_after(sheet: &Worksheet, header: u32) -> Option<u32> {
    for row in header + 1..=sheet.get_highest_row() {
        let text = (1..=sheet.get_highest_column().min(20))
            .map(|c| {
                normalize(
                    &sheet
                        .get_cell((c, row))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                )
            })
            .collect::<String>();
        if text.contains("合计") || text.contains("总计") || text == "净值" {
            return Some(row);
        }
        let formulas = (1..=sheet.get_highest_column().min(30))
            .filter(|c| {
                sheet
                    .get_cell((*c, row))
                    .is_some_and(|v| v.get_formula().to_uppercase().starts_with("SUM("))
            })
            .count();
        if formulas >= 2 {
            return Some(row);
        }
    }
    None
}
fn copy_row_within(sheet: &mut Worksheet, source_row: u32, target_row: u32, max_col: u32) {
    let cells = (1..=max_col)
        .map(|col| {
            sheet.get_cell((col, source_row)).map(|cell| {
                (
                    col,
                    cell.get_value().to_string(),
                    cell.get_formula().to_string(),
                    cell.get_style().clone(),
                )
            })
        })
        .flatten()
        .collect::<Vec<_>>();
    for (col, value, formula, style) in cells {
        let cell = sheet.get_cell_mut((col, target_row));
        cell.set_style(style);
        if !formula.is_empty() {
            cell.set_formula(formula);
        } else {
            cell.set_value(value);
        }
    }
}

fn roll_l1_schedule(
    source: &Workbook,
    target: &mut Workbook,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Ok(schedule) = source.get_sheet_by_name("后推明细表") else {
        return Ok(0);
    };
    let Some(lead_name) = matching_sheet_name(target, "L1.00") else {
        return Ok(0);
    };
    let Some(k01_name) = matching_sheet_name(target, "L1.01") else {
        return Ok(0);
    };
    let mut groups = Vec::<(String, u32, u32, u32)>::new();
    for col in 2..schedule.get_highest_column() {
        let label = schedule
            .get_cell((col, 2))
            .map(|v| v.get_value().to_string())
            .unwrap_or_default();
        if label.is_empty() {
            continue;
        }
        let book = normalize(
            &schedule
                .get_cell((col - 1, 3))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        let audit = normalize(
            &schedule
                .get_cell((col + 1, 3))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        if book.contains("账面数") && audit.contains("审定数") {
            groups.push((label, col - 1, col, col + 1));
        }
    }
    let total_col = groups
        .iter()
        .find(|v| normalize(&v.0).contains("合计"))
        .map(|v| v.3);
    let sections = [
        (&["原值"][..], "无形资产", "1701"),
        (&["累计摊销", "累计折旧"][..], "累计摊销", "1702"),
        (&["减值准备"][..], "减值准备", "1703"),
    ];
    let find_schedule_row = |names: &[&str]| -> Option<u32> {
        for name in names {
            let mut in_group = false;
            for row in 1..=schedule.get_highest_row() {
                let group = normalize(
                    &schedule
                        .get_cell((2, row))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                );
                if !group.is_empty() {
                    in_group = group.contains(&normalize(name));
                }
                let detail = normalize(
                    &schedule
                        .get_cell((3, row))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                );
                if in_group && detail.contains("年末余额") {
                    return Some(row);
                }
            }
        }
        None
    };
    let mut copied = 0;
    if let Some(total) = total_col {
        let lead = target.get_sheet_by_name_mut(&lead_name).unwrap();
        for (names, label, account) in &sections {
            if let Some(sr) = find_schedule_row(names) {
                if let Some(tr) = (1..=lead.get_highest_row()).find(|r| {
                    normalize(
                        &lead
                            .get_cell((3, *r))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                    .contains(&normalize(label))
                }) {
                    lead.get_cell_mut((2, tr)).set_value(*account);
                    copied += copy_value(schedule, lead, total, sr, 10, tr);
                }
            }
        }
    }
    let schedule_groups = groups
        .into_iter()
        .filter(|v| !normalize(&v.0).contains("合计"))
        .collect::<Vec<_>>();
    let (target_groups, opening_rows) = {
        let k = target.get_sheet_by_name(&k01_name).unwrap();
        let mut tg = Vec::new();
        for col in 2..k.get_highest_column() {
            let label = k
                .get_cell((col, 10))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default();
            let book = normalize(
                &k.get_cell((col - 1, 11))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            );
            let audit = normalize(
                &k.get_cell((col + 1, 11))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            );
            if !label.is_empty() && book.contains("账面数") && audit.contains("审定数") {
                tg.push((label, col - 1, col));
            }
        }
        let rows = (1..=k.get_highest_row())
            .filter(|r| {
                normalize(
                    &k.get_cell((3, *r))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                )
                .contains("年初余额")
            })
            .collect::<Vec<_>>();
        (tg, rows)
    };
    let k = target.get_sheet_by_name_mut(&k01_name).unwrap();
    for (index, (source_name, book_col, adjust_col, _)) in schedule_groups.iter().enumerate() {
        let Some((_, target_book, target_adjust)) = target_groups
            .iter()
            .find(|v| l1_category_key(source_name) == l1_category_key(&v.0))
            .or_else(|| target_groups.get(index))
        else {
            continue;
        };
        k.get_cell_mut((*target_adjust, 10)).set_value(source_name);
        for (section_index, (names, _, _)) in sections.iter().enumerate() {
            let Some(sr) = find_schedule_row(names) else {
                continue;
            };
            let Some(tr) = opening_rows.get(section_index) else {
                continue;
            };
            copied += copy_value(schedule, k, *book_col, sr, *target_book, *tr);
            copied += copy_value(schedule, k, *adjust_col, sr, *target_adjust, *tr);
        }
    }
    if copied > 0 {
        warnings.push("L1 后推明细表已写入 Lead 与 Agree SL to GL。".into());
    }
    Ok(copied)
}
fn l1_category_key(value: &str) -> String {
    let key = normalize(value);
    for token in ["土地", "非专利", "专利", "软件", "计算机", "其他"] {
        if key.contains(token) {
            return if token == "计算机" {
                "软件".into()
            } else {
                token.into()
            };
        }
    }
    key
}

fn rebuild_l1_formulas(source: &Workbook, target: &mut Workbook) -> usize {
    let Some(src) = matching_sheet(source, "L1.00") else {
        return 0;
    };
    let Some(name) = matching_sheet_name(target, "L1.00") else {
        return 0;
    };
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    let Some(header) = find_row(dst, "期末审定数", 1, 100) else {
        return 0;
    };
    let Some(total) = find_total_after(dst, header) else {
        return 0;
    };
    let source_header = find_row(src, "期末审定数", 1, 100).unwrap_or(header);
    let source_total = find_total_after(src, source_header).unwrap_or(src.get_highest_row());
    let source_rows = (source_header + 1..source_total)
        .filter_map(|r| {
            let key = normalize(
                &src.get_cell((3, r))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default(),
            );
            if key.is_empty() { None } else { Some((key, r)) }
        })
        .collect::<HashMap<_, _>>();
    let fluctuation = find_row(dst, "波动范围", 1, dst.get_highest_row()).unwrap_or(31);
    let mut changed = 0;
    let mut details = Vec::new();
    for row in header + 1..total {
        let name = normalize(
            &dst.get_cell((3, row))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default(),
        );
        if name.is_empty() || name == "合计" || name == "净值" {
            continue;
        }
        let sign = if name.contains("累计摊销") || name.contains("减值准备") {
            -1
        } else {
            1
        };
        details.push((row, sign));
        if let Some(sr) = source_rows.get(&name) {
            if dst
                .get_cell((5, row))
                .is_none_or(|v| v.get_value().is_empty())
            {
                if let Some(cell) = src
                    .get_cell((5, *sr))
                    .filter(|v| !v.get_formula().is_empty())
                {
                    dst.get_cell_mut((5, row)).set_formula(cell.get_formula());
                    changed += 1;
                }
            }
        }
        for (col, formula) in [
            (7, format!("=E{row}+F{row}")),
            (9, format!("=G{row}+H{row}")),
            (11, format!("=I{row}-J{row}")),
            (12, format!("=IF(J{row}<>0,K{row}/J{row},1)")),
            (
                14,
                format!(
                    "=IF(AND(ABS(K{row})>=$C${},ABS(L{row})>=$C${}),\"是\",\"否\")",
                    fluctuation + 1,
                    fluctuation + 2
                ),
            ),
        ] {
            if dst
                .get_cell((col, row))
                .is_none_or(|v| v.get_value().is_empty())
            {
                dst.get_cell_mut((col, row))
                    .set_formula(formula.trim_start_matches('='));
                changed += 1;
            }
        }
    }
    for col in 5..=11 {
        let letter = a1(col, 0).trim_end_matches('0').to_owned();
        let terms = details
            .iter()
            .enumerate()
            .map(|(i, (row, sign))| {
                format!(
                    "{}{}{}",
                    if *sign < 0 {
                        "-"
                    } else if i > 0 {
                        "+"
                    } else {
                        ""
                    },
                    letter,
                    row
                )
            })
            .collect::<String>();
        dst.get_cell_mut((col, total)).set_formula(terms);
        changed += 1;
    }
    dst.get_cell_mut((12, total))
        .set_formula(format!("IF(J{total}<>0,K{total}/J{total},1)"));
    changed + 1
}

fn roll_l2_bkd(
    source: &Workbook,
    target: &mut Workbook,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Some(src) = source
        .get_sheet_collection()
        .iter()
        .filter(|s| s.get_name().contains("L2.01.1"))
        .max_by_key(|s| s.get_highest_row())
    else {
        return Ok(0);
    };
    let Some(name) = target
        .get_sheet_collection()
        .iter()
        .find(|s| s.get_name().contains("L2.01.1"))
        .map(|s| s.get_name().to_owned())
    else {
        return Ok(0);
    };
    let Some(sh) = (1..=src.get_highest_row().min(100)).find(|r| {
        let text = (1..=src.get_highest_column().min(20))
            .map(|c| {
                normalize(
                    &src.get_cell((c, *r))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                )
            })
            .collect::<String>();
        text.contains("项目名称") && (text.contains("项目编码") || text.contains("序号"))
    }) else {
        return Ok(0);
    };
    let Some(stotal) = find_total_after(src, sh) else {
        return Ok(0);
    };
    let (th, total, business_end) = {
        let dst = target.get_sheet_by_name(&name).unwrap();
        let Some(h) = (1..=dst.get_highest_row().min(100)).find(|r| {
            let text = (1..=dst.get_highest_column().min(20))
                .map(|c| {
                    normalize(
                        &dst.get_cell((c, *r))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                })
                .collect::<String>();
            text.contains("项目名称") && (text.contains("项目编码") || text.contains("序号"))
        }) else {
            return Ok(0);
        };
        let Some(t) = find_total_after(dst, h) else {
            return Ok(0);
        };
        let end = (1..=dst.get_highest_column().min(60))
            .filter(|c| {
                (h.saturating_sub(2)..=h).any(|r| {
                    dst.get_cell((*c, r))
                        .is_some_and(|v| !v.get_value().is_empty())
                })
            })
            .max()
            .unwrap_or(0);
        (h, t, end)
    };
    if business_end < 18 {
        return Ok(0);
    }
    let records = (sh + 1..stotal)
        .filter_map(|r| {
            let code = src
                .get_cell((3, r))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default();
            let project = src
                .get_cell((4, r))
                .map(|v| v.get_value().to_string())
                .unwrap_or_default();
            if code.is_empty() && project.is_empty() {
                None
            } else {
                Some((r, code, project))
            }
        })
        .collect::<Vec<_>>();
    if records.is_empty() {
        return Ok(0);
    }
    let start = th + 1;
    let available = total - start;
    let extra = (records.len() as u32).saturating_sub(available);
    if extra > 0 {
        insert_rows_preserving_metadata(target, &name, total, extra)?;
    }
    let new_total = total + extra;
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    let formula_source = (start..new_total)
        .find(|r| {
            [12, 14, 18].iter().any(|c| {
                dst.get_cell((*c, *r))
                    .is_some_and(|v| !v.get_formula().is_empty())
            })
        })
        .unwrap_or(start);
    for (index, (sr, _, _)) in records.iter().enumerate() {
        let row = start + index as u32;
        if row != formula_source {
            copy_row_within(dst, formula_source, row, business_end);
        }
        for (sc, tc) in [(3, 3), (4, 4), (5, 5), (6, 6), (14, 7), (18, 15)] {
            let _ = copy_value(src, dst, sc, *sr, tc, row);
        }
        for col in [8, 9, 10, 11, 13, 16, 17] {
            dst.get_cell_mut((col, row)).set_blank();
        }
        dst.get_cell_mut((12, row))
            .set_formula(format!("G{row}+H{row}-I{row}"));
        dst.get_cell_mut((14, row))
            .set_formula(format!("L{row}+M{row}"));
        dst.get_cell_mut((18, row))
            .set_formula(format!("O{row}+P{row}-Q{row}"));
    }
    let last = start + records.len() as u32 - 1;
    for col in 7..=18 {
        if dst
            .get_cell((col, new_total))
            .is_some_and(|v| !v.get_formula().is_empty())
        {
            let letter = a1(col, 0).trim_end_matches('0').to_owned();
            dst.get_cell_mut((col, new_total))
                .set_formula(format!("SUM({letter}{start}:{letter}{last})"));
        }
    }
    extend_validations_to_row(dst, start, total - 1, last, business_end);
    warnings.push("L2 BKD 已按项目记录扩容并重建余额公式。".into());
    Ok(records.len() * 6)
}
fn extend_validations_to_row(
    sheet: &mut Worksheet,
    data_start: u32,
    old_end: u32,
    new_end: u32,
    business_end: u32,
) {
    if let Some(vs) = sheet.get_data_validations_mut() {
        for validation in vs.get_data_validation_list_mut() {
            let raw = validation.get_sequence_of_references().get_sqref();
            let updated = raw
                .split_whitespace()
                .map(|range| {
                    let mut p = range.split(':');
                    let a = p.next().unwrap_or("");
                    let b = p.next().unwrap_or(a);
                    let Some((c1, r1)) = parse_a1(a) else {
                        return range.into();
                    };
                    let Some((c2, r2)) = parse_a1(b) else {
                        return range.into();
                    };
                    if c1 <= business_end && r1 <= old_end && r2 >= data_start {
                        format!("{}:{}", a1(c1, r1.min(data_start)), a1(c2, new_end.max(r2)))
                    } else {
                        range.into()
                    }
                })
                .collect::<Vec<String>>()
                .join(" ");
            let refs = validation.get_sequence_of_references_mut();
            refs.remove_range_collection();
            refs.set_sqref(updated);
        }
    }
}

fn roll_l2_all_notes(
    source: &Workbook,
    target: &mut Workbook,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Some(src) = source
        .get_sheet_collection()
        .iter()
        .find(|s| s.get_name().contains("L2.01.1"))
    else {
        return Ok(0);
    };
    let Some(name) = target
        .get_sheet_collection()
        .iter()
        .find(|s| s.get_name().contains("L2.01.1"))
        .map(|s| s.get_name().to_owned())
    else {
        return Ok(0);
    };
    let source_notes = (1..=src.get_highest_row())
        .filter(|r| {
            (1..=src.get_highest_column().min(12)).any(|c| {
                normalize(
                    &src.get_cell((c, *r))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                )
                .starts_with("notes")
            })
        })
        .collect::<Vec<_>>();
    if source_notes.is_empty() {
        return Ok(0);
    }
    let mut target_notes = {
        let dst = target.get_sheet_by_name(&name).unwrap();
        (1..=dst.get_highest_row())
            .filter(|r| {
                (1..=dst.get_highest_column().min(12)).any(|c| {
                    normalize(
                        &dst.get_cell((c, *r))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                    .starts_with("notes")
                })
            })
            .collect::<Vec<_>>()
    };
    if target_notes.is_empty() {
        return Ok(0);
    }
    while target_notes.len() < source_notes.len() {
        let template = *target_notes.last().unwrap();
        let insert_at = template + 4;
        insert_rows_preserving_metadata(target, &name, insert_at, 4)?;
        let dst = target.get_sheet_by_name_mut(&name).unwrap();
        for offset in 0..4 {
            copy_row_within(
                dst,
                template + offset,
                insert_at + offset,
                dst.get_highest_column().min(40),
            );
        }
        target_notes.push(insert_at);
    }
    let dst = target.get_sheet_by_name_mut(&name).unwrap();
    let mut copied = 0;
    for (sr, tr) in source_notes.iter().zip(target_notes.iter()) {
        for offset in 1..=3 {
            for col in 1..=src
                .get_highest_column()
                .min(dst.get_highest_column())
                .min(40)
            {
                let Some(cell) = src.get_cell((col, sr + offset)) else {
                    continue;
                };
                if cell.get_value().is_empty() {
                    continue;
                }
                if !cell.get_formula().is_empty() {
                    dst.get_cell_mut((col, tr + offset))
                        .set_formula(cell.get_formula());
                } else {
                    dst.get_cell_mut((col, tr + offset))
                        .set_value(cell.get_value());
                }
                dst.get_style_mut((col, tr + offset))
                    .set_background_color(HIGHLIGHT_FILL);
                copied += 1;
            }
        }
    }
    if copied > 0 {
        warnings.push("L2 全部 Notes 响应框已按出现顺序结转。".into());
    }
    Ok(copied)
}

fn roll_date_sensitive_subjects(
    code: &str,
    source: &Workbook,
    target: &mut Workbook,
    date: NaiveDate,
    wording: bool,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    if code != "N" {
        return Ok(0);
    }
    roll_n_detail(source, target, date, wording, warnings)
}
fn roll_n_detail(
    source: &Workbook,
    target: &mut Workbook,
    date: NaiveDate,
    wording: bool,
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let Ok(src) = source.get_sheet_by_name("N.01.01明细账") else {
        return Ok(0);
    };
    let Ok(dst) = target.get_sheet_by_name_mut("N.01.01明细账") else {
        return Ok(0);
    };
    for cell in dst.cells_mut() {
        cell.set_blank();
    }
    for cell in src.cells() {
        let col = cell.coordinate().col_num();
        let row = cell.coordinate().row_num();
        let target_cell = dst.get_cell_mut((col, row));
        target_cell.set_style(cell.get_style().clone());
        if !cell.get_formula().is_empty() {
            target_cell.set_formula(cell.get_formula());
        } else {
            target_cell.set_value(cell.get_value());
        }
    }
    dst.get_merge_cells_mut().clear();
    for range in src.get_merge_cells() {
        dst.add_merge_cells(range.range());
    }
    dst.set_conditional_formatting_collection(src.get_conditional_formatting_collection().to_vec());
    if let Some(v) = src.get_data_validations() {
        dst.set_data_validations(v.clone());
    }
    for (col, row, value) in [
        (8, 5, date.format("%Y/%m/%d").to_string()),
        (14, 5, format!("{}/12/31", date.year() - 1)),
        (3, 225, date.format("%Y/%m/%d").to_string()),
        (5, 225, format!("{}/12/31", date.year() - 1)),
        (4, 257, date.format("%Y/%m/%d").to_string()),
    ] {
        dst.get_cell_mut((col, row)).set_value(value);
    }
    let Some(header) = find_row(dst, "期末审定数", 1, 30) else {
        return Ok(0);
    };
    let total = find_total_after(dst, header).unwrap_or(dst.get_highest_row() + 1);
    let closing = find_header_col_keywords(dst, header, &["期末审定数"]).unwrap_or(13);
    let py = find_header_col_keywords(dst, header, &["上期末审定数", "上年数"]).unwrap_or(14);
    let current = [
        "原币金额",
        "期末账面数",
        "本期审计调整编号",
        "审计调整",
        "重分类调整",
    ]
    .iter()
    .filter_map(|v| find_header_col_keywords(dst, header, &[*v]))
    .chain(std::iter::once(closing))
    .collect::<HashSet<_>>();
    let mut copied = 0;
    for row in header + 1..total {
        copied += copy_value(src, dst, closing, row, py, row);
        for col in &current {
            if *col != py
                && dst
                    .get_cell((*col, row))
                    .is_some_and(|v| v.get_formula().is_empty())
            {
                dst.get_cell_mut((*col, row)).set_blank();
            }
        }
    }
    if !wording {
        if let Some(start) = find_row(dst, "对于单项变动金额", 1, dst.get_highest_row()) {
            for row in start..=dst.get_highest_row() {
                for col in 2..=8 {
                    if dst
                        .get_cell((col, row))
                        .is_some_and(|v| v.get_formula().is_empty())
                    {
                        dst.get_cell_mut((col, row)).set_blank();
                    }
                }
            }
        }
    } else {
        warnings.push("N 明细分析文字已保留并标记为复核范围。".into());
    }
    Ok(copied)
}

fn matching_sheet<'a>(book: &'a Workbook, prefix: &str) -> Option<&'a Worksheet> {
    let key = normalize(prefix);
    book.get_sheet_collection()
        .iter()
        .find(|s| normalize(s.get_name()).starts_with(&key))
}
fn matching_sheet_name(book: &Workbook, prefix: &str) -> Option<String> {
    matching_sheet(book, prefix).map(|s| s.get_name().to_owned())
}

fn copy_labeled_values(
    source: &Workbook,
    target: &mut Workbook,
    prefix: &str,
    labels: &[&str],
) -> usize {
    let Some(src) = matching_sheet(source, prefix) else {
        return 0;
    };
    let Some(name) = matching_sheet_name(target, prefix) else {
        return 0;
    };
    let Ok(dst) = target.get_sheet_by_name_mut(&name) else {
        return 0;
    };
    let (scols, srows) = src.get_highest_column_and_row();
    let (dcols, drows) = dst.get_highest_column_and_row();
    let mut copied = 0;
    for label in labels {
        let key = normalize(label);
        let source_pos = (1..=srows).find_map(|r| {
            (1..=scols.min(20))
                .find(|c| {
                    normalize(
                        &src.get_cell((*c, r))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                    .contains(&key)
                })
                .map(|c| (c, r))
        });
        let target_pos = (1..=drows).find_map(|r| {
            (1..=dcols.min(20))
                .find(|c| {
                    normalize(
                        &dst.get_cell((*c, r))
                            .map(|v| v.get_value().to_string())
                            .unwrap_or_default(),
                    )
                    .contains(&key)
                })
                .map(|c| (c, r))
        });
        if let (Some((sc, sr)), Some((dc, dr))) = (source_pos, target_pos) {
            copied += copy_value(src, dst, (sc + 1).min(scols), sr, dc + 1, dr);
        }
    }
    copied
}

/// Bounded section copier used by the subject-specific wording/table paths.
/// It grows the template block only when the prior section has more populated
/// rows.  Workbook insertion is used so formulas, names, drawings, merges and
/// conditional formats shift together; data validation is adjusted explicitly.
fn copy_anchor_sections(
    source: &Workbook,
    target: &mut Workbook,
    prefixes: &[&str],
    anchors: &[&str],
    warnings: &mut Vec<String>,
) -> Result<usize, AppError> {
    let mut copied = 0;
    for prefix in prefixes {
        let Some(src) = matching_sheet(source, prefix) else {
            continue;
        };
        let Some(name) = matching_sheet_name(target, prefix) else {
            continue;
        };
        for anchor in anchors {
            let Some(sr) = find_row(src, anchor, 1, src.get_highest_row()) else {
                continue;
            };
            let Some(dr) = ({
                let dst = target.get_sheet_by_name(&name).unwrap();
                find_row(dst, anchor, 1, dst.get_highest_row())
            }) else {
                continue;
            };
            let src_end = section_end(src, sr, 30);
            let dst_end = {
                let dst = target.get_sheet_by_name(&name).unwrap();
                section_end(dst, dr, 30)
            };
            let source_len = src_end - sr + 1;
            let target_len = dst_end - dr + 1;
            if source_len > target_len {
                insert_rows_preserving_metadata(
                    target,
                    &name,
                    dst_end + 1,
                    source_len - target_len,
                )?;
            }
            let dst = target.get_sheet_by_name_mut(&name).unwrap();
            let max_col = src
                .get_highest_column()
                .min(dst.get_highest_column())
                .min(40);
            for offset in 0..source_len {
                for col in 1..=max_col {
                    let Some(cell) = src.get_cell((col, sr + offset)) else {
                        continue;
                    };
                    let value = cell.get_value().to_string();
                    if value.is_empty() {
                        continue;
                    }
                    let target_cell = dst.get_cell_mut((col, dr + offset));
                    if !cell.get_formula().is_empty() {
                        target_cell.set_formula(cell.get_formula());
                    } else {
                        target_cell.set_value(value);
                    }
                    dst.get_style_mut((col, dr + offset))
                        .set_background_color(HIGHLIGHT_FILL);
                    copied += 1;
                }
            }
        }
    }
    if copied > 0 {
        warnings.push("专项区块已结转并标黄，请项目组逐项复核。".into());
    }
    Ok(copied)
}
fn section_end(sheet: &Worksheet, start: u32, max_rows: u32) -> u32 {
    let (max_col, max_row) = sheet.get_highest_column_and_row();
    let mut last = start;
    let mut blanks = 0;
    for row in start..=(start + max_rows).min(max_row) {
        let nonempty = (1..=max_col.min(40)).any(|c| {
            sheet
                .get_cell((c, row))
                .is_some_and(|v| !v.get_value().trim().is_empty())
        });
        if nonempty {
            last = row;
            blanks = 0
        } else {
            blanks += 1;
            if blanks >= 2 {
                break;
            }
        }
    }
    last
}

fn fill_labeled_headers(
    book: &mut Workbook,
    company: &str,
    date: NaiveDate,
    params: &Value,
    info: &HashMap<String, String>,
    warnings: &mut Vec<String>,
) {
    let supplied = |param: &str, field: &str| {
        let explicit = json_text(&params[param]);
        if explicit.is_empty() {
            info.get(field).cloned().unwrap_or_default()
        } else {
            explicit
        }
    };
    let level = supplied("levelValue", "Level");
    let rp = supplied("rpValue", "RP");
    let pm = supplied("pmValue", "PM");
    let te = supplied("teValue", "TE");
    let sad = supplied("sadValue", "SAD");
    for (field, value) in [
        ("Level", &level),
        ("RP", &rp),
        ("PM", &pm),
        ("TE", &te),
        ("SAD", &sad),
    ] {
        if value.is_empty() {
            warnings.push(format!("PMTE信息表中未找到{field}数据，请手动填写"));
        }
    }
    let values = [
        (
            &["客户名称", "公司名称", "被审计单位", "客户"][..],
            company.to_owned(),
        ),
        (
            &["资产负债表日", "报告日期", "截止日期", "期末"][..],
            date.format("%Y-%m-%d").to_string(),
        ),
        (
            &["记账本位币", "本位币", "功能货币"][..],
            params["functionalCurrency"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        ),
        (
            &["适用会计准则", "会计准则"][..],
            params["accountingStandard"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        ),
        (&["项目层级", "LEVEL", "Level"][..], level),
        (&["风险比例", "RP"][..], rp),
        (&["重要性水平", "PM"][..], pm),
        (&["可容忍误差", "执行重要性", "TE"][..], te),
        (&["名义金额", "明显微小错报", "SAD"][..], sad),
    ];
    for sheet in book.get_sheet_collection_mut() {
        let (max_col, max_row) = sheet.get_highest_column_and_row();
        for row in 1..=max_row.min(25) {
            for col in 1..=max_col.min(20) {
                let label = normalize(
                    &sheet
                        .get_cell((col, row))
                        .map(|c| c.get_value().to_string())
                        .unwrap_or_default(),
                );
                for (keys, value) in &values {
                    if !value.is_empty() && keys.iter().any(|k| label.contains(&normalize(k))) {
                        sheet
                            .get_cell_mut(((col + 1).min(max_col), row))
                            .set_value(value);
                    }
                }
            }
        }
    }
}

fn extract_company_info(
    pmte_path: &str,
    company: &str,
) -> Result<HashMap<String, String>, AppError> {
    let mut result = HashMap::new();
    if pmte_path.trim().is_empty() {
        return Ok(result);
    }
    let prepared = crate::spreadsheet_input::prepare_xlsx(Path::new(pmte_path))?;
    let book = umya_spreadsheet::reader::xlsx::read(prepared.path()).map_err(xlsx_read_error)?;
    let Ok(sheet) = book.get_sheet_by_name("PMTE") else {
        return Ok(result);
    };
    let (_, max_row) = sheet.get_highest_column_and_row();
    let company_key = normalize(company);
    for row in 2..=max_row {
        let candidate = sheet
            .get_cell((1, row))
            .map(|c| c.get_value().to_string())
            .unwrap_or_default();
        let key = normalize(&candidate);
        if !key.is_empty() && (key.contains(&company_key) || company_key.contains(&key)) {
            for (col, name) in [(2, "Level"), (3, "RP"), (4, "PM"), (5, "TE"), (6, "SAD")] {
                let value = sheet
                    .get_cell((col, row))
                    .map(|c| c.get_value().to_string())
                    .unwrap_or_default();
                if !value.is_empty() {
                    result.insert(name.into(), value);
                }
            }
            break;
        }
    }
    Ok(result)
}

/// Row labels that open a narrative block worth carrying to the new year.
const WORDING_ANCHORS: &[&str] = &[
    "预期",
    "波动说明",
    "波动分析",
    "波动原因",
    "分析说明",
    "审计说明",
    "Notes",
    "调整汇总",
    "调整分录",
    "调整事项",
    "ARP",
];

/// Anchors whose block is a table, so its figures are part of the wording.
const WORDING_NUMERIC_ANCHORS: &[&str] = &["调整汇总", "调整分录", "调整事项"];

/// Labels that close a narrative block.  Running past one of these is how the
/// prior year's data headers and figures used to leak into the new workpaper.
const WORDING_STOPS: &[&str] = &[
    "账套名称",
    "期末审定数",
    "期初审定数",
    "科目编码",
    "科目名称",
    "索引号",
    "年初余额",
    "年末余额",
    "本期发生额",
    "合计",
    "小计",
];

/// Hard ceiling on how far a single block may run.
const WORDING_MAX_ROWS: u32 = 30;

fn is_numeric_text(value: &str) -> bool {
    let cleaned = value.trim().replace([',', '%', '(', ')', '-'], "");
    !cleaned.is_empty() && cleaned.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Carry the prior year's narrative sections into the new workpaper.
///
/// The previous implementation matched a broad keyword list (including
/// "审计程序" and "结论"), then copied a fixed 8×40 window of everything
/// non-formula — which dragged last year's figures and standard audit
/// conclusions into this year's template and highlighted them as if they were
/// current. Anchor on the narrative labels only, stop at the first data header,
/// and copy text unless the block is an adjustment table.
fn roll_wording(source: &Workbook, target: &mut Workbook, warnings: &mut Vec<String>) -> usize {
    let mut copied = 0;
    let mut skipped_numeric = 0usize;
    for src in source.get_sheet_collection() {
        let name = src.get_name();
        if src.sheet_state() == "hidden" || name == "Roll Forward Summary" {
            continue;
        }
        let Ok(dst) = target.get_sheet_by_name_mut(name) else {
            continue;
        };
        let (max_col, max_row) = src.get_highest_column_and_row();
        let text_at = |col: u32, row: u32| {
            src.get_cell((col, row))
                .map(|value| value.get_value().to_string())
                .unwrap_or_default()
        };
        let label_of = |row: u32| {
            (1..=max_col.min(12))
                .map(|col| text_at(col, row))
                .collect::<Vec<_>>()
                .join("")
        };
        let mut row = 1;
        while row <= max_row {
            let label = label_of(row);
            let Some(anchor) = WORDING_ANCHORS
                .iter()
                .find(|anchor| label.contains(*anchor))
            else {
                row += 1;
                continue;
            };
            let keep_numbers = WORDING_NUMERIC_ANCHORS.contains(anchor);
            let mut blank_run = 0;
            let mut end = row;
            for candidate in row..=(row + WORDING_MAX_ROWS).min(max_row) {
                let text = label_of(candidate);
                if candidate > row && WORDING_STOPS.iter().any(|stop| text.contains(stop)) {
                    break;
                }
                if candidate > row && WORDING_ANCHORS.iter().any(|other| text.contains(*other)) {
                    break;
                }
                if text.trim().is_empty() {
                    blank_run += 1;
                    if blank_run >= 2 {
                        break;
                    }
                } else {
                    blank_run = 0;
                }
                end = candidate;
            }
            for r in row..=end {
                for col in 1..=max_col.min(40) {
                    let value = text_at(col, r);
                    if value.trim().is_empty() || value.starts_with('=') {
                        continue;
                    }
                    if !keep_numbers && is_numeric_text(&value) {
                        skipped_numeric += 1;
                        continue;
                    }
                    // Never clobber a formula the new template supplies.
                    if !dst
                        .get_cell((col, r))
                        .map(|cell| cell.get_formula().is_empty())
                        .unwrap_or(true)
                    {
                        continue;
                    }
                    dst.get_cell_mut((col, r)).set_value(value);
                    dst.get_style_mut((col, r))
                        .set_background_color(HIGHLIGHT_FILL);
                    copied += 1;
                }
            }
            row = end + 1;
        }
    }
    if copied > 0 {
        warnings.push("已 roll forward wording，请项目组更新黄色标注区域".into());
    }
    if skipped_numeric > 0 {
        warnings.push(format!(
            "wording 区域内的 {skipped_numeric} 个数字未结转，请按本年度实际情况填写"
        ));
    }
    copied
}

fn apply_cra_records(
    book: &mut Workbook,
    code: &str,
    records: &[Value],
    warnings: &mut Vec<String>,
) -> usize {
    let applicable = records
        .iter()
        .filter(|r| {
            let subject = r
                .get("subject_code")
                .or_else(|| r.get("subjectCode"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let status = r
                .get("match_status")
                .or_else(|| r.get("matchStatus"))
                .and_then(Value::as_str)
                .unwrap_or("将写入");
            subject.eq_ignore_ascii_case(code) && status == "将写入"
        })
        .collect::<Vec<_>>();
    if applicable.is_empty() {
        return 0;
    }
    let mut matched = HashSet::new();
    for sheet in book.get_sheet_collection_mut() {
        let (max_col, max_row) = sheet.get_highest_column_and_row();
        let mut tables = Vec::new();
        for row in 1..=max_row.min(300) {
            let mut assertion_col = 0;
            let mut cra_col = 0;
            let mut ratio_col = 0;
            for col in 1..=max_col.min(20) {
                let label = normalize(
                    &sheet
                        .get_cell((col, row))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default(),
                )
                .to_uppercase();
                if label.contains("认定") && !label.contains("比例") {
                    assertion_col = col;
                }
                if label.contains("CRA") || label.contains("风险等级") {
                    cra_col = col;
                }
                if label.contains("比例")
                    || label.contains("THRESHOLD")
                    || label.contains("各项认定")
                {
                    ratio_col = col;
                }
            }
            if assertion_col > 0 && cra_col > 0 {
                tables.push((row, assertion_col, cra_col, ratio_col));
            }
        }
        if tables.is_empty() {
            continue;
        }
        for (table_index, (header, assertion_col, cra_col, ratio_col)) in
            tables.iter().copied().enumerate()
        {
            let table_end = tables
                .get(table_index + 1)
                .map(|next| next.0.saturating_sub(1))
                .unwrap_or(max_row);
            for row in header + 1..=table_end {
                let assertion_text = sheet
                    .get_cell((assertion_col, row))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default();
                let Some(assertion) = normalize_cra_assertion(&assertion_text) else {
                    continue;
                };
                for (index, record) in applicable.iter().enumerate() {
                    let record_assertion = record
                        .get("assertion")
                        .and_then(Value::as_str)
                        .and_then(normalize_cra_assertion)
                        .unwrap_or_default();
                    if record_assertion != assertion {
                        continue;
                    }
                    let cra = record
                        .get("cra_level")
                        .or_else(|| record.get("craLevel"))
                        .and_then(Value::as_str)
                        .unwrap_or("N/A");
                    sheet.get_cell_mut((cra_col, row)).set_value(cra);
                    sheet
                        .get_style_mut((cra_col, row))
                        .set_background_color(HIGHLIGHT_FILL);
                    if ratio_col > 0 {
                        let is_applicable = record
                            .get("applicable")
                            .and_then(Value::as_bool)
                            .unwrap_or(!matches!(cra, "N/A" | "不适用"));
                        if is_applicable {
                            if let Some(ratio) = record.get("ratio").and_then(Value::as_f64) {
                                sheet.get_cell_mut((ratio_col, row)).set_value_number(ratio);
                            }
                        } else {
                            sheet.get_cell_mut((ratio_col, row)).set_value("N/A");
                        }
                        sheet
                            .get_style_mut((ratio_col, row))
                            .set_background_color(HIGHLIGHT_FILL);
                    }
                    matched.insert(index);
                    break;
                }
            }
        }
    }
    if matched.len() < applicable.len() {
        warnings.push(format!(
            "CRA 有 {} 项未定位到模板，请手工复核。",
            applicable.len() - matched.len()
        ));
    }
    matched.len()
}

fn workbook_snapshot(book: &Workbook) -> HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    for sheet in book.get_sheet_collection() {
        let sheet_name = sheet.get_name();
        for cell in sheet.cells() {
            let coordinate = cell.coordinate();
            result.insert(
                format!(
                    "{sheet_name}!{}:{}",
                    coordinate.col_num(),
                    coordinate.row_num()
                ),
                (cell.get_value().to_string(), cell.get_formula().to_string()),
            );
        }
    }
    result
}
fn workbook_diff(before: &HashMap<String, (String, String)>, after: &Workbook) -> WorkbookDiff {
    let current = workbook_snapshot(after);
    let mut result = WorkbookDiff::default();
    let mut touched = HashSet::new();
    // Keyed by (sheet, col, row) so the detail list can be sorted the way a
    // reviewer reads a worksheet instead of in hash order.
    let mut ordered: Vec<(String, u32, u32, CellChange)> = Vec::new();
    for (key, value) in &current {
        let Some((sheet, position)) = key.split_once('!') else {
            continue;
        };
        let (col, row) = position
            .split_once(':')
            .and_then(|(col, row)| Some((col.parse::<u32>().ok()?, row.parse::<u32>().ok()?)))
            .unwrap_or((0, 0));
        let old = before.get(key);
        let added = old.is_none();
        let changed = match old {
            None => true,
            Some(old) => old != value,
        };
        if !changed {
            continue;
        }
        if added {
            result.added_cells += 1;
        } else {
            result.changed_cells += 1;
            if old.map(|old| old.1 != value.1).unwrap_or(false) {
                result.formula_changes += 1;
            }
        }
        touched.insert(sheet.to_owned());
        ordered.push((
            sheet.to_owned(),
            col,
            row,
            CellChange {
                sheet: sheet.to_owned(),
                cell: format!("{}{row}", column_letters(col)),
                before: old.map(|old| old.0.clone()).unwrap_or_default(),
                after: value.0.clone(),
                formula_before: old.map(|old| old.1.clone()).unwrap_or_default(),
                formula_after: value.1.clone(),
                added,
            },
        ));
    }
    ordered.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)).then(a.1.cmp(&b.1)));
    result.changes = ordered
        .into_iter()
        .take(SUMMARY_DETAIL_LIMIT)
        .map(|(_, _, _, change)| change)
        .collect();
    for sheet in after.get_sheet_collection() {
        let sheet_name = sheet.get_name().to_owned();
        for cell in sheet.cells() {
            let coordinate = cell.coordinate();
            let filled = sheet
                .get_style((coordinate.col_num(), coordinate.row_num()))
                .get_background_color()
                .map(|color| color.argb_str().to_uppercase().ends_with(HIGHLIGHT_FILL))
                .unwrap_or(false);
            if filled {
                result.highlighted.push((
                    sheet_name.clone(),
                    format!(
                        "{}{}",
                        column_letters(coordinate.col_num()),
                        coordinate.row_num()
                    ),
                ));
            }
        }
    }
    result.highlighted.sort();
    result.touched_sheets = touched.into_iter().collect();
    result.touched_sheets.sort();
    result
}

fn add_summary(
    book: &mut Workbook,
    code: &str,
    name: &str,
    company: &str,
    date: NaiveDate,
    prior: &Path,
    copied: usize,
    diff: &WorkbookDiff,
    warnings: &[String],
) -> Result<(), AppError> {
    let sheet_name = "Roll Forward Summary";
    if book.get_sheet_by_name(sheet_name).is_err() {
        book.new_sheet(sheet_name).map_err(|e| {
            error(
                "ROLL_FORWARD_SUMMARY_FAILED",
                "无法创建结转摘要。",
                Some(e.to_string()),
            )
        })?;
    }
    let sheet = book.get_sheet_by_name_mut(sheet_name).map_err(|e| {
        error(
            "ROLL_FORWARD_SUMMARY_FAILED",
            "无法读取结转摘要。",
            Some(e.to_string()),
        )
    })?;
    let rows = [
        ("科目", format!("{code} {name}")),
        ("公司", company.into()),
        ("资产负债表日", date.format("%Y-%m-%d").to_string()),
        ("上年底稿", prior.to_string_lossy().into_owned()),
        ("Rust 原生复制单元格", copied.to_string()),
        ("变更单元格", diff.changed_cells.to_string()),
        ("新增单元格", diff.added_cells.to_string()),
        ("公式变化", diff.formula_changes.to_string()),
        ("涉及工作表", diff.touched_sheets.join("、")),
        ("标黄单元格", diff.highlighted.len().to_string()),
        ("警告", warnings.join("；")),
    ];
    for (i, (label, value)) in rows.iter().enumerate() {
        sheet.get_cell_mut((1, (i + 1) as u32)).set_value(*label);
        sheet.get_cell_mut((2, (i + 1) as u32)).set_value(value);
    }
    // A totals-only summary tells a reviewer that something changed but not
    // what, so they would have to diff two workbooks by eye.  List the actual
    // cells the way the legacy summary did.
    let mut row = rows.len() as u32 + 2;
    for (index, header) in ["工作表", "单元格", "类型", "改动前", "改动后", "公式变化"]
        .iter()
        .enumerate()
    {
        sheet
            .get_cell_mut(((index + 1) as u32, row))
            .set_value(*header);
    }
    row += 1;
    for change in &diff.changes {
        let formula = if change.formula_before == change.formula_after {
            String::new()
        } else {
            format!("{} → {}", change.formula_before, change.formula_after)
        };
        for (index, value) in [
            change.sheet.clone(),
            change.cell.clone(),
            if change.added { "新增" } else { "修改" }.to_owned(),
            change.before.clone(),
            change.after.clone(),
            formula,
        ]
        .into_iter()
        .enumerate()
        {
            sheet
                .get_cell_mut(((index + 1) as u32, row))
                .set_value(value);
        }
        row += 1;
    }
    let listed = diff.changes.len();
    let total = diff.changed_cells + diff.added_cells;
    if total > listed {
        sheet
            .get_cell_mut((1, row))
            .set_value(format!("另有 {} 处改动未列出。", total - listed));
        row += 1;
    }
    row += 1;
    sheet.get_cell_mut((1, row)).set_value("标黄单元格清单");
    row += 1;
    for (sheet_name, cell) in diff.highlighted.iter().take(SUMMARY_DETAIL_LIMIT) {
        sheet.get_cell_mut((1, row)).set_value(sheet_name.clone());
        sheet.get_cell_mut((2, row)).set_value(cell.clone());
        row += 1;
    }
    if diff.highlighted.len() > SUMMARY_DETAIL_LIMIT {
        sheet.get_cell_mut((1, row)).set_value(format!(
            "另有 {} 个标黄单元格未列出。",
            diff.highlighted.len() - SUMMARY_DETAIL_LIMIT
        ));
        row += 1;
    }
    if !warnings.is_empty() {
        row += 1;
        sheet.get_cell_mut((1, row)).set_value("警告清单");
        row += 1;
        for warning in warnings {
            sheet.get_cell_mut((1, row)).set_value(warning.clone());
            row += 1;
        }
    }
    for (column, width) in [
        (1u32, 28.0),
        (2, 18.0),
        (3, 10.0),
        (4, 40.0),
        (5, 40.0),
        (6, 40.0),
    ] {
        sheet
            .get_column_dimension_by_number_mut(&column)
            .set_width(width);
    }
    Ok(())
}

/// `umya-spreadsheet` normally preserves template drawings. This is a final
/// package-level guard for templates whose media parts are not referenced by a
/// cell object understood by the library: media bytes are restored exactly and
/// missing drawing/relationship parts are copied back without replacing the
/// row-adjusted drawing XML emitted by umya.
fn ensure_template_drawing_parts(template: &Path, output: &Path) -> Result<(), AppError> {
    let mut template_zip =
        zip::ZipArchive::new(fs::File::open(template).map_err(io_error)?).map_err(io_error)?;
    let mut source_parts = HashMap::<String, Vec<u8>>::new();
    for index in 0..template_zip.len() {
        let mut entry = template_zip.by_index(index).map_err(io_error)?;
        let name = entry.name().replace('\\', "/");
        if name.starts_with("xl/media/")
            || name.starts_with("xl/drawings/")
            || name.starts_with("xl/worksheets/_rels/")
        {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(io_error)?;
            source_parts.insert(name, bytes);
        }
    }
    if source_parts.is_empty() {
        return Ok(());
    }
    let mut output_zip =
        zip::ZipArchive::new(fs::File::open(output).map_err(io_error)?).map_err(io_error)?;
    let mut entries = Vec::<(String, Vec<u8>, bool, zip::CompressionMethod)>::new();
    let mut names = HashSet::new();
    for index in 0..output_zip.len() {
        let mut entry = output_zip.by_index(index).map_err(io_error)?;
        let name = entry.name().replace('\\', "/");
        let is_dir = entry.is_dir();
        let method = entry.compression();
        let mut bytes = Vec::new();
        if !is_dir {
            entry.read_to_end(&mut bytes).map_err(io_error)?;
        }
        if name.starts_with("xl/media/") {
            if let Some(original) = source_parts.get(&name) {
                bytes = original.clone();
            }
        }
        names.insert(name.clone());
        entries.push((name, bytes, is_dir, method));
    }
    drop(output_zip);
    for (name, bytes) in source_parts {
        if !names.contains(&name) {
            entries.push((name, bytes, false, zip::CompressionMethod::Deflated));
        }
    }
    let rebuilt = output.with_extension("drawing-guard.partial.xlsx");
    let file = fs::File::create(&rebuilt).map_err(io_error)?;
    let mut writer = zip::ZipWriter::new(file);
    for (name, bytes, is_dir, method) in entries {
        let options = zip::write::SimpleFileOptions::default().compression_method(method);
        if is_dir {
            writer.add_directory(name, options).map_err(io_error)?;
        } else {
            writer.start_file(name, options).map_err(io_error)?;
            writer.write_all(&bytes).map_err(io_error)?;
        }
    }
    writer.finish().map_err(io_error)?;
    replace_file(&rebuilt, output)
}

const OFFICE_REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DRAWING_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const IMAGE_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

fn package_parts(path: &Path) -> Result<HashMap<String, Vec<u8>>, AppError> {
    let mut archive =
        zip::ZipArchive::new(fs::File::open(path).map_err(io_error)?).map_err(io_error)?;
    let mut parts = HashMap::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(io_error)?;
        if entry.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(io_error)?;
        parts.insert(entry.name().replace('\\', "/"), bytes);
    }
    Ok(parts)
}

fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(tag[start..end].to_owned())
}

fn xml_tags<'a>(xml: &'a str, local_name: &str) -> Vec<&'a str> {
    let mut tags = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = xml[cursor..].find('<') {
        let start = cursor + relative;
        let Some(end_relative) = xml[start..].find('>') else {
            break;
        };
        let end = start + end_relative + 1;
        let tag = &xml[start..end];
        let element = tag
            .trim_start_matches('<')
            .trim_start_matches('/')
            .split(|c: char| c == ':' || c.is_whitespace() || c == '>' || c == '/')
            .last()
            .unwrap_or("");
        if element == local_name || tag.starts_with(&format!("<{local_name} ")) {
            tags.push(tag);
        }
        cursor = end;
    }
    tags
}

fn resolve_ooxml_part(source: &str, target: &str) -> String {
    if target.starts_with('/') {
        return target.trim_start_matches('/').to_owned();
    }
    let mut segments = source
        .rsplit_once('/')
        .map(|v| v.0.split('/').collect::<Vec<_>>())
        .unwrap_or_default();
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            value => segments.push(value),
        }
    }
    segments.join("/")
}

fn rels_part(part: &str) -> String {
    let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
    if dir.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{dir}/_rels/{file}.rels")
    }
}

fn sheet_parts(parts: &HashMap<String, Vec<u8>>) -> HashMap<String, String> {
    let workbook = String::from_utf8_lossy(
        parts
            .get("xl/workbook.xml")
            .map(Vec::as_slice)
            .unwrap_or_default(),
    );
    let rels = String::from_utf8_lossy(
        parts
            .get("xl/_rels/workbook.xml.rels")
            .map(Vec::as_slice)
            .unwrap_or_default(),
    );
    let targets = xml_tags(&rels, "Relationship")
        .into_iter()
        .filter_map(|tag| Some((xml_attr(tag, "Id")?, xml_attr(tag, "Target")?)))
        .collect::<HashMap<_, _>>();
    xml_tags(&workbook, "sheet")
        .into_iter()
        .filter_map(|tag| {
            let name = xml_attr(tag, "name")?;
            let id = xml_attr(tag, "r:id")?;
            Some((
                name,
                resolve_ooxml_part("xl/workbook.xml", targets.get(&id)?),
            ))
        })
        .collect()
}

fn relationship_tags(xml: &str) -> Vec<String> {
    xml_tags(xml, "Relationship")
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn insert_before_close(xml: &str, close: &str, value: &str) -> String {
    if let Some(index) = xml.rfind(close) {
        format!("{}{}{}", &xml[..index], value, &xml[index..])
    } else {
        xml.to_owned()
    }
}

fn drawing_anchors(xml: &str) -> Vec<String> {
    let mut result = Vec::new();
    for kind in ["twoCellAnchor", "oneCellAnchor"] {
        let open = format!("<xdr:{kind}");
        let close = format!("</xdr:{kind}>");
        let mut cursor = 0;
        while let Some(relative) = xml[cursor..].find(&open) {
            let start = cursor + relative;
            let Some(end_relative) = xml[start..].find(&close) else {
                break;
            };
            let end = start + end_relative + close.len();
            result.push(xml[start..end].to_owned());
            cursor = end;
        }
    }
    result.sort_by_key(|anchor| xml.find(anchor).unwrap_or(usize::MAX));
    result
}

fn first_anchor_row(anchor: &str) -> Option<u32> {
    let from = anchor.find("<xdr:from")?;
    let row = anchor[from..].find("<xdr:row>")? + from + "<xdr:row>".len();
    let end = anchor[row..].find("</xdr:row>")? + row;
    anchor[row..end].trim().parse().ok()
}

fn referenced_relation_ids(anchor: &str) -> Vec<String> {
    ["r:embed", "r:link"]
        .into_iter()
        .flat_map(|name| {
            let mut values = Vec::new();
            let mut cursor = 0;
            let needle = format!("{name}=\"");
            while let Some(relative) = anchor[cursor..].find(&needle) {
                let start = cursor + relative + needle.len();
                let Some(end_relative) = anchor[start..].find('"') else {
                    break;
                };
                let end = start + end_relative;
                values.push(anchor[start..end].to_owned());
                cursor = end + 1;
            }
            values
        })
        .collect()
}

fn next_rel_id(xml: &str) -> String {
    let used = relationship_tags(xml)
        .iter()
        .filter_map(|tag| xml_attr(tag, "Id"))
        .collect::<HashSet<_>>();
    (1..)
        .map(|number| format!("rId{number}"))
        .find(|id| !used.contains(id))
        .unwrap()
}

fn unique_media_part(parts: &HashMap<String, Vec<u8>>, source: &str, bytes: &[u8]) -> String {
    if parts.get(source).is_none_or(|existing| existing == bytes) {
        return source.to_owned();
    }
    let (stem, extension) = source.rsplit_once('.').unwrap_or((source, "bin"));
    (1..)
        .map(|index| format!("{stem}_q1_{index}.{extension}"))
        .find(|candidate| !parts.contains_key(candidate))
        .unwrap()
}

fn ensure_q1_content_types(parts: &mut HashMap<String, Vec<u8>>, drawing_parts: &[String]) {
    let Some(bytes) = parts.get("[Content_Types].xml") else {
        return;
    };
    let mut xml = String::from_utf8_lossy(bytes).into_owned();
    for (extension, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
    ] {
        if parts
            .keys()
            .any(|name| name.to_lowercase().ends_with(&format!(".{extension}")))
            && !xml.contains(&format!("Extension=\"{extension}\""))
        {
            xml = insert_before_close(
                &xml,
                "</Types>",
                &format!("<Default Extension=\"{extension}\" ContentType=\"{mime}\"/>"),
            );
        }
    }
    for drawing in drawing_parts {
        let part_name = format!("/{drawing}");
        if !xml.contains(&format!("PartName=\"{part_name}\"")) {
            xml = insert_before_close(
                &xml,
                "</Types>",
                &format!(
                    "<Override PartName=\"{part_name}\" ContentType=\"application/vnd.openxmlformats-officedocument.drawing+xml\"/>"
                ),
            );
        }
    }
    parts.insert("[Content_Types].xml".into(), xml.into_bytes());
}

fn rewrite_package(parts: HashMap<String, Vec<u8>>, output: &Path) -> Result<(), AppError> {
    let temp = output.with_extension("q1-images.partial.xlsx");
    let mut writer = zip::ZipWriter::new(fs::File::create(&temp).map_err(io_error)?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut names = parts.keys().cloned().collect::<Vec<_>>();
    names.sort();
    for name in names {
        writer.start_file(&name, options).map_err(io_error)?;
        writer.write_all(&parts[&name]).map_err(io_error)?;
    }
    writer.finish().map_err(io_error)?;
    replace_file(&temp, output)
}

/// Copies only review/evidence pictures below the legacy Q1 Note areas.  The
/// relationship ids, media names, worksheet drawing link and content types are
/// rebuilt package-by-package so existing template pictures are not replaced.
fn copy_q1_review_images(prior: &Path, output: &Path) -> Result<usize, AppError> {
    let prior_parts = package_parts(prior)?;
    let mut output_parts = package_parts(output)?;
    let prior_sheets = sheet_parts(&prior_parts);
    let output_sheets = sheet_parts(&output_parts);
    let mut copied = 0;
    let mut touched_drawings = Vec::new();
    for (prefix, minimum_row) in [("Q1.01", 30_u32), ("Q1.05", 40_u32)] {
        let Some((_, prior_sheet)) = prior_sheets
            .iter()
            .find(|(name, _)| name.starts_with(prefix))
        else {
            continue;
        };
        let Some((_, output_sheet)) = output_sheets
            .iter()
            .find(|(name, _)| name.starts_with(prefix))
        else {
            continue;
        };
        let prior_sheet_rels_part = rels_part(prior_sheet);
        let Some(prior_sheet_rels_bytes) = prior_parts.get(&prior_sheet_rels_part) else {
            continue;
        };
        let prior_sheet_rels = String::from_utf8_lossy(prior_sheet_rels_bytes);
        let Some(prior_drawing_rel) = relationship_tags(&prior_sheet_rels)
            .into_iter()
            .find(|tag| xml_attr(tag, "Type").as_deref() == Some(DRAWING_REL_TYPE))
        else {
            continue;
        };
        let prior_drawing = resolve_ooxml_part(
            prior_sheet,
            &xml_attr(&prior_drawing_rel, "Target").unwrap_or_default(),
        );
        let prior_drawing_rels_part = rels_part(&prior_drawing);
        let Some(prior_drawing_xml) = prior_parts
            .get(&prior_drawing)
            .map(|v| String::from_utf8_lossy(v).into_owned())
        else {
            continue;
        };
        let Some(prior_drawing_rels_xml) = prior_parts
            .get(&prior_drawing_rels_part)
            .map(|v| String::from_utf8_lossy(v).into_owned())
        else {
            continue;
        };
        let selected = drawing_anchors(&prior_drawing_xml)
            .into_iter()
            .filter(|anchor| {
                anchor.contains("<xdr:pic")
                    && first_anchor_row(anchor).is_some_and(|row| row >= minimum_row)
            })
            .collect::<Vec<_>>();
        if selected.is_empty() {
            continue;
        }

        let output_sheet_rels_part = rels_part(output_sheet);
        let mut output_sheet_rels = output_parts.get(&output_sheet_rels_part)
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .unwrap_or_else(|| "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".into());
        let existing_drawing_rel = relationship_tags(&output_sheet_rels)
            .into_iter()
            .find(|tag| xml_attr(tag, "Type").as_deref() == Some(DRAWING_REL_TYPE));
        let (drawing_part, drawing_rel_id, is_new) = if let Some(tag) = existing_drawing_rel {
            (
                resolve_ooxml_part(output_sheet, &xml_attr(&tag, "Target").unwrap_or_default()),
                xml_attr(&tag, "Id").unwrap_or_default(),
                false,
            )
        } else {
            let number = (1..)
                .find(|n| !output_parts.contains_key(&format!("xl/drawings/drawing{n}.xml")))
                .unwrap();
            let part = format!("xl/drawings/drawing{number}.xml");
            let id = next_rel_id(&output_sheet_rels);
            let target = format!("../drawings/drawing{number}.xml");
            output_sheet_rels = insert_before_close(
                &output_sheet_rels,
                "</Relationships>",
                &format!(
                    "<Relationship Id=\"{id}\" Type=\"{DRAWING_REL_TYPE}\" Target=\"{target}\"/>"
                ),
            );
            (part, id, true)
        };
        let drawing_rels_part = rels_part(&drawing_part);
        let mut drawing_xml = output_parts.get(&drawing_part)
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .unwrap_or_else(|| "<?xml version=\"1.0\" encoding=\"UTF-8\"?><xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"></xdr:wsDr>".into());
        let mut drawing_rels = output_parts.get(&drawing_rels_part)
            .map(|v| String::from_utf8_lossy(v).into_owned())
            .unwrap_or_else(|| "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".into());
        let prior_relations = relationship_tags(&prior_drawing_rels_xml);
        for mut anchor in selected {
            let mut valid = true;
            for old_id in referenced_relation_ids(&anchor) {
                let Some(rel) = prior_relations
                    .iter()
                    .find(|tag| xml_attr(tag, "Id").as_deref() == Some(&old_id))
                else {
                    valid = false;
                    break;
                };
                if xml_attr(rel, "Type").as_deref() != Some(IMAGE_REL_TYPE) {
                    continue;
                }
                let source_media = resolve_ooxml_part(
                    &prior_drawing,
                    &xml_attr(rel, "Target").unwrap_or_default(),
                );
                let Some(bytes) = prior_parts.get(&source_media) else {
                    valid = false;
                    break;
                };
                let media = unique_media_part(&output_parts, &source_media, bytes);
                output_parts.insert(media.clone(), bytes.clone());
                let new_id = next_rel_id(&drawing_rels);
                let target = format!(
                    "../media/{}",
                    media.rsplit('/').next().unwrap_or("image.png")
                );
                drawing_rels = insert_before_close(
                    &drawing_rels,
                    "</Relationships>",
                    &format!(
                        "<Relationship Id=\"{new_id}\" Type=\"{IMAGE_REL_TYPE}\" Target=\"{target}\"/>"
                    ),
                );
                anchor = anchor.replace(
                    &format!("r:embed=\"{old_id}\""),
                    &format!("r:embed=\"{new_id}\""),
                );
                anchor = anchor.replace(
                    &format!("r:link=\"{old_id}\""),
                    &format!("r:link=\"{new_id}\""),
                );
            }
            if valid {
                drawing_xml = insert_before_close(&drawing_xml, "</xdr:wsDr>", &anchor);
                copied += 1;
            }
        }
        if copied == 0 {
            continue;
        }
        output_parts.insert(drawing_part.clone(), drawing_xml.into_bytes());
        output_parts.insert(drawing_rels_part, drawing_rels.into_bytes());
        output_parts.insert(output_sheet_rels_part, output_sheet_rels.into_bytes());
        if is_new {
            if let Some(sheet_bytes) = output_parts.get(output_sheet) {
                let sheet_xml = String::from_utf8_lossy(sheet_bytes);
                let drawing_node =
                    format!("<drawing xmlns:r=\"{OFFICE_REL_NS}\" r:id=\"{drawing_rel_id}\"/>");
                output_parts.insert(
                    output_sheet.clone(),
                    insert_before_close(&sheet_xml, "</worksheet>", &drawing_node).into_bytes(),
                );
            }
        }
        touched_drawings.push(drawing_part);
    }
    if copied > 0 {
        ensure_q1_content_types(&mut output_parts, &touched_drawings);
        rewrite_package(output_parts, output)?;
    }
    Ok(copied)
}

fn find_prior_file(base: &Path, code: &str, year: i32, item: &SubjectConfig) -> Option<PathBuf> {
    if base.is_file() {
        return Some(base.to_owned());
    }
    let mut candidates = workbook_files(base).ok()?;
    candidates.retain(|p| filename_matches(p, code, &item.name));
    candidates.sort_by_key(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        (!name.contains(&year.to_string()), name.len())
    });
    candidates.into_iter().next()
}
fn workbook_files(path: &Path) -> Result<Vec<PathBuf>, AppError> {
    if path.is_file() {
        return if is_xlsx(path) {
            Ok(vec![path.to_owned()])
        } else {
            Err(error(
                "ROLL_FORWARD_PRIOR_INVALID",
                "请选择 XLSX 或 XLS 上年底稿。",
                None,
            ))
        };
    }
    if !path.is_dir() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到上年底稿路径。",
            Some(path.display().to_string()),
        ));
    }
    Ok(WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_file()
                && is_xlsx(e.path())
                && !e.file_name().to_string_lossy().starts_with("~$")
        })
        .map(|e| e.into_path())
        .take(500)
        .collect())
}
fn filename_matches(path: &Path, code: &str, name: &str) -> bool {
    let raw = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_uppercase();
    let text = normalize(&raw);
    if code.eq_ignore_ascii_case("Uexp") {
        return !text.contains("VCVD")
            && !raw.contains("VC&VD")
            && (text.contains("UEXP") || text.contains(&normalize(name)));
    }
    if code.eq_ignore_ascii_case("UexpVCVD") {
        return text.contains("VCVD") || raw.contains("VC&VD") || text.contains(&normalize(name));
    }
    text.contains(&normalize(code)) || text.contains(&normalize(name))
}
fn find_row(sheet: &Worksheet, text: &str, start: u32, end: u32) -> Option<u32> {
    let (max_col, max_row) = sheet.get_highest_column_and_row();
    let wanted = normalize(text);
    (start..=end.min(max_row)).find(|row| {
        (1..=max_col).any(|col| {
            normalize(
                &sheet
                    .get_cell((col, *row))
                    .map(|c| c.get_value().to_string())
                    .unwrap_or_default(),
            )
            .contains(&wanted)
        })
    })
}
fn find_group_detail(sheet: &Worksheet, group: &str, detail: &str) -> Option<u32> {
    let (max_col, max_row) = sheet.get_highest_column_and_row();
    let g = normalize(group);
    let d = normalize(detail);
    (1..=max_row).find(|row| {
        let text = normalize(
            &(1..=max_col.min(8))
                .map(|c| {
                    sheet
                        .get_cell((c, *row))
                        .map(|v| v.get_value().to_string())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(""),
        );
        text.contains(&g) && text.contains(&d)
    })
}
fn is_end_row(sheet: &Worksheet, row: u32, max_col: u32, keywords: &[String]) -> bool {
    let text = normalize(
        &(1..=max_col.min(12))
            .map(|c| {
                sheet
                    .get_cell((c, row))
                    .map(|v| v.get_value().to_string())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(""),
    );
    text.contains("合计")
        || text.contains("总计")
        || keywords.iter().any(|v| text.contains(&normalize(v)))
}
fn copy_value(src: &Worksheet, dst: &mut Worksheet, sc: u32, sr: u32, dc: u32, dr: u32) -> usize {
    let Some(cell) = src.get_cell((sc, sr)) else {
        return 0;
    };
    let value = cell.get_value().to_string();
    if value.is_empty() {
        return 0;
    }
    if let Some(number) = cell.get_value_number() {
        dst.get_cell_mut((dc, dr)).set_value_number(number);
    } else {
        dst.get_cell_mut((dc, dr)).set_value(value);
    }
    1
}
fn output_filename(template: &str, date: NaiveDate, company: &str) -> String {
    let date8 = date.format("%Y%m%d").to_string();
    let mut name = template
        .replace("202YMMDD", &date8)
        .replace("XYZ公司", company);
    for bad in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
        name = name.replace(bad, "_");
    }
    name
}
fn parse_ratio(value: &str) -> Option<f64> {
    let v = value.trim().trim_end_matches('%').replace(',', "");
    let n = v.parse::<f64>().ok()?;
    Some(if value.contains('%') || n > 1.0 {
        n / 100.0
    } else {
        n
    })
}
fn parse_date(value: &str) -> Option<NaiveDate> {
    ["%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"]
        .iter()
        .find_map(|fmt| NaiveDate::parse_from_str(value, fmt).ok())
}
fn normalize(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace() && !"_-./\\：:；;（）()[]【】".contains(*c))
        .flat_map(char::to_uppercase)
        .collect()
}
fn string_array(params: &Value, key: &str) -> Vec<String> {
    match &params[key] {
        Value::Array(v) => v
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Value::String(v) => v
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}
fn required_path(params: &Value, key: &str, message: &str) -> Result<PathBuf, AppError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| error("INVALID_ARGUMENT", message, None))
}
fn required_string(params: &Value, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("INVALID_ARGUMENT", &format!("缺少参数：{key}"), None))
}
fn json_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_f64().map(|v| v.to_string()))
        .unwrap_or_default()
}
fn is_xlsx(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("xlsx") || v.eq_ignore_ascii_case("xls"))
}

#[cfg(test)]
mod xls_inputs_tests {
    use super::*;
    #[test]
    fn xls_inputs_roll_forward_discovery_and_template_fallback() {
        let root = std::env::temp_dir().join(format!("roll-xls-input-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("C 货币资金.XLS");
        fs::write(&input, include_bytes!("../../tests/fixtures/Excel Merger/simple-biff8.xls")).unwrap();
        assert_eq!(workbook_files(&root).unwrap(), vec![input.clone()]);
        assert_eq!(workbook_files(&input).unwrap(), vec![input.clone()]);
        assert_eq!(crate::spreadsheet_input::prefer_workbook(&input.with_extension("xlsx")), input.with_extension("xls"));
        fs::remove_dir_all(root).unwrap();
    }
}
fn replace_file(source: &Path, target: &Path) -> Result<(), AppError> {
    if target.exists() {
        fs::remove_file(target).map_err(|e| {
            error(
                "OUTPUT_REPLACE_FAILED",
                "无法替换输出文件，请确认文件未被 Excel 占用。",
                Some(e.to_string()),
            )
        })?;
    }
    fs::rename(source, target).map_err(io_error)
}
fn check_cancel(cancel: &Arc<AtomicBool>) -> Result<(), AppError> {
    check_cancel_ref(cancel.as_ref())
}
fn check_cancel_ref(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error(
            "JOB_CANCELLED",
            "任务已取消；已完成科目的结果已保留。",
            None,
        ))
    } else {
        Ok(())
    }
}
fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}
fn io_error(e: impl std::fmt::Display) -> AppError {
    error(
        "ROLL_FORWARD_IO_FAILED",
        "Roll Forward 文件处理失败。",
        Some(e.to_string()),
    )
}
fn xlsx_read_error(e: impl std::fmt::Display) -> AppError {
    error(
        "ROLL_FORWARD_READ_FAILED",
        "无法读取底稿，请确认文件为有效 XLSX 且未被占用。",
        Some(e.to_string()),
    )
}
fn xlsx_write_error(e: impl std::fmt::Display) -> AppError {
    error(
        "ROLL_FORWARD_WRITE_FAILED",
        "无法保存结转底稿，请确认输出文件未被占用。",
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_process(params: Value) -> Result<Value, AppError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        process(params, &|_, _, _, _| {}, cancel, &pause)
    }

    fn test_process_companies(params: Value) -> Result<Value, AppError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        process_companies(params, &|_, _, _, _| {}, cancel, &pause)
    }
    use umya_spreadsheet::{ConditionalFormatting, DataValidation, DataValidations};
    #[test]
    fn catalog_has_all_formal_subjects() {
        let value = catalog().unwrap();
        assert_eq!(value["subjects"].as_array().unwrap().len(), 10);
        assert_eq!(value["engine"], "rust");
    }
    #[test]
    fn output_name_replaces_date_company_and_illegal_characters() {
        let date = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        assert_eq!(
            output_filename("K1 202YMMDD XYZ公司.xlsx", date, "A:B公司"),
            "K1 20251231 A_B公司.xlsx"
        );
    }
    #[test]
    fn ratio_parser_keeps_decimal_and_percent_semantics() {
        assert_eq!(parse_ratio("25%"), Some(0.25));
        assert_eq!(parse_ratio("0.25"), Some(0.25));
    }
    #[test]
    fn generic_lead_rolls_closing_to_opening_and_preserves_target_formula() {
        let mut source = umya_spreadsheet::new_file();
        source
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 Lead");
        let src = source.get_sheet_by_name_mut("C.00 Lead").unwrap();
        src.get_cell_mut((2, 3)).set_value("期末审定数");
        src.get_cell_mut((10, 4)).set_value_number(123.45);
        let mut target = umya_spreadsheet::new_file();
        target
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 Lead");
        let dst = target.get_sheet_by_name_mut("C.00 Lead").unwrap();
        dst.get_cell_mut((2, 3)).set_value("期末审定数");
        dst.get_cell_mut((11, 5)).set_formula("SUM(A1:A2)");
        let cfg = LeadConfig {
            sheet_name: "C.00 Lead".into(),
            header_search_text: "期末审定数".into(),
            closing_col: 10,
            opening_col: 11,
            match_existing_rows_only: false,
            total_row_keywords: vec![],
            clear_current_period_cols: vec![],
        };
        let mut warnings = vec![];
        assert_eq!(
            roll_lead(&source, &mut target, &cfg, &mut warnings).unwrap(),
            1
        );
        assert_eq!(
            target
                .get_sheet_by_name("C.00 Lead")
                .unwrap()
                .get_cell((11, 4))
                .unwrap()
                .get_value_number(),
            Some(123.45)
        );
        assert!(
            !target
                .get_sheet_by_name("C.00 Lead")
                .unwrap()
                .get_cell((11, 5))
                .unwrap()
                .get_formula()
                .is_empty()
        );
    }
    #[test]
    fn generic_lead_uses_configured_columns_when_legacy_header_text_is_corrupt() {
        let mut source = umya_spreadsheet::new_file();
        source
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 Lead");
        let src = source.get_sheet_by_name_mut("C.00 Lead").unwrap();
        src.get_cell_mut((10, 10)).set_value_number(88.0);
        let mut target = umya_spreadsheet::new_file();
        target
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 Lead");
        target
            .get_sheet_by_name_mut("C.00 Lead")
            .unwrap()
            .get_cell_mut((11, 10))
            .set_value_number(0.0);
        let cfg = LeadConfig {
            sheet_name: "C.00 Lead".into(),
            header_search_text: "期末审定数".into(),
            closing_col: 10,
            opening_col: 11,
            match_existing_rows_only: false,
            total_row_keywords: vec![],
            clear_current_period_cols: vec![],
        };
        let mut warnings = vec![];
        assert_eq!(
            roll_lead(&source, &mut target, &cfg, &mut warnings).unwrap(),
            1
        );
        assert_eq!(
            target
                .get_sheet_by_name("C.00 Lead")
                .unwrap()
                .get_cell((11, 10))
                .unwrap()
                .get_value_number(),
            Some(88.0)
        );
        assert!(warnings.iter().any(|warning| warning.contains("列位")));
    }

    #[test]
    fn checked_in_legacy_c_fixture_has_a_structural_lead_header() {
        let prior_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/Audit Roll Forward/prior");
        let prior = fs::read_dir(&prior_dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "xlsx"))
            .unwrap();
        let book = umya_spreadsheet::reader::xlsx::read(&prior).unwrap();
        let sheet = book.get_sheet_by_name("C.00 Lead").unwrap();
        let cfg = LeadConfig {
            sheet_name: "C.00 Lead".into(),
            header_search_text: "期末审定数".into(),
            closing_col: 10,
            opening_col: 11,
            match_existing_rows_only: false,
            total_row_keywords: vec![],
            clear_current_period_cols: vec![],
        };
        assert_eq!(
            find_structural_lead_header(sheet, &cfg, sheet.get_highest_row()),
            Some(9)
        );
    }
    #[test]
    fn detect_export_cra_and_validation_match_rpc_contract() {
        let root = std::env::temp_dir().join(format!(
            "audit-rf-contract-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let prior = root.join("prior");
        let templates = root.join("templates");
        let output = root.join("output");
        for dir in [&prior, &templates, &output] {
            fs::create_dir_all(dir).unwrap();
        }
        for name in [
            "C 货币资金 2025.xlsx",
            "U_EXP other 2025.xlsx",
            "U_EXP VC&VD 2025.xlsx",
            "~$J1 临时.xlsx",
        ] {
            fs::write(prior.join(name), b"").unwrap();
        }
        let detected = detect_subjects(json!({"priorPath":prior})).unwrap();
        assert!(
            detected["subjects"]
                .as_array()
                .unwrap()
                .contains(&json!("C"))
        );
        assert!(
            detected["subjects"]
                .as_array()
                .unwrap()
                .contains(&json!("Uexp"))
        );
        assert!(
            detected["subjects"]
                .as_array()
                .unwrap()
                .contains(&json!("UexpVCVD"))
        );
        assert_eq!(detected["scannedWorkbookCount"], 3);
        let exported = project_export(
            json!({"outputPath":root.join("中文项目"),"project":{"project_name":"中文项目"}}),
        )
        .unwrap();
        let project = PathBuf::from(exported["outputPaths"][0].as_str().unwrap());
        assert_eq!(project.extension().unwrap(), "auditproj");
        assert!(fs::read_to_string(project).unwrap().contains("中文项目"));
        let cra=cra_parse(json!({"text":"科目名称\t认定\tCRA\t比例\n货币资金\t存在性\t低\t75%","subjectCodes":["C"]})).unwrap();
        assert_eq!(cra["writeCount"], 1);
        assert_eq!(cra["records"][0]["ratio"], 0.75);
        let cfg = config().unwrap();
        let c = cfg.subjects.get("C").unwrap();
        fs::write(templates.join(&c.template_file), b"placeholder").unwrap();
        let params = json!({"templateDir":templates,"priorDir":prior,"outputDir":output,"subjectCodes":["C"],"companyName":"公司","bsDate":"2026-12-31"});
        assert_eq!(validate(params.clone()).unwrap()["valid"], true);
        assert_eq!(
            validate(json_merge(
                params.clone(),
                json!({"llmEnhanced":true,"__llmOptions":{}})
            ))
            .unwrap()["llmReady"],
            false
        );
        assert_eq!(validate(json_merge(params,json!({"llmEnhanced":true,"__llmOptions":{"enabled":true,"api_type":"openai","api_key":"x","base_url":"https://example.invalid/v1","model":"m"}}))).unwrap()["valid"],true);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn synthetic_c_process_writes_opening_pmte_and_summary() {
        let root = std::env::temp_dir().join(format!(
            "audit-rf-process-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let templates = root.join("templates");
        let prior = root.join("prior");
        let output = root.join("output");
        for dir in [&templates, &prior, &output] {
            fs::create_dir_all(dir).unwrap();
        }
        let cfg = config().unwrap();
        let c = cfg.subjects.get("C").unwrap();
        let make = |path: &Path, value: f64| {
            let mut book = umya_spreadsheet::new_file();
            book.get_sheet_by_name_mut("Sheet1")
                .unwrap()
                .set_name("汇总");
            let summary = book.get_sheet_by_name_mut("汇总").unwrap();
            summary.get_cell_mut((1, 1)).set_value("客户名称");
            summary.get_cell_mut((1, 2)).set_value("PM");
            book.new_sheet("C.00 Lead").unwrap();
            let lead = book.get_sheet_by_name_mut("C.00 Lead").unwrap();
            lead.get_cell_mut((2, 9)).set_value("期末审定数");
            lead.get_cell_mut((2, 10)).set_value("1001");
            lead.get_cell_mut((3, 10)).set_value("银行存款");
            lead.get_cell_mut((10, 10)).set_value_number(value);
            lead.get_cell_mut((2, 11)).set_value("合计");
            umya_spreadsheet::writer::xlsx::write(&book, path).unwrap();
        };
        make(&templates.join(&c.template_file), 0.0);
        make(&prior.join("C 货币资金 2025 样例公司.xlsx"), 123456.78);
        let mut pmte = umya_spreadsheet::new_file();
        pmte.get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("PMTE");
        let sheet = pmte.get_sheet_by_name_mut("PMTE").unwrap();
        for (col, value) in ["公司", "Level", "RP", "PM", "TE", "SAD"]
            .iter()
            .enumerate()
        {
            sheet.get_cell_mut(((col + 1) as u32, 1)).set_value(*value);
        }
        for (col, value) in ["验收样例公司", "Low", "0.75", "1000000", "750000", "50000"]
            .iter()
            .enumerate()
        {
            sheet.get_cell_mut(((col + 1) as u32, 2)).set_value(*value);
        }
        let pmte_path = root.join("PMTE.xlsx");
        umya_spreadsheet::writer::xlsx::write(&pmte, &pmte_path).unwrap();
        let result=test_process(json!({"templateDir":templates,"priorDir":prior,"outputDir":output,"subjectCodes":["C"],"companyName":"验收样例公司","bsDate":"2026-12-31","pmtePath":pmte_path,"generateSummary":true})).unwrap();
        assert_eq!(result["results"][0]["success"], true);
        let path = PathBuf::from(result["outputPaths"][0].as_str().unwrap());
        assert!(
            !output
                .join(format!(
                    "{}.partial.xlsx",
                    path.file_stem().unwrap().to_string_lossy()
                ))
                .exists()
        );
        let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
        assert_eq!(
            book.get_sheet_by_name("C.00 Lead")
                .unwrap()
                .get_cell((11, 10))
                .unwrap()
                .get_value_number(),
            Some(123456.78)
        );
        assert!(book.get_sheet_by_name("Roll Forward Summary").is_ok());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn inserted_rows_preserve_formula_merge_conditional_format_and_validation() {
        let mut book = umya_spreadsheet::new_file();
        let sheet = book.get_sheet_by_name_mut("Sheet1").unwrap();
        sheet.get_cell_mut("C5").set_formula("SUM(A1:A4)");
        sheet.add_merge_cells("A5:B5");
        let mut cf = ConditionalFormatting::default();
        cf.sequence_of_references_mut().set_sqref("A5:A8");
        sheet.add_conditional_formatting_collection(cf);
        let mut validation = DataValidation::default();
        validation.sequence_of_references_mut().set_sqref("B5:B8");
        let mut validations = DataValidations::default();
        validations.add_data_validation_list(validation);
        sheet.set_data_validations(validations);
        insert_rows_preserving_metadata(&mut book, "Sheet1", 3, 2).unwrap();
        let sheet = book.get_sheet_by_name("Sheet1").unwrap();
        assert_eq!(sheet.get_merge_cells()[0].range(), "A7:B7");
        assert_eq!(
            sheet.get_conditional_formatting_collection()[0]
                .sequence_of_references()
                .get_sqref(),
            "A7:A10"
        );
        assert_eq!(
            sheet
                .get_data_validations()
                .unwrap()
                .get_data_validation_list()[0]
                .sequence_of_references()
                .get_sqref(),
            "B7:B10"
        );
        let formula = sheet.get_cell("C7").unwrap().get_formula();
        assert!(
            formula.contains("A1:A6"),
            "unexpected shifted formula: {formula}"
        );
    }
    #[test]
    fn c_j1_q1_specialists_copy_labeled_and_expand_anchored_blocks() {
        let mut c_src = umya_spreadsheet::new_file();
        c_src
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 BKD");
        c_src
            .get_sheet_by_name_mut("C.00 BKD")
            .unwrap()
            .get_cell_mut("A2")
            .set_value("开户银行");
        c_src
            .get_sheet_by_name_mut("C.00 BKD")
            .unwrap()
            .get_cell_mut("B2")
            .set_value("中国银行");
        let mut c_dst = umya_spreadsheet::new_file();
        c_dst
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("C.00 BKD");
        c_dst
            .get_sheet_by_name_mut("C.00 BKD")
            .unwrap()
            .get_cell_mut("A2")
            .set_value("开户银行");
        let mut warnings = vec![];
        assert!(roll_subject_specific("C", &c_src, &mut c_dst, false, &mut warnings).unwrap() > 0);
        assert_eq!(
            c_dst
                .get_sheet_by_name("C.00 BKD")
                .unwrap()
                .get_cell("B2")
                .unwrap()
                .get_value(),
            "中国银行"
        );
        for (code, sheet_name, anchor) in [
            ("J1", "J.01 Detail", "Notes"),
            ("Q1", "Q1.01 BKD", "借款明细"),
        ] {
            let mut source = umya_spreadsheet::new_file();
            source
                .get_sheet_by_name_mut("Sheet1")
                .unwrap()
                .set_name(sheet_name);
            let src = source.get_sheet_by_name_mut(sheet_name).unwrap();
            src.get_cell_mut("A1").set_value(anchor);
            src.get_cell_mut("A2").set_value("第一行");
            src.get_cell_mut("A3").set_value("第二行");
            src.get_cell_mut("A4").set_value("第三行");
            let mut target = umya_spreadsheet::new_file();
            target
                .get_sheet_by_name_mut("Sheet1")
                .unwrap()
                .set_name(sheet_name);
            let dst = target.get_sheet_by_name_mut(sheet_name).unwrap();
            dst.get_cell_mut("A1").set_value(anchor);
            dst.get_cell_mut("A2").set_value("旧行");
            let copied =
                roll_subject_specific(code, &source, &mut target, true, &mut warnings).unwrap();
            assert!(copied >= 4, "{code} specialist did not copy anchor block");
            assert_eq!(
                target
                    .get_sheet_by_name(sheet_name)
                    .unwrap()
                    .get_cell("A4")
                    .unwrap()
                    .get_value(),
                "第三行"
            );
        }
    }
    #[test]
    fn k1_l1_l2_n_specialists_follow_legacy_column_contracts() {
        let mut warnings = Vec::new();
        let mut ksrc = umya_spreadsheet::new_file();
        ksrc.get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("K.03.3 Policy");
        let s = ksrc.get_sheet_by_name_mut("K.03.3 Policy").unwrap();
        s.get_cell_mut("B3").set_value("房屋建筑物");
        s.get_cell_mut("C3").set_value("20年");
        s.get_cell_mut("D3").set_value("5%");
        let mut kdst = umya_spreadsheet::new_file();
        kdst.get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("K.03.3 Policy");
        let d = kdst.get_sheet_by_name_mut("K.03.3 Policy").unwrap();
        d.get_cell_mut("B12").set_value("公司折旧政策");
        d.get_cell_mut("C12").set_value("使用寿命");
        d.get_cell_mut("E13").set_formula("ROW()");
        d.get_cell_mut("B14").set_value("Notes");
        assert!(roll_subject_specific("K1", &ksrc, &mut kdst, false, &mut warnings).unwrap() >= 3);
        let d = kdst.get_sheet_by_name("K.03.3 Policy").unwrap();
        assert_eq!(d.get_cell("F13").unwrap().get_value(), "20年");
        assert_eq!(d.get_cell("G13").unwrap().get_value(), "5%");

        let mut l1src = umya_spreadsheet::new_file();
        l1src
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("L1.03 Policy");
        let s = l1src.get_sheet_by_name_mut("L1.03 Policy").unwrap();
        s.get_cell_mut("B3").set_value("软件");
        s.get_cell_mut("C3").set_value("10年");
        s.get_cell_mut("G3").set_value("无变化");
        let mut l1dst = umya_spreadsheet::new_file();
        l1dst
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("L1.03 Policy");
        l1dst
            .get_sheet_by_name_mut("L1.03 Policy")
            .unwrap()
            .get_cell_mut("B8")
            .set_value("软件");
        assert_eq!(
            roll_subject_specific("L1", &l1src, &mut l1dst, false, &mut warnings).unwrap(),
            2
        );
        assert_eq!(
            l1dst
                .get_sheet_by_name("L1.03 Policy")
                .unwrap()
                .get_cell("D8")
                .unwrap()
                .get_value(),
            "10年"
        );

        let mut nsrc = umya_spreadsheet::new_file();
        nsrc.get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("N.00 Lead sheet");
        let s = nsrc.get_sheet_by_name_mut("N.00 Lead sheet").unwrap();
        s.get_cell_mut("A1").set_value("表2 应付账款周转率分析");
        s.get_cell_mut("B2").set_value("周转次数");
        s.get_cell_mut("D2").set_value_number(6.5);
        let mut ndst = umya_spreadsheet::new_file();
        ndst.get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("N.00 Lead sheet");
        let d = ndst.get_sheet_by_name_mut("N.00 Lead sheet").unwrap();
        d.get_cell_mut("A1").set_value("表2 应付账款周转率分析");
        d.get_cell_mut("E1").set_value("PY");
        d.get_cell_mut("B2").set_value("周转次数");
        assert_eq!(
            roll_subject_specific("N", &nsrc, &mut ndst, false, &mut warnings).unwrap(),
            1
        );
        assert_eq!(
            ndst.get_sheet_by_name("N.00 Lead sheet")
                .unwrap()
                .get_cell("E2")
                .unwrap()
                .get_value_number(),
            Some(6.5)
        );

        let mut l2src = umya_spreadsheet::new_file();
        l2src
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("L2.00 Lead");
        let s = l2src.get_sheet_by_name_mut("L2.00 Lead").unwrap();
        s.get_cell_mut("C4").set_value("账户变动");
        s.get_cell_mut("C5").set_value("增加");
        s.get_cell_mut("D5").set_value("业务增长");
        let mut l2dst = umya_spreadsheet::new_file();
        l2dst
            .get_sheet_by_name_mut("Sheet1")
            .unwrap()
            .set_name("L2.00 Lead");
        assert_eq!(
            roll_subject_specific("L2", &l2src, &mut l2dst, true, &mut warnings).unwrap(),
            4
        );
        assert_eq!(
            l2dst
                .get_sheet_by_name("L2.00 Lead")
                .unwrap()
                .get_cell("D15")
                .unwrap()
                .get_value(),
            "业务增长"
        );
    }

    fn add_subject_specific_fixture(book: &mut Workbook, code: &str, source: bool) {
        match code {
            "L1" => {
                book.new_sheet("L1.03 Policy").unwrap();
                let sheet = book.get_sheet_by_name_mut("L1.03 Policy").unwrap();
                if source {
                    sheet.get_cell_mut("B3").set_value("软件");
                    sheet.get_cell_mut("C3").set_value("10年");
                    sheet.get_cell_mut("G3").set_value("无变化");
                } else {
                    sheet.get_cell_mut("B8").set_value("软件");
                }
            }
            "L2" => {
                book.new_sheet("L2.01.1 Detail").unwrap();
                let sheet = book.get_sheet_by_name_mut("L2.01.1 Detail").unwrap();
                sheet.get_cell_mut("C2").set_value("项目编码");
                sheet.get_cell_mut("D2").set_value("项目名称");
                for col in 5..=18 {
                    sheet.get_cell_mut((col, 2)).set_value(format!("字段{col}"));
                }
                if source {
                    sheet.get_cell_mut("C3").set_value("P001");
                    sheet.get_cell_mut("D3").set_value("装修费");
                    sheet.get_cell_mut("N3").set_value_number(88.0);
                    sheet.get_cell_mut("R3").set_value_number(66.0);
                } else {
                    sheet.get_cell_mut("L3").set_formula("G3+H3-I3");
                    sheet.get_cell_mut("N3").set_formula("L3+M3");
                    sheet.get_cell_mut("R3").set_formula("O3+P3-Q3");
                }
                sheet.get_cell_mut("A4").set_value("合计");
                for col in 7..=18 {
                    sheet
                        .get_cell_mut((col, 4))
                        .set_formula(format!("SUM({0}3:{0}3)", column_letters(col)));
                }
            }
            "N" => {
                book.new_sheet("N.01.01明细账").unwrap();
                let sheet = book.get_sheet_by_name_mut("N.01.01明细账").unwrap();
                sheet.get_cell_mut((13, 2)).set_value("期末审定数");
                sheet.get_cell_mut((14, 2)).set_value("上期末审定数");
                if source {
                    sheet.get_cell_mut((13, 3)).set_value_number(321.0);
                }
                sheet.get_cell_mut((1, 4)).set_value("合计");
            }
            "Uexp" | "UexpVCVD" => {
                let names = if code == "Uexp" {
                    vec!["Uexp财务费用BKD"]
                } else {
                    vec!["VC.00 销售费用BKD", "VD.00 管理费用BKD"]
                };
                for name in names {
                    book.new_sheet(name).unwrap();
                    let sheet = book.get_sheet_by_name_mut(name).unwrap();
                    for (col, label) in [
                        "科目编码",
                        "科目名称",
                        "本期账面数",
                        "账面调整",
                        "未审数",
                        "结构比",
                        "审计调整",
                        "本期账面审定数",
                        "上期末审定数",
                        "变动额",
                        "变动率",
                    ]
                    .iter()
                    .enumerate()
                    {
                        sheet.get_cell_mut(((col + 1) as u32, 2)).set_value(*label);
                    }
                    sheet.get_cell_mut("A3").set_value("6601");
                    sheet.get_cell_mut("B3").set_value("费用项目");
                    if source {
                        sheet.get_cell_mut("H3").set_value_number(99.0);
                    } else {
                        sheet.get_cell_mut("E3").set_formula("C3+D3");
                        sheet.get_cell_mut("H3").set_formula("E3+G3");
                    }
                    sheet.get_cell_mut("A4").set_value("合计");
                    for col in 3..=11 {
                        sheet
                            .get_cell_mut((col, 4))
                            .set_formula(format!("SUM({0}3:{0}3)", column_letters(col)));
                    }
                }
            }
            "Q1" => {
                book.new_sheet("Q1.01 Review").unwrap();
                book.get_sheet_by_name_mut("Q1.01 Review")
                    .unwrap()
                    .get_cell_mut("A1")
                    .set_value(if source {
                        "上期复核证据"
                    } else {
                        "本期模板"
                    });
            }
            _ => {}
        }
    }

    fn create_process_fixture(root: &Path, code: &str) -> (PathBuf, PathBuf, PathBuf) {
        let templates = root.join("templates");
        let prior = root.join("prior");
        let output = root.join("output");
        for dir in [&templates, &prior, &output] {
            fs::create_dir_all(dir).unwrap();
        }
        let cfg = config().unwrap();
        let item = cfg.subjects.get(code).unwrap();
        for source in [false, true] {
            let mut book = umya_spreadsheet::new_file();
            book.get_sheet_by_name_mut("Sheet1")
                .unwrap()
                .set_name(&item.lead_sheet.sheet_name);
            let lead = book
                .get_sheet_by_name_mut(&item.lead_sheet.sheet_name)
                .unwrap();
            lead.get_cell_mut((2, 2))
                .set_value(&item.lead_sheet.header_search_text);
            lead.get_cell_mut((2, 3)).set_value("1001");
            lead.get_cell_mut((3, 3)).set_value("测试科目");
            if source {
                lead.get_cell_mut((item.lead_sheet.closing_col, 3))
                    .set_value_number(123.0);
            }
            for row in [6, 10] {
                lead.get_cell_mut((2, row)).set_value("认定");
                lead.get_cell_mut((3, row)).set_value("CRA风险等级");
                lead.get_cell_mut((4, row)).set_value("比例");
                lead.get_cell_mut((2, row + 1)).set_value("存在性");
            }
            add_subject_specific_fixture(&mut book, code, source);
            let path = if source {
                let prior_name = match code {
                    "Uexp" => "U_EXP other 2025 测试公司.xlsx".to_owned(),
                    "UexpVCVD" => "U_EXP VC&VD 2025 测试公司.xlsx".to_owned(),
                    _ => format!("{code} {} 2025 测试公司.xlsx", item.name),
                };
                prior.join(prior_name)
            } else {
                templates.join(&item.template_file)
            };
            umya_spreadsheet::writer::xlsx::write(&book, path).unwrap();
        }
        (templates, prior, output)
    }

    #[test]
    fn migrated_subjects_and_multiple_cra_tables_execute_through_process() {
        for code in ["L1", "L2", "N", "Uexp", "UexpVCVD"] {
            let root = std::env::temp_dir().join(format!(
                "audit-rf-main-{code}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let (templates, prior, output) = create_process_fixture(&root, code);
            let result = test_process(
                json!({
                    "templateDir":templates,
                    "priorDir":prior,
                    "outputDir":output,
                    "subjectCodes":[code],
                    "companyName":"测试公司",
                    "bsDate":"2026-12-31",
                    "craRecords":[{"subject_code":code,"assertion":"存在性","cra_level":"Low","ratio":0.2,"applicable":true,"match_status":"将写入"}]
                }),
            )
            .unwrap();
            assert_eq!(result["results"][0]["success"], true, "{code}: {result}");
            let path = PathBuf::from(result["outputPaths"][0].as_str().unwrap());
            let book = umya_spreadsheet::reader::xlsx::read(path).unwrap();
            let cfg = config().unwrap();
            let item = cfg.subjects.get(code).unwrap();
            let lead = book.get_sheet_by_name(&item.lead_sheet.sheet_name).unwrap();
            assert_eq!(
                lead.get_cell((item.lead_sheet.opening_col, 3))
                    .unwrap()
                    .get_value_number(),
                Some(123.0),
                "{code} lead"
            );
            for row in [7, 11] {
                assert_eq!(lead.get_cell((3, row)).unwrap().get_value(), "Low");
                assert_eq!(
                    lead.get_cell((4, row)).unwrap().get_value_number(),
                    Some(0.2)
                );
            }
            match code {
                "L1" => assert_eq!(
                    book.get_sheet_by_name("L1.03 Policy")
                        .unwrap()
                        .get_cell("D8")
                        .unwrap()
                        .get_value(),
                    "10年"
                ),
                "L2" => assert_eq!(
                    book.get_sheet_by_name("L2.01.1 Detail")
                        .unwrap()
                        .get_cell("G3")
                        .unwrap()
                        .get_value_number(),
                    Some(88.0)
                ),
                "N" => assert_eq!(
                    book.get_sheet_by_name("N.01.01明细账")
                        .unwrap()
                        .get_cell((14, 3))
                        .unwrap()
                        .get_value_number(),
                    Some(321.0)
                ),
                "Uexp" => assert_eq!(
                    book.get_sheet_by_name("Uexp财务费用BKD")
                        .unwrap()
                        .get_cell("I3")
                        .unwrap()
                        .get_value_number(),
                    Some(99.0)
                ),
                "UexpVCVD" => assert_eq!(
                    book.get_sheet_by_name("VC.00 销售费用BKD")
                        .unwrap()
                        .get_cell("I3")
                        .unwrap()
                        .get_value_number(),
                    Some(99.0)
                ),
                _ => unreachable!(),
            }
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn process_companies_dispatches_each_company_through_main_entry() {
        let root = std::env::temp_dir().join(format!(
            "audit-rf-companies-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let (templates, prior, output) = create_process_fixture(&root, "L1");
        let result = test_process_companies(json!({
            "templateDir":templates,
            "priorDir":prior,
            "outputDir":output,
            "subjectCodes":["L1"],
            "bsDate":"2026-12-31",
            "companies":[{"companyName":"甲公司"},{"companyName":"乙公司"}]
        }))
        .unwrap();
        assert_eq!(result["companies"].as_array().unwrap().len(), 2);
        assert_eq!(result["outputPaths"].as_array().unwrap().len(), 2);
        for company in result["companies"].as_array().unwrap() {
            assert_eq!(company["results"][0]["success"], true);
        }
        let _ = fs::remove_dir_all(root);
    }

    fn inject_q1_picture(path: &Path) {
        let mut parts = package_parts(path).unwrap();
        let sheets = sheet_parts(&parts);
        let sheet = sheets
            .iter()
            .find(|(name, _)| name.starts_with("Q1.01"))
            .map(|(_, part)| part.clone())
            .unwrap();
        let sheet_rels = rels_part(&sheet);
        let relationship = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId99\" Type=\"{DRAWING_REL_TYPE}\" Target=\"../drawings/drawing99.xml\"/></Relationships>"
        );
        parts.insert(sheet_rels, relationship.into_bytes());
        let sheet_xml = String::from_utf8(parts.remove(&sheet).unwrap()).unwrap();
        parts.insert(
            sheet,
            insert_before_close(
                &sheet_xml,
                "</worksheet>",
                &format!("<drawing xmlns:r=\"{OFFICE_REL_NS}\" r:id=\"rId99\"/>"),
            )
            .into_bytes(),
        );
        let drawing = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><xdr:wsDr xmlns:xdr=\"http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{OFFICE_REL_NS}\"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>30</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>35</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id=\"99\" name=\"Prior Evidence\"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed=\"rId1\"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>"
        );
        parts.insert("xl/drawings/drawing99.xml".into(), drawing.into_bytes());
        parts.insert(
            "xl/drawings/_rels/drawing99.xml.rels".into(),
            format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"{IMAGE_REL_TYPE}\" Target=\"../media/prior-evidence.png\"/></Relationships>").into_bytes(),
        );
        parts.insert(
            "xl/media/prior-evidence.png".into(),
            b"\x89PNG\r\n\x1a\nSYNTHETIC-Q1-EVIDENCE".to_vec(),
        );
        ensure_q1_content_types(&mut parts, &["xl/drawings/drawing99.xml".into()]);
        rewrite_package(parts, path).unwrap();
    }

    #[test]
    fn q1_prior_picture_relationship_anchor_and_content_type_execute_through_process() {
        let root = std::env::temp_dir().join(format!(
            "audit-rf-q1-image-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let (templates, prior, output) = create_process_fixture(&root, "Q1");
        let prior_file = workbook_files(&prior).unwrap().remove(0);
        inject_q1_picture(&prior_file);
        let result = test_process(json!({
            "templateDir":templates,
            "priorDir":prior,
            "outputDir":output,
            "subjectCodes":["Q1"],
            "companyName":"测试公司",
            "bsDate":"2026-12-31"
        }))
        .unwrap();
        assert_eq!(result["results"][0]["success"], true, "{result}");
        let output = PathBuf::from(result["outputPaths"][0].as_str().unwrap());
        let parts = package_parts(&output).unwrap();
        assert!(parts.values().any(|bytes| {
            bytes
                .windows(b"SYNTHETIC-Q1-EVIDENCE".len())
                .any(|window| window == b"SYNTHETIC-Q1-EVIDENCE")
        }));
        let drawing = parts
            .iter()
            .find(|(name, bytes)| {
                name.starts_with("xl/drawings/drawing")
                    && String::from_utf8_lossy(bytes).contains("<xdr:row>30</xdr:row>")
            })
            .unwrap();
        let rels = parts.get(&rels_part(drawing.0)).unwrap();
        assert!(String::from_utf8_lossy(rels).contains(IMAGE_REL_TYPE));
        assert!(
            String::from_utf8_lossy(parts.get("[Content_Types].xml").unwrap())
                .contains("image/png")
        );
        let _ = fs::remove_dir_all(root);
    }

    fn json_merge(mut base: Value, patch: Value) -> Value {
        for (k, v) in patch.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }
}
