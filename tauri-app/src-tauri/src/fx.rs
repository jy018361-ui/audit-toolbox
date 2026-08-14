//! Native FX gain/loss audit engine.
//!
//! Calculations, validation and rate normalization intentionally live here:
//! neither the UI nor the LLM is trusted for arithmetic or classification.
use crate::{AppError, excel_merger::PauseCheckpoint, tabular};
use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Utc};
use directories::ProjectDirs;
use reqwest::blocking::Client;
use rust_xlsxwriter::{Format, FormatAlign, Formula, Workbook, Worksheet, XlsxError};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration as StdDuration,
};

const SAFE_URL: &str = "https://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do";
const RATE_SOURCE: &str = "国家外汇管理局人民币汇率中间价查询（数据由中国外汇交易中心公布）";

fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceSpec {
    input_path: String,
    #[serde(default)]
    sheet: String,
    #[serde(default)]
    header_row: usize,
    #[serde(default)]
    header_depth: usize,
}

#[derive(Clone, Debug)]
struct FxTable {
    path: PathBuf,
    sheet: String,
    sheets: Vec<String>,
    header_row: usize,
    header_depth: usize,
    raw_headers: Vec<Vec<String>>,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    header_candidates: Vec<(usize, f64)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RatePoint {
    requested_date: String,
    published_date: String,
    currency: String,
    cny_per_unit: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RateSnapshot {
    source: String,
    source_url: String,
    fetched_at: String,
    response_hash: String,
    start_date: String,
    end_date: String,
    rates: Vec<RatePoint>,
    #[serde(default)]
    missing: Vec<String>,
}

#[derive(Clone, Debug)]
struct RowRecord {
    source_row: usize,
    values: HashMap<String, String>,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "fx.classify_source" => classify_source(&params),
        "fx.inspect_je" => inspect(&params, "je"),
        "fx.inspect_tb" => inspect(&params, "tb"),
        "fx.validate_mapping" => validate_mapping(&params),
        "fx.account_roles" => account_roles(&params),
        "fx.entities" => entities(&params),
        "fx.rate_status" => rate_status(&params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到汇兑损益业务方法。",
            Some(method.into()),
        )),
    }
}

fn classify_source(params: &Value) -> Result<Value, AppError> {
    let source: SourceSpec = serde_json::from_value(
        params.get("source").cloned().unwrap_or_else(|| params.clone()),
    ).map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_fx_table(&source)?;
    let je = suggest_mappings(&table, "je");
    let tb = suggest_mappings(&table, "tb");
    let mapped = |candidates: &BTreeMap<String, Vec<Candidate>>, role: &str, threshold: f64| {
        candidates.get(role).and_then(|values| values.first()).is_some_and(|value| value.1 >= threshold)
    };
    let normalized = table.headers.iter().map(|value| normalize_header(value)).collect::<Vec<_>>();
    let header_has = |terms: &[&str]| normalized.iter().any(|header| {
        terms.iter().any(|term| header.contains(&normalize_header(term)))
    });
    let mut je_score = 0.0;
    let mut tb_score = 0.0;
    let mut je_reasons = Vec::new();
    let mut tb_reasons = Vec::new();
    for (role, weight, label) in [
        ("id", 3.0, "凭证号"), ("date", 3.0, "记账日期"),
        ("account", 2.0, "科目"), ("foreignAmount", 2.0, "原币发生额"),
        ("functionalAmount", 2.0, "本位币发生额"),
    ] {
        if mapped(&je, role, 0.55) { je_score += weight; je_reasons.push(label); }
    }
    if header_has(&["document type", "凭证类型", "voucher type"]) {
        je_score += 1.0; je_reasons.push("凭证类型");
    }
    for (role, weight, label) in [
        ("account", 2.0, "科目"), ("entity", 1.0, "公司"),
        ("currency", 1.0, "币种"), ("closingFunctionalAmount", 3.0, "期末/累计余额"),
        ("openingFunctionalAmount", 2.0, "期初余额"),
    ] {
        if mapped(&tb, role, 0.55) { tb_score += weight; tb_reasons.push(label); }
    }
    if header_has(&["ytd", "trial balance", "期末余额", "年末余额", "科目余额"]) {
        tb_score += 2.0; tb_reasons.push("余额表特征");
    }
    let (kind, confidence, reasons) = if je_score >= tb_score {
        ("je", if je_score == 0.0 { 0.0 } else { (je_score / 13.0_f64).min(1.0) }, je_reasons)
    } else {
        ("tb", if tb_score == 0.0 { 0.0 } else { (tb_score / 11.0_f64).min(1.0) }, tb_reasons)
    };
    let needs_llm = je_score.max(tb_score) < 5.0 || (je_score - tb_score).abs() < 2.0;
    Ok(json!({
        "kind": kind, "confidence": confidence, "needsLlm": needs_llm,
        "scores": {"je": je_score, "tb": tb_score}, "reasons": reasons,
        "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headerRow": table.header_row, "headerDepth": table.header_depth,
        "headers": table.headers, "preview": table.rows.iter().take(8).collect::<Vec<_>>()
    }))
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    checkpoint(&cancel, pause)?;
    match method {
        "fx.fetch_rates" => {
            progress("rates", 0, 2, "正在从官方来源获取人民币汇率中间价…");
            let snapshot = obtain_rates(&params)?;
            progress("rates", 2, 2, "汇率快照已锁定。");
            Ok(json!({"rateSnapshot": snapshot, "missing": snapshot.missing}))
        }
        "fx.preview" => calculate(&params, progress, &cancel, pause),
        "fx.export" => {
            let result = calculate(&params, progress, &cancel, pause)?;
            checkpoint(&cancel, pause)?;
            progress("export", 4, 5, "正在生成汇兑损益审计底稿…");
            let output = export_workbook(&params, &result)?;
            progress("export", 5, 5, "审计底稿已生成。");
            Ok(json!({
                "outputPaths": [output],
                "summary": result.get("summary"),
                "dataQuality": result.get("dataQuality"),
                "rateSnapshot": result.get("rateSnapshot")
            }))
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到汇兑损益任务方法。",
            Some(method.into()),
        )),
    }
}

fn checkpoint(cancel: &AtomicBool, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("JOB_CANCELLED", "任务已取消。", None));
    }
    pause.wait()
}

fn inspect(params: &Value, kind: &str) -> Result<Value, AppError> {
    let source: SourceSpec = serde_json::from_value(
        params
            .get("source")
            .cloned()
            .unwrap_or_else(|| params.clone()),
    )
    .map_err(|e| error("INVALID_PARAMS", "文件参数不完整。", Some(e.to_string())))?;
    let table = load_fx_table(&source)?;
    let normalized_headers = table.headers.iter().map(|header| normalize_header(header)).collect::<Vec<_>>();
    let has = |words: &[&str]| normalized_headers.iter().any(|header| words.iter().any(|word| header.contains(&normalize_header(word))));
    if kind == "je" && has(&["期初余额借方", "期末余额借方", "本期发生借方"]) && !has(&["凭证号", "凭证号数", "凭证编号"]) {
        return Err(error("SOURCE_KIND_MISMATCH", "该文件更像TB科目余额表，请拖放到TB区域。", Some(table.path.display().to_string())));
    }
    if kind == "tb" && has(&["凭证号", "凭证号数", "摘要"]) && !has(&["期初余额", "期末余额"]) {
        return Err(error("SOURCE_KIND_MISMATCH", "该文件更像JE凭证明细，请拖放到JE区域。", Some(table.path.display().to_string())));
    }
    let candidates = suggest_mappings(&table, kind);
    let mapping = candidates.iter().filter_map(|(role, values)| {
        if role == "account" {
            let columns = values.iter().filter(|candidate| candidate.1 >= 0.85)
                .map(|candidate| Value::String(candidate.0.clone())).collect::<Vec<_>>();
            (!columns.is_empty()).then(|| (role.clone(), Value::Array(columns)))
        } else {
            values.first().filter(|candidate| candidate.1 >= 0.55)
                .map(|candidate| (role.clone(), Value::String(candidate.0.clone())))
        }
    }).collect::<Map<_, _>>();
    let data_years = source_data_years(&table, kind, &mapping);
    let suggested_balance_sheet_date = if kind == "je" {
        first_col(&mapping, "date").and_then(|column| table.headers.iter().position(|header| header == &column))
            .and_then(|index| table.rows.iter().filter_map(|row| row.get(index).and_then(|value| parse_date(value))).max())
            .map(|date| date.format("%Y-%m-%d").to_string())
    } else { None };
    let close = table
        .header_candidates
        .get(1)
        .map(|x| table.header_candidates[0].1 - x.1 < 0.08)
        .unwrap_or(false);
    Ok(json!({
        "kind": kind, "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headerRow": table.header_row, "headerDepth": table.header_depth,
        "headerDetection": {
            "candidates": table.header_candidates.iter()
                .map(|x| json!({"row": x.0, "score": x.1})).collect::<Vec<_>>(),
            "needsConfirmation": close
        },
        "rawHeaders": table.raw_headers, "headers": table.headers,
        "preview": table.rows.iter().take(8).collect::<Vec<_>>(),
        "rowCount": table.rows.len(), "columnProfiles": column_profiles(&table),
        "mappingCandidates": candidate_json(&candidates), "suggestedMapping": mapping,
        "entities": distinct_for_role(&table, &candidates, "entity"),
        "accounts": distinct_for_role(&table, &candidates, "account"),
        "currencies": distinct_for_role(&table, &candidates, "currency")
        ,"dataYears": data_years, "suggestedBalanceSheetDate": suggested_balance_sheet_date
    }))
}

fn source_data_years(table: &FxTable, kind: &str, mapping: &Map<String, Value>) -> Vec<i32> {
    let mut years = BTreeSet::new();
    if kind == "je" {
        if let Some(column) = first_col(mapping, "date") {
            if let Some(index) = table.headers.iter().position(|header| header == &column) {
                for row in &table.rows {
                    if let Some(date) = row.get(index).and_then(|value| parse_date(value)) {
                        years.insert(date.year());
                    }
                }
            }
        }
    } else {
        for (index, header) in table.headers.iter().enumerate() {
            if !normalize_header(header).contains("期间") { continue; }
            for value in table.rows.iter().filter_map(|row| row.get(index)) {
                for token in value.split(|c: char| !c.is_ascii_digit()) {
                    if token.len() == 4 {
                        if let Ok(year) = token.parse::<i32>() {
                            if (1900..=2200).contains(&year) { years.insert(year); }
                        }
                    }
                }
            }
        }
    }
    years.into_iter().collect()
}

fn load_fx_table(source: &SourceSpec) -> Result<FxTable, AppError> {
    let path = PathBuf::from(&source.input_path);
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(source.input_path.clone()),
        ));
    }
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext == "parquet" {
        let value = crate::tabular::fx_load_table_value(&path, None, 1)?;
        let headers = strings(value.get("headers"));
        let rows = string_rows(value.get("rows"));
        return Ok(FxTable {
            path,
            sheet: "Parquet".into(),
            sheets: vec![],
            header_row: 1,
            header_depth: 1,
            raw_headers: vec![headers.clone()],
            headers,
            rows,
            header_candidates: vec![(1, 1.0)],
        });
    }
    let (sheet, sheets, all) = if matches!(ext.as_str(), "csv" | "txt" | "tsv") {
        ("CSV".to_string(), vec![], read_text_rows(&path)?)
    } else {
        let mut book = open_workbook_auto(&path).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作簿。",
                Some(e.to_string()),
            )
        })?;
        let sheets = book.sheet_names().to_vec();
        let (selected, all) = if !source.sheet.trim().is_empty() && sheets.contains(&source.sheet) {
            let range = book.worksheet_range(&source.sheet).map_err(|e| error(
                "WORKBOOK_READ_FAILED", "无法读取指定 Sheet。", Some(e.to_string())))?;
            (source.sheet.clone(), range.rows().map(|r| r.iter().map(data_text).collect()).collect())
        } else {
            let mut best: Option<(String, Vec<Vec<String>>, f64)> = None;
            for name in &sheets {
                let Ok(range) = book.worksheet_range(name) else { continue };
                let values = range.rows().map(|r| r.iter().map(data_text).collect()).collect::<Vec<Vec<String>>>();
                if values.iter().all(|row| row.iter().all(|value| value.trim().is_empty())) { continue; }
                let header = (0..values.len().min(30)).map(|index| header_score(&values, index)).fold(0.0_f64, f64::max);
                let populated = values.iter().filter(|row| row.iter().filter(|value| !value.trim().is_empty()).count() >= 2).count();
                let score = header + (populated.min(1000) as f64 / 1000.0) * 0.08;
                if best.as_ref().is_none_or(|current| score > current.2) { best = Some((name.clone(), values, score)); }
            }
            let (name, values, _) = best.ok_or_else(|| error("SOURCE_EMPTY", "工作簿中没有可读取的数据Sheet。", None))?;
            (name, values)
        };
        (selected, sheets, all)
    };
    if all.is_empty() {
        return Err(error("SOURCE_EMPTY", "文件中没有可读取的数据。", None));
    }
    let mut scored = (0..all.len().min(30))
        .map(|i| (i + 1, header_score(&all, i)))
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let header_row = if source.header_row > 0 {
        source.header_row
    } else {
        scored.first().map(|x| x.0).unwrap_or(1)
    };
    if header_row > all.len() {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let h = header_row - 1;
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let inferred_depth = if h + 1 < all.len()
        && combined_semantic_score(&all[h], &all[h + 1]) > semantic_hits(&all[h]) + 2
    {
        2
    } else {
        1
    };
    let depth = if source.header_depth == 0 {
        inferred_depth
    } else {
        source.header_depth.clamp(1, 2)
    };
    let raw_headers = all[h..(h + depth).min(all.len())]
        .iter()
        .map(|r| pad(r, width))
        .collect::<Vec<_>>();
    let headers = merge_headers(&raw_headers, width);
    let rows = all[(h + depth).min(all.len())..]
        .iter()
        .filter(|r| r.iter().any(|v| !v.trim().is_empty()))
        .map(|r| pad(r, width))
        .collect();
    Ok(FxTable {
        path,
        sheet,
        sheets,
        header_row,
        header_depth: depth,
        raw_headers,
        headers,
        rows,
        header_candidates: scored.into_iter().take(3).collect(),
    })
}

fn read_text_rows(path: &Path) -> Result<Vec<Vec<String>>, AppError> {
    let bytes = fs::read(path).map_err(|e| {
        error(
            "SOURCE_READ_FAILED",
            "无法读取文本文件。",
            Some(e.to_string()),
        )
    })?;
    let text = String::from_utf8(bytes.clone())
        .unwrap_or_else(|_| encoding_rs::GBK.decode(&bytes).0.into_owned());
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let delimiter = [
        (b',', first.matches(',').count()),
        (b'\t', first.matches('\t').count()),
        (b';', first.matches(';').count()),
        (b'|', first.matches('|').count()),
    ]
    .into_iter()
    .max_by_key(|x| x.1)
    .map(|x| x.0)
    .unwrap_or(b',');
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .delimiter(delimiter)
        .flexible(true)
        .from_reader(text.as_bytes());
    reader
        .records()
        .map(|r| {
            r.map(|v| v.iter().map(str::to_owned).collect())
                .map_err(|e| {
                    error(
                        "SOURCE_READ_FAILED",
                        "文本表格格式无效。",
                        Some(e.to_string()),
                    )
                })
        })
        .collect()
}

fn data_text(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(v) => v.clone(),
        Data::Float(v) => {
            if v.fract() == 0.0 {
                format!("{v:.0}")
            } else {
                v.to_string()
            }
        }
        Data::Int(v) => v.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v.as_datetime().map(|date| date.format("%Y-%m-%d %H:%M:%S").to_string()).unwrap_or_else(|| v.to_string()),
        Data::DateTimeIso(v) => v.clone(),
        Data::DurationIso(v) => v.clone(),
        Data::Error(v) => format!("{v:?}"),
    }
}

fn pad(row: &[String], width: usize) -> Vec<String> {
    (0..width)
        .map(|i| row.get(i).cloned().unwrap_or_default())
        .collect()
}
fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}
fn string_rows(v: Option<&Value>) -> Vec<Vec<String>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|r| strings(Some(r))).collect())
        .unwrap_or_default()
}

fn normalize_header(v: &str) -> String {
    v.to_lowercase().replace(
        [
            ' ', '\n', '\r', '\t', '_', '-', '—', '/', '（', '）', '(', ')',
        ],
        "",
    )
}

fn header_score(all: &[Vec<String>], i: usize) -> f64 {
    let row = &all[i];
    let n = row.len().max(1) as f64;
    let non = row.iter().filter(|v| !v.trim().is_empty()).count() as f64;
    let text = row
        .iter()
        .filter(|v| !v.trim().is_empty() && strict_number(v).is_err())
        .count() as f64;
    let unique = row
        .iter()
        .filter(|v| !v.trim().is_empty())
        .map(|v| normalize_header(v))
        .collect::<HashSet<_>>()
        .len() as f64;
    let hits = semantic_hits(row) as f64;
    let next = all
        .get(i + 1)
        .map(|r| {
            r.iter()
                .filter(|v| strict_number(v).ok().flatten().is_some() || parse_date(v).is_some())
                .count() as f64
                / r.len().max(1) as f64
        })
        .unwrap_or(0.0);
    (non / n) * 0.22
        + (text / non.max(1.0)) * 0.18
        + (unique / non.max(1.0)) * 0.12
        + (hits.min(8.0) / 8.0) * 0.36
        + next * 0.12
}

fn semantic_hits(row: &[String]) -> usize {
    let words = [
        "凭证",
        "日期",
        "科目",
        "公司",
        "主体",
        "币种",
        "原币",
        "外币",
        "本位币",
        "本币",
        "期初",
        "年初",
        "期末",
        "年末",
        "借方",
        "贷方",
        "余额",
        "金额",
        "摘要",
        "currency",
        "account",
        "entity",
        "date",
        "amount",
        "debit",
        "credit",
    ];
    row.iter()
        .map(|v| {
            let n = normalize_header(v);
            words.iter().filter(|w| n.contains(*w)).count()
        })
        .sum()
}

