use calamine::{Data, Reader, Sheets, open_workbook_auto};
use chrono::Local;
use directories::ProjectDirs;
use polars::prelude::*;
use rust_xlsxwriter::{
    ConditionalFormatFormula, Format, FormatAlign, FormatBorder, Workbook, Worksheet,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;
use crate::ledger_mapping;
use crate::ledger_mapping::{SignConvention, SignEvidence, header_index, normalize_name};

const TS_MAX_PIVOT_COLUMN_VALUES: usize = 180;

pub(crate) type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

#[derive(Debug, Clone)]
struct Table {
    path: PathBuf,
    sheet: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    sheets: Vec<String>,
    encoding: Option<String>,
    delimiter: Option<char>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceParams {
    input_path: String,
    sheet: Option<String>,
    #[serde(default = "one")]
    header_row: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterSpec {
    field: String,
    #[serde(default)]
    values: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsJobParams {
    input_path: String,
    sheet: Option<String>,
    #[serde(default = "one")]
    header_row: usize,
    output_path: Option<String>,
    #[serde(default)]
    filters: Vec<FilterSpec>,
    pivot_mode: Option<String>,
    #[serde(default)]
    row_fields: Vec<String>,
    column_field: Option<String>,
    value_field: Option<String>,
    agg: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LedgerMapping {
    #[serde(default)]
    pub(crate) id: Vec<String>,
    /// 科目编码列。与科目名称拆成两个独立角色，跟汇兑损益、存款利息、借款利息
    /// 共用的统一映射内核同口径——`会计科目` 这类编码列不该再顶着「科目名称」的名字。
    #[serde(default)]
    pub(crate) account_code: Option<String>,
    /// 科目名称列，可多列（科目名称一级＋二级这种层级拆分）。
    #[serde(default)]
    pub(crate) account_name: Vec<String>,
    /// 旧版把编码与名称混在一个 `account` 数组里。老草稿、老参数仍可能带它，
    /// 这里照收，统一由 [`LedgerMapping::account_columns`] 兜底。
    #[serde(default, rename = "account", skip_serializing_if = "Vec::is_empty")]
    pub(crate) legacy_account: Vec<String>,
    pub(crate) entity: Option<String>,
    pub(crate) date: Option<String>,
    pub(crate) summary: Option<String>,
    /// 线上名统一到内核的标准角色名，Rust 字段名保持简写不动——
    /// 28 处引用不用跟着改，`alias` 让历史保存的旧参数仍能读。
    #[serde(rename = "functionalAmount", alias = "amount")]
    pub(crate) amount: Option<String>,
    pub(crate) direction: Option<String>,
    #[serde(rename = "functionalDebit", alias = "debit")]
    pub(crate) debit: Option<String>,
    #[serde(rename = "functionalCredit", alias = "credit")]
    pub(crate) credit: Option<String>,
}

impl LedgerMapping {
    /// 组成科目键的列，顺序固定：**编码在前、名称在后**。下游按这个顺序用 `-`
    /// 把几列拼成一个科目值，顺序一变，用户已经选好的目标科目就全部对不上。
    /// 前端 `accountColumns` 必须保持同序。
    pub(crate) fn account_columns(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for value in self
            .account_code
            .as_deref()
            .into_iter()
            .chain(self.account_name.iter().map(String::as_str))
            .chain(self.legacy_account.iter().map(String::as_str))
        {
            let value = value.trim();
            if !value.is_empty() && !out.contains(&value) {
                out.push(value);
            }
        }
        out
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KanzhangParams {
    input_path: String,
    sheet: Option<String>,
    #[serde(default = "one")]
    header_row: usize,
    output_path: Option<String>,
    output_dir: Option<String>,
    mapping: Option<LedgerMapping>,
    #[serde(default)]
    target_accounts: Vec<String>,
    #[serde(default)]
    exclude_accounts: Vec<String>,
    #[serde(default)]
    include_pivot: bool,
    #[serde(default)]
    target_batches: Vec<LedgerBatch>,
    #[serde(default = "default_true")]
    mark_loss_transfer: bool,
    #[serde(default = "default_true")]
    include_voucher_types: bool,
    #[serde(default)]
    pivot_rows: Vec<String>,
    #[serde(default)]
    pivot_columns: Vec<String>,
    /// 透视的值字段。留空沿用净额，与旧版默认一致；填列名则按该列取数，
    /// 可多选。旧版允许把任意列拖进值字段，迁移时被写死成了净额。
    #[serde(default)]
    pivot_values: Vec<String>,
    #[serde(default = "default_true")]
    llm_analysis: bool,
    #[serde(default, rename = "__settings")]
    settings: Value,
    #[serde(default = "default_excel_chunk")]
    rows_per_sheet: usize,
}

fn one() -> usize {
    1
}
fn default_true() -> bool {
    true
}
fn default_excel_chunk() -> usize {
    900_000
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerBatch {
    name: String,
    #[serde(default)]
    accounts: Vec<String>,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "ts.inspect" => inspect_ts(params),
        "ts.filter" => ts_filter_values(params),
        "cache.stat" => cache_stat(params),
        "cache.clear" => cache_clear(params),
        "cache.sweep" => cache_sweep(params),
        "kanzhang.inspect" => inspect_kanzhang(params),
        "kanzhang.accounts" => kanzhang_account_values(params),
        "kanzhang.column_values" => kanzhang_column_values(params),
        "kanzhang.map" => validate_kanzhang_mapping(params),
        "kanzhang.mark_sign_report" => je_mark_sign_report(params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust Polars 表格方法。",
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
    let result = match method {
        // 读取阶段现在也走任务通道，才能报进度、才能中途取消。
        "ts.inspect" => {
            progress("read", 0, 1, "正在读取文件…");
            let value = inspect_ts(params);
            check_cancel(&cancel)?;
            value
        }
        "kanzhang.inspect" => {
            progress("read", 0, 1, "正在读取凭证文件…");
            let value = inspect_kanzhang(params);
            check_cancel(&cancel)?;
            value
        }
        "ts.cache" => cache_ts(params, progress, &cancel),
        "ts.filter" => ts_filter_preview(params, progress, &cancel),
        "ts.pivot" | "ts.export" => export_ts(params, progress, &cancel),
        "kanzhang.map" => validate_kanzhang_mapping(params),
        "kanzhang.filter" => kanzhang_filter_preview(params, progress, &cancel),
        "kanzhang.pivot" | "kanzhang.export" => export_kanzhang(params, progress, &cancel),
        // 正负数智能标记：读取与看账同一实现，只是要走自己的 toolId 才能被本页收到。
        "kanzhang.mark_inspect" => {
            progress("read", 0, 1, "正在读取凭证文件…");
            let value = inspect_kanzhang(params);
            check_cancel(&cancel)?;
            value
        }
        "kanzhang.mark_export" => export_je_mark(params, progress, &cancel),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust Polars 表格任务。",
            Some(method.into()),
        )),
    };
    pause.wait()?;
    result
}

fn inspect_ts(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params, "TS 参数不完整。")?;
    let started = Instant::now();
    // Populate the stable parquet cache on the very first read.  Loading
    // without it meant the same workbook was parsed from scratch again for the
    // filter values and once more for the export — three full reads of a file
    // that is often on a network share.
    let (table, cache_hit, cache) = load_ts_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
        true,
    )?;
    let defaults = ts_defaults(&table.headers);
    Ok(json!({
        "engine":"rust-polars", "sourceFingerprint":fingerprint(&table.path, &table.sheet, source.header_row)?,
        "path":table.path, "sheets":table.sheets, "selectedSheet":table.sheet,
        "headers":table.headers, "preview":table.rows.iter().take(20).collect::<Vec<_>>(),
        "dimensions":{"rows":table.rows.len(),"columns":table.headers.len()},
        "encoding":table.encoding, "delimiter":table.delimiter.map(|v|v.to_string()),
        "defaults":defaults, "cacheHit":cache_hit, "cachePath":cache,
        "timings":{"readMs":started.elapsed().as_millis()}
    }))
}

fn inspect_kanzhang(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params, "看账参数不完整。")?;
    let started = Instant::now();
    let table = load_ledger_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
    )?;
    let mapping = suggest_mapping(&table.headers, &table.rows);
    let (accounts, account_codes, account_count) = (!mapping.account_columns().is_empty())
        .then(|| {
            let (values, codes, total) = account_values(&table, &mapping, "", &[]);
            (
                values.into_iter().take(500).collect::<Vec<_>>(),
                codes.into_iter().take(500).collect::<Vec<_>>(),
                total,
            )
        })
        .unwrap_or_default();
    Ok(json!({
        "engine":"rust-polars", "sourceFingerprint":fingerprint(&table.path, &table.sheet, source.header_row)?,
        "path":table.path, "sheets":table.sheets, "selectedSheet":table.sheet,
        "headers":table.headers, "preview":table.rows.iter().take(50).collect::<Vec<_>>(),
        "dimensions":{"rows":table.rows.len(),"columns":table.headers.len()},
        "encoding":table.encoding, "delimiter":table.delimiter.map(|v|v.to_string()),
        "suggestedMapping":mapping, "accounts":accounts, "accountCodes":account_codes,
        "accountCount":account_count, "timings":{"readMs":started.elapsed().as_millis()}
    }))
}

fn kanzhang_account_values(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params.clone(), "看账参数不完整。")?;
    let table = load_ledger_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
    )?;
    let mapping: LedgerMapping = params
        .get("mapping")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| {
            error(
                "INVALID_MAPPING",
                "字段映射格式不正确。",
                Some(e.to_string()),
            )
        })?
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    if mapping.account_columns().is_empty() {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "请先确认科目编码或科目名称字段映射。",
            None,
        ));
    }
    let keyword = params.get("keyword").and_then(Value::as_str).unwrap_or("");
    // 按科目编码前缀批量筛选：`6401,6603` 选出这两段下的全部明细科目。
    let prefixes = parse_code_prefixes(
        params
            .get("codePrefixes")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(1_000)
        .clamp(1, 20_000) as usize;
    let (values, codes, total) = account_values(&table, &mapping, keyword, &prefixes);
    let primary_names = primary_account_names(&table, &mapping, &values);
    // 预设批次需要在一次点击中覆盖全部唯一科目；普通列表仍保留 20,000 的保护上限。
    let all = params.get("all").and_then(Value::as_bool).unwrap_or(false);
    let take = if all { total } else { limit };
    Ok(json!({
        "engine":"rust-polars",
        "values":values.into_iter().take(take).collect::<Vec<_>>(),
        // 与 values 同序一一对应，供前端按编码段做本地前缀匹配。
        "codes":codes.into_iter().take(take).collect::<Vec<_>>(),
        "primaryNames":primary_names.into_iter().take(take).collect::<Vec<_>>(),
        "total":total,
        "truncated":total>take,
    }))
}

/// 与显示科目一一对应的一级科目名称。多级名称映射时取第一列；只有一列时
/// 仍把原值交给前端，再由前端按常见层级分隔符取一级名称。
fn primary_account_names(table: &Table, mapping: &LedgerMapping, values: &[String]) -> Vec<String> {
    let indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let primary_index = mapping
        .account_name
        .first()
        .and_then(|name| header_index(&table.headers, name));
    let mut names = HashMap::<String, String>::new();
    if let Some(primary_index) = primary_index {
        for row in &table.rows {
            let value = joined_account(row, &indexes);
            if value.trim().is_empty() {
                continue;
            }
            let primary = row
                .get(primary_index)
                .map(|value| value.trim().to_owned())
                .unwrap_or_default();
            names.entry(value).or_insert(primary);
        }
    }
    values
        .iter()
        .map(|value| names.get(value).cloned().unwrap_or_default())
        .collect()
}

fn validate_kanzhang_mapping(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params.clone(), "看账参数不完整。")?;
    let table = load_ledger_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
    )?;
    let mapping = params
        .get("mapping")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| {
            error(
                "INVALID_MAPPING",
                "字段映射格式不正确。",
                Some(e.to_string()),
            )
        })?
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    // 必填走统一判定：金标身份槽 ∪ 看账自己声明的角色 ∪ 金额形态槽。
    let mut missing: Vec<&str> = crate::ledger_mapping::missing_required(
        crate::ledger_mapping::Tool::Ledger,
        "je",
        &mapped_roles(&mapping),
    )
    .into_iter()
    .map(|item| item.label)
    .collect();
    let scheme = if mapping.debit.is_some() && mapping.credit.is_some() {
        "debit_credit_columns"
    } else if mapping.amount.is_some() {
        "amount_direction"
    } else {
        "unknown"
    };
    if scheme == "unknown" && !missing.iter().any(|m| m.contains("金额")) {
        missing.push("金额字段");
    }
    let amount_issues = ledger_amount_parse_issues(&table, &mapping);
    let mapped = mapping_columns(&mapping);
    let unknown = mapped
        .into_iter()
        .filter(|name| header_index(&table.headers, name).is_none())
        .collect::<Vec<_>>();
    Ok(
        json!({"engine":"rust-polars","valid":missing.is_empty()&&unknown.is_empty()&&amount_issues.is_empty(),"scheme":scheme,"missing":missing,"unknownColumns":unknown,"amountIssues":amount_issues,"normalizedMapping":mapping}),
    )
}

/// 符号口径检测报告：导出前把结论与依据亮给用户，映射变更后可随时重查。
/// 与导出走同一套预处理和检测，保证「看到的口径 = 实际采用的口径」。
fn je_mark_sign_report(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params.clone(), "看账参数不完整。")?;
    let table = load_ledger_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
    )?;
    let mapping = params
        .get("mapping")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| {
            error(
                "INVALID_MAPPING",
                "字段映射格式不正确。",
                Some(e.to_string()),
            )
        })?
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    let table = preprocess_ledger(table, &mapping, None)?;
    let id_indexes = ledger_id_indexes(&table.headers, &mapping);
    let report = detect_sign_convention(&table.rows, &table.headers, &mapping, &id_indexes);
    Ok(json!({
        "engine":"rust-polars",
        "signConvention":serde_json::to_value(&report).unwrap_or_default(),
    }))
}

fn ts_filter_values(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params.clone(), "TS 参数不完整。")?;
    let field = required_string(&params, "field")?;
    let keyword = params
        .get("keyword")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(1_000)
        .min(20_000) as usize;
    let (table, cache_hit, _) = load_ts_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
        true,
    )?;
    let index = header_index(&table.headers, &field)
        .ok_or_else(|| error("COLUMN_NOT_FOUND", "筛选字段不存在。", Some(field.clone())))?;
    let mut values = BTreeSet::new();
    for row in &table.rows {
        let value = row.get(index).cloned().unwrap_or_default();
        if keyword.is_empty() || value.to_lowercase().contains(&keyword) {
            values.insert(if value.is_empty() {
                "<空白>".into()
            } else {
                value
            });
        }
    }
    let total = values.len();
    Ok(
        json!({"engine":"rust-polars","values":values.into_iter().take(limit).collect::<Vec<_>>(),"total":total,"truncated":total>limit,"cacheHit":cache_hit}),
    )
}

fn cache_ts(params: Value, progress: Progress<'_>, cancel: &AtomicBool) -> Result<Value, AppError> {
    let source: SourceParams = parse(params, "TS 参数不完整。")?;
    progress("read", 0, 3, "正在读取 Timesheet 数据…");
    check_cancel(cancel)?;
    let (table, cache_hit, cache) = load_ts_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
        false,
    )?;
    if cache_hit {
        progress("cache", 3, 3, "已命中稳定 Parquet 缓存。");
        return Ok(
            json!({"engine":"rust-polars","cachePath":cache,"cacheHit":true,"rows":table.rows.len(),"columns":table.headers.len(),"outputPaths":[]}),
        );
    }
    progress("convert", 1, 3, "正在转换为 Rust Polars 列式数据…");
    let mut frame = table_to_frame(&table)?;
    check_cancel(cancel)?;
    progress("cache", 2, 3, "正在写入稳定 Parquet 缓存…");
    write_frame_cache(&cache, &mut frame)?;
    Ok(
        json!({"engine":"rust-polars","cachePath":cache,"cacheHit":false,"rows":frame.height(),"columns":frame.width(),"outputPaths":[]}),
    )
}

fn ts_filter_preview(
    params: Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let job: TsJobParams = parse(params, "TS 参数不完整。")?;
    progress("read", 0, 2, "正在读取 Timesheet 数据…");
    let (table, cache_hit, _) = load_ts_cached(
        Path::new(&job.input_path),
        job.sheet.as_deref(),
        job.header_row,
        true,
    )?;
    check_cancel(cancel)?;
    let rows = apply_filters(&table, &job.filters);
    let frame = rows_to_frame(&table.headers, &rows)?;
    progress("filter", 2, 2, "筛选完成。");
    Ok(
        json!({"engine":"rust-polars","rows":frame.height(),"columns":frame.width(),"headers":frame.get_column_names().iter().map(|v|v.as_str()).collect::<Vec<_>>(),"preview":rows.iter().take(50).collect::<Vec<_>>(),"cacheHit":cache_hit,"outputPaths":[]}),
    )
}

fn export_ts(
    params: Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let job: TsJobParams = parse(params, "TS 参数不完整。")?;
    let selected_output = job
        .output_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| error("TS_OUTPUT_REQUIRED", "请选择 TS 导出文件的保存路径。", None))?;
    let total_started = Instant::now();
    progress("read", 0, 5, "正在读取 Timesheet 数据…");
    let (table, cache_hit, cache) = load_ts_cached(
        Path::new(&job.input_path),
        job.sheet.as_deref(),
        job.header_row,
        true,
    )?;
    check_cancel(cancel)?;
    let filtered = apply_filters(&table, &job.filters);
    progress("polars", 1, 5, "Rust Polars 正在计算透视结果…");
    let defaults = ts_defaults(&table.headers);
    let value_field = job
        .value_field
        .clone()
        .filter(|v| header_index(&table.headers, v).is_some())
        .or_else(|| {
            defaults
                .get("valueField")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            error(
                "TS_VALUE_FIELD_MISSING",
                "未找到可用于汇总的工时字段。",
                None,
            )
        })?;
    let column_field = job
        .column_field
        .clone()
        .filter(|v| header_index(&table.headers, v).is_some())
        .or_else(|| {
            defaults
                .get("columnField")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let manager_fields = string_array(defaults.get("managerRowFields"));
    let project_fields = string_array(defaults.get("projectRowFields"));
    let agg = job.agg.as_deref().unwrap_or("sum");
    let mode = job.pivot_mode.as_deref().unwrap_or("dual_default");
    let (manager, project) = if mode == "custom" && !job.row_fields.is_empty() {
        (
            pivot_rows(
                &table.headers,
                &filtered,
                &job.row_fields,
                column_field.as_deref(),
                &value_field,
                agg,
            )?,
            None,
        )
    } else if mode == "manager" {
        (
            pivot_rows(
                &table.headers,
                &filtered,
                &manager_fields,
                column_field.as_deref(),
                &value_field,
                agg,
            )?,
            None,
        )
    } else if mode == "project" {
        (
            pivot_rows(
                &table.headers,
                &filtered,
                &project_fields,
                column_field.as_deref(),
                &value_field,
                agg,
            )?,
            None,
        )
    } else {
        (
            pivot_rows(
                &table.headers,
                &filtered,
                &manager_fields,
                column_field.as_deref(),
                &value_field,
                agg,
            )?,
            Some(pivot_rows(
                &table.headers,
                &filtered,
                &project_fields,
                column_field.as_deref(),
                &value_field,
                agg,
            )?),
        )
    };
    check_cancel(cancel)?;
    let output = output_path(
        &job.input_path,
        Some(selected_output),
        "Timesheet_Default_Dual",
        "xlsx",
    )?;
    let partial = partial_path(&output);
    progress("write", 3, 5, "正在写出 Timesheet 透视工作簿…");
    write_ts_workbook(&partial, &manager, project.as_ref(), agg, cancel)?;
    replace_file(&partial, &output)?;
    let mut outputs = vec![output.to_string_lossy().into_owned()];
    progress("raw", 4, 5, "正在写出对应明细数据…");
    let raw = output.with_file_name(format!(
        "{}_data.csv",
        output.file_stem().unwrap_or_default().to_string_lossy()
    ));
    write_csv_table(&raw, &table.headers, &filtered, cancel)?;
    let raw_rows = filtered.len();
    outputs.push(raw.to_string_lossy().into_owned());
    Ok(
        json!({"engine":"rust-polars","outputPaths":outputs,"rowsManager":manager.rows.len(),"rowsProject":project.as_ref().map(|p|p.rows.len()).unwrap_or(0),"rawRows":raw_rows,"cacheHit":cache_hit,"cachePath":cache,"timings":{"totalMs":total_started.elapsed().as_millis()}}),
    )
}

fn kanzhang_filter_preview(
    params: Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let job: KanzhangParams = parse(params, "看账参数不完整。")?;
    progress("read", 0, 3, "正在读取凭证数据…");
    let table = load_ledger_cached(
        Path::new(&job.input_path),
        job.sheet.as_deref(),
        job.header_row,
    )?;
    let mapping = job
        .mapping
        .clone()
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    validate_mapping_required(&mapping)?;
    validate_ledger_amounts(&table, &mapping, job.header_row)?;
    let table = preprocess_ledger(table, &mapping, None)?;
    check_cancel(cancel)?;
    progress("filter", 1, 3, "Rust Polars 正在筛选目标科目和完整凭证…");
    let filtered = filter_ledger_rows(
        &table,
        &mapping,
        &job.target_accounts,
        &job.exclude_accounts,
    )?;
    let frame = rows_to_frame(&table.headers, &filtered)?;
    Ok(
        json!({"engine":"rust-polars","rows":frame.height(),"columns":frame.width(),"mapping":mapping,"preview":filtered.iter().take(50).collect::<Vec<_>>(),"outputPaths":[]}),
    )
}

fn export_kanzhang(
    params: Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let job: KanzhangParams = parse(params, "看账参数不完整。")?;
    let started = Instant::now();
    progress("read", 0, 6, "正在读取凭证数据…");
    let table = load_ledger_cached(
        Path::new(&job.input_path),
        job.sheet.as_deref(),
        job.header_row,
    )?;
    let mapping = job
        .mapping
        .clone()
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    validate_mapping_required(&mapping)?;
    validate_ledger_amounts(&table, &mapping, job.header_row)?;
    let table = preprocess_ledger(table, &mapping, None)?;
    check_cancel(cancel)?;
    let batches = normalized_batches(&job);
    let mut outputs = Vec::new();
    let mut batch_results = Vec::new();
    for (batch_index, batch) in batches.iter().enumerate() {
        check_cancel(cancel)?;
        progress(
            "normalize",
            1,
            6,
            &format!("正在处理批次 {}：{}…", batch_index + 1, batch.name),
        );
        let filtered =
            filter_ledger_rows(&table, &mapping, &batch.accounts, &job.exclude_accounts)?;
        progress("polars", 2, 6, "Rust Polars 正在生成凭证、科目及月份汇总…");
        let analysis = analyze_ledger(&table, &mapping, &filtered, &batch.accounts, &job, cancel)?;
        progress("classify", 4, 6, "正在识别凭证类型、JE 匹配和损益结转…");
        let output = kanzhang_batch_output_path(&job, batch, batch_index, batches.len())?;
        progress(
            "write",
            5,
            6,
            &format!("正在写出批次 {}：{}…", batch_index + 1, batch.name),
        );
        let batch_outputs = if output
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("csv"))
        {
            write_kanzhang_csv_suite(
                &output,
                &analysis,
                job.include_pivot,
                job.include_voucher_types,
                job.rows_per_sheet,
                cancel,
            )?
        } else {
            write_kanzhang_xlsx_suite(
                &output,
                &analysis,
                job.include_pivot,
                job.include_voucher_types,
                job.rows_per_sheet,
                cancel,
            )?
        };
        outputs.extend(
            batch_outputs
                .iter()
                .map(|path| path.to_string_lossy().into_owned()),
        );
        batch_results.push(json!({
            "name":batch.name,
            "accounts":batch.accounts,
            "rows":analysis.rows.len(),
            "excludedRows":analysis.excluded_rows.len(),
            "summaryRows":analysis.summary.rows.len(),
            "voucherRows":analysis.voucher_pivot.rows.len(),
            "voucherTypesLoose":analysis.voucher_type_loose.rows.len(),
            "voucherTypesStrict":analysis.voucher_type_strict.rows.len(),
            "lossTransferVouchers":analysis.loss_count
        }));
    }
    Ok(json!({
        "engine":"rust-polars",
        "outputPaths":outputs,
        "batchCount":batches.len(),
        "batches":batch_results,
        "mapping":mapping,
        "timings":{"totalMs":started.elapsed().as_millis()}
    }))
}

#[derive(Debug)]
struct PivotResult {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    row_field_count: usize,
}

#[derive(Debug)]
struct LedgerAnalysis {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    excluded_headers: Vec<String>,
    excluded_rows: Vec<Vec<String>>,
    summary: PivotResult,
    voucher_pivot: PivotResult,
    voucher_type_loose: PivotResult,
    voucher_type_strict: PivotResult,
    custom_pivot: Option<PivotResult>,
    llm_analysis: Option<Value>,
    /// 本批次的目标科目清单，写进隐藏 `_targets` 页——旧版靠它记录
    /// 「这份底稿是按哪些科目筛的」，同时给条件格式的 COUNTIF 当比对区域。
    target_accounts: Vec<String>,
    /// 科目名称、金额（借贷或金额列）在原表里的列名，用于版式里定位列号。
    account_headers: Vec<String>,
    amount_headers: Vec<String>,
    loss_count: usize,
    je_pairs: usize,
    je_cross_pairs: usize,
}

#[derive(Debug, Clone)]
struct VoucherInfo {
    id: String,
    /// 整张凭证每个科目的净额，**不做零值过滤**——旧版汇总同类凭证时也保留净额为 0 的
    /// 科目行，只有「净额和所有月份都为 0」才在最后一步丢掉。
    account_nets: BTreeMap<String, f64>,
    /// 参与归类的科目集合：净额四舍五入到 2 位后仍非零的科目（旧版口径）。
    nonzero_accounts: BTreeSet<String>,
    /// 非零目标科目 -> 符号（+1 / -1）。归类时只比这些科目的方向。
    target_signs: BTreeMap<String, i8>,
    summaries: Vec<String>,
    month_nets: BTreeMap<String, BTreeMap<String, f64>>,
}

#[derive(Debug)]
struct LedgerAmounts {
    net: Vec<f64>,
    allow_cross_match: bool,
}

fn pivot_rows(
    headers: &[String],
    rows: &[Vec<String>],
    row_fields: &[String],
    column_field: Option<&str>,
    value_field: &str,
    agg: &str,
) -> Result<PivotResult, AppError> {
    if !matches!(agg, "sum" | "count") {
        return Err(error(
            "TS_AGG_INVALID",
            "汇总方式仅支持 sum 或 count。",
            Some(agg.to_owned()),
        ));
    }
    let row_indexes = row_fields
        .iter()
        .filter_map(|name| header_index(headers, name).map(|index| (name.clone(), index)))
        .collect::<Vec<_>>();
    if row_indexes.is_empty() {
        return Err(error(
            "TS_ROW_FIELDS_MISSING",
            "没有找到有效的透视行字段。",
            None,
        ));
    }
    let value_index = header_index(headers, value_field).ok_or_else(|| {
        error(
            "COLUMN_NOT_FOUND",
            "值字段不存在。",
            Some(value_field.into()),
        )
    })?;
    let column_index = column_field.and_then(|name| header_index(headers, name));
    let mut group_columns = row_indexes
        .iter()
        .map(|(_, index)| *index)
        .collect::<Vec<_>>();
    if let Some(index) = column_index {
        group_columns.push(index);
    }
    let mut columns = Vec::new();
    for (position, (_, index)) in row_indexes.iter().enumerate() {
        columns.push(Column::new(
            format!("__row_{position}").into(),
            rows.iter()
                .map(|row| row.get(*index).cloned().unwrap_or_default())
                .collect::<Vec<_>>(),
        ));
    }
    if let Some(index) = column_index {
        columns.push(Column::new(
            "__pivot".into(),
            rows.iter()
                .map(|row| row.get(index).cloned().unwrap_or_default())
                .collect::<Vec<_>>(),
        ));
    }
    let metrics = rows
        .iter()
        .map(|row| {
            let value = row.get(value_index).map(String::as_str).unwrap_or("");
            if agg == "count" {
                if value.trim().is_empty() { 0.0 } else { 1.0 }
            } else {
                parse_number(value)
            }
        })
        .collect::<Vec<_>>();
    columns.push(Column::new("__metric".into(), metrics));
    let frame = DataFrame::new(rows.len(), columns).map_err(polars_error)?;
    let mut group_exprs = (0..row_indexes.len())
        .map(|i| col(format!("__row_{i}")))
        .collect::<Vec<_>>();
    if column_index.is_some() {
        group_exprs.push(col("__pivot"));
    }
    let grouped = frame
        .lazy()
        .group_by(group_exprs)
        .agg([col("__metric").sum().alias("__value")])
        .collect()
        .map_err(polars_error)?;
    let mut pivot_values = BTreeSet::new();
    let mut values = BTreeMap::<Vec<String>, BTreeMap<String, f64>>::new();
    for row_index in 0..grouped.height() {
        let row = grouped.get_row(row_index).map_err(polars_error)?;
        let key = row
            .0
            .iter()
            .take(row_indexes.len())
            .map(any_to_string)
            .collect::<Vec<_>>();
        let pivot = if column_index.is_some() {
            any_to_string(&row.0[row_indexes.len()])
        } else {
            value_field.to_owned()
        };
        let metric = row.0.last().map(any_to_f64).unwrap_or(0.0);
        pivot_values.insert(if pivot.is_empty() {
            "<空白>".into()
        } else {
            pivot.clone()
        });
        values.entry(key).or_default().insert(
            if pivot.is_empty() {
                "<空白>".into()
            } else {
                pivot
            },
            metric,
        );
    }
    if pivot_values.len() > TS_MAX_PIVOT_COLUMN_VALUES {
        return Err(error(
            "TS_PIVOT_TOO_WIDE",
            format!(
                "透视列字段去重值超过 {}，请先筛选后重试。",
                TS_MAX_PIVOT_COLUMN_VALUES
            ),
            Some(pivot_values.len().to_string()),
        ));
    }
    let pivot_values = pivot_values.into_iter().collect::<Vec<_>>();
    let mut output_headers = row_indexes
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    output_headers.extend(pivot_values.clone());
    let output_rows = values
        .into_iter()
        .map(|(mut key, map)| {
            key.extend(
                pivot_values
                    .iter()
                    .map(|name| format_number(*map.get(name).unwrap_or(&0.0))),
            );
            key
        })
        .collect();
    Ok(PivotResult {
        headers: output_headers,
        rows: output_rows,
        row_field_count: row_indexes.len(),
    })
}

