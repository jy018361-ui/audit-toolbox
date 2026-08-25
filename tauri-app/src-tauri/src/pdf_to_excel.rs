//! 回函 PDF 转 Excel。
//!
//! 桌面独立版《回函转Excel》已验证算法的 Rust 移植：
//! - 正文逐行放第一列，表格按阅读顺序内联在同一工作表，全程不合并单元格；
//! - 先 crop 到页面边界再做表格检测（部分银行回函有画到页外的矩形，会把
//!   表格边界撑到整页）。注意 Rust 版 crop 按对象**中心点**过滤，越界矩形被
//!   丢弃，表格回到真实边界；独立 Python 版的 crop 保留越界对象并把表格 bbox
//!   钳到近整页，导致正文被卷进表格再拆回（产生"整页巨行"、信头混入数据行）。
//!   工具箱版输出因此比独立版更干净，正文/数据行数与独立版不同属预期；
//! - 表头前"非空单元格<=1"的行是被表格大框卷进的正文，按行坐标拆回行流；
//! - 跨页续表按表头签名（过滤空列）+ 位置邻近合并，不重复表头。签名不比较
//!   列数——个别页多一条竖线会让列数虚增出空列，同一张表也会被判不同；
//! - 单元格内被硬折行的代码/数字段直连还原（如 ISIN "US912810\nRJ97"），
//!   普通多行文字用空格连接；
//! - 金额文本转数值并按 `#,##0.00;(#,##0.00)` 显示；前导零内容（账号）保持文本。

use chrono::Local;
use pdfplumber::{BBox, Pdf, Strategy, TableSettings, TextOptions};
use regex::Regex;
use rust_xlsxwriter::{Format, FormatAlign, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{AppError, excel_merger::PauseCheckpoint};

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

/// 安全数字：1,234.56 / -1,234.56 / 1234 / 1,234.56（不含前导零——账号、ISIN 不能被转成数字）。
static NUM_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$").unwrap());
/// 括号负数 (1,234.00) → -1234.00。
static NEG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\((\d{1,3}(,\d{3})*(\.\d+)?)\)$").unwrap());
/// 千分位两位小数的金额文本（转数值后按此格式显示，如 1,334.50 / (1,234.00)）。
static MONEY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[-(]?\d{1,3}(,\d{3})*\.\d{2}\)?$").unwrap());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConvertParams {
    #[serde(default)]
    pdf_paths: Vec<String>,
    #[serde(default)]
    output_dir: String,
}

/// 转换队列里的一份 PDF：路径 + 预扫得到的页数。
struct Queued {
    record_index: usize,
    path: PathBuf,
    name: String,
    pages: usize,
}

#[derive(Default)]
struct FileStats {
    pages: usize,
    text_rows: usize,
    tables: usize,
    table_data_rows: usize,
}

/// 清洗后的一张表。
struct CleanTable {
    /// 表头前被大框卷进来的正文（行 top 坐标 + 文本），按位置归还行流。
    preamble: Vec<(f64, String)>,
    header: Vec<String>,
    data: Vec<Vec<String>>,
    bbox: BBox,
}

/// 行流条目：正文一行，或一张表（`cont` 表示是上一页表格的续页）。
enum FlowItem {
    Text(String),
    Table { cont: bool, table: CleanTable },
}

/// 跨页续表候选：上一页最后一张表的表头签名与页底位置。
struct Pending {
    sig: Vec<String>,
    bottom: f64,
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    match method {
        "pdf2excel.convert" => convert_job(params, progress, cancel, pause),
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到回函转换任务方法。",
            Some(method.into()),
        )),
    }
}