fn combined_semantic_score(a: &[String], b: &[String]) -> usize {
    let width = a.len().max(b.len());
    semantic_hits(
        &(0..width)
            .map(|i| {
                format!(
                    "{}{}",
                    a.get(i).map(String::as_str).unwrap_or(""),
                    b.get(i).map(String::as_str).unwrap_or("")
                )
            })
            .collect::<Vec<_>>(),
    )
}

fn merge_headers(raw: &[Vec<String>], width: usize) -> Vec<String> {
    let mut upper = raw.first().cloned().unwrap_or_default();
    let mut carry = String::new();
    for value in &mut upper {
        if value.trim().is_empty() {
            *value = carry.clone();
        } else {
            carry = value.trim().to_owned();
        }
    }
    let mut seen = HashMap::new();
    (0..width)
        .map(|i| {
            let a = upper.get(i).map(|x| x.trim()).unwrap_or("");
            let b = raw
                .get(1)
                .and_then(|r| r.get(i))
                .map(|x| x.trim())
                .unwrap_or("");
            let base = if b.is_empty() || normalize_header(a) == normalize_header(b) {
                a.to_owned()
            } else if a.is_empty() {
                b.to_owned()
            } else {
                format!("{a}-{b}")
            };
            let base = if base.is_empty() {
                format!("列{}", i + 1)
            } else {
                base.replace(['\n', '\r'], " ")
            };
            let count = seen.entry(base.clone()).or_insert(0usize);
            *count += 1;
            if *count > 1 {
                format!("{base}_{}", *count)
            } else {
                base
            }
        })
        .collect()
}

type Candidate = (String, f64, Vec<String>, Vec<String>);

fn roles(kind: &str) -> Vec<(&'static str, Vec<&'static str>, Vec<&'static str>)> {
    if kind == "je" {
        vec![
            (
                "id",
                vec!["凭证号", "凭证号数", "凭证编号", "voucher", "documentno", "documentnumber", "belnr"],
                vec!["行号"],
            ),
            (
                "voucherType",
                vec!["凭证类型", "凭证类别", "document type", "documenttype", "voucher type", "blart"],
                vec![],
            ),
            (
                "entity",
                vec![
                    "公司代码",
                    "公司名称",
                    "核算主体",
                    "记账主体",
                    "companycode",
                    "bukrs",
                ],
                vec!["客户", "供应商", "对方", "currency"],
            ),
            (
                "date",
                vec!["日期", "记账日期", "过账日期", "凭证日期", "postingdate", "budat"],
                vec!["期间"],
            ),
            (
                "account",
                vec!["科目编码", "科目名称", "总账科目", "g/l account", "glaccount", "account", "saknr"],
                vec![],
            ),
            (
                "currency",
                vec!["交易币种", "原币币种", "币种", "document currency key", "documentcurrencykey", "currency", "waers"],
                vec!["本位币", "companycodecurrency", "groupcurrency", "currencyvalue"],
            ),
            (
                "summary",
                vec!["摘要", "文本", "text", "description", "sgtxt"],
                vec![],
            ),
            (
                "auxiliary",
                vec!["辅助核算", "客户", "供应商", "往来单位"],
                vec![],
            ),
            (
                "clearingId",
                vec!["清账号", "核销号", "clearingdocument"],
                vec![],
            ),
            (
                "foreignAmount",
                vec!["原币金额", "外币金额", "原币", "document currency value", "documentcurrencyvalue", "transactionamount"],
                vec!["本位币"],
            ),
            (
                "foreignDirection",
                vec!["原币借贷方向", "外币借贷方向", "借贷方向", "方向"],
                vec!["本位币"],
            ),
            (
                "foreignDebit",
                vec!["原币借方", "外币借方"],
                vec!["贷方", "本位币"],
            ),
            (
                "foreignCredit",
                vec!["原币贷方", "外币贷方"],
                vec!["借方", "本位币"],
            ),
            (
                "functionalAmount",
                vec!["本位币金额", "本币金额", "借正贷负", "company code currency value", "companycodecurrencyvalue", "localamount"],
                vec!["原币", "外币"],
            ),
            (
                "functionalDirection",
                vec!["本位币借贷方向", "本币借贷方向"],
                vec!["原币"],
            ),
            (
                "functionalDebit",
                vec!["本位币借方", "本币借方"],
                vec!["贷方", "原币"],
            ),
            (
                "functionalCredit",
                vec!["本位币贷方", "本币贷方"],
                vec!["借方", "原币"],
            ),
        ]
    } else {
        vec![
            (
                "entity",
                vec!["公司代码", "公司名称", "核算主体", "company code", "companycode", "entity"],
                vec!["客户", "供应商"],
            ),
            ("account", vec!["科目编码", "科目名称", "g/l account", "glaccount", "gl description", "gldescription", "account"], vec![]),
            (
                "currency",
                vec!["币种", "原币币种", "currency"],
                vec!["本位币"],
            ),
            (
                "auxiliary",
                vec!["辅助核算", "客户", "供应商", "明细账户"],
                vec![],
            ),
            (
                "functionalCurrency",
                vec!["本位币", "功能货币", "functionalcurrency"],
                vec!["金额"],
            ),
            (
                "openingForeignAmount",
                vec!["期初原币余额", "年初原币余额", "期初外币余额"],
                vec!["期末", "本位币", "发生额"],
            ),
            (
                "openingFunctionalAmount",
                vec!["期初本位币余额", "年初本币余额", "期初本币余额"],
                vec!["期末", "原币", "发生额"],
            ),
            (
                "closingForeignAmount",
                vec!["期末原币余额", "年末原币余额", "期末外币余额"],
                vec!["期初", "本位币", "发生额"],
            ),
            (
                "closingFunctionalAmount",
                vec!["期末本位币余额", "年末本币余额", "期末本币余额", "ytd act (local curr)", "ytdactlocalcurr"],
                vec!["期初", "原币", "发生额"],
            ),
            (
                "openingForeignDebit",
                vec!["期初原币借方余额"],
                vec!["贷方", "期末", "本位币"],
            ),
            (
                "openingForeignCredit",
                vec!["期初原币贷方余额"],
                vec!["借方", "期末", "本位币"],
            ),
            (
                "openingFunctionalDebit",
                vec!["期初余额借方", "期初本位币借方余额"],
                vec!["贷方", "期末", "原币"],
            ),
            (
                "openingFunctionalCredit",
                vec!["期初余额贷方", "期初本位币贷方余额"],
                vec!["借方", "期末", "原币"],
            ),
            (
                "closingForeignDebit",
                vec!["期末原币借方余额"],
                vec!["贷方", "期初", "本位币"],
            ),
            (
                "closingForeignCredit",
                vec!["期末原币贷方余额"],
                vec!["借方", "期初", "本位币"],
            ),
            (
                "closingFunctionalDebit",
                vec!["期末余额借方", "期末本位币借方余额"],
                vec!["贷方", "期初", "原币"],
            ),
            (
                "closingFunctionalCredit",
                vec!["期末余额贷方", "期末本位币贷方余额"],
                vec!["借方", "期初", "原币"],
            ),
            (
                "periodFunctionalDebit",
                vec!["本期发生借方", "本期借方发生额", "本期本位币借方发生额"],
                vec!["贷方", "期初", "期末", "原币"],
            ),
            (
                "periodFunctionalCredit",
                vec!["本期发生贷方", "本期贷方发生额", "本期本位币贷方发生额"],
                vec!["借方", "期初", "期末", "原币"],
            ),
        ]
    }
}

fn suggest_mappings(table: &FxTable, kind: &str) -> BTreeMap<String, Vec<Candidate>> {
    let profiles = column_profiles(table);
    let mut out = BTreeMap::new();
    for (role, aliases, conflicts) in roles(kind) {
        let mut choices = table
            .headers
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let n = normalize_header(h);
                let exact = aliases
                    .iter()
                    .filter(|a| n == normalize_header(a))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let partial = aliases
                    .iter()
                    // A short header such as “原币” must not fan out to
                    // “原币借方/原币贷方”. Only let a real header contain a
                    // complete alias, never the other way around.
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let bad = conflicts
                    .iter()
                    .filter(|a| n.contains(&normalize_header(a)))
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>();
                let mut score: f64 = if !exact.is_empty() {
                    0.94
                } else if !partial.is_empty() {
                    0.72
                } else {
                    semantic_role_score(role, &n)
                };
                if role == "date" {
                    score += profiles[i]
                        .get("dateRatio")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        * 0.12;
                }
                if role.to_lowercase().contains("amount")
                    || role.to_lowercase().contains("debit")
                    || role.to_lowercase().contains("credit")
                {
                    score += profiles[i]
                        .get("numberRatio")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        * 0.12;
                }
                score -= bad.len() as f64 * 0.35;
                (
                    h.clone(),
                    score.clamp(0.0, 1.0),
                    if exact.is_empty() { partial } else { exact },
                    bad,
                )
            })
            .filter(|x| x.1 > 0.15)
            .collect::<Vec<_>>();
        choices.sort_by(|a, b| b.1.total_cmp(&a.1));
        choices.truncate(3);
        out.insert(role.into(), choices);
    }
    out
}

fn semantic_role_score(role: &str, header: &str) -> f64 {
    let contains_any = |words: &[&str]| words.iter().any(|word| header.contains(word));
    let period_ok = if role.starts_with("opening") {
        contains_any(&["期初", "年初", "opening", "begin"])
    } else if role.starts_with("closing") {
        contains_any(&["期末", "年末", "closing", "ending"])
    } else {
        true
    };
    let currency_ok = if role.contains("Foreign") {
        contains_any(&["原币", "外币", "foreign", "transaction"])
    } else if role.contains("Functional") {
        contains_any(&["本位币", "本币", "functional", "local"])
    } else {
        true
    };
    let direction_ok = if role.ends_with("Debit") {
        contains_any(&["借方", "debit", "dr"])
    } else if role.ends_with("Credit") {
        contains_any(&["贷方", "credit", "cr"])
    } else {
        true
    };
    let value_ok = if role.contains("Amount") || role.contains("Debit") || role.contains("Credit") {
        contains_any(&["金额", "余额", "amount", "balance", "借方", "贷方"])
    } else {
        true
    };
    if period_ok
        && currency_ok
        && direction_ok
        && value_ok
        && (role.starts_with("opening") || role.starts_with("closing"))
    {
        0.82
    } else {
        0.0
    }
}

fn candidate_json(v: &BTreeMap<String, Vec<Candidate>>) -> Value {
    json!(
        v.iter()
            .map(|(role, choices)| json!({
                "role": role,
                "candidates": choices.iter().map(|x| json!({
                    "column": x.0, "ruleScore": x.1, "sampleScore": x.1,
                    "confidence": x.1, "hitTerms": x.2, "conflictTerms": x.3
                })).collect::<Vec<_>>()
            }))
            .collect::<Vec<_>>()
    )
}

fn column_profiles(table: &FxTable) -> Vec<Value> {
    (0..table.headers.len())
        .map(|i| {
            let values = table
                .rows
                .iter()
                .take(200)
                .filter_map(|r| r.get(i))
                .filter(|v| !v.trim().is_empty())
                .collect::<Vec<_>>();
            let n = values.len().max(1) as f64;
            let numbers = values
                .iter()
                .filter(|v| strict_number(v).ok().flatten().is_some())
                .count() as f64;
            let dates = values.iter().filter(|v| parse_date(v).is_some()).count() as f64;
            json!({
                "column": table.headers[i], "nonEmpty": values.len(),
                "numberRatio": numbers / n, "dateRatio": dates / n,
                "samples": values.into_iter().take(5).collect::<Vec<_>>()
            })
        })
        .collect()
}

fn distinct_for_role(
    table: &FxTable,
    candidates: &BTreeMap<String, Vec<Candidate>>,
    role: &str,
) -> Vec<String> {
    if role == "account" {
        let columns = candidates.get(role).into_iter().flatten()
            .filter(|candidate| candidate.1 >= 0.85)
            .filter_map(|candidate| table.headers.iter().position(|header| header == &candidate.0))
            .collect::<Vec<_>>();
        if columns.is_empty() { return vec![]; }
        let mut values = table.rows.iter().map(|row| columns.iter()
            .filter_map(|index| row.get(*index)).map(|value| value.trim())
            .filter(|value| !value.is_empty()).collect::<Vec<_>>().join(" "))
            .filter(|value| !value.is_empty()).collect::<BTreeSet<_>>().into_iter().collect::<Vec<_>>();
        values.truncate(200);
        return values;
    }
    let Some(col) = candidates.get(role).and_then(|x| x.first()).map(|x| &x.0) else {
        return vec![];
    };
    if candidates.get(role).and_then(|values| values.first()).is_none_or(|candidate| candidate.1 < 0.55) { return vec![]; }
    let Some(i) = table.headers.iter().position(|h| h == col) else {
        return vec![];
    };
    let mut values = table
        .rows
        .iter()
        .filter_map(|r| r.get(i))
        .map(|x| x.trim().to_owned())
        .filter(|x| !x.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.truncate(200);
    values
}

fn mapping_obj(params: &Value, key: &str) -> Map<String, Value> {
    params
        .get(key)
        .and_then(Value::as_object)
        .cloned()
        .or_else(|| params.get("mapping").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

fn mapped_cols(mapping: &Map<String, Value>, role: &str) -> Vec<String> {
    match mapping.get(role) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    }
}
fn first_col(mapping: &Map<String, Value>, role: &str) -> Option<String> {
    mapped_cols(mapping, role).first().cloned()
}

fn fixed_entity(params: &Value) -> &str {
    params
        .get("fixedEntity")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
}

fn entity_for<'a>(row: &'a RowRecord, mapping: &Map<String, Value>, params: &'a Value) -> &'a str {
    let mapped = cell(row, mapping, "entity").trim();
    if mapped.is_empty() { fixed_entity(params) } else { mapped }
}

fn currency_from_text(value: &str) -> Option<String> {
    let normalized = value.to_uppercase();
    [
        ("USD", ["USD", "美元"].as_slice()),
        ("EUR", ["EUR", "欧元"].as_slice()),
        ("JPY", ["JPY", "日元"].as_slice()),
        ("HKD", ["HKD", "港币", "港元"].as_slice()),
        ("GBP", ["GBP", "英镑"].as_slice()),
        ("AUD", ["AUD", "澳元"].as_slice()),
        ("SGD", ["SGD", "新加坡元"].as_slice()),
        ("CAD", ["CAD", "加拿大元", "加元"].as_slice()),
    ]
    .into_iter()
    .find(|(_, aliases)| aliases.iter().any(|alias| normalized.contains(alias)))
    .map(|(code, _)| code.to_owned())
}

fn currency_for(row: &RowRecord, mapping: &Map<String, Value>, account: &str, params: &Value) -> String {
    let mapped = normalize_currency(cell(row, mapping, "currency"));
    let account_currency = params
        .get("accountCurrencies")
        .and_then(Value::as_object)
        .and_then(|values| values.get(account))
        .and_then(Value::as_str)
        .map(normalize_currency)
        .or_else(|| currency_from_text(account));
    if mapped.is_empty() || mapped == "CNY" {
        if let Some(currency) = account_currency {
            return currency;
        }
    }
    if !mapped.is_empty() {
        return mapped;
    }
    account_currency.unwrap_or_default()
}

fn validate_mapping(params: &Value) -> Result<Value, AppError> {
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let report_year = params.get("reportEnd").and_then(Value::as_str)
        .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()).map(|date| date.year());
    if matches!(mode, "realized" | "combined") && params.get("jeSource").is_none() {
        errors.push("已实现测算必须上传JE".to_string());
    }
    if matches!(mode, "unrealized" | "combined") && params.get("tbSource").is_none() {
        errors.push("未实现测算必须上传TB".to_string());
    }
    for (kind, key, source_key) in [
        ("JE", "jeMapping", "jeSource"),
        ("TB", "tbMapping", "tbSource"),
    ] {
        if let Some(src) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(src.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, key);
            let data_years = source_data_years(&table, if kind == "JE" { "je" } else { "tb" }, &mapping);
            if let Some(year) = report_year {
                if !data_years.is_empty() && !data_years.contains(&year) {
                    errors.push(format!("资产负债表日为{year}年，但{kind}数据期间为{}年", data_years.iter().map(ToString::to_string).collect::<Vec<_>>().join("、")));
                }
            }
            for col in mapping.values().flat_map(|v| match v {
                Value::String(s) => vec![s.clone()],
                Value::Array(a) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ => vec![],
            }) {
                if !table.headers.contains(&col) {
                    errors.push(format!("{kind} 映射列不存在：{col}"));
                }
            }
            let required = if kind == "JE" {
                vec!["id", "date", "account", "currency"]
            } else {
                vec!["account"]
            };
            for role in required {
                if mapped_cols(&mapping, role).is_empty() {
                    errors.push(format!("{kind} 缺少必填字段：{role}"));
                }
            }
            if kind == "JE" {
                if mapped_cols(&mapping, "entity").is_empty() && fixed_entity(params).is_empty() {
                    errors.push("JE 缺少主体列时必须指定固定主体".to_string());
                }
                for prefix in ["foreign", "functional"] {
                    if !amount_scheme_ok(&mapping, prefix) {
                        errors.push(format!("JE {prefix} 金额方案不成立"));
                    }
                }
                let id_columns = mapped_cols(&mapping, "id");
                let entity_column = first_col(&mapping, "entity");
                let date_column = first_col(&mapping, "date");
                let mut seen_rows = HashSet::new();
                for (index, row) in table.rows.iter().enumerate() {
                    let value = |column: &Option<String>| {
                        column
                            .as_ref()
                            .and_then(|c| table.headers.iter().position(|h| h == c))
                            .and_then(|i| row.get(i))
                            .map(|v| v.trim())
                            .unwrap_or("")
                    };
                    let entity = if entity_column.is_some() { value(&entity_column) } else { fixed_entity(params) };
                    let parts = std::iter::once(entity.to_owned())
                        .chain(std::iter::once(value(&date_column).to_owned()))
                        .chain(id_columns.iter().map(|c| {
                            table
                                .headers
                                .iter()
                                .position(|h| h == c)
                                .and_then(|i| row.get(i))
                                .map(|v| v.trim().to_owned())
                                .unwrap_or_default()
                        }))
                        .collect::<Vec<_>>();
                    if parts.iter().skip(1).all(|value| value.is_empty()) {
                        continue;
                    }
                    if parts.iter().any(|v| v.is_empty()) {
                        errors.push(format!(
                            "JE 第{}行匹配ID存在空值",
                            table.header_row + table.header_depth + index
                        ));
                        break;
                    }
                    let full_row = row.join("\u{1f}");
                    if !seen_rows.insert(full_row) {
                        errors.push(format!(
                            "JE 存在重复明细行（源文件第{}行）",
                            table.header_row + table.header_depth + index
                        ));
                        break;
                    }
                }
            } else {
                if mapped_cols(&mapping, "entity").is_empty() && fixed_entity(params).is_empty() {
                    errors.push("TB 缺少主体列时必须指定固定主体".to_string());
                }
                let has_je_back_calculation = params.get("jeSource").is_some();
                let required_schemes: &[&str] = if has_je_back_calculation {
                    &["closingFunctional"]
                } else {
                    &["openingForeign", "openingFunctional", "closingForeign", "closingFunctional"]
                };
                for prefix in required_schemes {
                    if !amount_scheme_ok(&mapping, prefix) {
                        errors.push(format!("TB {prefix} 余额方案不成立"));
                    }
                }
                if has_je_back_calculation && !amount_scheme_ok(&mapping, "openingForeign") {
                    warnings.push("TB不含原币余额：将对正则/JE识别出的外币货币性科目按官方汇率倒算，并在底稿中标记为倒算口径。".to_string());
                }
                if has_je_back_calculation && !amount_scheme_ok(&mapping, "openingFunctional") {
                    warnings.push("TB不含期初本位币余额：将以期末余额减去JE全年净变动倒推出期初余额。".to_string());
                }
                for (a, b) in [
                    ("openingForeignAmount", "closingForeignAmount"),
                    ("openingFunctionalAmount", "closingFunctionalAmount"),
                ] {
                    if first_col(&mapping, a).is_some()
                        && first_col(&mapping, a) == first_col(&mapping, b)
                    {
                        errors.push(format!("TB {a} 与 {b} 不能使用同一列"));
                    }
                }
                for role in [
                    "openingForeignAmount",
                    "openingForeignDebit",
                    "openingForeignCredit",
                    "openingFunctionalAmount",
                    "openingFunctionalDebit",
                    "openingFunctionalCredit",
                    "closingForeignAmount",
                    "closingForeignDebit",
                    "closingForeignCredit",
                    "closingFunctionalAmount",
                    "closingFunctionalDebit",
                    "closingFunctionalCredit",
                ] {
                    if let Some(col) = first_col(&mapping, role) {
                        let idx = table.headers.iter().position(|h| h == &col).unwrap();
                        let non_empty = table
                            .rows
                            .iter()
                            .filter_map(|r| r.get(idx))
                            .filter(|v| !v.trim().is_empty() && !is_placeholder(v))
                            .collect::<Vec<_>>();
                        let bad = non_empty
                            .iter()
                            .filter(|v| strict_number(v).is_err())
                            .count();
                        if !non_empty.is_empty()
                            && ((non_empty.len() - bad) as f64 / non_empty.len() as f64) < 0.99
                        {
                            errors.push(format!("TB 关键余额列“{col}”有效数值比例低于99%"));
                        }
                    }
                }
                if let Some(currency_col) = first_col(&mapping, "currency") {
                    let index = table
                        .headers
                        .iter()
                        .position(|h| h == &currency_col)
                        .unwrap();
                    let supported = supported_currencies();
                    for (row_index, row) in table.rows.iter().enumerate() {
                        let raw = row.get(index).map(String::as_str).unwrap_or("");
                        let code = normalize_currency(raw);
                        if code.len() != 3 || !supported.contains(code.as_str()) {
                            errors.push(format!(
                                "TB 第{}行币种无法标准化或不在官方汇率覆盖范围：{}",
                                table.header_row + table.header_depth + row_index,
                                raw
                            ));
                            break;
                        }
                    }
                }
                let key_columns = ["entity", "currency"]
                    .into_iter()
                    .filter_map(|role| first_col(&mapping, role))
                    .chain(mapped_cols(&mapping, "account"))
                    .chain(mapped_cols(&mapping, "auxiliary"))
                    .collect::<Vec<_>>();
                let mut keys = HashSet::new();
                for (row_index, row) in table.rows.iter().enumerate() {
                    let mut key = key_columns
                        .iter()
                        .map(|column| {
                            table
                                .headers
                                .iter()
                                .position(|h| h == column)
                                .and_then(|i| row.get(i))
                                .map(|v| v.trim())
                                .unwrap_or("")
                        })
                        .collect::<Vec<_>>()
                        .join("\u{1f}");
                    if key_columns.is_empty() || !mapped_cols(&mapping, "entity").is_empty() {
                        // already includes all mapped key dimensions
                    } else {
                        key = format!("{}\u{1f}{key}", fixed_entity(params));
                    }
                    if !keys.insert(key) {
                        errors.push(format!(
                            "TB 第{}行存在无法解释的重复余额键",
                            table.header_row + table.header_depth + row_index
                        ));
                        break;
                    }
                }
            }
        }
    }
    if mode == "unrealized" && params.get("jeSource").is_none() {
        warnings.push("未上传JE：仅执行年初、年末两时点检查；仅年末差异作为建议调整。".to_string());
    }
    Ok(json!({"valid": errors.is_empty(), "errors": errors, "warnings": warnings}))
}