fn ledger_summary_from_amounts(
    rows: &[Vec<String>],
    account_indexes: &[usize],
    amounts: &[f64],
) -> Result<PivotResult, AppError> {
    let mut columns = vec![Column::new(
        "account".into(),
        rows.iter()
            .map(|row| joined_account(row, account_indexes))
            .collect::<Vec<_>>(),
    )];
    columns.push(Column::new("amount".into(), amounts.to_vec()));
    let frame = DataFrame::new(rows.len(), columns).map_err(polars_error)?;
    let grouped = frame
        .lazy()
        .group_by([col("account")])
        .agg([
            col("amount").sum().alias("netAmount"),
            len().alias("lineCount"),
        ])
        .collect()
        .map_err(polars_error)?;
    let mut output: Vec<Vec<String>> = Vec::new();
    for index in 0..grouped.height() {
        let row = grouped.get_row(index).map_err(polars_error)?;
        output.push(row.0.iter().map(any_to_string).collect());
    }
    output.sort_by(|a, b| a.first().cmp(&b.first()));
    Ok(PivotResult {
        headers: vec!["科目名称".into(), "净额".into(), "行数".into()],
        rows: output,
        row_field_count: 1,
    })
}

fn filter_ledger_rows(
    table: &Table,
    mapping: &LedgerMapping,
    targets: &[String],
    excludes: &[String],
) -> Result<Vec<Vec<String>>, AppError> {
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let mut id_indexes = Vec::new();
    for optional in [mapping.entity.as_deref(), mapping.date.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(index) = header_index(&table.headers, optional) {
            id_indexes.push(index);
        }
    }
    id_indexes.extend(
        mapping
            .id
            .iter()
            .filter_map(|name| header_index(&table.headers, name)),
    );
    if account_indexes.is_empty() || id_indexes.is_empty() {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "请先确认凭证编号和科目字段映射。",
            None,
        ));
    }
    let target_set = targets
        .iter()
        .map(|v| normalize_account_text(v))
        .filter(|v| !v.is_empty())
        .collect::<HashSet<_>>();
    // 与旧版一致：剔除科目仅生成独立“剔除明细”，不得从命中目标科目的
    // 完整凭证中删行。否则凭证会失衡，且对方科目/凭证类型会失真。
    let _exclude_set = excludes
        .iter()
        .map(|v| normalize_account_text(v))
        .filter(|v| !v.is_empty())
        .collect::<HashSet<_>>();
    let mut target_ids = HashSet::new();
    if !target_set.is_empty() {
        for row in &table.rows {
            if row_matches_accounts(row, &account_indexes, &target_set) {
                target_ids.insert(voucher_key(row, &id_indexes));
            }
        }
    }
    let result = table
        .rows
        .iter()
        .filter(|row| {
            let included =
                target_set.is_empty() || target_ids.contains(&voucher_key(row, &id_indexes));
            included
        })
        .cloned()
        .collect();
    Ok(result)
}

fn excluded_ledger_rows(
    table: &Table,
    mapping: &LedgerMapping,
    excludes: &[String],
) -> Vec<Vec<String>> {
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let exclude_set = excludes
        .iter()
        .map(|value| normalize_account_text(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    if account_indexes.is_empty() || exclude_set.is_empty() {
        return Vec::new();
    }
    table
        .rows
        .iter()
        .filter(|row| row_matches_accounts(row, &account_indexes, &exclude_set))
        .cloned()
        .collect()
}

fn preprocess_ledger(
    mut table: Table,
    mapping: &LedgerMapping,
    sign_override: Option<SignConvention>,
) -> Result<Table, AppError> {
    let id_indexes = ledger_id_indexes(&table.headers, mapping);
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let amount_indexes = [
        mapping.amount.as_deref(),
        mapping.debit.as_deref(),
        mapping.credit.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(|name| header_index(&table.headers, name))
    .collect::<HashSet<_>>();
    let mapped_indexes = mapping_columns(mapping)
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let fill_indexes = mapped_indexes
        .iter()
        .copied()
        .filter(|index| !amount_indexes.contains(index))
        .collect::<Vec<_>>();
    let fill_columns = fill_indexes
        .iter()
        .filter_map(|index| table.headers.get(*index).cloned())
        .collect::<Vec<_>>();
    ledger_mapping::forward_fill_columns(&table.headers, &mut table.rows, &fill_columns);
    let mut prepared = Vec::<(Vec<String>, bool)>::new();
    for row in table.rows {
        let had_amount = amount_indexes.iter().any(|index| {
            row.get(*index)
                .is_some_and(|value| !value.trim().is_empty())
        });
        let candidate = had_amount
            && id_indexes
                .iter()
                .chain(account_indexes.iter())
                .any(|index| row.get(*index).is_none_or(|value| value.trim().is_empty()));
        let has_mapped = mapped_indexes.iter().any(|index| {
            row.get(*index)
                .is_some_and(|value| !value.trim().is_empty())
        });
        let ids_complete = !id_indexes.is_empty()
            && id_indexes.iter().all(|index| {
                row.get(*index)
                    .is_some_and(|value| !value.trim().is_empty())
            });
        let amount_present = amount_indexes.iter().any(|index| {
            row.get(*index)
                .is_some_and(|value| !value.trim().is_empty())
        });
        if has_mapped && (ids_complete || amount_present) {
            prepared.push((row, candidate));
        }
    }
    let rows = prepared
        .iter()
        .map(|(row, _)| row.clone())
        .collect::<Vec<_>>();
    let amounts = ledger_amounts(&rows, &table.headers, mapping, &id_indexes, sign_override);
    let mut balance = HashMap::<String, f64>::new();
    for (row, amount) in rows.iter().zip(amounts.net.iter()) {
        *balance.entry(voucher_key(row, &id_indexes)).or_default() += *amount;
    }
    table.rows = prepared
        .into_iter()
        .filter_map(|(row, candidate)| {
            let imbalanced = balance
                .get(&voucher_key(&row, &id_indexes))
                .is_some_and(|amount| amount.abs() > 0.01);
            if candidate && imbalanced {
                None
            } else {
                Some(row)
            }
        })
        .collect();
    Ok(table)
}

fn normalized_batches(job: &KanzhangParams) -> Vec<LedgerBatch> {
    let mut batches = job
        .target_batches
        .iter()
        .filter_map(|batch| {
            let name = batch.name.trim();
            let accounts = dedup_strings(&batch.accounts);
            if name.is_empty() || accounts.is_empty() {
                None
            } else {
                Some(LedgerBatch {
                    name: name.to_owned(),
                    accounts,
                })
            }
        })
        .collect::<Vec<_>>();
    if batches.is_empty() {
        batches.push(LedgerBatch {
            name: "批次1".into(),
            accounts: dedup_strings(&job.target_accounts),
        });
    }
    batches
}

fn analyze_ledger(
    table: &Table,
    mapping: &LedgerMapping,
    rows: &[Vec<String>],
    targets: &[String],
    job: &KanzhangParams,
    cancel: &AtomicBool,
) -> Result<LedgerAnalysis, AppError> {
    let id_indexes = ledger_id_indexes(&table.headers, mapping);
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    if id_indexes.is_empty() || account_indexes.is_empty() {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "无法构造凭证唯一识别码或科目字段。",
            None,
        ));
    }
    let target_set = targets
        .iter()
        .map(|value| normalize_account_text(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let amounts = ledger_amounts(rows, &table.headers, mapping, &id_indexes, None);
    let loss_ids = if job.mark_loss_transfer {
        detect_loss_transfer_ids(rows, &id_indexes, &account_indexes)
    } else {
        HashSet::new()
    };
    let excluded_rows = excluded_ledger_rows(table, mapping, &job.exclude_accounts);

    // 旧版把辅助列放在最前面，原始列在后；迁移版原来追加在末尾，
    // 用户打开导出文件第一眼看到的东西完全不同。
    // 绝对值/符号/智能匹配状态三列已随正负数智能标记一并移出本工具。
    let mut headers = Vec::with_capacity(table.headers.len() + 1);
    if job.mark_loss_transfer {
        headers.push("【损益结转】".into());
    }
    headers.extend(table.headers.iter().cloned());
    let mut enriched = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        if index % 2_000 == 0 {
            check_cancel(cancel)?;
        }
        let key = voucher_key(row, &id_indexes);
        let mut output = Vec::with_capacity(headers.len());
        if job.mark_loss_transfer {
            output.push(if loss_ids.contains(&key) {
                "损益结转".into()
            } else {
                String::new()
            });
        }
        output.extend(row.iter().cloned());
        enriched.push(output);
    }
    let excluded_headers = table.headers.clone();
    let summary = ledger_summary_from_amounts(rows, &account_indexes, &amounts.net)?;
    let key_label = voucher_key_label(&table.headers, &id_indexes);
    let voucher_pivot = build_voucher_pivot_rust(
        rows,
        &amounts.net,
        &table.headers,
        mapping,
        &id_indexes,
        &account_indexes,
        &key_label,
    )?;
    let infos = voucher_infos(
        rows,
        &table.headers,
        &amounts.net,
        mapping,
        &id_indexes,
        &account_indexes,
        &target_set,
        &loss_ids,
    );
    let voucher_type_loose = build_voucher_type_rows(&infos, false, &key_label);
    let voucher_type_strict = build_voucher_type_rows(&infos, true, &key_label);
    let pivot_values = ledger_pivot_values(table, rows, &amounts.net, &job.pivot_values);
    let custom_pivot = build_custom_ledger_pivot(
        table,
        rows,
        &pivot_values,
        mapping,
        &job.pivot_rows,
        &job.pivot_columns,
        &loss_ids,
    )?;
    let llm_analysis = if job.llm_analysis
        && job
            .settings
            .get("llm")
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        let payload = json!({"targetAccounts":targets,"subjectSummary":{"headers":&summary.headers,"rows":summary.rows.iter().take(40).collect::<Vec<_>>()},"voucherTypesStrict":{"headers":&voucher_type_strict.headers,"rows":voucher_type_strict.rows.iter().take(80).collect::<Vec<_>>()},"voucherTypesLoose":{"headers":&voucher_type_loose.headers,"rows":voucher_type_loose.rows.iter().take(40).collect::<Vec<_>>()},"customPivot":custom_pivot.as_ref().map(|pivot|json!({"headers":&pivot.headers,"rows":pivot.rows.iter().take(80).collect::<Vec<_>>() }))});
        crate::audipick::kanzhang_llm_call(
            &json!({"mode":"analysis","payload":payload}),
            &job.settings,
        )
        .ok()
    } else {
        None
    };
    Ok(LedgerAnalysis {
        headers,
        rows: enriched,
        excluded_headers,
        excluded_rows,
        summary,
        voucher_pivot,
        voucher_type_loose,
        voucher_type_strict,
        custom_pivot,
        llm_analysis,
        // 用原始科目名而不是 target_set 里归一化过的小写值——`_targets` 的 A 列是给人看的。
        target_accounts: {
            let mut values = targets
                .iter()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            values.sort();
            values.dedup();
            values
        },
        account_headers: mapping
            .account_columns()
            .into_iter()
            .map(str::to_owned)
            .collect(),
        amount_headers: [
            mapping.amount.as_deref(),
            mapping.debit.as_deref(),
            mapping.credit.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect(),
        loss_count: loss_ids.len(),
        // 对冲配对属于正负数智能标记，看账不再统计。
        je_pairs: 0,
        je_cross_pairs: 0,
    })
}

fn ledger_id_indexes(headers: &[String], mapping: &LedgerMapping) -> Vec<usize> {
    let mut indexes = Vec::new();
    for optional in [mapping.entity.as_deref(), mapping.date.as_deref()]
        .into_iter()
        .flatten()
    {
        if let Some(index) = header_index(headers, optional) {
            indexes.push(index);
        }
    }
    indexes.extend(
        mapping
            .id
            .iter()
            .filter_map(|name| header_index(headers, name)),
    );
    let mut seen = HashSet::new();
    indexes
        .into_iter()
        .filter(|index| seen.insert(*index))
        .collect()
}

pub(crate) fn detect_loss_transfer_ids(
    rows: &[Vec<String>],
    id_indexes: &[usize],
    account_indexes: &[usize],
) -> HashSet<String> {
    rows.iter()
        .filter(|row| {
            account_indexes.iter().any(|index| {
                let value = row.get(*index).map(String::as_str).unwrap_or("");
                value.contains("本年利润") || value.contains("未分配利润")
            })
        })
        .map(|row| voucher_key(row, id_indexes))
        .collect()
}

fn match_je_rows(
    rows: &[Vec<String>],
    headers: &[String],
    amounts: &LedgerAmounts,
    mapping: &LedgerMapping,
    id_indexes: &[usize],
    account_indexes: &[usize],
    target_set: &HashSet<String>,
    loss_ids: &HashSet<String>,
    cancel: &AtomicBool,
) -> Result<(Vec<String>, usize, usize), AppError> {
    let entity_index = mapping
        .entity
        .as_deref()
        .and_then(|name| header_index(headers, name));
    let mut status = vec!["未匹配".to_owned(); rows.len()];
    let eligible = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            if loss_ids.contains(&voucher_key(row, id_indexes)) {
                return None;
            }
            let account = joined_account(row, account_indexes);
            if !target_set.is_empty() && !target_set.contains(&normalize_account_text(&account)) {
                return None;
            }
            // 直接配对与符号列、跨行匹配同用净额口径：已匹配行的借贷净额必须为 0。
            // 旧口径（贷方记正数）会把"贷方结转"和"借方红字冲销"这类同向减少的
            // 行配成一对，两行净额同号，筛"已匹配"后净额不为零。
            let amount = round_money(amounts.net.get(index).copied().unwrap_or(0.0));
            if amount == 0 {
                return None;
            }
            let entity = entity_index
                .and_then(|i| row.get(i))
                .cloned()
                .unwrap_or_default();
            Some((index, account, entity, amount))
        })
        .collect::<Vec<_>>();

    let mut direct = BTreeMap::<(String, String, i64), (Vec<usize>, Vec<usize>)>::new();
    for (position, (index, account, entity, amount)) in eligible.iter().enumerate() {
        if position % 2_000 == 0 {
            check_cancel(cancel)?;
        }
        let entry = direct
            .entry((
                normalize_account_text(account),
                entity.trim().to_owned(),
                amount.abs(),
            ))
            .or_default();
        if *amount > 0 {
            entry.0.push(*index);
        } else {
            entry.1.push(*index);
        }
    }
    let mut direct_pairs = 0;
    for (_, (positive, negative)) in direct {
        let pairs = positive.len().min(negative.len());
        for index in positive.into_iter().take(pairs) {
            status[index] = "已匹配-计提".into();
        }
        for index in negative.into_iter().take(pairs) {
            status[index] = "已匹配-冲销".into();
        }
        direct_pairs += pairs;
    }

    let mut grouped = BTreeMap::<(String, String), BTreeMap<String, (i64, Vec<usize>)>>::new();
    for (index, account, entity, _amount) in eligible {
        if status[index] != "未匹配" {
            continue;
        }
        let voucher = voucher_key(&rows[index], id_indexes);
        let entry = grouped
            .entry((normalize_account_text(&account), entity.trim().to_owned()))
            .or_default()
            .entry(voucher)
            .or_insert_with(|| (0, Vec::new()));
        entry.0 += round_money(amounts.net.get(index).copied().unwrap_or(0.0));
        entry.1.push(index);
    }
    let mut cross_pairs = 0;
    if amounts.allow_cross_match {
        for (_, vouchers) in grouped {
            let mut positive = BTreeMap::<i64, Vec<(String, Vec<usize>)>>::new();
            let mut negative = BTreeMap::<i64, Vec<(String, Vec<usize>)>>::new();
            for (id, (amount, indexes)) in vouchers {
                if amount > 0 {
                    positive.entry(amount).or_default().push((id, indexes));
                } else if amount < 0 {
                    negative.entry(-amount).or_default().push((id, indexes));
                }
            }
            for (amount, positives) in positive {
                let negatives = negative.remove(&amount).unwrap_or_default();
                let pairs = positives.len().min(negatives.len());
                for pair in 0..pairs {
                    for index in &positives[pair].1 {
                        status[*index] = "跨行已匹配-计提".into();
                    }
                    for index in &negatives[pair].1 {
                        status[*index] = "跨行已匹配-冲销".into();
                    }
                }
                cross_pairs += pairs;
            }
        }
    }
    // Rows outside the target scope and loss-transfer vouchers never participate.
    let eligible_indexes = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            if loss_ids.contains(&voucher_key(row, id_indexes)) {
                return None;
            }
            let account = joined_account(row, account_indexes);
            if !target_set.is_empty() && !target_set.contains(&normalize_account_text(&account)) {
                None
            } else {
                Some(index)
            }
        })
        .collect::<HashSet<_>>();
    for (index, value) in status.iter_mut().enumerate() {
        if !eligible_indexes.contains(&index) {
            *value = String::new();
        }
    }
    Ok((status, direct_pairs, cross_pairs))
}

/// 固定资产 TB+JE 模式复用的公共视图。这里只是把「正负数智能标记」
/// 已有的金额规范化和 `match_je_rows` 暴露给其他业务模块，不另写匹配规则。
#[derive(Debug)]
pub(crate) struct NetZeroView {
    pub(crate) net: Vec<f64>,
    pub(crate) status: Vec<String>,
    pub(crate) direct_pairs: usize,
    pub(crate) cross_pairs: usize,
    pub(crate) sign_basis: String,
}

pub(crate) fn net_zero_view(
    rows: &[Vec<String>],
    headers: &[String],
    mapping: &LedgerMapping,
    targets: &[String],
    cancel: &AtomicBool,
) -> Result<NetZeroView, AppError> {
    validate_mapping_required(mapping)?;
    let id_indexes = ledger_id_indexes(headers, mapping);
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(headers, name))
        .collect::<Vec<_>>();
    let report = detect_sign_convention(rows, headers, mapping, &id_indexes);
    let convention = report.detected_convention().ok_or_else(|| {
        error(
            "AMOUNT_SCHEME_UNDETERMINED",
            format!("无法自动判断序时账金额记法：{}", report.basis),
            None,
        )
    })?;
    let amounts = ledger_amounts(rows, headers, mapping, &id_indexes, Some(convention));
    let target_set = targets
        .iter()
        .map(|value| normalize_account_text(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let (status, direct_pairs, cross_pairs) = match_je_rows(
        rows,
        headers,
        &amounts,
        mapping,
        &id_indexes,
        &account_indexes,
        &target_set,
        &HashSet::new(),
        cancel,
    )?;
    Ok(NetZeroView {
        net: amounts.net,
        status,
        direct_pairs,
        cross_pairs,
        sign_basis: report.basis,
    })
}

/// 与看账输出完全相同的凭证键和科目键，避免 FA 业务层自行拼接。
pub(crate) fn ledger_row_keys(
    rows: &[Vec<String>],
    headers: &[String],
    mapping: &LedgerMapping,
) -> (Vec<String>, Vec<String>) {
    let id_indexes = ledger_id_indexes(headers, mapping);
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(headers, name))
        .collect::<Vec<_>>();
    (
        rows.iter()
            .map(|row| voucher_key(row, &id_indexes))
            .collect(),
        rows.iter()
            .map(|row| joined_account(row, &account_indexes))
            .collect(),
    )
}

fn voucher_infos(
    rows: &[Vec<String>],
    headers: &[String],
    amounts: &[f64],
    mapping: &LedgerMapping,
    id_indexes: &[usize],
    account_indexes: &[usize],
    targets: &HashSet<String>,
    loss_ids: &HashSet<String>,
) -> Vec<VoucherInfo> {
    // 凭证按「在底稿里第一次出现」的顺序排列，不能用 BTreeMap 的字典序：
    // 旧版的归类是两阶段并查集，谁先出现谁就当基准组的种子，顺序会直接改变归并结果。
    let mut order = Vec::<String>::new();
    let mut voucher_keys = Vec::new();
    let mut account_keys = Vec::new();
    let mut kept_amounts = Vec::new();
    let mut seen = HashSet::new();
    let mut summaries = HashMap::<String, Vec<String>>::new();
    let mut month_nets = HashMap::<String, BTreeMap<String, BTreeMap<String, f64>>>::new();
    let summary_index = mapping
        .summary
        .as_deref()
        .and_then(|name| header_index(headers, name));
    let date_index = mapping
        .date
        .as_deref()
        .and_then(|name| header_index(headers, name));
    for (row, amount) in rows.iter().zip(amounts.iter()) {
        let id = voucher_key(row, id_indexes);
        if loss_ids.contains(&id) {
            continue;
        }
        let account = joined_account(row, account_indexes);
        if seen.insert(id.clone()) {
            order.push(id.clone());
        }
        voucher_keys.push(id.clone());
        account_keys.push(account.clone());
        kept_amounts.push(*amount);
        if let Some(index) = summary_index {
            let value = row.get(index).map(|value| value.trim()).unwrap_or("");
            let bucket = summaries.entry(id.clone()).or_default();
            if !value.is_empty() && !bucket.iter().any(|existing| existing == value) {
                bucket.push(value.to_owned());
            }
        }
        if let Some(month) = date_index
            .and_then(|index| row.get(index))
            .and_then(|value| parse_month(value))
        {
            *month_nets
                .entry(id.clone())
                .or_default()
                .entry(month)
                .or_default()
                .entry(account)
                .or_default() += *amount;
        }
    }
    let mut vouchers = voucher_account_nets(&voucher_keys, &account_keys, &kept_amounts);
    order
        .into_iter()
        .filter_map(|id| {
            let account_nets = vouchers.remove(&id)?;
            // 归类只看「净额四舍五入到 2 位后仍非零」的科目；净额为 0 的科目不进集合，
            // 也不算方向，但它的明细行仍然要留给下游汇总。
            let mut nonzero_accounts = BTreeSet::new();
            let mut target_signs = BTreeMap::new();
            for (account, amount) in &account_nets {
                let rounded = round_to_cent(*amount);
                if rounded == 0.0 {
                    continue;
                }
                nonzero_accounts.insert(account.clone());
                if targets.contains(&normalize_account_text(account)) {
                    target_signs.insert(account.clone(), if rounded > 0.0 { 1i8 } else { -1i8 });
                }
            }
            // 凭证类型只分析命中目标科目的凭证：没有目标科目的凭证即使被完整凭证筛选带进来，
            // 也不能参与归并，否则会出现「类型里没有目标科目」的行。
            if target_signs.is_empty() {
                return None;
            }
            let info_summaries = summaries.remove(&id).unwrap_or_default();
            let info_months = month_nets.remove(&id).unwrap_or_default();
            Some(VoucherInfo {
                id,
                account_nets,
                nonzero_accounts,
                target_signs,
                summaries: info_summaries,
                month_nets: info_months,
            })
        })
        .collect()
}

/// 看账与固定资产共用的完整凭证逐科目净额。保留零净额，保持输入累加顺序。
pub(crate) fn voucher_account_nets(
    voucher_keys: &[String],
    account_keys: &[String],
    amounts: &[f64],
) -> HashMap<String, BTreeMap<String, f64>> {
    let mut vouchers = HashMap::<String, BTreeMap<String, f64>>::new();
    for ((id, account), amount) in voucher_keys.iter().zip(account_keys).zip(amounts) {
        *vouchers
            .entry(id.clone())
            .or_default()
            .entry(account.clone())
            .or_default() += *amount;
    }
    vouchers
}

fn build_voucher_pivot_rust(
    rows: &[Vec<String>],
    amounts: &[f64],
    headers: &[String],
    mapping: &LedgerMapping,
    id_indexes: &[usize],
    account_indexes: &[usize],
    key_label: &str,
) -> Result<PivotResult, AppError> {
    // 旧版在“金额 + 方向”方案下会把方向展开为列（如“借 / 贷”），
    // 只有借贷分列或无方向列时才输出单列净额。这张隐藏中间表同时是
    // 凭证类型的人工复核底稿，不能因为净额合计一样就丢掉方向维度。
    if let Some(direction_index) = mapping
        .direction
        .as_deref()
        .and_then(|name| header_index(headers, name))
    {
        let mut directions = BTreeSet::new();
        let mut values = BTreeMap::<(String, String, String), f64>::new();
        let mut row_keys = BTreeSet::<(String, String)>::new();
        for (row, amount) in rows.iter().zip(amounts.iter()) {
            let direction = row
                .get(direction_index)
                .map(|value| value.trim())
                .unwrap_or("")
                .to_owned();
            if direction.is_empty() {
                continue;
            }
            let id = voucher_key(row, id_indexes);
            let account = joined_account(row, account_indexes);
            directions.insert(direction.clone());
            row_keys.insert((id.clone(), account.clone()));
            *values.entry((id, account, direction)).or_default() += *amount;
        }
        if !directions.is_empty() {
            let directions = directions.into_iter().collect::<Vec<_>>();
            let output = row_keys
                .into_iter()
                .map(|(id, account)| {
                    let mut output = vec![display_voucher_key(&id), account.clone()];
                    output.extend(directions.iter().map(|direction| {
                        format_number(
                            (values
                                .get(&(id.clone(), account.clone(), direction.clone()))
                                .copied()
                                .unwrap_or_default()
                                * 100.0)
                                .round()
                                / 100.0,
                        )
                    }));
                    output
                })
                .collect();
            let mut output_headers = vec![key_label.to_owned(), "科目名称".into()];
            output_headers.extend(directions);
            return Ok(PivotResult {
                headers: output_headers,
                rows: output,
                row_field_count: 2,
            });
        }
    }
    let mut values = BTreeMap::<(String, String), f64>::new();
    for (row, amount) in rows.iter().zip(amounts.iter()) {
        *values
            .entry((
                voucher_key(row, id_indexes),
                joined_account(row, account_indexes),
            ))
            .or_default() += *amount;
    }
    let output = values
        .into_iter()
        .map(|((id, account), amount)| {
            vec![
                display_voucher_key(&id),
                account,
                format_number((amount * 100.0).round() / 100.0),
            ]
        })
        .collect();
    Ok(PivotResult {
        headers: vec![
            key_label.to_owned(),
            "科目名称".into(),
            "#_净额(Net)".into(),
        ],
        rows: output,
        row_field_count: 2,
    })
}

/// 透视的值字段：标签 + 每行取值。
struct LedgerPivotValue {
    label: String,
    amounts: Vec<f64>,
}

/// 透视值字段的净额伪列名。它不是源表的列，是按金额方案算出来的。
pub(crate) const NET_VALUE_FIELD: &str = "#_净额(Net)";

/// 把用户选的值字段解析成可求和的数列。
///
/// 留空时仍按净额（与旧版默认一致）。净额可以显式选，也可以和普通列一起选——
/// 显式选中时按选择的先后进入结果，不再被静默丢掉。普通列按该列逐行取数，
/// 无法解析为数字的格子按 0 计入，和其余金额口径保持一致。
fn ledger_pivot_values(
    table: &Table,
    rows: &[Vec<String>],
    net: &[f64],
    requested: &[String],
) -> Vec<LedgerPivotValue> {
    let mut result = Vec::new();
    for name in requested {
        if name.trim().is_empty() {
            continue;
        }
        if name == NET_VALUE_FIELD {
            if !result
                .iter()
                .any(|value: &LedgerPivotValue| value.label == NET_VALUE_FIELD)
            {
                result.push(LedgerPivotValue {
                    label: NET_VALUE_FIELD.to_owned(),
                    amounts: net.to_vec(),
                });
            }
            continue;
        }
        let Some(index) = header_index(&table.headers, name) else {
            continue;
        };
        result.push(LedgerPivotValue {
            label: name.clone(),
            amounts: rows
                .iter()
                .map(|row| parse_number(row.get(index).map(String::as_str).unwrap_or("")))
                .collect(),
        });
    }
    if result.is_empty() {
        result.push(LedgerPivotValue {
            label: NET_VALUE_FIELD.to_owned(),
            amounts: net.to_vec(),
        });
    }
    result
}