fn convert_job(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let params: ConvertParams = serde_json::from_value(params).map_err(|e| {
        error(
            "INVALID_ARGUMENT",
            "回函转换参数不完整。",
            Some(e.to_string()),
        )
    })?;
    if params.pdf_paths.is_empty() {
        return Err(error(
            "INVALID_ARGUMENT",
            "请先选择要转换的 PDF 文件。",
            None,
        ));
    }

    // 校验 + 轻量预扫页数（只开文档读目录，不解析页面内容），用于全局进度分母。
    let mut records: Vec<Value> = Vec::new();
    let mut queued: Vec<Queued> = Vec::new();
    let mut total_pages = 0usize;
    for (index, raw) in params.pdf_paths.iter().enumerate() {
        let path = PathBuf::from(raw.trim());
        let name = path
            .file_name()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());
        let record = json!({"name": name, "status": "成功", "error": ""});
        records.push(record);
        if !path.is_file() {
            records[index]["status"] = json!("失败");
            records[index]["error"] = json!("文件不存在或无法访问。");
            continue;
        }
        match Pdf::open_file(&path, None) {
            Ok(pdf) => {
                let pages = pdf.page_count();
                if pages == 0 {
                    records[index]["status"] = json!("失败");
                    records[index]["error"] = json!("这个 PDF 没有页面。");
                    continue;
                }
                total_pages += pages;
                queued.push(Queued {
                    record_index: index,
                    path,
                    name,
                    pages,
                });
            }
            Err(err) => {
                records[index]["status"] = json!("失败");
                records[index]["error"] = json!(format!("无法打开 PDF：{err}"));
            }
        }
    }
    if queued.is_empty() {
        let first_error = records
            .iter()
            .find_map(|row| row["error"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let count = records.len();
        return Err(error(
            "PDF_OPEN_FAILED",
            &format!("{count} 份 PDF 全部无法转换，第一份原因是：{first_error}"),
            Some(records_to_detail(&records)),
        ));
    }
    check_cancel(&cancel)?;

    // 输出目录：留空则集中到第一份 PDF 旁的「回函Excel输出\<时间戳>\」。
    let out_dir = if params.output_dir.trim().is_empty() {
        let first = &queued[0].path;
        first
            .parent()
            .unwrap_or(Path::new("."))
            .join("回函Excel输出")
            .join(Local::now().format("%Y%m%d_%H%M%S").to_string())
    } else {
        PathBuf::from(params.output_dir.trim())
    };
    fs::create_dir_all(&out_dir).map_err(io_error)?;

    progress(
        "convert",
        0,
        total_pages.max(1),
        &format!("开始转换 {} 份 PDF…", queued.len()),
    );

    let mut used_names: HashSet<String> = HashSet::new();
    let mut output_paths: Vec<String> = Vec::new();
    let mut success_count = 0usize;
    let mut fail_count = 0usize;
    let mut done_pages = 0usize;
    for q in &queued {
        pause.wait()?;
        check_cancel(&cancel)?;
        // 同名 PDF 各生成一个 xlsx：重名追加序号。
        let stem = q
            .path
            .file_stem()
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| "输出".to_string());
        let mut file_name = format!("{stem}.xlsx");
        let mut serial = 2;
        while !used_names.insert(file_name.clone()) {
            file_name = format!("{stem}-{serial}.xlsx");
            serial += 1;
        }
        let output = out_dir.join(&file_name);

        let base = done_pages;
        let total = total_pages.max(1);
        let name = q.name.clone();
        let page_progress = |page_no: usize, pages: usize| {
            progress(
                "convert",
                base + page_no,
                total,
                &format!("正在转换 {name}（第 {page_no}/{pages} 页）"),
            );
        };
        let result = convert_one(&q.path, &output, &page_progress, &cancel);
        done_pages += q.pages;
        let record = &mut records[q.record_index];
        match result {
            Ok(stats) => {
                success_count += 1;
                record["pages"] = json!(stats.pages);
                record["textRows"] = json!(stats.text_rows);
                record["tables"] = json!(stats.tables);
                record["tableDataRows"] = json!(stats.table_data_rows);
                record["outputPath"] = json!(output.to_string_lossy());
                output_paths.push(output.to_string_lossy().into_owned());
            }
            Err(err) if err.code == "JOB_CANCELLED" => return Err(err),
            Err(err) => {
                fail_count += 1;
                record["status"] = json!("失败");
                record["error"] = json!(err.user_message);
            }
        }
    }
    check_cancel(&cancel)?;

    let manifest_path = out_dir.join("处理清单.xlsx");
    write_manifest(&records, &manifest_path)?;
    output_paths.push(manifest_path.to_string_lossy().into_owned());
    progress("completed", 1, 1, "转换完成。");

    Ok(json!({
        "outputDir": out_dir.to_string_lossy(),
        "manifestPath": manifest_path.to_string_lossy(),
        "files": records,
        "successCount": success_count,
        "failCount": fail_count,
        "outputPaths": output_paths,
    }))
}