fn amount_scheme_ok(mapping: &Map<String, Value>, prefix: &str) -> bool {
    let amount = first_col(mapping, &format!("{prefix}Amount")).is_some();
    let direction = first_col(mapping, &format!("{prefix}Direction")).is_some();
    let debit = first_col(mapping, &format!("{prefix}Debit")).is_some();
    let credit = first_col(mapping, &format!("{prefix}Credit")).is_some();
    (amount && !debit && !credit)
        || (debit && credit && !amount)
        || (amount && direction && !debit && !credit)
}

fn strict_number(raw: &str) -> Result<Option<f64>, String> {
    let mut s = raw.trim().replace([',', '，', ' ', '\u{a0}'], "");
    if s.is_empty() || is_placeholder(&s) {
        return Ok(None);
    }
    let mut sign = 1.0;
    if s.starts_with('(') && s.ends_with(')') {
        sign = -1.0;
        s = s[1..s.len() - 1].to_owned();
    }
    if s.ends_with('-') {
        sign *= -1.0;
        s.pop();
    }
    if s.to_ascii_uppercase().ends_with("CR") {
        sign *= -1.0;
        s.truncate(s.len() - 2);
    } else if s.to_ascii_uppercase().ends_with("DR") {
        s.truncate(s.len() - 2);
    }
    if s.ends_with('贷') {
        sign *= -1.0;
        s.pop();
    } else if s.ends_with('借') {
        s.pop();
    }
    s.parse::<f64>()
        .map(|v| Some(sign * v))
        .map_err(|_| format!("无法解析数值：{raw}"))
}

fn is_placeholder(s: &str) -> bool {
    matches!(s.trim(), "-" | "—" | "–" | "N/A" | "n/a" | "NA" | "无")
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let text = s.trim();
    for format in ["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d", "%d/%m/%Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(text, format) {
            return Some(date);
        }
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"] {
        if let Ok(value) = NaiveDateTime::parse_from_str(text, format) { return Some(value.date()); }
    }
    None
}

fn records(table: &FxTable) -> Vec<RowRecord> {
    table
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| RowRecord {
            source_row: table.header_row + table.header_depth + i,
            values: table
                .headers
                .iter()
                .cloned()
                .zip(row.iter().cloned())
                .collect(),
        })
        .collect()
}

fn cell<'a>(row: &'a RowRecord, mapping: &Map<String, Value>, role: &str) -> &'a str {
    first_col(mapping, role)
        .and_then(|c| row.values.get(&c))
        .map(String::as_str)
        .unwrap_or("")
}

fn signed_amount(
    row: &RowRecord,
    mapping: &Map<String, Value>,
    prefix: &str,
) -> Result<f64, String> {
    if let (Some(debit), Some(credit)) = (
        first_col(mapping, &format!("{prefix}Debit")),
        first_col(mapping, &format!("{prefix}Credit")),
    ) {
        return Ok(
            strict_number(row.values.get(&debit).map(String::as_str).unwrap_or(""))?.unwrap_or(0.0)
                - strict_number(row.values.get(&credit).map(String::as_str).unwrap_or(""))?
                    .unwrap_or(0.0),
        );
    }
    let value = strict_number(cell(row, mapping, &format!("{prefix}Amount")))?.unwrap_or(0.0);
    let direction = cell(row, mapping, &format!("{prefix}Direction")).to_ascii_uppercase();
    Ok(if direction.contains("CR") || direction.contains('贷') {
        -value.abs()
    } else {
        value
    })
}

fn voucher_id(row: &RowRecord, mapping: &Map<String, Value>, params: &Value) -> String {
    let mut parts = vec![
        entity_for(row, mapping, params).to_owned(),
        parse_date(cell(row, mapping, "date"))
            .map(|d| d.format("%Y-%m-%d").to_string())
            .unwrap_or_else(|| cell(row, mapping, "date").trim().to_owned()),
    ];
    parts.extend(mapped_cols(mapping, "id").iter().map(|c| {
        row.values
            .get(c)
            .map(|v| v.trim().to_owned())
            .unwrap_or_default()
    }));
    parts.join("\u{1f}")
}
fn display_voucher_id(id: &str) -> String {
    id.split('\u{1f}').collect::<Vec<_>>().join("-")
}

fn is_je_business_row(row: &RowRecord, mapping: &Map<String, Value>) -> bool {
    !cell(row, mapping, "date").trim().is_empty()
        || mapped_cols(mapping, "id").iter().any(|column| {
            row.values.get(column).is_some_and(|value| !value.trim().is_empty())
        })
}

fn entities(params: &Value) -> Result<Value, AppError> {
    let mut output = BTreeSet::new();
    for (source_key, map_key) in [("jeSource", "jeMapping"), ("tbSource", "tbMapping")] {
        if let Some(source) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(source.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, map_key);
            for row in records(&table) {
                let value = cell(&row, &mapping, "entity").trim();
                if !value.is_empty() {
                    output.insert(value.to_owned());
                }
            }
        }
    }
    Ok(json!({"entities": output}))
}

fn account_roles(params: &Value) -> Result<Value, AppError> {
    let mut output = BTreeMap::new();
    for (source_key, map_key) in [("jeSource", "jeMapping"), ("tbSource", "tbMapping")] {
        if let Some(source) = params.get(source_key) {
            let spec: SourceSpec = serde_json::from_value(source.clone())
                .map_err(|e| error("INVALID_PARAMS", "来源参数无效。", Some(e.to_string())))?;
            let table = load_fx_table(&spec)?;
            let mapping = mapping_obj(params, map_key);
            for row in records(&table) {
                let name = account_name(&row, &mapping);
                if !name.is_empty() {
                    output
                        .entry(name.clone())
                        .or_insert_with(|| suggest_account_role(&name));
                }
            }
        }
    }
    Ok(json!({
        "accounts": output.into_iter().map(|(account, suggested_role)|
            json!({"account": account, "suggestedRole": suggested_role})
        ).collect::<Vec<_>>()
    }))
}

fn account_name(row: &RowRecord, mapping: &Map<String, Value>) -> String {
    mapped_cols(mapping, "account")
        .iter()
        .filter_map(|c| row.values.get(c))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn account_match_key(account: &str) -> &str {
    account.split_whitespace().next().filter(|value| !value.is_empty()).unwrap_or(account.trim())
}

fn suggest_account_role(value: &str) -> String {
    let normalized = value.to_lowercase();
    if ["银行存款", "银行", "库存现金", "cash", "bank", "boc", "boa", "hsbc", "cmb"]
        .iter()
        .any(|x| normalized.contains(x))
    {
        "cash"
    } else if ["应收", "receivable", "accts rec", "acct rec", "a/r", "interco cust"]
        .iter()
        .any(|x| normalized.contains(x))
    {
        "monetary_asset"
    } else if ["应付", "payable", "accts pay", "acct pay", "a/p", "借款", "loan", "interco vend"]
        .iter()
        .any(|x| normalized.contains(x))
    {
        "monetary_liability"
    } else if [
        "汇兑损益", "汇率损益", "exchange gain", "exchange loss", "fx gain", "fx loss",
        "cur remeasur g/l", "currency remeasur", "fx transl cogs", "foreign exch", "forex g/l",
    ]
        .iter()
        .any(|x| normalized.contains(x))
    {
        "fx_gain_loss"
    } else if ["预付", "预收"].iter().any(|x| normalized.contains(x)) {
        "review"
    } else {
        "unassigned"
    }
    .into()
}

fn role_for(account: &str, params: &Value) -> String {
    let roles = params.get("accountRoles").and_then(Value::as_object);
    if let Some(role) = roles.and_then(|m| m.get(account)).and_then(Value::as_str) {
        if role != "unassigned" { return role.to_owned(); }
    }
    let key = account_match_key(account);
    if let Some(role) = roles.and_then(|values| values.iter().find_map(|(candidate, role)| {
        (account_match_key(candidate) == key)
            .then(|| role.as_str())
            .flatten()
            .filter(|value| *value != "unassigned")
    })) { return role.to_owned(); }
    suggest_account_role(account)
}

fn rate_status(params: &Value) -> Result<Value, AppError> {
    let start = params
        .get("reportStart")
        .and_then(Value::as_str)
        .unwrap_or("");
    let end = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .unwrap_or("");
    let path = rate_cache_dir()?.join(format!("{}.json", rate_cache_key(start, end)));
    Ok(json!({
        "cached": path.is_file(), "path": path,
        "source": RATE_SOURCE, "sourceUrl": SAFE_URL
    }))
}

fn rate_cache_dir() -> Result<PathBuf, AppError> {
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .ok_or_else(|| error("DATA_DIR_UNAVAILABLE", "无法确定汇率缓存目录。", None))?;
    let path = dirs.cache_dir().join("fx_rates");
    fs::create_dir_all(&path).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法创建汇率缓存目录。",
            Some(e.to_string()),
        )
    })?;
    Ok(path)
}
fn rate_cache_key(start: &str, end: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(format!("safe-v1|{start}|{end}"));
    hex::encode(hash.finalize())[..20].to_owned()
}

fn obtain_rates(params: &Value) -> Result<RateSnapshot, AppError> {
    if let Some(value) = params.get("rateSnapshot") {
        if !value.is_null() {
            return serde_json::from_value(value.clone()).map_err(|e| {
                error(
                    "RATE_SNAPSHOT_INVALID",
                    "汇率快照格式无效。",
                    Some(e.to_string()),
                )
            });
        }
    }
    let start = params
        .get("reportStart")
        .and_then(Value::as_str)
        .ok_or_else(|| error("REPORT_DATE_REQUIRED", "请填写报告期开始日。", None))?;
    let end = params
        .get("reportEnd")
        .and_then(Value::as_str)
        .ok_or_else(|| error("REPORT_DATE_REQUIRED", "请填写报告期结束日。", None))?;
    let path = rate_cache_dir()?.join(format!("{}.json", rate_cache_key(start, end)));
    if path.is_file() {
        return serde_json::from_slice(&fs::read(&path).map_err(|e| {
            error(
                "CACHE_READ_FAILED",
                "无法读取汇率缓存。",
                Some(e.to_string()),
            )
        })?)
        .map_err(|e| error("CACHE_READ_FAILED", "汇率缓存已损坏。", Some(e.to_string())));
    }
    let snapshot = fetch_safe_rates(start, end)?;
    let bytes = serde_json::to_vec_pretty(&snapshot).unwrap_or_default();
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法写入汇率缓存。",
            Some(e.to_string()),
        )
    })?;
    fs::rename(temp, path).map_err(|e| {
        error(
            "CACHE_WRITE_FAILED",
            "无法锁定汇率缓存。",
            Some(e.to_string()),
        )
    })?;
    Ok(snapshot)
}