fn build_custom_ledger_pivot(
    table: &Table,
    rows: &[Vec<String>],
    values_config: &[LedgerPivotValue],
    mapping: &LedgerMapping,
    row_fields: &[String],
    column_fields: &[String],
    loss_ids: &HashSet<String>,
) -> Result<Option<PivotResult>, AppError> {
    if row_fields.is_empty() {
        return Ok(None);
    }
    let row_indexes = row_fields
        .iter()
        .filter_map(|name| header_index(&table.headers, name).map(|index| (name.clone(), index)))
        .collect::<Vec<_>>();
    if row_indexes.is_empty() {
        return Err(error(
            "KANZHANG_PIVOT_ROWS_MISSING",
            "透视配置没有有效的行字段。",
            None,
        ));
    }
    let column_indexes = column_fields
        .iter()
        .filter_map(|name| header_index(&table.headers, name).map(|index| (name.clone(), index)))
        .collect::<Vec<_>>();
    let date_index = mapping
        .date
        .as_deref()
        .and_then(|name| header_index(&table.headers, name));
    let id_indexes = ledger_id_indexes(&table.headers, mapping);
    let mut columns = BTreeSet::new();
    let mut values = BTreeMap::<Vec<String>, BTreeMap<String, f64>>::new();
    for (index, row) in rows.iter().enumerate() {
        if loss_ids.contains(&voucher_key(row, &id_indexes)) {
            continue;
        }
        let key = row_indexes
            .iter()
            .map(|(_, position)| row.get(*position).cloned().unwrap_or_default())
            .collect::<Vec<_>>();
        let base = if column_indexes.is_empty() {
            String::new()
        } else {
            column_indexes
                .iter()
                .map(|(_, position)| {
                    let raw = row.get(*position).map(String::as_str).unwrap_or("");
                    if Some(*position) == date_index {
                        parse_month(raw).unwrap_or_else(|| "Unknown".into())
                    } else {
                        raw.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("-")
        };
        for value in values_config {
            // 旧版把「列字段-值字段」拼成一个列名（`2025-01-#_净额(Net)`），
            // 单值字段时也照拼；不拼的话多选值字段会落进同一列被求和。
            let column = if base.is_empty() {
                value.label.clone()
            } else {
                format!("{base}-{}", value.label)
            };
            let amount = value.amounts.get(index).copied().unwrap_or(0.0);
            columns.insert(column.clone());
            *values
                .entry(key.clone())
                .or_default()
                .entry(column)
                .or_default() += amount;
        }
    }
    let columns = columns.into_iter().collect::<Vec<_>>();
    let mut headers = row_indexes
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    if !column_indexes.is_empty() {
        headers.push("合计".into());
    }
    headers.extend(columns.clone());
    let output = values
        .into_iter()
        .map(|(mut key, map)| {
            if !column_indexes.is_empty() {
                key.push(format_number(map.values().sum()));
            }
            key.extend(
                columns
                    .iter()
                    .map(|column| format_number(*map.get(column).unwrap_or(&0.0))),
            );
            key
        })
        .collect();
    Ok(Some(PivotResult {
        headers,
        rows: output,
        row_field_count: row_indexes.len(),
    }))
}

fn build_voucher_type_rows(infos: &[VoucherInfo], strict: bool, key_label: &str) -> PivotResult {
    if infos.is_empty() {
        return PivotResult {
            headers: vec![
                "科目名称-类型".into(),
                key_label.to_owned(),
                "摘要".into(),
                "科目名称".into(),
                "#_净额(Net)".into(),
            ],
            rows: Vec::new(),
            row_field_count: 4,
        };
    }
    let type_groups = classify_vouchers(infos, strict);

    let mut months = BTreeSet::new();
    for info in infos {
        months.extend(info.month_nets.keys().cloned());
    }
    let months = months.into_iter().collect::<Vec<_>>();

    // 类型编号按「该科目出现过的代表凭证号排序后的名次」定，而不是按分组的遍历顺序：
    // 旧版就是这样编的，同一科目才能稳定地从「类型1」开始数。
    let mut accounts_per_group = Vec::<BTreeSet<String>>::with_capacity(type_groups.len());
    let mut targets_per_group = Vec::<BTreeSet<String>>::with_capacity(type_groups.len());
    for group in &type_groups {
        let mut accounts = BTreeSet::new();
        let mut target_names = BTreeSet::new();
        for index in group {
            accounts.extend(infos[*index].nonzero_accounts.iter().cloned());
            target_names.extend(infos[*index].target_signs.keys().cloned());
        }
        accounts_per_group.push(accounts);
        targets_per_group.push(target_names);
    }
    let mut reps_per_account = BTreeMap::<String, BTreeSet<String>>::new();
    for (position, group) in type_groups.iter().enumerate() {
        let representative = infos[group[0]].id.clone();
        for account in &targets_per_group[position] {
            reps_per_account
                .entry(account.clone())
                .or_default()
                .insert(representative.clone());
        }
    }
    let mut type_rank = HashMap::<(String, String), usize>::new();
    for (account, representatives) in &reps_per_account {
        for (rank, representative) in representatives.iter().enumerate() {
            type_rank.insert((account.clone(), representative.clone()), rank + 1);
        }
    }

    let mut output = Vec::new();
    for (position, group) in type_groups.iter().enumerate() {
        let representative = infos[group[0]].id.clone();
        let label = targets_per_group[position]
            .iter()
            .map(|account| {
                let rank = type_rank
                    .get(&(account.clone(), representative.clone()))
                    .copied()
                    .unwrap_or(1);
                format!("{account}-类型{rank}")
            })
            .collect::<Vec<_>>()
            .join(" | ");
        let mut summary_values = Vec::new();
        'summaries: for index in group {
            for value in &infos[*index].summaries {
                if !summary_values.iter().any(|existing| existing == value) {
                    summary_values.push(value.clone());
                }
                if summary_values.len() >= 3 {
                    break 'summaries;
                }
            }
        }
        let summary = summary_values.join(" | ");
        let mut accounts = BTreeMap::<String, f64>::new();
        let mut account_months = BTreeMap::<String, BTreeMap<String, f64>>::new();
        for index in group {
            for (account, amount) in &infos[*index].account_nets {
                *accounts.entry(account.clone()).or_default() += *amount;
            }
            for (month, values) in &infos[*index].month_nets {
                for (account, amount) in values {
                    *account_months
                        .entry(account.clone())
                        .or_default()
                        .entry(month.clone())
                        .or_default() += *amount;
                }
            }
        }
        for (account, amount) in accounts {
            let rounded = round_to_cent(amount);
            let month_values = months
                .iter()
                .map(|month| {
                    round_to_cent(
                        account_months
                            .get(&account)
                            .and_then(|values| values.get(month))
                            .copied()
                            .unwrap_or(0.0),
                    )
                })
                .collect::<Vec<_>>();
            // 净额和所有月份都是 0 的科目行不展示（旧版同一处理）。
            if rounded == 0.0 && month_values.iter().all(|value| *value == 0.0) {
                continue;
            }
            let mut row = vec![
                label.clone(),
                display_voucher_key(&representative),
                summary.clone(),
                account.clone(),
                format_number(rounded),
            ];
            row.extend(month_values.into_iter().map(format_number));
            output.push(row);
        }
    }
    // 旧版排序：先按（类型标签、科目名称）升序落表，再按「标签里第一个科目名」和
    // 「最后一个类型编号」倒序做稳定排序。
    output.sort_by(|left, right| left[0].cmp(&right[0]).then_with(|| left[3].cmp(&right[3])));
    output.sort_by(|left, right| type_sort_key(&right[0]).cmp(&type_sort_key(&left[0])));
    let mut headers = vec![
        "科目名称-类型".into(),
        key_label.to_owned(),
        "摘要".into(),
        "科目名称".into(),
        "#_净额(Net)".into(),
    ];
    headers.extend(months);
    PivotResult {
        headers,
        rows: output,
        row_field_count: 4,
    }
}

/// 「科目名称-类型」标签的排序键：标签里第一个科目名 + 最后一个类型编号。
fn type_sort_key(label: &str) -> (&str, u32) {
    const MARK: &str = "-类型";
    let head = label.split_once(MARK).map_or(label, |(head, _)| head);
    let tail = label
        .rsplit_once(MARK)
        .and_then(|(_, tail)| tail.parse::<u32>().ok())
        .unwrap_or(0);
    (head, tail)
}

/// 旧版的并查集：`union(a, b)` 把 b 的根挂到 a 的根下。
struct DisjointSet {
    parent: Vec<usize>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
        }
    }

    fn find(&mut self, mut node: usize) -> usize {
        while self.parent[node] != node {
            self.parent[node] = self.parent[self.parent[node]];
            node = self.parent[node];
        }
        node
    }

    fn union(&mut self, left: usize, right: usize) {
        let (left_root, right_root) = (self.find(left), self.find(right));
        if left_root != right_root {
            self.parent[right_root] = left_root;
        }
    }
}

/// 基准组：一批已经认定为同一类型的凭证，外加组内目标科目的方向表。
struct BaseGroup {
    members: Vec<usize>,
    sign_map: BTreeMap<String, i8>,
}

/// 只比较「共同出现」的目标科目方向：凭证带来的额外目标科目不会挡住归类。
fn compatible_signs(group_map: &BTreeMap<String, i8>, voucher: &BTreeMap<String, i8>) -> bool {
    voucher
        .iter()
        .all(|(account, sign)| group_map.get(account).is_none_or(|value| value == sign))
}

/// 取「最小集合」：去重后，凡是包含了另一个集合的都不算最小。
fn minimal_account_sets<'a>(
    sets: impl Iterator<Item = &'a BTreeSet<String>>,
) -> Vec<BTreeSet<String>> {
    let unique = sets
        .filter(|set| !set.is_empty())
        .cloned()
        .collect::<BTreeSet<_>>();
    unique
        .iter()
        .filter(|candidate| {
            !unique
                .iter()
                .any(|other| other.len() < candidate.len() && other.is_subset(candidate))
        })
        .cloned()
        .collect()
}

/// 把最小集合排成「元素多的在前，同样多的按字典序」，这决定了一张凭证挂到哪个基准集合上。
fn order_base_sets(sets: &[BTreeSet<String>]) -> Vec<BTreeSet<String>> {
    let mut ordered = sets.to_vec();
    ordered.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    ordered
}

/// 找出该凭证对应的基准集合：第一个是它子集的最小集合（按 `order_base_sets` 的顺序）。
fn pick_base_set<'a>(
    ordered: &'a [BTreeSet<String>],
    candidate: &BTreeSet<String>,
) -> Option<&'a BTreeSet<String>> {
    ordered.iter().find(|set| set.is_subset(candidate))
}

/// 往基准组里塞种子：只有当这张凭证跟现有各组的方向都冲突时，才另开一组。
fn seed_base_group(groups: &mut Vec<BaseGroup>, index: usize, signs: &BTreeMap<String, i8>) {
    if groups
        .iter()
        .any(|group| compatible_signs(&group.sign_map, signs))
    {
        return;
    }
    groups.push(BaseGroup {
        members: vec![index],
        sign_map: signs.clone(),
    });
}

/// 归类一张凭证：**只有恰好一个基准组方向兼容时才合并**。零个说明没有基准，
/// 两个以上说明有歧义——旧版两种情况都宁可让它单独成一类。
fn attach_to_base_group(
    disjoint: &mut DisjointSet,
    groups: &mut [BaseGroup],
    index: usize,
    signs: &BTreeMap<String, i8>,
) {
    let mut matched = None;
    for (position, group) in groups.iter().enumerate() {
        if compatible_signs(&group.sign_map, signs) {
            if matched.is_some() {
                return;
            }
            matched = Some(position);
        }
    }
    let Some(position) = matched else {
        return;
    };
    let group = &mut groups[position];
    disjoint.union(index, group.members[0]);
    if !group.members.contains(&index) {
        group.members.push(index);
    }
    for (account, sign) in signs {
        group.sign_map.entry(account.clone()).or_insert(*sign);
    }
}

/// 旧版的两阶段并查集归类。返回每个类型的成员下标，`group[0]` 就是代表凭证。
///
/// 宽松（loose）：先按目标科目集合归并，再对「找得到目标基准集合」的凭证按全科目集合
/// 归并一次。严格（strict）：按同一凭证的目标科目个数分流——多个目标科目的走目标集合，
/// 单个目标科目的走全科目集合，最后再对单目标科目的凭证做一次同全科目集合的兜底合并。
fn classify_vouchers(infos: &[VoucherInfo], strict: bool) -> Vec<Vec<usize>> {
    let target_sets = infos
        .iter()
        .map(|info| info.target_signs.keys().cloned().collect::<BTreeSet<_>>())
        .collect::<Vec<_>>();
    let full_sets = infos
        .iter()
        .map(|info| info.nonzero_accounts.clone())
        .collect::<Vec<_>>();
    let mut disjoint = DisjointSet::new(infos.len());

    if strict {
        let base_targets = minimal_account_sets(
            target_sets
                .iter()
                .enumerate()
                .filter(|(_, set)| set.len() > 1)
                .map(|(_, set)| set),
        );
        let base_target_lookup = base_targets.iter().cloned().collect::<BTreeSet<_>>();
        let base_targets = order_base_sets(&base_targets);
        let base_fulls = minimal_account_sets(
            full_sets
                .iter()
                .enumerate()
                .filter(|(index, _)| target_sets[*index].len() == 1)
                .map(|(_, set)| set),
        );
        let base_full_lookup = base_fulls.iter().cloned().collect::<BTreeSet<_>>();
        let base_fulls = order_base_sets(&base_fulls);

        // 严格模式下只有「集合恰好等于某个最小集合」的凭证才有资格当基准组的种子。
        let mut groups_by_target = BTreeMap::<BTreeSet<String>, Vec<BaseGroup>>::new();
        for (index, info) in infos.iter().enumerate() {
            let target_set = &target_sets[index];
            if target_set.len() <= 1 || !base_target_lookup.contains(target_set) {
                continue;
            }
            seed_base_group(
                groups_by_target.entry(target_set.clone()).or_default(),
                index,
                &info.target_signs,
            );
        }
        let mut groups_by_full = BTreeMap::<BTreeSet<String>, Vec<BaseGroup>>::new();
        for (index, info) in infos.iter().enumerate() {
            if target_sets[index].len() != 1 {
                continue;
            }
            let full_set = &full_sets[index];
            if full_set.is_empty() || !base_full_lookup.contains(full_set) {
                continue;
            }
            seed_base_group(
                groups_by_full.entry(full_set.clone()).or_default(),
                index,
                &info.target_signs,
            );
        }

        for (index, info) in infos.iter().enumerate() {
            let target_set = &target_sets[index];
            let groups = if target_set.len() > 1 {
                pick_base_set(&base_targets, target_set)
                    .and_then(|base| groups_by_target.get_mut(base))
            } else {
                pick_base_set(&base_fulls, &full_sets[index])
                    .and_then(|base| groups_by_full.get_mut(base))
            };
            let Some(groups) = groups else {
                continue;
            };
            attach_to_base_group(&mut disjoint, groups, index, &info.target_signs);
        }

        // 兜底：只命中一个目标科目、且整张凭证的科目集合完全相同的凭证，方向兼容就直接并到一起。
        let mut by_full = BTreeMap::<&BTreeSet<String>, Vec<usize>>::new();
        for (index, target_set) in target_sets.iter().enumerate() {
            if target_set.len() == 1 {
                by_full.entry(&full_sets[index]).or_default().push(index);
            }
        }
        for indexes in by_full.values() {
            let Some((base, rest)) = indexes.split_first() else {
                continue;
            };
            for other in rest {
                let (left, right) = (&infos[*base].target_signs, &infos[*other].target_signs);
                if compatible_signs(left, right) && compatible_signs(right, left) {
                    disjoint.union(*base, *other);
                }
            }
        }
    } else {
        let base_targets = order_base_sets(&minimal_account_sets(target_sets.iter()));
        // 第二阶段只作用于「找得到目标基准集合」的凭证，避免没有基准时的误合并。
        let primary = (0..infos.len())
            .filter(|index| pick_base_set(&base_targets, &target_sets[*index]).is_some())
            .collect::<Vec<_>>();

        let mut groups_by_target = BTreeMap::<BTreeSet<String>, Vec<BaseGroup>>::new();
        for (index, info) in infos.iter().enumerate() {
            let Some(base) = pick_base_set(&base_targets, &target_sets[index]) else {
                continue;
            };
            seed_base_group(
                groups_by_target.entry(base.clone()).or_default(),
                index,
                &info.target_signs,
            );
        }
        for (index, info) in infos.iter().enumerate() {
            let Some(base) = pick_base_set(&base_targets, &target_sets[index]) else {
                continue;
            };
            let Some(groups) = groups_by_target.get_mut(base) else {
                continue;
            };
            attach_to_base_group(&mut disjoint, groups, index, &info.target_signs);
        }

        let base_fulls = order_base_sets(&minimal_account_sets(
            primary.iter().map(|index| &full_sets[*index]),
        ));
        let mut groups_by_full = BTreeMap::<BTreeSet<String>, Vec<BaseGroup>>::new();
        for index in &primary {
            let Some(base) = pick_base_set(&base_fulls, &full_sets[*index]) else {
                continue;
            };
            seed_base_group(
                groups_by_full.entry(base.clone()).or_default(),
                *index,
                &infos[*index].target_signs,
            );
        }
        for index in &primary {
            let Some(base) = pick_base_set(&base_fulls, &full_sets[*index]) else {
                continue;
            };
            let Some(groups) = groups_by_full.get_mut(base) else {
                continue;
            };
            attach_to_base_group(&mut disjoint, groups, *index, &infos[*index].target_signs);
        }
    }

    let mut positions = HashMap::<usize, usize>::new();
    let mut groups = Vec::<Vec<usize>>::new();
    for index in 0..infos.len() {
        let root = disjoint.find(index);
        let position = *positions.entry(root).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[position].push(index);
    }
    groups
}

/// 科目清单：显示值（几列拼接）＋ 该行的科目编码原值。
///
/// 编码单独带出来，前端才能按**编码段**做前缀匹配。只把拼接串按第一个 `-`
/// 切开是不行的——Oracle 的段式科目编码本身就含连字符（`01-1002-000`），
/// 切出来的 `01` 毫无意义。
fn account_values(
    table: &Table,
    mapping: &LedgerMapping,
    keyword: &str,
    prefixes: &[String],
) -> (Vec<String>, Vec<String>, usize) {
    let indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    let code_index = mapping
        .account_code
        .as_deref()
        .and_then(|name| header_index(&table.headers, name));
    let mut pairs: BTreeMap<String, String> = BTreeMap::new();
    for row in &table.rows {
        let value = joined_account(row, &indexes);
        if value.trim().is_empty() {
            continue;
        }
        let code = code_index
            .and_then(|index| row.get(index))
            .map(|v| v.trim().to_owned())
            .unwrap_or_default();
        pairs.entry(value).or_insert(code);
    }
    let lower = keyword.trim().to_lowercase();
    let filtered: Vec<(String, String)> = pairs
        .into_iter()
        .filter(|(value, code)| {
            // 关键词既搜名称也搜编码——面板显示「编码 名称」后，按编码找是主路径。
            if !lower.is_empty()
                && !value.to_lowercase().contains(&lower)
                && !code.to_lowercase().contains(&lower)
            {
                return false;
            }
            prefixes.is_empty() || matches_code_prefix(code, value, prefixes)
        })
        .collect();
    let total = filtered.len();
    let (values, codes): (Vec<String>, Vec<String>) = filtered.into_iter().unzip();
    (values, codes, total)
}

/// 科目编码是否命中任一前缀。**只比编码，不比整个拼接串**——否则输入 `6401`
/// 会把科目名称里恰好含 6401 的科目也拉进来。没有映射编码列时退回比对显示值
/// 的开头，让只有名称列的账也能用这个筛选。
pub(crate) fn matches_code_prefix(code: &str, display: &str, prefixes: &[String]) -> bool {
    let target = if code.trim().is_empty() {
        display
    } else {
        code
    };
    let target = target.trim().to_lowercase();
    prefixes.iter().any(|prefix| {
        let prefix = prefix.trim().to_lowercase();
        !prefix.is_empty() && target.starts_with(&prefix)
    })
}

/// 把用户输入的前缀串切成多个前缀：逗号、分号、空格、顿号都算分隔符。
pub(crate) fn parse_code_prefixes(raw: &str) -> Vec<String> {
    raw.split([',', '，', ';', '；', ' ', '\u{3000}', '、', '\n', '\t'])
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 把看账的映射翻译成统一内核的角色集合，供必填判定使用。
/// 看账只读序时账，用不到原币口径与余额类角色。
fn mapped_roles(mapping: &LedgerMapping) -> std::collections::HashSet<&'static str> {
    let mut out = std::collections::HashSet::new();
    if !mapping.id.is_empty() {
        out.insert("id");
    }
    if mapping
        .account_code
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty())
    {
        out.insert("accountCode");
    }
    if mapping.account_name.iter().any(|v| !v.trim().is_empty()) {
        out.insert("accountName");
    }
    // 旧版把编码与名称混在一个数组里，两个角色都算到位，否则老参数会被判成缺列。
    if !mapping.legacy_account.is_empty() {
        out.insert("accountCode");
        out.insert("accountName");
    }
    for (value, role) in [
        (mapping.entity.as_deref(), "entity"),
        (mapping.date.as_deref(), "date"),
        (mapping.summary.as_deref(), "summary"),
        (mapping.amount.as_deref(), "functionalAmount"),
        (mapping.direction.as_deref(), "direction"),
        (mapping.debit.as_deref(), "functionalDebit"),
        (mapping.credit.as_deref(), "functionalCredit"),
    ] {
        if value.is_some_and(|v| !v.trim().is_empty()) {
            out.insert(role);
        }
    }
    out
}

fn joined_account(row: &[String], indexes: &[usize]) -> String {
    indexes
        .iter()
        .map(|index| row.get(*index).map(String::as_str).unwrap_or("").trim())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// 科目**文本筛选**的归一：`-` 分段去空格再转小写。
///
/// 只服务于「用户选的目标科目 vs 账里的科目拼接串」这种文本比对，与引擎的
/// [`ledger_mapping::normalize_account_code`]（去前导零、作 TB/JE 跨表匹配键）
/// 语义完全不同——名字分开，免得有人拿去建匹配键。
fn normalize_account_text(value: &str) -> String {
    value
        .split('-')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

/// 四舍五入到分，并把 -0.0 归一成 0.0——否则 `format_number` 会写出 "-0"。
fn round_to_cent(value: f64) -> f64 {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

fn round_money(value: f64) -> i64 {
    (value * 100.0).round() as i64
}

fn dedup_strings(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_lowercase()))
        .map(str::to_owned)
        .collect()
}

// ────────────────────────────── 工作表自动选择 ──────────────────────────────
//
// 账簿文件里常混着审计人自建的透视/核对副本，未指定表名时「取第一张」会选错
// 正表——同一份文件汇兑损益挑正表、看账挑到副本，口径就分叉了。选哪张表的
// 判据只有一份：打分公式本体在公共引擎 ledger_mapping 里（`sheet_score` /
// `is_auxiliary_sheet_name`），这里只负责逐张表算「表头分 + 有数行数」两个输入，
// 口径与 fx.rs 的选择循环一致。

/// `open_workbook_auto` 按扩展名分派出来的读取器，选表打分要用它逐张读。
type AutoWorkbook = Sheets<BufReader<File>>;

/// 用户未指定表名时的自动选择入口：先看这份工作簿有没有记过结论，记过就直接
/// 用，不必把所有 Sheet 再解析一遍；没记过才逐张打分，并把结论记下来。
///
/// 缓存化就是为了不让 36 万行的序时账每次打开都全量重读，挑表不能把老问题带
/// 回来——缓存命中路径上这里只多读一个小文本文件。
fn pick_auto_sheet(path: &Path, workbook: &mut AutoWorkbook, sheets: &[String]) -> Option<String> {
    if sheets.len() <= 1 {
        return sheets.first().cloned();
    }
    if let Ok(memo_path) = auto_sheet_memo_path(path) {
        if let Some(remembered) = fs::read_to_string(&memo_path)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty() && sheets.contains(value))
        {
            touch_cache(&memo_path);
            return Some(remembered);
        }
    }
    let picked = auto_select_sheet(workbook, sheets)?;
    if let Ok(memo_path) = auto_sheet_memo_path(path) {
        let partial = memo_path.with_extension("sheet.partial");
        if fs::create_dir_all(memo_path.parent().unwrap_or(Path::new("."))).is_ok()
            && fs::write(&partial, &picked).is_ok()
        {
            // 记不下来不影响本次结果，最坏只是下次多扫一遍。
            let _ = replace_file(&partial, &memo_path);
        }
    }
    Some(picked)
}

/// 逐张表打分取最高。表头分取前 30 行里的最大值，有数行数按「至少两个非空
/// 单元格的行」计；并列时靠前的表胜出——单表、平分这些场景维持「取第一张」
/// 的旧结果，行为变化只发生在打分真的分出高下时。
fn auto_select_sheet(workbook: &mut AutoWorkbook, sheets: &[String]) -> Option<String> {
    let mut best: Option<(String, f64)> = None;
    for name in sheets {
        // 读不出来的表（受保护、损坏）跳过，不让一张坏表挡住整个工作簿。
        let Ok(range) = workbook.worksheet_range(name) else {
            continue;
        };
        // 前 31 行单独留下算表头分（第 i 行的得分要看第 i+1 行像不像数据行），
        // 其余行只数「有数行」，边读边丢，不把整张表再复制一份。
        let mut head: Vec<Vec<String>> = Vec::with_capacity(31);
        let mut populated = 0usize;
        let mut has_any = false;
        for (index, row) in range.rows().enumerate() {
            let texts: Vec<String> = row.iter().map(data_text).collect();
            let non_empty = texts
                .iter()
                .filter(|value| !value.trim().is_empty())
                .count();
            has_any |= non_empty > 0;
            if non_empty >= 2 {
                populated += 1;
            }
            if index < 31 {
                head.push(texts);
            }
        }
        if !has_any {
            continue;
        }
        let header = (0..head.len().min(30))
            .map(|index| ledger_mapping::header_row_score(&head, index))
            .fold(0.0_f64, f64::max);
        let score = ledger_mapping::sheet_score(header, populated, name);
        if best.as_ref().is_none_or(|(_, current)| score > *current) {
            best = Some((name.clone(), score));
        }
    }
    best.map(|(name, _)| name)
}

/// 自动选表结论的记事文件，键只有工作簿身份（规范路径、大小、修改时间）——
/// 不含表名与标题行，同一份文件谁来读、读哪行表头，挑的都是同一张表；文件
/// 内容一变身份就变，老结论自然作废。与 Parquet 缓存同目录，随同一套
/// 「按天扫除/一键清空」生命周期管理。
fn auto_sheet_memo_path(path: &Path) -> Result<PathBuf, AppError> {
    let meta = fs::metadata(path).map_err(io_error)?;
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
    hasher.update(b"auto-sheet-v1");
    let key = hex::encode(hasher.finalize());
    Ok(cache_root()?
        .join("ts")
        .join("v1")
        .join(format!("{key}.sheet")))
}

