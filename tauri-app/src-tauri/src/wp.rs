//! FY27 WP 服务单纯 Rust 业务内核。
//!
//! 本模块逐项复刻 `modules/wp-service-generator` 的拆分、Section 聚合、
//! Outlook Hours 核对、服务方案模板复制、SER 公式和索引生成逻辑。
//! 读取导出数据使用 Calamine，现有模板的复制与无损修改使用
//! umya-spreadsheet；运行时不启动 Python、PowerShell 或 Excel COM。

use base64::Engine;
use calamine::{Data, Reader, open_workbook_auto};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::{
    collections::{HashMap, HashSet},
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use umya_spreadsheet::structs::{
    Border, Color, ConditionalFormatValues, ConditionalFormatting, ConditionalFormattingRule,
    Coordinate, Formula, HorizontalAlignmentValues, OrientationValues, Pane, PaneStateValues,
    PaneValues, SequenceOfReferences, SheetStateValues, SheetView, Style, VerticalAlignmentValues,
};
use umya_spreadsheet::{Workbook, Worksheet};

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;

const BASE_SHEETS: [&str; 4] = ["AUD2026", "IPO", "IPO archive", "AUD2025"];
const DEFAULT_SER: [(f64, f64); 4] = [(0.08, 2733.0), (0.25, 1199.0), (0.58, 683.0), (0.09, 173.0)];
const SER_ROLES: [&str; 4] = ["Manager", "Senior", "Staff", "Intern"];
const TIMELINE_NOTES: [&str; 13] = [
    "预审开始日前3周，整理发出预审PBC List",
    "完成抽样、TOD、大额分析性复核等工作",
    "交付预审工作底稿，优化年审服务方案",
    "12/31前整理发出年审PBC List",
    "收集函证资料，及时发出函证",
    "执行年审工作",
    "完成抽样、TOD、大额分析性复核等工作",
    "完成底稿的BKD程序",
    "确定调整事项【早于最终交付时间】",
    "WP底稿首次交付【早于最终交付时间】",
    "WP底稿整体交付【不得晚于报告日前一周】",
    "报告日前3天完成项目质量检查",
    "自行填写",
];
const NAVY: &str = "17324D";
const TEAL: &str = "0F7C80";
const GOLD: &str = "D6A83D";
const LIGHT_GOLD: &str = "FFF4D6";
const PALE_TEAL: &str = "E8F4F3";
const PALE_BLUE: &str = "EAF1F6";
const LIGHT: &str = "F4F7F9";
const TEXT: &str = "243746";
const MUTED: &str = "64717D";
const WHITE: &str = "FFFFFF";
const GREEN: &str = "2F7D5A";
const PALE_GREEN: &str = "E6F3EC";
static TEMPLATE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WpGenerateParams {
    pub input_path: PathBuf,
    pub section_list_path: Option<PathBuf>,
    pub template_path: PathBuf,
    pub output_path: PathBuf,
    pub split_output_path: Option<PathBuf>,
    #[serde(default = "default_ipo_years")]
    pub ipo_years: Vec<i32>,
}

fn default_ipo_years() -> Vec<i32> {
    vec![2026, 2027]
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutlookDifference {
    pub service_number: String,
    pub engagement_name: String,
    pub calculated: f64,
    pub source: f64,
    pub difference: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedIpo {
    pub engagement_name: String,
    pub service_number: String,
    pub start_years: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedOther {
    pub engagement_name: String,
    pub service_number: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WpGenerateResult {
    pub output_path: String,
    pub split_file: Option<String>,
    pub sheets: usize,
    pub services: usize,
    pub index_rows: usize,
    pub aud2026_rows: usize,
    pub ipo_rows: usize,
    pub ipo_archive_rows: usize,
    pub aud2025_rows: usize,
    pub split_aud2026_rows: usize,
    pub split_ipo_rows: usize,
    pub split_ipo_archive_rows: usize,
    pub split_aud2025_rows: usize,
    pub section_list_found: bool,
    pub matched_section_orders: usize,
    pub matched_section_rows: usize,
    pub populated_section_rows: usize,
    pub template_section_rows: usize,
    pub populated_template_rows: usize,
    pub outlook_compared: usize,
    pub outlook_equal: usize,
    pub outlook_differences: Vec<OutlookDifference>,
    pub unmatched_section_orders: Vec<String>,
    pub excluded_ipo: Vec<ExcludedIpo>,
    pub excluded_other: Vec<ExcludedOther>,
    pub ipo_years: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WpError(pub String);

impl fmt::Display for WpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WpError {}
impl From<std::io::Error> for WpError {
    fn from(value: std::io::Error) -> Self {
        Self(value.to_string())
    }
}

pub(crate) fn call(method: &str, params: JsonValue) -> std::result::Result<JsonValue, AppError> {
    match method {
        "wp.validate" => validate_call(params),
        _ => Err(app_error(
            "METHOD_NOT_FOUND",
            "未找到 Rust WP 服务单方法。",
            Some(method.into()),
        )),
    }
}

pub(crate) fn run_job(
    method: &str,
    params: JsonValue,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> std::result::Result<JsonValue, AppError> {
    if method != "wp.generate" {
        return Err(app_error(
            "METHOD_NOT_FOUND",
            "未找到 Rust WP 服务单任务。",
            Some(method.into()),
        ));
    }
    let check = validate_call(params.clone())?;
    if !check["valid"].as_bool().unwrap_or(false) {
        let missing = check["missing"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(JsonValue::as_str)
            .collect::<Vec<_>>()
            .join("、");
        return Err(app_error(
            "WP_INPUT_MISSING",
            &format!("缺少 WP 服务单输入文件：{missing}"),
            None,
        ));
    }
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("validate", 1, 3, "输入文件检查通过");
    let folder = required_folder(&params)?;
    let input_path = check["serviceOrderPath"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| app_error("WP_INPUT_INVALID", "未识别到 WP 服务单文件。", None))?;
    let section_list_path = check["sectionListPath"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| app_error("WP_INPUT_INVALID", "未识别到 Section List 文件。", None))?;
    let template = ensure_template(&folder)?;
    let generation = WpGenerateParams {
        input_path,
        section_list_path: Some(section_list_path),
        template_path: template.path().to_path_buf(),
        output_path: params
            .get("outputPath")
            .and_then(JsonValue::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| folder.join("FY27+WP服务单汇总.xlsx")),
        split_output_path: Some(folder.join("FY27+WP服务单_自动拆分.xlsx")),
        ipo_years: params
            .get("ipoYears")
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(JsonValue::as_i64)
                    .map(|year| year as i32)
                    .collect()
            })
            .unwrap_or_else(default_ipo_years),
    };
    pause.wait()?;
    progress("generate", 2, 3, "正在生成服务方案和汇总文件");
    let result =
        generate_cancellable(&generation, cancel.as_ref(), Some(pause)).map_err(|error| {
            if cancel.load(Ordering::Relaxed) {
                app_error("JOB_CANCELLED", "任务已取消。", None)
            } else {
                app_error(
                    "WP_GENERATE_FAILED",
                    "WP 服务方案生成失败。",
                    Some(error.to_string()),
                )
            }
        })?;
    pause.wait()?;
    check_cancel(&cancel)?;
    progress("verify", 3, 3, "生成完成");
    let mut value = serde_json::to_value(result).map_err(|error| {
        app_error(
            "WP_RESULT_FAILED",
            "无法整理 WP 生成结果。",
            Some(error.to_string()),
        )
    })?;
    value["outputPaths"] = json!([
        generation.output_path.to_string_lossy(),
        generation
            .split_output_path
            .as_ref()
            .unwrap()
            .to_string_lossy()
    ]);
    Ok(value)
}

fn validate_call(params: JsonValue) -> std::result::Result<JsonValue, AppError> {
    let folder = required_folder(&params)?;
    let service_order = find_service_order_file(&folder)
        .map_err(|error| app_error("WP_INPUT_INVALID", &error.to_string(), None))?;
    let section_list = find_section_list_file(&folder)
        .map_err(|error| app_error("WP_INPUT_INVALID", &error.to_string(), None))?;
    Ok(json!({
        "folder": folder.to_string_lossy(),
        "valid": true,
        "missing": [],
        "serviceOrderPath": service_order.to_string_lossy(),
        "sectionListPath": section_list.to_string_lossy(),
        "inputFiles": {
            "wpServiceOrder": service_order.file_name().unwrap_or_default().to_string_lossy(),
            "sectionList": section_list.file_name().unwrap_or_default().to_string_lossy()
        },
        "outputPath": folder.join("FY27+WP服务单汇总.xlsx").to_string_lossy(),
        "engine": "rust"
    }))
}

fn required_folder(params: &JsonValue) -> std::result::Result<PathBuf, AppError> {
    let folder = params
        .get("folder")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| app_error("INVALID_ARGUMENT", "请选择包含 WP 服务单的文件夹。", None))?;
    if !folder.is_dir() {
        return Err(app_error(
            "PATH_NOT_FOUND",
            "选择的 WP 服务单文件夹不存在。",
            Some(folder.to_string_lossy().into_owned()),
        ));
    }
    Ok(folder)
}

struct PreparedTemplate {
    path: PathBuf,
    _temporary: Option<TemporaryArtifact>,
}

impl PreparedTemplate {
    fn path(&self) -> &Path {
        &self.path
    }
}

fn ensure_template(folder: &Path) -> std::result::Result<PreparedTemplate, AppError> {
    let target = folder.join("FY27+WP服务单.xlsx");
    if target.is_file() {
        return Ok(PreparedTemplate {
            path: target,
            _temporary: None,
        });
    }
    const TEMPLATE_B64: &str = include_str!("../../assets/wp/FY27+WP服务单.xlsx.b64");
    let compact: String = TEMPLATE_B64
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|error| {
            app_error(
                "WP_TEMPLATE_INVALID",
                "内置 WP 服务方案模板损坏。",
                Some(error.to_string()),
            )
        })?;
    let temp_folder = std::env::temp_dir().join("AuditToolbox");
    fs::create_dir_all(&temp_folder).map_err(|error| {
        app_error(
            "WP_TEMPLATE_WRITE_FAILED",
            "无法准备 WP 服务方案临时模板目录。",
            Some(error.to_string()),
        )
    })?;
    let sequence = TEMPLATE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = temp_folder.join(format!(
        "wp-template-{}-{sequence}.xlsx",
        std::process::id()
    ));
    let temporary = TemporaryArtifact::new(path.clone()).map_err(|error| {
        app_error(
            "WP_TEMPLATE_WRITE_FAILED",
            "无法准备 WP 服务方案临时模板。",
            Some(error.to_string()),
        )
    })?;
    fs::write(&path, bytes).map_err(|error| {
        app_error(
            "WP_TEMPLATE_WRITE_FAILED",
            "无法写入 WP 服务方案临时模板。",
            Some(error.to_string()),
        )
    })?;
    Ok(PreparedTemplate {
        path,
        _temporary: Some(temporary),
    })
}

fn check_cancel(cancel: &AtomicBool) -> std::result::Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(app_error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}

fn replace_with_temporary(temporary: &Path, target: &Path, context: &str) -> Result<()> {
    match fs::rename(temporary, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => match fs::copy(temporary, target) {
            Ok(_) => {
                fs::remove_file(temporary).map_err(WpError::from)?;
                Ok(())
            }
            Err(copy_error) => {
                let _ = fs::remove_file(temporary);
                Err(WpError(format!(
                    "{context}。目标文件可能正被占用：{copy_error}（原子替换失败：{rename_error}）"
                )))
            }
        },
    }
}

struct TemporaryArtifact {
    path: PathBuf,
    armed: bool,
}

impl TemporaryArtifact {
    fn new(path: PathBuf) -> Result<Self> {
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                WpError(format!(
                    "无法清理上次遗留的临时文件 {}：{error}",
                    path.display()
                ))
            })?;
        }
        Ok(Self { path, armed: true })
    }

    fn commit(mut self, target: &Path, context: &str) -> Result<()> {
        replace_with_temporary(&self.path, target, context)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for TemporaryArtifact {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn app_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

type Result<T> = std::result::Result<T, WpError>;

const IGNORED_INPUT_MARKERS: [&str; 2] = ["汇总", "自动拆分"];

fn normalized_file_stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_xlsx_input(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("xlsx"))
        && !path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("~$")
        && !IGNORED_INPUT_MARKERS.iter().any(|marker| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .contains(marker)
        })
}

fn single_input_candidate(mut candidates: Vec<PathBuf>, label: &str) -> Result<PathBuf> {
    candidates.sort_by_key(|path| {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    });
    match candidates.len() {
        0 => Err(WpError(format!(
            "找不到{label}：请放入文件名包含“{label}”的 Excel 文件。"
        ))),
        1 => Ok(candidates.remove(0)),
        _ => {
            let names = candidates
                .iter()
                .map(|path| {
                    format!(
                        "- {}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            Err(WpError(format!(
                "找到多个可能的{label}，请只保留一个：\n{names}"
            )))
        }
    }
}

fn find_service_order_file(folder: &Path) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(folder)? {
        let path = entry?.path();
        if !is_xlsx_input(&path) {
            continue;
        }
        let normalized = normalized_file_stem(&path);
        if normalized.contains("wp服务单")
            && !normalized.contains("sectionlist")
            && !normalized.contains("+wp服务单")
        {
            candidates.push(path);
        }
    }
    single_input_candidate(candidates, "WP服务单")
}

fn find_section_list_file(folder: &Path) -> Result<PathBuf> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(folder)? {
        let path = entry?.path();
        if is_xlsx_input(&path) && normalized_file_stem(&path).contains("sectionlist") {
            candidates.push(path);
        }
    }
    single_input_candidate(candidates, "Section List")
}

#[derive(Clone, Debug)]
enum Value {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
}

