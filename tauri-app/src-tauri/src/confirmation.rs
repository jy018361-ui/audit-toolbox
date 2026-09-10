use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Local, NaiveDate, NaiveDateTime, NaiveTime};
use rust_xlsxwriter::{
    ConditionalFormatDataBar, ConditionalFormatType, Format, FormatAlign, FormatBorder, Workbook,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::AppError;
use crate::excel_merger::PauseCheckpoint;

const BANK_TYPES: [&str; 2] = ["银行", "银行-电子函证"];
const BANK_REQUIRED: [&str; 8] = [
    "函证类型",
    "函证编号",
    "发函单位名称",
    "函证状态",
    "函证基准日",
    "发函模版",
    "发函签收时间",
    "询证项回函结果",
];
const TRADE_REQUIRED: [&str; 6] = [
    "函证类型",
    "函证编号",
    "发函单位名称",
    "函证状态",
    "发函签收时间",
    "询证项回函结果",
];

#[derive(Clone, Debug)]
struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

#[derive(Clone, Default)]
struct SummaryRow {
    group: String,
    values: Vec<f64>,
}

pub(crate) fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "confirmation.inspect" => inspect(params),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust 函证方法。",
            Some(method.into()),
        )),
    }
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    match method {
        "confirmation.process" => {
            let result = process(params, progress, cancel);
            pause.wait()?;
            result
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Rust 函证任务。",
            Some(method.into()),
        )),
    }
}

fn inspect(params: Value) -> Result<Value, AppError> {
    let input = required_path(&params, "inputPath")?;
    let mode = valid_mode(params.get("mode").and_then(Value::as_str).unwrap_or("both"))?;
    let table = load_table(&input)?;
    Ok(inspect_table(&input, mode, &table))
}

fn inspect_table(path: &Path, mode: &str, table: &Table) -> Value {
    let type_index = column(&table.headers, "函证类型");
    let bank = type_index
        .map(|index| {
            table
                .rows
                .iter()
                .filter(|row| BANK_TYPES.contains(&cell(row, index)))
                .count()
        })
        .unwrap_or(0);
    let trade = if type_index.is_some() {
        table.rows.len().saturating_sub(bank)
    } else {
        0
    };
    let mut required = BTreeSet::from(["函证类型"]);
    if matches!(mode, "bank" | "both") && bank > 0 {
        required.extend(BANK_REQUIRED);
    }
    if matches!(mode, "trade" | "both") && trade > 0 {
        required.extend(TRADE_REQUIRED);
    }
    let header_set = table
        .headers
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let missing = required
        .iter()
        .filter(|name| !header_set.contains(**name))
        .copied()
        .collect::<Vec<_>>();
    let present = required
        .iter()
        .filter(|name| header_set.contains(**name))
        .copied()
        .collect::<Vec<_>>();
    let base_dates = unique_dates(table, "函证基准日");
    let projects = unique_non_empty(table, "项目名称");
    let units = unique_non_empty(table, "发函单位名称");
    let output_dir = path.parent().unwrap_or(Path::new(".")).join("函证统计结果");
    json!({
        "path":path.to_string_lossy(), "kind":"excel", "mode":mode,
        "headers":table.headers, "preview":table.rows.iter().take(12).collect::<Vec<_>>(),
        "dimensions":{"rows":table.rows.len(),"columns":table.headers.len()},
        "requiredColumns":required, "requiredColumnsPresent":present, "missingColumns":missing,
        "statistics":{"total":table.rows.len(),"bank":bank,"trade":trade,"projects":projects,"units":units,"baseDates":base_dates},
        "outputDirectory":output_dir.to_string_lossy(),
        "willGenerate":{"bank":matches!(mode,"bank"|"both")&&bank>0,"trade":matches!(mode,"trade"|"both")&&trade>0},
        "engine":"rust"
    })
}