fn fetch_safe_rates(start: &str, end: &str) -> Result<RateSnapshot, AppError> {
    let start_date = parse_date(start)
        .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期开始日格式无效。", None))?;
    let end_date = parse_date(end)
        .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期结束日格式无效。", None))?;
    if end_date > Utc::now().date_naive() {
        return Err(error(
            "FUTURE_RATE_DENIED",
            "报告期结束日晚于当前日期，系统不允许使用未来汇率。",
            None,
        ));
    }
    if end_date < start_date || end_date - start_date > Duration::days(366) {
        return Err(error(
            "REPORT_RANGE_INVALID",
            "汇率查询区间必须在366天内。",
            None,
        ));
    }
    // Include a 14-day lookback so holidays at the period start can safely use
    // the nearest prior publication without ever using a future rate.
    let client = Client::builder()
        .timeout(StdDuration::from_secs(45))
        .build()
        .map_err(|e| {
            error(
                "RATE_FETCH_FAILED",
                "无法创建汇率请求。",
                Some(e.to_string()),
            )
        })?;
    let fetch = |from: NaiveDate, to: NaiveDate| -> Result<Vec<u8>, AppError> {
        client
            .post(SAFE_URL)
            .form(&[
                ("startDate", from.format("%Y-%m-%d").to_string()),
                ("endDate", to.format("%Y-%m-%d").to_string()),
                ("queryYN", "true".into()),
            ])
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| {
                error(
                    "RATE_FETCH_FAILED",
                    "无法从官方来源获取汇率。",
                    Some(e.to_string()),
                )
            })?
            .bytes()
            .map(|v| v.to_vec())
            .map_err(|e| {
                error(
                    "RATE_FETCH_FAILED",
                    "无法读取官方汇率响应。",
                    Some(e.to_string()),
                )
            })
    };
    let lookback = fetch(start_date - Duration::days(14), start_date)?;
    let period = fetch(start_date, end_date)?;
    let mut digest = Sha256::new();
    digest.update(&lookback);
    digest.update(&period);
    let response_hash = hex::encode(digest.finalize());
    let mut raw = parse_safe_html(&String::from_utf8_lossy(&lookback));
    raw.extend(parse_safe_html(&String::from_utf8_lossy(&period)));
    raw.sort_by_key(|x| x.0);
    raw.dedup_by_key(|x| x.0);
    if raw.is_empty() {
        return Err(error(
            "RATE_PARSE_FAILED",
            "官方汇率响应中没有可识别的数据。",
            None,
        ));
    }
    let currencies = [
        "USD", "EUR", "JPY", "HKD", "GBP", "AUD", "NZD", "SGD", "CHF", "CAD", "MOP", "MYR", "RUB",
        "ZAR", "KRW", "AED", "SAR", "HUF", "PLN", "DKK", "SEK", "NOK", "TRY", "MXN", "THB",
    ];
    let mut rates = Vec::new();
    for requested in date_points(start_date, end_date) {
        for (i, currency) in currencies.iter().enumerate() {
            if let Some((published, values)) = raw
                .iter()
                .filter(|(date, _)| *date <= requested)
                .max_by_key(|x| x.0)
            {
                if let Some(Some(value)) = values.get(i) {
                    // First ten SAFE columns are CNY per 100 foreign units.
                    // Remaining columns are foreign units per 100 CNY.
                    let cny_per_unit = if i < 10 {
                        *value / 100.0
                    } else {
                        100.0 / *value
                    };
                    rates.push(RatePoint {
                        requested_date: requested.format("%Y-%m-%d").to_string(),
                        published_date: published.format("%Y-%m-%d").to_string(),
                        currency: (*currency).into(),
                        cny_per_unit,
                    });
                }
            }
        }
        rates.push(RatePoint {
            requested_date: requested.format("%Y-%m-%d").to_string(),
            published_date: requested.format("%Y-%m-%d").to_string(),
            currency: "CNY".into(),
            cny_per_unit: 1.0,
        });
    }
    Ok(RateSnapshot {
        source: RATE_SOURCE.into(),
        source_url: SAFE_URL.into(),
        fetched_at: Utc::now().to_rfc3339(),
        response_hash,
        start_date: start.into(),
        end_date: end.into(),
        rates,
        missing: vec![],
    })
}

fn date_points(start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    // A full daily normalized snapshot makes the run reproducible for both
    // voucher dates and month ends. Non-publication days still resolve only to
    // a prior publication in fetch_safe_rates().
    let mut output = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        output.push(cursor);
        cursor += Duration::days(1);
    }
    output
}

fn parse_safe_html(html: &str) -> Vec<(NaiveDate, Vec<Option<f64>>)> {
    html.split("<tr class=\"first\"")
        .skip(1)
        .filter_map(|chunk| {
            let mut cells = Vec::new();
            let mut rest = chunk;
            while let Some(index) = rest.find("<td") {
                rest = &rest[index + 3..];
                let end = rest.find('>')?;
                rest = &rest[end + 1..];
                let close = rest.find("</td>")?;
                cells.push(strip_tags(&rest[..close]));
                rest = &rest[close + 5..];
            }
            let date = parse_date(cells.first()?.trim())?;
            let values = cells
                .iter()
                .skip(1)
                .take(25)
                .map(|v| strict_number(v).ok().flatten())
                .collect::<Vec<_>>();
            Some((date, values))
        })
        .collect()
}

fn strip_tags(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in value.chars() {
        if character == '<' {
            in_tag = true;
        } else if character == '>' {
            in_tag = false;
        } else if !in_tag {
            output.push(character);
        }
    }
    output.replace("&nbsp;", "").trim().to_owned()
}

fn normalize_currency(value: &str) -> String {
    let normalized = value.trim().to_uppercase();
    match normalized.as_str() {
        "人民币" | "RMB" => "CNY",
        "美元" => "USD",
        "欧元" => "EUR",
        "日元" => "JPY",
        "港币" | "港元" => "HKD",
        "英镑" => "GBP",
        "澳元" => "AUD",
        "新加坡元" => "SGD",
        "加拿大元" | "加元" => "CAD",
        _ => normalized.as_str(),
    }
    .to_owned()
}

fn supported_currencies() -> HashSet<&'static str> {
    [
        "CNY", "USD", "EUR", "JPY", "HKD", "GBP", "AUD", "NZD", "SGD", "CHF", "CAD", "MOP", "MYR",
        "RUB", "ZAR", "KRW", "AED", "SAR", "HUF", "PLN", "DKK", "SEK", "NOK", "TRY", "MXN", "THB",
    ]
    .into_iter()
    .collect()
}

fn functional_currency(entity: &str, params: &Value) -> String {
    params
        .get("entityCurrencies")
        .and_then(Value::as_object)
        .and_then(|m| m.get(entity))
        .and_then(Value::as_str)
        .unwrap_or("CNY")
        .to_owned()
}

fn rate(
    snapshot: &RateSnapshot,
    date: NaiveDate,
    currency: &str,
    functional: &str,
) -> Option<(f64, String)> {
    let requested = date.format("%Y-%m-%d").to_string();
    let find = |code: &str| {
        snapshot
            .rates
            .iter()
            .find(|r| r.requested_date == requested && r.currency == code)
    };
    let foreign = find(&normalize_currency(currency))?;
    let functional_rate = find(&normalize_currency(functional))?;
    Some((
        foreign.cny_per_unit / functional_rate.cny_per_unit,
        foreign.published_date.clone(),
    ))
}

fn calculate(
    params: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: &AtomicBool,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let validation = validate_mapping(params)?;
    if !validation
        .get("valid")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(error(
            "MAPPING_INVALID",
            "字段映射或数据质量校验未通过。",
            Some(validation.to_string()),
        ));
    }
    checkpoint(cancel, pause)?;
    progress("rates", 1, 4, "正在锁定官方汇率快照…");
    let snapshot = obtain_rates(params)?;
    checkpoint(cancel, pause)?;
    progress("calculate", 2, 4, "正在执行汇兑损益测算与分类…");
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let mut realized = Vec::new();
    let mut unrealized = Vec::new();
    let mut classification = Vec::new();
    let mut quality = Vec::new();
    let je_detail = if let Some(source) = params.get("jeSource") {
        let spec: SourceSpec = serde_json::from_value(source.clone())
            .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        records(&table)
            .into_iter()
            .map(|row| {
                let mut value = row
                    .values
                    .into_iter()
                    .map(|(key, value)| (key, Value::String(value)))
                    .collect::<Map<_, _>>();
                value.insert("sourceRow".into(), json!(row.source_row));
                Value::Object(value)
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if matches!(mode, "realized" | "combined") {
        let (calculation, classes, issues) = calculate_realized(params, &snapshot)?;
        realized = calculation;
        classification = classes;
        quality.extend(issues);
    }
    if matches!(mode, "unrealized" | "combined") {
        let (calculation, issues) = calculate_unrealized(params, &snapshot)?;
        unrealized = calculation;
        quality.extend(issues);
    }
    let realized_total = realized
        .iter()
        .filter_map(|v| v.get("auditGainLoss").and_then(Value::as_f64))
        .sum::<f64>();
    let unrealized_total = unrealized
        .iter()
        .filter_map(|v| {
            v.get("suggestedAdjustment")
                .or_else(|| v.get("unrealizedGainLoss"))
                .and_then(Value::as_f64)
        })
        .sum::<f64>();
    let automatic_total = realized_total + unrealized_total;
    let bridge = build_review_bridge(params, &realized, &unrealized)?;
    let pending_review = bridge.get("pendingReviews").and_then(Value::as_array).cloned().unwrap_or_default();
    let pending_review_amount = bridge.get("pendingReviewAmount").and_then(Value::as_f64).unwrap_or(0.0);
    let covered_book = bridge.get("coveredBookFxGainLoss").and_then(Value::as_f64).unwrap_or(0.0);
    let provisional_total = automatic_total + pending_review_amount;
    for item in &pending_review {
        classification.push(json!({
            "voucherId": item.get("voucherId"), "classification":"待复核",
            "eventType": item.get("voucherType"), "realizedScore":0.0, "unrealizedScore":0.0,
            "matchedRules":["未执行复杂多行分摊，按账面汇兑损益暂列待复核"],
            "counterEvidence":[item.get("reviewReason")], "confidence":"待复核", "ruleConflict":false
        }));
    }
    let mut reconciliation = reconcile_fx_gain_loss(params)?;
    if let Some(object) = reconciliation.as_object_mut() {
        object.insert("coveredBookFxGainLoss".into(), json!(covered_book));
        object.insert("pendingReviewAmount".into(), json!(pending_review_amount));
        object.insert("pendingReviewCount".into(), bridge.get("pendingReviewCount").cloned().unwrap_or(json!(0)));
        object.insert("coverageDifference".into(), bridge.get("coverageDifference").cloned().unwrap_or(json!(0.0)));
    }
    let tb_fx = reconciliation.get("tbFxGainLoss").and_then(Value::as_f64);
    let difference = tb_fx.map(|value| provisional_total - value);
    let difference_ratio = tb_fx.and_then(|value| {
        if value.abs() < 0.01 { None } else { Some((provisional_total - value).abs() / value.abs()) }
    });
    let no_calculation_rows = realized.is_empty() && unrealized.is_empty();
    if no_calculation_rows && !classification.is_empty() {
        quality.push(json!({
            "source":"系统诊断", "type":"外币数据未形成测算结果", "severity":"待复核",
            "detail": format!("已读取{}个凭证事件，但没有事件进入已实现或未实现测算；请检查科目角色、凭证类型、币种及金额映射。", classification.len())
        }));
    }
    progress("reconcile", 3, 4, "正在汇总并执行TB勾稽…");
    Ok(json!({
        "mode": mode,
        "summary": {
            "realizedGainLoss": realized_total,
            "unrealizedAdjustment": unrealized_total,
            "automaticMeasuredFxGainLoss": automatic_total,
            "pendingReviewAmount": pending_review_amount,
            "pendingReviewCount": pending_review.len(),
            "coveredBookFxGainLoss": covered_book,
            "measurementDifference": automatic_total - covered_book,
            "auditFxGainLoss": provisional_total,
            "tbFxGainLoss": tb_fx,
            "difference": difference,
            "differenceRatio": difference_ratio,
            "reconciliationPassed": difference_ratio.map(|value| value < 0.05),
            "realizedEvents": realized.len(),
            "unrealizedRows": unrealized.len(),
            "lowConfidenceEvents": classification.iter().filter(|v|
                v.get("confidence").and_then(Value::as_str) == Some("低")
            ).count(),
            "needsZeroResultReview": no_calculation_rows && !classification.is_empty()
        },
        "realized": realized, "classification": classification, "jeDetail": je_detail,
        "unrealized": unrealized, "pendingReview": pending_review,
        "dataQuality": quality, "reconciliation": reconciliation,
        "validation": validation, "rateSnapshot": snapshot
    }))
}

fn reconcile_fx_gain_loss(params: &Value) -> Result<Value, AppError> {
    let mut tb_rows = Vec::new();
    let mut tb_total = 0.0;
    if let Some(source) = params.get("tbSource") {
        let spec: SourceSpec = serde_json::from_value(source.clone())
            .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        let mapping = mapping_obj(params, "tbMapping");
        let mut candidates = records(&table).into_iter().filter_map(|row| {
            let account = account_name(&row, &mapping);
            if role_for(&account, params) != "fx_gain_loss" { return None; }
            let debit = first_col(&mapping, "periodFunctionalDebit")
                .and_then(|column| row.values.get(&column))
                .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                .transpose().ok().flatten();
            let credit = first_col(&mapping, "periodFunctionalCredit")
                .and_then(|column| row.values.get(&column))
                .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                .transpose().ok().flatten();
            let closing = first_col(&mapping, "closingFunctionalAmount")
                .and_then(|column| row.values.get(&column))
                .map(|value| strict_number(value).map(|v| v.unwrap_or(0.0)))
                .transpose().ok().flatten();
            // 发生额借、贷方案只有在两列同时映射时才成立。单边的LLM建议
            // 不能覆盖更可靠的累计/期末净额列，否则SAP的MTD列会误替代YTD。
            let split_period_scheme = first_col(&mapping, "periodFunctionalDebit").is_some()
                && first_col(&mapping, "periodFunctionalCredit").is_some();
            let amount = match (split_period_scheme, debit, credit) {
                (true, Some(d), Some(c)) if (d - c).abs() < 0.01 && d.signum() == c.signum() => d,
                (true, Some(d), Some(c)) => d - c,
                _ => closing.unwrap_or(0.0),
            };
            Some((account, row.source_row, amount))
        }).collect::<Vec<_>>();
        // Prefer detail accounts so a parent financial-expense row does not duplicate its child.
        candidates.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
        for (account, source_row, amount) in candidates {
            if tb_rows.iter().any(|value: &Value| {
                let selected = value.get("account").and_then(Value::as_str).unwrap_or("");
                selected != account && selected.starts_with(&account)
            }) { continue; }
            tb_total += amount;
            tb_rows.push(json!({"account":account, "sourceRow":source_row, "amount":amount,
                "scheme": if first_col(&mapping, "periodFunctionalDebit").is_some() && first_col(&mapping, "periodFunctionalCredit").is_some() {
                    "ERP借贷同额带符号时取单列，否则借方减贷方"
                } else { "TB未提供发生额时，取累计本位币金额" }}));
        }
    }
    let mut je_total = 0.0;
    let mut excluded = 0usize;
    if let Some(source) = params.get("jeSource") {
        let spec: SourceSpec = serde_json::from_value(source.clone())
            .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
        let table = load_fx_table(&spec)?;
        let mapping = mapping_obj(params, "jeMapping");
        let id_indexes = std::iter::once(first_col(&mapping, "date")).flatten()
            .chain(mapped_cols(&mapping, "id"))
            .filter_map(|name| table.headers.iter().position(|header| header == &name)).collect::<Vec<_>>();
        let account_indexes = mapped_cols(&mapping, "account").iter()
            .filter_map(|name| table.headers.iter().position(|header| header == name)).collect::<Vec<_>>();
        let loss_keys = tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
        for (row, raw) in records(&table).into_iter().zip(table.rows.iter()) {
            if role_for(&account_name(&row, &mapping), params) != "fx_gain_loss" { continue; }
            if loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)) { excluded += 1; continue; }
            je_total += signed_amount(&row, &mapping, "functional").map_err(|detail| error(
                "NUMERIC_PARSE_FAILED", "JE汇兑损益金额无法解析。", Some(format!("第{}行：{detail}", row.source_row))))?;
        }
    }
    Ok(json!({"tbFxGainLoss":tb_total, "tbRows":tb_rows,
        "jeFxGainLossAfterTransferExclusion":je_total, "excludedTransferRows":excluded,
        "jeTbDifference":je_total-tb_total}))
}

fn build_review_bridge(params: &Value, realized: &[Value], unrealized: &[Value]) -> Result<Value, AppError> {
    let Some(source) = params.get("jeSource") else {
        return Ok(json!({
            "pendingReviews": [], "pendingReviewAmount": 0.0,
            "coveredBookFxGainLoss": 0.0, "jeFxGainLoss": null,
            "automaticCoveredVouchers": 0, "pendingReviewCount": 0
        }));
    };
    let spec: SourceSpec = serde_json::from_value(source.clone())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
    let measured = realized.iter().chain(unrealized.iter())
        .filter_map(|item| item.get("voucherId").and_then(Value::as_str))
        .map(str::to_owned).collect::<HashSet<_>>();
    let id_indexes = std::iter::once(first_col(&mapping, "date")).flatten()
        .chain(mapped_cols(&mapping, "id"))
        .filter_map(|name| table.headers.iter().position(|header| header == &name)).collect::<Vec<_>>();
    let account_indexes = mapped_cols(&mapping, "account").iter()
        .filter_map(|name| table.headers.iter().position(|header| header == name)).collect::<Vec<_>>();
    let loss_keys = tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
    let mut groups = BTreeMap::<String, Vec<RowRecord>>::new();
    for (row, raw) in records(&table).into_iter().zip(table.rows.iter()) {
        if !is_je_business_row(&row, &mapping) || loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)) { continue; }
        groups.entry(voucher_id(&row, &mapping, params)).or_default().push(row);
    }
    let mut pending = Vec::new();
    let mut pending_amount = 0.0;
    let mut covered_book = 0.0;
    let mut je_total = 0.0;
    let mut covered_count = 0usize;
    for (id, rows) in groups {
        let mut booked = 0.0;
        let mut fx_accounts = BTreeSet::new();
        let mut all_accounts = BTreeSet::new();
        let mut currencies = BTreeSet::new();
        for row in &rows {
            let account = account_name(row, &mapping);
            if !account.trim().is_empty() { all_accounts.insert(account.clone()); }
            let currency = normalize_currency(cell(row, &mapping, "currency"));
            if !currency.is_empty() { currencies.insert(currency); }
            if role_for(&account, params) == "fx_gain_loss" {
                fx_accounts.insert(account);
                booked += signed_amount(row, &mapping, "functional").map_err(|detail| error(
                    "NUMERIC_PARSE_FAILED", "JE汇兑损益金额无法解析。", Some(format!("第{}行：{detail}", row.source_row))))?;
            }
        }
        if booked.abs() < 0.005 { continue; }
        je_total += booked;
        let display_id = display_voucher_id(&id);
        if measured.contains(&display_id) {
            covered_book += booked;
            covered_count += 1;
            continue;
        }
        let voucher_type = rows.iter().map(|row| cell(row, &mapping, "voucherType"))
            .find(|value| !value.trim().is_empty()).unwrap_or_default().trim().to_uppercase();
        let summary = rows.iter().map(|row| cell(row, &mapping, "summary"))
            .filter(|value| !value.trim().is_empty()).collect::<Vec<_>>().join(" | ");
        let reason = match voucher_type.as_str() {
            "AB" => "手工调整、重分类或多行净额凭证，暂不执行复杂分摊",
            "FX" => "重估影子科目、底层科目角色不明确或属于非货币性项目",
            "DZ" | "ZE" => "收付款结构包含多个货币性项目，无法可靠一对一匹配",
            _ => "结算或重估证据不足，无法可靠自动重算",
        };
        pending_amount += booked;
        pending.push(json!({
            "voucherId": display_id,
            "date": rows.iter().find_map(|row| parse_date(cell(row, &mapping, "date"))),
            "voucherType": voucher_type, "classification": "待复核",
            "bookedFxGainLoss": booked, "reviewReason": reason,
            "fxAccounts": fx_accounts.into_iter().collect::<Vec<_>>(),
            "accounts": all_accounts.into_iter().collect::<Vec<_>>(),
            "currencies": currencies.into_iter().collect::<Vec<_>>(),
            "evidence": summary
        }));
    }
    let pending_count = pending.len();
    Ok(json!({
        "pendingReviews": pending, "pendingReviewAmount": pending_amount,
        "coveredBookFxGainLoss": covered_book, "jeFxGainLoss": je_total,
        "automaticCoveredVouchers": covered_count,
        "pendingReviewCount": pending_count,
        "coverageDifference": je_total - covered_book - pending_amount
    }))
}