impl Value {
    fn text(&self) -> String {
        match self {
            Self::Empty => String::new(),
            Self::Text(value) => value.clone(),
            Self::Number(value) if value.fract() == 0.0 => format!("{value:.0}"),
            Self::Number(value) => value.to_string(),
            Self::Bool(value) => value.to_string(),
        }
    }
    fn number(&self) -> f64 {
        match self {
            Self::Number(value) => *value,
            Self::Text(value) => value.replace(',', "").trim().parse().unwrap_or(0.0),
            Self::Bool(value) => {
                if *value {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Empty => 0.0,
        }
    }
    fn is_empty(&self) -> bool {
        matches!(self, Self::Empty) || self.text().is_empty()
    }
}

fn from_data(value: &Data) -> Value {
    match value {
        Data::Empty => Value::Empty,
        Data::String(value) | Data::DateTimeIso(value) | Data::DurationIso(value) => {
            Value::Text(value.clone())
        }
        Data::Float(value) => Value::Number(*value),
        Data::Int(value) => Value::Number(*value as f64),
        Data::Bool(value) => Value::Bool(*value),
        Data::DateTime(value) => Value::Number(value.as_f64()),
        Data::Error(value) => Value::Text(value.to_string()),
    }
}

fn read_first_sheet(path: &Path, preferred: Option<&str>) -> Result<Vec<Vec<Value>>> {
    let mut book = open_workbook_auto(path)
        .map_err(|error| WpError(format!("无法读取 {}：{error}", path.display())))?;
    let sheet_name = if let Some(name) = preferred {
        if !book.sheet_names().iter().any(|item| item == name) {
            return Err(WpError(format!(
                "{} 中找不到‘{name}’工作表。",
                path.display()
            )));
        }
        name.to_owned()
    } else {
        book.sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| WpError("工作簿没有工作表。".into()))?
    };
    let range = book
        .worksheet_range(&sheet_name)
        .map_err(|error| WpError(format!("无法读取工作表 {sheet_name}：{error}")))?;
    Ok(range
        .rows()
        .map(|row| row.iter().map(from_data).collect())
        .collect())
}

fn compact(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}
fn normalize_order(value: &str) -> String {
    compact(value).to_uppercase().replace(['–', '—'], "-")
}
fn normalize_section(value: &str) -> String {
    let mut normalized = compact(value)
        .replace('（', "(")
        .replace('）', ")")
        .to_lowercase();
    if normalized.starts_with("u_exp-other(") {
        normalized.replace_range(..11, "u_exp");
    } else if normalized.starts_with("u_expother(") {
        normalized.replace_range(..10, "u_exp");
    }
    normalized
}
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn header_map(headers: &[Value]) -> HashMap<String, usize> {
    headers
        .iter()
        .enumerate()
        .map(|(index, value)| (compact(&value.text()), index))
        .collect()
}

fn require_headers(map: &HashMap<String, usize>, required: &[&str], context: &str) -> Result<()> {
    let missing: Vec<&str> = required
        .iter()
        .copied()
        .filter(|name| !map.contains_key(*name))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(WpError(format!(
            "{context}缺少字段：{}",
            missing.join("、")
        )))
    }
}

/// Source-sheet fields mapped to the header texts that may carry them.
///
/// The first alias doubles as the label shown when the column is missing.
/// Reading these by header keeps a reordered export working: the system that
/// produces `FY27 WP服务单.xlsx` does not guarantee a column order, and the
/// legacy fixed-index reads silently pulled a neighbouring column instead.
const SOURCE_FIELD_ALIASES: &[(&str, &[&str])] = &[
    ("client_name", &["Client Name"]),
    ("engagement_code", &["Engagement Code"]),
    ("engagement_name", &["Engagement Name"]),
    ("outlook_hours", &["Outlook Hours"]),
    ("service_number", &["WP服务单编号"]),
    ("task_count", &["底稿任务数量"]),
    ("schedule_status", &["排班状态"]),
    ("project_status", &["项目状态"]),
    ("wp_eic", &["WP EIC"]),
    ("wp_fic", &["WP FIC", "WP FIC*"]),
    ("service_type", &["Service Type"]),
    ("audit_eic", &["Audit EIC"]),
    ("report_date", &["Audit Report Date"]),
    ("related_order", &["相关订单"]),
    ("pre_start", &["Booking Period Start-预审"]),
    ("pre_end", &["Booking Period End-预审"]),
    ("final_start", &["Booking Period Start-年审"]),
    ("final_end", &["Booking Period End-年审"]),
    ("total_booking_hours", &["Total Booking Hours"]),
    ("team", &["团队"]),
    ("group", &["组别"]),
    ("client_code", &["Client Code"]),
    ("engagement_id", &["审计项目"]),
];

/// Header key used for source-field lookup: whitespace dropped, en/em dashes
/// folded to `-`, case ignored.
fn normalize_header(value: &str) -> String {
    compact(value).replace(['–', '—'], "-").to_lowercase()
}

/// Zero-based column index of each source field present in `headers`.
///
/// Duplicate headers keep the right-most column, matching the legacy dict
/// comprehension that built the same map in Python.
fn source_columns<I>(headers: I) -> HashMap<&'static str, usize>
where
    I: IntoIterator<Item = String>,
{
    let lookup: HashMap<String, usize> = headers
        .into_iter()
        .enumerate()
        .filter(|(_, text)| !text.trim().is_empty())
        .map(|(index, text)| (normalize_header(&text), index))
        .collect();
    SOURCE_FIELD_ALIASES
        .iter()
        .filter_map(|(field, aliases)| {
            aliases
                .iter()
                .find_map(|alias| lookup.get(&normalize_header(alias)))
                .map(|index| (*field, *index))
        })
        .collect()
}

/// One source field of a raw row, or [`Value::Empty`] when the column is absent.
fn source_field<'a>(
    row: &'a [Value],
    columns: &HashMap<&'static str, usize>,
    field: &str,
) -> &'a Value {
    columns
        .get(field)
        .and_then(|index| row.get(*index))
        .unwrap_or(&Value::Empty)
}

/// One-based source-field columns of a written sheet, read back from row 1.
fn sheet_source_columns(sheet: &Worksheet) -> HashMap<&'static str, u32> {
    let headers = (1..=sheet.get_highest_column()).map(|column| sheet.value((column, 1)));
    source_columns(headers)
        .into_iter()
        .map(|(field, index)| (field, index as u32 + 1))
        .collect()
}

/// Booking-period year plus the month when the source actually carries one.
///
/// Legacy took the year from the leading digits and treated a missing month as
/// unknown.  Requiring a strict `year-month` layout would drop `2026年4月` (the
/// whole row disappears from every sheet), and defaulting a missing month to
/// January would push a bare `2026` into "IPO archive" so its service sheet is
/// never generated.  Both failures are silent, so keep the month optional.
fn year_month(value: &Value) -> Option<(i32, Option<u32>)> {
    match value {
        Value::Number(serial) if *serial > 1.0 => {
            let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?;
            let date = base.checked_add_signed(chrono::Duration::days(serial.floor() as i64))?;
            Some((
                chrono::Datelike::year(&date),
                Some(chrono::Datelike::month(&date)),
            ))
        }
        _ => {
            let text = value.text();
            let groups = text
                .trim()
                .split(|c: char| !c.is_ascii_digit())
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>();
            let year = groups.first().filter(|part| part.len() >= 4)?[..4]
                .parse()
                .ok()?;
            let month = groups
                .get(1)
                .and_then(|part| part.parse::<u32>().ok())
                .filter(|month| (1..=12).contains(month));
            Some((year, month))
        }
    }
}

#[derive(Default)]
struct SplitData {
    headers: Vec<Value>,
    groups: HashMap<&'static str, Vec<Vec<Value>>>,
    excluded_ipo: Vec<ExcludedIpo>,
    excluded_other: Vec<ExcludedOther>,
}

fn split_raw(rows: Vec<Vec<Value>>, ipo_years: &[i32]) -> Result<SplitData> {
    let headers = rows
        .first()
        .cloned()
        .ok_or_else(|| WpError("FY27 WP服务单为空。".into()))?;
    let map = header_map(&headers);
    let required = [
        "EngagementName",
        "OutlookHours",
        "BookingPeriodStart-预审",
        "BookingPeriodEnd-预审",
        "BookingPeriodStart-年审",
        "BookingPeriodEnd-年审",
        "WP服务单编号",
    ];
    require_headers(&map, &required, "FY27 WP服务单")?;
    let mut result = SplitData {
        headers,
        ..Default::default()
    };
    for name in BASE_SHEETS {
        result.groups.insert(name, Vec::new());
    }
    for mut row in rows.into_iter().skip(1) {
        if row.iter().all(Value::is_empty) {
            continue;
        }
        row.resize(result.headers.len(), Value::Empty);
        let engagement = row[map["EngagementName"]].text().trim().to_owned();
        let upper = engagement.to_uppercase();
        let service = row[map["WP服务单编号"]].text();
        let group = if upper.starts_with("IPO") {
            let starts = [
                &row[map["BookingPeriodStart-预审"]],
                &row[map["BookingPeriodStart-年审"]],
            ];
            let ends = [
                &row[map["BookingPeriodEnd-预审"]],
                &row[map["BookingPeriodEnd-年审"]],
            ];
            let mut years: Vec<i32> = starts
                .iter()
                .filter_map(|value| year_month(value).map(|item| item.0))
                .collect();
            years.sort_unstable();
            years.dedup();
            if !years.iter().any(|year| ipo_years.contains(year)) {
                result.excluded_ipo.push(ExcludedIpo {
                    engagement_name: engagement,
                    service_number: service,
                    start_years: years,
                });
                continue;
            }
            // A period without a month cannot prove the archive window, so it
            // stays in the regular IPO group exactly like the legacy tool.
            let archive =
                starts
                    .iter()
                    .filter_map(|value| year_month(value))
                    .any(|(year, month)| {
                        year == 2026 && month.is_some_and(|month| (1..=3).contains(&month))
                    })
                    || ends
                        .iter()
                        .filter_map(|value| year_month(value))
                        .any(|(year, month)| year == 2026 && month.is_some_and(|month| month <= 4));
            if archive { "IPO archive" } else { "IPO" }
        } else if contains_year_token(&upper, &["AUD", "FY"], 2025) {
            "AUD2025"
        } else if contains_year_token(&upper, &["AUD", "INT"], 2026)
            || contains_year_token(&upper, &["AUD", "INT"], 2027)
        {
            "AUD2026"
        } else {
            let years = extract_years(&upper);
            if years.iter().any(|year| *year <= 2025) {
                "AUD2025"
            } else if !years.is_empty() {
                "AUD2026"
            } else {
                result.excluded_other.push(ExcludedOther {
                    engagement_name: engagement,
                    service_number: service,
                });
                continue;
            }
        };
        let outlook_index = map["OutlookHours"];
        if let Value::Text(text) = &row[outlook_index] {
            if let Ok(number) = text.replace(',', "").trim().parse::<f64>() {
                row[outlook_index] = Value::Number(number);
            }
        }
        result
            .groups
            .get_mut(group)
            .expect("base group exists")
            .push(row);
    }
    Ok(result)
}

fn contains_year_token(text: &str, prefixes: &[&str], year: i32) -> bool {
    let compacted: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    prefixes
        .iter()
        .any(|prefix| compacted.contains(&format!("{prefix}{year}")))
}
fn extract_years(text: &str) -> Vec<i32> {
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len().saturating_sub(3))
        .filter_map(|index| {
            let chunk: String = chars[index..index + 4].iter().collect();
            chunk
                .starts_with("20")
                .then(|| chunk.parse().ok())
                .flatten()
        })
        .collect()
}

#[derive(Clone)]
struct Record {
    source_sheet: &'static str,
    source_row: u32,
    engagement_name: String,
    outlook_hours: f64,
    service_number: String,
    related_order: String,
    pre_start: Value,
    pre_end: Value,
    final_start: Value,
    final_end: Value,
    report_date: Value,
    wp_fic: String,
    sheet_name: String,
}

fn collect_records(split: &SplitData) -> Vec<Record> {
    let columns = source_columns(split.headers.iter().map(Value::text));
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for source in ["AUD2026", "IPO"] {
        for (index, row) in split.groups[source].iter().enumerate() {
            let service = source_field(row, &columns, "service_number").text();
            if service.is_empty() || !seen.insert(service.clone()) {
                continue;
            }
            records.push(Record {
                source_sheet: source,
                source_row: index as u32 + 2,
                engagement_name: source_field(row, &columns, "engagement_name").text(),
                outlook_hours: source_field(row, &columns, "outlook_hours").number(),
                service_number: service,
                wp_fic: source_field(row, &columns, "wp_fic").text(),
                pre_start: source_field(row, &columns, "pre_start").clone(),
                pre_end: source_field(row, &columns, "pre_end").clone(),
                final_start: source_field(row, &columns, "final_start").clone(),
                final_end: source_field(row, &columns, "final_end").clone(),
                report_date: source_field(row, &columns, "report_date").clone(),
                related_order: source_field(row, &columns, "related_order").text(),
                sheet_name: String::new(),
            });
        }
    }
    records
}

#[derive(Clone, Copy, Default)]
struct SectionItem {
    entity: Option<f64>,
    drafts: Option<f64>,
    budget: Option<f64>,
}
type SectionDetails = HashMap<String, HashMap<String, SectionItem>>;

struct SectionResult {
    details: SectionDetails,
    matched_rows: usize,
    populated_rows: usize,
    found: bool,
}

fn load_section_details(path: Option<&Path>, records: &[Record]) -> Result<SectionResult> {
    let Some(path) = path.filter(|path| path.exists()) else {
        return Ok(SectionResult {
            details: HashMap::new(),
            matched_rows: 0,
            populated_rows: 0,
            found: false,
        });
    };
    let rows = read_first_sheet(path, None)?;
    let headers = rows
        .first()
        .ok_or_else(|| WpError("FY27 Section List为空。".into()))?;
    let map = header_map(headers);
    let section = map.get("Section").copied();
    // Scan in column order: a hash-map iteration would pick an arbitrary column
    // whenever the sheet carries several `Entity数量…` variants, so the same
    // file could produce different hours on two consecutive runs.
    let entity = headers
        .iter()
        .position(|value| value.text().trim().starts_with("Entity数量"));
    let drafts = map.get("底稿数量").copied();
    let budget = map.get("预算调整").copied();
    let order = map.get("所属WP服务单").copied();
    if [section, entity, drafts, budget, order]
        .iter()
        .any(Option::is_none)
    {
        return Err(WpError(
            "FY27 Section List 缺少字段：Section、Entity数量、底稿数量、预算调整或所属WP服务单。"
                .into(),
        ));
    }
    let (section, entity, drafts, budget, order) = (
        section.unwrap(),
        entity.unwrap(),
        drafts.unwrap(),
        budget.unwrap(),
        order.unwrap(),
    );
    let targets: HashSet<String> = records
        .iter()
        .map(|record| normalize_order(&record.service_number))
        .collect();
    let mut details: SectionDetails = HashMap::new();
    let mut matched_rows = 0;
    let mut populated_rows = 0;
    for row in rows.iter().skip(1) {
        let order_key = normalize_order(&row.get(order).map(Value::text).unwrap_or_default());
        if !targets.contains(&order_key) {
            continue;
        }
        let section_key = normalize_section(&row.get(section).map(Value::text).unwrap_or_default());
        if section_key.is_empty() {
            continue;
        }
        matched_rows += 1;
        let raw = [row.get(entity), row.get(drafts), row.get(budget)];
        if raw.iter().flatten().any(|value| !value.is_empty()) {
            populated_rows += 1;
        }
        let item = details
            .entry(order_key)
            .or_default()
            .entry(section_key)
            .or_default();
        add_optional(&mut item.entity, raw[0]);
        add_optional(&mut item.drafts, raw[1]);
        add_optional(&mut item.budget, raw[2]);
    }
    Ok(SectionResult {
        details,
        matched_rows,
        populated_rows,
        found: true,
    })
}