fn process(
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
) -> Result<Value, AppError> {
    let input = required_path(&params, "inputPath")?;
    let mode = valid_mode(params.get("mode").and_then(Value::as_str).unwrap_or("both"))?;
    let table = load_table(&input)?;
    let check = inspect_table(&input, mode, &table);
    let missing = check["missingColumns"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !missing.is_empty() {
        return Err(error(
            "CONFIRMATION_COLUMNS_MISSING",
            &format!(
                "函证清单缺少列：{}",
                missing
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、")
            ),
            None,
        ));
    }
    let modes = if mode == "both" {
        vec!["bank", "trade"]
    } else {
        vec![mode]
    };
    let mut outputs = Vec::new();
    let mut reports = Vec::new();
    for (index, item) in modes.iter().enumerate() {
        check_cancel(&cancel)?;
        let label = if *item == "bank" {
            "银行函证"
        } else {
            "往来函证"
        };
        let expected = check["statistics"][*item].as_u64().unwrap_or(0) as usize;
        progress(
            "process",
            index,
            modes.len(),
            &format!("正在生成{label}报告"),
        );
        if expected == 0 {
            reports.push(
                json!({"type":item,"label":label,"status":"skipped","reason":"没有符合类型的数据"}),
            );
            continue;
        }
        let (output, summary_rows) = write_report(&input, &table, item, &cancel)?;
        outputs.push(output.to_string_lossy().into_owned());
        reports.push(json!({"type":item,"label":label,"status":"completed","summaryRows":summary_rows,"outputPath":output.to_string_lossy()}));
        progress(
            "process",
            index + 1,
            modes.len(),
            &format!("{label}报告已生成"),
        );
    }
    if outputs.is_empty() {
        return Err(error(
            "CONFIRMATION_EMPTY",
            "输入文件中没有符合所选类型的函证数据。",
            None,
        ));
    }
    Ok(
        json!({"mode":mode,"inputPath":input.to_string_lossy(),"statistics":check["statistics"],"reports":reports,"outputDirectory":check["outputDirectory"],"outputPaths":outputs,"engine":"rust"}),
    )
}

fn write_report(
    input: &Path,
    table: &Table,
    mode: &str,
    cancel: &AtomicBool,
) -> Result<(PathBuf, usize), AppError> {
    let is_bank = mode == "bank";
    let type_index = column(&table.headers, "函证类型").ok_or_else(|| {
        error(
            "CONFIRMATION_COLUMNS_MISSING",
            "函证清单缺少列：函证类型",
            None,
        )
    })?;
    let selected = table
        .rows
        .iter()
        .filter(|row| BANK_TYPES.contains(&cell(row, type_index)) == is_bank)
        .cloned()
        .collect::<Vec<_>>();
    let output_dir = input
        .parent()
        .unwrap_or(Path::new("."))
        .join("函证统计结果");
    fs::create_dir_all(&output_dir).map_err(io_error)?;
    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    let label = if is_bank {
        "银行函证"
    } else {
        "往来函证"
    };
    let output = output_dir.join(format!("{stem}_{label}_进度报告_{stamp}.xlsx"));
    let partial = output.with_extension("xlsx.partial");
    let mut workbook = Workbook::new();
    let today = Local::now().format("%Y年%m月%d日").to_string();
    if column(&table.headers, "项目名称").is_some() {
        let rows = aggregate(table, &selected, "项目名称", is_bank)?;
        write_summary_sheet(
            &mut workbook,
            "按项目名称汇总",
            &format!("{label}进度统计报告 - 按项目名称汇总 - {today}"),
            "项目名称",
            &rows,
            is_bank,
        )?;
    }
    let rows = aggregate(table, &selected, "发函单位名称", is_bank)?;
    let summary_rows = rows.len();
    write_summary_sheet(
        &mut workbook,
        "按发函单位汇总",
        &format!("{label}进度统计报告 - 按发函单位汇总 - {today}"),
        "发函单位名称",
        &rows,
        is_bank,
    )?;
    if is_bank {
        let date_index = column(&table.headers, "函证基准日").unwrap();
        for date in unique_dates_from_rows(&selected, date_index) {
            check_cancel_ref(cancel)?;
            let subset = selected
                .iter()
                .filter(|row| {
                    normalized_date(cell(row, date_index)).as_deref() == Some(date.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            for group in ["发函单位名称", "项目名称"] {
                if column(&table.headers, group).is_none() {
                    continue;
                }
                let rows = aggregate(table, &subset, group, true)?;
                let suffix = if group == "项目名称" {
                    "按项目名称"
                } else {
                    "按发函单位"
                };
                let name = truncate_chars(&format!("基准日_{date}_{suffix}"), 31);
                write_summary_sheet(
                    &mut workbook,
                    &name,
                    &format!("银行函证进度统计 - 基准日{date}（{suffix}） - {today}"),
                    group,
                    &rows,
                    true,
                )?;
            }
        }
    }
    workbook.save(&partial).map_err(xlsx_error)?;
    check_cancel_ref(cancel)?;
    if output.exists() {
        fs::remove_file(&output).map_err(io_error)?;
    }
    fs::rename(&partial, &output).map_err(io_error)?;
    Ok((output, summary_rows))
}

fn aggregate(
    table: &Table,
    rows: &[Vec<String>],
    group: &str,
    bank: bool,
) -> Result<Vec<SummaryRow>, AppError> {
    let indexes = table
        .headers
        .iter()
        .enumerate()
        .map(|(i, h)| (h.as_str(), i))
        .collect::<HashMap<_, _>>();
    let get = |name: &str| {
        indexes.get(name).copied().ok_or_else(|| {
            error(
                "CONFIRMATION_COLUMNS_MISSING",
                &format!("函证清单缺少列：{name}"),
                None,
            )
        })
    };
    let group_i = get(group)?;
    let id_i = get("函证编号")?;
    let type_i = get("函证类型")?;
    let status_i = get("函证状态")?;
    let sign_i = get("发函签收时间")?;
    let result_i = get("询证项回函结果")?;
    let template_i = indexes.get("发函模版").copied();
    let mut groups: BTreeMap<String, Vec<&Vec<String>>> = BTreeMap::new();
    for row in rows {
        let key = cell(row, group_i);
        if !key.is_empty() {
            groups.entry(key.to_owned()).or_default().push(row);
        }
    }
    let mut result = Vec::new();
    for (name, items) in groups {
        let count_non_empty = |idx: usize| {
            items
                .iter()
                .filter(|row| !cell(row, idx).is_empty())
                .count() as f64
        };
        let count_eq = |idx: usize, value: &str| {
            items.iter().filter(|row| cell(row, idx) == value).count() as f64
        };
        let count_has = |idx: usize, value: &str| {
            items
                .iter()
                .filter(|row| cell(row, idx).contains(value))
                .count() as f64
        };
        let sent = items
            .iter()
            .filter(|row| matches!(cell(row, status_i), "已发出" | "已收回"))
            .count() as f64;
        let returned = count_eq(status_i, "已收回");
        let matched = count_eq(result_i, "相符");
        let signed = items
            .iter()
            .filter(|row| valid_datetime(cell(row, sign_i)))
            .count() as f64;
        let mut values = if bank {
            let ti = template_i.unwrap();
            let format1 = count_has(ti, "格式一");
            let format2 = count_has(ti, "格式二");
            vec![
                count_non_empty(id_i),
                items.len() as f64,
                count_eq(type_i, "银行"),
                count_eq(type_i, "银行-电子函证"),
                format1,
                format2,
                count_non_empty(ti) - format1 - format2,
                count_eq(status_i, "未发出"),
                sent,
                signed,
                returned,
                matched,
                count_has(result_i, "不符"),
            ]
        } else {
            vec![
                count_non_empty(id_i),
                count_has(type_i, "往来"),
                count_has(type_i, "其他"),
                count_eq(status_i, "未发出"),
                sent,
                signed,
                returned,
                matched,
                count_has(result_i, "不符"),
            ]
        };
        let denominator = if bank { values[1] } else { values[0] };
        values.push(percent(sent, denominator));
        values.push(percent(returned, denominator));
        values.push(percent(matched, returned));
        result.push(SummaryRow {
            group: name,
            values,
        });
    }
    let width = if bank { 16 } else { 12 };
    let mut totals = vec![0.0; width];
    for row in &result {
        for (i, v) in row.values.iter().take(width - 3).enumerate() {
            totals[i] += v;
        }
    }
    let denom = if bank { totals[1] } else { totals[0] };
    let sent = totals[if bank { 8 } else { 4 }];
    let returned = totals[if bank { 10 } else { 6 }];
    let matched = totals[if bank { 11 } else { 7 }];
    totals[width - 3] = percent(sent, denom);
    totals[width - 2] = percent(returned, denom);
    totals[width - 1] = percent(matched, returned);
    result.push(SummaryRow {
        group: "合计".into(),
        values: totals,
    });
    Ok(result)
}

fn write_summary_sheet(
    workbook: &mut Workbook,
    name: &str,
    title: &str,
    group: &str,
    rows: &[SummaryRow],
    bank: bool,
) -> Result<(), AppError> {
    let sheet = workbook.add_worksheet();
    sheet.set_name(name).map_err(xlsx_error)?;
    let headers: Vec<&str> = if bank {
        vec![
            group,
            "函证总数",
            "银行函证",
            "纸质",
            "电子",
            "格式一",
            "格式二",
            "其他模版",
            "未发出",
            "已发出",
            "已签收（纸质）",
            "已回函",
            "回函相符",
            "回函不符",
            "发函率",
            "回函率",
            "相符率",
        ]
    } else {
        vec![
            group,
            "往来总数",
            "标准往来",
            "其他函证",
            "未发出",
            "已发出",
            "已签收（纸质）",
            "已回函",
            "回函相符",
            "回函不符",
            "发函率",
            "回函率",
            "相符率",
        ]
    };
    let border = Format::new()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_font_name("微软雅黑");
    let title_fmt = border
        .clone()
        .set_bold()
        .set_font_size(16)
        .set_font_color("#FFFFFF")
        .set_background_color("#2E5B8F");
    let group_fmt = border
        .clone()
        .set_bold()
        .set_font_color("#FFFFFF")
        .set_background_color("#4A86E8");
    let header_fmt = border
        .clone()
        .set_bold()
        .set_font_color("#FFFFFF")
        .set_background_color("#366092");
    let total_fmt = border.clone().set_bold().set_background_color("#FFE599");
    sheet
        .merge_range(0, 0, 0, (headers.len() - 1) as u16, title, &title_fmt)
        .map_err(xlsx_error)?;
    sheet
        .merge_range(1, 0, 2, 0, group, &header_fmt)
        .map_err(xlsx_error)?;
    let groups = if bank {
        vec![
            ("函证类别", 1, 2),
            ("函证类型", 3, 4),
            ("发函模版", 5, 7),
            ("函证进度", 8, 11),
            ("回函结果", 12, 13),
            ("进度百分比", 14, 16),
        ]
    } else {
        vec![
            ("函证类型", 1, 3),
            ("函证进度", 4, 7),
            ("回函结果", 8, 9),
            ("进度百分比", 10, 12),
        ]
    };
    for (label, start, end) in groups {
        sheet
            .merge_range(1, start, 1, end, label, &group_fmt)
            .map_err(xlsx_error)?;
    }
    for (col, header) in headers.iter().enumerate().skip(1) {
        sheet
            .write_with_format(2, col as u16, *header, &header_fmt)
            .map_err(xlsx_error)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        let excel_row = (row_index + 3) as u32;
        let fmt = if row.group == "合计" {
            &total_fmt
        } else {
            &border
        };
        sheet
            .write_with_format(excel_row, 0, &row.group, fmt)
            .map_err(xlsx_error)?;
        for (col, value) in row.values.iter().enumerate() {
            sheet
                .write_number_with_format(excel_row, (col + 1) as u16, *value, fmt)
                .map_err(xlsx_error)?;
        }
    }
    sheet
        .set_column_width(0, optimal_width(rows))
        .map_err(xlsx_error)?;
    for col in 1..headers.len() {
        sheet
            .set_column_width(col as u16, if col == 10 { 15 } else { 12 })
            .map_err(xlsx_error)?;
    }
    let first_percent = if bank { 14 } else { 10 };
    let last_row = (rows.len() + 2) as u32;
    for (col, color) in [
        (first_percent, "#63C384"),
        (first_percent + 1, "#4A90E2"),
        (first_percent + 2, "#FF6B6B"),
    ] {
        // Pin the bars to 0-100 like the legacy report.  With the default
        // automatic scale the highest percentage in the sheet always renders as
        // a full bar, so a report where nothing exceeds 60% looks complete.
        let cf = ConditionalFormatDataBar::new()
            .set_fill_color(color)
            .set_minimum(ConditionalFormatType::Number, 0)
            .set_maximum(ConditionalFormatType::Number, 100);
        sheet
            .add_conditional_format(3, col as u16, last_row, col as u16, &cf)
            .map_err(xlsx_error)?;
    }
    Ok(())
}

fn load_table(path: &Path) -> Result<Table, AppError> {
    if !path.is_file() {
        return Err(error(
            "INPUT_NOT_FOUND",
            "找不到函证清单。",
            Some(path.to_string_lossy().into_owned()),
        ));
    }
    let range = if crate::spreadsheet_input::is_text(path) {
        crate::spreadsheet_input::text_range(path)?
    } else {
        let mut workbook = open_workbook_auto(path).map_err(|e| {
            error(
                "CONFIRMATION_READ_FAILED",
                "无法读取函证清单，请确认文件格式正确且未被占用。",
                Some(e.to_string()),
            )
        })?;
        let sheet = workbook
            .sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| error("CONFIRMATION_READ_FAILED", "函证清单没有工作表。", None))?;
        workbook.worksheet_range(&sheet).map_err(|e| {
            error(
                "CONFIRMATION_READ_FAILED",
                "无法读取函证清单，请确认文件格式正确且未被占用。",
                Some(e.to_string()),
            )
        })?
    };
    let mut iter = range.rows();
    let headers = iter
        .next()
        .unwrap_or(&[])
        .iter()
        .map(|v| data_text(v).trim().to_owned())
        .collect::<Vec<_>>();
    let rows = iter
        .map(|row| {
            (0..headers.len())
                .map(|i| row.get(i).map(data_text).unwrap_or_default())
                .collect()
        })
        .collect();
    Ok(Table { headers, rows })
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
        Data::DateTime(v) => v
            .as_datetime()
            .map(|d| {
                if d.time() == NaiveTime::MIN {
                    d.format("%Y-%m-%d").to_string()
                } else {
                    d.format("%Y-%m-%d %H:%M:%S").to_string()
                }
            })
            .unwrap_or_else(|| v.as_f64().to_string()),
        other => other.to_string(),
    }
}
fn required_path(params: &Value, key: &str) -> Result<PathBuf, AppError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| error("INPUT_REQUIRED", "请选择函证清单。", None))
}
fn valid_mode(mode: &str) -> Result<&str, AppError> {
    if matches!(mode, "bank" | "trade" | "both") {
        Ok(mode)
    } else {
        Err(error(
            "CONFIRMATION_MODE_INVALID",
            "统计类型必须为银行函证、往来函证或两类都生成。",
            None,
        ))
    }
}
fn column(headers: &[String], name: &str) -> Option<usize> {
    headers.iter().position(|value| value == name)
}
fn cell(row: &[String], index: usize) -> &str {
    row.get(index).map(String::as_str).unwrap_or("")
}
fn unique_non_empty(table: &Table, name: &str) -> usize {
    column(&table.headers, name)
        .map(|i| {
            table
                .rows
                .iter()
                .map(|r| cell(r, i).trim())
                .filter(|v| !v.is_empty())
                .collect::<HashSet<_>>()
                .len()
        })
        .unwrap_or(0)
}
fn unique_dates(table: &Table, name: &str) -> Vec<String> {
    column(&table.headers, name)
        .map(|i| unique_dates_from_rows(&table.rows, i))
        .unwrap_or_default()
}
fn unique_dates_from_rows(rows: &[Vec<String>], index: usize) -> Vec<String> {
    rows.iter()
        .filter_map(|r| normalized_date(cell(r, index)))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
fn normalized_date(value: &str) -> Option<String> {
    let value = value.trim();
    for fmt in [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
    ] {
        if let Ok(v) = NaiveDate::parse_from_str(value, fmt) {
            return Some(v.format("%Y-%m-%d").to_string());
        }
        if let Ok(v) = NaiveDateTime::parse_from_str(value, fmt) {
            return Some(v.date().format("%Y-%m-%d").to_string());
        }
    }
    None
}
/// A signed-for confirmation only needs a readable date.  Excel stores a
/// date-only cell as midnight, which renders without a time part, so demanding
/// `年-月-日 时:分:秒` dropped every row where the assistant filled in just the
/// date and undercounted 已签收（纸质）.
fn valid_datetime(value: &str) -> bool {
    let trimmed = value.trim();
    const DATETIME_FORMATS: [&str; 4] = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
    ];
    const DATE_FORMATS: [&str; 2] = ["%Y-%m-%d", "%Y/%m/%d"];
    DATETIME_FORMATS
        .iter()
        .any(|format| NaiveDateTime::parse_from_str(trimmed, format).is_ok())
        || DATE_FORMATS
            .iter()
            .any(|format| NaiveDate::parse_from_str(trimmed, format).is_ok())
}
fn percent(n: f64, d: f64) -> f64 {
    if d > 0.0 {
        (n / d * 10000.0).round() / 100.0
    } else {
        0.0
    }
}
fn optimal_width(rows: &[SummaryRow]) -> f64 {
    let max = rows
        .iter()
        .map(|r| {
            r.group
                .chars()
                .map(|c| if c.is_ascii() { 1 } else { 2 })
                .sum::<usize>()
        })
        .max()
        .unwrap_or(0);
    (max + 6).clamp(30, 100) as f64
}
fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}
fn check_cancel(cancel: &Arc<AtomicBool>) -> Result<(), AppError> {
    check_cancel_ref(cancel.as_ref())
}
fn check_cancel_ref(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}
fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}
fn io_error(e: impl std::fmt::Display) -> AppError {
    error(
        "CONFIRMATION_IO_FAILED",
        "函证报告文件处理失败。",
        Some(e.to_string()),
    )
}
fn xlsx_error(e: impl std::fmt::Display) -> AppError {
    error(
        "CONFIRMATION_REPORT_FAILED",
        "函证报告生成失败。",
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn percentages_match_legacy_rounding() {
        assert_eq!(percent(1.0, 3.0), 33.33);
        assert_eq!(percent(0.0, 0.0), 0.0);
    }
    #[test]
    fn invalid_mode_is_rejected() {
        assert_eq!(
            valid_mode("x").unwrap_err().code,
            "CONFIRMATION_MODE_INVALID"
        );
    }
    #[test]
    fn rust_confirmation_keeps_legacy_sheets_totals_and_data_bars() {
        let root = std::env::temp_dir().join(format!(
            "audit-confirmation-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("函证列表.xlsx");
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        let headers = [
            "项目名称",
            "发函单位名称",
            "函证编号",
            "函证类型",
            "发函模版",
            "函证状态",
            "发函签收时间",
            "询证项回函结果",
            "函证基准日",
        ];
        for (i, value) in headers.iter().enumerate() {
            sheet.write_string(0, i as u16, *value).unwrap();
        }
        let rows = [
            [
                "项目甲",
                "甲银行",
                "B-001",
                "银行",
                "银行格式一",
                "已收回",
                "2025-01-02 10:20:30",
                "相符",
                "2024-12-31",
            ],
            [
                "项目甲",
                "乙银行",
                "B-002",
                "银行-电子函证",
                "银行格式二",
                "未发出",
                "",
                "",
                "2024-12-31",
            ],
            [
                "项目乙",
                "客户A",
                "T-001",
                "往来询证函",
                "",
                "已收回",
                "2025-01-03 01:02:03",
                "不符-金额差异",
                "2024-12-31",
            ],
        ];
        for (r, row) in rows.iter().enumerate() {
            for (c, value) in row.iter().enumerate() {
                sheet
                    .write_string((r + 1) as u32, c as u16, *value)
                    .unwrap();
            }
        }
        book.save(&input).unwrap();
        let inspected = inspect(json!({"inputPath":input,"mode":"both"})).unwrap();
        assert_eq!(inspected["engine"], "rust");
        assert_eq!(inspected["statistics"]["bank"], 2);
        assert_eq!(inspected["statistics"]["trade"], 1);
        let result = process(
            json!({"inputPath":input,"mode":"both"}),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let outputs = result["outputPaths"].as_array().unwrap();
        assert_eq!(outputs.len(), 2);
        let bank_path = PathBuf::from(
            outputs
                .iter()
                .find_map(|v| v.as_str().filter(|p| p.contains("银行函证")))
                .unwrap(),
        );
        let mut bank = open_workbook_auto(&bank_path).unwrap();
        assert_eq!(
            &bank.sheet_names()[0..2],
            ["按项目名称汇总", "按发函单位汇总"]
        );
        let range = bank.worksheet_range("按发函单位汇总").unwrap();
        assert_eq!(
            range.get_value((5, 0)).map(ToString::to_string).as_deref(),
            Some("合计")
        );
        assert_eq!(
            range.get_value((5, 1)).map(ToString::to_string).as_deref(),
            Some("2")
        );
        let file = fs::File::open(&bank_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        archive
            .by_name("xl/worksheets/sheet2.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert_eq!(xml.matches("<conditionalFormatting").count(), 3);
        let _ = fs::remove_dir_all(root);
    }
}