fn calculate_realized(
    params: &Value,
    snapshot: &RateSnapshot,
) -> Result<(Vec<Value>, Vec<Value>, Vec<Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
    let id_indexes = std::iter::once(first_col(&mapping, "date"))
        .flatten()
        .chain(mapped_cols(&mapping, "id"))
        .filter_map(|name| table.headers.iter().position(|header| header == &name))
        .collect::<Vec<_>>();
    let account_indexes = mapped_cols(&mapping, "account")
        .iter()
        .filter_map(|name| table.headers.iter().position(|header| header == name))
        .collect::<Vec<_>>();
    let loss_keys = tabular::detect_loss_transfer_ids(&table.rows, &id_indexes, &account_indexes);
    let loss_ids = records(&table)
        .into_iter()
        .zip(table.rows.iter())
        .filter(|(_, raw)| loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)))
        .map(|(row, _)| voucher_id(&row, &mapping, params))
        .collect::<HashSet<_>>();
    let mut groups: BTreeMap<String, Vec<RowRecord>> = BTreeMap::new();
    let mut quality = Vec::new();
    for row in records(&table).into_iter().filter(|row| is_je_business_row(row, &mapping)) {
        let id = voucher_id(&row, &mapping, params);
        if id.split('\u{1f}').any(|x| x.trim().is_empty()) {
            quality.push(json!({
                "source": "JE", "row": row.source_row,
                "type": "空匹配ID", "severity": "阻断"
            }));
        }
        groups.entry(id).or_default().push(row);
    }
    let mut calculation = Vec::new();
    let mut classes = Vec::new();
    for (id, rows) in groups {
        if loss_ids.contains(&id) {
            classes.push(json!({
                "voucherId": display_voucher_id(&id),
                "classification": "损益结转剔除",
                "eventType": "期间损益结转",
                "realizedScore": 0.0,
                "unrealizedScore": 0.0,
                "matchedRules": ["复用kanzhang：完整凭证含本年利润或未分配利润"],
                "counterEvidence": [],
                "confidence": "高",
                "ruleConflict": false
            }));
            continue;
        }
        let Some(date) = rows
            .iter()
            .find_map(|r| parse_date(cell(r, &mapping, "date")))
        else {
            continue;
        };
        let summary = rows
            .iter()
            .map(|r| cell(r, &mapping, "summary"))
            .collect::<Vec<_>>()
            .join(" ");
        let summary_lower = summary.to_lowercase();
        let voucher_type_upper = rows.iter()
            .map(|r| cell(r, &mapping, "voucherType").trim())
            .find(|value| !value.is_empty())
            .unwrap_or("")
            .to_uppercase();
        let mut has_fx = false;
        let mut has_cash = false;
        let mut settlement_targets = Vec::new();
        let mut monetary_counterparty_count = 0usize;
        let mut monetary_foreign = 0.0;
        let mut monetary_functional = 0.0;
        let mut cash_settlements = HashMap::<String, (f64, f64)>::new();
        for row in &rows {
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            has_fx |= role == "fx_gain_loss";
            has_cash |= role == "cash";
            if matches!(
                role.as_str(),
                "monetary_asset" | "monetary_liability" | "cash"
            ) {
                let foreign = signed_amount(row, &mapping, "foreign").map_err(|e| {
                    error(
                        "NUMERIC_PARSE_FAILED",
                        "JE关键金额存在无法解析的非空值。",
                        Some(format!("第{}行：{e}", row.source_row)),
                    )
                })?;
                let functional = signed_amount(row, &mapping, "functional").unwrap_or(0.0);
                monetary_foreign += foreign;
                monetary_functional += functional;
                if role == "cash" && foreign.abs() >= 0.005 && functional.abs() >= 0.005 {
                    let currency = normalize_currency(&currency_for(row, &mapping, &account, params));
                    let item = cash_settlements.entry(currency).or_default();
                    item.0 += foreign;
                    item.1 += functional;
                }
                if matches!(role.as_str(), "monetary_asset" | "monetary_liability") {
                    monetary_counterparty_count += 1;
                }
                let terminates_asset = role == "monetary_asset" && foreign < -0.005;
                let terminates_liability = role == "monetary_liability" && foreign > 0.005;
                if terminates_asset || terminates_liability {
                    settlement_targets.push((
                        row,
                        account,
                        role,
                        foreign,
                        functional,
                    ));
                }
            }
        }
        let revaluation_signal = voucher_type_upper == "FX"
            || ["valuation", "revaluation", "translation", "重估", "评估"]
                .iter().any(|value| summary_lower.contains(value));
        let text_settlement = [
            "结算", "收款", "付款", "核销", "抵销", "偿还", "结售汇",
            "settlement", "clearing", "payment", "receipt", "direct credit", "direct debit",
        ].iter().any(|value| summary_lower.contains(value));
        let type_settlement = matches!(voucher_type_upper.as_str(), "DZ" | "ZE");
        let structural_settlement = has_cash && !settlement_targets.is_empty();
        let has_settlement = text_settlement || type_settlement || structural_settlement;
        let simple_settlement = settlement_targets.len() == 1
            && monetary_counterparty_count == 1
            && voucher_type_upper != "AB"
            && !revaluation_signal;
        let realized_hard = has_fx && has_settlement && simple_settlement;
        let unrealized_hard = !realized_hard && revaluation_signal
            && monetary_foreign.abs() < 0.01 && monetary_functional.abs() > 0.01;
        let realized_score: f64 = (if realized_hard { 0.75 } else { 0.0 })
            + (if has_fx { 0.15 } else { 0.0 })
            + (if has_settlement { 0.1 } else { 0.0 });
        let unrealized_score: f64 =
            (if unrealized_hard { 0.8 } else { 0.0 }) + (if has_fx { 0.1 } else { 0.0 });
        let class = if realized_hard {
            "已实现"
        } else if unrealized_hard {
            "未实现"
        } else if realized_score >= unrealized_score {
            "已实现候选"
        } else {
            "未实现候选"
        };
        let confidence = if realized_score.max(unrealized_score) >= 0.8 {
            "高"
        } else if realized_score.max(unrealized_score) >= 0.55 {
            "中"
        } else {
            "低"
        };
        classes.push(json!({
            "voucherId": display_voucher_id(&id), "classification": class,
            "eventType": if has_settlement {"结算/终止确认"} else {"重估/待复核"},
            "realizedScore": realized_score, "unrealizedScore": unrealized_score,
            "matchedRules": [if realized_hard {
                "货币性项目原币减少且存在结算/抵销/转换/终止确认"
            } else if unrealized_hard {
                "本位币变化、原币净变动在容差内且无结算"
            } else {"证据评分"}],
            "counterEvidence": if !has_settlement {vec!["未识别到结算证据"]} else {vec![]},
            "confidence": confidence, "ruleConflict": realized_hard && unrealized_hard
        }));
        if realized_hard && !has_fx {
            quality.push(json!({
                "source": "JE", "voucherId": display_voucher_id(&id),
                "type": "已实现候选缺少历史账面价值证据", "severity": "待复核",
                "detail": "交易行本位币金额是结算金额，不能直接替代终止确认项目的历史账面价值；本凭证不计入自动测算总额。"
            }));
        }
        if realized_hard {
            for (row, account, role, foreign, functional) in settlement_targets {
                let entity = entity_for(row, &mapping, params);
                let currency = currency_for(row, &mapping, &account, params);
                let functional_code = functional_currency(entity, params);
                if let Some((official_rate, published)) =
                    rate(snapshot, date, &currency, &functional_code)
                {
                    let settlement = foreign.abs();
                    let normalized_currency = normalize_currency(&currency);
                    let cash_pair = cash_settlements.get(&normalized_currency).copied();
                    let cash_implied_rate = cash_pair.and_then(|(cash_foreign, cash_functional)| {
                        if cash_foreign.abs() < 0.005 || cash_functional.abs() < 0.005 {
                            None
                        } else {
                            let value = cash_functional.abs() / cash_foreign.abs();
                            value.is_finite().then_some(value)
                        }
                    });
                    // 对收付款结算，银行/现金行的本位币与原币金额形成实际结算汇率，
                    // 这是已实现损益的首选计量依据；央行中间价作为基准比较和无现金
                    // 结算时的后备汇率。这样不会把银行实际成交价差误报为会计错报。
                    let settlement_rate = cash_implied_rate.unwrap_or(official_rate);
                    let translated = settlement * settlement_rate;
                    let official_benchmark = settlement * official_rate;
                    let carrying = functional.abs();
                    // JE signed amounts use debit-positive convention. An asset
                    // settlement loss is carrying value minus translated cash;
                    // a liability settlement loss is translated cash minus carrying value.
                    let gain_loss = if role == "monetary_liability" {
                        translated - carrying
                    } else {
                        carrying - translated
                    };
                    calculation.push(json!({
                        "voucherId": display_voucher_id(&id), "date": date,
                        "entity": entity, "account": account, "role": role,
                        "currency": currency, "functionalCurrency": functional_code,
                        "settlementForeign": settlement, "officialRate": official_rate,
                        "settlementRate": settlement_rate,
                        "rateSource": if cash_implied_rate.is_some() {"JE现金/银行行实际结算汇率"} else {RATE_SOURCE},
                        "calculationMethod": if cash_implied_rate.is_some() {"实际结算汇率法"} else {"央行交易日汇率法（无可用现金结算行）"},
                        "publishedDate": published, "carryingFunctional": carrying,
                        "translatedFunctional": translated, "auditGainLoss": gain_loss,
                        "officialBenchmarkFunctional": official_benchmark,
                        "officialBenchmarkDifference": translated - official_benchmark,
                        "cashRequired": false, "sourceRow": row.source_row
                    }));
                } else {
                    quality.push(json!({
                        "source": "JE", "row": row.source_row, "type": "汇率缺失",
                        "currency": currency, "severity": "隔离"
                    }));
                }
            }
        }
    }
    Ok((calculation, classes, quality))
}

fn calculate_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("tbSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "TB参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "tbMapping");
    let start = parse_date(
        params
            .get("reportStart")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期开始日无效。", None))?;
    let end = parse_date(
        params
            .get("reportEnd")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .ok_or_else(|| error("REPORT_DATE_INVALID", "报告期结束日无效。", None))?;
    let has_je = params.get("jeSource").is_some();
    let has_foreign_balances = amount_scheme_ok(&mapping, "openingForeign")
        && amount_scheme_ok(&mapping, "closingForeign");
    if has_je && !has_foreign_balances {
        return calculate_back_calculated_unrealized(params, snapshot, start, end, &table, &mapping);
    }
    let mut output = Vec::new();
    let mut quality = Vec::new();
    let mut seen = HashSet::new();
    for row in records(&table) {
        let entity = entity_for(&row, &mapping, params);
        let account = account_name(&row, &mapping);
        let currency = currency_for(&row, &mapping, &account, params);
        let auxiliary = mapped_cols(&mapping, "auxiliary")
            .iter()
            .filter_map(|c| row.values.get(c))
            .map(|v| v.trim())
            .collect::<Vec<_>>()
            .join("|");
        let key = format!("{entity}\u{1f}{account}\u{1f}{currency}\u{1f}{auxiliary}");
        if !seen.insert(key.clone()) {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "重复余额键",
                "key": key, "severity": "阻断"
            }));
            continue;
        }
        let role = role_for(&account, params);
        if matches!(role.as_str(), "non_monetary" | "excluded" | "unassigned") {
            continue;
        }
        let parse = |prefix: &str| {
            signed_amount(&row, &mapping, prefix).map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "TB关键余额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })
        };
        let opening_foreign = parse("openingForeign")?;
        let opening_local = parse("openingFunctional")?;
        let closing_foreign = parse("closingForeign")?;
        let closing_local = parse("closingFunctional")?;
        let functional_code = functional_currency(entity, params);
        let Some((opening_rate, opening_published)) =
            rate(snapshot, start, &currency, &functional_code)
        else {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "汇率缺失",
                "currency": currency, "severity": "隔离"
            }));
            continue;
        };
        let Some((closing_rate, closing_published)) =
            rate(snapshot, end, &currency, &functional_code)
        else {
            quality.push(json!({
                "source": "TB", "row": row.source_row, "type": "汇率缺失",
                "currency": currency, "severity": "隔离"
            }));
            continue;
        };
        let opening_audit = opening_foreign * opening_rate;
        let closing_audit = closing_foreign * closing_rate;
        let opening_difference = opening_audit - opening_local;
        let closing_difference = closing_audit - closing_local;
        output.push(json!({
            "entity": entity, "account": account, "auxiliary": auxiliary,
            "currency": currency, "functionalCurrency": functional_code,
            "openingForeign": opening_foreign, "openingBookFunctional": opening_local,
            "openingRate": opening_rate, "openingPublishedDate": opening_published,
            "openingAuditFunctional": opening_audit, "openingDifference": opening_difference,
            "closingForeign": closing_foreign, "closingBookFunctional": closing_local,
            "closingRate": closing_rate, "closingPublishedDate": closing_published,
            "closingAuditFunctional": closing_audit, "closingDifference": closing_difference,
            "twoPointChange": closing_difference - opening_difference,
            "suggestedAdjustment": closing_difference,
            "method": if has_je {
                "月度滚动（TB端点勾稽）"
            } else {
                "年初/年末两时点检查"
            },
            "sourceRow": row.source_row
        }));
    }
    if has_je {
        let monthly =
            calculate_monthly_unrealized(params, snapshot, start, end, &output, &mut quality)?;
        Ok((monthly, quality))
    } else {
        Ok((output, quality))
    }
}

