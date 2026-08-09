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
        atomic::{AtomicBool, Ordering},
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
    let template = ensure_template(&folder)?;
    let generation = WpGenerateParams {
        input_path: folder.join("FY27 WP服务单.xlsx"),
        section_list_path: Some(folder.join("FY27 section list.xlsx")),
        template_path: template,
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
    let required = ["FY27 WP服务单.xlsx", "FY27 section list.xlsx"];
    let missing = required
        .iter()
        .filter(|name| !folder.join(name).is_file())
        .copied()
        .collect::<Vec<_>>();
    Ok(json!({
        "folder": folder.to_string_lossy(),
        "valid": missing.is_empty(),
        "missing": missing,
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

fn ensure_template(folder: &Path) -> std::result::Result<PathBuf, AppError> {
    let target = folder.join("FY27+WP服务单.xlsx");
    if target.is_file() {
        return Ok(target);
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
    let temporary = target.with_extension("xlsx.tmp");
    fs::write(&temporary, bytes).map_err(|error| {
        app_error(
            "WP_TEMPLATE_WRITE_FAILED",
            "无法释放 WP 服务方案模板。",
            Some(error.to_string()),
        )
    })?;
    fs::rename(&temporary, &target)
        .or_else(|_| {
            fs::copy(&temporary, &target)?;
            fs::remove_file(&temporary)
        })
        .map_err(|error| {
            app_error(
                "WP_TEMPLATE_WRITE_FAILED",
                "无法释放 WP 服务方案模板。",
                Some(error.to_string()),
            )
        })?;
    Ok(target)
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
    wp_fic: String,
    sheet_name: String,
}

fn collect_records(split: &SplitData) -> Vec<Record> {
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for source in ["AUD2026", "IPO"] {
        for (index, row) in split.groups[source].iter().enumerate() {
            let service = row.get(5).map(Value::text).unwrap_or_default();
            if service.is_empty() || !seen.insert(service.clone()) {
                continue;
            }
            records.push(Record {
                source_sheet: source,
                source_row: index as u32 + 2,
                engagement_name: row.get(2).map(Value::text).unwrap_or_default(),
                outlook_hours: row.get(3).map(Value::number).unwrap_or_default(),
                service_number: service,
                wp_fic: row.get(9).map(Value::text).unwrap_or_default(),
                pre_start: row.get(10).cloned().unwrap_or(Value::Empty),
                pre_end: row.get(11).cloned().unwrap_or(Value::Empty),
                final_start: row.get(12).cloned().unwrap_or(Value::Empty),
                final_end: row.get(13).cloned().unwrap_or(Value::Empty),
                related_order: row.get(17).map(Value::text).unwrap_or_default(),
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
            cell.set_value("");
        }
        Value::Text(value) => {
            cell.set_value(value);
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
    sheet.get_cell_mut(coordinate).set_value(value.into());
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
        .set_bottom(0.5);
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

fn style_source_sheet(sheet: &mut Worksheet) {
    set_column_widths(
        sheet,
        &[
            ("A", 34.0),
            ("B", 14.0),
            ("C", 38.0),
            ("D", 14.0),
            ("E", 13.0),
            ("F", 27.0),
            ("G", 14.0),
            ("H", 15.0),
            ("I", 19.0),
            ("J", 18.0),
            ("K", 17.0),
            ("L", 17.0),
            ("M", 17.0),
            ("N", 17.0),
            ("O", 34.0),
            ("P", 25.0),
            ("Q", 16.0),
            ("R", 28.0),
            ("S", 18.0),
            ("T", 23.0),
            ("U", 16.0),
            ("V", 23.0),
            ("W", 20.0),
        ],
    );
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
        for col in [2, 4, 7, 19, 21] {
            if col <= max_col {
                sheet
                    .get_style_mut((col, row))
                    .alignment_mut()
                    .set_horizontal(HorizontalAlignmentValues::Center);
            }
        }
        for col in [4, 7, 19] {
            if col <= max_col {
                sheet
                    .get_style_mut((col, row))
                    .number_format_mut()
                    .set_format_code("#,##0.00");
            }
        }
        for col in [6, 18] {
            if col <= max_col && !sheet.value((col, row)).is_empty() {
                let style = sheet.get_style_mut((col, row));
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
    if max_row >= 2 && max_col >= 8 {
        add_formula_conditional(
            sheet,
            format!("E2:E{max_row}"),
            "E2=\"已完成\"".into(),
            cell_style(Some(PALE_GREEN), GREEN, true, 9.0, false),
            1,
        );
        add_formula_conditional(
            sheet,
            format!("H2:H{max_row}"),
            "H2=\"项目承接\"".into(),
            cell_style(Some(LIGHT_GOLD), NAVY, true, 9.0, false),
            2,
        );
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
    for col in 5..=8 {
        sheet.get_style_mut((col, 2)).remove_borders();
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
        set_visual_style(
            sheet,
            (col, 39),
            cell_style(Some(GOLD), NAVY, true, 11.0, false),
        );
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
                cell_style(Some(fill), TEXT, false, 9.0, false),
            );
        }
    }
    for col in 1..=8 {
        set_visual_style(
            sheet,
            (col, 55),
            cell_style(Some(TEAL), WHITE, true, 11.0, false),
        );
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

fn prepare_template(template: &mut Worksheet, metadata: &TemplateMetadata) {
    if template_reference_column(template) == 9 {
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
        }
    }
    if template.get_highest_row() >= 55 {
        template.remove_row(55, template.get_highest_row() - 54);
    }
    for (row, section) in &metadata.section_by_row {
        set_text(template, &format!("B{row}"), section);
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
    let headers = ["", "Hours占比", "分配Hours", "", "", "SER金额"];
    for (index, header) in headers.iter().enumerate() {
        set_text(
            sheet,
            &format!("{}57", (b'A' + index as u8) as char),
            *header,
        );
    }
    for (offset, (mix, rate)) in ser.iter().enumerate() {
        let row = 58 + offset;
        set_text(sheet, &format!("A{row}"), "");
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

fn clone_base_sheets(template_book: &Workbook) -> HashMap<&'static str, Worksheet> {
    let mut result = HashMap::new();
    for name in BASE_SHEETS {
        let aliases: &[&str] = match name {
            "AUD2026" => &["AUD2026", "FY26"],
            "AUD2025" => &["AUD2025", "FY25"],
            _ => &[name],
        };
        if let Some(sheet) = aliases
            .iter()
            .find_map(|alias| template_book.get_sheet_by_name(alias).ok())
        {
            let mut clone = sheet.clone();
            clone.set_name(name);
            result.insert(name, clone);
        }
    }
    result
}

fn write_split_workbook(
    template_path: &Path,
    output_path: &Path,
    template: &Worksheet,
    bases: &HashMap<&'static str, Worksheet>,
    split: &SplitData,
) -> Result<()> {
    let mut book = umya_spreadsheet::reader::xlsx::read(template_path)
        .map_err(|error| WpError(format!("无法读取服务方案模板：{error}")))?;
    while book.get_sheet_count() > 0 {
        book.remove_sheet(0)
            .map_err(|error| WpError(error.to_string()))?;
    }
    for name in BASE_SHEETS {
        let source = clear_and_fill_source(
            bases.get(name).cloned().unwrap_or_default(),
            name,
            &split.headers,
            &split.groups[name],
        );
        book.add_sheet(source)
            .map_err(|error| WpError(error.to_string()))?;
    }
    let mut hidden_template = template.clone();
    hidden_template.set_name("_WP_TEMPLATE");
    hidden_template.set_state(SheetStateValues::Hidden);
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
) -> Worksheet {
    sheet.set_name(name);
    let highest = sheet.get_highest_row();
    if highest > 1 {
        sheet.remove_row(2, highest - 1);
    }
    for (col, value) in headers.iter().enumerate() {
        set_cell_value(&mut sheet, col as u32 + 1, 1, value);
    }
    let row2_styles: Vec<_> = (1..=headers.len() as u32)
        .map(|col| sheet.get_style((col, 2)).clone())
        .collect();
    for (row_index, row) in rows.iter().enumerate() {
        let target_row = row_index as u32 + 2;
        for (col_index, value) in row.iter().enumerate() {
            set_cell_value(&mut sheet, col_index as u32 + 1, target_row, value);
            if let Some(style) = row2_styles.get(col_index) {
                sheet.set_style((col_index as u32 + 1, target_row), style.clone());
            }
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
    sheet.set_auto_filter(format!(
        "A1:{}{}",
        column_name(headers.len() as u32),
        rows.len() + 1
    ));
    style_source_sheet(&mut sheet);
    sheet
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
            for row in 2..=sheet.get_highest_row() {
                let service = sheet.value((6, row));
                if let Some(record) = by_service.get(service.as_str()) {
                    set_formula(
                        sheet,
                        &format!("F{row}"),
                        hyperlink_formula(&record.sheet_name, "A1", &service),
                    );
                    let related = sheet.value((18, row));
                    if !related.is_empty() {
                        set_formula(
                            sheet,
                            &format!("R{row}"),
                            hyperlink_formula(&record.sheet_name, "A1", &related),
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
    let section_path = params.section_list_path.clone().or_else(|| {
        let candidate = params.input_path.parent()?.join("FY27 section list.xlsx");
        candidate.exists().then_some(candidate)
    });
    let section = load_section_details(section_path.as_deref(), &records)?;
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
    let base_clones = clone_base_sheets(&book);
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
            &base_clones,
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
        let base = base_clones.get(name).cloned().unwrap_or_default();
        let source = clear_and_fill_source(base, name, &split.headers, &split.groups[name]);
        book.add_sheet(source)
            .map_err(|error| WpError(error.to_string()))?;
    }
    for sheet in service_sheets {
        book.add_sheet(sheet)
            .map_err(|error| WpError(error.to_string()))?;
    }
    rewrite_source_links(&mut book, &records);

    if let Some(parent) = params.output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = TemporaryArtifact::new(params.output_path.with_extension("xlsx.tmp"))?;
    umya_spreadsheet::writer::xlsx::write(&book, &temporary.path)
        .map_err(|error| WpError(format!("无法写入结果工作簿：{error}")))?;
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
        std::fs::create_dir_all(&folder).unwrap();
        let result = call("wp.validate", json!({ "folder": folder })).unwrap();
        assert_eq!(result["valid"], false);
        assert_eq!(
            result["missing"],
            json!(["FY27 WP服务单.xlsx", "FY27 section list.xlsx"])
        );
        assert_eq!(result["engine"], "rust");
        let _ = std::fs::remove_dir(folder);
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
        for name in [
            "FY27 WP服务单.xlsx",
            "FY27 section list.xlsx",
            "FY27+WP服务单.xlsx",
        ] {
            std::fs::copy(samples.join(name), folder.join(name)).unwrap();
        }
        let raw_template =
            umya_spreadsheet::reader::xlsx::read(samples.join("FY27+WP服务单.xlsx")).unwrap();
        let raw_template_name = locate_template(&raw_template).unwrap();
        let raw_h4 = raw_template
            .get_sheet_by_name(&raw_template_name)
            .unwrap()
            .value("H4");
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
        assert!(
            book.defined_names()
                .iter()
                .any(|name| name.name() == "_xlnm.Print_Titles")
        );
        assert_eq!(
            service.get_cell((9, 1)).unwrap().get_formula(),
            hyperlink_formula("AUD2026", "A2", "返回源表")
        );
        let split =
            umya_spreadsheet::reader::xlsx::read(folder.join("FY27+WP服务单_自动拆分.xlsx"))
                .unwrap();
        let hidden = split.get_sheet_by_name("_WP_TEMPLATE").unwrap();
        assert!(matches!(hidden.state(), SheetStateValues::Hidden));
        assert_eq!(hidden.value("H4"), raw_h4);
        let source = book.get_sheet_by_name("AUD2026").unwrap();
        assert_eq!(source.conditional_formatting_collection().len(), 2);
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

    #[test]
    fn duplicate_service_numbers_only_generate_one_service_sheet() {
        let mut split = SplitData::default();
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