fn add_optional(target: &mut Option<f64>, value: Option<&Value>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        *target = Some(target.unwrap_or(0.0) + value.number());
    }
}

fn load_ser_config(folder: &Path) -> Result<[(f64, f64); 4]> {
    let path = folder.join("SER配置.xlsx");
    if !path.exists() {
        return Ok(DEFAULT_SER);
    }
    let rows = read_first_sheet(&path, None)?;
    let mut config = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(1) {
        let mix_value = row.get(1).unwrap_or(&Value::Empty);
        let rate_value = row.get(2).unwrap_or(&Value::Empty);
        if mix_value.is_empty() && rate_value.is_empty() {
            continue;
        }
        let numeric = |value: &Value| match value {
            Value::Number(value) => Some(*value),
            Value::Text(value) => value.replace(',', "").trim().parse::<f64>().ok(),
            _ => None,
        };
        let (Some(mut mix), Some(rate)) = (numeric(mix_value), numeric(rate_value)) else {
            return Err(WpError(format!(
                "SER配置.xlsx第{}行比例或费率不是数字。",
                index + 1
            )));
        };
        if mix > 1.0 {
            mix /= 100.0;
        }
        if mix <= 0.0 || rate <= 0.0 {
            return Err(WpError(format!(
                "SER配置.xlsx第{}行比例和费率必须大于0。",
                index + 1
            )));
        }
        config.push((mix, rate));
    }
    if config.len() != 4 {
        return Err(WpError(
            "SER配置.xlsx必须有4行配置，顺序为Manager、Senior、Staff、Intern。".into(),
        ));
    }
    if (config.iter().map(|item| item.0).sum::<f64>() - 1.0).abs() > 0.0001 {
        return Err(WpError("SER配置.xlsx的Hours占比合计必须为100%。".into()));
    }
    Ok(config.try_into().expect("four SER rows"))
}