fn load_table(path: &Path, sheet: Option<&str>, header_row: usize) -> Result<Table, AppError> {
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(path.display().to_string()),
        ));
    }
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if extension == "parquet" {
        return load_parquet(path);
    }
    if crate::spreadsheet_input::is_text(path.as_ref()) {
        return load_text(path, header_row);
    }
    let read_path = local_read_path(path)?;
    let mut workbook = open_workbook_auto(&read_path).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "无法读取工作簿。",
            Some(e.to_string()),
        )
    })?;
    let sheets = workbook.sheet_names().to_vec();
    // 用户指定了表名就照用；没指定（或表名不在工作簿里）才走引擎打分挑正表。
    let selected = sheet
        .filter(|name| sheets.iter().any(|value| value == name))
        .map(str::to_owned)
        .or_else(|| pick_auto_sheet(path, &mut workbook, &sheets))
        .ok_or_else(|| error("WORKBOOK_EMPTY", "工作簿中没有 Sheet。", None))?;
    let range = workbook.worksheet_range(&selected).map_err(|e| {
        error(
            "WORKBOOK_READ_FAILED",
            "无法读取指定 Sheet。",
            Some(e.to_string()),
        )
    })?;
    let all = range
        .rows()
        .map(|row| row.iter().map(data_text).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let header_index = header_row.saturating_sub(1);
    if all.len() <= header_index {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let headers = normalize_headers(&all[header_index], width);
    let rows = normalize_rows(&all[header_index + 1..], width);
    Ok(Table {
        path: path.to_path_buf(),
        sheet: selected,
        headers,
        rows,
        sheets,
        encoding: None,
        delimiter: None,
    })
}

/// Narrow bridge used by the FX tool for formats whose decoding already lives
/// here (notably parquet). FX keeps its own header detection and strict parser.
pub(crate) fn fx_load_table_value(
    path: &Path,
    sheet: Option<&str>,
    header_row: usize,
) -> Result<Value, AppError> {
    let table = load_table(path, sheet, header_row)?;
    Ok(json!({
        "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headers": table.headers, "rows": table.rows,
        "encoding": table.encoding, "delimiter": table.delimiter,
    }))
}

/// TB / JE 公共引擎读取已确认过表头的账表：首次把 Excel/CSV 解码为
/// Polars DataFrame 并写入稳定 Parquet，之后所有工具复用同一份缓存。
///
/// Excel 容器仍由 calamine 解码（Polars 不负责解析 xlsx 单元格格式）；
/// “统一走 Polars”指解码后的列式数据、缓存和后续读取统一由 Rust Polars 承担。
pub(crate) fn fx_load_ledger_table_value_cached(
    path: &Path,
    sheet: Option<&str>,
    header_row: usize,
) -> Result<Value, AppError> {
    let table = load_ledger_cached(path, sheet, header_row)?;
    Ok(json!({
        "path": table.path, "sheet": table.sheet, "sheets": table.sheets,
        "headers": table.headers, "rows": table.rows,
        "encoding": table.encoding, "delimiter": table.delimiter,
        "engine": "rust-polars",
    }))
}

/// Load the stable, full-column TS parquet when it is valid for the exact
/// source file/sheet/header tuple. On a miss the source is read once and, when
/// requested, atomically cached. The cache key includes canonical path, size,
/// mtime, sheet and header row, so UNC files and replaced files cannot reuse a
/// stale frame.
/// 看账与正负数凭证标记的读取入口：与 TS 共用同一套稳定 Parquet 缓存。
///
/// 此前这两个工具走的是裸 [`load_table`]，一份 36 万行的序时账在
/// 读取、取科目、筛选、导出**每一步都要重新全量解析一遍**。
/// 缓存键含源文件规范路径、大小、修改时间，与哪个工具在读无关——
/// TS 和看账读同一份文件时还能命中彼此的缓存。
fn load_ledger_cached(
    path: &Path,
    sheet: Option<&str>,
    header_row: usize,
) -> Result<Table, AppError> {
    load_ts_cached(path, sheet, header_row, true).map(|(table, _, _)| table)
}

fn load_ts_cached(
    path: &Path,
    sheet: Option<&str>,
    header_row: usize,
    populate_on_miss: bool,
) -> Result<(Table, bool, PathBuf), AppError> {
    if !path.is_file() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输入文件。",
            Some(path.display().to_string()),
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if extension == "parquet" {
        let table = load_parquet(path)?;
        return Ok((table, true, path.to_path_buf()));
    }

    let (selected_sheet, sheets) = if crate::spreadsheet_input::is_text(path.as_ref()) {
        ("CSV".to_owned(), Vec::new())
    } else {
        let read_path = local_read_path(path)?;
        let mut workbook = open_workbook_auto(&read_path).map_err(|e| {
            error(
                "WORKBOOK_READ_FAILED",
                "无法读取工作簿。",
                Some(e.to_string()),
            )
        })?;
        let names = workbook.sheet_names().to_vec();
        // 用户指定了表名就照用；没指定（或表名不在工作簿里）才走引擎打分挑正表。
        let selected = sheet
            .filter(|name| names.iter().any(|value| value == name))
            .map(str::to_owned)
            .or_else(|| pick_auto_sheet(path, &mut workbook, &names))
            .ok_or_else(|| error("WORKBOOK_EMPTY", "工作簿中没有 Sheet。", None))?;
        (selected, names)
    };
    let key = fingerprint(path, &selected_sheet, header_row)?;
    let cache = cache_path("ts", &key)?;
    if cache.is_file() {
        match load_parquet(&cache) {
            Ok(mut table) => {
                table.path = path.to_path_buf();
                table.sheet = selected_sheet;
                table.sheets = sheets;
                // 记下「这份缓存今天还在用」，按天扫除时才不会误删常用的。
                touch_cache(&cache);
                return Ok((table, true, cache));
            }
            Err(_) => {
                // An interrupted/old cache is recoverable: remove it and read
                // the source. Never make a corrupt cache block the user.
                let _ = fs::remove_file(&cache);
            }
        }
    }
    let table = load_table(path, Some(&selected_sheet), header_row)?;
    if populate_on_miss {
        let mut frame = table_to_frame(&table)?;
        write_frame_cache(&cache, &mut frame)?;
    }
    Ok((table, false, cache))
}

fn local_read_path(path: &Path) -> Result<PathBuf, AppError> {
    let text = path.to_string_lossy();
    if !text.starts_with("\\\\") {
        return Ok(path.to_path_buf());
    }
    let metadata = fs::metadata(path).map_err(io_error)?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    let identity = hex::encode(hasher.finalize());
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .ok_or_else(|| error("DATA_DIR_UNAVAILABLE", "无法确定缓存目录。", None))?;
    let directory = dirs.cache_dir().join("ts").join("source");
    fs::create_dir_all(&directory).map_err(io_error)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx");
    let local = directory.join(format!("{}.{}", &identity[..24], extension));
    if local.is_file() && fs::metadata(&local).map_err(io_error)?.len() == metadata.len() {
        return Ok(local);
    }
    let partial = local.with_extension(format!("{extension}.partial"));
    let _ = fs::remove_file(&partial);
    fs::copy(path, &partial).map_err(io_error)?;
    replace_file(&partial, &local)?;
    Ok(local)
}

fn write_frame_cache(path: &Path, frame: &mut DataFrame) -> Result<(), AppError> {
    fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(io_error)?;
    let partial = path.with_extension("parquet.partial");
    let _ = fs::remove_file(&partial);
    let write_result = ParquetWriter::new(File::create(&partial).map_err(io_error)?)
        .finish(frame)
        .map_err(polars_error);
    if let Err(err) = write_result {
        let _ = fs::remove_file(&partial);
        return Err(err);
    }
    replace_file(&partial, path)
}

fn load_text(path: &Path, header_row: usize) -> Result<Table, AppError> {
    let (encoding, delimiter) = crate::spreadsheet_input::text_metadata(path)?;
    let all = crate::spreadsheet_input::read_rows(path)?;
    let header_index = header_row.saturating_sub(1);
    if all.len() <= header_index {
        return Err(error("HEADER_ROW_INVALID", "标题行超出数据范围。", None));
    }
    let width = all.iter().map(Vec::len).max().unwrap_or(0);
    let headers = normalize_headers(&all[header_index], width);
    let rows = normalize_rows(&all[header_index + 1..], width);
    Ok(Table {
        path: path.to_path_buf(),
        sheet: "CSV".into(),
        headers,
        rows,
        sheets: Vec::new(),
        encoding: Some(encoding),
        delimiter: Some(delimiter),
    })
}

fn load_parquet(path: &Path) -> Result<Table, AppError> {
    let frame = ParquetReader::new(File::open(path).map_err(io_error)?)
        .finish()
        .map_err(polars_error)?;
    let headers = frame
        .get_column_names()
        .iter()
        .map(|v| v.as_str().to_owned())
        .collect::<Vec<_>>();
    let mut rows = Vec::with_capacity(frame.height());
    for index in 0..frame.height() {
        rows.push(
            frame
                .get_row(index)
                .map_err(polars_error)?
                .0
                .iter()
                .map(any_to_string)
                .collect(),
        );
    }
    Ok(Table {
        path: path.to_path_buf(),
        sheet: "Parquet".into(),
        headers,
        rows,
        sheets: Vec::new(),
        encoding: None,
        delimiter: None,
    })
}

fn table_to_frame(table: &Table) -> Result<DataFrame, AppError> {
    rows_to_frame(&table.headers, &table.rows)
}
fn rows_to_frame(headers: &[String], rows: &[Vec<String>]) -> Result<DataFrame, AppError> {
    let columns = headers
        .iter()
        .enumerate()
        .map(|(index, name)| {
            Column::new(
                name.clone().into(),
                rows.iter()
                    .map(|row| row.get(index).cloned().unwrap_or_default())
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    DataFrame::new(rows.len(), columns).map_err(polars_error)
}

fn write_ts_workbook(
    path: &Path,
    manager: &PivotResult,
    project: Option<&PivotResult>,
    agg: &str,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let style = PivotSheetStyle::timesheet(agg);
    write_pivot_sheet(
        workbook.add_worksheet(),
        if project.is_some() {
            "by经理"
        } else {
            "透视结果"
        },
        manager,
        &style,
        cancel,
    )?;
    if let Some(project) = project {
        write_pivot_sheet(workbook.add_worksheet(), "by项目", project, &style, cancel)?;
    }
    workbook.save(path).map_err(xlsx_error)
}

// ===== 工作簿版式 =====
//
// 旧版的 `_apply_output_formatting` 做了四件事，迁移版一件都没落地：
// 金额格式 `#,##0`、辅助列灰底、凭证类型表按类型分组的交替底色 + 识别码合并，
// 以及基于隐藏页 `_targets` 的目标科目条件加粗。列宽旧版干脆不设，
// 迁移版按"表头字数折半"设，比不设还糟——「科目名称」只有 6 个字符宽，
// 里面装的却是二十多个汉字的全路径科目名。这里一并补齐，列宽改成按内容自适应。

/// Excel 里一个全角字符约占两个半角字符宽。
fn cell_display_width(value: &str) -> usize {
    value
        .chars()
        .map(|ch| if (ch as u32) > 0x2E7F { 2 } else { 1 })
        .sum()
}

/// 采样前若干行估算列宽。不全量扫描是因为明细动辄几十万行；
/// 上限用来兜住个别超长摘要，否则一格能把整列撑到屏幕外。
const AUTOFIT_SAMPLE_ROWS: usize = 600;
fn autofit_column_widths(headers: &[String], rows: &[Vec<String>], max_width: f64) -> Vec<f64> {
    let mut widths = headers
        .iter()
        .map(|value| cell_display_width(value) as f64 + 3.0)
        .collect::<Vec<_>>();
    for row in rows.iter().take(AUTOFIT_SAMPLE_ROWS) {
        for (index, value) in row.iter().enumerate() {
            if index >= widths.len() {
                break;
            }
            let width = cell_display_width(value) as f64 + 2.0;
            if width > widths[index] {
                widths[index] = width;
            }
        }
    }
    widths
        .into_iter()
        .map(|width| width.clamp(8.0, max_width))
        .collect()
}

fn apply_column_widths(sheet: &mut Worksheet, widths: &[f64]) -> Result<(), AppError> {
    for (index, width) in widths.iter().enumerate() {
        sheet
            .set_column_width(index as u16, *width)
            .map_err(xlsx_error)?;
    }
    Ok(())
}

/// 凭证类型表的前四列是长文本（类型、识别码、摘要、科目）。
/// 文本按最长内容完全撑开会挤掉右侧金额和月份；用户要求它们缩到
/// 原自适应宽度的约 1/3，数字列仍保持按内容自适应。
fn pivot_column_widths(pivot: &PivotResult, kind: PivotSheetKind) -> Vec<f64> {
    let mut widths = autofit_column_widths(&pivot.headers, &pivot.rows, 52.0);
    if kind == PivotSheetKind::VoucherType {
        for width in widths.iter_mut().take(4) {
            *width = (*width / 3.0).max(8.0);
        }
    }
    widths
}

fn column_letter(index: usize) -> String {
    let mut letters = String::new();
    let mut value = index as i64;
    while value >= 0 {
        letters.insert(0, (b'A' + (value % 26) as u8) as char);
        value = value / 26 - 1;
    }
    letters
}

/// `_targets` 的 B 列口径：去掉连字符两侧的空格，便于和单元格里的科目名比对。
fn normalized_target_display(value: &str) -> String {
    value
        .split('-')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("-")
}

fn targets_range(targets: &[String]) -> Option<String> {
    (!targets.is_empty()).then(|| format!("'_targets'!$B$1:$B${}", targets.len()))
}

/// 旧版在每个导出工作簿里都放一张隐藏的 `_targets`（明细簿和套表簿各一份），
/// A 列原名给人看，B 列归一化后供条件格式的 COUNTIF 比对。
fn write_targets_sheet(workbook: &mut Workbook, targets: &[String]) -> Result<(), AppError> {
    if targets.is_empty() {
        return Ok(());
    }
    let sheet = workbook.add_worksheet();
    sheet.set_name("_targets").map_err(xlsx_error)?;
    for (index, account) in targets.iter().enumerate() {
        sheet
            .write_string(index as u32, 0, account)
            .map_err(xlsx_error)?;
        sheet
            .write_string(index as u32, 1, normalized_target_display(account))
            .map_err(xlsx_error)?;
    }
    sheet.set_hidden(true);
    Ok(())
}

/// 命中目标科目的条件格式表达式。多列科目按 "-" 拼接后再做一次空格归一，
/// 与 `_targets` 的 B 列口径一致。
fn target_bold_rule(range: &str, account_columns: &[usize]) -> Option<String> {
    if account_columns.is_empty() {
        return None;
    }
    let expr = account_columns
        .iter()
        .map(|index| format!("{}2", column_letter(*index)))
        .collect::<Vec<_>>()
        .join("&\"-\"&");
    Some(format!(
        "COUNTIF({range},SUBSTITUTE(SUBSTITUTE(SUBSTITUTE({expr},\" - \",\"-\"),\" -\",\"-\"),\"- \",\"-\"))>0"
    ))
}

fn add_bold_rule(
    sheet: &mut Worksheet,
    rule: &str,
    rows: usize,
    columns: &[usize],
) -> Result<(), AppError> {
    if rows == 0 || columns.is_empty() {
        return Ok(());
    }
    let bold = Format::new().set_bold();
    for column in columns {
        let format = ConditionalFormatFormula::new()
            .set_rule(rule)
            .set_format(bold.clone());
        sheet
            .add_conditional_format(1, *column as u16, rows as u32, *column as u16, &format)
            .map_err(xlsx_error)?;
    }
    Ok(())
}

fn is_month_header(value: &str) -> bool {
    let value = value.trim();
    value.len() == 7
        && value.as_bytes()[4] == b'-'
        && value[..4].bytes().all(|b| b.is_ascii_digit())
        && value[5..].bytes().all(|b| b.is_ascii_digit())
}

#[derive(Clone, Copy, PartialEq)]
enum PivotSheetKind {
    /// 科目汇总、凭证：只要表头、金额格式和列宽
    Plain,
    /// 凭证类型-宽松/严格：按类型分组交替底色、合并识别码、月份列淡蓝表头
    VoucherType,
    /// 透视分析：命中目标科目的整行加粗
    CustomPivot,
}

struct PivotSheetStyle<'a> {
    kind: PivotSheetKind,
    number_format: &'a str,
    /// 冻结窗格锁定的列数。TS 透视按 `TS_PARITY.md` 的约定冻到 J2（锁前九列），
    /// 看账套表跟旧版一样只冻首行。
    freeze_columns: u16,
    /// TS 透视的期间列多到要把中段折叠起来；看账套表月份最多十二列，折叠反而会藏数据。
    collapse_middle_columns: bool,
    /// `_targets` 的 B 列区域；为空表示这次导出没有目标科目，不做加粗
    target_range: Option<&'a str>,
    /// 自定义透视里科目名称所在列（0 基）
    account_columns: &'a [usize],
}

impl<'a> PivotSheetStyle<'a> {
    /// 看账套表的基础版式。
    fn plain() -> PivotSheetStyle<'a> {
        PivotSheetStyle {
            kind: PivotSheetKind::Plain,
            number_format: "#,##0",
            freeze_columns: 0,
            collapse_middle_columns: false,
            target_range: None,
            account_columns: &[],
        }
    }
    /// TS 管理的透视沿用迁移时定下的版式，不受看账这轮改动影响。
    fn timesheet(agg: &'a str) -> PivotSheetStyle<'a> {
        PivotSheetStyle {
            kind: PivotSheetKind::Plain,
            number_format: if agg == "count" { "#,##0" } else { "#,##0.00" },
            freeze_columns: 9,
            collapse_middle_columns: true,
            target_range: None,
            account_columns: &[],
        }
    }
}

fn write_pivot_sheet(
    sheet: &mut Worksheet,
    name: &str,
    pivot: &PivotResult,
    style: &PivotSheetStyle<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    sheet.set_name(name).map_err(xlsx_error)?;
    let header = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center);
    // 旧版月份列表头淡蓝，用来把"按月分布"和前面的定性列区分开。
    let month_header = header.clone().set_background_color("#D9EAF7");
    // 看账套表的金额一律 `#,##0`（旧版口径）：套表是给人看趋势的，两位小数只会让列变长。
    // 单元格里存的仍是完整精度，求和不受影响。
    let number = Format::new().set_num_format(style.number_format);
    let banded = Format::new().set_background_color("#E0E0E0");
    let banded_number = number.clone().set_background_color("#E0E0E0");
    let month_columns = pivot
        .headers
        .iter()
        .enumerate()
        .filter(|(_, value)| is_month_header(value))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    for (col, value) in pivot.headers.iter().enumerate() {
        let format = if month_columns.contains(&col) {
            &month_header
        } else {
            &header
        };
        sheet
            .write_string_with_format(0, col as u16, value, format)
            .map_err(xlsx_error)?;
    }
    // 凭证类型表按「科目名称-类型」分组，奇数组整组灰底——一张表里几百个类型，
    // 没有底色分隔根本看不出一个类型从哪行到哪行。底色只铺到月份列之前，
    // 月份区保持白底，方便看数。
    let voucher_type = style.kind == PivotSheetKind::VoucherType;
    let band_until = month_columns
        .first()
        .copied()
        .unwrap_or(pivot.headers.len());
    let bands = if voucher_type {
        group_band_flags(&pivot.rows)
    } else {
        vec![false; pivot.rows.len()]
    };
    let numeric_start = pivot.row_field_count;
    for (row_index, row) in pivot.rows.iter().enumerate() {
        if row_index % 1000 == 0 {
            check_cancel(cancel)?;
        }
        let shaded = bands.get(row_index).copied().unwrap_or(false);
        for (col, value) in row.iter().enumerate() {
            let band = shaded && col < band_until;
            let numeric = (col >= numeric_start)
                .then(|| value.parse::<f64>().ok())
                .flatten();
            match numeric {
                Some(parsed) => sheet
                    .write_number_with_format(
                        (row_index + 1) as u32,
                        col as u16,
                        parsed,
                        if band { &banded_number } else { &number },
                    )
                    .map_err(xlsx_error)?,
                None if band => sheet
                    .write_string_with_format((row_index + 1) as u32, col as u16, value, &banded)
                    .map_err(xlsx_error)?,
                None => sheet
                    .write_string((row_index + 1) as u32, col as u16, value)
                    .map_err(xlsx_error)?,
            };
        }
    }
    // 看账套表跟旧版一样只冻首行。此前一律冻在 (1, 9)，等于把前九列也锁死，
    // 而且配套的 group_columns_collapsed 会把中间的月份列直接折叠隐藏——
    // 上一版导出里 2025-06 那一列就是这么消失的。
    sheet
        .set_freeze_panes(1, style.freeze_columns)
        .map_err(xlsx_error)?;
    if !pivot.headers.is_empty() {
        sheet
            .autofilter(
                0,
                0,
                pivot.rows.len() as u32,
                pivot.headers.len().saturating_sub(1) as u16,
            )
            .map_err(xlsx_error)?;
    }
    apply_column_widths(sheet, &pivot_column_widths(pivot, style.kind))?;
    if style.collapse_middle_columns {
        let group_start = 9usize;
        let group_end = pivot.headers.len().saturating_sub(5);
        if group_end >= group_start {
            sheet
                .group_columns_collapsed(group_start as u16, group_end as u16)
                .map_err(xlsx_error)?;
        }
    }
    if voucher_type {
        // 同一张凭证在类型表里会摊成多行（每个科目一行），旧版把识别码那一列
        // 纵向合并，读起来才是"一张凭证"而不是重复了五遍的编号。
        merge_repeated_column(sheet, &pivot.rows, 1)?;
    }
    if let Some(range) = style.target_range {
        match style.kind {
            PivotSheetKind::VoucherType => {
                // 类型表里科目名称固定在第 4 列；加粗科目名和净额列。
                if let Some(rule) = target_bold_rule(range, &[3]) {
                    let mut columns = vec![3usize];
                    columns.extend(
                        pivot
                            .headers
                            .iter()
                            .enumerate()
                            .filter(|(_, value)| value.contains("#_净额(Net)"))
                            .map(|(index, _)| index),
                    );
                    columns.dedup();
                    add_bold_rule(sheet, &rule, pivot.rows.len(), &columns)?;
                }
            }
            PivotSheetKind::CustomPivot => {
                if let Some(rule) = target_bold_rule(range, style.account_columns) {
                    let columns = (0..pivot.headers.len()).collect::<Vec<_>>();
                    add_bold_rule(sheet, &rule, pivot.rows.len(), &columns)?;
                }
            }
            PivotSheetKind::Plain => {}
        }
    }
    Ok(())
}

/// 按第一列的取值分组，奇数组返回 true（该整组铺灰底）。
fn group_band_flags(rows: &[Vec<String>]) -> Vec<bool> {
    let mut flags = Vec::with_capacity(rows.len());
    let mut group = 0usize;
    let mut previous: Option<&str> = None;
    for row in rows {
        let key = row.first().map(String::as_str).unwrap_or("");
        if previous.is_some_and(|value| value != key) {
            group += 1;
        }
        previous = Some(key);
        flags.push(group % 2 == 1);
    }
    flags
}

/// 把某一列里连续相同的取值纵向合并成一格。
fn merge_repeated_column(
    sheet: &mut Worksheet,
    rows: &[Vec<String>],
    column: usize,
) -> Result<(), AppError> {
    let value_at = |index: usize| {
        rows.get(index)
            .and_then(|row| row.get(column))
            .map(String::as_str)
            .unwrap_or("")
    };
    let merged = Format::new().set_align(FormatAlign::VerticalCenter);
    let mut start = 0usize;
    for index in 1..=rows.len() {
        if index == rows.len() || value_at(index) != value_at(start) {
            if index - start > 1 {
                sheet
                    .merge_range(
                        (start + 1) as u32,
                        column as u16,
                        index as u32,
                        column as u16,
                        value_at(start),
                        &merged,
                    )
                    .map_err(xlsx_error)?;
            }
            start = index;
        }
    }
    Ok(())
}

// 旧版是两阶段导出：明细单独一个文件，套表（凭证/透视/凭证类型）另一个文件。
// 明细动辄几十万行，和套表挤在一个工作簿里既慢又难打开，所以这里保持拆分。
fn kanzhang_suite_enabled(
    analysis: &LedgerAnalysis,
    include_pivot: bool,
    include_voucher_types: bool,
) -> bool {
    include_pivot || include_voucher_types || analysis.custom_pivot.is_some()
}

fn write_kanzhang_detail_workbook(
    path: &Path,
    analysis: &LedgerAnalysis,
    rows_per_sheet: usize,
    with_llm_analysis: bool,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let header_format = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_background_color("#DCE6F1");
    let range = targets_range(&analysis.target_accounts);
    // 旧版给明细页做三件事：辅助列整列灰底、金额列 `#,##0`、命中目标科目的
    // 科目列与金额列加粗。加粗走 `_targets` + COUNTIF，所以明细簿里也要有那张隐藏页。
    let detail_style = DetailSheetStyle {
        gray_columns: header_positions_by(&analysis.headers, |value| value.starts_with('【')),
        target_range: range.as_deref(),
        account_columns: header_positions(&analysis.headers, &analysis.account_headers),
        bold_columns: {
            let mut columns = header_positions(&analysis.headers, &analysis.account_headers);
            columns.extend(header_positions(
                &analysis.headers,
                &analysis.amount_headers,
            ));
            columns.sort_unstable();
            columns.dedup();
            columns
        },
    };
    write_detail_sheets(
        &mut workbook,
        "凭证明细",
        &analysis.headers,
        &analysis.rows,
        &header_format,
        rows_per_sheet,
        &detail_style,
        cancel,
    )?;
    if !analysis.excluded_rows.is_empty() {
        // 剔除明细没有辅助列，也不需要"命中目标科目"的加粗——它按定义就没命中。
        write_detail_sheets(
            &mut workbook,
            "剔除明细",
            &analysis.excluded_headers,
            &analysis.excluded_rows,
            &header_format,
            rows_per_sheet,
            &DetailSheetStyle::default(),
            cancel,
        )?;
    }
    // 没有套表可写时，LLM 分析没有别的落脚点，跟着明细走，避免整段结论丢失。
    if with_llm_analysis {
        if let Some(value) = analysis.llm_analysis.as_ref() {
            write_llm_analysis_sheet(workbook.add_worksheet(), value)?;
        }
    }
    write_targets_sheet(&mut workbook, &analysis.target_accounts)?;
    workbook.save(path).map_err(xlsx_error)
}

fn header_positions_by(headers: &[String], predicate: impl Fn(&str) -> bool) -> Vec<usize> {
    headers
        .iter()
        .enumerate()
        .filter(|(_, value)| predicate(value))
        .map(|(index, _)| index)
        .collect()
}

fn write_kanzhang_suite_workbook(
    path: &Path,
    analysis: &LedgerAnalysis,
    include_pivot: bool,
    include_voucher_types: bool,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let range = targets_range(&analysis.target_accounts);
    // 页签顺序照旧版排：凭证 → 凭证类型-宽松 → 凭证类型-严格 → 透视分析 → _targets → LLM分析。
    // 「科目汇总」是新版才有的页，插在旧版四页之后，免得把复核人熟悉的位置挤走。
    if include_pivot || !analysis.summary.rows.is_empty() {
        // 「凭证」是给透视和类型表当底稿的中间表，旧版套表里是隐藏的：
        // 一万多行的明细摊在第二个标签页，会盖过真正要看的透视和类型分析。
        let voucher = workbook.add_worksheet();
        write_pivot_sheet(
            voucher,
            "凭证",
            &analysis.voucher_pivot,
            &PivotSheetStyle::plain(),
            cancel,
        )?;
        voucher.set_hidden(true);
    }
    if include_voucher_types {
        let style = PivotSheetStyle {
            kind: PivotSheetKind::VoucherType,
            target_range: range.as_deref(),
            ..PivotSheetStyle::plain()
        };
        write_pivot_sheet(
            workbook.add_worksheet(),
            "凭证类型-宽松",
            &analysis.voucher_type_loose,
            &style,
            cancel,
        )?;
        write_pivot_sheet(
            workbook.add_worksheet(),
            "凭证类型-严格",
            &analysis.voucher_type_strict,
            &style,
            cancel,
        )?;
    }
    if let Some(pivot) = analysis.custom_pivot.as_ref() {
        let account_columns = header_positions(&pivot.headers, &analysis.account_headers);
        write_pivot_sheet(
            workbook.add_worksheet(),
            "透视分析",
            pivot,
            &PivotSheetStyle {
                kind: PivotSheetKind::CustomPivot,
                target_range: range.as_deref(),
                account_columns: &account_columns,
                ..PivotSheetStyle::plain()
            },
            cancel,
        )?;
    }
    if include_pivot || !analysis.summary.rows.is_empty() {
        write_pivot_sheet(
            workbook.add_worksheet(),
            "科目汇总",
            &analysis.summary,
            &PivotSheetStyle::plain(),
            cancel,
        )?;
    }
    write_targets_sheet(&mut workbook, &analysis.target_accounts)?;
    if let Some(value) = analysis.llm_analysis.as_ref() {
        write_llm_analysis_sheet(workbook.add_worksheet(), value)?;
    }
    activate_first_visible_sheet(&mut workbook);
    workbook.save(path).map_err(xlsx_error)
}

/// 「凭证」和 `_targets` 都要隐藏，但工作簿默认把第一张表当活动表，
/// 而活动表不能是隐藏的——不显式指定一张可见表，「凭证」会被重新显示出来。
fn activate_first_visible_sheet(workbook: &mut Workbook) {
    for name in ["凭证类型-宽松", "透视分析", "科目汇总", "LLM分析"] {
        if let Ok(sheet) = workbook.worksheet_from_name(name) {
            sheet.set_active(true);
            return;
        }
    }
}

/// 在给定表头里定位这些列名的位置（0 基），用于把映射里的科目列换算成列号。
fn header_positions(headers: &[String], names: &[String]) -> Vec<usize> {
    names
        .iter()
        .filter_map(|name| header_index(headers, name))
        .collect()
}

// 明细 + 套表两个文件一起写出，返回实际落盘的路径（顺序：明细在前）。
fn write_kanzhang_xlsx_suite(
    detail: &Path,
    analysis: &LedgerAnalysis,
    include_pivot: bool,
    include_voucher_types: bool,
    rows_per_sheet: usize,
    cancel: &AtomicBool,
) -> Result<Vec<PathBuf>, AppError> {
    let suite_enabled = kanzhang_suite_enabled(analysis, include_pivot, include_voucher_types);
    let detail_partial = partial_path(detail);
    write_kanzhang_detail_workbook(
        &detail_partial,
        analysis,
        rows_per_sheet,
        !suite_enabled,
        cancel,
    )?;
    replace_file(&detail_partial, detail)?;
    let mut outputs = vec![detail.to_path_buf()];
    if suite_enabled {
        let parent = detail.parent().unwrap_or(Path::new("."));
        let stem = detail.file_stem().unwrap_or_default().to_string_lossy();
        let suite = parent.join(format!("{stem}_套表.xlsx"));
        let partial = partial_path(&suite);
        write_kanzhang_suite_workbook(
            &partial,
            analysis,
            include_pivot,
            include_voucher_types,
            cancel,
        )?;
        replace_file(&partial, &suite)?;
        outputs.push(suite);
    }
    Ok(outputs)
}

fn write_kanzhang_csv_suite(
    base: &Path,
    analysis: &LedgerAnalysis,
    include_pivot: bool,
    include_voucher_types: bool,
    rows_per_sheet: usize,
    cancel: &AtomicBool,
) -> Result<Vec<PathBuf>, AppError> {
    let parent = base.parent().unwrap_or(Path::new("."));
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    let chunk_size = rows_per_sheet.max(1);
    let mut outputs = Vec::new();
    if analysis.rows.len() > chunk_size {
        for (index, chunk) in analysis.rows.chunks(chunk_size).enumerate() {
            let detail = parent.join(format!("{stem}_凭证明细_Part{}.csv", index + 1));
            let detail_partial = partial_path(&detail);
            write_csv_table(&detail_partial, &analysis.headers, chunk, cancel)?;
            replace_file(&detail_partial, &detail)?;
            outputs.push(detail);
        }
    } else {
        let detail = parent.join(format!("{stem}_凭证明细.csv"));
        let detail_partial = partial_path(&detail);
        write_csv_table(&detail_partial, &analysis.headers, &analysis.rows, cancel)?;
        replace_file(&detail_partial, &detail)?;
        outputs.push(detail);
    }
    if !analysis.excluded_rows.is_empty() {
        let excluded = parent.join(format!("{stem}_剔除明细.csv"));
        let partial = partial_path(&excluded);
        write_csv_table(
            &partial,
            &analysis.excluded_headers,
            &analysis.excluded_rows,
            cancel,
        )?;
        replace_file(&partial, &excluded)?;
        outputs.push(excluded);
    }
    if kanzhang_suite_enabled(analysis, include_pivot, include_voucher_types) {
        let suite = parent.join(format!("{stem}_套表.xlsx"));
        let partial = partial_path(&suite);
        write_kanzhang_suite_workbook(
            &partial,
            analysis,
            include_pivot,
            include_voucher_types,
            cancel,
        )?;
        replace_file(&partial, &suite)?;
        outputs.push(suite);
    }
    Ok(outputs)
}

fn write_llm_analysis_sheet(sheet: &mut Worksheet, value: &Value) -> Result<(), AppError> {
    sheet.set_name("LLM分析").map_err(xlsx_error)?;
    let title = Format::new().set_bold().set_font_size(14);
    let heading = Format::new().set_bold().set_background_color("#DCE6F1");
    sheet
        .write_string_with_format(
            0,
            0,
            value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("看账工具分析辅助说明"),
            &title,
        )
        .map_err(xlsx_error)?;
    let mut row = 2u32;
    for section in value
        .get("sections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        sheet
            .write_string_with_format(
                row,
                0,
                section
                    .get("heading")
                    .and_then(Value::as_str)
                    .unwrap_or("分析"),
                &heading,
            )
            .map_err(xlsx_error)?;
        row += 1;
        for point in section
            .get("points")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            sheet
                .write_string(
                    row,
                    0,
                    point.get("label").and_then(Value::as_str).unwrap_or(""),
                )
                .map_err(xlsx_error)?;
            sheet
                .write_string(
                    row,
                    1,
                    point.get("text").and_then(Value::as_str).unwrap_or(""),
                )
                .map_err(xlsx_error)?;
            row += 1;
        }
        row += 1;
    }
    for note in value
        .get("review_notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        sheet
            .write_string(row, 1, note.as_str().unwrap_or(""))
            .map_err(xlsx_error)?;
        row += 1;
    }
    sheet.set_column_width(0, 24).map_err(xlsx_error)?;
    sheet.set_column_width(1, 100).map_err(xlsx_error)?;
    Ok(())
}

/// Amount-like detail columns are written as numbers instead of text.
fn is_amount_header(header: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "金额",
        "借方",
        "贷方",
        "净额",
        "余额",
        "发生额",
        "绝对值",
        "amount",
        "debit",
        "credit",
        "balance",
    ];
    let lowered = header.to_lowercase();
    KEYWORDS.iter().any(|keyword| lowered.contains(keyword))
}