fn calculate_back_calculated_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    start: NaiveDate,
    end: NaiveDate,
    tb_table: &FxTable,
    tb_mapping: &Map<String, Value>,
) -> Result<(Vec<Value>, Vec<Value>), AppError> {
    let je_spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let je_table = load_fx_table(&je_spec)?;
    let je_mapping = mapping_obj(params, "jeMapping");
    let derive_opening = !amount_scheme_ok(tb_mapping, "openingFunctional");
    let mut balances = HashMap::<String, f64>::new();
    let mut closing_balances = HashMap::<String, f64>::new();
    for row in records(tb_table) {
        let account = account_name(&row, tb_mapping);
        let currency = currency_for(&row, tb_mapping, &account, params);
        if currency.is_empty() || !matches!(role_for(&account, params).as_str(), "cash" | "monetary_asset" | "monetary_liability") {
            continue;
        }
        let entity = entity_for(&row, tb_mapping, params);
        let key = format!("{entity}\u{1f}{}\u{1f}{currency}", account_match_key(&account));
        if derive_opening {
            let closing = signed_amount(&row, tb_mapping, "closingFunctional").map_err(|detail| {
                error("NUMERIC_PARSE_FAILED", "TB期末本位币余额无法解析。", Some(format!("第{}行：{detail}", row.source_row)))
            })?;
            closing_balances.insert(key, closing);
        } else {
            let opening = signed_amount(&row, tb_mapping, "openingFunctional").map_err(|detail| {
                error("NUMERIC_PARSE_FAILED", "TB期初本位币余额无法解析。", Some(format!("第{}行：{detail}", row.source_row)))
            })?;
            balances.insert(key, opening);
        }
    }

    let id_indexes = std::iter::once(first_col(&je_mapping, "date"))
        .flatten()
        .chain(mapped_cols(&je_mapping, "id"))
        .filter_map(|name| je_table.headers.iter().position(|header| header == &name))
        .collect::<Vec<_>>();
    let account_indexes = mapped_cols(&je_mapping, "account")
        .iter()
        .filter_map(|name| je_table.headers.iter().position(|header| header == name))
        .collect::<Vec<_>>();
    let loss_keys = tabular::detect_loss_transfer_ids(&je_table.rows, &id_indexes, &account_indexes);
    let mut groups = BTreeMap::<(NaiveDate, String), Vec<RowRecord>>::new();
    for (row, raw) in records(&je_table).into_iter().zip(je_table.rows.iter()) {
        if !is_je_business_row(&row, &je_mapping) { continue; }
        let Some(date) = parse_date(cell(&row, &je_mapping, "date")) else { continue };
        let id = voucher_id(&row, &je_mapping, params);
        if !loss_keys.contains(&tabular::voucher_key(raw, &id_indexes)) {
            groups.entry((date, id)).or_default().push(row);
        }
    }
    if derive_opening {
        let mut movements = HashMap::<String, f64>::new();
        for rows in groups.values() {
            for row in rows {
                let account = account_name(row, &je_mapping);
                let role = role_for(&account, params);
                if !matches!(role.as_str(), "cash" | "monetary_asset" | "monetary_liability") { continue; }
                let entity = entity_for(row, &je_mapping, params);
                let currency = currency_for(row, &je_mapping, &account, params);
                if currency.is_empty() || currency == functional_currency(entity, params) { continue; }
                let key = format!("{entity}\u{1f}{}\u{1f}{currency}", account_match_key(&account));
                *movements.entry(key).or_default() += signed_amount(row, &je_mapping, "functional").map_err(|detail| error(
                    "NUMERIC_PARSE_FAILED", "JE本位币金额无法解析。", Some(format!("第{}行：{detail}", row.source_row))))?;
            }
        }
        for (key, closing) in closing_balances { balances.insert(key.clone(), closing - movements.get(&key).copied().unwrap_or(0.0)); }
    }
    let mut output = Vec::new();
    let mut quality = vec![json!({
        "source": "TB+JE", "type": "原币余额倒算",
        "severity": "提示",
        "detail": "TB无原币余额；仅对科目名称/JE币种识别出的外币货币性项目，以月末官方汇率倒算原币，并用完整凭证识别客户重估。"
    })];
    for ((date, id), rows) in groups {
        if date < start || date > end { continue; }
        let summary = rows.iter().map(|row| cell(row, &je_mapping, "summary")).collect::<Vec<_>>().join(" ");
        let voucher_type = rows.iter().map(|row| cell(row, &je_mapping, "voucherType")).collect::<Vec<_>>().join(" ");
        let summary_lower = summary.to_lowercase();
        let revaluation_signal = voucher_type.split_whitespace().any(|value| value.eq_ignore_ascii_case("fx"))
            || ["valuation", "revaluation", "translation", "重估", "评估"]
                .iter().any(|value| summary_lower.contains(value));
        let mut movements = BTreeMap::<String, (String, String, String, String, f64, f64)>::new();
        for row in &rows {
            let account = account_name(row, &je_mapping);
            let role = role_for(&account, params);
            if !matches!(role.as_str(), "cash" | "monetary_asset" | "monetary_liability") { continue; }
            let entity = entity_for(row, &je_mapping, params).to_owned();
            let currency = currency_for(row, &je_mapping, &account, params);
            if currency.is_empty() || currency == functional_currency(&entity, params) { continue; }
            let foreign = signed_amount(row, &je_mapping, "foreign").map_err(|detail| error(
                "NUMERIC_PARSE_FAILED", "JE原币金额无法解析。", Some(format!("第{}行：{detail}", row.source_row))))?;
            let functional = signed_amount(row, &je_mapping, "functional").map_err(|detail| error(
                "NUMERIC_PARSE_FAILED", "JE本位币金额无法解析。", Some(format!("第{}行：{detail}", row.source_row))))?;
            let key = format!("{entity}\u{1f}{}\u{1f}{currency}", account_match_key(&account));
            let item = movements.entry(key).or_insert((entity, account, role, currency, 0.0, 0.0));
            item.4 += foreign;
            item.5 += functional;
        }
        for (key, (entity, account, role, currency, foreign_movement, functional_movement)) in movements {
            let before = balances.get(&key).copied().unwrap_or(0.0);
            let after = before + functional_movement;
            let is_revaluation = revaluation_signal && foreign_movement.abs() < 0.01 && functional_movement.abs() >= 0.01;
            if is_revaluation {
                if let Some((official_rate, published_date)) = rate(snapshot, date, &currency, &functional_currency(&entity, params)) {
                    let inferred_foreign = after / official_rate;
                    let audit_closing = inferred_foreign * official_rate;
                    let pnl = -(audit_closing - before);
                    let is_reversal = summary_lower.contains("reversal") || summary_lower.contains("冲回");
                    output.push(json!({
                        "monthEnd": date, "voucherId": display_voucher_id(&id),
                        "entity": entity, "account": account, "role": role,
                        "currency": currency, "functionalCurrency": functional_currency(&entity, params),
                        "preRevaluationFunctional": before,
                        "clientRevaluationExcluded": functional_movement,
                        "postRevaluationFunctional": after,
                        "officialRate": official_rate, "publishedDate": published_date,
                        "inferredForeign": inferred_foreign,
                        "auditClosingFunctional": audit_closing,
                        "unrealizedGainLoss": pnl, "suggestedAdjustment": pnl,
                        "method": if is_reversal {
                            "客户重估冲回复核（TB无原币余额，暂按账面冲回金额）"
                        } else {
                            "客户月末重估凭证复核（TB无原币余额，暂按账面重估金额）"
                        },
                        "rateSource": "央行中间价（仅用于倒算原币展示）",
                        "evidence": summary
                    }));
                } else {
                    quality.push(json!({"source":"JE", "type":"汇率缺失", "voucherId":display_voucher_id(&id), "currency":currency, "severity":"隔离"}));
                }
            }
            balances.insert(key, after);
        }
    }
    Ok((output, quality))
}

fn calculate_monthly_unrealized(
    params: &Value,
    snapshot: &RateSnapshot,
    start: NaiveDate,
    end: NaiveDate,
    endpoints: &[Value],
    quality: &mut Vec<Value>,
) -> Result<Vec<Value>, AppError> {
    let spec: SourceSpec = serde_json::from_value(params.get("jeSource").cloned().unwrap())
        .map_err(|e| error("INVALID_PARAMS", "JE参数无效。", Some(e.to_string())))?;
    let table = load_fx_table(&spec)?;
    let mapping = mapping_obj(params, "jeMapping");
    let rows = records(&table);
    // entity/account/currency is the common key available in both JE and TB.
    // Auxiliary values remain in the source trace and duplicate TB keys are
    // already blocked by validation/data-quality checks.
    let key_for = |entity: &str, account: &str, currency: &str| {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            entity.trim(),
            account.trim(),
            normalize_currency(currency)
        )
    };
    let mut state: BTreeMap<String, (String, String, String, f64, f64)> = BTreeMap::new();
    let mut closing_book = HashMap::new();
    for endpoint in endpoints {
        let entity = endpoint.get("entity").and_then(Value::as_str).unwrap_or("");
        let account = endpoint
            .get("account")
            .and_then(Value::as_str)
            .unwrap_or("");
        let currency = endpoint
            .get("currency")
            .and_then(Value::as_str)
            .unwrap_or("");
        let key = key_for(entity, account, currency);
        state.insert(
            key.clone(),
            (
                entity.into(),
                account.into(),
                currency.into(),
                endpoint
                    .get("openingForeign")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                endpoint
                    .get("openingAuditFunctional")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
            ),
        );
        closing_book.insert(
            key,
            endpoint
                .get("closingBookFunctional")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
        );
    }
    let mut output = Vec::new();
    let mut previous = start - Duration::days(1);
    for month_end in date_points(start, end)
        .into_iter()
        .filter(|date| *date == end || (*date + Duration::days(1)).day() == 1)
    {
        let mut movement: HashMap<String, (f64, f64, f64)> = HashMap::new();
        for row in &rows {
            let Some(date) = parse_date(cell(row, &mapping, "date")) else {
                continue;
            };
            if date <= previous || date > month_end {
                continue;
            }
            let account = account_name(row, &mapping);
            let role = role_for(&account, params);
            if !matches!(
                role.as_str(),
                "cash" | "monetary_asset" | "monetary_liability"
            ) {
                continue;
            }
            let entity = cell(row, &mapping, "entity");
            let currency = cell(row, &mapping, "currency");
            let key = key_for(entity, &account, currency);
            let foreign = signed_amount(row, &mapping, "foreign").map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE关键金额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })?;
            let functional = signed_amount(row, &mapping, "functional").map_err(|e| {
                error(
                    "NUMERIC_PARSE_FAILED",
                    "JE关键金额存在无法解析的非空值。",
                    Some(format!("第{}行：{e}", row.source_row)),
                )
            })?;
            let revaluation = foreign.abs() < 0.01 && functional.abs() >= 0.01;
            let item = movement.entry(key.clone()).or_insert((0.0, 0.0, 0.0));
            item.0 += foreign;
            if revaluation {
                item.2 += functional;
            } else {
                item.1 += functional;
            }
            state.entry(key).or_insert_with(|| {
                (
                    entity.into(),
                    account.clone(),
                    normalize_currency(currency),
                    0.0,
                    0.0,
                )
            });
        }
        for (key, (entity, account, currency, foreign_balance, prior_audit)) in state.clone() {
            let (foreign_change, non_revaluation_change, client_revaluation) =
                movement.get(&key).copied().unwrap_or((0.0, 0.0, 0.0));
            let closing_foreign = foreign_balance + foreign_change;
            let functional = functional_currency(&entity, params);
            let Some((official_rate, published_date)) =
                rate(snapshot, month_end, &currency, &functional)
            else {
                quality.push(json!({
                    "source": "JE", "type": "月末汇率缺失", "currency": currency,
                    "monthEnd": month_end, "severity": "隔离"
                }));
                continue;
            };
            let pre_revaluation = prior_audit + non_revaluation_change;
            let audit_closing = closing_foreign * official_rate;
            let unrealized = audit_closing - pre_revaluation;
            let tb_closing = if month_end == end {
                closing_book.get(&key).copied()
            } else {
                None
            };
            output.push(json!({
                "monthEnd": month_end, "entity": entity, "account": account,
                "currency": currency, "functionalCurrency": functional,
                "openingAuditFunctional": prior_audit,
                "foreignMovement": foreign_change, "closingForeign": closing_foreign,
                "nonRevaluationFunctionalMovement": non_revaluation_change,
                "clientRevaluationExcluded": client_revaluation,
                "preRevaluationFunctional": pre_revaluation,
                "officialRate": official_rate, "publishedDate": published_date,
                "auditClosingFunctional": audit_closing,
                "unrealizedGainLoss": unrealized,
                "suggestedAdjustment": unrealized,
                "tbClosingFunctional": tb_closing,
                "tbReconciliationDifference": tb_closing.map(|value| audit_closing - value),
                "method": "月度滚动"
            }));
            state.insert(
                key,
                (entity, account, currency, closing_foreign, audit_closing),
            );
        }
        previous = month_end;
    }
    Ok(output)
}