fn safe_sheet_name(preferred: &str, used: &mut HashSet<String>) -> String {
    let mut base: String = preferred
        .chars()
        .map(|ch| if "\\/?*[]:".contains(ch) { ' ' } else { ch })
        .collect();
    base = base.trim().chars().take(31).collect();
    if base.is_empty() {
        base = "服务方案".into();
    }
    let mut candidate = base.clone();
    let mut number = 2;
    while used.contains(&candidate.to_lowercase()) {
        let suffix = format!("_{number}");
        candidate = format!(
            "{}{}",
            base.chars()
                .take(31 - suffix.chars().count())
                .collect::<String>()
                .trim_end(),
            suffix
        );
        number += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

fn set_cell_value(sheet: &mut Worksheet, col: u32, row: u32, value: &Value) {
    let cell = sheet.get_cell_mut((col, row));
    match value {
        Value::Empty => {
            cell.set_blank();
        }
        // `set_value` sniffs the text and silently stores "47141836" as a
        // number.  The legacy exporter keeps whatever type the source carried,
        // so Engagement Code / Client Code / 底稿任务数量 must stay text.
        Value::Text(value) if value.is_empty() => {
            cell.set_blank();
        }
        Value::Text(value) => {
            cell.set_value_string(value);
        }
        Value::Number(value) => {
            cell.set_value_number(*value);
        }
        Value::Bool(value) => {
            cell.set_value_bool(*value);
        }
    }
}
fn set_text(sheet: &mut Worksheet, coordinate: &str, value: impl Into<String>) {
    let value: String = value.into();
    let cell = sheet.get_cell_mut(coordinate);
    if value.is_empty() {
        cell.set_blank();
    } else {
        cell.set_value_string(value);
    }
}
fn set_number(sheet: &mut Worksheet, coordinate: &str, value: f64) {
    sheet.get_cell_mut(coordinate).set_value_number(value);
}
fn set_formula(sheet: &mut Worksheet, coordinate: &str, formula: impl AsRef<str>) {
    sheet
        .get_cell_mut(coordinate)
        .set_formula(formula.as_ref().trim_start_matches('='));
}

fn cell_style(fill: Option<&str>, font_color: &str, bold: bool, size: f64, center: bool) -> Style {
    let mut style = Style::default();
    if let Some(fill) = fill {
        style.set_background_color(fill);
    }
    style
        .font_mut()
        .set_name("Microsoft YaHei")
        .set_size(size)
        .set_bold(bold)
        .color_mut()
        .set_argb_str(font_color);
    style.alignment_mut().set_horizontal(if center {
        HorizontalAlignmentValues::Center
    } else {
        HorizontalAlignmentValues::Left
    });
    style
        .alignment_mut()
        .set_vertical(VerticalAlignmentValues::Center);
    style.alignment_mut().set_wrap_text(true);
    let border = || {
        let mut color = Color::default();
        color.set_argb_str("D9E2E8");
        let mut border = Border::default();
        border.set_border_style(Border::BORDER_THIN);
        border.set_color(color);
        border
    };
    style
        .borders_mut()
        .set_left(border())
        .set_right(border())
        .set_top(border())
        .set_bottom(border());
    style
}

/// 旧版这些格子用的是不带 `wrap_text` 的 `Alignment(...)`，不能沿用默认换行。
fn clear_wrap(sheet: &mut Worksheet, coordinate: (u32, u32)) {
    sheet
        .get_style_mut(coordinate)
        .alignment_mut()
        .set_wrap_text(false);
}

/// 条件格式的差异格式只覆盖底色和字体颜色/加粗。
///
/// 旧版 `FormulaRule(fill=..., font=Font(color=..., bold=True))` 不带字体名、
/// 字号、边框和对齐；这些一旦写进 dxf，就会在命中的单元格上覆盖原有排版。
fn conditional_style(fill: &str, font_color: &str) -> Style {
    let mut style = Style::default();
    style.set_background_color(fill);
    style
        .font_mut()
        .set_bold(true)
        .color_mut()
        .set_argb_str(font_color);
    style
}

/// 旧版 `style_section_title` 只给 `Border(bottom=MEDIUM_NAVY)`，四周没有网格线。
fn section_title_style(fill: &str, font_color: &str) -> Style {
    let mut style = cell_style(Some(fill), font_color, true, 11.0, false);
    style.remove_borders();
    let mut color = Color::default();
    color.set_argb_str(NAVY);
    let mut bottom = Border::default();
    bottom.set_border_style(Border::BORDER_MEDIUM);
    bottom.set_color(color);
    style.borders_mut().set_bottom(bottom);
    style
}

fn set_number_format(sheet: &mut Worksheet, coordinate: &str, code: &str) {
    sheet
        .get_style_mut(coordinate)
        .number_format_mut()
        .set_format_code(code);
}

fn set_visual_style(sheet: &mut Worksheet, coordinate: (u32, u32), mut style: Style) {
    if let Some(number_format) = sheet.get_style(coordinate).number_format().cloned() {
        style.set_number_format(number_format);
    }
    sheet.set_style(coordinate, style);
}

fn set_visual_style_named(sheet: &mut Worksheet, coordinate: &str, mut style: Style) {
    if let Some(number_format) = sheet.get_style(coordinate).number_format().cloned() {
        style.set_number_format(number_format);
    }
    sheet.set_style(coordinate, style);
}

fn set_row_height(sheet: &mut Worksheet, row: u32, height: f64) {
    sheet
        .get_row_dimension_mut(&row)
        .set_height(height)
        .set_custom_height(true);
}

fn set_column_widths(sheet: &mut Worksheet, widths: &[(&str, f64)]) {
    for (column, width) in widths {
        sheet.get_column_dimension_mut(column).set_width(*width);
    }
}

fn configure_view(sheet: &mut Worksheet, freeze_row: u32) {
    let views = sheet.get_sheet_views_mut().sheet_view_list_mut();
    if views.is_empty() {
        views.push(SheetView::default());
    }
    let view = &mut views[0];
    view.set_show_grid_lines(false);
    view.set_zoom_scale(90);
    // 模板表在模板文件里是被选中的；85 张服务方案都克隆自它，
    // 不复位就会在 Excel 里成组选中——此时改一个格子会同时写进所有表。
    view.set_tab_selected(false);
    let mut coordinate = Coordinate::default();
    coordinate.set_coordinate(format!("A{freeze_row}"));
    let mut pane = Pane::default();
    pane.set_vertical_split((freeze_row - 1) as f64)
        .set_top_left_cell(coordinate)
        .set_active_pane(PaneValues::BottomLeft)
        .set_state(PaneStateValues::Frozen);
    view.set_pane(pane);
}

fn set_tab_color(sheet: &mut Worksheet, argb: &str) {
    let mut color = Color::default();
    color.set_argb_str(argb);
    sheet.set_tab_color(color);
}

fn configure_print(sheet: &mut Worksheet, print_area: &str, repeat_rows: Option<&str>) {
    sheet
        .get_page_setup_mut()
        .set_orientation(OrientationValues::Landscape)
        .set_paper_size(9)
        .set_fit_to_width(1)
        .set_fit_to_height(0);
    sheet
        .get_page_margins_mut()
        .set_left(0.25)
        .set_right(0.25)
        .set_top(0.5)
        .set_bottom(0.5)
        .set_header(0.5)
        .set_footer(0.5);
    sheet
        .get_header_footer_mut()
        .odd_footer_mut()
        .set_value("&L&8&K64717DFY27 WP COE 服务方案&R&8&K64717DPage &P / &N");
    let quoted = quote_sheet(sheet.get_name());
    sheet
        .defined_names_mut()
        .retain(|name| name.name() != "_xlnm.Print_Area" && name.name() != "_xlnm.Print_Titles");
    let _ = sheet.add_defined_name(
        "_xlnm.Print_Area".to_owned(),
        format!("'{quoted}'!{print_area}"),
    );
    if let Some(repeat_rows) = repeat_rows {
        let _ = sheet.add_defined_name(
            "_xlnm.Print_Titles".to_owned(),
            format!("'{quoted}'!{repeat_rows}"),
        );
    }
}

fn add_formula_conditional(
    sheet: &mut Worksheet,
    range: String,
    formula: String,
    style: Style,
    priority: i32,
) {
    let mut expression = Formula::default();
    expression.set_string_value(formula);
    let mut rule = ConditionalFormattingRule::default();
    rule.set_type(ConditionalFormatValues::Expression)
        .set_priority(priority)
        .set_style(style)
        .set_formula(expression);
    let mut references = SequenceOfReferences::default();
    references.set_sqref(range);
    let mut conditional = ConditionalFormatting::default();
    conditional
        .set_sequence_of_references(references)
        .set_conditional_collection(vec![rule]);
    sheet.add_conditional_formatting_collection(conditional);
}

/// Source-sheet column widths keyed by field rather than by letter, so a
/// reordered export still widens the right columns.
const SOURCE_FIELD_WIDTHS: &[(&str, f64)] = &[
    ("client_name", 34.0),
    ("engagement_code", 14.0),
    ("engagement_name", 38.0),
    ("outlook_hours", 14.0),
    ("schedule_status", 13.0),
    ("service_number", 27.0),
    ("task_count", 14.0),
    ("project_status", 15.0),
    ("wp_eic", 19.0),
    ("wp_fic", 18.0),
    ("pre_start", 17.0),
    ("pre_end", 17.0),
    ("final_start", 17.0),
    ("final_end", 17.0),
    ("service_type", 34.0),
    ("audit_eic", 25.0),
    ("report_date", 16.0),
    ("related_order", 28.0),
    ("total_booking_hours", 18.0),
    ("team", 23.0),
    ("group", 23.0),
    ("client_code", 16.0),
    ("engagement_id", 23.0),
];

fn style_source_sheet(sheet: &mut Worksheet) {
    let columns = sheet_source_columns(sheet);
    let widths: Vec<(String, f64)> = (1..=sheet.get_highest_column())
        .map(|column| (column_name(column), 18.0))
        .chain(SOURCE_FIELD_WIDTHS.iter().filter_map(|(field, width)| {
            columns
                .get(field)
                .map(|column| (column_name(*column), *width))
        }))
        .collect();
    for (column, width) in &widths {
        sheet.get_column_dimension_mut(column).set_width(*width);
    }
    // 用户提供的旧版成果对尾部五列采用固定版式；即使导出表头的业务含义
    // 发生过调整，R:V 的宽度仍须保持 28/18/23/16/23。
    for (column, width) in [(18, 28.0), (19, 18.0), (20, 23.0), (21, 16.0), (22, 23.0)] {
        if column <= sheet.get_highest_column() {
            sheet
                .get_column_dimension_mut(&column_name(column))
                .set_width(width);
        }
    }
    let max_col = sheet.get_highest_column();
    let max_row = sheet.get_highest_row();
    set_row_height(sheet, 1, 34.0);
    let header = cell_style(Some(NAVY), WHITE, true, 10.0, true);
    for col in 1..=max_col {
        set_visual_style(sheet, (col, 1), header.clone());
    }
    for row in 2..=max_row {
        set_row_height(sheet, row, 29.0);
        let body = cell_style(
            Some(if row % 2 == 0 { WHITE } else { LIGHT }),
            TEXT,
            false,
            9.0,
            false,
        );
        for col in 1..=max_col {
            set_visual_style(sheet, (col, row), body.clone());
        }
        for field in [
            "engagement_code",
            "outlook_hours",
            "task_count",
            "total_booking_hours",
            "client_code",
        ] {
            if let Some(&col) = columns.get(field) {
                sheet
                    .get_style_mut((col, row))
                    .alignment_mut()
                    .set_horizontal(HorizontalAlignmentValues::Center);
            }
        }
        for field in ["outlook_hours", "task_count", "total_booking_hours"] {
            if let Some(&col) = columns.get(field) {
                sheet
                    .get_style_mut((col, row))
                    .number_format_mut()
                    .set_format_code("#,##0.00");
            }
        }
        // 旧版成果固定把第 18 列作为返回服务方案的链接列。
        if sheet.get_highest_column() >= 18 {
            sheet
                .get_style_mut((18, row))
                .alignment_mut()
                .set_horizontal(HorizontalAlignmentValues::Left);
            sheet
                .get_style_mut((19, row))
                .alignment_mut()
                .set_horizontal(HorizontalAlignmentValues::Center);
            sheet
                .get_style_mut((19, row))
                .number_format_mut()
                .set_format_code("#,##0.00");
        }
        for column in columns
            .get("service_number")
            .copied()
            .into_iter()
            .chain((sheet.get_highest_column() >= 18).then_some(18))
        {
            if !sheet.value((column, row)).is_empty() {
                let style = sheet.get_style_mut((column, row));
                style.set_background_color(PALE_TEAL);
                style
                    .font_mut()
                    .set_bold(true)
                    .set_underline("single")
                    .color_mut()
                    .set_argb_str(TEAL);
            }
        }
    }
    configure_view(sheet, 2);
    set_tab_color(
        sheet,
        if sheet.get_name() == "AUD2026" {
            GOLD
        } else if sheet.get_name() == "IPO" {
            TEAL
        } else {
            MUTED
        },
    );
    if max_row >= 2 {
        if let Some(&col) = columns.get("schedule_status") {
            let letter = column_name(col);
            add_formula_conditional(
                sheet,
                format!("{letter}2:{letter}{max_row}"),
                format!("{letter}2=\"已完成\""),
                conditional_style(PALE_GREEN, GREEN),
                1,
            );
        }
        if let Some(&col) = columns.get("project_status") {
            let letter = column_name(col);
            add_formula_conditional(
                sheet,
                format!("{letter}2:{letter}{max_row}"),
                format!("{letter}2=\"项目承接\""),
                conditional_style(LIGHT_GOLD, NAVY),
                2,
            );
        }
    }
    configure_print(
        sheet,
        &format!("$A$1:${}${max_row}", column_name(max_col)),
        Some("$1:$1"),
    );
}

fn style_service_sheet(sheet: &mut Worksheet) {
    set_column_widths(
        sheet,
        &[
            ("A", 13.0),
            ("B", 36.0),
            ("C", 15.0),
            ("D", 15.0),
            ("E", 17.0),
            ("F", 15.0),
            ("G", 16.0),
            ("H", 18.0),
            ("I", 14.0),
        ],
    );
    configure_view(sheet, 5);
    for (row, height) in [
        (1, 30.0),
        (2, 42.0),
        (4, 32.0),
        (39, 28.0),
        (40, 30.0),
        (55, 28.0),
        (62, 29.0),
    ] {
        set_row_height(sheet, row, height);
    }
    for row in 5..=36 {
        set_row_height(sheet, row, 27.0);
    }
    for row in 41..=54 {
        set_row_height(sheet, row, 26.0);
    }
    for row in 58..=61 {
        set_row_height(sheet, row, 27.0);
    }
    let navy_header = cell_style(Some(NAVY), WHITE, true, 10.0, true);
    let teal_header = cell_style(Some(TEAL), WHITE, true, 10.0, true);
    for col in 1..=8 {
        set_visual_style(sheet, (col, 1), navy_header.clone());
        set_visual_style(sheet, (col, 4), teal_header.clone());
        set_visual_style(sheet, (col, 40), navy_header.clone());
    }
    for col in 1..=8 {
        set_visual_style(
            sheet,
            (col, 2),
            cell_style(Some(WHITE), TEXT, matches!(col, 2 | 3 | 4), 10.0, false),
        );
    }
    // 旧版把 E1:H2 重新刷成无边框白底正文：第 1 行这四格不是表头。
    for row in [1, 2] {
        for col in 5..=8 {
            set_visual_style(
                sheet,
                (col, row),
                cell_style(Some(WHITE), TEXT, false, 10.0, false),
            );
            sheet.get_style_mut((col, row)).remove_borders();
        }
    }
    if !sheet.value("I1").is_empty()
        || sheet
            .get_cell("I1")
            .is_some_and(|cell| !cell.get_formula().is_empty())
    {
        set_visual_style_named(sheet, "I1", cell_style(Some(TEAL), WHITE, true, 10.0, true));
        sheet.get_style_mut("I1").font_mut().set_underline("single");
    }
    for col in 1..=8 {
        set_visual_style(sheet, (col, 39), section_title_style(GOLD, NAVY));
    }
    set_visual_style_named(
        sheet,
        "I4",
        cell_style(Some(WHITE), TEXT, false, 10.0, false),
    );
    sheet.get_style_mut("I4").remove_borders();
    for row in 5..=36 {
        let fill = if row % 2 == 0 { LIGHT } else { WHITE };
        for col in 1..=8 {
            set_visual_style(
                sheet,
                (col, row),
                cell_style(Some(fill), TEXT, false, 9.0, col != 2),
            );
        }
        clear_wrap(sheet, (1, row));
        for col in [3, 4, 6] {
            sheet
                .get_style_mut((col, row))
                .set_background_color(LIGHT_GOLD);
        }
        sheet
            .get_style_mut((5, row))
            .set_background_color(PALE_BLUE);
        sheet.get_style_mut((8, row)).set_background_color(LIGHT);
        for col in [5, 7, 8] {
            sheet
                .get_style_mut((col, row))
                .number_format_mut()
                .set_format_code("0.00");
        }
    }
    for col in 1..=8 {
        set_visual_style(
            sheet,
            (col, 37),
            cell_style(Some(PALE_TEAL), TEXT, matches!(col, 4 | 6 | 7), 9.0, false),
        );
    }
    set_number_format(sheet, "G37", "#,##0.00");
    for row in 41..=54 {
        let fill = if row % 2 == 0 { LIGHT } else { WHITE };
        for col in 1..=8 {
            set_visual_style(
                sheet,
                (col, row),
                cell_style(Some(fill), TEXT, false, 9.0, col == 3),
            );
        }
    }
    for col in 1..=8 {
        set_visual_style(sheet, (col, 55), section_title_style(TEAL, WHITE));
    }
    for col in 1..=8 {
        set_visual_style(
            sheet,
            (col, 56),
            cell_style(Some(PALE_TEAL), TEXT, col <= 2, 9.0, false),
        );
    }
    for col in 1..=6 {
        set_visual_style(sheet, (col, 57), navy_header.clone());
    }
    for col in 7..=8 {
        set_visual_style(
            sheet,
            (col, 57),
            cell_style(Some(LIGHT), TEXT, false, 9.0, false),
        );
    }
    for row in 58..=61 {
        let fill = if row % 2 == 0 { WHITE } else { LIGHT };
        for col in 1..=8 {
            set_visual_style(
                sheet,
                (col, row),
                cell_style(Some(fill), TEXT, false, 9.0, false),
            );
        }
        set_number_format(sheet, &format!("B{row}"), "0%");
        for col in ['C', 'D', 'E', 'F'] {
            set_number_format(sheet, &format!("{col}{row}"), "#,##0.00");
        }
    }
    for col in 1..=8 {
        set_visual_style(
            sheet,
            (col, 62),
            cell_style(
                Some(LIGHT_GOLD),
                TEXT,
                matches!(col, 1 | 2 | 3 | 6),
                9.0,
                false,
            ),
        );
    }
    set_number_format(sheet, "B56", "#,##0.00");
    set_number_format(sheet, "B62", "0%");
    set_number_format(sheet, "C62", "#,##0.00");
    set_number_format(sheet, "F62", "#,##0.00");
    set_number_format(sheet, "C2", "#,##0.00");
    set_number_format(sheet, "D2", "#,##0.00");
    set_tab_color(sheet, TEAL);
    configure_print(sheet, "$A$1:$H$62", Some("$1:$4"));
}

fn style_index_sheet(sheet: &mut Worksheet) {
    set_column_widths(
        sheet,
        &[
            ("A", 8.0),
            ("B", 10.0),
            ("C", 38.0),
            ("D", 27.0),
            ("E", 28.0),
            ("F", 24.0),
            ("G", 19.0),
            ("H", 19.0),
            ("I", 14.0),
            ("J", 16.0),
            ("K", 16.0),
        ],
    );
    configure_view(sheet, 8);
    set_row_height(sheet, 1, 46.0);
    set_row_height(sheet, 2, 27.0);
    set_row_height(sheet, 7, 32.0);
    // 标题条旧版只设了填充/字体/对齐，没有边框也没有换行。
    set_visual_style_named(
        sheet,
        "A1",
        cell_style(Some(NAVY), WHITE, true, 20.0, false),
    );
    set_visual_style_named(
        sheet,
        "A2",
        cell_style(Some(NAVY), "DDE8F0", false, 10.0, false),
    );
    for row in [1, 2] {
        sheet.get_style_mut((1, row)).remove_borders();
        clear_wrap(sheet, (1, row));
    }
    for col in [1, 3, 5, 7] {
        set_visual_style(
            sheet,
            (col, 4),
            cell_style(Some(PALE_TEAL), MUTED, true, 9.0, false),
        );
    }
    for col in [2, 4, 6, 8] {
        set_visual_style(
            sheet,
            (col, 4),
            cell_style(Some(WHITE), NAVY, true, 12.0, true),
        );
    }
    let header = cell_style(Some(TEAL), WHITE, true, 10.0, true);
    for col in 1..=11 {
        set_visual_style(sheet, (col, 7), header.clone());
    }
    for row in 8..=sheet.get_highest_row() {
        set_row_height(sheet, row, 28.0);
        let fill = if row % 2 == 0 { WHITE } else { LIGHT };
        for col in 1..=11 {
            set_visual_style(
                sheet,
                (col, row),
                cell_style(Some(fill), TEXT, false, 9.0, matches!(col, 1 | 2 | 10 | 11)),
            );
        }
        for col in [1, 2, 10, 11] {
            clear_wrap(sheet, (col, row));
        }
        for col in [7, 8, 9] {
            sheet
                .get_style_mut((col, row))
                .number_format_mut()
                .set_format_code("#,##0.00");
        }
        sheet
            .get_style_mut((11, row))
            .set_background_color(PALE_TEAL);
        sheet
            .get_style_mut((11, row))
            .font_mut()
            .set_bold(true)
            .set_underline("single")
            .color_mut()
            .set_argb_str(TEAL);
    }
    set_tab_color(sheet, GOLD);
    configure_print(
        sheet,
        &format!("$A$1:$K${}", sheet.get_highest_row()),
        Some("$7:$7"),
    );
}
fn quote_sheet(name: &str) -> String {
    name.replace('\'', "''")
}
fn hyperlink_formula(sheet: &str, cell: &str, display: &str) -> String {
    format!(
        "HYPERLINK(\"#'{}'!{}\",\"{}\")",
        quote_sheet(sheet),
        cell,
        display.replace('"', "\"\"")
    )
}

fn locate_template(book: &Workbook) -> Result<String> {
    let mut inspected = Vec::new();
    for sheet in book.get_sheet_collection() {
        let a1 = sheet.value("A1");
        let b4 = sheet.value("B4");
        let count = (5..=36)
            .filter(|row| !sheet.value((2, *row)).is_empty())
            .count();
        inspected.push(format!(
            "{}[A1={a1:?},B4={b4:?},Section={count}]",
            sheet.get_name()
        ));
        // umya-spreadsheet intentionally exposes an empty value for A1 when
        // that anchor participates in the template's merged title range.
        // B4 plus the exact 32 populated Section rows is the same unambiguous
        // template signature used by the legacy code.
        if b4 == "Section" {
            if count == 32 {
                return Ok(sheet.get_name().to_owned());
            }
        }
    }
    Err(WpError(format!(
        "找不到包含 32 个 Section 的服务方案模板。已检查：{}",
        inspected.join("；")
    )))
}

fn template_reference_column(template: &Worksheet) -> u32 {
    // Do not rely only on the Chinese header text. Some historical templates
    // were saved through a non-Unicode locale and their headers are mojibake
    // even though the numeric reference column remains intact.
    let populated_numbers = |column: u32| {
        (5..=36)
            .filter(|row| {
                template
                    .value((column, *row))
                    .replace(',', "")
                    .trim()
                    .parse::<f64>()
                    .is_ok()
            })
            .count()
    };
    let h_numbers = populated_numbers(8);
    let i_numbers = populated_numbers(9);
    if template.value("H4") == "Section系统编号" || i_numbers > h_numbers {
        9
    } else {
        8
    }
}

#[derive(Default)]
struct TemplateMetadata {
    section_by_row: HashMap<u32, String>,
    reference_by_section: HashMap<String, f64>,
    /// Every literal text cell of the template, keyed by 1-based (column, row)
    /// **before** the reference-column shift.  umya keeps the template styles
    /// but only exposes the first run of a rich-text shared string, so labels
    /// such as `WP服务单编号` come back as `WP` and `阶段`/`预审下场时间`
    /// come back empty.  Calamine is the canonical reader; these values are
    /// written back verbatim once the sheet layout is final.
    text_by_cell: HashMap<(u32, u32), String>,
}

fn load_template_metadata(path: &Path, sheet_name: &str) -> Result<TemplateMetadata> {
    // Several Section labels are rich-text shared strings. umya preserves the
    // workbook styles, but exposes only part of those text runs; Calamine is
    // therefore the canonical value reader for this template.
    let rows = read_first_sheet(path, Some(sheet_name))?;
    let numeric_count = |index: usize| {
        (5..=36_usize)
            .filter(|row| {
                rows.get(row - 1)
                    .and_then(|values| values.get(index))
                    .is_some_and(|value| {
                        !value.is_empty() && value.text().replace(',', "").parse::<f64>().is_ok()
                    })
            })
            .count()
    };
    let value_index = if numeric_count(8) > numeric_count(7) {
        8
    } else {
        7
    };
    let mut metadata = TemplateMetadata::default();
    for (row_index, values) in rows.iter().enumerate() {
        for (col_index, value) in values.iter().enumerate() {
            if let Value::Text(text) = value {
                if !text.is_empty() {
                    metadata
                        .text_by_cell
                        .insert((col_index as u32 + 1, row_index as u32 + 1), text.clone());
                }
            }
        }
    }
    for row in 5..=36_u32 {
        let Some(values) = rows.get(row as usize - 1) else {
            continue;
        };
        let section = values.get(1).map(Value::text).unwrap_or_default();
        let key = normalize_section(&section);
        if key.is_empty() {
            continue;
        }
        metadata.section_by_row.insert(row, section);
        metadata.reference_by_section.insert(
            key,
            values.get(value_index).map(Value::number).unwrap_or(0.0),
        );
    }
    if metadata.section_by_row.len() != 32 {
        return Err(WpError(format!(
            "服务方案模板应包含32个Section，实际读取{}个。",
            metadata.section_by_row.len()
        )));
    }
    Ok(metadata)
}

fn calculate_outlook(
    records: &[Record],
    details: &SectionDetails,
    reference: &HashMap<String, f64>,
) -> (usize, usize, usize, usize, Vec<OutlookDifference>) {
    let mut template_rows = 0;
    let mut populated_rows = 0;
    let mut compared = 0;
    let mut equal = 0;
    let mut differences = Vec::new();
    for record in records {
        let project = details.get(&normalize_order(&record.service_number));
        let mut total = 0.0;
        let mut has_data = false;
        if let Some(project) = project {
            for (section, item) in project {
                let Some(reference) = reference.get(section) else {
                    continue;
                };
                template_rows += 1;
                if item.entity.is_some() || item.drafts.is_some() || item.budget.is_some() {
                    populated_rows += 1;
                }
                if item.entity.is_none() && item.budget.is_none() {
                    continue;
                }
                has_data = true;
                total +=
                    round2(item.entity.unwrap_or(0.0) * reference + item.budget.unwrap_or(0.0));
            }
        }
        if has_data {
            let calculated = round2(total * 1.1);
            let source = round2(record.outlook_hours);
            let difference = round2(calculated - source);
            compared += 1;
            if difference.abs() <= 0.01 {
                equal += 1;
            } else {
                differences.push(OutlookDifference {
                    service_number: record.service_number.clone(),
                    engagement_name: record.engagement_name.clone(),
                    calculated,
                    source,
                    difference,
                });
            }
        }
    }
    (template_rows, populated_rows, compared, equal, differences)
}

/// 把 Calamine 读到的模板文本原样写回，补上 umya 丢失的富文本 run。
///
/// `shifted` 表示这张表已按旧版 `delete_cols(8, 1)` 把 I 列并到 H 列。
fn restore_template_text(sheet: &mut Worksheet, metadata: &TemplateMetadata, shifted: bool) {
    let highest_row = sheet.get_highest_row();
    let mut restore: Vec<((u32, u32), String)> = metadata
        .text_by_cell
        .iter()
        .filter_map(|(&(column, row), text)| {
            if row > highest_row {
                return None;
            }
            let column = match (shifted, column) {
                (true, 8) => return None,
                (true, column) if column > 8 => column - 1,
                (_, column) => column,
            };
            Some(((column, row), text.clone()))
        })
        .collect();
    restore.sort_by_key(|(coordinate, _)| *coordinate);
    for ((column, row), text) in restore {
        // 模板里的公式不能被字面文本覆盖。
        if sheet
            .get_cell((column, row))
            .is_some_and(|cell| !cell.get_formula().is_empty())
        {
            continue;
        }
        sheet.get_cell_mut((column, row)).set_value_string(text);
    }
    // The sanitized built-in template accidentally removed this non-client,
    // fixed guidance block. Restore only blank cells so a caller-provided
    // template can still override the wording.
    for (offset, note) in TIMELINE_NOTES.iter().enumerate() {
        let row = 41 + offset as u32;
        if row <= highest_row && sheet.value((4, row)).is_empty() {
            sheet.get_cell_mut((4, row)).set_value_string(*note);
        }
    }
}

fn prepare_template(template: &mut Worksheet, metadata: &TemplateMetadata) {
    let shifted = template_reference_column(template) == 9;
    if shifted {
        // umya 3.0.1 does not reliably shift sparse styled cells when a
        // column is removed.  The legacy delete-H operation is therefore
        // reproduced explicitly: copy I (参考时间/Entity) into H with its
        // complete style/value, then clear I for the navigation link column.
        let highest = template.get_highest_row();
        for row in 1..=highest {
            if let Some(source) = template.get_cell((9, row)).cloned() {
                let value = source.get_value().to_owned();
                let formula = source.get_formula().to_owned();
                let style = template.get_style((9, row)).clone();
                let target = template.get_cell_mut((8, row));
                if formula.is_empty() {
                    target.set_value(value);
                } else {
                    target.set_formula(formula);
                }
                template.set_style((8, row), style);
            }
            template.get_cell_mut((9, row)).set_blank();
            // 旧版是 delete_cols(8, 1)：整列连同样式一起消失。只清值会把
            // 模板 I 列的居中/边框留在导航列上，所以样式也要一并复位。
            template.set_style((9, row), Style::default());
        }
    }
    if template.get_highest_row() >= 55 {
        template.remove_row(55, template.get_highest_row() - 54);
    }
    restore_template_text(template, metadata, shifted);
    for (row, section) in &metadata.section_by_row {
        set_text(template, &format!("B{row}"), section);
    }
    // 旧版把参考工时列强制转成 float，转不动就清空——模板里这一列有不少是
    // 文本数字，留成文本会让 H 列显示为左对齐字符串。
    for row in 5..=36_u32 {
        let raw = template.value((8, row));
        let cell = template.get_cell_mut((8, row));
        match raw.replace(',', "").trim().parse::<f64>() {
            Ok(number) if !raw.trim().is_empty() => {
                cell.set_value_number(number);
            }
            _ => {
                cell.set_blank();
            }
        }
    }
}

fn fill_service_sheet(
    sheet: &mut Worksheet,
    record: &Record,
    details: &SectionDetails,
    template_metadata: &TemplateMetadata,
    ser: &[(f64, f64); 4],
) {
    set_text(sheet, "A2", &record.related_order);
    set_text(sheet, "B2", &record.service_number);
    for coordinate in ["E1", "F1", "G1", "H1", "E2", "F2", "G2", "H2"] {
        set_text(sheet, coordinate, "");
    }
    set_text(sheet, "C1", "Outlook Hours");
    set_formula(sheet, "C2", "G37");
    set_text(sheet, "D1", "SER");
    set_formula(sheet, "D2", "F62");
    set_formula(
        sheet,
        "I1",
        hyperlink_formula(
            record.source_sheet,
            &format!("A{}", record.source_row),
            "返回源表",
        ),
    );
    set_text(sheet, "H4", "参考时间/Entity");
    let project = details.get(&normalize_order(&record.service_number));
    for row in 5..=36 {
        let section = template_metadata
            .section_by_row
            .get(&row)
            .cloned()
            .unwrap_or_else(|| sheet.value((2, row)));
        set_text(sheet, &format!("B{row}"), &section);
        let imported = project.and_then(|project| project.get(&normalize_section(&section)));
        for (col, value) in [
            (3, imported.and_then(|item| item.entity)),
            (4, imported.and_then(|item| item.drafts)),
            (6, imported.and_then(|item| item.budget)),
        ] {
            let cell = sheet.get_cell_mut((col, row));
            if let Some(value) = value {
                cell.set_value_number(value);
            } else {
                cell.set_value("");
            }
        }
        set_formula(
            sheet,
            &format!("E{row}"),
            format!(
                "IF(OR(C{row}=\"\",H{row}=\"\"),\"\",ROUND(C{row}*IFERROR(VALUE(H{row}),0),2))"
            ),
        );
        set_formula(
            sheet,
            &format!("G{row}"),
            format!(
                "IF(AND(F{row}=\"\",OR(C{row}=\"\",H{row}=\"\")),\"\",ROUND(IF(OR(C{row}=\"\",H{row}=\"\"),0,C{row}*IFERROR(VALUE(H{row}),0))+IFERROR(VALUE(F{row}),0),2))"
            ),
        );
    }
    set_formula(sheet, "G37", "SUM(G5:G36)*1.1");
    for (coordinate, value) in [
        ("C41", &record.pre_start),
        ("C42", &record.pre_end),
        ("C47", &record.final_start),
        ("C48", &record.final_end),
        ("C52", &record.report_date),
    ] {
        set_cell_value(
            sheet,
            coordinate.chars().next().unwrap() as u32 - 64,
            coordinate[1..].parse().unwrap(),
            value,
        );
    }
    set_text(sheet, "A55", "SER测算（计算上浮5%）");
    set_text(sheet, "A56", "Total Outlook Hours");
    set_formula(sheet, "B56", "G37");
    let headers = [
        "",
        "Hours占比",
        "分配Hours",
        "bill rate",
        "上浮5%",
        "SER金额",
    ];
    for (index, header) in headers.iter().enumerate() {
        set_text(
            sheet,
            &format!("{}57", (b'A' + index as u8) as char),
            *header,
        );
    }
    for (offset, (mix, rate)) in ser.iter().enumerate() {
        let row = 58 + offset;
        set_text(sheet, &format!("A{row}"), SER_ROLES[offset]);
        set_number(sheet, &format!("B{row}"), *mix);
        set_formula(sheet, &format!("C{row}"), format!("B{row}*$G$37"));
        set_number(sheet, &format!("D{row}"), *rate);
        set_formula(sheet, &format!("E{row}"), format!("D{row}*1.05"));
        set_formula(sheet, &format!("F{row}"), format!("C{row}*E{row}"));
    }
    set_text(sheet, "A62", "合计");
    set_formula(sheet, "B62", "SUM(B58:B61)");
    set_formula(sheet, "C62", "SUM(C58:C61)");
    set_formula(sheet, "F62", "SUM(F58:F61)");
}

fn write_split_workbook(
    template_path: &Path,
    output_path: &Path,
    template: &Worksheet,
    metadata: &TemplateMetadata,
    split: &SplitData,
) -> Result<()> {
    let mut book = umya_spreadsheet::reader::xlsx::read(template_path)
        .map_err(|error| WpError(format!("无法读取服务方案模板：{error}")))?;
    while book.get_sheet_count() > 0 {
        book.remove_sheet(0)
            .map_err(|error| WpError(error.to_string()))?;
    }
    for name in BASE_SHEETS {
        // 旧版拆分簿的四张来源表是 create_sheet + append 出来的裸表：
        // 没有排版，也不继承模板表遗留的列。
        let source = clear_and_fill_source(
            Worksheet::default(),
            name,
            &split.headers,
            &split.groups[name],
            false,
        );
        book.add_sheet(source)
            .map_err(|error| WpError(error.to_string()))?;
    }
    let mut hidden_template = template.clone();
    hidden_template.set_name("_WP_TEMPLATE");
    hidden_template.set_state(SheetStateValues::Hidden);
    restore_template_text(&mut hidden_template, metadata, false);
    book.add_sheet(hidden_template)
        .map_err(|error| WpError(error.to_string()))?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    umya_spreadsheet::writer::xlsx::write(&book, output_path)
        .map_err(|error| WpError(format!("无法写入自动拆分工作簿：{error}")))
}

fn clear_and_fill_source(
    mut sheet: Worksheet,
    name: &str,
    headers: &[Value],
    rows: &[Vec<Value>],
    styled: bool,
) -> Worksheet {
    sheet.set_name(name);
    let highest = sheet.get_highest_row();
    if highest > 1 {
        sheet.remove_row(2, highest - 1);
    }
    for (col, value) in headers.iter().enumerate() {
        set_cell_value(&mut sheet, col as u32 + 1, 1, value);
    }
    for (row_index, row) in rows.iter().enumerate() {
        let target_row = row_index as u32 + 2;
        for (col_index, value) in row.iter().enumerate() {
            set_cell_value(&mut sheet, col_index as u32 + 1, target_row, value);
            let header = headers.get(col_index).map(Value::text).unwrap_or_default();
            if matches!(value, Value::Number(_))
                && (header.contains("BookingPeriod")
                    || compact(&header).eq_ignore_ascii_case("AuditReportDate"))
            {
                sheet
                    .get_style_mut((col_index as u32 + 1, target_row))
                    .number_format_mut()
                    .set_format_code("yyyy-mm-dd");
            }
        }
    }
    if !styled {
        // 裸表沿用 Excel/openpyxl 新建工作表的页边距，别留 umya 的全 0。
        sheet
            .get_page_margins_mut()
            .set_left(0.75)
            .set_right(0.75)
            .set_top(1.0)
            .set_bottom(1.0)
            .set_header(0.5)
            .set_footer(0.5);
    }
    if styled {
        sheet.set_auto_filter(format!(
            "A1:{}{}",
            column_name(headers.len() as u32),
            rows.len() + 1
        ));
        style_source_sheet(&mut sheet);
    }
    sheet
}

/// 打印区域/打印标题必须写成"属于某张表"的定义名。
///
/// umya 只有在 `localSheetId` 被显式赋值时才输出该属性；缺了它，90 张表会写出
/// 90 组同名的工作簿级定义名，Excel 打开时判为重复名称，打印区域和顶端标题行
/// 直接失效。
fn assign_local_sheet_ids(book: &mut Workbook) {
    for (index, sheet) in book.get_sheet_collection_mut().iter_mut().enumerate() {
        for defined in sheet.defined_names_mut() {
            defined.set_local_sheet_id(index as u32);
        }
    }
}

/// umya 3.0.1 把 `calcPr` 写死成只有 `calcId`，也完全不支持 `pageSetUpPr`。
/// 这两项旧版都有（打开时全部重算、缩放到一页宽），只能在写盘后补进 XML。
fn finalize_workbook_xml(path: &Path) -> Result<()> {
    let data = fs::read(path)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|error| WpError(format!("无法打开结果工作簿：{error}")))?;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| WpError(format!("无法读取结果工作簿部件：{error}")))?;
        let name = file.name().to_owned();
        if name.ends_with('/') {
            continue;
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes)?;
        if name == "xl/workbook.xml" {
            bytes = patch_calculation_properties(&bytes);
        } else if name == "xl/styles.xml" {
            bytes = patch_differential_fonts(&bytes);
        } else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") {
            bytes = patch_fit_to_page(&bytes);
        }
        entries.push((name, bytes));
    }
    let mut writer = zip::ZipWriter::new(fs::File::create(path)?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer
            .start_file(name, options)
            .map_err(|error| WpError(format!("无法写回结果工作簿：{error}")))?;
        std::io::Write::write_all(&mut writer, &bytes)?;
    }
    writer
        .finish()
        .map_err(|error| WpError(format!("无法关闭结果工作簿：{error}")))?;
    Ok(())
}