/// Return the numeric value of an amount cell, or `None` when writing it as a
/// number would change what the user sees (leading zeros, codes longer than the
/// exactly representable range, anything non-numeric).
fn amount_cell_value(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned = trimmed.replace(',', "");
    let digits = cleaned.trim_start_matches(['-', '+']);
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    if digits.chars().filter(|c| *c == '.').count() > 1 {
        return None;
    }
    let integer_part = digits.split('.').next().unwrap_or("");
    if integer_part.len() > 1 && integer_part.starts_with('0') {
        return None;
    }
    if digits.chars().filter(char::is_ascii_digit).count() > 15 {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

#[derive(Default)]
struct DetailSheetStyle<'a> {
    /// 需要整列铺灰底的列（辅助列）
    gray_columns: Vec<usize>,
    /// `_targets` 的 B 列区域；为空则不做加粗
    target_range: Option<&'a str>,
    /// 构造 COUNTIF 用的科目列
    account_columns: Vec<usize>,
    /// 命中目标科目时要加粗的列
    bold_columns: Vec<usize>,
}

fn write_detail_sheets(
    workbook: &mut Workbook,
    base_name: &str,
    headers: &[String],
    rows: &[Vec<String>],
    header_format: &Format,
    rows_per_sheet: usize,
    style: &DetailSheetStyle<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let chunk_size = rows_per_sheet.clamp(1, 1_000_000);
    // 旧版明细金额也是 `#,##0`，与套表一致。
    let amount_format = Format::new().set_num_format("#,##0");
    let gray = Format::new().set_background_color("#E0E0E0");
    let gray_amount = amount_format.clone().set_background_color("#E0E0E0");
    let chunks = rows.chunks(chunk_size).collect::<Vec<_>>();
    let empty: &[Vec<String>] = &[];
    for (chunk_index, chunk) in if chunks.is_empty() {
        vec![empty]
    } else {
        chunks
    }
    .into_iter()
    .enumerate()
    {
        let sheet = workbook.add_worksheet();
        let name = if chunk_index == 0 {
            base_name.to_owned()
        } else {
            format!("{base_name}_{}", chunk_index + 1)
        };
        sheet.set_name(&name).map_err(xlsx_error)?;
        for (col, value) in headers.iter().enumerate() {
            sheet
                .write_string_with_format(0, col as u16, value, header_format)
                .map_err(xlsx_error)?;
        }
        // Legacy wrote amount columns as real numbers with a thousands format so
        // auditors can select the column and read the sum straight off the status
        // bar.  Only amount-like headers are converted: writing every numeric
        // looking cell as a number would strip leading zeros from voucher and
        // account codes.
        for (row_index, row) in chunk.iter().enumerate() {
            if row_index % 1000 == 0 {
                check_cancel(cancel)?;
            }
            for (col, value) in row.iter().enumerate() {
                let shaded = style.gray_columns.contains(&col);
                let numeric = headers
                    .get(col)
                    .is_some_and(|header| is_amount_header(header))
                    .then(|| amount_cell_value(value))
                    .flatten();
                match numeric {
                    Some(number) => sheet
                        .write_number_with_format(
                            (row_index + 1) as u32,
                            col as u16,
                            number,
                            if shaded { &gray_amount } else { &amount_format },
                        )
                        .map_err(xlsx_error)?,
                    None if shaded => sheet
                        .write_string_with_format((row_index + 1) as u32, col as u16, value, &gray)
                        .map_err(xlsx_error)?,
                    None => sheet
                        .write_string((row_index + 1) as u32, col as u16, value)
                        .map_err(xlsx_error)?,
                };
            }
        }
        sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
        if !headers.is_empty() {
            sheet
                .autofilter(
                    0,
                    0,
                    chunk.len() as u32,
                    headers.len().saturating_sub(1) as u16,
                )
                .map_err(xlsx_error)?;
        }
        // 明细列宽按内容自适应：科目全路径名和摘要动辄二三十个汉字，
        // 默认宽度只能看到开头几个字，整页都要手动拉一遍。
        apply_column_widths(sheet, &autofit_column_widths(headers, chunk, 60.0))?;
        if let Some(range) = style.target_range {
            if let Some(rule) = target_bold_rule(range, &style.account_columns) {
                add_bold_rule(sheet, &rule, chunk.len(), &style.bold_columns)?;
            }
        }
    }
    Ok(())
}

fn write_csv_table(
    path: &Path,
    headers: &[String],
    rows: &[Vec<String>],
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut file = File::create(path).map_err(io_error)?;
    use std::io::Write;
    file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
    let mut writer = csv::Writer::from_writer(file);
    writer.write_record(headers).map_err(csv_error)?;
    for (index, row) in rows.iter().enumerate() {
        if index % 1000 == 0 {
            check_cancel(cancel)?;
        }
        writer.write_record(row).map_err(csv_error)?;
    }
    writer.flush().map_err(io_error)
}

fn ts_defaults(headers: &[String]) -> Value {
    let base = [
        "COE Manager",
        "Employee Name",
        "Employee Rank Name",
        "Engagement Name",
        "Engagement Code",
        "Engagement Type",
        "Time Type Desc",
        "Employee GPN",
        "COE Senior",
    ];
    let mut manager = base
        .iter()
        .filter(|v| header_index(headers, v).is_some())
        .map(|v| (*v).to_owned())
        .collect::<Vec<_>>();
    if manager.is_empty() {
        manager = headers.iter().take(4).cloned().collect();
    }
    if let Some(pos) = manager.iter().position(|v| v == "Employee Name") {
        let v = manager.remove(pos);
        manager.insert(1.min(manager.len()), v);
    }
    let mut project = manager.clone();
    if let Some(pos) = project.iter().position(|v| v == "Engagement Name") {
        let v = project.remove(pos);
        project.insert(0, v);
    }
    if let Some(pos) = project.iter().position(|v| v == "Employee Name") {
        let v = project.remove(pos);
        project.insert(1.min(project.len()), v);
    }
    let value = headers
        .iter()
        .find(|v| v.as_str() == "Hours")
        .cloned()
        .or_else(|| headers.first().cloned());
    let column = headers
        .iter()
        .find(|v| v.as_str() == "Transaction Cycle Date")
        .cloned()
        .or_else(|| headers.iter().find(|v| v.as_str() == "Month").cloned());
    json!({"filterField":if header_index(headers,"Department Name").is_some(){"Department Name"}else{""},"filterValue":if header_index(headers,"Department Name").is_some(){"ASU Delivery Center ZZ-WP"}else{""},"valueField":value,"columnField":column,"managerRowFields":manager,"projectRowFields":project})
}

/// 表头识别走统一映射内核，与汇兑损益、存款利息、借款利息共用同一份别名库。
///
/// 看账只读序时账，用不到原币口径与余额类角色，取内核结果里对应的那几个。
/// 能拿到数据行时一律走内核的带数据版 [`ledger_mapping::suggest_roles_with_data`]
/// ——对 `je` 而言它比纯表头版只多一步「合并科目列补位」（本年累计按量级分配
/// 是 TB 独有，内核里直接跳过）：整张表只有一列「科目」、值都是
/// `1001010000:库存现金` 这种混写形态时，按列名判不出科目编码，只有看数据
/// 才能补上。拿不到数据行（只剩表头的调用方）传空切片，行为退回纯表头版。
fn suggest_mapping(headers: &[String], rows: &[Vec<String>]) -> LedgerMapping {
    let roles = ledger_mapping::suggest_roles_with_data("je", headers, rows);
    let columns = |want: &str| -> Vec<String> {
        roles
            .iter()
            .filter(|(_, role)| **role == want)
            .filter_map(|(index, _)| headers.get(*index).cloned())
            .collect()
    };
    let one = |want: &str| columns(want).into_iter().next();
    // 编码与名称各归各位，界面上是两个独立角色。两者都保留：只有编码时
    // 「1002」看不出是银行存款，只有名称时又没法按科目号筛。
    let mut mapping = LedgerMapping {
        id: columns("id"),
        account_code: one("accountCode"),
        account_name: columns("accountName"),
        entity: one("entity"),
        date: one("date"),
        summary: one("summary"),
        amount: one("functionalAmount"),
        direction: one("direction"),
        debit: one("functionalDebit"),
        credit: one("functionalCredit"),
        ..Default::default()
    };
    // 一列同时被判成借方和贷方，说明它其实是「借/贷」标识列，不是金额列。
    if mapping.debit.is_some() && mapping.debit == mapping.credit {
        let combined = mapping.debit.take();
        mapping.credit = None;
        if mapping.direction.is_none() {
            mapping.direction = combined;
        }
    }
    mapping
}

fn find_header(headers: &[String], terms: &[&str]) -> Option<String> {
    let normalized = terms
        .iter()
        .map(|term| normalize_name(term))
        .collect::<Vec<_>>();
    headers
        .iter()
        .find(|header| {
            normalized
                .iter()
                .any(|term| normalize_name(header) == *term)
        })
        .cloned()
        .or_else(|| {
            headers
                .iter()
                .filter_map(|header| {
                    let value = normalize_name(header);
                    normalized
                        .iter()
                        .filter(|term| value.contains(term.as_str()))
                        .map(|term| (value.len().saturating_sub(term.len()), header))
                        .min_by_key(|(distance, _)| *distance)
                })
                .min_by_key(|(distance, _)| *distance)
                .map(|(_, header)| header.clone())
        })
}

fn apply_filters(table: &Table, filters: &[FilterSpec]) -> Vec<Vec<String>> {
    let compiled = filters
        .iter()
        .filter_map(|f| {
            header_index(&table.headers, &f.field).map(|i| {
                (
                    i,
                    f.values
                        .iter()
                        .map(|v| if v == "<空白>" { "" } else { v }.to_owned())
                        .collect::<HashSet<_>>(),
                )
            })
        })
        .filter(|(_, v)| !v.is_empty())
        .collect::<Vec<_>>();
    table
        .rows
        .iter()
        .filter(|row| {
            compiled
                .iter()
                .all(|(i, vals)| vals.contains(row.get(*i).map(String::as_str).unwrap_or("")))
        })
        .cloned()
        .collect()
}
fn row_matches_accounts(row: &[String], indexes: &[usize], values: &HashSet<String>) -> bool {
    !values.is_empty() && values.contains(&normalize_account_text(&joined_account(row, indexes)))
}
pub(crate) fn voucher_key(row: &[String], indexes: &[usize]) -> String {
    indexes
        .iter()
        .map(|i| row.get(*i).map(String::as_str).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\u{1f}")
}
/// 内部用 \u{1F} 连接凭证识别码，是为了避免公司名里带 "-" 时两个不同凭证串成同一个键。
/// 但这个控制字符一旦原样写进 xlsx，Excel 会把它转义成字面量 `_x001F_`，
/// 用户看到的就是「上海某某_x001F_2025-01-03_x001F_0008」。落表前一律还原成旧版的 "-"。
fn display_voucher_key(key: &str) -> String {
    key.replace('\u{1f}', "-")
}
/// 旧版把识别码列直接命名为参与拼接的字段名，例如「公司-记账日期-凭证号」。
fn voucher_key_label(headers: &[String], id_indexes: &[usize]) -> String {
    let parts = id_indexes
        .iter()
        .filter_map(|index| headers.get(*index))
        .map(String::as_str)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        "唯一识别码".into()
    } else {
        parts.join("-")
    }
}

/// 符号口径判定已提升为公共内核（`ledger_mapping`）——看账原本是五个工具里
/// 判定最完整的一套，现在由汇兑损益、存款利息、借款利息共用同一份实现。
/// 这里只负责把映射好的列取出来交给内核。
/// 看账的符号口径判定：**整个流程走统一内核**，这里只回答「角色对应哪一列」。
///
/// 此前这里是本模块自己的一份流程（取列、分组凭证、按记法选投票函数），
/// 汇兑损益、存款、借款各有各的写法，改一处别处不会跟着变。
pub(crate) fn sign_evidence(
    rows: &[Vec<String>],
    headers: &[String],
    mapping: &LedgerMapping,
    id_indexes: &[usize],
) -> SignEvidence {
    let _ = id_indexes;
    ledger_mapping::detect_sign_convention(headers, rows, &|role| match role {
        "id" => mapping.id.clone(),
        "entity" => mapping.entity.clone().into_iter().collect(),
        "date" => mapping.date.clone().into_iter().collect(),
        "functionalDebit" => mapping.debit.clone().into_iter().collect(),
        "functionalCredit" => mapping.credit.clone().into_iter().collect(),
        "functionalAmount" => mapping.amount.clone().into_iter().collect(),
        "direction" => mapping.direction.clone().into_iter().collect(),
        _ => Vec::new(),
    })
}

/// 凭证按首现顺序分组；顺序稳定，统计与文案才稳定。
fn group_vouchers(rows: &[Vec<String>], id_indexes: &[usize]) -> Vec<Vec<usize>> {
    let mut vouchers: Vec<Vec<usize>> = Vec::new();
    let mut slot_of: HashMap<String, usize> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let key = voucher_key(row, id_indexes);
        match slot_of.get(&key) {
            Some(&slot) => vouchers[slot].push(index),
            None => {
                let slot = vouchers.len();
                slot_of.insert(key, slot);
                vouchers.push(vec![index]);
            }
        }
    }
    vouchers
}

fn row_direction(value: Option<&String>) -> &str {
    value.map(|text| text.trim()).unwrap_or("")
}

/// 检测报告：结论 + 中文依据 + 凭证完整性统计，序列化给前端直接展示。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignReport {
    scheme: &'static str,
    /// "signed" / "unsigned"；null = 数据无法判定，需要用户指定。
    detected: Option<&'static str>,
    basis: String,
    total_vouchers: usize,
    balanced_vouchers: usize,
    unbalanced_vouchers: usize,
    /// 只有借方或只有贷方的凭证张数。
    one_sided_vouchers: usize,
    /// 单边凭证占多数——账多半是按科目筛选过后导出的。
    filtered: bool,
    /// 借贷齐全却两种口径都配不平的凭证占多——凭证识别字段可能组错。
    key_suspect: bool,
}

impl SignReport {
    fn detected_convention(&self) -> Option<SignConvention> {
        match self.detected {
            Some("signed") => Some(SignConvention::Signed),
            Some("unsigned") => Some(SignConvention::Unsigned),
            _ => None,
        }
    }
}

fn detect_sign_convention(
    rows: &[Vec<String>],
    headers: &[String],
    mapping: &LedgerMapping,
    id_indexes: &[usize],
) -> SignReport {
    let evidence = sign_evidence(rows, headers, mapping, id_indexes);
    let votes = evidence.signed_votes + evidence.unsigned_votes;
    let basis = if votes > 0 {
        format!(
            "{} 张借贷齐全的凭证中，{} 张按「已带符号」配平、{} 张按「借贷符号一样」配平，取多数。",
            votes, evidence.signed_votes, evidence.unsigned_votes
        )
    } else {
        evidence
            .note
            .clone()
            .unwrap_or_else(|| "金额字段未映射。".into())
    };
    SignReport {
        scheme: evidence.scheme,
        detected: evidence.convention.map(|c| c.as_str()),
        basis,
        total_vouchers: evidence.total_vouchers,
        balanced_vouchers: votes,
        unbalanced_vouchers: evidence.unbalanced,
        one_sided_vouchers: evidence.one_sided,
        // 账被筛过 vs 凭证键组错：两者都会让凭证配不平，但成因完全不同，
        // 提示语指错方向会让人去查一个不存在的映射问题。
        // 判据是单边凭证的占比——按科目筛过的账里另一半分录被筛掉了，
        // 单边占比会很高（实测约 89%）；键组错只是把凭证并粗，两边都在，
        // 单边占比仍然很低（实测不到 1%）。
        filtered: matches!(evidence.scheme, "A" | "B")
            && evidence.total_vouchers > 0
            && evidence.one_sided * 2 > evidence.total_vouchers,
        key_suspect: evidence.unbalanced > votes
            && evidence.unbalanced > 0
            && evidence.one_sided * 2 <= evidence.total_vouchers,
    }
}

fn ledger_amounts(
    rows: &[Vec<String>],
    headers: &[String],
    mapping: &LedgerMapping,
    id_indexes: &[usize],
    sign_override: Option<SignConvention>,
) -> LedgerAmounts {
    if let (Some(dr_index), Some(cr_index)) = (
        mapping
            .debit
            .as_deref()
            .and_then(|name| header_index(headers, name)),
        mapping
            .credit
            .as_deref()
            .and_then(|name| header_index(headers, name)),
    ) {
        let evidence = sign_evidence(rows, headers, mapping, id_indexes);
        let convention = sign_override
            .or(evidence.convention)
            .unwrap_or(SignConvention::Unsigned);
        let debit = rows
            .iter()
            .map(|row| parse_number(row.get(dr_index).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>();
        let credit = rows
            .iter()
            .map(|row| parse_number(row.get(cr_index).map(String::as_str).unwrap_or("")))
            .collect::<Vec<_>>();
        let net = debit
            .iter()
            .zip(credit.iter())
            .map(|(debit, credit)| {
                ledger_mapping::signed_amount(
                    &ledger_mapping::AmountInputs {
                        debit: Some(*debit),
                        credit: Some(*credit),
                        ..Default::default()
                    },
                    convention,
                )
            })
            .collect();
        return LedgerAmounts {
            net,
            allow_cross_match: true,
        };
    }
    let amount_index = mapping
        .amount
        .as_deref()
        .and_then(|name| header_index(headers, name));
    let raw = rows
        .iter()
        .map(|row| {
            amount_index
                .map(|index| parse_number(row.get(index).map(String::as_str).unwrap_or("")))
                .unwrap_or(0.0)
        })
        .collect::<Vec<_>>();
    let direction_index = mapping
        .direction
        .as_deref()
        .and_then(|name| header_index(headers, name));
    if let Some(direction_index) = direction_index {
        let evidence = sign_evidence(rows, headers, mapping, id_indexes);
        let convention = sign_override
            .or(evidence.convention)
            .unwrap_or(SignConvention::Unsigned);
        let net = rows
            .iter()
            .zip(raw.iter())
            .map(|(row, amount)| {
                ledger_mapping::signed_amount(
                    &ledger_mapping::AmountInputs {
                        amount: Some(*amount),
                        direction: row.get(direction_index).cloned(),
                        ..Default::default()
                    },
                    convention,
                )
            })
            .collect();
        LedgerAmounts {
            net,
            allow_cross_match: false,
        }
    } else {
        LedgerAmounts {
            net: raw,
            allow_cross_match: true,
        }
    }
}

fn mapping_columns(m: &LedgerMapping) -> Vec<&str> {
    m.id.iter()
        .map(String::as_str)
        .chain(m.account_columns())
        .chain(
            [
                m.entity.as_deref(),
                m.date.as_deref(),
                m.summary.as_deref(),
                m.amount.as_deref(),
                m.direction.as_deref(),
                m.debit.as_deref(),
                m.credit.as_deref(),
            ]
            .into_iter()
            .flatten(),
        )
        .collect()
}

fn ledger_columns_for_role(mapping: &LedgerMapping, role: &str) -> Vec<String> {
    match role {
        "functionalAmount" => mapping.amount.iter().cloned().collect(),
        "functionalDebit" => mapping.debit.iter().cloned().collect(),
        "functionalCredit" => mapping.credit.iter().cloned().collect(),
        _ => Vec::new(),
    }
}

fn ledger_amount_parse_issues(table: &Table, mapping: &LedgerMapping) -> Vec<Value> {
    ledger_mapping::mapped_amount_parse_issues("je", &table.headers, &table.rows, &|role| {
        ledger_columns_for_role(mapping, role)
    })
    .into_iter()
    .take(20)
    .map(|issue| {
        json!({
            "rowIndex": issue.row_index,
            "column": issue.column,
            "role": issue.role,
            "label": issue.label,
            "value": issue.value,
        })
    })
    .collect()
}

fn validate_ledger_amounts(
    table: &Table,
    mapping: &LedgerMapping,
    header_row: usize,
) -> Result<(), AppError> {
    let issues =
        ledger_mapping::mapped_amount_parse_issues("je", &table.headers, &table.rows, &|role| {
            ledger_columns_for_role(mapping, role)
        });
    if issues.is_empty() {
        return Ok(());
    }
    let detail = issues
        .iter()
        .take(20)
        .map(|issue| {
            format!(
                "{}（{}）第{}行=“{}”",
                issue.column,
                issue.label,
                header_row + issue.row_index + 1,
                issue.value
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    Err(error(
        "KANZHANG_AMOUNT_VALUE_INVALID",
        "金额列存在非空但无法解析为数值的单元格，请修正后重试。",
        Some(if issues.len() > 20 {
            format!("{detail}；另有{}处未列出。", issues.len() - 20)
        } else {
            detail
        }),
    ))
}
fn validate_mapping_required(m: &LedgerMapping) -> Result<(), AppError> {
    if m.id.is_empty()
        || m.account_columns().is_empty()
        || !((m.debit.is_some() && m.credit.is_some()) || m.amount.is_some())
    {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "字段映射不完整：至少需要凭证编号、科目，以及金额或借贷金额列。",
            None,
        ));
    }
    // Legacy re-checked this right before exporting: when both sides of the
    // debit/credit scheme point at one column every net amount degrades to
    // `x - x = 0` and the whole workbook silently reports zero.  Refuse instead.
    if let (Some(debit), Some(credit)) = (m.debit.as_deref(), m.credit.as_deref()) {
        if normalize_name(debit) == normalize_name(credit) {
            return Err(error(
                "KANZHANG_MAPPING_CONFLICT",
                "借方金额和贷方金额指向同一列，净额会全部变成 0。请改用「金额+方向」方案，或分别指定借方列和贷方列。",
                Some(debit.to_string()),
            ));
        }
    }
    Ok(())
}

fn normalize_headers(row: &[String], width: usize) -> Vec<String> {
    let mut used = HashMap::<String, usize>::new();
    (0..width)
        .map(|i| {
            let base = row
                .get(i)
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Column_{}", i + 1));
            let count = used.entry(base.clone()).or_default();
            *count += 1;
            if *count == 1 {
                base
            } else {
                format!("{base}_{}", *count)
            }
        })
        .collect()
}
fn normalize_rows(rows: &[Vec<String>], width: usize) -> Vec<Vec<String>> {
    rows.iter()
        .map(|row| {
            let mut r = row.clone();
            r.resize(width, String::new());
            r.truncate(width);
            // 内部整行空白是账表的结构信息：TBJE 用它区分正文与表尾手工
            // 草稿。不能在公共 Polars 缓存前删掉，否则下游再也无法恢复边界。
            r
        })
        .collect()
}
fn data_text(v: &Data) -> String {
    match v {
        Data::Empty => String::new(),
        Data::String(v) => v.clone(),
        Data::Float(v) => format_number(*v),
        Data::Int(v) => v.to_string(),
        Data::Bool(v) => v.to_string(),
        Data::DateTime(v) => v
            .as_datetime()
            .map(|d| {
                if d.time() == chrono::NaiveTime::MIN {
                    d.format("%Y-%m-%d").to_string()
                } else {
                    d.format("%Y-%m-%d %H:%M:%S").to_string()
                }
            })
            .unwrap_or_else(|| v.as_f64().to_string()),
        other => other.to_string(),
    }
}
fn parse_month(value: &str) -> Option<String> {
    let cleaned = value.trim().trim_end_matches(".0");
    if cleaned.is_empty() {
        return None;
    }
    let digits = cleaned
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    if digits.len() == 8 {
        if let Ok(date) = chrono::NaiveDate::parse_from_str(&digits, "%Y%m%d") {
            return Some(date.format("%Y-%m").to_string());
        }
    }
    if let Ok(serial) = cleaned.parse::<i64>() {
        if (1_000..100_000).contains(&serial) {
            if let Some(origin) = chrono::NaiveDate::from_ymd_opt(1899, 12, 30) {
                if let Some(date) = origin.checked_add_signed(chrono::Duration::days(serial)) {
                    return Some(date.format("%Y-%m").to_string());
                }
            }
        }
    }
    for format in [
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y-%m", "%Y/%m", "%Y.%m",
    ] {
        if let Ok(date) = chrono::NaiveDate::parse_from_str(cleaned, format) {
            return Some(date.format("%Y-%m").to_string());
        }
        if matches!(format, "%Y-%m" | "%Y/%m" | "%Y.%m") {
            let extended = format!("{cleaned}-01").replace('/', "-").replace('.', "-");
            if let Ok(date) = chrono::NaiveDate::parse_from_str(&extended, "%Y-%m-%d") {
                return Some(date.format("%Y-%m").to_string());
            }
        }
    }
    None
}
/// 取数用的数值解析，**能力走统一内核**。
///
/// 本工具的策略是读不出按 0 处理、继续往下跑——看账要容忍脏账，
/// 一个坏格子不该让整次导出失败。但**能力**必须和别的工具一致：
/// 此前这里只去引号和千分位，`(500)`、`1,234CR`、全角逗号一律静默变成 0，
/// 金额无声无息地丢掉。
fn parse_number(value: &str) -> f64 {
    ledger_mapping::parse_amount(value)
        .ok()
        .flatten()
        .unwrap_or(0.0)
}
fn format_number(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}
fn any_to_string(value: &AnyValue<'_>) -> String {
    match value {
        AnyValue::Null => String::new(),
        AnyValue::String(v) => (*v).to_owned(),
        _ => value.to_string(),
    }
}
fn any_to_f64(value: &AnyValue<'_>) -> f64 {
    match value {
        AnyValue::Float64(v) => *v,
        AnyValue::Float32(v) => *v as f64,
        AnyValue::Int64(v) => *v as f64,
        AnyValue::Int32(v) => *v as f64,
        AnyValue::UInt64(v) => *v as f64,
        AnyValue::UInt32(v) => *v as f64,
        _ => parse_number(&any_to_string(value)),
    }
}

fn fingerprint(path: &Path, sheet: &str, header_row: usize) -> Result<String, AppError> {
    let meta = fs::metadata(path).map_err(io_error)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|v| v.as_nanos())
        .unwrap_or(0);
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut h = Sha256::new();
    h.update(canonical.to_string_lossy().as_bytes());
    h.update(meta.len().to_le_bytes());
    h.update(modified.to_le_bytes());
    h.update(sheet.as_bytes());
    h.update(header_row.to_le_bytes());
    // Shared strict text decoding must not reuse rows decoded lossily by older versions.
    h.update(b"rust-polars-v3-shared-spreadsheet-input");
    Ok(hex::encode(h.finalize()))
}
/// 缓存根目录：`%LOCALAPPDATA%/AuditToolbox/AuditToolbox/cache`。
fn cache_root() -> Result<PathBuf, AppError> {
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .ok_or_else(|| error("DATA_DIR_UNAVAILABLE", "无法确定缓存目录。", None))?;
    Ok(dirs.cache_dir().to_path_buf())
}

/// 逐个缓存文件的路径与「最后一次用到」的时间。
///
/// 用 mtime 当最后使用时间：缓存命中时会 touch 一下（见 [`touch_cache`]），
/// 所以它记的是「上次真正读到过」，而不是「什么时候写进来的」。
/// Windows 默认不更新 atime，拿 atime 判反而会把常用缓存误删。
fn cache_entries() -> Result<Vec<(PathBuf, SystemTime, u64)>, AppError> {
    let root = cache_root()?;
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if matches!(
                path.extension().and_then(|v| v.to_str()),
                // `.sheet` 是自动选表结论的小记事文件，跟着 Parquet 缓存一起
                // 统计、清空与扫除，不然会在缓存目录里悄悄攒下来。
                Some("parquet") | Some("sheet")
            ) {
                let used = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                out.push((path, used, meta.len()));
            }
        }
    }
    Ok(out)
}

/// 缓存命中时把 mtime 推到当前时间，让「最后使用时间」保持真实。
/// 失败不影响读取——最坏的结果只是这份缓存早一点被扫除。
fn touch_cache(path: &Path) {
    let _ = fs::File::options()
        .append(true)
        .open(path)
        .and_then(|file| file.set_modified(SystemTime::now()));
}

/// 缓存占用概况：文件数、总字节、最早一次使用距今多少天。
fn cache_stat(_params: Value) -> Result<Value, AppError> {
    let entries = cache_entries()?;
    let bytes: u64 = entries.iter().map(|(_, _, size)| size).sum();
    let oldest_days = entries
        .iter()
        .filter_map(|(_, used, _)| used.elapsed().ok())
        .map(|age| age.as_secs() / 86_400)
        .max()
        .unwrap_or(0);
    Ok(json!({
        "files": entries.len(),
        "bytes": bytes,
        "oldestDays": oldest_days,
        "path": cache_root()?.display().to_string(),
    }))
}

/// 清空全部缓存。删不掉的文件（正被占用）跳过并计数，不让一个文件挡住整次清理。
fn cache_clear(_params: Value) -> Result<Value, AppError> {
    let entries = cache_entries()?;
    let mut removed = 0usize;
    let mut freed = 0u64;
    let mut failed = 0usize;
    for (path, _, size) in entries {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += size;
        } else {
            failed += 1;
        }
    }
    Ok(json!({"removed":removed,"freed":freed,"failed":failed}))
}

/// 按周期自动清理：`mode` 为 `daily`／`weekly`／`off`。
///
/// 到期与否在这里判，前端只负责按时来问一次、把返回的时间戳存回设置——
/// 免得「多久算一天」这种判断散在两边各写一遍。
///
/// 清的是**超过一个周期没用过的**缓存，不是无差别清空：今天刚用过的表
/// 明天大概率还要用，连它一起删等于把缓存关掉。
fn cache_sweep(params: Value) -> Result<Value, AppError> {
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("weekly");
    let period_days = match mode {
        "off" => {
            return Ok(json!({"removed":0,"freed":0,"skipped":true,"reason":"已关闭自动清理"}));
        }
        "daily" => 1u64,
        _ => 7u64,
    };
    let period = Duration::from_secs(period_days * 86_400);
    // 距上次清理不足一个周期就不动手——前端每小时来问一次也只会真跑一次。
    if let Some(last) = params.get("lastCleanup").and_then(Value::as_i64) {
        if chrono::Utc::now().timestamp() - last < period.as_secs() as i64 {
            return Ok(
                json!({"removed":0,"freed":0,"skipped":true,"reason":"距上次清理不足一个周期"}),
            );
        }
    }
    let mut removed = 0usize;
    let mut freed = 0u64;
    for (path, used, size) in cache_entries()? {
        let stale = used.elapsed().map(|age| age > period).unwrap_or(false);
        if stale && fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += size;
        }
    }
    Ok(json!({
        "removed":removed,"freed":freed,"skipped":false,"mode":mode,
        "cleanedAt": chrono::Utc::now().timestamp(),
    }))
}

fn cache_path(tool: &str, key: &str) -> Result<PathBuf, AppError> {
    let dirs = ProjectDirs::from("com", "AuditToolbox", "AuditToolbox")
        .ok_or_else(|| error("DATA_DIR_UNAVAILABLE", "无法确定缓存目录。", None))?;
    Ok(dirs
        .cache_dir()
        .join(tool)
        .join("v1")
        .join(format!("{key}.parquet")))
}
fn output_path(
    input: &str,
    selected: Option<&str>,
    prefix: &str,
    extension: &str,
) -> Result<PathBuf, AppError> {
    if let Some(v) = selected.filter(|v| !v.trim().is_empty()) {
        let mut p = PathBuf::from(v);
        if p.extension().is_none() {
            p.set_extension(extension);
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        return Ok(p);
    }
    let input = Path::new(input);
    let parent = input.parent().unwrap_or(Path::new("."));
    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    Ok(parent.join(format!("{prefix}_{stamp}.{extension}")))
}
fn kanzhang_batch_output_path(
    job: &KanzhangParams,
    batch: &LedgerBatch,
    index: usize,
    total: usize,
) -> Result<PathBuf, AppError> {
    let suffix = sanitize_filename(&batch.name);
    if let Some(value) = job
        .output_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let mut base = PathBuf::from(value);
        if base.extension().is_none() {
            base.set_extension("xlsx");
        }
        if total == 1 || index == 0 {
            return output_path(&job.input_path, base.to_str(), "看账结果", "xlsx");
        }
        let parent = base.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(io_error)?;
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let extension = base
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("xlsx");
        return Ok(parent.join(format!("{stem}_{}_{:02}.{extension}", suffix, index + 1)));
    }
    let directory = job
        .output_dir
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(&job.input_path)
                .parent()
                .unwrap_or(Path::new("."))
                .to_path_buf()
        });
    fs::create_dir_all(&directory).map_err(io_error)?;
    // 与旧版 _build_default_save_name 对齐：看账导出_<源文件名>[_工作表<Sheet>]_<时间戳>，
    // 且默认走 CSV——明细动辄百万行，CSV 写出快得多，套表仍单独出 xlsx。
    let stem = Path::new(&job.input_path)
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "未命名".to_string());
    let mut parts = vec!["看账导出".to_string(), sanitize_filename(&stem)];
    if let Some(sheet) = job
        .sheet
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        parts.push(format!("工作表{}", sanitize_filename(sheet)));
    }
    if total > 1 {
        parts.push(format!("{:02}_{}", index + 1, suffix));
    }
    parts.push(Local::now().format("%Y%m%d_%H%M%S").to_string());
    Ok(directory.join(format!("{}.csv", parts.join("_"))))
}
fn sanitize_filename(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '\"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "批次".into()
    } else {
        trimmed.chars().take(60).collect()
    }
}
fn partial_path(output: &Path) -> PathBuf {
    output.with_file_name(format!(
        "{}.partial.{}",
        output.file_name().unwrap_or_default().to_string_lossy(),
        output.extension().and_then(|v| v.to_str()).unwrap_or("tmp")
    ))
}
fn replace_file(partial: &Path, output: &Path) -> Result<(), AppError> {
    if output.exists() {
        fs::remove_file(output).map_err(io_error)?;
    }
    fs::rename(partial, output).map_err(io_error)
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}
fn required_string(params: &Value, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("INVALID_ARGUMENT", format!("缺少必填参数：{key}"), None))
}
fn parse<T: for<'de> Deserialize<'de>>(params: Value, message: &str) -> Result<T, AppError> {
    serde_json::from_value(params)
        .map_err(|e| error("INVALID_ARGUMENT", message, Some(e.to_string())))
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
fn error(code: &str, message: impl Into<String>, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}
fn io_error(e: std::io::Error) -> AppError {
    error("IO_ERROR", "文件读写失败。", Some(e.to_string()))
}
fn csv_error(e: csv::Error) -> AppError {
    error("CSV_ERROR", "CSV 文件处理失败。", Some(e.to_string()))
}
fn polars_error(e: PolarsError) -> AppError {
    error(
        "POLARS_ERROR",
        "Rust Polars 数据处理失败。",
        Some(e.to_string()),
    )
}
fn xlsx_error(e: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "XLSX_WRITE_FAILED",
        "Excel 文件写出失败。",
        Some(e.to_string()),
    )
}