fn records_to_detail(records: &[Value]) -> String {
    records
        .iter()
        .map(|row| {
            format!(
                "{}: {}",
                row["name"].as_str().unwrap_or(""),
                row["error"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// 转换单份 PDF → 同名 xlsx。页粒度进度经 `page_progress(page_no, pages)` 回调（已节流）。
fn convert_one(
    pdf_path: &Path,
    output: &Path,
    page_progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<FileStats, AppError> {
    let pdf = Pdf::open_file(pdf_path, None).map_err(|e| {
        error(
            "PDF_OPEN_FAILED",
            &format!("无法打开 PDF：{e}"),
            Some(e.to_string()),
        )
    })?;
    let pages = pdf.page_count();
    if pages == 0 {
        return Err(error("PDF_NO_PAGES", "这个 PDF 没有页面。", None));
    }
    // 空文字层 → 多半是扫描件，提前报错而不是产出空 Excel。
    let first = pdf.page(0).map_err(pdf_error)?;
    let first_text = first.extract_text(&TextOptions::default());
    if first_text.trim().is_empty() {
        return Err(error(
            "PDF_NO_TEXT_LAYER",
            "这个 PDF 提取不到文字，可能是扫描件/图片版，本工具只支持文字版 PDF。",
            None,
        ));
    }

    let mut flow: Vec<FlowItem> = Vec::new();
    let mut pending: Option<Pending> = None;
    for pi in 0..pages {
        check_cancel(cancel)?;
        if pi == 0 || pi % 20 == 19 || pi + 1 == pages {
            page_progress(pi + 1, pages);
        }
        let page = pdf.page(pi).map_err(|e| page_error(pi, e))?;
        let mut items = scan_page(&page, &mut pending);
        flow.append(&mut items);
    }

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let partial = partial_path(output);
    let write_result = write_flow(&flow, &partial);
    if let Err(err) = write_result {
        let _ = fs::remove_file(&partial);
        return Err(err);
    }
    check_cancel(cancel).inspect_err(|_| {
        let _ = fs::remove_file(&partial);
    })?;
    if output.exists() {
        fs::remove_file(output).map_err(|e| {
            error(
                "OUTPUT_REPLACE_FAILED",
                "无法替换已有输出文件，请确认文件未被 Excel 占用。",
                Some(e.to_string()),
            )
        })?;
    }
    fs::rename(&partial, output).map_err(io_error)?;

    let mut stats = FileStats {
        pages,
        ..Default::default()
    };
    for item in &flow {
        match item {
            FlowItem::Text(text) => {
                if !text.is_empty() {
                    stats.text_rows += 1;
                }
            }
            FlowItem::Table { cont, table } => {
                if !cont {
                    stats.tables += 1;
                }
                stats.table_data_rows += table.data.len();
            }
        }
    }
    Ok(stats)
}

/// 处理一页：表格检测 + 清洗 + 表格外正文逐行提取，按位置合成行流。
fn scan_page(page: &pdfplumber::Page, pending: &mut Option<Pending>) -> Vec<FlowItem> {
    let width = page.width();
    let height = page.height();
    // 1) 裁剪回页面范围：部分回函 PDF 有越界矩形会把表格边界撑到页外。
    let pg = page.crop(BBox {
        x0: 0.0,
        top: 0.0,
        x1: width,
        bottom: height,
    });
    let mut tables = pg.find_tables(&table_settings());
    tables.sort_by(|a, b| {
        a.bbox
            .top
            .partial_cmp(&b.bbox.top)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut cleaned: Vec<CleanTable> = tables
        .iter()
        .map(clean_table)
        .filter(|ct| !ct.header.is_empty() || !ct.data.is_empty())
        .collect();

    struct PageItem {
        top: f64,
        /// 正文行排在前：同 top 时正文先于表格（对齐独立版排序键 (top, kind != "text")）。
        is_text: bool,
        item: FlowItem,
    }
    let mut page_items: Vec<PageItem> = Vec::new();

    // 页末的续表候选 = 本页最后一张表的表头签名与页底位置（无表则清空）。
    let last_info = cleaned
        .last()
        .map(|ct| (header_sig(&ct.header), ct.bbox.bottom));

    // 2) 表格区域以外的正文逐行提取（表格区域必须排除，否则表头会在正文里重复）。
    let mut rest = pg;
    for ct in &cleaned {
        rest = rest.outside_bbox(ct.bbox);
    }
    for line in rest.extract_text_lines(&TextOptions::default()) {
        let text = line.text().trim().to_string();
        if !text.is_empty() {
            page_items.push(PageItem {
                top: line.bbox.top,
                is_text: true,
                item: FlowItem::Text(text),
            });
        }
    }

    // 3) 表格拆出的正文 + 表格本体并入行流；本页第一张表可能是上一页表格的续页。
    let mut first_table = true;
    for ct in cleaned.drain(..) {
        for (top, text) in &ct.preamble {
            page_items.push(PageItem {
                top: *top,
                is_text: true,
                item: FlowItem::Text(text.clone()),
            });
        }
        let mut is_cont = false;
        if first_table {
            if let Some(p) = pending.as_ref() {
                let same_sig = p.sig == header_sig(&ct.header);
                let near = p.bottom >= height - 120.0 && ct.bbox.top <= 240.0;
                if same_sig && near {
                    is_cont = true; // 跨页续表：只续数据行，不重复表头
                }
            }
        }
        page_items.push(PageItem {
            top: ct.bbox.top,
            is_text: false,
            item: FlowItem::Table {
                cont: is_cont,
                table: ct,
            },
        });
        first_table = false;
    }
    *pending = last_info.map(|(sig, bottom)| Pending { sig, bottom });

    page_items.sort_by(|a, b| {
        a.top
            .partial_cmp(&b.top)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then((!a.is_text as u8).cmp(&(!b.is_text as u8)))
    });
    page_items.into_iter().map(|item| item.item).collect()
}

fn table_settings() -> TableSettings {
    TableSettings {
        // Lattice = Python pdfplumber 的 "lines"（线 + 矩形边），银行回函表格均有边框线。
        vertical_strategy: Some(Strategy::Lattice),
        horizontal_strategy: Some(Strategy::Lattice),
        ..Default::default()
    }
}

/// 清洗一张表：preamble 拆正文、找表头行、数据行规范化。
fn clean_table(table: &pdfplumber::Table) -> CleanTable {
    let cells: Vec<Vec<Option<String>>> = table
        .rows
        .iter()
        .map(|row| row.iter().map(|cell| cell.text.clone()).collect())
        .collect();
    let tops: Vec<f64> = table
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| cell.bbox.top)
                .fold(f64::INFINITY, f64::min)
        })
        .collect();
    let ncols = cells.iter().map(Vec::len).max().unwrap_or(0);
    let (preamble, header, data) = clean_rows(&cells, &tops, ncols);
    CleanTable {
        preamble,
        header,
        data,
        bbox: table.bbox,
    }
}

/// `clean_table` 的纯逻辑（可单测）：
/// - 整行空白丢弃；
/// - 表头确定前"非空单元格<=1"的行视为被大框卷进的正文（preamble）；
/// - 首个"非空列数 >= max(2, 列数一半)"的行 = 表头；其余进数据行。
fn clean_rows(
    cells: &[Vec<Option<String>>],
    tops: &[f64],
    ncols: usize,
) -> (Vec<(f64, String)>, Vec<String>, Vec<Vec<String>>) {
    let mut preamble: Vec<(f64, String)> = Vec::new();
    let mut header: Option<Vec<String>> = None;
    let mut data: Vec<Vec<String>> = Vec::new();
    let threshold = std::cmp::max(2, if ncols > 0 { ncols / 2 } else { 1 });
    for (i, row) in cells.iter().enumerate() {
        let normalized: Vec<String> = row.iter().map(|cell| norm_cell(cell.as_deref())).collect();
        let non_empty = normalized.iter().filter(|c| !c.is_empty()).count();
        if non_empty == 0 {
            continue;
        }
        let top = tops.get(i).copied().unwrap_or(0.0);
        if header.is_none() {
            if non_empty <= 1 {
                let text = normalized
                    .iter()
                    .filter(|c| !c.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" ");
                preamble.push((top, text));
                continue;
            }
            if non_empty >= threshold {
                header = Some(normalized);
                continue;
            }
        }
        data.push(normalized);
    }
    (preamble, header.unwrap_or_default(), data)
}

/// 表头签名：过滤空列并去尾空白。不比较列数——个别页多一条竖线会虚增空列。
fn header_sig(header: &[String]) -> Vec<String> {
    header
        .iter()
        .filter(|c| !c.is_empty())
        .map(|c| c.trim_end().to_string())
        .collect()
}

/// 单元格规范化：None→空串；内部换行合并。
/// 代码/数字被折行（如 ISIN 的 "US912810\nRJ97"、数量的 "19,305,00\n0"）→ 直接连回；
/// 普通多行文字（如 "NOMINAL\nVALUE"）→ 用空格连接。
fn norm_cell(text: Option<&str>) -> String {
    let s = text.unwrap_or("").trim();
    if s.is_empty() {
        return String::new();
    }
    if !s.contains('\n') {
        return s.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let segments: Vec<&str> = s
        .split('\n')
        .map(str::trim)
        .filter(|seg| !seg.is_empty())
        .collect();
    if segments.len() >= 2
        && segments.iter().all(|seg| is_code_segment(seg))
        && segments.iter().any(|seg| seg.chars().any(|c| c.is_ascii_digit()))
    {
        segments.concat()
    } else {
        segments.join(" ")
    }
}

/// 折行代码段：全大写字母/数字/标点（`^[A-Z0-9,./()+\-]+$` 的零正则实现）。
fn is_code_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.chars().all(|c| {
            matches!(
                c,
                'A'..='Z' | '0'..='9' | ',' | '.' | '/' | '(' | ')' | '+' | '-'
            )
        })
}

/// 写入值：仅对无前导零风险的纯数字转数值，其余保持文本原样。
enum CellValue {
    Text(String),
    Number(f64),
}

fn to_value(text: &str) -> CellValue {
    let trimmed = text.trim();
    let candidate = match NEG_RE.captures(trimmed) {
        Some(caps) => format!("-{}", caps.get(1).map(|m| m.as_str()).unwrap_or("")),
        None => trimmed.to_string(),
    };
    if !NUM_RE.is_match(&candidate) {
        return CellValue::Text(text.to_string());
    }
    // 独立 Python 版在这里先 lstrip("-") 再 parse，括号负数 (1,234.00) 会被丢掉
    // 负号变成正数；金额符号出错对审计不可接受，这里保留符号。
    let negative = candidate.starts_with('-');
    let digits = candidate.trim_start_matches('-').replace(',', "");
    let integer = digits.split('.').next().unwrap_or("");
    if integer.len() > 1 && integer.starts_with('0') {
        return CellValue::Text(text.to_string()); // 前导零（如账号 0100684742）保持文本
    }
    match digits.parse::<f64>() {
        Ok(magnitude) => CellValue::Number(if negative { -magnitude } else { magnitude }),
        Err(_) => CellValue::Text(text.to_string()),
    }
}

/// 把整份行流写进单一工作表「回函内容」：正文一行一格，表格内联，全程无合并单元格。
fn write_flow(flow: &[FlowItem], output: &Path) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("回函内容").map_err(xlsx_error)?;
    // 第一列放正文给宽，其余数据列适中。
    sheet.set_column_width(0, 70).map_err(xlsx_error)?;
    sheet
        .set_column_range_width(1, 39, 16)
        .map_err(xlsx_error)?;

    let header_format = Format::new().set_bold().set_background_color("#DDEBF7");
    // 数据行统一顶部对齐（对齐独立版），金额数值另带两位小数显示。
    let data_format = Format::new().set_align(FormatAlign::Top);
    let money_format = Format::new()
        .set_align(FormatAlign::Top)
        .set_num_format("#,##0.00;(#,##0.00)");

    let mut row: u32 = 0;
    let mut last_was_content = false;
    for item in flow {
        match item {
            FlowItem::Text(text) => {
                if !text.is_empty() {
                    sheet.write_string(row, 0, text).map_err(xlsx_error)?;
                    row += 1;
                    last_was_content = true;
                }
            }
            FlowItem::Table { cont, table } => {
                // 仅新表前空一行分隔；续表直接接上（否则每页一个空行把长表切碎）。
                if !cont && last_was_content {
                    row += 1;
                }
                if !cont && !table.header.is_empty() {
                    for (column, value) in table.header.iter().enumerate() {
                        sheet
                            .write_string_with_format(
                                row,
                                column as u16,
                                value,
                                &header_format,
                            )
                            .map_err(xlsx_error)?;
                    }
                    row += 1;
                }
                for cells in &table.data {
                    for (column, original) in cells.iter().enumerate() {
                        match to_value(original) {
                            CellValue::Number(number) => {
                                if MONEY_RE.is_match(original.trim()) {
                                    sheet
                                        .write_number_with_format(
                                            row,
                                            column as u16,
                                            number,
                                            &money_format,
                                        )
                                        .map_err(xlsx_error)?;
                                } else {
                                    sheet
                                        .write_number_with_format(
                                            row,
                                            column as u16,
                                            number,
                                            &data_format,
                                        )
                                        .map_err(xlsx_error)?;
                                }
                            }
                            CellValue::Text(value) => {
                                sheet
                                    .write_string_with_format(
                                        row,
                                        column as u16,
                                        value,
                                        &data_format,
                                    )
                                    .map_err(xlsx_error)?;
                            }
                        }
                    }
                    row += 1;
                }
                last_was_content = true;
            }
        }
    }
    workbook.save(output).map_err(xlsx_error)
}

/// 批量结果清单「处理清单.xlsx」。
fn write_manifest(records: &[Value], output: &Path) -> Result<(), AppError> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();
    sheet.set_name("处理清单").map_err(xlsx_error)?;
    let header_format = Format::new().set_bold().set_background_color("#DDEBF7");
    for (column, width) in [38.0, 8.0, 8.0, 10.0, 8.0, 12.0, 50.0, 40.0].iter().enumerate() {
        sheet
            .set_column_width(column as u16, *width)
            .map_err(xlsx_error)?;
    }
    let heads = [
        "文件名",
        "状态",
        "页数",
        "正文行数",
        "表格数",
        "表格数据行",
        "输出文件",
        "失败原因",
    ];
    for (column, head) in heads.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, *head, &header_format)
            .map_err(xlsx_error)?;
    }
    for (index, record) in records.iter().enumerate() {
        let row = (index + 1) as u32;
        let pages = record["pages"].as_u64().unwrap_or(0);
        let text_rows = record["textRows"].as_u64().unwrap_or(0);
        let tables = record["tables"].as_u64().unwrap_or(0);
        let table_rows = record["tableDataRows"].as_u64().unwrap_or(0);
        sheet
            .write_string(row, 0, record["name"].as_str().unwrap_or(""))
            .map_err(xlsx_error)?;
        sheet
            .write_string(row, 1, record["status"].as_str().unwrap_or(""))
            .map_err(xlsx_error)?;
        sheet.write_number(row, 2, pages as f64).map_err(xlsx_error)?;
        sheet
            .write_number(row, 3, text_rows as f64)
            .map_err(xlsx_error)?;
        sheet.write_number(row, 4, tables as f64).map_err(xlsx_error)?;
        sheet
            .write_number(row, 5, table_rows as f64)
            .map_err(xlsx_error)?;
        sheet
            .write_string(row, 6, record["outputPath"].as_str().unwrap_or(""))
            .map_err(xlsx_error)?;
        sheet
            .write_string(row, 7, record["error"].as_str().unwrap_or(""))
            .map_err(xlsx_error)?;
    }
    workbook.save(output).map_err(xlsx_error)
}

fn partial_path(output: &Path) -> PathBuf {
    let mut name = output.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    output.with_file_name(name)
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("JOB_CANCELLED", "任务已取消。", None))
    } else {
        Ok(())
    }
}