const CALC_PR: &str =
    "<calcPr calcId=\"122211\" calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/>";

fn patch_calculation_properties(bytes: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    if let Some(start) = text.find("<calcPr") {
        if let Some(offset) = text[start..].find("/>") {
            let end = start + offset + 2;
            return format!("{}{CALC_PR}{}", &text[..start], &text[end..]).into_bytes();
        }
    }
    if let Some(position) = text.rfind("</workbook>") {
        return format!("{}{CALC_PR}{}", &text[..position], &text[position..]).into_bytes();
    }
    bytes.to_vec()
}

/// umya 的 `Font` 总会把字体名/字号/family/scheme 写进差异格式。
///
/// 条件格式命中时这些会覆盖单元格原有的 Microsoft YaHei 9，把整格换成
/// Calibri 11。旧版的 dxf 只有加粗和颜色，这里把多余的子元素删掉。
fn patch_differential_fonts(bytes: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    let Some(start) = text.find("<dxfs") else {
        return bytes.to_vec();
    };
    let Some(offset) = text[start..].find("</dxfs>") else {
        return bytes.to_vec();
    };
    let end = start + offset + "</dxfs>".len();
    let mut block = text[start..end].to_owned();
    for tag in ["<sz ", "<name ", "<family ", "<scheme "] {
        while let Some(position) = block.find(tag) {
            let Some(close) = block[position..].find("/>") else {
                break;
            };
            block.replace_range(position..position + close + 2, "");
        }
    }
    format!("{}{block}{}", &text[..start], &text[end..]).into_bytes()
}