// ---------------------------------------------------------------------------
// 正负数智能标记
//
// 从看账小工具剪出来的独立工具：只做 JE 对冲标记，不做透视、套表和损益结转。
// 加载、映射、科目取值三条通道与看账共用，标记算法即 `match_je_rows`，
// 唯一差别是这里不把损益结转凭证挡在匹配之外——该识别已随功能一并移除。
// ---------------------------------------------------------------------------

/// 引擎用这个字面量表示"该列为空"，与 TS 的列筛选面板同一口径。
const BLANK_VALUE_TOKEN: &str = "<空白>";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColumnFilter {
    field: String,
    #[serde(default)]
    values: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JeMarkParams {
    input_path: String,
    sheet: Option<String>,
    #[serde(default = "one")]
    header_row: usize,
    output_path: Option<String>,
    mapping: Option<LedgerMapping>,
    #[serde(default)]
    target_batches: Vec<LedgerBatch>,
    /// 非科目列的漏斗筛选。同列多值取「或」，跨列取「与」，与 TS 口径一致。
    #[serde(default)]
    column_filters: Vec<ColumnFilter>,
    /// 金额符号口径：None/"auto" 自动检测，"signed" 已带符号，"unsigned" 借贷符号一样。
    #[serde(default)]
    sign_convention: Option<String>,
    #[serde(default = "default_excel_chunk")]
    rows_per_sheet: usize,
}

/// 解析前端传来的符号口径选择；非法取值直接报错，不静默回退。
fn parse_sign_choice(value: Option<&str>) -> Result<Option<SignConvention>, AppError> {
    match value {
        None | Some("auto") => Ok(None),
        Some("signed") => Ok(Some(SignConvention::Signed)),
        Some("unsigned") => Ok(Some(SignConvention::Unsigned)),
        Some(other) => Err(error(
            "INVALID_PARAMS",
            "符号口径只能是 auto / signed / unsigned。",
            Some(other.into()),
        )),
    }
}

/// 任意一列的取值清单，供预览表头的漏斗面板按需读取。
/// 与 `ts.filter` 同形，但走 `load_table` 而不是 TS 的 Parquet 缓存，
/// 保证读到的表结构与看账/标记的其他步骤完全一致。
fn kanzhang_column_values(params: Value) -> Result<Value, AppError> {
    let source: SourceParams = parse(params.clone(), "参数不完整。")?;
    let field = required_string(&params, "field")?;
    let keyword = params
        .get("keyword")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(1_000)
        .clamp(1, 20_000) as usize;
    let table = load_ledger_cached(
        Path::new(&source.input_path),
        source.sheet.as_deref(),
        source.header_row,
    )?;
    let index = header_index(&table.headers, &field)
        .ok_or_else(|| error("COLUMN_NOT_FOUND", "筛选字段不存在。", Some(field.clone())))?;
    let mut values = BTreeSet::new();
    for row in &table.rows {
        let value = row.get(index).map(|value| value.trim()).unwrap_or("");
        if keyword.is_empty() || value.to_lowercase().contains(&keyword) {
            values.insert(if value.is_empty() {
                BLANK_VALUE_TOKEN.to_owned()
            } else {
                value.to_owned()
            });
        }
    }
    let total = values.len();
    Ok(
        json!({"engine":"rust-polars","values":values.into_iter().take(limit).collect::<Vec<_>>(),"total":total,"truncated":total>limit}),
    )
}

/// 按凭证套用非科目列的筛选：凭证里只要有一行同时满足所有已勾选的列条件，
/// 整张凭证保留。按行裁会把凭证切碎，跨凭证配对算的净额随之失真。
fn apply_column_filters(
    mut table: Table,
    mapping: &LedgerMapping,
    filters: &[ColumnFilter],
) -> Table {
    let active = filters
        .iter()
        .filter_map(|filter| {
            let index = header_index(&table.headers, &filter.field)?;
            let chosen = filter
                .values
                .iter()
                .map(|value| value.trim().to_owned())
                .collect::<HashSet<_>>();
            if chosen.is_empty() {
                None
            } else {
                Some((index, chosen))
            }
        })
        .collect::<Vec<_>>();
    if active.is_empty() {
        return table;
    }
    let id_indexes = ledger_id_indexes(&table.headers, mapping);
    let mut keep = HashSet::new();
    for row in &table.rows {
        let hit = active.iter().all(|(index, chosen)| {
            let value = row.get(*index).map(|value| value.trim()).unwrap_or("");
            chosen.contains(if value.is_empty() {
                BLANK_VALUE_TOKEN
            } else {
                value
            })
        });
        if hit {
            keep.insert(voucher_key(row, &id_indexes));
        }
    }
    table
        .rows
        .retain(|row| keep.contains(&voucher_key(row, &id_indexes)));
    table
}

/// 只算三列辅助列的精简分析：绝对值、符号、智能匹配状态。
/// 套表、凭证类型、透视、LLM 分析都不属于这个工具，一律留空。
/// `sign` 是导出前已定案的符号口径（用户指定或全表检测），各批次强制一致。
fn analyze_je_mark(
    table: &Table,
    mapping: &LedgerMapping,
    rows: &[Vec<String>],
    targets: &[String],
    sign: SignConvention,
    cancel: &AtomicBool,
) -> Result<LedgerAnalysis, AppError> {
    let id_indexes = ledger_id_indexes(&table.headers, mapping);
    let account_indexes = mapping
        .account_columns()
        .into_iter()
        .filter_map(|name| header_index(&table.headers, name))
        .collect::<Vec<_>>();
    if id_indexes.is_empty() || account_indexes.is_empty() {
        return Err(error(
            "KANZHANG_MAPPING_INCOMPLETE",
            "无法构造凭证唯一识别码或科目字段。",
            None,
        ));
    }
    let target_set = targets
        .iter()
        .map(|value| normalize_account_text(value))
        .filter(|value| !value.is_empty())
        .collect::<HashSet<_>>();
    let amounts = ledger_amounts(rows, &table.headers, mapping, &id_indexes, Some(sign));
    // 本工具不识别损益结转，结转凭证照常参与匹配。
    let loss_ids = HashSet::new();
    let (je_status, je_pairs, je_cross_pairs) = match_je_rows(
        rows,
        &table.headers,
        &amounts,
        mapping,
        &id_indexes,
        &account_indexes,
        &target_set,
        &loss_ids,
        cancel,
    )?;
    // 辅助列摆在最前，与看账旧版的明细列序一致。
    let mut headers = Vec::with_capacity(table.headers.len() + 3);
    headers.extend(
        ["【辅助_绝对值】", "【辅助_符号】", "【智能匹配状态】"]
            .into_iter()
            .map(str::to_owned),
    );
    headers.extend(table.headers.iter().cloned());
    let mut enriched = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        if index % 2_000 == 0 {
            check_cancel(cancel)?;
        }
        let amount = amounts.net.get(index).copied().unwrap_or(0.0);
        let mut output = Vec::with_capacity(headers.len());
        // 只有目标科目行参与配对，其余行三列留空——铺满全表会让人误以为
        // 每一行都参与了匹配。匹配状态本身就只在这个范围内非空，以它为准。
        let status = je_status.get(index).cloned().unwrap_or_default();
        if status.is_empty() {
            output.push(String::new());
            output.push(String::new());
        } else {
            output.push(format_number(amount.abs()));
            output.push(if amount >= 0.0 {
                "正数".into()
            } else {
                "负数".into()
            });
        }
        output.push(status);
        output.extend(row.iter().cloned());
        enriched.push(output);
    }
    let empty_pivot = || PivotResult {
        headers: Vec::new(),
        rows: Vec::new(),
        row_field_count: 0,
    };
    Ok(LedgerAnalysis {
        headers,
        rows: enriched,
        excluded_headers: Vec::new(),
        excluded_rows: Vec::new(),
        summary: empty_pivot(),
        voucher_pivot: empty_pivot(),
        voucher_type_loose: empty_pivot(),
        voucher_type_strict: empty_pivot(),
        custom_pivot: None,
        llm_analysis: None,
        target_accounts: {
            let mut values = targets
                .iter()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            values.sort();
            values.dedup();
            values
        },
        account_headers: mapping
            .account_columns()
            .into_iter()
            .map(str::to_owned)
            .collect(),
        amount_headers: [
            mapping.amount.as_deref(),
            mapping.debit.as_deref(),
            mapping.credit.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(str::to_owned)
        .collect(),
        loss_count: 0,
        je_pairs,
        je_cross_pairs,
    })
}

/// 多批次各出一个文件；命名规则与看账的多批次一致。
fn je_mark_batch_output_path(
    job: &JeMarkParams,
    batch: &LedgerBatch,
    index: usize,
    total: usize,
) -> Result<PathBuf, AppError> {
    let suffix = sanitize_filename(&batch.name);
    if let Some(value) = job
        .output_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let mut base = PathBuf::from(value);
        if base.extension().is_none() {
            base.set_extension("csv");
        }
        if total == 1 || index == 0 {
            return output_path(&job.input_path, base.to_str(), "正负数标记", "csv");
        }
        let parent = base.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(parent).map_err(io_error)?;
        let stem = base.file_stem().unwrap_or_default().to_string_lossy();
        let extension = base
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("csv");
        return Ok(parent.join(format!("{stem}_{}_{:02}.{extension}", suffix, index + 1)));
    }
    let base = output_path(&job.input_path, None, "正负数标记", "csv")?;
    if total == 1 {
        return Ok(base);
    }
    let parent = base.parent().unwrap_or(Path::new(".")).to_path_buf();
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    Ok(parent.join(format!("{stem}_{}_{:02}.csv", suffix, index + 1)))
}

fn export_je_mark(
    params: Value,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Value, AppError> {
    let job: JeMarkParams = parse(params, "正负数标记参数不完整。")?;
    let sign_choice = parse_sign_choice(job.sign_convention.as_deref())?;
    let started = Instant::now();
    progress("read", 0, 5, "正在读取凭证数据…");
    let table = load_ledger_cached(
        Path::new(&job.input_path),
        job.sheet.as_deref(),
        job.header_row,
    )?;
    let mapping = job
        .mapping
        .clone()
        .unwrap_or_else(|| suggest_mapping(&table.headers, &table.rows));
    validate_mapping_required(&mapping)?;
    validate_ledger_amounts(&table, &mapping, job.header_row)?;
    let table = preprocess_ledger(table, &mapping, sign_choice)?;
    check_cancel(cancel)?;
    // 口径在全表（列筛选前）定案一次：用户指定 > 凭证投票/列级兜底 > 默认符号一样。
    // 各批次共用同一口径，检测依据也如实回显给前端。
    let id_indexes = ledger_id_indexes(&table.headers, &mapping);
    let report = detect_sign_convention(&table.rows, &table.headers, &mapping, &id_indexes);
    let resolved = sign_choice
        .or(report.detected_convention())
        .unwrap_or(SignConvention::Unsigned);
    progress("filter", 1, 5, "正在按列筛选条件收拢完整凭证…");
    let table = apply_column_filters(table, &mapping, &job.column_filters);
    let batches = je_mark_batches(&job)?;
    let mut outputs = Vec::new();
    let mut batch_results = Vec::new();
    for (batch_index, batch) in batches.iter().enumerate() {
        check_cancel(cancel)?;
        progress(
            "normalize",
            2,
            5,
            &format!("正在处理批次 {}：{}…", batch_index + 1, batch.name),
        );
        let filtered = filter_ledger_rows(&table, &mapping, &batch.accounts, &[])?;
        progress("match", 3, 5, "正在做正负数智能匹配…");
        let analysis = analyze_je_mark(
            &table,
            &mapping,
            &filtered,
            &batch.accounts,
            resolved,
            cancel,
        )?;
        let unmatched = analysis
            .rows
            .iter()
            .filter(|row| row.get(2).is_some_and(|value| value == "未匹配"))
            .count();
        let output = je_mark_batch_output_path(&job, batch, batch_index, batches.len())?;
        progress(
            "write",
            4,
            5,
            &format!("正在写出批次 {}：{}…", batch_index + 1, batch.name),
        );
        let partial = partial_path(&output);
        if output
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("csv"))
        {
            write_csv_table(&partial, &analysis.headers, &analysis.rows, cancel)?;
        } else {
            write_kanzhang_detail_workbook(&partial, &analysis, job.rows_per_sheet, false, cancel)?;
        }
        replace_file(&partial, &output)?;
        outputs.push(output.to_string_lossy().into_owned());
        batch_results.push(json!({
            "name":batch.name,
            "accounts":batch.accounts,
            "rows":analysis.rows.len(),
            "matchedPairs":analysis.je_pairs,
            "crossMatchedPairs":analysis.je_cross_pairs,
            "unmatchedRows":unmatched
        }));
    }
    Ok(json!({
        "engine":"rust-polars",
        "outputPaths":outputs,
        "batchCount":batches.len(),
        "batches":batch_results,
        "mapping":mapping,
        "signConvention":{
            "choice":job.sign_convention.as_deref().unwrap_or("auto"),
            "applied":resolved.as_str(),
            "scheme":report.scheme,
            "detected":report.detected,
            "basis":report.basis,
            "filtered":report.filtered,
            "keySuspect":report.key_suspect,
        },
        "timings":{"totalMs":started.elapsed().as_millis()}
    }))
}