fn io_error(err: std::io::Error) -> AppError {
    error(
        "FILE_IO_FAILED",
        "无法读写文件，请检查路径权限和文件占用状态。",
        Some(err.to_string()),
    )
}

fn xlsx_error(err: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "WORKBOOK_WRITE_FAILED",
        "无法生成 Excel 文件，请确认输出文件未被占用。",
        Some(err.to_string()),
    )
}

fn pdf_error(err: pdfplumber::PdfError) -> AppError {
    error(
        "PDF_OPEN_FAILED",
        &format!("无法读取 PDF：{err}"),
        Some(err.to_string()),
    )
}

fn page_error(page_index: usize, err: pdfplumber::PdfError) -> AppError {
    error(
        "PDF_PAGE_FAILED",
        &format!("第 {} 页解析失败：{err}", page_index + 1),
        Some(err.to_string()),
    )
}

fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, false, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader;

    #[test]
    fn 折行代码直连而普通多行用空格连接() {
        assert_eq!(norm_cell(Some("US912810\nRJ97")), "US912810RJ97");
        assert_eq!(norm_cell(Some("19,305,00\n0")), "19,305,000");
        assert_eq!(norm_cell(Some("NOMINAL\nVALUE")), "NOMINAL VALUE");
        assert_eq!(norm_cell(Some("Account\nName")), "Account Name");
        assert_eq!(norm_cell(None), "");
        assert_eq!(norm_cell(Some("  空白  规整  ")), "空白 规整");
        // 只有一段时不做直连判断
        assert_eq!(norm_cell(Some("US912810\n")), "US912810");
    }

    #[test]
    fn 金额转数值且前导零保持文本() {
        assert!(matches!(to_value("1,334.50"), CellValue::Number(v) if (v - 1334.5).abs() < 1e-9));
        assert!(matches!(to_value("(1,234.00)"), CellValue::Number(v) if (v + 1234.0).abs() < 1e-9));
        assert!(matches!(to_value("-982.25"), CellValue::Number(v) if (v + 982.25).abs() < 1e-9));
        assert!(matches!(to_value("0.00"), CellValue::Number(v) if v == 0.0));
        // 账号 0100684742 的前导零必须保持文本
        assert!(matches!(to_value("0100684742"), CellValue::Text(t) if t == "0100684742"));
        assert!(matches!(to_value("CURRENT ACCOUNT"), CellValue::Text(t) if t == "CURRENT ACCOUNT"));
        assert!(matches!(to_value("US912810RJ97"), CellValue::Text(t) if t == "US912810RJ97"));
    }

    #[test]
    fn 金额格式只匹配两位小数的千分位文本() {
        assert!(MONEY_RE.is_match("1,334.50"));
        assert!(MONEY_RE.is_match("(1,234.00)"));
        assert!(MONEY_RE.is_match("-1,234.00"));
        assert!(MONEY_RE.is_match("0.00"), "无千分位的两位小数同样匹配（与独立版一致）");
        assert!(!MONEY_RE.is_match("0100684742"));
        assert!(!MONEY_RE.is_match("1,334.5"), "一位小数不匹配");
        assert!(!MONEY_RE.is_match("1,33"));
    }

    #[test]
    fn 表格清洗拆出正文并识别表头() {
        let cells = vec![
            vec![Some("Item #1: Deposits,".into()), None, None],
            vec![None, None, Some("TEL: (65) 6229 1818".into())],
            vec![
                Some("Account No".into()),
                Some("Account Name".into()),
                Some("Currency".into()),
            ],
            vec![
                Some("0100684742".into()),
                Some("CURRENT ACCOUNT - AUD".into()),
                Some("AUD".into()),
            ],
            vec![None, None, None],
        ];
        let tops = vec![10.0, 24.0, 38.0, 52.0, 66.0];
        let (preamble, header, data) = clean_rows(&cells, &tops, 3);
        assert_eq!(preamble.len(), 2);
        assert_eq!(preamble[0], (10.0, "Item #1: Deposits,".to_string()));
        assert_eq!(preamble[1], (24.0, "TEL: (65) 6229 1818".to_string()));
        assert_eq!(header, vec!["Account No", "Account Name", "Currency"]);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0][0], "0100684742");
    }

    #[test]
    fn 表头签名忽略空列与尾空白() {
        let a = header_sig(&[
            "Account No".into(),
            "".into(),
            "Currency ".into(),
        ]);
        let b = header_sig(&["Account No".into(), "Currency".into()]);
        assert_eq!(a, b);
    }

    #[test]
    fn 未登记方法必须显式报错() {
        let err = run_job(
            "pdf2excel.unknown",
            json!({}),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_err();
        assert_eq!(err.code, "METHOD_NOT_FOUND");
    }

    #[test]
    fn 空文件列表直接拒绝() {
        let err = convert_job(
            json!({"pdfPaths": []}),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_err();
        assert_eq!(err.code, "INVALID_ARGUMENT");
    }

    #[test]
    fn 单份不存在文件导致全批失败并携带清单明细() {
        let err = convert_job(
            json!({"pdfPaths": ["Z:\\不存在\\样例回函.pdf"]}),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false))),
        )
        .unwrap_err();
        assert_eq!(err.code, "PDF_OPEN_FAILED");
        let detail = err.detail.unwrap_or_default();
        assert!(detail.contains("样例回函.pdf"), "明细应包含文件名：{detail}");
    }

    #[test]
    fn 行流写入单一工作表且无合并单元格() {
        let root = std::env::temp_dir().join(format!(
            "audit-toolbox-pdf2excel-flow-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let output = root.join("输出.xlsx");
        let table = CleanTable {
            preamble: vec![(5.0, "Item #1: Deposits,".to_string())],
            header: vec!["Account No".into(), "Currency".into()],
            data: vec![
                vec!["0100684742".to_string(), "AUD".to_string()],
                vec!["1,334.50".to_string(), "USD".to_string()],
            ],
            bbox: BBox {
                x0: 0.0,
                top: 0.0,
                x1: 100.0,
                bottom: 50.0,
            },
        };
        let flow = vec![
            FlowItem::Text("回函正文第一行".to_string()),
            FlowItem::Text("Item #1: Deposits,".to_string()),
            FlowItem::Table {
                cont: false,
                table,
            },
        ];
        write_flow(&flow, &output).unwrap();
        assert!(output.exists());
        assert!(!partial_path(&output).exists());

        // 值读回：正文/账号为文本，金额为数值（行序：正文2行 → 空行 → 表头 → 2行数据）。
        let mut workbook = calamine::open_workbook_auto(&output).unwrap();
        let range = workbook.worksheet_range("回函内容").unwrap();
        assert_eq!(
            range.get_value((0, 0)).unwrap().to_string(),
            "回函正文第一行"
        );
        assert_eq!(range.get_value((4, 0)).unwrap().to_string(), "0100684742");
        assert_eq!(range.get_value((3, 0)).unwrap().to_string(), "Account No");
        assert_eq!(range.get_value((5, 0)).unwrap().to_string(), "1334.5");

        let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
        let mut sheet_xml = String::new();
        use std::io::Read;
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut sheet_xml)
            .unwrap();
        assert!(!sheet_xml.contains("<mergeCell"), "不允许出现合并单元格");
        // 1,334.50 应写成数值 1334.5，两位小数格式定义在 styles.xml
        assert!(sheet_xml.contains("1334.5"));
        let mut styles_xml = String::new();
        archive
            .by_name("xl/styles.xml")
            .unwrap()
            .read_to_string(&mut styles_xml)
            .unwrap();
        assert!(styles_xml.contains("#,##0.00;(#,##0.00)"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn 清单写入包含成功与失败行() {
        let root = std::env::temp_dir().join(format!(
            "audit-toolbox-pdf2excel-manifest-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let output = root.join("处理清单.xlsx");
        let records = vec![
            json!({"name": "样例A.pdf", "status": "成功", "pages": 298, "textRows": 227,
                   "tables": 5, "tableDataRows": 6785, "outputPath": "C:\\out\\样例A.xlsx", "error": ""}),
            json!({"name": "扫描件.pdf", "status": "失败", "error": "这个 PDF 提取不到文字，可能是扫描件/图片版。"}),
        ];
        write_manifest(&records, &output).unwrap();
        let mut workbook = calamine::open_workbook_auto(&output).unwrap();
        let range = workbook.worksheet_range("处理清单").unwrap();
        assert_eq!(range.get_value((0, 0)).unwrap().to_string(), "文件名");
        assert_eq!(range.get_value((1, 0)).unwrap().to_string(), "样例A.pdf");
        assert_eq!(range.get_value((2, 1)).unwrap().to_string(), "失败");
        assert_eq!(
            range.get_value((2, 7)).unwrap().to_string(),
            "这个 PDF 提取不到文字，可能是扫描件/图片版。"
        );
        let _ = fs::remove_dir_all(&root);
    }


    /// 真实 298 页渣打银行回函（本机 Downloads 下）的端到端验收。
    /// 基准数字来自本机实跑。Rust 版对越界矩形的处理与独立 Python 版不同：crop 采用对象
    /// 中心点判定，表格回到真实边界，正文逐行干净——修正了独立版"整页巨行"与"信头混入数据
    /// 行"两个缺陷，因此正文/数据行数与独立版不同属预期。
    /// 样例不在时静默跳过；本机用 `cargo test -- --ignored` 显式跑。
    #[test]
    #[ignore]
    fn 真实回函端到端与独立版对齐() {
        let sample = Path::new(r"C:\Users\lenovo\Downloads\BLF_CC_127_R.pdf");
        if !sample.is_file() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "audit-toolbox-pdf2excel-e2e-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let output = root.join("BLF_CC_127_R.xlsx");
        let stats = convert_one(sample, &output, &|_, _| {}, &AtomicBool::new(false)).unwrap();
        println!(
            "基准: pages={} text_rows={} tables={} table_data_rows={}",
            stats.pages, stats.text_rows, stats.tables, stats.table_data_rows
        );
        assert_eq!(stats.pages, 298);
        // 基准来自本机实跑并经与独立版逐页比对核实（见 PDF_TO_EXCEL_PARITY.md）：
        // 6 张表 = 独立版 5 张 + 尾部 2 行 Custody 小表独立成表；
        // 6499 数据行 = 独立版 6785 - 286 行信头垃圾行（独立版把每页底部信头卷进数据区）。
        assert_eq!(stats.text_rows, 2230);
        assert_eq!(stats.tables, 6);
        assert_eq!(stats.table_data_rows, 6499);

        let mut workbook = calamine::open_workbook_auto(&output).unwrap();
        let range = workbook.worksheet_range("回函内容").unwrap();
        assert!(!range.is_empty(), "工作表应有内容");
        // 账号应原样保留为文本（不被数值化剥掉前导零），且与独立版种类数一致
        static ACCOUNT_RE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"\b\d{10}\b").unwrap());
        let mut accounts: HashSet<&str> = HashSet::new();
        for row in range.rows() {
            for cell in row {
                if let calamine::Data::String(s) = cell {
                    accounts.extend(ACCOUNT_RE.find_iter(s).map(|m| m.as_str()));
                }
            }
        }
        assert!(
            accounts.contains("0100684742"),
            "账号 0100684742 应原样保留"
        );
        assert_eq!(accounts.len(), 723, "10 位账号种类应与独立版一致");
        let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
        let mut sheet_xml = String::new();
        use std::io::Read;
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut sheet_xml)
            .unwrap();
        assert!(!sheet_xml.contains("<mergeCell"), "不允许出现合并单元格");
        // 设 PDF2EXCEL_KEEP=1 时保留输出文件（供与独立版做内容对比），否则清理。
        if std::env::var("PDF2EXCEL_KEEP").ok().as_deref() != Some("1") {
            let _ = fs::remove_dir_all(&root);
        } else {
            println!("保留输出: {}", output.display());
        }
    }
}