const FIT_TO_PAGE: &str = "<pageSetUpPr fitToPage=\"1\"/>";

fn patch_fit_to_page(bytes: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return bytes.to_vec();
    };
    if text.contains("<pageSetUpPr") || !text.contains("<pageSetup") {
        return bytes.to_vec();
    }
    // `<sheetPr` 也是 `<sheetProtection` 的前缀，必须连分隔符一起匹配。
    let opening = ["<sheetPr>", "<sheetPr ", "<sheetPr/"]
        .iter()
        .find_map(|marker| text.find(marker).map(|start| (start, *marker)));
    match opening {
        Some((start, "<sheetPr>")) => {
            let Some(offset) = text[start..].find("</sheetPr>") else {
                return bytes.to_vec();
            };
            let position = start + offset;
            format!("{}{FIT_TO_PAGE}{}", &text[..position], &text[position..]).into_bytes()
        }
        Some((start, _)) => {
            // 自闭合 `<sheetPr .../>` 要展开成有子元素的写法。
            let Some(offset) = text[start..].find('>') else {
                return bytes.to_vec();
            };
            let end = start + offset + 1;
            let head = &text[start..end];
            if head.ends_with("/>") {
                let attributes = &head[..head.len() - 2];
                format!(
                    "{}{attributes}>{FIT_TO_PAGE}</sheetPr>{}",
                    &text[..start],
                    &text[end..]
                )
                .into_bytes()
            } else {
                let Some(close) = text[end..].find("</sheetPr>") else {
                    return bytes.to_vec();
                };
                let position = end + close;
                format!("{}{FIT_TO_PAGE}{}", &text[..position], &text[position..]).into_bytes()
            }
        }
        None => {
            let Some(offset) = text.find("<worksheet") else {
                return bytes.to_vec();
            };
            let Some(close) = text[offset..].find('>') else {
                return bytes.to_vec();
            };
            let position = offset + close + 1;
            format!(
                "{}<sheetPr>{FIT_TO_PAGE}</sheetPr>{}",
                &text[..position],
                &text[position..]
            )
            .into_bytes()
        }
    }
}

fn column_name(mut column: u32) -> String {
    let mut name = String::new();
    while column > 0 {
        column -= 1;
        name.insert(0, (b'A' + (column % 26) as u8) as char);
        column /= 26;
    }
    name
}

fn build_index(service_sheets: &[Worksheet], records: &[Record]) -> Worksheet {
    let mut sheet = Worksheet::default();
    sheet.set_name("服务方案索引");
    set_text(&mut sheet, "A1", "FY27 WP 服务方案清单");
    sheet.add_merge_cells("A1:K1");
    set_text(
        &mut sheet,
        "A2",
        "项目组展示版 · 服务单、相关订单、Section 与 SER 测算集中查看",
    );
    sheet.add_merge_cells("A2:K2");
    set_text(&mut sheet, "A4", "服务方案");
    set_number(&mut sheet, "B4", service_sheets.len() as f64);
    set_text(&mut sheet, "C4", "AUD2026项目");
    set_number(
        &mut sheet,
        "D4",
        records
            .iter()
            .filter(|record| record.source_sheet == "AUD2026")
            .count() as f64,
    );
    set_text(&mut sheet, "E4", "IPO项目");
    set_number(
        &mut sheet,
        "F4",
        records
            .iter()
            .filter(|record| record.source_sheet == "IPO")
            .count() as f64,
    );
    set_text(&mut sheet, "G4", "生成日期");
    set_text(
        &mut sheet,
        "H4",
        chrono::Local::now().date_naive().to_string(),
    );
    let headers = [
        "序号",
        "来源",
        "项目名称",
        "WP服务单编号",
        "相关订单",
        "WP FIC",
        "预算Outlook Hours",
        "源表Outlook Hours",
        "差异",
        "核对结果",
        "查看服务方案",
    ];
    for (index, header) in headers.iter().enumerate() {
        set_text(
            &mut sheet,
            &format!("{}7", column_name(index as u32 + 1)),
            *header,
        );
    }
    for (index, (service, record)) in service_sheets.iter().zip(records).enumerate() {
        let row = index + 8;
        let quoted = quote_sheet(service.get_name());
        let values = [
            record.source_sheet.to_owned(),
            service.get_name().to_owned(),
            record.service_number.clone(),
            record.related_order.clone(),
            record.wp_fic.clone(),
        ];
        set_number(&mut sheet, &format!("A{row}"), index as f64 + 1.0);
        for (col, value) in (2..=6).zip(values) {
            set_text(&mut sheet, &format!("{}{row}", column_name(col)), value);
        }
        set_formula(&mut sheet, &format!("G{row}"), format!("'{quoted}'!C2"));
        set_number(&mut sheet, &format!("H{row}"), record.outlook_hours);
        let has_data = (5..=36)
            .any(|r| !service.value((3, r)).is_empty() || !service.value((6, r)).is_empty());
        if has_data {
            set_formula(
                &mut sheet,
                &format!("I{row}"),
                format!("IF(OR(G{row}=\"\",H{row}=\"\"),\"\",G{row}-H{row})"),
            );
            set_formula(
                &mut sheet,
                &format!("J{row}"),
                format!("IF(I{row}=\"\",\"\",IF(ABS(I{row})<=0.01,\"一致\",\"不一致\"))"),
            );
        } else {
            set_text(&mut sheet, &format!("J{row}"), "待补充Section");
        }
        set_formula(
            &mut sheet,
            &format!("K{row}"),
            hyperlink_formula(service.get_name(), "A1", "打开"),
        );
    }
    sheet.set_auto_filter(format!("A7:K{}", service_sheets.len() + 7));
    style_index_sheet(&mut sheet);
    sheet
}

fn rewrite_source_links(book: &mut Workbook, records: &[Record]) {
    let by_service: HashMap<&str, &Record> = records
        .iter()
        .map(|record| (record.service_number.as_str(), record))
        .collect();
    for source in ["AUD2026", "IPO"] {
        if let Ok(sheet) = book.get_sheet_by_name_mut(source) {
            let columns = sheet_source_columns(sheet);
            let Some(&service_column) = columns.get("service_number") else {
                continue;
            };
            let legacy_link_column = (sheet.get_highest_column() >= 18).then_some(18_u32);
            for row in 2..=sheet.get_highest_row() {
                let service = sheet.value((service_column, row));
                if let Some(record) = by_service.get(service.as_str()) {
                    set_formula(
                        sheet,
                        &format!("{}{row}", column_name(service_column)),
                        hyperlink_formula(&record.sheet_name, "A1", &service),
                    );
                    let Some(legacy_link_column) = legacy_link_column else {
                        continue;
                    };
                    let link_text = sheet.value((legacy_link_column, row));
                    if !link_text.is_empty() {
                        set_formula(
                            sheet,
                            &format!("{}{row}", column_name(legacy_link_column)),
                            hyperlink_formula(&record.sheet_name, "A1", &link_text),
                        );
                    }
                }
            }
        }
    }
}

pub fn generate(params: &WpGenerateParams) -> Result<WpGenerateResult> {
    generate_cancellable(params, &AtomicBool::new(false), None)
}

fn generate_cancellable(
    params: &WpGenerateParams,
    cancel: &AtomicBool,
    pause: Option<&PauseCheckpoint>,
) -> Result<WpGenerateResult> {
    let pause_wait = || -> Result<()> {
        if let Some(gate) = pause {
            gate.wait().map_err(|_| WpError("任务已取消。".into()))?;
        }
        Ok(())
    };
    pause_wait()?;
    if !params.input_path.exists() {
        return Err(WpError(format!(
            "输入文件不存在：{}",
            params.input_path.display()
        )));
    }
    if !params.template_path.exists() {
        return Err(WpError(format!(
            "服务方案模板不存在：{}",
            params.template_path.display()
        )));
    }
    let ipo_years = if params.ipo_years.is_empty() {
        default_ipo_years()
    } else {
        params.ipo_years.clone()
    };
    let split = split_raw(
        read_first_sheet(&params.input_path, Some("业务"))?,
        &ipo_years,
    )?;
    pause_wait()?;
    if cancel.load(Ordering::Relaxed) {
        return Err(WpError("任务已取消。".into()));
    }
    let mut records = collect_records(&split);
    if records.is_empty() {
        return Err(WpError("AUD2026 和 IPO 中没有找到 WP服务单编号。".into()));
    }
    let ser = load_ser_config(params.input_path.parent().unwrap_or(Path::new(".")))?;
    let section_path = match params.section_list_path.clone() {
        Some(path) => path,
        None => find_section_list_file(params.input_path.parent().unwrap_or(Path::new(".")))?,
    };
    let section = load_section_details(Some(&section_path), &records)?;
    pause_wait()?;
    if cancel.load(Ordering::Relaxed) {
        return Err(WpError("任务已取消。".into()));
    }
    let unmatched: Vec<String> = records
        .iter()
        .filter(|record| {
            !section
                .details
                .contains_key(&normalize_order(&record.service_number))
        })
        .map(|record| record.service_number.clone())
        .collect();

    let mut book = umya_spreadsheet::reader::xlsx::read(&params.template_path)
        .map_err(|error| WpError(format!("无法读取服务方案模板：{error}")))?;
    let template_name = locate_template(&book)?;
    let mut template = book
        .get_sheet_by_name(&template_name)
        .map_err(|error| WpError(error.to_string()))?
        .clone();
    let split_template = template.clone();
    let template_metadata = load_template_metadata(&params.template_path, &template_name)?;
    prepare_template(&mut template, &template_metadata);
    template.set_name("_WP_TEMPLATE");
    let outlook = calculate_outlook(
        &records,
        &section.details,
        &template_metadata.reference_by_section,
    );
    let mut used: HashSet<String> = BASE_SHEETS.iter().map(|name| name.to_lowercase()).collect();
    used.insert("服务方案索引".into());
    for record in &mut records {
        record.sheet_name = safe_sheet_name(&record.engagement_name, &mut used);
    }

    let mut pending_split = None;
    if let Some(split_output) = &params.split_output_path {
        pause_wait()?;
        let temporary = TemporaryArtifact::new(split_output.with_extension("xlsx.tmp"))?;
        write_split_workbook(
            &params.template_path,
            &temporary.path,
            &split_template,
            &template_metadata,
            &split,
        )?;
        pending_split = Some((temporary, split_output));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(WpError("任务已取消。".into()));
    }

    while book.get_sheet_count() > 0 {
        book.remove_sheet(0)
            .map_err(|error| WpError(error.to_string()))?;
    }
    let mut service_sheets = Vec::new();
    for record in &records {
        pause_wait()?;
        if cancel.load(Ordering::Relaxed) {
            return Err(WpError("任务已取消。".into()));
        }
        let mut sheet = template.clone();
        sheet.set_name(&record.sheet_name);
        // 模板在拆分簿里是隐藏表，克隆会连隐藏状态一起带过来——
        // 不复位的话 85 张服务方案在 Excel 里全部看不见。
        sheet.set_state(SheetStateValues::Visible);
        fill_service_sheet(
            &mut sheet,
            record,
            &section.details,
            &template_metadata,
            &ser,
        );
        style_service_sheet(&mut sheet);
        service_sheets.push(sheet);
    }
    book.add_sheet(build_index(&service_sheets, &records))
        .map_err(|error| WpError(error.to_string()))?;
    for name in BASE_SHEETS {
        let source = clear_and_fill_source(
            Worksheet::default(),
            name,
            &split.headers,
            &split.groups[name],
            true,
        );
        book.add_sheet(source)
            .map_err(|error| WpError(error.to_string()))?;
    }
    for sheet in service_sheets {
        book.add_sheet(sheet)
            .map_err(|error| WpError(error.to_string()))?;
    }
    rewrite_source_links(&mut book, &records);
    assign_local_sheet_ids(&mut book);

    if let Some(parent) = params.output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = TemporaryArtifact::new(params.output_path.with_extension("xlsx.tmp"))?;
    umya_spreadsheet::writer::xlsx::write(&book, &temporary.path)
        .map_err(|error| WpError(format!("无法写入结果工作簿：{error}")))?;
    finalize_workbook_xml(&temporary.path)?;
    validate_output(&temporary.path, records.len())?;
    if let Some((split_temporary, split_output)) = pending_split {
        split_temporary.commit(split_output, "无法保存 WP 自动拆分结果")?;
    }
    temporary.commit(&params.output_path, "无法保存 WP 服务方案结果")?;

    Ok(WpGenerateResult {
        output_path: params.output_path.to_string_lossy().into_owned(),
        split_file: params
            .split_output_path
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned()),
        sheets: book.get_sheet_count(),
        services: records.len(),
        index_rows: records.len(),
        aud2026_rows: split.groups["AUD2026"].len(),
        ipo_rows: split.groups["IPO"].len(),
        ipo_archive_rows: split.groups["IPO archive"].len(),
        aud2025_rows: split.groups["AUD2025"].len(),
        split_aud2026_rows: split.groups["AUD2026"].len(),
        split_ipo_rows: split.groups["IPO"].len(),
        split_ipo_archive_rows: split.groups["IPO archive"].len(),
        split_aud2025_rows: split.groups["AUD2025"].len(),
        section_list_found: section.found,
        matched_section_orders: section.details.len(),
        matched_section_rows: section.matched_rows,
        populated_section_rows: section.populated_rows,
        template_section_rows: outlook.0,
        populated_template_rows: outlook.1,
        outlook_compared: outlook.2,
        outlook_equal: outlook.3,
        outlook_differences: outlook.4,
        unmatched_section_orders: unmatched,
        excluded_ipo: split.excluded_ipo,
        excluded_other: split.excluded_other,
        ipo_years,
    })
}