/// 空批次直接跳过；一个有效批次都没有时不该猜用户想标全表。
fn je_mark_batches(job: &JeMarkParams) -> Result<Vec<LedgerBatch>, AppError> {
    let batches = job
        .target_batches
        .iter()
        .filter_map(|batch| {
            let name = batch.name.trim();
            let accounts = dedup_strings(&batch.accounts);
            if name.is_empty() || accounts.is_empty() {
                None
            } else {
                Some(LedgerBatch {
                    name: name.to_owned(),
                    accounts,
                })
            }
        })
        .collect::<Vec<_>>();
    if batches.is_empty() {
        return Err(error(
            "JE_MARK_NO_TARGET",
            "请至少为一个批次选择目标科目。",
            None,
        ));
    }
    Ok(batches)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("audit-toolbox-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }
    /// 账被按科目筛过 vs 凭证识别字段组错——两种成因的提示语完全不同，
    /// 指错方向会让人去查一个根本不存在的映射问题。判据是单边凭证占比。
    #[test]
    fn tells_a_filtered_ledger_apart_from_a_wrong_voucher_key() {
        let headers: Vec<String> = ["凭证号", "科目", "借方", "贷方"]
            .iter()
            .map(|x| (*x).to_string())
            .collect();
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_name: vec!["科目".into()],
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let build = |rows: Vec<Vec<&str>>| {
            let rows: Vec<Vec<String>> = rows
                .into_iter()
                .map(|row| row.into_iter().map(str::to_string).collect())
                .collect();
            detect_sign_convention(&rows, &headers, &mapping, &[0])
        };

        // 只导了银行存款科目：绝大多数凭证只剩单边，另一半被筛掉了。
        let mut filtered_rows = vec![
            vec!["V1", "银行存款", "100", "0"],
            vec!["V1", "银行存款", "0", "100"],
        ];
        for _ in 0..8 {
            filtered_rows.push(vec!["Vx", "银行存款", "50", "0"]);
        }
        let mut rows = filtered_rows.clone();
        for (i, row) in rows.iter_mut().enumerate().skip(2) {
            row[0] = Box::leak(format!("V{}", i + 10).into_boxed_str());
        }
        let report = build(rows);
        assert!(report.filtered, "单边占多数时应判为账被筛过");
        assert!(!report.key_suspect, "不能反过来怪凭证识别字段");

        // 全量账、凭证键组错：凭证被并粗，两边分录都还在，单边极少。
        let rows = vec![
            vec!["V1", "银行存款", "100", "0"],
            vec!["V1", "应收账款", "0", "90"],
            vec!["V2", "银行存款", "0", "30"],
            vec!["V2", "管理费用", "40", "0"],
        ];
        let report = build(rows);
        assert!(!report.filtered, "两边分录都在，不是被筛过");
        assert!(
            report.key_suspect,
            "配不平且几乎没有单边，应怀疑凭证识别字段"
        );
    }

    #[test]
    fn headers_are_stable_and_unique() {
        assert_eq!(
            normalize_headers(&["".into(), "Name".into(), "Name".into()], 3),
            vec!["Column_1", "Name", "Name_2"]
        );
    }
    #[test]
    fn mapping_detects_debit_credit_scheme() {
        let m = suggest_mapping(
            &[
                "凭证号".into(),
                "科目名称".into(),
                "借方金额".into(),
                "贷方金额".into(),
            ],
            &[],
        );
        assert_eq!(m.id, vec!["凭证号"]);
        assert_eq!(m.account_name, vec!["科目名称"]);
        assert!(m.account_code.is_none());
        assert!(m.debit.is_some() && m.credit.is_some());
    }
    #[test]
    fn 单列科目混写形态能建议出科目编码() {
        // 整张表只有一列「科目」，值都是「编码:名称」混写。「科目」不是任何
        // 角色的别名，光看表头这列谁也不认；只有引擎拿数据探测合并列才能把
        // 科目编码补上——存款利息那边的 03 号样例同款形态。
        let headers: Vec<String> = ["凭证号", "科目", "摘要", "借方金额", "贷方金额"]
            .iter()
            .map(|v| (*v).to_string())
            .collect();
        let rows: Vec<Vec<String>> = [
            "1001000000:库存现金",
            "1002000000:银行存款",
            "2202000000:应付账款",
            "6401000000:主营业务收入",
            "6602000000:管理费用",
            "1403000000:原材料",
        ]
        .iter()
        .enumerate()
        .map(|(i, account)| {
            vec![
                format!("记-{i}"),
                (*account).to_string(),
                "付款".into(),
                "100".into(),
                "0".into(),
            ]
        })
        .collect();
        let mapping = suggest_mapping(&headers, &rows);
        assert_eq!(
            mapping.account_code.as_deref(),
            Some("科目"),
            "合并科目列应建议为科目编码"
        );
        assert!(mapping.debit.is_some() && mapping.credit.is_some());
        // 没有数据行时（只剩表头的调用方）引擎无从探测，维持纯表头判定。
        let headers_only = suggest_mapping(&headers, &[]);
        assert!(headers_only.account_code.is_none());
    }
    #[test]
    fn 缓存清理按周期跳过与执行() {
        // 关闭时什么都不做。
        let off = cache_sweep(json!({"mode":"off"})).expect("off 不该报错");
        assert_eq!(off["skipped"], true);
        assert_eq!(off["removed"], 0);

        // 距上次清理不足一个周期就跳过——前端每小时来问一次也只会真跑一次。
        let just_now = chrono::Utc::now().timestamp();
        let fresh =
            cache_sweep(json!({"mode":"daily","lastCleanup":just_now})).expect("daily 不该报错");
        assert_eq!(fresh["skipped"], true, "{fresh:?}");

        // 超过一个周期就执行，并回一个新的时间戳供前端存回设置。
        let long_ago = just_now - 30 * 86_400;
        let due =
            cache_sweep(json!({"mode":"weekly","lastCleanup":long_ago})).expect("weekly 不该报错");
        assert_eq!(due["skipped"], false, "{due:?}");
        assert!(due["cleanedAt"].as_i64().is_some_and(|v| v >= just_now));
        // 认不出的模式按每周处理，不能因为设置里存了脏值就不清理。
        let fallback =
            cache_sweep(json!({"mode":"随便","lastCleanup":long_ago})).expect("未知模式不该报错");
        assert_eq!(fallback["mode"], "随便");
        assert_eq!(fallback["skipped"], false);
    }

    #[test]
    fn 缓存统计给出文件数与占用() {
        let stat = cache_stat(json!({})).expect("统计不该报错");
        assert!(stat["files"].as_u64().is_some());
        assert!(stat["bytes"].as_u64().is_some());
        // 路径要能显示给用户，让他知道清的是哪个目录。
        assert!(!stat["path"].as_str().unwrap_or("").is_empty());
    }

    #[test]
    fn 编码前缀只比编码段不比整串() {
        // 关键的坑：科目值是「编码-名称」拼接串，按第一个连字符切开是不行的——
        // Oracle 的段式科目编码本身就含连字符，切出来的 `01` 毫无意义。
        assert!(matches_code_prefix(
            "01-1002-000",
            "01-1002-000-银行存款",
            &["01-1002".into()]
        ));
        assert!(matches_code_prefix(
            "6401050002",
            "6401050002-营业成本-运费",
            &["6401".into()]
        ));
        // 名称里含 6401 但编码不是 6401 开头的，不该被拉进来。
        assert!(!matches_code_prefix(
            "2241110001",
            "2241110001-其他应付款-6401专项",
            &["6401".into()]
        ));
        // 多个前缀任一命中即可，大小写不敏感。
        assert!(matches_code_prefix(
            "AR1001",
            "AR1001-应收",
            &["6603".into(), "ar10".into()]
        ));
        // 没有映射编码列时退回比对显示值开头，只有名称列的账也能用。
        assert!(matches_code_prefix("", "银行存款-中行", &["银行".into()]));
        assert!(!matches_code_prefix("", "应收账款-A公司", &["银行".into()]));
    }

    #[test]
    fn 前缀串按多种分隔符切开() {
        assert_eq!(parse_code_prefixes("6401,6603"), vec!["6401", "6603"]);
        assert_eq!(
            parse_code_prefixes("6401，6603；1002 2241"),
            vec!["6401", "6603", "1002", "2241"]
        );
        assert_eq!(parse_code_prefixes("  6401  "), vec!["6401"]);
        assert!(parse_code_prefixes("  ,  ; ").is_empty());
    }

    #[test]
    fn 科目清单带出编码供前端做前缀匹配() {
        let table = Table {
            path: PathBuf::new(),
            sheet: "S".into(),
            sheets: vec!["S".into()],
            headers: vec!["会计科目".into(), "科目文本".into()],
            rows: vec![
                vec!["6401050002".into(), "营业成本-运费".into()],
                vec!["6603080001".into(), "销售费用-仓储".into()],
                vec!["6401050001".into(), "营业成本-生产".into()],
            ],
            encoding: None,
            delimiter: None,
        };
        let mapping = LedgerMapping {
            account_code: Some("会计科目".into()),
            account_name: vec!["科目文本".into()],
            ..Default::default()
        };
        let (values, codes, total) = account_values(&table, &mapping, "", &[]);
        assert_eq!(total, 3);
        assert_eq!(values.len(), codes.len(), "编码与显示值必须一一对应");
        assert!(values.iter().all(|v| v.contains('-')));
        // 按 6401 前缀批量筛出两个明细科目。
        let (hit, _, count) = account_values(&table, &mapping, "", &["6401".into()]);
        assert_eq!(count, 2, "{hit:?}");
        assert!(hit.iter().all(|v| v.starts_with("6401")));
        // 关键词与前缀可以叠加。
        let (both, _, n) = account_values(&table, &mapping, "生产", &["6401".into()]);
        assert_eq!(n, 1, "{both:?}");
        // 关键词按编码也能命中——面板把编码拆出来显示后，按编码找是主路径之一。
        let (by_code, _, c) = account_values(&table, &mapping, "660308", &[]);
        assert_eq!(c, 1, "{by_code:?}");
        assert_eq!(by_code, vec!["6603080001-销售费用-仓储".to_string()]);
    }

    #[test]
    fn 多级科目清单带出一级科目名称() {
        let table = Table {
            path: PathBuf::new(),
            sheet: "S".into(),
            sheets: vec!["S".into()],
            headers: vec![
                "科目代码".into(),
                "科目名称一级".into(),
                "科目名称二级".into(),
            ],
            rows: vec![
                vec!["160101".into(), "固定资产".into(), "机器设备".into()],
                vec!["160102".into(), "固定资产".into(), "运输工具".into()],
            ],
            encoding: None,
            delimiter: None,
        };
        let mapping = LedgerMapping {
            account_code: Some("科目代码".into()),
            account_name: vec!["科目名称一级".into(), "科目名称二级".into()],
            ..Default::default()
        };
        let (values, _, _) = account_values(&table, &mapping, "", &[]);
        assert_eq!(
            primary_account_names(&table, &mapping, &values),
            vec!["固定资产", "固定资产"]
        );
    }

    #[test]
    fn 科目编码与名称各归各位() {
        // 4800 那份 SAP 序时账的真实表头：`会计科目` 是编码，`科目文本` 是名称，
        // 拆开之前两列都顶着「科目名称」的角色名。
        let m = suggest_mapping(
            &[
                "凭证号码".into(),
                "会计科目".into(),
                "科目文本".into(),
                "预算二级科目描述".into(),
                "本位币金额".into(),
            ],
            &[],
        );
        assert_eq!(m.account_code.as_deref(), Some("会计科目"));
        assert_eq!(m.account_name, vec!["科目文本"]);
        // 预算科目是冲突词挡下的，绝不能拼进科目键。
        assert!(!m.account_name.iter().any(|v| v.contains("预算")));
        // 科目键的顺序固定：编码在前、名称在后。
        assert_eq!(m.account_columns(), vec!["会计科目", "科目文本"]);
    }

    #[test]
    fn 旧版混在一起的account字段仍能读出科目键() {
        // 老草稿、老任务参数里科目是一个混合数组，反序列化后必须还能拼出同样的科目键。
        let legacy: LedgerMapping = serde_json::from_value(
            json!({"id":["凭证号"],"account":["科目编码","科目名称"],"amount":"金额"}),
        )
        .expect("旧结构可解析");
        assert_eq!(legacy.account_columns(), vec!["科目编码", "科目名称"]);
        assert!(validate_mapping_required(&legacy).is_ok());
        // 新旧字段同时出现时按编码、名称的顺序去重，不会拼出重复列。
        let mixed: LedgerMapping = serde_json::from_value(
            json!({"id":["凭证号"],"accountCode":"科目编码","accountName":["科目名称"],"account":["科目编码","科目名称"],"amount":"金额"}),
        )
        .expect("混合结构可解析");
        assert_eq!(mixed.account_columns(), vec!["科目编码", "科目名称"]);
    }

    #[test]
    fn 看账公共入口拦截金额列非数值() {
        let table = Table {
            path: PathBuf::new(),
            sheet: "Sheet1".to_owned(),
            headers: vec!["凭证号".into(), "科目".into(), "借方".into(), "贷方".into()],
            rows: vec![vec![
                "V1".into(),
                "1001".into(),
                "100".into(),
                "待确认".into(),
            ]],
            sheets: vec![],
            encoding: None,
            delimiter: None,
        };
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            legacy_account: vec!["科目".into()],
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let error = validate_ledger_amounts(&table, &mapping, 1).unwrap_err();
        assert_eq!(error.code, "KANZHANG_AMOUNT_VALUE_INVALID");
        assert!(error.detail.as_deref().unwrap_or("").contains("待确认"));
    }

    #[test]
    fn mapping_recognizes_legacy_entity_headers() {
        for header in ["单位名称", "单位", "BUKRS", "Co Code", "BusinessUnit"] {
            let mapping = suggest_mapping(
                &[
                    "凭证号".into(),
                    "科目名称".into(),
                    header.into(),
                    "金额".into(),
                ],
                &[],
            );
            assert_eq!(mapping.entity.as_deref(), Some(header));
        }
    }
    #[test]
    fn combined_debit_credit_header_is_direction_not_two_amount_columns() {
        let mapping = suggest_mapping(
            &[
                "凭证号".into(),
                "科目名称".into(),
                "Debit_Credit".into(),
                "Functional Amount".into(),
            ],
            &[],
        );
        assert_eq!(mapping.direction.as_deref(), Some("Debit_Credit"));
        assert!(mapping.debit.is_none() && mapping.credit.is_none());
        assert_eq!(mapping.amount.as_deref(), Some("Functional Amount"));
    }
    #[test]
    fn polars_pivot_sums_values() {
        let h = vec!["Manager".into(), "Month".into(), "Hours".into()];
        let r = vec![
            vec!["A".into(), "01".into(), "1.5".into()],
            vec!["A".into(), "01".into(), "2.5".into()],
        ];
        let p = pivot_rows(&h, &r, &["Manager".into()], Some("Month"), "Hours", "sum").unwrap();
        assert_eq!(p.rows[0], vec!["A", "4"]);
    }
    #[test]
    fn ts_export_builds_default_dual_workbook() {
        let root = temp_dir("ts");
        let input = root.join("timesheet.csv");
        let output = root.join("result.xlsx");
        fs::write(&input,"COE Manager,Employee Name,Engagement Name,Transaction Cycle Date,Hours\nM1,Alice,P1,2026-01,2.5\nM1,Alice,P1,2026-01,1.5\n").unwrap();
        let params =
            json!({"inputPath":input,"outputPath":output,"pivotMode":"dual_default","filters":[]});
        let result = export_ts(params, &|_, _, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(result["engine"], "rust-polars");
        let workbook = open_workbook_auto(&output).unwrap();
        assert_eq!(
            workbook.sheet_names(),
            &["by经理".to_string(), "by项目".to_string()]
        );
        let raw = root.join("result_data.csv");
        assert!(raw.is_file());
        assert_eq!(result["rawRows"], 2);
        assert_eq!(result["outputPaths"].as_array().unwrap().len(), 2);
        assert!(fs::read(&raw).unwrap().starts_with(&[0xEF, 0xBB, 0xBF]));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn ts_export_requires_a_user_selected_output_path() {
        let root = temp_dir("ts-output-required");
        let input = root.join("timesheet.csv");
        fs::write(
            &input,
            "COE Manager,Employee Name,Engagement Name,Transaction Cycle Date,Hours\nM1,Alice,P1,2026-01,2.5\n",
        )
        .unwrap();
        let err = export_ts(
            json!({"inputPath":input,"pivotMode":"dual_default","filters":[]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, "TS_OUTPUT_REQUIRED");
        assert!(err.user_message.contains("保存路径"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn ts_filters_are_or_within_field_and_and_across_fields() {
        let table = Table {
            path: PathBuf::new(),
            sheet: "CSV".into(),
            headers: vec!["Department Name".into(), "Month".into(), "Hours".into()],
            rows: vec![
                vec!["A".into(), "01".into(), "1".into()],
                vec!["B".into(), "01".into(), "2".into()],
                vec!["B".into(), "02".into(), "3".into()],
            ],
            sheets: vec![],
            encoding: Some("utf-8".into()),
            delimiter: Some(','),
        };
        let rows = apply_filters(
            &table,
            &[
                FilterSpec {
                    field: "Department Name".into(),
                    values: vec!["A".into(), "B".into()],
                },
                FilterSpec {
                    field: "Month".into(),
                    values: vec!["01".into()],
                },
            ],
        );
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row[1] == "01"));
    }
    #[test]
    fn ts_pivot_rejects_more_than_legacy_column_limit() {
        let headers = vec!["Manager".into(), "Month".into(), "Hours".into()];
        let rows = (0..=TS_MAX_PIVOT_COLUMN_VALUES)
            .map(|index| vec!["M".into(), format!("{index:03}"), "1".into()])
            .collect::<Vec<_>>();
        let err = pivot_rows(
            &headers,
            &rows,
            &["Manager".into()],
            Some("Month"),
            "Hours",
            "sum",
        )
        .unwrap_err();
        assert_eq!(err.code, "TS_PIVOT_TOO_WIDE");
    }
    #[test]
    fn ts_export_populates_and_reuses_stable_parquet_cache() {
        let root = temp_dir("ts-cache");
        let input = root.join("timesheet.csv");
        let first_output = root.join("first.xlsx");
        let second_output = root.join("second.xlsx");
        fs::write(&input,"COE Manager,Employee Name,Engagement Name,Transaction Cycle Date,Hours\nM1,Alice,P1,2026-01,2.5\n").unwrap();
        let first=export_ts(json!({"inputPath":input,"outputPath":first_output,"pivotMode":"dual_default","filters":[]}),&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        assert_eq!(first["cacheHit"], false);
        assert!(Path::new(first["cachePath"].as_str().unwrap()).is_file());
        let second=export_ts(json!({"inputPath":input,"outputPath":second_output,"pivotMode":"dual_default","filters":[]}),&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        assert_eq!(second["cacheHit"], true);
        assert!(second_output.is_file());
        let _ = fs::remove_file(first["cachePath"].as_str().unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn tbje_bridge_uses_the_shared_polars_cache() {
        let root = temp_dir("tbje-polars-cache");
        let input = root.join("journal.csv");
        fs::write(
            &input,
            "凭证号,科目编码,借方,贷方\n1,1001,100,0\n1,6001,0,100\n",
        )
        .unwrap();
        let first = fx_load_ledger_table_value_cached(&input, None, 1).unwrap();
        assert_eq!(first["engine"], "rust-polars");
        assert_eq!(first["rows"].as_array().unwrap().len(), 2);
        let key = fingerprint(&input, "CSV", 1).unwrap();
        let cache = cache_path("ts", &key).unwrap();
        assert!(cache.is_file(), "TBJE 应复用统一的稳定 Parquet 缓存");
        let second = fx_load_ledger_table_value_cached(&input, None, 1).unwrap();
        assert_eq!(second["rows"], first["rows"]);
        let _ = fs::remove_file(cache);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn 未指定表名时按引擎打分挑正表而不是第一张() {
        let root = temp_dir("sheet-score");
        let input = root.join("账簿.xlsx");
        let mut book = Workbook::new();

        // 「透视check」放在最前面——旧逻辑取第一张正好选中它。它的表头甚至
        // 比正表还标准（右半边粘着一份科目余额表），光比表头会选错，只有
        // 规模权重加辅助表名降权能翻盘，与引擎 sheet_score 的样例口径一致。
        let pivot = book.add_worksheet();
        pivot.set_name("透视check").unwrap();
        pivot
            .write_row(
                0,
                0,
                [
                    "科目编码",
                    "科目名称",
                    "期初余额",
                    "借方",
                    "贷方",
                    "期末余额",
                ],
            )
            .unwrap();
        for row in 0..384u32 {
            pivot
                .write_row(
                    row + 1,
                    0,
                    ["1002000000", "银行存款", "100", "0", "50", "50"],
                )
                .unwrap();
        }

        let journal = book.add_worksheet();
        journal.set_name("序时账").unwrap();
        journal
            .write_row(
                0,
                0,
                [
                    "凭证号",
                    "记账日期",
                    "科目编码",
                    "科目名称",
                    "摘要",
                    "借方金额",
                    "贷方金额",
                ],
            )
            .unwrap();
        for row in 0..3_000u32 {
            let voucher = format!("记-{row}");
            journal
                .write_row(
                    row + 1,
                    0,
                    [
                        voucher.as_str(),
                        "2026-01-10",
                        "1002000000",
                        "银行存款",
                        "付款",
                        "100",
                        "0",
                    ],
                )
                .unwrap();
        }
        book.save(&input).unwrap();

        // 未指定表名：自动选几千行的正表，不再被第一张透视副本带走。
        let table = load_table(&input, None, 1).unwrap();
        assert_eq!(table.sheet, "序时账", "规模与表名降权应让正表胜出");
        // 用户显式指定表名：照用，哪怕它是那张小副本。
        let pinned = load_table(&input, Some("透视check"), 1).unwrap();
        assert_eq!(pinned.sheet, "透视check");

        // 自动选表的结论记进缓存目录：同一份文件走缓存化入口结论一致。
        let memo = auto_sheet_memo_path(&input).unwrap();
        assert!(memo.is_file(), "选表结论应记进缓存目录");
        let cached = fx_load_ledger_table_value_cached(&input, None, 1).unwrap();
        assert_eq!(cached["sheet"].as_str().unwrap(), "序时账");
        // 记事文件丢了不阻塞读取：重扫一遍仍是同一张表。
        fs::remove_file(&memo).unwrap();
        let again = load_table(&input, None, 1).unwrap();
        assert_eq!(again.sheet, "序时账");

        // 测试写进真实缓存目录的产物要带走。
        if let Ok(key) = fingerprint(&input, "序时账", 1) {
            let _ = fs::remove_file(cache_path("ts", &key).unwrap());
        }
        let _ = fs::remove_file(auto_sheet_memo_path(&input).unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn 指定不存在的表名时退回自动选表而不是第一张() {
        let root = temp_dir("sheet-missing");
        let input = root.join("账簿.xlsx");
        let mut book = Workbook::new();
        // 第一张是几乎空白的说明页：旧行为（悄悄取第一张）会撞上它，
        // 现在应退回自动选择挑真正的数据表。
        let cover = book.add_worksheet();
        cover.set_name("说明").unwrap();
        cover.write_row(0, 0, ["本表由财务系统导出"]).unwrap();
        let journal = book.add_worksheet();
        journal.set_name("序时账").unwrap();
        journal
            .write_row(
                0,
                0,
                [
                    "凭证号",
                    "记账日期",
                    "科目编码",
                    "科目名称",
                    "摘要",
                    "借方金额",
                    "贷方金额",
                ],
            )
            .unwrap();
        for row in 0..50u32 {
            let voucher = format!("记-{row}");
            journal
                .write_row(
                    row + 1,
                    0,
                    [
                        voucher.as_str(),
                        "2026-01-10",
                        "1002000000",
                        "银行存款",
                        "付款",
                        "100",
                        "0",
                    ],
                )
                .unwrap();
        }
        book.save(&input).unwrap();

        // 未指定表名同样适用：说明页不该再凭「排在第一」当选。
        let auto = load_table(&input, None, 1).unwrap();
        assert_eq!(auto.sheet, "序时账");
        let missing = load_table(&input, Some("不存在"), 1).unwrap();
        assert_eq!(missing.sheet, "序时账");

        let _ = fs::remove_file(auto_sheet_memo_path(&input).unwrap());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn ledger_target_expands_to_complete_voucher() {
        let root = temp_dir("ledger");
        let input = root.join("ledger.csv");
        fs::write(&input,"凭证号,科目名称,借方金额,贷方金额\n1,现金,100,0\n1,收入,0,100\n2,银行,20,0\n2,费用,0,20\n").unwrap();
        let table = load_table(&input, None, 1).unwrap();
        let mapping = suggest_mapping(&table.headers, &table.rows);
        let rows = filter_ledger_rows(&table, &mapping, &["现金".into()], &[]).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|row| row[1] == "收入"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn excluded_accounts_are_separate_and_do_not_damage_complete_voucher() {
        let headers = vec!["凭证号".into(), "科目名称".into(), "金额".into()];
        let rows = vec![
            vec!["1".into(), "收入".into(), "100".into()],
            vec!["1".into(), "折旧".into(), "-100".into()],
        ];
        let table = Table {
            path: PathBuf::new(),
            sheet: "S".into(),
            headers: headers.clone(),
            rows,
            sheets: vec![],
            encoding: None,
            delimiter: None,
        };
        let mapping = suggest_mapping(&headers, &[]);
        let selected =
            filter_ledger_rows(&table, &mapping, &["收入".into()], &["折旧".into()]).unwrap();
        let excluded = excluded_ledger_rows(&table, &mapping, &["折旧".into()]);
        assert_eq!(selected.len(), 2);
        assert_eq!(excluded.len(), 1);
        assert_eq!(excluded[0][1], "折旧");
    }
    #[test]
    fn composite_account_selection_matches_the_joined_account_only() {
        let headers = vec![
            "凭证号".into(),
            "科目编码".into(),
            "科目名称".into(),
            "金额".into(),
        ];
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_code: Some("科目编码".into()),
            account_name: vec!["科目名称".into()],
            amount: Some("金额".into()),
            ..Default::default()
        };
        let table = Table {
            path: PathBuf::new(),
            sheet: "S".into(),
            headers,
            rows: vec![
                vec!["1".into(), "6001".into(), "收入".into(), "100".into()],
                vec!["1".into(), "1001".into(), "银行".into(), "-100".into()],
            ],
            sheets: vec![],
            encoding: None,
            delimiter: None,
        };
        assert_eq!(
            filter_ledger_rows(&table, &mapping, &["6001 - 收入".into()], &[])
                .unwrap()
                .len(),
            2
        );
        assert!(
            filter_ledger_rows(&table, &mapping, &["收入".into()], &[])
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn legacy_date_forms_convert_to_month() {
        assert_eq!(parse_month("20260131").as_deref(), Some("2026-01"));
        assert_eq!(parse_month("2026/02/01").as_deref(), Some("2026-02"));
        assert_eq!(parse_month("46023").as_deref(), Some("2026-01"));
        // 真实底稿里月日不补零的写法也要认，否则整张凭证的月份分布会被丢成 0。
        assert_eq!(parse_month("2026-1-23").as_deref(), Some("2026-01"));
        assert_eq!(parse_month("2026/1/3").as_deref(), Some("2026-01"));
    }

    #[test]
    fn voucher_type_drops_rows_that_are_zero_everywhere_but_keeps_offsetting_months() {
        let mut netted = voucher_info("V1", &[("A", 100.0), ("X", -100.0)], &["A"], &[]);
        // X 全年净额为 0，但 1 月 +50、2 月 -50：这行有内容，必须留。
        netted.account_nets.insert("X".into(), 0.0);
        netted.month_nets.insert(
            "2026-01".into(),
            BTreeMap::from([("A".into(), 100.0), ("X".into(), 50.0)]),
        );
        netted
            .month_nets
            .insert("2026-02".into(), BTreeMap::from([("X".into(), -50.0)]));
        // Y 净额和每个月都是 0，整行没有信息，丢掉。
        netted.account_nets.insert("Y".into(), 0.0);
        let rows = build_voucher_type_rows(&[netted], false, "凭证号").rows;
        let accounts = rows.iter().map(|row| row[3].clone()).collect::<Vec<_>>();
        assert_eq!(accounts, vec!["A".to_owned(), "X".to_owned()]);
        let x = rows.iter().find(|row| row[3] == "X").unwrap();
        assert_eq!(&x[4..], ["0", "50", "-50"]);
    }
    #[test]
    fn ledger_amounts_follow_global_debit_credit_heuristic() {
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "0".into()],
            vec!["1".into(), "B".into(), "0".into(), "100".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let values = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(values.net, vec![100.0, -100.0]);
        assert!(values.allow_cross_match);
    }
    #[test]
    fn je_mark_matched_pairs_net_to_zero_on_positive_credit_ledgers() {
        // 真实脱敏样例暴露的口径错位：借贷分列且贷方为正数时，旧直接配对
        // 口径把贷方记正数——"贷方 100 结转"与"借方 -100 红字冲销"净额同号，
        // 却被配成计提/冲销一对，筛"已匹配"后借贷净额合计 -200 不为零。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["2".into(), "A".into(), "".into(), "100".into()],
            vec!["3".into(), "A".into(), "-100".into(), "".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0, -100.0]);
        let (status, pairs, cross) = match_je_rows(
            &rows,
            &headers,
            &amounts,
            &mapping,
            &[0],
            &[1],
            &HashSet::from(["a".into()]),
            &HashSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((pairs, cross), (1, 0));
        assert_eq!(status[0], "已匹配-计提");
        assert_eq!(status[1], "已匹配-冲销");
        assert_eq!(status[2], "未匹配");
        let matched_net: f64 = status
            .iter()
            .enumerate()
            .filter(|(_, value)| value.contains("已匹配"))
            .map(|(index, _)| amounts.net[index])
            .sum();
        assert!((matched_net - 0.0).abs() < 0.005);
    }
    #[test]
    fn sign_detection_votes_across_all_balanced_vouchers() {
        // 两张借贷齐全的凭证都按「符号一样」配平（Σ借=Σ贷）——投票判为 unsigned。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["1".into(), "B".into(), "".into(), "100".into()],
            vec!["2".into(), "A".into(), "30".into(), "".into()],
            vec!["2".into(), "B".into(), "70".into(), "".into()],
            vec!["2".into(), "C".into(), "".into(), "100".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.scheme, "B");
        assert_eq!(report.detected, Some("unsigned"));
        assert_eq!(report.balanced_vouchers, 2);
        assert!(!report.filtered && !report.key_suspect);
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0, 30.0, 70.0, -100.0]);
    }
    #[test]
    fn sign_detection_votes_signed_when_credit_column_is_negative() {
        // 借贷齐全且 Σ原值=0——贷方带负号，判为 signed，净额即原值。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["1".into(), "B".into(), "".into(), "-100".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.detected, Some("signed"));
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0]);
    }
    #[test]
    fn sign_detection_falls_back_when_ledger_is_filtered() {
        // 筛过的单边账：没有借贷齐全的凭证。贷方多数为负 → 推断已带符号。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["2".into(), "A".into(), "80".into(), "".into()],
            vec!["3".into(), "A".into(), "".into(), "-100".into()],
            vec!["4".into(), "A".into(), "".into(), "-80".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.detected, Some("signed"));
        assert!(report.filtered);
        assert_eq!(report.balanced_vouchers, 0);
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, 80.0, -100.0, -80.0]);
    }
    #[test]
    fn sign_detection_filtered_positive_credit_ledger_stays_unsigned() {
        // 同样是筛过的账，贷方全为正（正数账）→ 推断符号一样，净额=借−贷。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["2".into(), "A".into(), "".into(), "100".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.detected, Some("unsigned"));
        assert!(report.filtered);
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0]);
    }
    #[test]
    fn sign_detection_cross_checks_direction_column() {
        // 方案 A：借贷齐全凭证 Σ金额=0 → signed；无凭证时看负数落点。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "金额".into(),
            "方向".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "借".into()],
            vec!["1".into(), "B".into(), "-100".into(), "贷".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.scheme, "A");
        assert_eq!(report.detected, Some("signed"));
        let amounts = ledger_amounts(&rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0]);
        // 筛过的账：负数集中在借方向（红字）→ 金额为正数、方向列区分借贷。
        let filtered_rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "借".into()],
            vec!["2".into(), "A".into(), "-100".into(), "借".into()],
        ];
        let report = detect_sign_convention(&filtered_rows, &headers, &mapping, &[0]);
        assert!(report.filtered);
        assert_eq!(report.detected, Some("unsigned"));
        let amounts = ledger_amounts(&filtered_rows, &headers, &mapping, &[0], None);
        assert_eq!(amounts.net, vec![100.0, -100.0]);
    }
    #[test]
    fn sign_detection_treats_single_amount_column_as_inherently_signed() {
        let headers = vec!["凭证号".into(), "科目名称".into(), "金额".into()];
        let rows = vec![vec!["1".into(), "A".into(), "100".into()]];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.scheme, "single");
        assert_eq!(report.detected, Some("signed"));
    }
    #[test]
    fn sign_detection_flags_suspect_voucher_keys() {
        // 同一凭证号下塞了两张不相关的凭证（键组错）：借贷齐全却怎么都配不平。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["1".into(), "B".into(), "".into(), "70".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let report = detect_sign_convention(&rows, &headers, &mapping, &[0]);
        assert_eq!(report.unbalanced_vouchers, 1);
        assert!(report.key_suspect);
    }
    #[test]
    fn sign_override_beats_detection() {
        // 正数账被用户指定为「已带符号」：净额不再做借−贷换算。
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "A".into(), "100".into(), "".into()],
            vec!["1".into(), "B".into(), "".into(), "100".into()],
        ];
        let mapping = suggest_mapping(&headers, &[]);
        let amounts = ledger_amounts(
            &rows,
            &headers,
            &mapping,
            &[0],
            Some(SignConvention::Signed),
        );
        assert_eq!(amounts.net, vec![100.0, 100.0]);
    }
    #[test]
    fn je_mark_export_detects_filtered_signed_ledger_and_echoes_convention() {
        // 筛过的账：凭证全是单边行，贷方带负号。兜底判「已带符号」，
        // 配对照常对平，结果里如实回显口径与"账被筛过"。
        let root = temp_dir("je-mark-sign-filtered");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,借方金额,贷方金额
1,预提费用,100,
2,预提费用,80,
3,预提费用,,-100
4,预提费用,,-80
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        let value = export_je_mark(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"预提","accounts":["预提费用"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let sign = &value["signConvention"];
        assert_eq!(sign["scheme"], "B");
        assert_eq!(sign["choice"], "auto");
        assert_eq!(sign["detected"], "signed");
        assert_eq!(sign["applied"], "signed");
        assert_eq!(sign["filtered"], true);
        assert_eq!(value["batches"][0]["matchedPairs"], 2);
        assert_eq!(value["batches"][0]["unmatchedRows"], 0);
        let rows = read_marked_csv(&output);
        // 核销口径与符号列一致：Σ(绝对值×符号)。「已带符号」的账上借贷两列
        // 都带着负号，借−贷会把冲销行算两遍，不能用那个口径核对。
        let matched_net: f64 = rows[1..]
            .iter()
            .filter(|row| row[2].contains("已匹配"))
            .map(|row| {
                let abs: f64 = row[0].trim().parse().unwrap_or(0.0);
                if row[1] == "负数" { -abs } else { abs }
            })
            .sum();
        assert!(matched_net.abs() < 0.005);
    }
    #[test]
    fn je_mark_export_honors_manual_sign_convention() {
        // 同一份筛过的账被指定「借贷符号一样」：贷方负数按借−贷折成正值，
        // 全表无配平对，applied 如实回显用户的选择。
        let root = temp_dir("je-mark-sign-override");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,借方金额,贷方金额
1,预提费用,100,
2,预提费用,,-100
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        let value = export_je_mark(
            json!({"inputPath":input,"outputPath":output,"signConvention":"unsigned",
                "targetBatches":[{"name":"预提","accounts":["预提费用"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let sign = &value["signConvention"];
        assert_eq!(sign["choice"], "unsigned");
        assert_eq!(sign["detected"], "signed");
        assert_eq!(sign["applied"], "unsigned");
        assert_eq!(value["batches"][0]["matchedPairs"], 0);
        assert_eq!(value["batches"][0]["unmatchedRows"], 2);
    }
    #[test]
    fn loss_transfer_marks_whole_voucher_and_is_excluded_from_types() {
        let headers = vec![
            "凭证号".into(),
            "科目名称".into(),
            "借方金额".into(),
            "贷方金额".into(),
        ];
        let rows = vec![
            vec!["1".into(), "本年利润".into(), "100".into(), "0".into()],
            vec!["1".into(), "收入".into(), "0".into(), "100".into()],
            vec!["2".into(), "收入".into(), "50".into(), "0".into()],
            vec!["2".into(), "银行".into(), "0".into(), "50".into()],
        ];
        let table = Table {
            path: PathBuf::new(),
            sheet: "S".into(),
            headers: headers.clone(),
            rows: rows.clone(),
            sheets: vec![],
            encoding: None,
            delimiter: None,
        };
        let mapping = suggest_mapping(&headers, &[]);
        let job: KanzhangParams = serde_json::from_value(
            json!({"inputPath":"x","targetAccounts":["收入"],"includePivot":true}),
        )
        .unwrap();
        let analysis = analyze_ledger(
            &table,
            &mapping,
            &rows,
            &["收入".into()],
            &job,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(analysis.loss_count, 1);
        assert_eq!(
            analysis
                .rows
                .iter()
                .filter(|row| row.contains(&"损益结转".to_owned()))
                .count(),
            2
        );
        assert_eq!(analysis.voucher_type_loose.rows.len(), 2);
        assert!(
            analysis
                .voucher_type_loose
                .rows
                .iter()
                .all(|row| row[1].contains('2'))
        );
    }
    /// 造一张凭证：`accounts` 是「科目 -> 净额」，`targets` 是其中哪些算目标科目。
    fn voucher_info(
        id: &str,
        accounts: &[(&str, f64)],
        targets: &[&str],
        summaries: &[&str],
    ) -> VoucherInfo {
        let account_nets = accounts
            .iter()
            .map(|(account, amount)| ((*account).to_owned(), *amount))
            .collect::<BTreeMap<String, f64>>();
        let mut nonzero_accounts = BTreeSet::new();
        let mut target_signs = BTreeMap::new();
        for (account, amount) in &account_nets {
            if *amount == 0.0 {
                continue;
            }
            nonzero_accounts.insert(account.clone());
            if targets.contains(&account.as_str()) {
                target_signs.insert(account.clone(), if *amount > 0.0 { 1i8 } else { -1i8 });
            }
        }
        VoucherInfo {
            id: id.to_owned(),
            account_nets,
            nonzero_accounts,
            target_signs,
            summaries: summaries.iter().map(|value| (*value).to_owned()).collect(),
            month_nets: BTreeMap::new(),
        }
    }

    /// 每个类型的代表凭证号 -> 成员凭证号，方便断言归并结果。
    fn grouped_ids(infos: &[VoucherInfo], strict: bool) -> Vec<Vec<String>> {
        classify_vouchers(infos, strict)
            .into_iter()
            .map(|group| {
                group
                    .into_iter()
                    .map(|index| infos[index].id.clone())
                    .collect()
            })
            .collect()
    }

    /// 真实底稿的凭证类型比对。默认 `#[ignore]`：样例是客户数据，不入库。
    ///
    /// 跑法（两个环境变量都要给）：
    /// ```text
    /// KANZHANG_PARITY_DETAIL=<旧版导出的 _凭证明细.csv>
    /// KANZHANG_PARITY_EXPECT=<期望值目录，内含 expect_loose.csv / expect_strict.csv / targets.csv>
    /// cargo test kanzhang_voucher_type_matches_legacy_sample -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要本地真实底稿，通过 KANZHANG_PARITY_DETAIL / KANZHANG_PARITY_EXPECT 指定"]
    fn kanzhang_voucher_type_matches_legacy_sample() {
        let Ok(detail) = std::env::var("KANZHANG_PARITY_DETAIL") else {
            panic!("请设置 KANZHANG_PARITY_DETAIL 指向旧版导出的凭证明细 CSV");
        };
        let expect_dir =
            std::env::var("KANZHANG_PARITY_EXPECT").expect("请设置 KANZHANG_PARITY_EXPECT");
        let expect_dir = std::path::PathBuf::from(expect_dir);

        let read_csv = |path: &std::path::Path| -> (Vec<String>, Vec<Vec<String>>) {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|error| panic!("读不到 {}: {error}", path.display()));
            let mut reader = csv::ReaderBuilder::new()
                .flexible(true)
                .from_reader(text.trim_start_matches('\u{feff}').as_bytes());
            let headers = reader
                .headers()
                .unwrap()
                .iter()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let rows = reader
                .records()
                .map(|record| {
                    record
                        .unwrap()
                        .iter()
                        .map(str::to_owned)
                        .collect::<Vec<String>>()
                })
                .collect::<Vec<_>>();
            (headers, rows)
        };

        let (headers, rows) = read_csv(std::path::Path::new(&detail));
        let column = |name: &str| header_index(&headers, name).expect(name);
        let id_indexes = ["公司", "记账日期", "凭证号"]
            .iter()
            .map(|name| column(name))
            .collect::<Vec<_>>();
        let account_indexes = vec![column("科目名称")];
        let (debit, credit) = (column("借方"), column("贷方"));
        let amounts = rows
            .iter()
            .map(|row| parse_number(&row[debit]) - parse_number(&row[credit]))
            .collect::<Vec<_>>();
        let loss_column = column("【损益结转】");
        let loss_ids = rows
            .iter()
            .filter(|row| row[loss_column].trim() == "损益结转")
            .map(|row| voucher_key(row, &id_indexes))
            .collect::<HashSet<_>>();
        let (_, target_rows) = read_csv(&expect_dir.join("targets.csv"));
        let targets = target_rows
            .iter()
            .filter_map(|row| row.first())
            .filter(|value| !value.trim().is_empty())
            .map(|value| normalize_account_text(value.trim()))
            .collect::<HashSet<_>>();
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_name: vec!["科目名称".into()],
            entity: Some("公司".into()),
            date: Some("记账日期".into()),
            summary: Some("ZY".into()),
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let infos = voucher_infos(
            &rows,
            &headers,
            &amounts,
            &mapping,
            &id_indexes,
            &account_indexes,
            &targets,
            &loss_ids,
        );

        for (strict, file) in [(false, "expect_loose.csv"), (true, "expect_strict.csv")] {
            let actual = build_voucher_type_rows(&infos, strict, "公司-记账日期-凭证号");
            let (expect_headers, expect_rows) = read_csv(&expect_dir.join(file));
            assert_eq!(actual.headers, expect_headers, "{file}: 表头不一致");
            assert_eq!(
                actual.rows.len(),
                expect_rows.len(),
                "{file}: 行数 {} != 期望 {}",
                actual.rows.len(),
                expect_rows.len()
            );
            for (index, (got, want)) in actual.rows.iter().zip(expect_rows.iter()).enumerate() {
                assert_eq!(got, want, "{file}: 第 {} 行不一致", index + 1);
            }
        }
    }

    #[test]
    fn voucher_type_loose_and_strict_have_expected_difference() {
        let infos = vec![
            voucher_info("V1", &[("A", 100.0), ("X", -100.0)], &["A"], &["计提"]),
            voucher_info("V2", &[("A", 200.0), ("Y", -200.0)], &["A"], &["追加"]),
        ];
        let loose = build_voucher_type_rows(&infos, false, "唯一识别码");
        let strict = build_voucher_type_rows(&infos, true, "唯一识别码");
        assert_eq!(loose.rows.len(), 3);
        assert!(loose.rows.iter().all(|row| row[0] == "A-类型1"));
        assert_eq!(strict.rows.len(), 4);
        assert_eq!(
            strict
                .rows
                .iter()
                .map(|row| row[0].clone())
                .collect::<BTreeSet<_>>()
                .len(),
            2
        );
    }

    #[test]
    fn voucher_type_loose_merges_same_target_set_only_when_signs_agree() {
        let infos = vec![
            voucher_info("V1", &[("A", 100.0), ("X", -100.0)], &["A"], &[]),
            voucher_info("V2", &[("A", 200.0), ("Y", -200.0)], &["A"], &[]),
            // A 方向相反，不能和上面两张并成同一类型。
            voucher_info("V3", &[("A", -50.0), ("Z", 50.0)], &["A"], &[]),
        ];
        assert_eq!(
            grouped_ids(&infos, false),
            vec![
                vec!["V1".to_owned(), "V2".to_owned()],
                vec!["V3".to_owned()]
            ]
        );
    }

    #[test]
    fn voucher_type_leaves_ambiguous_voucher_in_its_own_group() {
        // 基准集合是 {A}，但 {A} 上挂着两个方向互斥的基准组（B 一正一负）。
        // 只带 A 的 V3 对两个组都兼容——旧版遇到这种歧义宁可让它单独成一类。
        let infos = vec![
            voucher_info(
                "V1",
                &[("A", 100.0), ("B", 50.0), ("X", -150.0)],
                &["A", "B"],
                &[],
            ),
            voucher_info(
                "V2",
                &[("A", 100.0), ("B", -50.0), ("Y", -50.0)],
                &["A", "B"],
                &[],
            ),
            voucher_info("V3", &[("A", 100.0), ("Z", -100.0)], &["A"], &[]),
        ];
        assert_eq!(
            grouped_ids(&infos, false),
            vec![
                vec!["V1".to_owned()],
                vec!["V2".to_owned()],
                vec!["V3".to_owned()],
            ]
        );
    }

    #[test]
    fn voucher_type_strict_splits_by_target_count_where_loose_merges() {
        let infos = vec![
            // 两个目标科目：严格模式走目标科目集合。
            voucher_info(
                "V1",
                &[("A", 100.0), ("B", 100.0), ("X", -200.0)],
                &["A", "B"],
                &[],
            ),
            // 单个目标科目：严格模式改走全科目集合，因此和 V1 分开。
            voucher_info("V2", &[("A", 100.0), ("X", -100.0)], &["A"], &[]),
            voucher_info("V3", &[("A", 300.0), ("X", -300.0)], &["A"], &[]),
        ];
        assert_eq!(
            grouped_ids(&infos, true),
            vec![
                vec!["V1".to_owned()],
                vec!["V2".to_owned(), "V3".to_owned()],
            ]
        );
        // 宽松模式只看目标科目集合 {A}，三张全归一类。
        assert_eq!(
            grouped_ids(&infos, false),
            vec![vec!["V1".to_owned(), "V2".to_owned(), "V3".to_owned()]]
        );
    }

    #[test]
    fn voucher_type_representative_follows_ledger_order_not_id_order() {
        // 凭证号倒着排：代表凭证必须是底稿里先出现的 V9，而不是字典序最小的 V1。
        let headers = vec![
            "凭证号".to_owned(),
            "科目名称".to_owned(),
            "借方".to_owned(),
            "贷方".to_owned(),
            "ZY".to_owned(),
        ];
        let rows = [
            ["V9", "A", "100", "", "先来"],
            ["V9", "X", "", "100", "先来"],
            ["V1", "A", "200", "", "后到"],
            ["V1", "X", "", "200", "后到"],
        ]
        .iter()
        .map(|row| row.iter().map(|value| (*value).to_owned()).collect())
        .collect::<Vec<Vec<String>>>();
        let amounts = rows
            .iter()
            .map(|row| parse_number(&row[2]) - parse_number(&row[3]))
            .collect::<Vec<_>>();
        let mapping = LedgerMapping {
            id: vec!["凭证号".into()],
            account_name: vec!["科目名称".into()],
            summary: Some("ZY".into()),
            debit: Some("借方".into()),
            credit: Some("贷方".into()),
            ..Default::default()
        };
        let infos = voucher_infos(
            &rows,
            &headers,
            &amounts,
            &mapping,
            &[0],
            &[1],
            &HashSet::from(["a".to_owned()]),
            &HashSet::new(),
        );
        assert_eq!(
            infos
                .iter()
                .map(|info| info.id.as_str())
                .collect::<Vec<_>>(),
            vec!["V9", "V1"]
        );
        let loose = build_voucher_type_rows(&infos, false, "凭证号");
        assert!(loose.rows.iter().all(|row| row[1] == "V9"));
        assert!(loose.rows.iter().all(|row| row[2] == "先来 | 后到"));
        // 净额按类型汇总：A 300、X -300。
        let nets = loose
            .rows
            .iter()
            .map(|row| (row[3].clone(), row[4].clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            nets,
            BTreeMap::from([
                ("A".to_owned(), "300".to_owned()),
                ("X".to_owned(), "-300".to_owned()),
            ])
        );
    }

    #[test]
    fn voucher_type_numbers_are_ranked_by_sorted_representative_id() {
        // 三个互不相容的方向组合 → 三个类型；「类型N」按代表凭证号排序编号，
        // 与分组的遍历顺序无关：先出现的 V3 反而是「类型3」。
        let infos = vec![
            voucher_info(
                "V3",
                &[("A", 100.0), ("B", 100.0), ("X", -200.0)],
                &["A", "B"],
                &[],
            ),
            voucher_info(
                "V2",
                &[("A", 100.0), ("B", -100.0), ("X", 0.0)],
                &["A", "B"],
                &[],
            ),
            voucher_info(
                "V1",
                &[("A", -100.0), ("B", 100.0), ("X", 0.0)],
                &["A", "B"],
                &[],
            ),
        ];
        assert_eq!(grouped_ids(&infos, false).len(), 3);
        let loose = build_voucher_type_rows(&infos, false, "凭证号");
        let labels = loose
            .rows
            .iter()
            .map(|row| (row[1].clone(), row[0].clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            labels,
            BTreeMap::from([
                ("V1".to_owned(), "A-类型1 | B-类型1".to_owned()),
                ("V2".to_owned(), "A-类型2 | B-类型2".to_owned()),
                ("V3".to_owned(), "A-类型3 | B-类型3".to_owned()),
            ])
        );
    }

    #[test]
    fn voucher_type_rows_sort_by_leading_account_then_type_number_descending() {
        let infos = vec![
            voucher_info("V1", &[("乙", 100.0), ("X", -100.0)], &["乙"], &[]),
            voucher_info("V2", &[("甲", 100.0), ("X", -100.0)], &["甲"], &[]),
            voucher_info("V3", &[("甲", -100.0), ("X", 100.0)], &["甲"], &[]),
        ];
        let loose = build_voucher_type_rows(&infos, false, "凭证号");
        let order = loose
            .rows
            .iter()
            .map(|row| format!("{}/{}", row[0], row[3]))
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            vec![
                "甲-类型2/X",
                "甲-类型2/甲",
                "甲-类型1/X",
                "甲-类型1/甲",
                "乙-类型1/X",
                "乙-类型1/乙",
            ]
        );
    }
    #[test]
    fn je_matching_supports_direct_and_cross_voucher_pairs() {
        let headers = vec!["凭证号".into(), "科目名称".into(), "金额".into()];
        let mapping = suggest_mapping(&headers, &[]);
        let direct_rows = vec![
            vec!["1".into(), "A".into(), "100".into()],
            vec!["2".into(), "A".into(), "-100".into()],
        ];
        let direct_amounts = ledger_amounts(&direct_rows, &headers, &mapping, &[0], None);
        let (status, pairs, cross) = match_je_rows(
            &direct_rows,
            &headers,
            &direct_amounts,
            &mapping,
            &[0],
            &[1],
            &HashSet::from(["a".into()]),
            &HashSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((pairs, cross), (1, 0));
        assert_eq!(status, vec!["已匹配-计提", "已匹配-冲销"]);
        let cross_rows = vec![
            vec!["1".into(), "A".into(), "60".into()],
            vec!["1".into(), "A".into(), "40".into()],
            vec!["2".into(), "A".into(), "-100".into()],
        ];
        let cross_amounts = ledger_amounts(&cross_rows, &headers, &mapping, &[0], None);
        let (status, pairs, cross) = match_je_rows(
            &cross_rows,
            &headers,
            &cross_amounts,
            &mapping,
            &[0],
            &[1],
            &HashSet::from(["a".into()]),
            &HashSet::new(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((pairs, cross), (0, 1));
        assert!(status.iter().all(|value| value.starts_with("跨行已匹配")));
    }
    /// 读回导出的 CSV：去掉 BOM，按行拆成单元格。
    fn read_marked_csv(path: &Path) -> Vec<Vec<String>> {
        let text = fs::read_to_string(path).unwrap();
        let text = text.trim_start_matches('\u{feff}');
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.split(',').map(str::to_owned).collect())
            .collect()
    }
    #[test]
    fn je_mark_exports_whole_vouchers_and_marks_only_target_rows() {
        let root = temp_dir("je-mark-detail");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,金额,部门
1,预提费用,100,生产部
1,银行存款,-100,生产部
2,预提费用,-100,销售部
2,银行存款,100,销售部
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        let value = export_je_mark(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"预提","accounts":["预提费用"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(value["batches"][0]["matchedPairs"], 1);
        assert_eq!(value["batches"][0]["unmatchedRows"], 0);
        let rows = read_marked_csv(&output);
        // 辅助列在最前，损益结转列已随功能一并移除。
        assert_eq!(
            rows[0][..4].to_vec(),
            vec![
                "【辅助_绝对值】",
                "【辅助_符号】",
                "【智能匹配状态】",
                "凭证号"
            ]
        );
        // 对方科目行照常输出——凭证是完整的，只是三列留空。
        assert_eq!(rows.len(), 5);
        let by_account = |account: &str| {
            rows.iter()
                .filter(|row| row[4] == account)
                .cloned()
                .collect::<Vec<_>>()
        };
        let target = by_account("预提费用");
        assert_eq!(target.len(), 2);
        assert_eq!(target[0][1], "正数");
        assert_eq!(target[0][2], "已匹配-计提");
        assert_eq!(target[1][1], "负数");
        assert_eq!(target[1][2], "已匹配-冲销");
        let other = by_account("银行存款");
        assert_eq!(other.len(), 2);
        assert!(
            other
                .iter()
                .all(|row| row[..3].iter().all(String::is_empty))
        );
    }
    #[test]
    fn je_mark_column_filters_keep_vouchers_whole() {
        let root = temp_dir("je-mark-filter");
        let input = root.join("ledger.csv");
        // 对方科目行的部门留空：按行筛会把它裁掉、凭证失衡，按凭证筛则整张保留。
        fs::write(
            &input,
            "凭证号,科目名称,金额,部门
1,预提费用,100,生产部
1,银行存款,-100,
2,预提费用,-100,销售部
2,银行存款,100,销售部
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        export_je_mark(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"预提","accounts":["预提费用"]}],
                "columnFilters":[{"field":"部门","values":["生产部"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let rows = read_marked_csv(&output);
        assert_eq!(rows.len(), 3, "只应保留凭证 1 的完整两行：{rows:?}");
        assert!(rows[1..].iter().all(|row| row[3] == "1"));
    }
    #[test]
    fn je_mark_does_not_exclude_profit_transfer_vouchers() {
        let root = temp_dir("je-mark-loss");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,金额
1,管理费用,100
1,银行存款,-100
2,管理费用,-100
2,本年利润,100
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        let value = export_je_mark(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"管理费用","accounts":["管理费用"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        // 看账会把含本年利润的整张凭证挡在匹配外，这里照常配对——损益结转识别已移除。
        assert_eq!(value["batches"][0]["matchedPairs"], 1);
        let rows = read_marked_csv(&output);
        let statuses = rows[1..]
            .iter()
            .filter(|row| row[4] == "管理费用")
            .map(|row| row[2].clone())
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec!["已匹配-计提", "已匹配-冲销"]);
    }
    #[test]
    fn je_mark_requires_a_target_batch() {
        let root = temp_dir("je-mark-empty");
        let input = root.join("ledger.csv");
        fs::write(&input, "凭证号,科目名称,金额\n1,预提费用,100\n").unwrap();
        let error = export_je_mark(
            json!({"inputPath":input,"targetBatches":[{"name":"批次1","accounts":[]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, "JE_MARK_NO_TARGET");
    }
    #[test]
    fn je_mark_multi_batches_write_one_file_each() {
        let root = temp_dir("je-mark-batches");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,金额
1,预提费用,100
1,银行存款,-100
2,应付账款,-50
2,银行存款,50
",
        )
        .unwrap();
        let output = root.join("marked.csv");
        let value = export_je_mark(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[
                    {"name":"预提","accounts":["预提费用"]},
                    {"name":"应付","accounts":["应付账款"]}]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let outputs = value["outputPaths"].as_array().unwrap();
        assert_eq!(outputs.len(), 2, "{outputs:?}");
        assert!(outputs[1].as_str().unwrap().contains("应付"));
    }
    #[test]
    fn je_mark_column_values_lists_any_column() {
        let root = temp_dir("je-mark-values");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,科目名称,部门\n1,预提费用,生产部\n2,预提费用,\n3,预提费用,销售部\n",
        )
        .unwrap();
        let value =
            kanzhang_column_values(json!({"inputPath":input,"field":"部门","limit":10})).unwrap();
        let values = value["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        // 空值以 <空白> 呈现，勾选它等价于筛空值行——与 TS 的列筛选同一口径。
        assert!(values.contains(&"<空白>".to_owned()), "{values:?}");
        assert!(values.contains(&"生产部".to_owned()));
        assert_eq!(value["truncated"], false);
    }
    #[test]
    fn kanzhang_pivot_value_fields_are_selectable() {
        let root = temp_dir("kanzhang-pivot-values");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,日期,摘要,科目名称,借方金额,贷方金额
1,2026-01-10,销售,收入,100,0
1,2026-01-10,销售,银行,0,100
",
        )
        .unwrap();
        let run = |values: Value| {
            let output = root.join(format!("out-{}.xlsx", values.to_string().len()));
            export_kanzhang(
                json!({"inputPath":input,"outputPath":output,
                    "targetBatches":[{"name":"收入","accounts":["收入"]}],
                    "includePivot":true,"pivotRows":["科目名称"],"pivotValues":values}),
                &|_, _, _, _| {},
                &AtomicBool::new(false),
            )
            .unwrap();
            let suite = root.join(format!(
                "{}_套表.xlsx",
                output.file_stem().unwrap().to_string_lossy()
            ));
            let mut workbook = open_workbook_auto(&suite).unwrap();
            workbook
                .worksheet_range("透视分析")
                .unwrap()
                .rows()
                .next()
                .unwrap()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        };

        // 留空 = 旧口径：单列净额。
        assert_eq!(run(json!([])), ["科目名称", "#_净额(Net)"]);
        // 显式选净额和留空等价——界面上现在能直接选它。
        assert_eq!(run(json!([NET_VALUE_FIELD])), ["科目名称", "#_净额(Net)"]);
        // 选普通列：按该列取数，列名即字段名。
        assert_eq!(run(json!(["借方金额"])), ["科目名称", "借方金额"]);
        // 多值字段各占一列，不会被合并求和。
        assert_eq!(
            run(json!(["借方金额", "贷方金额"])),
            ["科目名称", "借方金额", "贷方金额"]
        );
        // 净额与普通列同选时净额不再被丢掉。
        assert_eq!(
            run(json!([NET_VALUE_FIELD, "借方金额"])),
            ["科目名称", "#_净额(Net)", "借方金额"]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn kanzhang_pivot_column_names_join_column_and_value_like_legacy() {
        let root = temp_dir("kanzhang-pivot-colnames");
        let input = root.join("ledger.csv");
        fs::write(
            &input,
            "凭证号,日期,摘要,科目名称,借方金额,贷方金额
1,2026-01-10,销售,收入,100,0
1,2026-01-10,销售,银行,0,100
2,2026-02-10,销售,收入,50,0
2,2026-02-10,销售,银行,0,50
",
        )
        .unwrap();
        let output = root.join("out.xlsx");
        export_kanzhang(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"收入","accounts":["收入"]}],
                "includePivot":true,"pivotRows":["科目名称"],"pivotColumns":["日期"]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut workbook = open_workbook_auto(root.join("out_套表.xlsx")).unwrap();
        let headers = workbook
            .worksheet_range("透视分析")
            .unwrap()
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        // 旧版列名是「列字段-值字段」，单值字段时也照拼。
        assert_eq!(
            headers,
            [
                "科目名称",
                "合计",
                "2026-01-#_净额(Net)",
                "2026-02-#_净额(Net)"
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn kanzhang_export_writes_advanced_sheets_and_multiple_batches() {
        let root = temp_dir("kanzhang-advanced");
        let input = root.join("ledger.csv");
        let output = root.join("result.xlsx");
        fs::write(&input,"凭证号,日期,摘要,科目名称,借方金额,贷方金额\n1,2026-01-10,销售,收入,100,0\n1,2026-01-10,销售,银行,0,100\n2,2026-02-10,采购,成本,50,0\n2,2026-02-10,采购,银行,0,50\n").unwrap();
        let result=export_kanzhang(json!({"inputPath":input,"outputPath":output,"targetBatches":[{"name":"收入","accounts":["收入"]},{"name":"成本","accounts":["成本"]}],"excludeAccounts":["银行"],"includePivot":true,"includeVoucherTypes":true,"markLossTransfer":true,"pivotRows":["科目名称"],"pivotColumns":["日期"]}),&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        assert_eq!(result["batchCount"], 2);
        assert!(output.exists());
        assert!(root.join("result_成本_02.xlsx").exists());
        // 与旧版两阶段导出一致：明细一个文件、套表另一个文件，套表里不再夹带明细。
        let workbook = open_workbook_auto(&output).unwrap();
        // 明细簿也带 `_targets`：命中目标科目的加粗是条件格式，公式要在同一个工作簿里取值。
        assert_eq!(
            workbook.sheet_names(),
            &["凭证明细", "剔除明细", "_targets"]
        );
        let suite = open_workbook_auto(root.join("result_套表.xlsx")).unwrap();
        // 页签顺序照旧版：凭证 → 两张凭证类型 → 透视分析；新增的「科目汇总」排在其后。
        assert_eq!(
            suite.sheet_names(),
            &[
                "凭证",
                "凭证类型-宽松",
                "凭证类型-严格",
                "透视分析",
                "科目汇总",
                // 旧版套表里记录目标科目的隐藏页
                "_targets"
            ]
        );
        assert!(root.join("result_成本_02_套表.xlsx").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kanzhang_detail_keeps_only_the_loss_transfer_aux_column() {
        let root = temp_dir("kanzhang-aux-columns");
        let input = root.join("ledger.csv");
        let output = root.join("out.csv");
        fs::write(
            &input,
            "公司,记账日期,凭证号,科目名称,借方金额,贷方金额\n\
             甲公司,2026-01-10,0001,收入,0,100\n\
             甲公司,2026-01-10,0001,银行,100,0\n",
        )
        .unwrap();
        export_kanzhang(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"收入","accounts":["收入"]}],
                "includePivot":false,"includeVoucherTypes":false,
                "markLossTransfer":true,"llmAnalysis":false}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let text = fs::read_to_string(root.join("out_凭证明细.csv")).unwrap();
        let mut lines = text.lines();
        let header = lines.next().unwrap().trim_start_matches('\u{feff}');
        // 辅助列仍在最前，但绝对值/符号/智能匹配状态三列已剪到「正负数智能标记」，
        // 看账只剩损益结转一列。
        assert!(
            header.starts_with("【损益结转】,公司,记账日期,凭证号,科目名称"),
            "{header}"
        );
        for column in ["【辅助_绝对值】", "【辅助_符号】", "【智能匹配状态】"]
        {
            assert!(!header.contains(column), "看账不该再有 {column}：{header}");
        }
        let rows = lines
            .map(|line| line.split(',').map(str::to_owned).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        // 命中目标科目的整张凭证照常输出，对方科目行也在。
        assert!(rows.iter().any(|r| r[4] == "收入"));
        assert!(rows.iter().any(|r| r[4] == "银行"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kanzhang_formatting_helpers_match_legacy_rules() {
        // 列宽按内容算，中日韩字符按两个字符宽——「科目名称」这种表头折半后只有 6 宽，
        // 装不下二十多个汉字的全路径科目名。
        assert_eq!(cell_display_width("abc"), 3);
        assert_eq!(cell_display_width("科目名称"), 8);
        let headers = vec!["科目名称".to_string(), "净额".to_string()];
        let rows = vec![vec![
            "主营业务成本_自营_收销成本_二手车代销成本_居间成本".to_string(),
            "-18415.09".to_string(),
        ]];
        let widths = autofit_column_widths(&headers, &rows, 52.0);
        assert!(widths[0] > 40.0, "长科目名要撑开列宽，实际 {widths:?}");
        assert!(widths[1] >= 8.0 && widths[1] < 14.0, "{widths:?}");
        // 上限要兜住超长摘要
        let long = vec![vec!["摘".repeat(400), String::new()]];
        assert_eq!(autofit_column_widths(&headers, &long, 52.0)[0], 52.0);

        assert_eq!(column_letter(0), "A");
        assert_eq!(column_letter(25), "Z");
        assert_eq!(column_letter(26), "AA");
        assert!(is_month_header("2025-01"));
        assert!(!is_month_header("2025-1"));
        assert!(!is_month_header("科目名称"));
        // 按第一列分组，奇数组铺灰底
        assert_eq!(
            group_band_flags(&[
                vec!["甲".into()],
                vec!["甲".into()],
                vec!["乙".into()],
                vec!["丙".into()],
            ]),
            vec![false, false, true, false]
        );
        assert_eq!(
            normalized_target_display("管理费用 - 差旅费"),
            "管理费用-差旅费"
        );
        let rule = target_bold_rule("'_targets'!$B$1:$B$3", &[3]).unwrap();
        assert!(
            rule.starts_with("COUNTIF('_targets'!$B$1:$B$3,SUBSTITUTE("),
            "{rule}"
        );
        assert!(rule.contains("D2"), "{rule}");
        assert!(target_bold_rule("'_targets'!$B$1:$B$3", &[]).is_none());

        let voucher_type = PivotResult {
            headers: vec![
                "科目名称-类型".into(),
                "单位名称-日期-凭证号".into(),
                "摘要".into(),
                "科目名称".into(),
                "#_净额(Net)".into(),
                "2026-01".into(),
            ],
            rows: vec![vec![
                "销售费用-职工薪酬-类型 123".into(),
                "某有限公司-2026-01-000001".into(),
                "这是一段很长的凭证摘要文本，用于验证不再把文本列完全撑开".into(),
                "销售费用-职工薪酬-职工工资".into(),
                "123456789.12".into(),
                "-9876543.21".into(),
            ]],
            row_field_count: 4,
        };
        let full = autofit_column_widths(&voucher_type.headers, &voucher_type.rows, 52.0);
        let compact = pivot_column_widths(&voucher_type, PivotSheetKind::VoucherType);
        for index in 0..4 {
            assert_eq!(compact[index], (full[index] / 3.0).max(8.0));
        }
        assert_eq!(&compact[4..], &full[4..], "数字列仍应按内容自适应");
    }

    #[test]
    fn kanzhang_voucher_pivot_preserves_direction_columns_like_legacy() {
        let headers = vec![
            "公司".into(),
            "日期".into(),
            "凭证号".into(),
            "科目名称".into(),
            "金额".into(),
            "方向".into(),
        ];
        let rows = vec![
            vec![
                "A".into(),
                "2026-01-01".into(),
                "1".into(),
                "银行".into(),
                "100".into(),
                "借".into(),
            ],
            vec![
                "A".into(),
                "2026-01-01".into(),
                "1".into(),
                "银行".into(),
                "260".into(),
                "贷".into(),
            ],
            vec![
                "A".into(),
                "2026-01-01".into(),
                "1".into(),
                "费用".into(),
                "160".into(),
                "借".into(),
            ],
        ];
        let mapping = LedgerMapping {
            direction: Some("方向".into()),
            ..LedgerMapping::default()
        };
        let pivot = build_voucher_pivot_rust(
            &rows,
            &[100.0, -260.0, 160.0],
            &headers,
            &mapping,
            &[0, 1, 2],
            &[3],
            "公司-日期-凭证号",
        )
        .unwrap();
        assert_eq!(
            pivot.headers,
            vec!["公司-日期-凭证号", "科目名称", "借", "贷"]
        );
        assert_eq!(
            pivot.rows,
            vec![
                vec!["A-2026-01-01-1", "费用", "160", "0"],
                vec!["A-2026-01-01-1", "银行", "100", "-260"],
            ]
        );
    }

    #[test]
    fn kanzhang_suite_applies_legacy_workbook_formatting() {
        let root = temp_dir("kanzhang-formatting");
        let input = root.join("ledger.csv");
        let output = root.join("out.xlsx");
        // 同一张凭证摊成两行（收入 + 银行），识别码列应被纵向合并。
        fs::write(
            &input,
            "公司,记账日期,凭证号,科目名称,借方金额,贷方金额\n\
             甲公司,2026-01-10,0001,收入,0,100\n\
             甲公司,2026-01-10,0001,银行,100,0\n\
             甲公司,2026-02-10,0002,成本,50,0\n\
             甲公司,2026-02-10,0002,银行,0,50\n",
        )
        .unwrap();
        export_kanzhang(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"收入","accounts":["收入","成本"]}],
                "includePivot":true,"includeVoucherTypes":true,"llmAnalysis":false,
                "pivotRows":["科目名称"],"pivotColumns":["记账日期"]}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();

        let suite = root.join("out_套表.xlsx");
        let xml = read_sheet_xml(&suite, "xl/worksheets/sheet2.xml");
        // 凭证类型-宽松：识别码列合并 + 冻结首行（不再锁前九列）+ 不折叠中段列
        assert!(xml.contains("<mergeCell"), "识别码列应有纵向合并");
        assert!(
            xml.contains(r#"topLeftCell="A2""#),
            "应只冻结首行，实际 pane: {:?}",
            xml.split("<pane").nth(1).map(|v| &v[..v.len().min(120)])
        );
        assert!(!xml.contains("outlineLevel"), "看账套表不应折叠列");
        // 条件格式：命中目标科目的行加粗
        assert!(
            xml.contains("<conditionalFormatting"),
            "缺少目标科目加粗规则"
        );
        assert!(
            xml.contains("COUNTIF"),
            "加粗规则应基于 _targets 的 COUNTIF"
        );
        // 「凭证」是中间底稿，旧版隐藏它。工作簿默认把第一张表当活动表、
        // 活动表又不能隐藏，所以必须显式激活一张可见表，否则这里会退回 visible。
        let book_xml = read_sheet_xml(&suite, "xl/workbook.xml");
        let voucher_entry = book_xml
            .split("<sheet ")
            .find(|chunk| chunk.starts_with(r#"name="凭证""#))
            .unwrap_or_default();
        assert!(
            voucher_entry.contains(r#"state="hidden""#),
            "「凭证」应隐藏，实际 {voucher_entry:?}"
        );

        let mut book = open_workbook_auto(&suite).unwrap();
        assert!(
            book.sheet_names().iter().any(|name| name == "_targets"),
            "{:?}",
            book.sheet_names()
        );
        let targets = book.worksheet_range("_targets").unwrap();
        let listed = targets
            .rows()
            .map(|row| row[0].to_string())
            .collect::<Vec<_>>();
        // A 列是原始科目名（不是归一化后的小写值）
        assert_eq!(listed, vec!["成本".to_string(), "收入".to_string()]);
        let _ = fs::remove_dir_all(root);
    }

    /// 直接读 xlsx 里某张 sheet 的 XML——calamine 只给单元格值，读不到合并、
    /// 冻结窗格和条件格式这些版式信息。
    fn read_sheet_xml(path: &Path, entry: &str) -> String {
        let file = File::open(path).unwrap();
        // 绝对路径：polars 的 prelude 也导出了名为 zip 的项，会挡住 crate 名。
        let mut zip = ::zip::ZipArchive::new(file).unwrap();
        let mut text = String::new();
        use std::io::Read;
        zip.by_name(entry)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    }

    #[test]
    fn kanzhang_detail_shades_aux_columns_and_widens_by_content() {
        let root = temp_dir("kanzhang-detail-format");
        let input = root.join("ledger.csv");
        let output = root.join("out.xlsx");
        fs::write(
            &input,
            "公司,记账日期,凭证号,科目名称,借方金额,贷方金额\n\
             甲公司,2026-01-10,0001,主营业务成本_自营_收销成本_二手车代销成本_居间成本,0,100\n\
             甲公司,2026-01-10,0001,银行,100,0\n",
        )
        .unwrap();
        export_kanzhang(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"成本","accounts":["主营业务成本_自营_收销成本_二手车代销成本_居间成本"]}],
                "includePivot":false,"includeVoucherTypes":false,"llmAnalysis":false,
                "markLossTransfer":true}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let xml = read_sheet_xml(&output, "xl/worksheets/sheet1.xml");
        // 列宽自适应：长科目名那一列应明显宽于默认。辅助列只剩【损益结转】后
        // 它落在第 5 列（1 基）。
        let widths = xml
            .split("<col ")
            .skip(1)
            .filter_map(|chunk| {
                let min = chunk
                    .split("min=\"")
                    .nth(1)?
                    .split('"')
                    .next()?
                    .parse::<usize>()
                    .ok()?;
                let width = chunk
                    .split("width=\"")
                    .nth(1)?
                    .split('"')
                    .next()?
                    .parse::<f64>()
                    .ok()?;
                Some((min, width))
            })
            .collect::<Vec<_>>();
        let account_width = widths.iter().find(|(min, _)| *min == 5).map(|(_, w)| *w);
        assert!(
            account_width.is_some_and(|width| width > 40.0),
            "科目名称列应按内容加宽，实际 {widths:?}"
        );
        assert!(xml.contains("COUNTIF"), "明细页也要有目标科目加粗规则");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kanzhang_suite_writes_readable_voucher_key_not_control_characters() {
        let root = temp_dir("kanzhang-voucher-key");
        let input = root.join("ledger.csv");
        let output = root.join("out.xlsx");
        fs::write(
            &input,
            "公司,记账日期,凭证号,科目名称,借方金额,贷方金额\n\
             甲公司,2026-01-10,0001,收入,0,100\n\
             甲公司,2026-01-10,0001,银行,100,0\n",
        )
        .unwrap();
        export_kanzhang(
            json!({"inputPath":input,"outputPath":output,
                "targetBatches":[{"name":"收入","accounts":["收入"]}],
                "includePivot":true,"includeVoucherTypes":true,"llmAnalysis":false}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let mut suite = open_workbook_auto(root.join("out_套表.xlsx")).unwrap();
        let sheet = suite.worksheet_range("凭证").unwrap();
        let header = sheet
            .rows()
            .next()
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        // 列名按参与拼接的字段命名，不是笼统的"唯一识别码"。
        assert_eq!(header[0], "公司-记账日期-凭证号");
        let first = sheet.rows().nth(1).unwrap()[0].to_string();
        // \u{1F} 一旦写进 xlsx，Excel 会显示成字面量 _x001F_。
        assert!(!first.contains('\u{1f}'), "{first}");
        assert_eq!(first, "甲公司-2026-01-10-0001");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn kanzhang_default_output_follows_legacy_csv_suite_naming() {
        let root = temp_dir("kanzhang-default-name");
        let input = root.join("JE-用于测试.csv");
        fs::write(
            &input,
            "凭证号,科目名称,借方金额,贷方金额\n1,收入,100,0\n1,银行,0,100\n",
        )
        .unwrap();
        // 不给 outputPath：应落回旧版默认名，并按 CSV 套件产出多个文件。
        let result = export_kanzhang(
            json!({"inputPath":input,"targetBatches":[{"name":"收入","accounts":["收入"]}],
                "excludeAccounts":["银行"],"includePivot":true,"includeVoucherTypes":true}),
            &|_, _, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        let outputs = result["outputPaths"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(|value| {
                Path::new(value)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(outputs.len(), 3, "明细 + 剔除 + 套表，实际 {outputs:?}");
        assert!(
            outputs[0].starts_with("看账导出_JE-用于测试_"),
            "{outputs:?}"
        );
        assert!(outputs[0].ends_with("_凭证明细.csv"), "{outputs:?}");
        assert!(outputs[1].ends_with("_剔除明细.csv"), "{outputs:?}");
        assert!(outputs[2].ends_with("_套表.xlsx"), "{outputs:?}");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn kanzhang_csv_export_uses_legacy_chunk_names() {
        let root = temp_dir("kanzhang-csv-chunks");
        let input = root.join("ledger.csv");
        let output = root.join("result.csv");
        fs::write(
            &input,
            "凭证号,科目名称,借方金额,贷方金额\n1,收入,100,0\n1,银行,0,100\n",
        )
        .unwrap();
        let result=export_kanzhang(json!({"inputPath":input,"outputPath":output,"targetBatches":[{"name":"收入","accounts":["收入"]}],"includePivot":false,"includeVoucherTypes":false,"llmAnalysis":false,"rowsPerSheet":1}),&|_,_,_,_|{},&AtomicBool::new(false)).unwrap();
        let outputs = result["outputPaths"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        assert_eq!(outputs.len(), 2);
        assert!(root.join("result_凭证明细_Part1.csv").is_file());
        assert!(root.join("result_凭证明细_Part2.csv").is_file());
        assert!(!root.join("result_凭证明细.csv").exists());
        let _ = fs::remove_dir_all(root);
    }
}