fn export_workbook(params: &Value, result: &Value) -> Result<String, AppError> {
    let output = params
        .get("outputPath")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let source = params
                .get("tbSource")
                .or_else(|| params.get("jeSource"))
                .and_then(|v| v.get("inputPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            source.parent().unwrap_or(Path::new(".")).join(format!(
                "汇兑损益审计测算_{}.xlsx",
                Utc::now().format("%Y%m%d_%H%M%S")
            ))
        });
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            error(
                "OUTPUT_WRITE_FAILED",
                "无法创建输出目录。",
                Some(e.to_string()),
            )
        })?;
    }
    let partial = output.with_extension("partial.xlsx");
    let mut workbook = Workbook::new();
    let mode = result.get("mode").and_then(Value::as_str).unwrap_or("");
    write_user_conclusion_sheet(&mut workbook, params, result)?;
    write_user_calculation_sheet(&mut workbook, result)?;
    write_kv_sheet(
        &mut workbook,
        "使用说明",
        &[
            (
                "底稿用途",
                "汇兑损益审计重算；结果需结合业务资料与审计判断复核。",
            ),
            ("测算模式", mode),
            ("汇率口径", RATE_SOURCE),
            (
                "重要说明",
                "现金科目并非已实现的必要条件；系统按结算、抵销、币种转换或终止确认判断。",
            ),
        ],
    )?;
    write_json_object_sheet(
        &mut workbook,
        "执行摘要",
        result.get("summary").unwrap_or(&Value::Null),
    )?;
    write_kv_sheet(
        &mut workbook,
        "参数与口径",
        &[
            (
                "报告期开始",
                params
                    .get("reportStart")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "报告期结束",
                params
                    .get("reportEnd")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            ("测算模式", mode),
        ],
    )?;
    write_mapping_sheet(&mut workbook, "JE字段映射", params.get("jeMapping"))?;
    write_mapping_sheet(&mut workbook, "TB字段映射", params.get("tbMapping"))?;
    write_value_array_sheet(&mut workbook, "数据质量", result.get("dataQuality"))?;
    write_value_array_sheet(&mut workbook, "待复核项目", result.get("pendingReview"))?;
    write_mapping_sheet(&mut workbook, "科目角色", params.get("accountRoles"))?;
    write_value_array_sheet(
        &mut workbook,
        "央行汇率",
        result.pointer("/rateSnapshot/rates"),
    )?;
    write_value_array_sheet(&mut workbook, "异常与限制", result.get("dataQuality"))?;
    write_json_object_sheet(
        &mut workbook,
        "_rate_snapshot",
        result.get("rateSnapshot").unwrap_or(&Value::Null),
    )?;
    write_kv_sheet(
        &mut workbook,
        "_source_trace",
        &[
            (
                "JE来源",
                params
                    .pointer("/jeSource/inputPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "TB来源",
                params
                    .pointer("/tbSource/inputPath")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
            (
                "汇率响应哈希",
                result
                    .pointer("/rateSnapshot/responseHash")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            ),
        ],
    )?;
    if matches!(mode, "realized" | "combined") {
        write_value_array_sheet(&mut workbook, "JE完整明细", result.get("jeDetail"))?;
        write_value_array_sheet(&mut workbook, "事件分类", result.get("classification"))?;
        write_value_array_sheet(&mut workbook, "已实现测算", result.get("realized"))?;
        let summary_row = Value::Array(vec![result.get("summary").cloned().unwrap_or(Value::Null)]);
        write_value_array_sheet(&mut workbook, "已实现汇总", Some(&summary_row))?;
    }
    if matches!(mode, "unrealized" | "combined") {
        if params.get("jeSource").is_some() {
            write_value_array_sheet(
                &mut workbook,
                "未实现凭证识别",
                result.get("classification"),
            )?;
            write_value_array_sheet(&mut workbook, "月度测算", result.get("unrealized"))?;
            let summary_row =
                Value::Array(vec![result.get("summary").cloned().unwrap_or(Value::Null)]);
            write_value_array_sheet(&mut workbook, "全年汇总", Some(&summary_row))?;
            let reconciliation_row = Value::Array(vec![result.get("reconciliation").cloned().unwrap_or(Value::Null)]);
            write_value_array_sheet(&mut workbook, "TB勾稽", Some(&reconciliation_row))?;
        } else {
            write_value_array_sheet(&mut workbook, "TB余额明细", result.get("unrealized"))?;
            write_filtered_sheet(
                &mut workbook,
                "年初重估",
                result.get("unrealized"),
                "opening",
            )?;
            write_filtered_sheet(
                &mut workbook,
                "年末重估",
                result.get("unrealized"),
                "closing",
            )?;
            write_value_array_sheet(&mut workbook, "两时点分析", result.get("unrealized"))?;
        }
    }
    for name in [
        "使用说明", "执行摘要", "参数与口径", "JE字段映射", "TB字段映射", "数据质量", "待复核项目",
        "科目角色", "央行汇率", "异常与限制", "_rate_snapshot", "_source_trace", "JE完整明细",
        "事件分类", "已实现测算", "已实现汇总", "未实现凭证识别", "月度测算", "全年汇总",
        "TB勾稽", "TB余额明细", "年初重估", "年末重估", "两时点分析",
    ] {
        if let Ok(sheet) = workbook.worksheet_from_name(name) {
            sheet.set_hidden(true);
        }
    }
    workbook.worksheet_from_name("审计结论").map_err(xlsx_err)?.set_active(true);
    workbook.save(&partial).map_err(xlsx_err)?;
    fs::rename(&partial, &output).map_err(|e| {
        error(
            "OUTPUT_WRITE_FAILED",
            "无法保存审计底稿，文件可能正在被占用。",
            Some(e.to_string()),
        )
    })?;
    Ok(output.to_string_lossy().into_owned())
}

fn write_user_conclusion_sheet(
    workbook: &mut Workbook,
    params: &Value,
    result: &Value,
) -> Result<(), AppError> {
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent = Format::new().set_num_format("0.00%");
    let pass = Format::new().set_bold().set_font_color("#1B5E20").set_background_color("#E8F5E9");
    let sheet = workbook.add_worksheet();
    setup(sheet, "审计结论")?;
    sheet.write_string_with_format(0, 0, "项目", &header).map_err(xlsx_err)?;
    sheet.write_string_with_format(0, 1, "结果", &header).map_err(xlsx_err)?;
    let summary = result.get("summary").unwrap_or(&Value::Null);
    let text_rows = [
        ("公司/核算主体", fixed_entity(params)),
        ("报告期间", &format!("{} 至 {}", params.get("reportStart").and_then(Value::as_str).unwrap_or(""), params.get("reportEnd").and_then(Value::as_str).unwrap_or(""))),
        ("测算范围", localized_scalar(result.get("mode").and_then(Value::as_str).unwrap_or(""))),
    ];
    for (index, (label, value)) in text_rows.iter().enumerate() {
        sheet.write_string((index + 1) as u32, 0, *label).map_err(xlsx_err)?;
        sheet.write_string((index + 1) as u32, 1, *value).map_err(xlsx_err)?;
    }
    let amount_rows = [
        ("已实现汇兑损益测算", "realizedGainLoss"),
        ("未实现汇兑损益测算", "unrealizedAdjustment"),
        ("自动测算合计", "automaticMeasuredFxGainLoss"),
        ("待复核项目（账面金额）", "pendingReviewAmount"),
        ("暂估审计汇兑损益", "auditFxGainLoss"),
        ("TB财务费用—汇兑损益", "tbFxGainLoss"),
        ("测算差异", "difference"),
    ];
    for (offset, (label, key)) in amount_rows.iter().enumerate() {
        let row = (offset + 4) as u32;
        sheet.write_string(row, 0, *label).map_err(xlsx_err)?;
        let cached = summary.get(*key).and_then(Value::as_f64).unwrap_or(0.0);
        let formula = match *key {
            "realizedGainLoss" => "SUMIF('汇兑损益测算'!$C:$C,\"已实现\",'汇兑损益测算'!$J:$J)",
            "unrealizedAdjustment" => "SUMIF('汇兑损益测算'!$C:$C,\"未实现\",'汇兑损益测算'!$J:$J)",
            "automaticMeasuredFxGainLoss" => "SUM(B5:B6)",
            "pendingReviewAmount" => "SUMIF('汇兑损益测算'!$C:$C,\"待复核\",'汇兑损益测算'!$J:$J)",
            "auditFxGainLoss" => "SUM('汇兑损益测算'!$J:$J)",
            "difference" => "B9-B10",
            _ => "",
        };
        if formula.is_empty() {
            sheet.write_number_with_format(row, 1, cached, &amount).map_err(xlsx_err)?;
        } else {
            sheet.write_formula_with_format(row, 1, Formula::new(formula).set_result(cached.to_string()), &amount).map_err(xlsx_err)?;
        }
    }
    sheet.write_string(11, 0, "差异率").map_err(xlsx_err)?;
    let ratio = summary.get("differenceRatio").and_then(Value::as_f64).unwrap_or(0.0);
    sheet.write_formula_with_format(11, 1, Formula::new("IFERROR(ABS(B11/B10),0)").set_result(ratio.to_string()), &percent).map_err(xlsx_err)?;
    sheet.write_string(12, 0, "勾稽结果").map_err(xlsx_err)?;
    let passed = summary.get("reconciliationPassed").and_then(Value::as_bool).unwrap_or(false);
    sheet.write_string_with_format(12, 1, if passed { "通过" } else { "不通过" }, &pass).map_err(xlsx_err)?;
    sheet.write_string_with_format(14, 0, "测算类型", &header).map_err(xlsx_err)?;
    sheet.write_string_with_format(14, 1, "测算方法、公式及数据来源", &header).map_err(xlsx_err)?;
    let method_text = Format::new().set_text_wrap();
    let methods = [
        ("已实现", "实际结算汇率法：实际结算汇率＝|JE现金/银行行本位币金额合计|÷|JE现金/银行行原币金额合计|；资产损益＝终止确认账面价值－结算原币×实际结算汇率；负债损益＝结算原币×实际结算汇率－终止确认账面价值。央行交易日中间价作为基准比较；无可用现金行时作为后备汇率。数据来源：完整JE凭证、央行汇率快照。"),
        ("未实现", "有原币余额时：月末审计余额＝月末原币余额×央行月末汇率；未实现损益＝月末审计余额－重估前本位币余额。TB无原币余额时，不伪造独立重算：识别客户重估及冲回凭证，暂按账面重估金额复核，央行汇率仅用于倒算原币展示。数据来源：JE重估/冲回凭证、TB、央行汇率快照。"),
        ("待复核", "无法可靠自动重算的复杂、多对多或科目角色不明凭证，暂按JE汇兑损益科目账面金额纳入暂估审计金额，并在隐藏明细中保留凭证号和待复核原因。"),
        ("TB对比", "优先取TB累计/YTD本位币净额；只有借方发生额和贷方发生额两列同时映射时才采用借方减贷方。单边MTD字段不得覆盖YTD累计字段。数据来源：TB财务费用—汇兑损益明细科目。"),
    ];
    for (offset, (kind, detail)) in methods.iter().enumerate() {
        let row = (15 + offset) as u32;
        sheet.write_string(row, 0, *kind).map_err(xlsx_err)?;
        sheet.write_string_with_format(row, 1, *detail, &method_text).map_err(xlsx_err)?;
        sheet.set_row_height(row, 54).map_err(xlsx_err)?;
    }
    sheet.set_column_width(0, 32).map_err(xlsx_err)?;
    sheet.set_column_width(1, 96).map_err(xlsx_err)?;
    Ok(())
}

fn write_user_calculation_sheet(workbook: &mut Workbook, result: &Value) -> Result<(), AppError> {
    let mut rows = Vec::new();
    for item in result.get("realized").and_then(Value::as_array).into_iter().flatten() {
        rows.push(json!({
            "date": item.get("date"), "voucherId": item.get("voucherId"), "calculationType": "已实现",
            "account": item.get("account"), "currency": item.get("currency"),
            "foreignAmount": item.get("settlementForeign"),
            "appliedRate": item.get("settlementRate").or_else(|| item.get("officialRate")),
            "bookAmount": item.get("carryingFunctional"), "auditAmount": item.get("translatedFunctional"),
            "gainLoss": item.get("auditGainLoss"), "formulaDirection": if item.get("role").and_then(Value::as_str)==Some("monetary_liability") {"审计金额－账面金额"} else {"账面金额－审计金额"},
            "note": format!("{}；汇率来源：{}；央行交易日中间价：{:.6}",
                item.get("calculationMethod").and_then(Value::as_str).unwrap_or("结算事件测算"),
                item.get("rateSource").and_then(Value::as_str).unwrap_or(RATE_SOURCE),
                item.get("officialRate").and_then(Value::as_f64).unwrap_or(0.0))
        }));
    }
    for item in result.get("unrealized").and_then(Value::as_array).into_iter().flatten() {
        rows.push(json!({
            "date": item.get("monthEnd"), "voucherId": item.get("voucherId"), "calculationType": "未实现",
            "account": item.get("account"), "currency": item.get("currency"),
            "foreignAmount": item.get("inferredForeign").or_else(|| item.get("closingForeign")),
            "appliedRate": item.get("officialRate").or_else(|| item.get("closingRate")),
            "bookAmount": item.get("preRevaluationFunctional").or_else(|| item.get("closingBookFunctional")),
            "auditAmount": item.get("auditClosingFunctional").or_else(|| item.get("closingAuditFunctional")),
            "gainLoss": item.get("unrealizedGainLoss").or_else(|| item.get("suggestedAdjustment")),
            "formulaDirection": if item.get("inferredForeign").is_some() {"账面金额－审计金额"} else {"审计金额－账面金额"},
            "note": format!("{}；数据来源：JE重估/冲回凭证、TB及央行汇率快照",
                item.get("method").and_then(Value::as_str).unwrap_or("未实现重估测算"))
        }));
    }
    for item in result.get("pendingReview").and_then(Value::as_array).into_iter().flatten() {
        rows.push(json!({
            "date": item.get("date"), "voucherId": item.get("voucherId"), "calculationType": "待复核",
            "account": item.get("fxAccounts"), "currency": item.get("currencies"),
            "foreignAmount": 0.0, "appliedRate": 0.0,
            "bookAmount": item.get("bookedFxGainLoss"), "auditAmount": null,
            "gainLoss": item.get("bookedFxGainLoss"), "formulaDirection": "暂按账面金额保留",
            "note": item.get("reviewReason"), "pending": true
        }));
    }
    let (header, _) = formats();
    let amount = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let rate = Format::new().set_num_format("0.000000");
    let sheet = workbook.add_worksheet();
    setup(sheet, "汇兑损益测算")?;
    for (column, title) in ["日期","凭证匹配ID","测算类型","科目","币种","原币金额","测算采用汇率","账面本位币金额","审计本位币金额","测算/待复核金额","计算逻辑","测算方法与数据来源"].iter().enumerate() {
        sheet.write_string_with_format(0, column as u16, *title, &header).map_err(xlsx_err)?;
        sheet.set_column_width(column as u16, if matches!(column,3|10|11) {36} else {18}).map_err(xlsx_err)?;
    }
    for (index, row) in rows.iter().enumerate() {
        let excel_row = index + 2;
        let output_row = (index + 1) as u32;
        for (column, key) in ["date","voucherId","calculationType","account","currency"].iter().enumerate() {
            sheet.write_string(output_row, column as u16, localized_text(key, row.get(key).unwrap_or(&Value::Null))).map_err(xlsx_err)?;
        }
        let foreign = row.get("foreignAmount").and_then(Value::as_f64).unwrap_or(0.0);
        let applied_rate = row.get("appliedRate").and_then(Value::as_f64).unwrap_or(0.0);
        let book = row.get("bookAmount").and_then(Value::as_f64).unwrap_or(0.0);
        let audit = row.get("auditAmount").and_then(Value::as_f64).unwrap_or(0.0);
        let gain_loss = row.get("gainLoss").and_then(Value::as_f64).unwrap_or(0.0);
        sheet.write_number_with_format(output_row, 5, foreign, &amount).map_err(xlsx_err)?;
        sheet.write_number_with_format(output_row, 6, applied_rate, &rate).map_err(xlsx_err)?;
        sheet.write_number_with_format(output_row, 7, book, &amount).map_err(xlsx_err)?;
        let direction = row.get("formulaDirection").and_then(Value::as_str).unwrap_or("审计金额－账面金额");
        let pending = row.get("pending").and_then(Value::as_bool).unwrap_or(false);
        if pending {
            sheet.write_blank(output_row, 8, &amount).map_err(xlsx_err)?;
        } else {
            sheet.write_formula_with_format(output_row, 8, Formula::new(format!("F{excel_row}*G{excel_row}")).set_result(audit.to_string()), &amount).map_err(xlsx_err)?;
        }
        let formula = if pending { format!("H{excel_row}") } else if direction.starts_with("账面") { format!("H{excel_row}-I{excel_row}") } else { format!("I{excel_row}-H{excel_row}") };
        sheet.write_formula_with_format(output_row, 9, Formula::new(formula).set_result(gain_loss.to_string()), &amount).map_err(xlsx_err)?;
        sheet.write_string(output_row, 10, direction).map_err(xlsx_err)?;
        sheet.write_string(output_row, 11, localized_text("note", row.get("note").unwrap_or(&Value::Null))).map_err(xlsx_err)?;
    }
    Ok(())
}

fn formats() -> (Format, Format) {
    (
        Format::new()
            .set_bold()
            .set_font_color("#FFFFFF")
            .set_background_color("#245A57")
            .set_align(FormatAlign::Center),
        Format::new().set_background_color("#EAF3F1"),
    )
}

fn setup(worksheet: &mut Worksheet, name: &str) -> Result<(), AppError> {
    worksheet.set_name(name).map_err(xlsx_err)?;
    worksheet.set_freeze_panes(1, 0).map_err(xlsx_err)?;
    Ok(())
}

fn write_kv_sheet(
    workbook: &mut Workbook,
    name: &str,
    rows: &[(&str, &str)],
) -> Result<(), AppError> {
    let (header, _) = formats();
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    worksheet
        .write_string_with_format(0, 0, "项目", &header)
        .map_err(xlsx_err)?;
    worksheet
        .write_string_with_format(0, 1, "内容", &header)
        .map_err(xlsx_err)?;
    for (index, (key, value)) in rows.iter().enumerate() {
        worksheet
            .write_string((index + 1) as u32, 0, *key)
            .map_err(xlsx_err)?;
        worksheet
            .write_string((index + 1) as u32, 1, localized_scalar(value))
            .map_err(xlsx_err)?;
    }
    worksheet.set_column_width(0, 22).map_err(xlsx_err)?;
    worksheet.set_column_width(1, 80).map_err(xlsx_err)?;
    Ok(())
}

fn write_json_object_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: &Value,
) -> Result<(), AppError> {
    let (header, _) = formats();
    let number_format = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent_format = Format::new().set_num_format("0.00%");
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    worksheet.write_string_with_format(0, 0, "项目", &header).map_err(xlsx_err)?;
    worksheet.write_string_with_format(0, 1, "内容", &header).map_err(xlsx_err)?;
    for (index, (key, value)) in value.as_object().into_iter().flatten().enumerate() {
        worksheet.write_string((index + 1) as u32, 0, chinese_header(key)).map_err(xlsx_err)?;
        match value {
            Value::Number(value) => worksheet.write_number_with_format(
                (index + 1) as u32, 1, value.as_f64().unwrap_or(0.0),
                if key.to_lowercase().contains("ratio") { &percent_format } else { &number_format }
            ).map_err(xlsx_err)?,
            Value::Bool(value) => worksheet.write_string((index + 1) as u32, 1, if *value { "是" } else { "否" }).map_err(xlsx_err)?,
            _ => worksheet.write_string((index + 1) as u32, 1, localized_text(key, value)).map_err(xlsx_err)?,
        };
    }
    worksheet.set_column_width(0, 28).map_err(xlsx_err)?;
    worksheet.set_column_width(1, 38).map_err(xlsx_err)?;
    Ok(())
}

fn write_mapping_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
) -> Result<(), AppError> {
    let rows = value
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(key, value)| {
                    json!({
                        "字段角色": chinese_header(key), "最终映射": value,
                        "识别方式": "硬编码 + LLM复核 + 用户确认",
                        "校验结果": "后端再次验证"
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    write_value_array_sheet(workbook, name, Some(&Value::Array(rows)))
}

fn write_value_array_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
) -> Result<(), AppError> {
    let rows = value.and_then(Value::as_array).cloned().unwrap_or_default();
    let mut keys = BTreeSet::new();
    for row in &rows {
        if let Some(object) = row.as_object() {
            keys.extend(object.keys().cloned());
        }
    }
    let keys = keys.into_iter().collect::<Vec<_>>();
    let (header, _) = formats();
    let number_format = Format::new().set_num_format("#,##0.00;[Red](#,##0.00);-");
    let percent_format = Format::new().set_num_format("0.00%");
    let worksheet = workbook.add_worksheet();
    setup(worksheet, name)?;
    for (column, key) in keys.iter().enumerate() {
        worksheet
            .write_string_with_format(0, column as u16, chinese_header(key), &header)
            .map_err(xlsx_err)?;
        worksheet
            .set_column_width(column as u16, match key.as_str() {
                "account" => 38, "evidence" | "detail" | "matchedRules" | "counterEvidence" | "tbRows" => 50,
                "method" | "summary" | "scheme" => 36, _ => 24,
            })
            .map_err(xlsx_err)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        for (column, key) in keys.iter().enumerate() {
            if let Some(value) = row.get(key) {
                match value {
                    Value::Number(number) => {
                        worksheet
                            .write_number_with_format(
                                (row_index + 1) as u32,
                                column as u16,
                                number.as_f64().unwrap_or(0.0),
                                if key.to_lowercase().contains("ratio") { &percent_format } else { &number_format },
                            )
                            .map_err(xlsx_err)?;
                    }
                    _ => {
                        worksheet
                            .write_string((row_index + 1) as u32, column as u16, localized_text(key, value))
                            .map_err(xlsx_err)?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn write_filtered_sheet(
    workbook: &mut Workbook,
    name: &str,
    value: Option<&Value>,
    prefix: &str,
) -> Result<(), AppError> {
    let rows = value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|row| {
                    let mut output = Map::new();
                    if let Some(object) = row.as_object() {
                        for (key, value) in object {
                            if [
                                "entity",
                                "account",
                                "currency",
                                "functionalCurrency",
                                "sourceRow",
                            ]
                            .contains(&key.as_str())
                                || key.starts_with(prefix)
                            {
                                output.insert(key.clone(), value.clone());
                            }
                        }
                    }
                    Value::Object(output)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    write_value_array_sheet(workbook, name, Some(&Value::Array(rows)))
}

fn json_text(value: &Value) -> String {
    let text = match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    };
    if text.chars().count() > 32_000 {
        let mut shortened = text.chars().take(31_950).collect::<String>();
        shortened.push_str("…[内容超出Excel单元格上限，完整明细见对应明细页]");
        shortened
    } else {
        text
    }
}

fn chinese_header(key: &str) -> &str {
    match key {
        "account" => "科目", "accountRoles" => "科目角色", "amount" => "金额",
        "automaticMeasuredFxGainLoss" => "自动测算合计",
        "auditClosingFunctional" => "审计月末本位币余额", "auditFxGainLoss" => "审计测算汇兑损益",
        "auditGainLoss" => "审计已实现汇兑损益", "auxiliary" => "辅助核算",
        "bookedFxGainLoss" => "账面汇兑损益",
        "carryingFunctional" => "终止确认账面本位币价值", "cashRequired" => "现金是否为必要条件",
        "classification" => "分类", "clientRevaluationExcluded" => "已识别客户重估金额",
        "closingAuditFunctional" => "年末审计本位币余额", "closingBookFunctional" => "年末账面本位币余额",
        "closingDifference" => "年末重估差异", "closingForeign" => "年末原币余额",
        "closingRate" => "年末汇率", "confidence" => "置信度", "counterEvidence" => "反向证据",
        "coverageDifference" => "覆盖勾稽差异", "coveredBookFxGainLoss" => "自动测算覆盖的账面汇兑损益",
        "currency" => "币种", "date" => "日期", "detail" => "说明", "difference" => "测算与TB差异",
        "differenceRatio" => "差异率", "entity" => "公司/核算主体", "eventType" => "事件类型",
        "evidence" => "识别证据", "excludedTransferRows" => "剔除损益结转行数",
        "foreignMovement" => "原币变动", "functionalCurrency" => "本位币",
        "inferredForeign" => "倒算原币余额", "jeFxGainLossAfterTransferExclusion" => "JE剔除损益结转后汇兑损益",
        "jeTbDifference" => "JE与TB差异", "lowConfidenceEvents" => "低置信度事件数",
        "matchedRules" => "命中规则", "measurementDifference" => "自动测算金额差异", "method" => "测算方法", "mode" => "测算模式",
        "needsZeroResultReview" => "零结果是否需要复核",
        "monthEnd" => "月末/重估日期", "nonRevaluationFunctionalMovement" => "非重估本位币变动",
        "officialRate" => "官方汇率", "openingAuditFunctional" => "年初审计本位币余额",
        "openingBookFunctional" => "年初账面本位币余额", "openingDifference" => "年初重估差异",
        "openingForeign" => "年初原币余额", "openingRate" => "年初汇率",
        "pendingReviewAmount" => "待复核项目账面金额", "pendingReviewCount" => "待复核项目数",
        "postRevaluationFunctional" => "重估后本位币余额", "preRevaluationFunctional" => "重估前本位币余额",
        "publishedDate" => "汇率公布日期", "realizedEvents" => "已实现测算事件数",
        "realizedGainLoss" => "已实现汇兑损益", "realizedScore" => "已实现得分",
        "reconciliationPassed" => "勾稽是否通过", "requestedDate" => "请求日期",
        "responseHash" => "汇率响应哈希", "reviewReason" => "待复核原因", "role" => "科目角色", "ruleConflict" => "规则冲突",
        "scheme" => "金额口径", "settlementForeign" => "结算原币金额", "severity" => "严重程度",
        "source" => "来源/识别方式", "sourceRow" => "源文件行号", "suggestedAdjustment" => "建议调整",
        "summary" => "摘要", "tbClosingFunctional" => "TB年末本位币余额",
        "tbFxGainLoss" => "TB汇兑损益发生额", "tbReconciliationDifference" => "TB勾稽差异",
        "tbRows" => "TB汇兑损益取数明细", "translatedFunctional" => "按官方汇率折算本位币",
        "twoPointChange" => "两时点差异变化", "type" => "异常/检查类型",
        "unrealizedAdjustment" => "未实现汇兑损益", "unrealizedGainLoss" => "未实现汇兑损益",
        "unrealizedRows" => "未实现测算行数", "unrealizedScore" => "未实现得分",
        "voucherId" => "凭证匹配ID", "openingPublishedDate" => "年初汇率公布日期",
        "fxAccounts" => "汇兑损益科目", "currencies" => "涉及币种",
        "calculationType" => "测算类型", "bookAmount" => "测算前账面金额", "auditAmount" => "审计测算金额",
        "gainLoss" => "汇兑损益", "included" => "是否纳入汇总", "note" => "备注",
        "closingPublishedDate" => "年末汇率公布日期", "fetchedAt" => "汇率抓取时间",
        "sourceUrl" => "汇率来源网址", "startDate" => "汇率快照开始日", "endDate" => "汇率快照结束日",
        "rates" => "汇率明细", "missing" => "缺失币种/日期", "cnyPerUnit" => "每单位外币折合人民币",
        "functionalAmount" => "本位币净额", "foreignAmount" => "原币净额", "foreignDirection" => "原币借贷方向",
        "id" => "凭证识别字段", "voucherType" => "凭证类型", "date" => "记账日期", "account" => "科目编码/名称",
        "currency" => "交易币种", "openingFunctionalDebit" => "年初本位币借方余额",
        "openingFunctionalCredit" => "年初本位币贷方余额", "closingFunctionalDebit" => "年末本位币借方余额",
        "closingFunctionalCredit" => "年末本位币贷方余额", "periodFunctionalDebit" => "本期本位币借方发生额",
        "periodFunctionalCredit" => "本期本位币贷方发生额", _ => key,
    }
}

fn localized_text(_key: &str, value: &Value) -> String {
    fn localize(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(object.iter().map(|(key, value)| {
                (chinese_header(key).to_owned(), localize(value))
            }).collect()),
            Value::Array(values) => Value::Array(values.iter().map(localize).collect()),
            Value::String(text) => Value::String(localized_scalar(text).to_owned()),
            Value::Bool(value) => Value::String(if *value { "是" } else { "否" }.to_owned()),
            _ => value.clone(),
        }
    }
    match value {
        Value::String(text) => localized_scalar(text).to_owned(),
        _ => json_text(&localize(value)),
    }
}

fn localized_scalar(value: &str) -> &str {
    match value {
        "realized" => "仅已实现", "unrealized" => "仅未实现", "combined" => "已实现＋未实现",
        "cash" => "外币现金及银行", "monetary_asset" => "货币性资产",
        "monetary_liability" => "货币性负债", "fx_gain_loss" => "汇兑损益",
        "non_monetary" => "非货币性项目", "excluded" => "排除项目", "review" => "待确认",
        "unassigned" => "未分配", "true" => "是", "false" => "否", _ => value,
    }
}

fn xlsx_err(value: XlsxError) -> AppError {
    error(
        "OUTPUT_WRITE_FAILED",
        "无法写入审计底稿。",
        Some(value.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real_sample_params(output_path: Option<&Path>) -> Value {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let mut params = json!({
            "mode": "combined",
            "reportStart": "2024-01-01",
            "reportEnd": "2024-12-31",
            "fixedEntity": "真实样例公司",
            "entityCurrencies": {"真实样例公司": "CNY"},
            "jeSource": {"inputPath": root.join("序时账-1.xlsx"), "sheet":"UFPrn20250110180715", "headerRow":1, "headerDepth":1},
            "tbSource": {"inputPath": root.join("科目余额表.xls"), "sheet":"UFPrn20250110184259", "headerRow":1, "headerDepth":1},
            "jeMapping": {
                "id":["凭证号数"], "date":"日期", "account":["科目编码","科目名称"],
                "currency":"币种", "summary":"摘要", "foreignAmount":"原币",
                "foreignDirection":"方向", "functionalAmount":"借正贷负"
            },
            "tbMapping": {
                "account":["科目编码","科目名称"],
                "openingFunctionalDebit":"期初余额借方", "openingFunctionalCredit":"期初余额贷方",
                "closingFunctionalDebit":"期末余额借方", "closingFunctionalCredit":"期末余额贷方",
                "periodFunctionalDebit":"本期发生借方", "periodFunctionalCredit":"本期发生贷方"
            }
        });
        if let Some(path) = output_path {
            params["outputPath"] = json!(path);
        }
        params
    }

    fn candidate_has(value: &Value, role: &str, column: &str) -> bool {
        value["mappingCandidates"].as_array().is_some_and(|roles| roles.iter().any(|item| {
            item["role"] == role && item["candidates"].as_array().is_some_and(|items| {
                items.iter().any(|candidate| candidate["column"] == column)
            })
        }))
    }

    #[test]
    fn strict_numeric_never_turns_invalid_into_zero() {
        assert_eq!(strict_number("(1,234.50)").unwrap(), Some(-1234.5));
        assert_eq!(strict_number("123-").unwrap(), Some(-123.0));
        assert!(strict_number("12x").is_err());
        assert_eq!(strict_number("—").unwrap(), None);
    }

    #[test]
    fn two_level_headers_are_combined() {
        let raw = vec![
            vec!["期初余额".into(), "".into(), "期末余额".into(), "".into()],
            vec![
                "原币".into(),
                "本位币".into(),
                "原币".into(),
                "本位币".into(),
            ],
        ];
        assert_eq!(
            merge_headers(&raw, 4),
            vec![
                "期初余额-原币",
                "期初余额-本位币",
                "期末余额-原币",
                "期末余额-本位币"
            ]
        );
    }

    #[test]
    fn voucher_key_uses_entity_date_and_all_ids() {
        let row = RowRecord {
            source_row: 2,
            values: HashMap::from([
                ("公司".into(), "A".into()),
                ("日期".into(), "2025-01-02".into()),
                ("凭证".into(), "9".into()),
                ("类型".into(), "记".into()),
            ]),
        };
        let mapping = Map::from_iter([
            ("entity".into(), json!("公司")),
            ("date".into(), json!("日期")),
            ("id".into(), json!(["类型", "凭证"])),
        ]);
        assert_eq!(
            display_voucher_id(&voucher_id(&row, &mapping, &json!({"fixedEntity": "E"}))),
            "A-2025-01-02-记-9"
        );
    }

    #[test]
    fn safe_html_rates_are_parsed() {
        let html = r#"<tr class="first"><td>2025-12-31</td><td>702.88</td><td>-</td></tr>"#;
        let rows = parse_safe_html(html);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1[0], Some(702.88));
        assert_eq!(rows[0].1[1], None);
    }

    #[test]
    fn amount_schemes_are_mutually_complete() {
        let mapping = Map::from_iter([
            ("foreignDebit".into(), json!("借")),
            ("foreignCredit".into(), json!("贷")),
        ]);
        assert!(amount_scheme_ok(&mapping, "foreign"));
        let bad = Map::from_iter([
            ("foreignAmount".into(), json!("金额")),
            ("foreignDebit".into(), json!("借")),
            ("foreignCredit".into(), json!("贷")),
        ]);
        assert!(!amount_scheme_ok(&bad, "foreign"));
    }

    #[test]
    fn account_code_inherits_non_unassigned_role_from_tb_description() {
        let params = json!({"accountRoles":{
            "707000":"unassigned",
            "707000 Cur Remeasur G/L-Sys":"fx_gain_loss",
            "111201 FX Val-A/R Trade":"monetary_asset"
        }});
        assert_eq!(role_for("707000", &params), "fx_gain_loss");
        assert_eq!(role_for("111201", &params), "monetary_asset");
        assert_eq!(suggest_account_role("200011 FX Val-A/P Trade"), "monetary_liability");
    }

    #[test]
    fn exported_headers_and_roles_are_chinese() {
        assert_eq!(chinese_header("auditFxGainLoss"), "审计测算汇兑损益");
        assert_eq!(chinese_header("periodFunctionalDebit"), "本期本位币借方发生额");
        assert_eq!(localized_scalar("fx_gain_loss"), "汇兑损益");
        assert_eq!(localized_scalar("combined"), "已实现＋未实现");
    }

    #[test]
    #[ignore = "uses the user's immutable real JE/TB sample and official rate service"]
    fn real_sample_runs_through_fx_tool_and_exports_reconciled_workpaper() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        assert!(root.join("序时账-1.xlsx").is_file());
        assert!(root.join("科目余额表.xls").is_file());
        let source_hash = |path: &Path| hex::encode(Sha256::digest(fs::read(path).unwrap()));
        let je_hash = source_hash(&root.join("序时账-1.xlsx"));
        let tb_hash = source_hash(&root.join("科目余额表.xls"));

        let je = inspect(&json!({"source": real_sample_params(None)["jeSource"]}), "je").unwrap();
        let tb = inspect(&json!({"source": real_sample_params(None)["tbSource"]}), "tb").unwrap();
        assert_eq!(je["headerRow"], 1);
        assert_eq!(tb["headerRow"], 1);
        assert_eq!(je["dataYears"], json!([2024]));
        assert_eq!(tb["dataYears"], json!([2024]));
        assert!(candidate_has(&je, "foreignAmount", "原币"));
        assert!(candidate_has(&je, "functionalAmount", "借正贷负"));
        assert!(candidate_has(&tb, "periodFunctionalDebit", "本期发生借方"));
        let suggested_je = je["suggestedMapping"].as_object().unwrap();
        assert_eq!(suggested_je.get("id"), Some(&json!("凭证号数")));
        assert_eq!(suggested_je.get("date"), Some(&json!("日期")));
        assert_eq!(suggested_je.get("currency"), Some(&json!("币种")));
        assert_eq!(suggested_je.get("foreignAmount"), Some(&json!("原币")));
        assert_eq!(suggested_je.get("functionalAmount"), Some(&json!("借正贷负")));
        assert_eq!(tb.pointer("/suggestedMapping/openingFunctionalDebit"), Some(&json!("期初余额借方")));
        assert_eq!(tb.pointer("/suggestedMapping/openingFunctionalCredit"), Some(&json!("期初余额贷方")));
        assert_eq!(tb.pointer("/suggestedMapping/closingFunctionalDebit"), Some(&json!("期末余额借方")));
        assert_eq!(tb.pointer("/suggestedMapping/closingFunctionalCredit"), Some(&json!("期末余额贷方")));
        let mut auto_params = real_sample_params(None);
        auto_params["jeMapping"] = je["suggestedMapping"].clone();
        auto_params["tbMapping"] = tb["suggestedMapping"].clone();
        let auto_validation = validate_mapping(&auto_params).unwrap();
        assert_eq!(auto_validation["valid"], true, "自动映射必须直接通过后端校验：{auto_validation:#}");
        auto_params["reportStart"] = json!("2025-01-01");
        auto_params["reportEnd"] = json!("2025-12-31");
        let wrong_year = validate_mapping(&auto_params).unwrap();
        assert_eq!(wrong_year["valid"], false);
        assert!(wrong_year["errors"].as_array().unwrap().iter().any(|message|
            message.as_str().is_some_and(|text| text.contains("但JE数据期间为2024年"))));

        let output = root.join("测试输出").join("汇兑损益真实样例验证_中文版.xlsx");
        let params = real_sample_params(Some(&output));
        let validation = validate_mapping(&params).unwrap();
        assert_eq!(validation["valid"], true, "{validation:#}");
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = calculate(&params, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        assert_eq!(result.pointer("/reconciliation/excludedTransferRows"), Some(&json!(12)));
        assert!((result.pointer("/reconciliation/tbFxGainLoss").and_then(Value::as_f64).unwrap() + 164800.85).abs() < 0.01);
        assert!((result.pointer("/reconciliation/jeFxGainLossAfterTransferExclusion").and_then(Value::as_f64).unwrap() + 164800.85).abs() < 0.01);
        assert!((result.pointer("/summary/auditFxGainLoss").and_then(Value::as_f64).unwrap() + 164800.85).abs() < 0.01);
        assert!(result.pointer("/summary/difference").and_then(Value::as_f64).unwrap().abs() < 0.01);
        assert_eq!(result.pointer("/summary/reconciliationPassed"), Some(&json!(true)), "summary={:#}\nquality={:#}\nunrealized={:#}", result["summary"], result["dataQuality"], result["unrealized"]);
        export_workbook(&params, &result).unwrap();
        assert!(output.is_file());
        assert_eq!(source_hash(&root.join("序时账-1.xlsx")), je_hash);
        assert_eq!(source_hash(&root.join("科目余额表.xls")), tb_hash);
    }

    #[test]
    #[ignore = "uses the user's immutable SAP JE/TB customer samples"]
    fn sap_customer_samples_auto_select_sheet_and_map_required_fields() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../汇兑损益测试资料");
        let je = inspect(&json!({"source": {
            "inputPath": root.join("JE+YTD+OCT.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}), "je").unwrap();
        let je_class = classify_source(&json!({"source": {
            "inputPath": root.join("JE+YTD+OCT.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }})).unwrap();
        assert_eq!(je_class["kind"], "je");
        assert_eq!(je_class["needsLlm"], false);
        assert_eq!(je["sheet"], "Sheet1 (2)");
        assert_eq!(je["headerRow"], 1);
        assert_eq!(je["suggestedBalanceSheetDate"], "2025-10-31", "date sample={}", je["preview"][0][6]);
        assert!(je.pointer("/suggestedMapping/entity").is_none(), "币值金额列不能误识别为公司字段");
        assert_eq!(je.pointer("/suggestedMapping/id"), Some(&json!("Document Number")));
        assert_eq!(je.pointer("/suggestedMapping/date"), Some(&json!("Posting Date")));
        assert_eq!(je.pointer("/suggestedMapping/account"), Some(&json!(["G/L Account"])));
        assert_eq!(je.pointer("/suggestedMapping/currency"), Some(&json!("Document Currency Key")));
        assert_eq!(je.pointer("/suggestedMapping/foreignAmount"), Some(&json!("Document Currency Value")));
        assert_eq!(je.pointer("/suggestedMapping/functionalAmount"), Some(&json!("Company Code Currency Value")));

        let tb = inspect(&json!({"source": {
            "inputPath": root.join("Oct+BS+PL+TB.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }}), "tb").unwrap();
        let tb_class = classify_source(&json!({"source": {
            "inputPath": root.join("Oct+BS+PL+TB.xlsx"), "sheet":"", "headerRow":0, "headerDepth":0
        }})).unwrap();
        assert_eq!(tb_class["kind"], "tb");
        assert_eq!(tb_class["needsLlm"], false);
        assert_eq!(tb["sheet"], "TB");
        assert_eq!(tb["headerRow"], 13);
        assert_eq!(tb.pointer("/suggestedMapping/entity"), Some(&json!("Company Code")));
        assert_eq!(tb.pointer("/suggestedMapping/account"), Some(&json!(["GL Account", "GL Description"])));
        assert_eq!(tb.pointer("/suggestedMapping/closingFunctionalAmount"), Some(&json!("YTD Act (Local Curr)")));
        let mut account_roles = Map::new();
        for account in je["accounts"].as_array().into_iter().flatten()
            .chain(tb["accounts"].as_array().into_iter().flatten())
            .filter_map(Value::as_str) {
            account_roles.insert(account.to_owned(), json!(suggest_account_role(account)));
        }
        let output = root.join("汇兑损益SAP客户样例_根因修复验证.xlsx");
        let mut params = json!({
            "mode":"combined", "reportStart":"2025-01-01", "reportEnd":"2025-10-31",
            "fixedEntity":"KL", "entityCurrencies":{"KL":"CNY"},
            "jeSource":{"inputPath":root.join("JE+YTD+OCT.xlsx"),"sheet":je["sheet"],"headerRow":je["headerRow"],"headerDepth":je["headerDepth"]},
            "tbSource":{"inputPath":root.join("Oct+BS+PL+TB.xlsx"),"sheet":tb["sheet"],"headerRow":tb["headerRow"],"headerDepth":tb["headerDepth"]},
            "jeMapping":je["suggestedMapping"], "tbMapping":tb["suggestedMapping"],
            "accountRoles": account_roles, "outputPath": output
        });
        // 模拟LLM把SAP单月MTD误放入一个单边发生额字段。后端仍必须优先
        // 使用已成立的YTD累计净额方案，不能让单边建议改写TB对比口径。
        params["tbMapping"]["periodFunctionalDebit"] = json!("MTD Local Curr");
        let validation = validate_mapping(&params).unwrap();
        assert_eq!(validation["valid"], true, "SAP客户样例的自动映射应可直接进入测算：{validation:#}");
        let reconciliation = reconcile_fx_gain_loss(&params).unwrap();
        assert!((reconciliation["tbFxGainLoss"].as_f64().unwrap() - 2_663_591.50).abs() < 0.01, "{reconciliation:#}");
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let result = calculate(&params, &|_, _, _, _| {}, &cancel, &pause).unwrap();
        assert_ne!(result.pointer("/summary/auditFxGainLoss").and_then(Value::as_f64).unwrap_or(0.0), 0.0, "{:#}", result["summary"]);
        assert!(result.pointer("/summary/unrealizedRows").and_then(Value::as_u64).unwrap_or(0) > 0, "{:#}", result["summary"]);
        let summary = &result["summary"];
        let automatic = summary["automaticMeasuredFxGainLoss"].as_f64().unwrap();
        let pending = summary["pendingReviewAmount"].as_f64().unwrap();
        let provisional = summary["auditFxGainLoss"].as_f64().unwrap();
        let covered_book = summary["coveredBookFxGainLoss"].as_f64().unwrap();
        assert!(summary["pendingReviewCount"].as_u64().unwrap() > 0, "{summary:#}");
        assert!((provisional - automatic - pending).abs() < 0.01, "{summary:#}");
        assert!((covered_book + pending - 2_663_591.50).abs() < 0.01, "{summary:#}");
        assert!(result.pointer("/reconciliation/coverageDifference")
            .and_then(Value::as_f64).unwrap_or(f64::INFINITY).abs() < 0.01, "{:#}", result["reconciliation"]);
        assert!(summary["differenceRatio"].as_f64().unwrap_or(f64::INFINITY) < 0.05,
            "真实样例测算差异率必须低于5%：{summary:#}");
        assert_eq!(summary["reconciliationPassed"], true, "{summary:#}");
        export_workbook(&params, &result).unwrap();
        assert!(output.is_file());
    }
}