pub fn validate_output(path: &Path, expected_services: usize) -> Result<()> {
    let book = umya_spreadsheet::reader::xlsx::read(path)
        .map_err(|error| WpError(format!("无法回读结果文件：{error}")))?;
    for name in ["服务方案索引", "AUD2026", "AUD2025", "IPO", "IPO archive"] {
        if book.get_sheet_by_name(name).is_err() {
            return Err(WpError(format!("生成后缺少工作表：{name}")));
        }
    }
    let base: HashSet<&str> = ["服务方案索引", "AUD2026", "AUD2025", "IPO", "IPO archive"]
        .into_iter()
        .collect();
    let services: Vec<&Worksheet> = book
        .get_sheet_collection()
        .iter()
        .filter(|sheet| !base.contains(sheet.get_name()))
        .collect();
    if services.len() != expected_services {
        return Err(WpError(format!(
            "服务方案数量不一致：{}/{}",
            services.len(),
            expected_services
        )));
    }
    for sheet in services {
        if (5..=36)
            .filter(|row| !sheet.value((2, *row)).is_empty())
            .count()
            != 32
        {
            return Err(WpError(format!("{} 未保留32个Section。", sheet.get_name())));
        }
        if sheet
            .get_cell((7, 37))
            .map(|cell| cell.get_formula())
            .unwrap_or_default()
            != "SUM(G5:G36)*1.1"
        {
            return Err(WpError(format!("{} Outlook公式异常。", sheet.get_name())));
        }
        if sheet
            .get_cell((6, 62))
            .map(|cell| cell.get_formula())
            .unwrap_or_default()
            != "SUM(F58:F61)"
        {
            return Err(WpError(format!("{} SER公式异常。", sheet.get_name())));
        }
        for coordinate in ["E1", "F1", "G1", "H1", "E2", "F2", "G2", "H2"] {
            if !sheet.value(coordinate).is_empty() {
                return Err(WpError(format!(
                    "{} 隐藏字段未清空：{coordinate}。",
                    sheet.get_name()
                )));
            }
        }
        if sheet.value("C1") != "Outlook Hours"
            || sheet.value("D1") != "SER"
            || sheet.value("H4") != "参考时间/Entity"
            || sheet
                .get_cell("C2")
                .map(|cell| cell.get_formula())
                .unwrap_or_default()
                != "G37"
            || sheet
                .get_cell("D2")
                .map(|cell| cell.get_formula())
                .unwrap_or_default()
                != "F62"
        {
            return Err(WpError(format!(
                "{} 顶部摘要或Section表头异常。",
                sheet.get_name()
            )));
        }
        if (41..=53).any(|row| sheet.value((4, row)).is_empty()) {
            return Err(WpError(format!(
                "{} 基本时间表操作说明缺失。",
                sheet.get_name()
            )));
        }
        let ser_headers = [
            "",
            "Hours占比",
            "分配Hours",
            "bill rate",
            "上浮5%",
            "SER金额",
        ];
        if ser_headers
            .iter()
            .enumerate()
            .any(|(index, expected)| sheet.value((index as u32 + 1, 57)) != *expected)
            || SER_ROLES
                .iter()
                .enumerate()
                .any(|(index, expected)| sheet.value((1, index as u32 + 58)) != *expected)
        {
            return Err(WpError(format!(
                "{} SER表头或级别标签缺失。",
                sheet.get_name()
            )));
        }
        for row in 5..=36 {
            let e = format!(
                "IF(OR(C{row}=\"\",H{row}=\"\"),\"\",ROUND(C{row}*IFERROR(VALUE(H{row}),0),2))"
            );
            let g = format!(
                "IF(AND(F{row}=\"\",OR(C{row}=\"\",H{row}=\"\")),\"\",ROUND(IF(OR(C{row}=\"\",H{row}=\"\"),0,C{row}*IFERROR(VALUE(H{row}),0))+IFERROR(VALUE(F{row}),0),2))"
            );
            if sheet
                .get_cell((5, row))
                .map(|cell| cell.get_formula())
                .unwrap_or_default()
                != e
                || sheet
                    .get_cell((7, row))
                    .map(|cell| cell.get_formula())
                    .unwrap_or_default()
                    != g
            {
                return Err(WpError(format!(
                    "{} 第{row}行Outlook公式异常。",
                    sheet.get_name()
                )));
            }
        }
        for row in 58..=61 {
            if sheet
                .get_cell((3, row))
                .map(|cell| cell.get_formula())
                .unwrap_or_default()
                != format!("B{row}*$G$37")
                || sheet
                    .get_cell((5, row))
                    .map(|cell| cell.get_formula())
                    .unwrap_or_default()
                    != format!("D{row}*1.05")
                || sheet
                    .get_cell((6, row))
                    .map(|cell| cell.get_formula())
                    .unwrap_or_default()
                    != format!("C{row}*E{row}")
            {
                return Err(WpError(format!(
                    "{} 第{row}行SER公式异常。",
                    sheet.get_name()
                )));
            }
        }
    }
    let index = book
        .get_sheet_by_name("服务方案索引")
        .map_err(|error| WpError(error.to_string()))?;
    let index_rows = (8..=index.get_highest_row())
        .filter(|row| !index.value((3, *row)).is_empty())
        .count();
    if index_rows != expected_services {
        return Err(WpError(format!(
            "索引数量不一致：{index_rows}/{expected_services}"
        )));
    }
    let expected_headers = [
        "序号",
        "来源",
        "项目名称",
        "WP服务单编号",
        "相关订单",
        "WP FIC",
        "预算Outlook Hours",
        "源表Outlook Hours",
        "差异",
        "核对结果",
        "查看服务方案",
    ];
    if expected_headers
        .iter()
        .enumerate()
        .any(|(column, header)| index.value((column as u32 + 1, 7)) != *header)
    {
        return Err(WpError("服务方案索引表头异常。".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 对着一份真实（脱敏）样例跑完整生成，用于和旧版 Python 逐格比对。
    /// 需要 `WP_REAL_FOLDER` 指向放着两个输入文件的目录：
    /// `cargo test --lib wp::tests::real_sample_generate -- --ignored`
    #[test]
    #[ignore]
    fn real_sample_generate() {
        let Ok(folder) = std::env::var("WP_REAL_FOLDER") else {
            return;
        };
        let folder = PathBuf::from(folder);
        let template = ensure_template(&folder).unwrap();
        let params = WpGenerateParams {
            input_path: folder.join("FY27 WP服务单.xlsx"),
            section_list_path: Some(folder.join("FY27 section list.xlsx")),
            template_path: template.path().to_path_buf(),
            output_path: folder.join("FY27+WP服务单汇总.xlsx"),
            split_output_path: Some(folder.join("FY27+WP服务单_自动拆分.xlsx")),
            ipo_years: default_ipo_years(),
        };
        generate(&params).unwrap();
    }

    fn read_zip_entry(path: &Path, entry: &str) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(entry).unwrap(), &mut text).unwrap();
        text
    }

    #[test]
    fn normalizers_match_legacy_rules() {
        assert_eq!(normalize_order(" wp – 01 "), "WP-01");
        assert_eq!(normalize_section("U_EXP-Other（A）"), "u_exp(a)");
        let mut used = HashSet::new();
        assert_eq!(safe_sheet_name("项目/A", &mut used), "项目 A");
        assert_eq!(safe_sheet_name("项目/A", &mut used), "项目 A_2");
    }

    #[test]
    fn split_rules_cover_all_four_groups() {
        let headers = [
            "EngagementName",
            "OutlookHours",
            "BookingPeriodStart-预审",
            "BookingPeriodEnd-预审",
            "BookingPeriodStart-年审",
            "BookingPeriodEnd-年审",
            "WP服务单编号",
        ];
        let mut rows = vec![
            headers
                .iter()
                .map(|value| Value::Text((*value).into()))
                .collect::<Vec<_>>(),
        ];
        let row = |name: &str, start: &str, end: &str, number: &str| {
            vec![
                Value::Text(name.into()),
                Value::Number(1.0),
                Value::Text(start.into()),
                Value::Text(end.into()),
                Value::Text(start.into()),
                Value::Text(end.into()),
                Value::Text(number.into()),
            ]
        };
        rows.push(row("AUD 2026 A", "2026-05-01", "2027-01-01", "A"));
        rows.push(row("IPO A", "2026-05-01", "2027-01-01", "B"));
        rows.push(row("IPO archive A", "2026-02-01", "2026-04-01", "C"));
        rows.push(row("AUD 2025 A", "2025-01-01", "2025-02-01", "D"));
        let split = split_raw(rows, &[2026, 2027]).unwrap();
        assert_eq!(split.groups["AUD2026"].len(), 1);
        assert_eq!(split.groups["IPO"].len(), 1);
        assert_eq!(split.groups["IPO archive"].len(), 1);
        assert_eq!(split.groups["AUD2025"].len(), 1);
    }

    #[test]
    fn validate_contract_reports_required_files() {
        let folder = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-validate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let error = call("wp.validate", json!({ "folder": folder })).unwrap_err();
        assert_eq!(error.code, "WP_INPUT_INVALID");
        assert!(error.user_message.contains("找不到WP服务单"));
        let _ = std::fs::remove_dir(folder);
    }

    #[test]
    fn discovers_keyword_inputs_and_ignores_generated_files() {
        let folder = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-discovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        for name in [
            "8月导出的 WP 服务单 v2.XLSX",
            "Client SECTION LIST final.xlsx",
            "FY27+WP服务单.xlsx",
            "FY27+WP服务单汇总.xlsx",
            "~$临时 WP服务单.xlsx",
        ] {
            std::fs::write(folder.join(name), []).unwrap();
        }

        assert_eq!(
            find_service_order_file(&folder)
                .unwrap()
                .file_name()
                .unwrap(),
            "8月导出的 WP 服务单 v2.XLSX"
        );
        assert_eq!(
            find_section_list_file(&folder)
                .unwrap()
                .file_name()
                .unwrap(),
            "Client SECTION LIST final.xlsx"
        );
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn rejects_multiple_keyword_inputs() {
        let folder = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-multiple-inputs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        for name in ["WP服务单 A.xlsx", "WP服务单 B.xlsx"] {
            std::fs::write(folder.join(name), []).unwrap();
        }

        let error = find_service_order_file(&folder).unwrap_err().to_string();
        assert!(error.contains("找到多个可能的WP服务单"));
        assert!(error.contains("WP服务单 A.xlsx"));
        assert!(error.contains("WP服务单 B.xlsx"));
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn generate_contract_honors_pre_cancel() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("WP服务单");
        if !root.join("FY27 WP服务单.xlsx").exists() {
            return;
        }
        let cancel = Arc::new(AtomicBool::new(true));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let error = run_job(
            "wp.generate",
            json!({ "folder": root }),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap_err();
        assert_eq!(error.code, "JOB_CANCELLED");
    }

    #[test]
    fn synthetic_acceptance_generates_complete_workbook() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("WP服务单");
        if !root.join("FY27 WP服务单.xlsx").exists() {
            // The repository's generated acceptance artifacts are optional in
            // clean source archives; deterministic unit tests above still run.
            return;
        }
        let output = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-rust-{}.xlsx", std::process::id()));
        let split_output = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-rust-split-{}.xlsx", std::process::id()));
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        let params = WpGenerateParams {
            input_path: root.join("FY27 WP服务单.xlsx"),
            section_list_path: Some(root.join("FY27 section list.xlsx")),
            template_path: root.join("FY27+WP服务单.xlsx"),
            output_path: output.clone(),
            split_output_path: Some(split_output.clone()),
            ipo_years: vec![2026, 2027],
        };
        let result = generate(&params).unwrap();
        assert_eq!(
            (
                result.services,
                result.aud2026_rows,
                result.ipo_rows,
                result.ipo_archive_rows,
                result.aud2025_rows
            ),
            (2, 1, 1, 1, 1)
        );
        assert_eq!(
            (
                result.matched_section_orders,
                result.outlook_compared,
                result.outlook_equal
            ),
            (2, 2, 2)
        );
        assert!(result.outlook_differences.is_empty());
        validate_output(&output, 2).unwrap();
        assert!(split_output.exists());
        let _ = std::fs::remove_file(output);
        let _ = std::fs::remove_file(split_output);
    }

    #[test]
    fn wp_generate_entrypoint_preserves_navigation_and_layout_contract() {
        let samples = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("WP服务单");
        if !samples.join("FY27 WP服务单.xlsx").exists() {
            return;
        }
        let folder = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-entry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        for name in ["FY27 WP服务单.xlsx", "FY27 section list.xlsx"] {
            std::fs::copy(samples.join(name), folder.join(name)).unwrap();
        }
        let raw_template =
            umya_spreadsheet::reader::xlsx::read(samples.join("FY27+WP服务单.xlsx")).unwrap();
        let raw_template_name = locate_template(&raw_template).unwrap();
        // 用 Calamine 取模板原文：umya 对富文本共享字符串只暴露第一段 run，
        // 拿它当基准会把"标签被截断"当成正确结果。
        let raw_h4 = read_first_sheet(
            &samples.join("FY27+WP服务单.xlsx"),
            Some(raw_template_name.as_str()),
        )
        .unwrap()
        .get(3)
        .and_then(|row| row.get(7))
        .map(Value::text)
        .unwrap_or_default();
        let output = folder.join("中文 长路径 WP 汇总.xlsx");
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        let value = run_job(
            "wp.generate",
            json!({ "folder": folder, "outputPath": output }),
            &|_, _, _, _| {},
            cancel,
            &pause,
        )
        .unwrap();
        assert!(
            !folder.join("FY27+WP服务单.xlsx").exists(),
            "内置模板只能临时使用，不能作为第三个结果文件留在输出目录"
        );
        assert_eq!(value["services"], 2);
        assert_eq!(value["outlookCompared"], 2);
        let book = umya_spreadsheet::reader::xlsx::read(&output).unwrap();
        let index = book.get_sheet_by_name("服务方案索引").unwrap();
        assert!(
            index
                .get_merge_cells()
                .iter()
                .any(|range| range.get_range() == "A1:K1")
        );
        assert_eq!(index.get_column_dimension("C").unwrap().width(), 38.0);
        assert_eq!(index.get_row_dimension(&1).unwrap().height(), 46.0);
        assert_eq!(
            index.sheets_views().sheet_view_list()[0]
                .pane()
                .unwrap()
                .top_left_cell()
                .to_string(),
            "A8"
        );
        assert_eq!(index.page_setup().fit_to_width(), 1);
        assert!(
            index
                .header_footer()
                .odd_footer()
                .value()
                .contains("Page &P / &N")
        );
        // A well-formed print area resolves to its own sheet, so umya files it
        // under that worksheet.  Only an address Excel cannot parse falls back
        // to the workbook-level list — assert the address is usable, not just
        // present, and that it never regrows the stray `$` that made Excel
        // offer to repair the workbook.
        let print_areas = book
            .get_sheet_collection()
            .iter()
            .flat_map(|sheet| sheet.defined_names())
            .filter(|name| name.name() == "_xlnm.Print_Area")
            .collect::<Vec<_>>();
        assert!(!print_areas.is_empty());
        assert!(
            book.defined_names()
                .iter()
                .all(|name| name.name() != "_xlnm.Print_Area")
        );
        assert!(
            print_areas
                .iter()
                .all(|name| !name.address().contains("$$"))
        );
        let service = book
            .get_sheet_collection()
            .iter()
            .find(|sheet| {
                !BASE_SHEETS.contains(&sheet.get_name()) && sheet.get_name() != "服务方案索引"
            })
            .unwrap();
        assert_eq!(service.get_column_dimension("B").unwrap().width(), 36.0);
        assert_eq!(service.get_row_dimension(&55).unwrap().height(), 28.0);
        assert_eq!(
            service.sheets_views().sheet_view_list()[0]
                .pane()
                .unwrap()
                .top_left_cell()
                .to_string(),
            "A5"
        );
        assert_eq!(service.page_setup().paper_size(), 9);
        // 打印标题行同样必须挂在所属工作表上：没有 localSheetId 的话，90 张表
        // 会写出 90 个同名工作簿级定义名，Excel 会判为重复并丢弃。
        let print_titles = book
            .get_sheet_collection()
            .iter()
            .flat_map(|sheet| sheet.defined_names())
            .filter(|name| name.name() == "_xlnm.Print_Titles")
            .collect::<Vec<_>>();
        assert!(!print_titles.is_empty());
        assert!(
            book.defined_names()
                .iter()
                .all(|name| name.name() != "_xlnm.Print_Titles")
        );
        assert_eq!(
            service.get_cell((9, 1)).unwrap().get_formula(),
            hyperlink_formula("AUD2026", "A2", "返回源表")
        );
        assert!(!service.value("C52").is_empty(), "报告日应逐项目回填");
        assert_eq!(service.value("D41"), TIMELINE_NOTES[0]);
        assert_eq!(service.value("D53"), TIMELINE_NOTES[12]);
        assert!(service.value("A57").is_empty());
        assert_eq!(service.value("D57"), "bill rate");
        assert_eq!(service.value("E57"), "上浮5%");
        for (offset, role) in SER_ROLES.iter().enumerate() {
            assert_eq!(service.value((1, offset as u32 + 58)), *role);
        }
        // 服务方案是这个工具的交付物：模板在拆分簿里是隐藏表，克隆时必须复位，
        // 否则 Excel 里一张服务方案都看不到。
        for sheet in book.get_sheet_collection() {
            if !BASE_SHEETS.contains(&sheet.get_name()) && sheet.get_name() != "服务方案索引"
            {
                assert!(matches!(sheet.state(), SheetStateValues::Visible));
            }
            // 同理，克隆来的"标签页被选中"也要复位，否则整簿成组选中。
            assert!(!sheet.sheets_views().sheet_view_list()[0].tab_selected());
        }
        assert_eq!(
            service
                .get_style("B56")
                .number_format()
                .map(|format| format.get_format_code().to_owned()),
            Some("#,##0.00".to_owned())
        );
        // 模板里的中文标签有一部分是富文本共享字符串，umya 只读得到第一段
        // （`WP服务单编号` 会变成 `WP`，`阶段`/`预审下场时间` 直接变空）。
        // 基本时间表整块都不参与回填，正好用来守住"文本没丢"这条线。
        let template_rows = read_first_sheet(
            &samples.join("FY27+WP服务单.xlsx"),
            Some(raw_template_name.as_str()),
        )
        .unwrap();
        let mut checked = 0;
        for row in 39..=54_u32 {
            let Some(values) = template_rows.get(row as usize - 1) else {
                continue;
            };
            for column in [1_u32, 2, 4] {
                let Some(Value::Text(expected)) = values.get(column as usize - 1) else {
                    continue;
                };
                if expected.is_empty() {
                    continue;
                }
                assert_eq!(&service.value((column, row)), expected);
                checked += 1;
            }
        }
        assert!(checked > 0, "模板样例里没有可核对的基本时间表文本");
        // 来源表不能带上模板里遗留的列（旧模板 U/V 是 Client Code / 相关项目）。
        let source = book.get_sheet_by_name("AUD2026").unwrap();
        let raw_headers =
            read_first_sheet(&folder.join("FY27 WP服务单.xlsx"), Some("业务")).unwrap();
        assert_eq!(
            source.get_highest_column() as usize,
            raw_headers[0].len(),
            "来源表列数应与导出文件表头一致"
        );
        let workbook_xml = read_zip_entry(&output, "xl/workbook.xml");
        assert!(workbook_xml.contains("fullCalcOnLoad=\"1\""));
        assert!(workbook_xml.contains("forceFullCalc=\"1\""));
        assert!(
            read_zip_entry(&output, "xl/worksheets/sheet1.xml")
                .contains("<pageSetUpPr fitToPage=\"1\"/>")
        );
        let split =
            umya_spreadsheet::reader::xlsx::read(folder.join("FY27+WP服务单_自动拆分.xlsx"))
                .unwrap();
        let hidden = split.get_sheet_by_name("_WP_TEMPLATE").unwrap();
        assert!(matches!(hidden.state(), SheetStateValues::Hidden));
        assert_eq!(hidden.value("H4"), raw_h4);
        assert_eq!(hidden.value("D41"), TIMELINE_NOTES[0]);
        assert_eq!(hidden.value("D53"), TIMELINE_NOTES[12]);
        let source = book.get_sheet_by_name("AUD2026").unwrap();
        assert_eq!(source.conditional_formatting_collection().len(), 2);
        assert_eq!(source.get_column_dimension("R").unwrap().width(), 28.0);
        assert_eq!(source.get_column_dimension("T").unwrap().width(), 23.0);
        assert!(
            source
                .get_cell((18, 2))
                .unwrap()
                .get_formula()
                .starts_with("HYPERLINK(")
        );
        assert_eq!(
            source
                .get_style((19, 2))
                .number_format()
                .map(|format| format.get_format_code().to_owned()),
            Some("#,##0.00".to_owned())
        );
        assert_eq!(
            source.sheets_views().sheet_view_list()[0]
                .pane()
                .unwrap()
                .top_left_cell()
                .to_string(),
            "A2"
        );
        let gold_path = samples.join("FY27+WP服务单汇总.xlsx");
        if gold_path.exists() {
            let gold = umya_spreadsheet::reader::xlsx::read(gold_path).unwrap();
            let actual_names = book
                .get_sheet_collection()
                .iter()
                .map(|sheet| sheet.get_name())
                .collect::<Vec<_>>();
            let gold_names = gold
                .get_sheet_collection()
                .iter()
                .map(|sheet| sheet.get_name())
                .collect::<Vec<_>>();
            assert_eq!(actual_names, gold_names);
            for name in actual_names {
                let actual = book.get_sheet_by_name(name).unwrap();
                let expected = gold.get_sheet_by_name(name).unwrap();
                let max_row = actual.get_highest_row().max(expected.get_highest_row());
                let max_col = actual
                    .get_highest_column()
                    .max(expected.get_highest_column());
                for row in 1..=max_row {
                    for col in 1..=max_col {
                        if name == "服务方案索引" && row == 4 && col == 8 {
                            continue; // 生成日期随运行日变化。
                        }
                        assert_eq!(
                            actual
                                .get_cell((col, row))
                                .map(|cell| cell.get_formula())
                                .unwrap_or_default(),
                            expected
                                .get_cell((col, row))
                                .map(|cell| cell.get_formula())
                                .unwrap_or_default(),
                            "公式不一致：{name}!{}{}",
                            column_name(col),
                            row
                        );
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(folder);
    }

    /// Header row in the order the source system emitted it before #12.
    const LEGACY_SOURCE_HEADERS: &[&str] = &[
        "Client Name",
        "Engagement Code",
        "Engagement Name",
        "Outlook Hours",
        "排班状态",
        "WP服务单编号",
        "底稿任务数量",
        "项目状态",
        "WP EIC",
        "WP FIC",
        "Booking Period Start-预审",
        "Booking Period End-预审",
        "Booking Period Start-年审",
        "Booking Period End-年审",
        "Service Type",
        "Audit EIC",
        "Audit Report Date",
        "相关订单",
    ];

    fn headers_from(names: &[&str]) -> Vec<Value> {
        names
            .iter()
            .map(|name| Value::Text((*name).into()))
            .collect()
    }

    #[test]
    fn duplicate_service_numbers_only_generate_one_service_sheet() {
        let mut split = SplitData {
            headers: headers_from(LEGACY_SOURCE_HEADERS),
            ..Default::default()
        };
        for name in BASE_SHEETS {
            split.groups.insert(name, Vec::new());
        }
        let mut row = vec![Value::Empty; 18];
        row[2] = Value::Text("同名项目".into());
        row[5] = Value::Text("WP-001".into());
        split.groups.get_mut("AUD2026").unwrap().push(row.clone());
        split.groups.get_mut("IPO").unwrap().push(row);
        let records = collect_records(&split);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].source_sheet, "AUD2026");
    }

    /// A reordered export must still land in the right `Record` fields.  The
    /// fixed-index reads this replaced pulled whichever column happened to sit
    /// at position 3/6/10/18, so hours and dates silently came from neighbours.
    #[test]
    fn reordered_source_columns_still_map_to_the_right_fields() {
        let reordered = [
            "WP服务单编号",
            "相关订单",
            "Booking Period Start-预审",
            "Booking Period End-预审",
            "Booking Period Start-年审",
            "Booking Period End-年审",
            "Audit Report Date",
            "WP FIC",
            "Outlook Hours",
            "Engagement Name",
        ];
        let mut split = SplitData {
            headers: headers_from(&reordered),
            ..Default::default()
        };
        for name in BASE_SHEETS {
            split.groups.insert(name, Vec::new());
        }
        split.groups.get_mut("AUD2026").unwrap().push(vec![
            Value::Text("WP-77".into()),
            Value::Text("ORD-9".into()),
            Value::Text("2026-01-02".into()),
            Value::Text("2026-01-31".into()),
            Value::Text("2026-03-01".into()),
            Value::Text("2026-03-31".into()),
            Value::Text("2026-04-15".into()),
            Value::Text("张三".into()),
            Value::Number(120.5),
            Value::Text("样例公司".into()),
        ]);
        let records = collect_records(&split);
        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.service_number, "WP-77");
        assert_eq!(record.related_order, "ORD-9");
        assert_eq!(record.engagement_name, "样例公司");
        assert_eq!(record.outlook_hours, 120.5);
        assert_eq!(record.wp_fic, "张三");
        assert_eq!(record.pre_start.text(), "2026-01-02");
        assert_eq!(record.pre_end.text(), "2026-01-31");
        assert_eq!(record.final_start.text(), "2026-03-01");
        assert_eq!(record.final_end.text(), "2026-03-31");
        assert_eq!(record.report_date.text(), "2026-04-15");
    }

    #[test]
    fn source_columns_tolerate_spacing_dash_and_case_variants() {
        let columns = source_columns(
            [
                "  outlook   hours ",
                "Booking Period Start–预审",
                "WP FIC*",
                "wp服务单编号",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        assert_eq!(columns.get("outlook_hours"), Some(&0));
        assert_eq!(columns.get("pre_start"), Some(&1));
        assert_eq!(columns.get("wp_fic"), Some(&2));
        assert_eq!(columns.get("service_number"), Some(&3));
    }

    /// Absent optional columns must degrade to empty values, never panic or
    /// shift the remaining fields.
    #[test]
    fn missing_optional_source_columns_yield_empty_values() {
        let mut split = SplitData {
            headers: headers_from(&["Engagement Name", "Outlook Hours", "WP服务单编号"]),
            ..Default::default()
        };
        for name in BASE_SHEETS {
            split.groups.insert(name, Vec::new());
        }
        split.groups.get_mut("AUD2026").unwrap().push(vec![
            Value::Text("样例公司".into()),
            Value::Number(80.0),
            Value::Text("WP-001".into()),
        ]);
        let records = collect_records(&split);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].engagement_name, "样例公司");
        assert_eq!(records[0].related_order, "");
        assert_eq!(records[0].wp_fic, "");
        assert!(records[0].pre_start.is_empty());
        assert!(records[0].report_date.is_empty());
    }

    #[test]
    fn failed_atomic_replace_cleans_temporary_file() {
        let root = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-occupied-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let temporary = root.join("result.xlsx.tmp");
        std::fs::write(&temporary, b"temporary").unwrap();
        let occupied_target = root.join("result.xlsx");
        std::fs::create_dir(&occupied_target).unwrap();
        let error = replace_with_temporary(&temporary, &occupied_target, "无法保存").unwrap_err();
        assert!(error.to_string().contains("可能正被占用"));
        assert!(!temporary.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dropping_pending_artifact_cleans_cancelled_job_file() {
        let path = std::env::temp_dir()
            .join("AuditToolbox")
            .join(format!("wp-cancel-{}.xlsx.tmp", std::process::id()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        {
            let pending = TemporaryArtifact::new(path.clone()).unwrap();
            std::fs::write(&pending.path, b"partial workbook").unwrap();
        }
        assert!(!path.exists());
    }
}
