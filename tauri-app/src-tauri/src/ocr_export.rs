//! Text-only XLSX output: no inferred numeric coercion, truncation or overwrite.
//! Recognition/extraction sheets contain source content, not per-page pipeline
//! warnings. Those remain in the store/UI and in the export's `partial` result.
use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    ocr_store::{Document, Store, failure, io_error},
};
use rust_xlsxwriter::{Format, FormatBorder, Url, Workbook, Worksheet};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
fn xlsx_error(_: rust_xlsxwriter::XlsxError) -> AppError {
    failure("OCR_EXPORT", "Excel 导出失败，请检查表格规模和输出目录。")
}
pub(crate) fn chunks(text: &str) -> Vec<String> {
    let mut parts = vec![];
    let mut part = String::new();
    let mut len = 0;
    for ch in text.chars() {
        if len + ch.len_utf16() > 32000 {
            parts.push(std::mem::take(&mut part));
            len = 0;
        }
        part.push(ch);
        len += ch.len_utf16();
    }
    parts.push(part);
    parts
}
fn unique_name(base: &str, names: &mut BTreeSet<String>) -> String {
    let clean: String = base
        .chars()
        .map(|c| {
            if "[]:*?/\\".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_matches('\'');
    let clean = if clean.is_empty() { "表格" } else { clean };
    for index in 0usize.. {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{index}")
        };
        let name = format!(
            "{}{}",
            clean
                .chars()
                .take(31 - suffix.len().min(30))
                .collect::<String>(),
            suffix
        );
        if names.insert(name.to_lowercase()) {
            return name;
        }
    }
    unreachable!()
}
fn sheet<'a>(
    book: &'a mut Workbook,
    base: &str,
    names: &mut BTreeSet<String>,
) -> Result<&'a mut Worksheet, AppError> {
    let name = unique_name(base, names);
    let s = book.add_worksheet();
    s.set_name(name).map_err(xlsx_error)?;
    s.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    s.set_column_width(0, 16).map_err(xlsx_error)?;
    s.set_column_width(1, 8).map_err(xlsx_error)?;
    Ok(s)
}
fn row(s: &mut Worksheet, index: &mut u32, values: &[String]) -> Result<(), AppError> {
    if values.len() > 16384 {
        return Err(failure(
            "OCR_EXPORT_COLUMNS",
            "表格超过 Excel 列数限制，请拆分表格后导出。",
        ));
    }
    let parts: Vec<_> = values.iter().map(|v| chunks(v)).collect();
    let count = parts.iter().map(Vec::len).max().unwrap_or(1);
    for offset in 0..count {
        if *index >= 1_048_576 {
            return Err(failure(
                "OCR_EXPORT_ROWS",
                "工作表超过 Excel 行数限制，请按文件分别导出。",
            ));
        }
        for (col, part) in parts.iter().enumerate() {
            if let Some(value) = part.get(offset) {
                s.write_string(*index, col as u16, value)
                    .map_err(xlsx_error)?;
            }
        }
        *index += 1;
    }
    Ok(())
}
fn value_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => {
            let trimmed = s.trim();
            // Models sometimes encode an object twice. Interpret only a complete
            // JSON container in an extraction cell, never the source text itself.
            if (trimmed.starts_with('{') || trimmed.starts_with('['))
                && let Ok(parsed @ (Value::Object(_) | Value::Array(_))) =
                    serde_json::from_str::<Value>(trimmed)
            {
                return value_text(&parsed);
            }
            crate::bailian_ocr::readable_ocr_text(s)
        }
        Value::Bool(value) => if *value { "是" } else { "否" }.into(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(value_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(fields) => fields
            .iter()
            .filter(|(key, _)| visible_field(key))
            .map(|(key, value)| format!("{}：{}", field_label(key), value_text(value)))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}
fn source_text_field(key: &str) -> bool {
    let compact: String = key.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.contains("原文") || compact.contains("全文") || compact.contains("逐字证据") { return true; }
    matches!(compact.to_ascii_lowercase().as_str(),
        "quote" | "quotes" | "excerpt" | "contract_excerpt" | "source_excerpt"
        | "evidence" | "evidence_quotes" | "evidence_refs" | "evidence_ids"
        | "source_reference" | "source_text" | "sourcetext" | "original_text"
        | "originaltext" | "full_text" | "fulltext" | "raw_text" | "rawtext"
        | "contractexcerpt" | "sourceexcerpt" | "evidencequotes" | "evidencerefs"
        | "evidenceids" | "sourcereference"
        | "原文" | "原文摘录" | "合同原文" | "合同原文摘录" | "关键合同原文"
        | "完整原文" | "原文内容" | "来源原文" | "逐字原文" | "逐字证据"
        | "原文证据" | "证据原文" | "原文引用出处" | "原文引用" | "原文引用位置"
        | "原文引用内容" | "原文引用来源" | "原文片段")
}
fn visible_field(key: &str) -> bool {
    !key.starts_with('_') && !source_text_field(key) && !matches!(key,
        "source_document_id" | "evidence_quotes" | "covenant_category_id"
        | "covenant_scope" | "contract_classification" | "is_financial")
}
fn canonical_field(key: &str) -> &str {
    match key {
        "source_documents" => "sourceFile",
        "page" | "pages" | "source_page" => "sourcePage",
        _ => key,
    }
}
fn extraction_columns(extraction: &Value, source_file_first: bool) -> Vec<(String, String)> {
    let mut columns = Vec::new();
    let mut seen = BTreeSet::new();
    if source_file_first {
        columns.push(("sourceFile".into(), "来源文件".into()));
        seen.insert("sourceFile".to_string());
    }
    for column in extraction["columns"].as_array().into_iter().flatten() {
        let Some(original_key) = column["key"].as_str().filter(|key| visible_field(key)) else { continue; };
        if column["label"].as_str().is_some_and(source_text_field) { continue; }
        let key = canonical_field(original_key);
        if !seen.insert(key.to_string()) { continue; }
        let label = column["label"].as_str().unwrap_or(original_key);
        let label = if label == original_key || matches!(key, "sourceFile" | "sourcePage") {
            field_label(key)
        } else { label };
        columns.push((key.into(), label.into()));
    }
    columns
}
fn field_label(key: &str) -> &str {
    match key {
        "amount" => "金额",
        "currency" => "币种",
        "date" => "日期",
        "value" => "内容",
        "category" => "类别",
        "name" => "名称",
        "title" => "事项",
        "rate" => "利率",
        "principal" => "本金",
        "description" => "说明",
        "condition" | "conditions" => "条件",
        "frequency" => "频率",
        "start_date" => "开始日期",
        "end_date" => "结束日期",
        "due_date" => "到期日期",
        "account" | "account_no" => "账号",
        "quote" | "excerpt" | "contract_excerpt" | "source_excerpt" => "原文摘录",
        "evidence" => "逐字证据",
        "sourceFile" | "source_documents" => "来源文件",
        "sourcePage" | "page" | "pages" | "source_page" => "来源页码",
        "source_reference" => "原文引用出处",
        "review_note" => "复核提示",
        "covenant_category" => "财务指标契约类型",
        "trigger_standard" => "限制或触发标准",
        "clause_ref" => "条款位置",
        "breach_consequence" => "违约后果",
        "covenant_scope" => "契约适用范围",
        "contract_classification" => "合同分类",
        "is_financial" => "是否为财务约束",
        "auditor_summary" => "审计提示",
        _ => key,
    }
}
fn scenario_label(id: &str) -> &str {
    match id {
        "loan_restrictive" => "借款限制性契约（含非财务）",
        "loan_covenant" => "借款财务指标契约",
        "loan_general" => "借款合同主表",
        "revenue" => "收入合同",
        "procurement" => "采购合同",
        "invoicing_agreement" => "开票协议",
        "statement" => "对账单",
        "invoice" => "发票",
        "warehouse_io" => "出入库单",
        "account_opening" => "开户资料",
        "tax_declaration" => "纳税申报",
        "credit_report" => "征信报告",
        "tax_audit_report" => "税务审计报告",
        "custom" => "自定义摘录",
        _ => "场景摘录",
    }
}
fn readable_extraction_row(data: &Value) -> Value {
    let mut row = data.as_object().cloned().unwrap_or_default();
    // Old model output duplicates provenance under aliases. Prefer the already
    // verified canonical value; otherwise retain the alias's source information.
    for (alias, canonical) in [("source_documents", "sourceFile"), ("pages", "sourcePage"), ("page", "sourcePage"), ("source_page", "sourcePage")] {
        if let Some(value) = row.remove(alias)
            && row.get(canonical).is_none_or(|v| value_text(v).trim().is_empty())
        {
            row.insert(canonical.into(), value);
        }
    }
    // Keep the actionable review reason, while hiding pipeline traces, raw model
    // links and internal document identifiers from the user's workbook.
    if let Some(reason) = row.get("_covenant_review_reason").cloned()
        && !value_text(&reason).trim().is_empty()
    {
        row.insert("review_note".into(), reason);
    }
    row.retain(|key, _| visible_field(key));
    Value::Object(row)
}
fn extraction_row(extraction: &Value, data: &Value) -> Value {
    let mut row = readable_extraction_row(data);
    // A model-defined key may be opaque while its label clearly names an
    // original-text column. Do not resurrect it through historical row-key
    // discovery after the declared column was excluded.
    if let Some(values) = row.as_object_mut() {
        for column in extraction["columns"].as_array().into_iter().flatten() {
            if column["label"].as_str().is_some_and(source_text_field)
                && let Some(key) = column["key"].as_str()
            { values.remove(key); }
        }
    }
    row
}
fn section_row(s: &mut Worksheet, index: &mut u32, values: &[String]) -> Result<(), AppError> {
    let first = *index;
    row(s, index, values)?;
    s.set_row_format(
        first,
        &Format::new().set_bold().set_background_color(0xEAF2F1),
    )
    .map_err(xlsx_error)?;
    Ok(())
}

/// Use only the original scan retained by the trusted store, never model
/// output as a target. A missing file remains a plain filename in the workbook.
fn source_link(store: &Store, doc: &Document) -> Result<Option<String>, AppError> {
    let path = store.source(&doc.id)?;
    if !path.is_file() { return Ok(None); }
    let absolute = if path.is_absolute() { path } else { std::env::current_dir().map_err(io_error)?.join(path) };
    Ok(reqwest::Url::from_file_path(absolute).ok().map(|url| url.to_string()).filter(|url| url.len() <= 2080))
}

/// Repeat provenance on every physical Excel row, including long-cell
/// continuations. A continuation must never lose its file or page context.
fn source_row(s: &mut Worksheet, r: &mut u32, file: &str, page: &str, values: &[String], link: Option<&str>) -> Result<(), AppError> {
    let parts: Vec<_> = values.iter().map(|value| chunks(value)).collect();
    for offset in 0..parts.iter().map(Vec::len).max().unwrap_or(1) {
        let mut cells = vec![file.to_owned(), page.to_owned()];
        cells.extend(parts.iter().map(|part| part.get(offset).cloned().unwrap_or_default()));
        let index = *r;
        row(s, r, &cells)?;
        // Stay within Excel's hyperlink-count limit even for very large OCR
        // exports. Later rows retain the filename without an active link.
        if index < 65_530 && let Some(link) = link {
            s.write_url_with_format(index, 0, Url::new(link).set_text(file),
                &Format::new().set_font_color(0x0563C1).set_underline(rust_xlsxwriter::FormatUnderline::Single).set_num_format("@"))
                .map_err(xlsx_error)?;
        }
    }
    Ok(())
}
fn source_columns(s: &mut Worksheet, body_columns: usize) -> Result<(), AppError> {
    if body_columns > 16382 { return Err(failure("OCR_EXPORT_COLUMNS", "表格超过 Excel 列数限制，请拆分表格后导出。")); }
    s.set_column_width(0, 16).map_err(xlsx_error)?;
    s.set_column_width(1, 8).map_err(xlsx_error)?;
    for column in 0..body_columns + 2 {
        if column >= 2 { s.set_column_width(column as u16, if column == 2 { 100 } else { 32 }).map_err(xlsx_error)?; }
        let format = Format::new().set_num_format("@");
        let format = if column >= 2 { format.set_text_wrap() } else { format };
        s.set_column_format(column as u16, &format).map_err(xlsx_error)?;
    }
    Ok(())
}
fn table_source_row(s: &mut Worksheet, r: &mut u32, file: &str, page: &str, cells: &[String], link: Option<&str>) -> Result<(), AppError> {
    if cells.len() > 16382 { return Err(failure("OCR_EXPORT_COLUMNS", "表格超过 Excel 列数限制，请拆分表格后导出。")); }
    let first = *r;
    source_row(s, r, file, page, cells, link)?;
    if !cells.is_empty() {
        s.set_range_format(first, 2, *r - 1, (cells.len() + 1) as u16,
            &Format::new().set_border(FormatBorder::Thin).set_text_wrap().set_num_format("@"))
            .map_err(xlsx_error)?;
    }
    Ok(())
}
fn extraction_business_columns(extractions: &[Value]) -> Vec<(String, String)> {
    let mut columns = vec![];
    let mut seen = BTreeSet::new();
    for extraction in extractions {
        for (key, label) in extraction_columns(extraction, false) {
            if !matches!(canonical_field(&key), "sourceFile" | "sourcePage") && seen.insert(key.clone()) { columns.push((key, label)); }
        }
        for data in extraction["rows"].as_array().into_iter().flatten().map(|data| extraction_row(extraction, data)) {
            if let Some(object) = data.as_object() {
                for key in object.keys().filter(|key| visible_field(key)) {
                    if !matches!(canonical_field(key), "sourceFile" | "sourcePage") && seen.insert(key.clone()) { columns.push((key.clone(), field_label(key).into())); }
                }
            }
        }
    }
    if extractions.iter().any(|entry| entry["rows"].as_array().is_none_or(Vec::is_empty)) {
        columns.push(("__empty_result".into(), "摘录说明".into()));
    }
    if columns.is_empty() { columns.push(("value".into(), "内容".into())); }
    // Keep the principal business content in C; classification and scenario
    // labels must not displace the content the user is trying to review.
    if let Some(index) = ["requirement", "trigger_standard", "value", "description"]
        .iter().find_map(|key| columns.iter().position(|(column, _)| column == key)) {
        let content = columns.remove(index); columns.insert(0, content);
    }
    columns
}
fn extraction_header(s: &mut Worksheet, r: &mut u32, columns: &[(String, String)]) -> Result<(), AppError> {
    let mut header = vec!["来源文件".into(), "页码".into()];
    header.extend(columns.iter().map(|(_, label)| label.clone()));
    header.push("场景".into());
    section_row(s, r, &header)?;
    source_columns(s, columns.len() + 1)?;
    s.set_column_width(2, 32).map_err(xlsx_error)?;
    Ok(())
}
fn extraction_rows(s: &mut Worksheet, r: &mut u32, doc: &Document, extraction: &Value, scenario: &str,
    columns: &[(String, String)], pause: &PauseCheckpoint, link: Option<&str>) -> Result<(), AppError> {
    let rows: Vec<_> = extraction["rows"].as_array().into_iter().flatten().map(|data| extraction_row(extraction, data)).collect();
    if rows.is_empty() {
        let mut cells: Vec<String> = columns.iter().map(|(key, _)| if key == "__empty_result" { "未发现符合场景事项".into() } else { String::new() }).collect();
        cells.push(scenario.to_owned());
        return source_row(s, r, &doc.name, "", &cells, link);
    }
    for data in rows {
        pause.wait()?;
        let page = value_text(&data["sourcePage"]);
        let page = if page.trim().is_empty() { "具体出处待核对" } else { &page };
        let mut cells: Vec<String> = columns.iter().map(|(key, _)| if key == "__empty_result" { String::new() } else { value_text(&data[key]) }).collect();
        cells.push(scenario.to_owned());
        source_row(s, r, &doc.name, page, &cells, link)?;
    }
    Ok(())
}
fn extraction_blocks(s: &mut Worksheet, r: &mut u32, doc: &Document, extraction: &Value, scenario: &str, pause: &PauseCheckpoint, link: Option<&str>) -> Result<(), AppError> {
    let columns = extraction_business_columns(std::slice::from_ref(extraction));
    extraction_header(s, r, &columns)?;
    extraction_rows(s, r, doc, extraction, scenario, &columns, pause, link)
}
/// A native grid already embedded in the text is written at its exact source
/// position as cells. Never infer tables by splitting arbitrary prose on tabs.
fn page_rows(s: &mut Worksheet, r: &mut u32, doc: &Document, page: &crate::ocr_store::Page, pause: &PauseCheckpoint, link: Option<&str>) -> Result<(), AppError> {
    let mut matches = vec![];
    let mut placed = BTreeSet::new();
    for (index, table) in page.tables.iter().enumerate() {
        if table.rows.is_empty() || table.rows.iter().map(Vec::len).max().unwrap_or(0) < 2 { continue; }
        for separator in ["\n", "\n\n"] {
            let grid = table.rows.iter().map(|cells| cells.join("\t")).collect::<Vec<_>>().join(separator);
            if grid.is_empty() { continue; }
            let found = page.text.match_indices(&grid).find(|(start, _)| {
                let end = start + grid.len();
                (*start == 0 || page.text[..*start].ends_with('\n')) &&
                    (end == page.text.len() || page.text[end..].starts_with('\n')) &&
                    !matches.iter().any(|(from, to, _)| *start < *to && end > *from)
            });
            if let Some((start, _)) = found {
                matches.push((start, start + grid.len(), index)); placed.insert(index); break;
            }
        }
    }
    matches.sort_by_key(|(start, _, _)| *start);
    let number = page.page.to_string();
    let mut cursor = 0;
    for (start, end, index) in matches {
        let prose = &page.text[cursor..start];
        for line in prose.strip_suffix('\n').unwrap_or(prose).split_terminator('\n') {
            pause.wait()?; source_row(s, r, &doc.name, &number, &[line.into()], link)?;
        }
        for cells in &page.tables[index].rows { pause.wait()?; table_source_row(s, r, &doc.name, &number, cells, link)?; }
        cursor = end;
        if page.text[cursor..].starts_with('\n') { cursor += 1; }
    }
    for line in page.text[cursor..].split_terminator('\n') {
        pause.wait()?; source_row(s, r, &doc.name, &number, &[line.into()], link)?;
    }
    for (_, table) in page.tables.iter().enumerate().filter(|(index, _)| !placed.contains(index)) {
        if !table.title.is_empty() { source_row(s, r, &doc.name, &number, &[table.title.clone()], link)?; }
        for cells in &table.rows { pause.wait()?; table_source_row(s, r, &doc.name, &number, cells, link)?; }
    }
    source_columns(s, page.tables.iter().flat_map(|table| &table.rows).map(Vec::len).max().unwrap_or(1))
}
fn document_blocks(store: &Store, doc: &Document, s: &mut Worksheet, r: &mut u32, pause: &PauseCheckpoint) -> Result<(), AppError> {
    if *r == 0 { section_row(s, r, &["来源文件".into(), "页码".into(), "内容".into()])?; }
    let link = source_link(store, doc)?;
    for page in store.pages(&doc.id)? { page_rows(s, r, doc, &page, pause, link.as_deref())?; }
    for extraction in store.extractions(&doc.id)? {
        extraction_blocks(s, r, doc, &extraction, scenario_label(extraction["scenarioId"].as_str().unwrap_or("")), pause, link.as_deref())?;
    }
    // Historical extracts can share an OCR sheet; its primary prose column
    // keeps the wider OCR layout rather than the extraction-only width.
    s.set_column_width(2, 100).map_err(xlsx_error)?;
    Ok(())
}

fn build_sectioned(
    store: &Store,
    docs: &[Document],
    single_sheet: bool,
    pause: &PauseCheckpoint,
) -> Result<Vec<u8>, AppError> {
    let mut book = Workbook::new();
    let mut names = BTreeSet::new();
    if single_sheet {
        let s = sheet(&mut book, "OCR汇总", &mut names)?;
        let mut r = 0;
        for doc in docs {
            document_blocks(store, doc, s, &mut r, pause)?;
        }
    } else {
        for doc in docs {
            let name = Path::new(&doc.name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            let s = sheet(&mut book, &name, &mut names)?;
            let mut r = 0;
            document_blocks(store, doc, s, &mut r, pause)?;
        }
    }
    pause.wait()?;
    book.save_to_buffer().map_err(xlsx_error)
}

fn build(store: &Store, docs: &[Document], pause: &PauseCheckpoint) -> Result<Vec<u8>, AppError> {
    let mut book = Workbook::new();
    let mut names = BTreeSet::new();
    let directory = unique_name("目录", &mut names);
    book.add_worksheet()
        .set_name(&directory)
        .map_err(xlsx_error)?;
    let mut entries = vec![];
    let mut entry_links = vec![];
    for (dindex, doc) in docs.iter().enumerate() {
        pause.wait()?;
        let link = source_link(store, doc)?;
        let pages = store.pages(&doc.id)?;
        let s = sheet(&mut book, &format!("{}_完整原文", dindex + 1), &mut names)?;
        let text_name = s.name();
        let mut r = 0;
        s.set_column_width(0, 30).map_err(xlsx_error)?;
        s.set_column_width(1, 8).map_err(xlsx_error)?;
        s.set_column_width(2, 110).map_err(xlsx_error)?;
        s.set_column_format(2, &Format::new().set_text_wrap().set_num_format("@"))
            .map_err(xlsx_error)?;
        row(
            s,
            &mut r,
            &["来源文件".into(), "页码".into(), "完整原文".into()],
        )?;
        for page in &pages { page_rows(s, &mut r, doc, page, pause, link.as_deref())?; }
        for page in &pages {
            for (tindex, table) in page.tables.iter().enumerate() {
                pause.wait()?;
                let s = sheet(
                    &mut book,
                    &format!("{}_第{}页_表{}", dindex + 1, page.page, tindex + 1),
                    &mut names,
                )?;
                let table_name = s.name();
                let mut r = 0;
                source_columns(s, table.rows.iter().map(Vec::len).max().unwrap_or(1))?;
                section_row(s, &mut r, &["来源文件".into(), "页码".into(), "表格内容".into()])?;
                for cells in &table.rows { table_source_row(s, &mut r, &doc.name, &page.page.to_string(), cells, link.as_deref())?; }
                entry_links.push(link.clone());
                entries.push(vec![
                    doc.name.clone(),
                    page.page.to_string(),
                    "表格".into(),
                    table_name,
                ]);
            }
        }
        for extraction in store.extractions(&doc.id)? {
            pause.wait()?;
            let scenario = scenario_label(extraction["scenarioId"].as_str().unwrap_or(""));
            let s = sheet(
                &mut book,
                &format!("{}_摘录_{}", dindex + 1, scenario),
                &mut names,
            )?;
            let extract_name = s.name();
            let mut r = 0;
            extraction_blocks(s, &mut r, doc, &extraction, scenario, pause, link.as_deref())?;
            entry_links.push(link.clone());
            entries.push(vec![
                doc.name.clone(),
                String::new(),
                "摘录".into(),
                extract_name,
            ]);
        }
        entry_links.push(link.clone());
        entries.push(vec![
            doc.name.clone(),
            pages.iter().map(|page| page.page.to_string()).collect::<Vec<_>>().join("、"),
            "完整原文".into(),
            text_name,
        ]);
    }
    let s = book.worksheet_from_name(&directory).map_err(xlsx_error)?;
    let mut r = 0;
    row(
        s,
        &mut r,
        &[
            "来源文件".into(),
            "页码".into(),
            "内容类型".into(),
            "工作表".into(),
        ],
    )?;
    for (item, link) in entries.iter().zip(&entry_links) {
        source_row(s, &mut r, &item[0], &item[1], &item[2..], link.as_deref())?;
    }
    s.set_column_width(0, 16).map_err(xlsx_error)?;
    s.set_column_width(1, 8).map_err(xlsx_error)?;
    s.set_column_width(2, 50).map_err(xlsx_error)?;
    let format = Format::new().set_bold();
    s.set_row_format(0, &format).map_err(xlsx_error)?;
    book.save_to_buffer().map_err(xlsx_error)
}
fn filename(s: &str) -> String {
    let clean: String = s
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let clean = clean.trim_matches(['.', ' ']);
    if clean.is_empty() {
        "OCR".into()
    } else {
        clean.into()
    }
}

fn build_extractions(store: &Store, docs: &[Document], ids: &BTreeSet<String>, single_sheet: bool, pause: &PauseCheckpoint) -> Result<Vec<u8>, AppError> {
    let mut book = Workbook::new();
    let mut names = BTreeSet::new();
    let mut found = BTreeSet::new();
    let mut shared_name = String::new();
    let mut shared_row = 0;
    let mut selected = vec![];
    for doc in docs {
        selected.extend(store.extractions(&doc.id)?.into_iter().filter(|entry| entry["id"].as_str().is_some_and(|id| ids.contains(id))));
    }
    let columns = extraction_business_columns(&selected);
    for doc in docs {
        pause.wait()?;
        let extractions: Vec<Value> = store.extractions(&doc.id)?.into_iter()
            .filter(|entry| entry["id"].as_str().is_some_and(|id| ids.contains(id))).collect();
        if extractions.is_empty() {
            return Err(failure("OCR_EXTRACTION_NOT_FOUND", "本次摘录结果与所选文件不一致，请重新摘录后导出。"));
        }
        let target = if single_sheet && !shared_name.is_empty() {
            book.worksheet_from_name(&shared_name).map_err(xlsx_error)?
        } else {
            let target = sheet(&mut book, if single_sheet { "场景摘录" } else { &doc.name }, &mut names)?;
            if single_sheet { shared_name = target.name(); }
            target
        };
        let mut r = if single_sheet { shared_row } else { 0 };
        if r == 0 { extraction_header(target, &mut r, &columns)?; }
        let project = store.project(&doc.project_id)?;
        let link = source_link(store, doc)?;
        for extraction in extractions {
            found.insert(extraction["id"].as_str().unwrap_or("").to_owned());
            let scenario_id = extraction["scenarioId"].as_str().unwrap_or("");
            let scenario_name = project["customScenarios"].as_array().into_iter().flatten()
                .find(|entry| entry["id"] == scenario_id).and_then(|entry| entry["name"].as_str()).unwrap_or_else(|| scenario_label(scenario_id));
            extraction_rows(target, &mut r, doc, &extraction, scenario_name, &columns, pause, link.as_deref())?;
        }
        if single_sheet { shared_row = r; }
    }
    if found != *ids { return Err(failure("OCR_EXTRACTION_NOT_FOUND", "本次摘录列表包含其他文件或不存在的记录。")); }
    book.save_to_buffer().map_err(xlsx_error)
}
/// Compatibility publication for volumes without hard links. Returns false on
/// an existing name; any failed or cancelled new file is removed.
fn write_new_target(
    output: &Path,
    bytes: &[u8],
    pause: &PauseCheckpoint,
) -> Result<bool, AppError> {
    let mut target = match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(output)
    {
        Ok(target) => target,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(io_error(e)),
    };
    let written = (|| {
        for part in bytes.chunks(1024 * 1024) {
            pause.wait()?;
            target.write_all(part).map_err(io_error)?;
        }
        target.sync_all().map_err(io_error)?;
        pause.wait()
    })();
    drop(target);
    if let Err(error) = written {
        let _ = fs::remove_file(output);
        return Err(error);
    }
    Ok(true)
}
fn publish(
    dir: &Path,
    base: &str,
    bytes: &[u8],
    pause: &PauseCheckpoint,
) -> Result<PathBuf, AppError> {
    // Write complete data first, then atomically add a destination hard link. hard_link
    // fails when the final name exists, unlike rename on platforms that overwrite.
    let temp = dir.join(format!(".ocr-{}.tmp", uuid::Uuid::new_v4()));
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(io_error)?;
    let result = (|| {
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(io_error)?;
        drop(f);
        pause.wait()?;
        for index in 0..10000 {
            let suffix = if index == 0 {
                String::new()
            } else {
                format!("_{index}")
            };
            let output = dir.join(format!("{}{suffix}.xlsx", filename(base)));
            match fs::hard_link(&temp, &output) {
                Ok(()) => return Ok(output),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => {
                    // exFAT/FAT and some network drives have no hard links.
                    // create_new still reserves the final path without overwriting.
                    if write_new_target(&output, bytes, pause)? {
                        return Ok(output);
                    }
                    continue;
                }
            }
        }
        Err(failure("OCR_EXPORT_NAMES", "输出目录中同名文件过多。"))
    })();
    let _ = fs::remove_file(temp);
    result
}
pub(crate) fn export(
    store: &Store,
    p: &Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    let project = p["projectId"].as_str().unwrap_or("");
    let project_data = store.project(project)?;
    let all = store.documents(project)?;
    let selected = p.get("documentIds").and_then(Value::as_array);
    if selected.is_some_and(|ids| ids.iter().any(|id| !all.iter().any(|doc| doc["id"] == *id))) {
        return Err(failure(
            "OCR_DOCUMENT_NOT_FOUND",
            "导出列表包含其他项目或已删除的文件。",
        ));
    }
    let docs: Vec<Document> = all
        .into_iter()
        .filter(|v| selected.is_none_or(|ids| ids.contains(&v["id"])))
        .map(|v| serde_json::from_value(v).map_err(|_| failure("OCR_DATA", "文件信息无效。")))
        .collect::<Result<_, _>>()?;
    if docs.is_empty() {
        return Err(failure("OCR_EXPORT_EMPTY", "请先选择需要导出的文件。"));
    }
    let dir = Path::new(p["outputDir"].as_str().unwrap_or(""));
    if !dir.is_dir() {
        return Err(failure("OCR_OUTPUT_DIR", "请选择有效的输出目录。"));
    }
    let mode = p["mode"].as_str().unwrap_or("");
    if !matches!(mode, "combined" | "individual" | "single_sheet" | "per_document") {
        return Err(failure("OCR_EXPORT_MODE", "请选择一个工作表、按文件分工作表或分别导出 Excel。"));
    }
    let mut outputs = vec![];
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    let extractions_only = p["extractionsOnly"] == true;
    let extraction_ids: BTreeSet<String> = p["extractionIds"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    if extractions_only && (extraction_ids.is_empty() || p["extractionIds"].as_array().is_none_or(|ids| ids.len() != extraction_ids.len())) {
        return Err(failure("OCR_EXTRACTION_NOT_FOUND", "请指定本次保存的摘录结果。"));
    }
    if extractions_only {
        let mut available = BTreeSet::new();
        for doc in &docs {
            available.extend(store.extractions(&doc.id)?.iter().filter_map(|entry| entry["id"].as_str()).filter(|id| extraction_ids.contains(*id)).map(str::to_owned));
        }
        if available != extraction_ids { return Err(failure("OCR_EXTRACTION_NOT_FOUND", "本次摘录列表包含其他文件或不存在的记录。")); }
    }
    if mode != "individual" {
        progress("export", 0, 1, "正在生成项目 Excel");
        let bytes = if extractions_only { build_extractions(store, &docs, &extraction_ids, mode == "single_sheet", pause)? } else { match mode {
            "single_sheet" => build_sectioned(store, &docs, true, pause)?,
            "per_document" => build_sectioned(store, &docs, false, pause)?,
            _ => build(store, &docs, pause)?,
        }};
        outputs.push(publish(
            dir,
            &format!("{}_{}_{stamp}", project_data["name"].as_str().unwrap_or("项目"), if extractions_only { "场景摘录" } else { "OCR" }),
            &bytes,
            pause,
        )?);
    } else {
        for (index, doc) in docs.iter().enumerate() {
            pause.wait()?;
            progress("export", index, docs.len(), "正在生成文件 Excel");
            let document_ids: BTreeSet<String> = store.extractions(&doc.id)?.iter().filter_map(|entry| entry["id"].as_str()).filter(|id| extraction_ids.contains(*id)).map(str::to_owned).collect();
            let bytes = if extractions_only { build_extractions(store, std::slice::from_ref(doc), &document_ids, true, pause)? }
                else { build(store, std::slice::from_ref(doc), pause)? };
            let stem = Path::new(&doc.name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            outputs.push(publish(dir, &format!("{stem}_{}_{stamp}", if extractions_only { "场景摘录" } else { "OCR" }), &bytes, pause)?);
        }
    }
    progress("export", docs.len(), docs.len(), "Excel 导出完成");
    store.remember_output_directory(project, dir)?;
    Ok(
        json!({"outputPaths":outputs.iter().map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>(),"documentCount":docs.len(),"partial":docs.iter().any(|d|d.status!="completed")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicBool};
    /// Explicitly invoked manual acceptance against an isolated fixture store.
    /// No model configuration or credentials are read by this export probe.
    #[test]
    #[ignore = "需 OCR_EXPORT_PROBE_REQUEST 指向已授权的隔离数据库导出请求"]
    fn fixture_export_from_request_file() {
        let request_file = std::env::var("OCR_EXPORT_PROBE_REQUEST").expect("缺少导出验收请求文件");
        let request: Value = serde_json::from_slice(&fs::read(request_file).unwrap()).unwrap();
        let store = Store::open(Path::new(request["dbPath"].as_str().unwrap())).unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let result = export(&store, &request["params"], &|_,_,_,_|{}, &pause)
            .unwrap_or_else(|error| panic!("{}：{}", error.code, error.user_message));
        fs::write(request["resultPath"].as_str().unwrap(), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        println!("隔离数据库的本次摘录导出完成。");
    }
    #[test]
    fn financial_metric_scenario_and_column_names_match_the_ui() {
        assert_eq!(scenario_label("loan_covenant"), "借款财务指标契约");
        assert_eq!(field_label("covenant_category"), "财务指标契约类型");
    }
    #[test]
    fn extraction_columns_hide_pipeline_fields_and_merge_provenance_without_losing_business() {
        let extraction = json!({"columns":[
            {"key":"sourceFile","label":"来源文件"},{"key":"source_documents","label":"source_documents"},
            {"key":"sourcePage","label":"核实页码"},{"key":"pages","label":"pages"},
            {"key":"title","label":"title"},{"key":"clause_ref","label":"clause_ref"},
            {"key":"covenant_category_id"},{"key":"covenant_scope"},{"key":"contract_classification"},{"key":"is_financial"},
            {"key":"auditor_summary","label":"审计提示"},{"key":"client_field","label":"自定义业务列"}
        ]});
        for with_source in [false, true] {
            assert_eq!(extraction_columns(&extraction, with_source), vec![
                ("sourceFile".into(), "来源文件".into()), ("sourcePage".into(), "来源页码".into()),
                ("title".into(), "事项".into()), ("clause_ref".into(), "条款位置".into()),
                ("auditor_summary".into(), "审计提示".into()), ("client_field".into(), "自定义业务列".into())
            ]);
        }
        let row = readable_extraction_row(&json!({"sourceFile":"当前文件.pdf","source_documents":"重复文件.pdf","sourcePage":"21","pages":"22","title":"投资限额","clause_ref":"第二十条","covenant_category_id":"C03","covenant_scope":"repayment","contract_classification":"财务指标契约","is_financial":true,"auditor_summary":"履约情况需复核","client_field":"客户自定义内容"}));
        assert_eq!(row, json!({"sourceFile":"当前文件.pdf","sourcePage":"21","title":"投资限额","clause_ref":"第二十条","auditor_summary":"履约情况需复核","client_field":"客户自定义内容"}));
        assert_eq!(readable_extraction_row(&json!({"source_documents":["甲.pdf","乙.pdf"],"pages":[1,3]})),json!({"sourceFile":["甲.pdf","乙.pdf"],"sourcePage":[1,3]}));
    }
    #[test]
    fn all_scenarios_exclude_source_text_aliases_and_labels_across_export_modes() {
        use crate::ocr_store::Page;
        use calamine::Reader;
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"场景不附原文"})).unwrap();
        let source = dir.path().join("合同.pdf"); fs::write(&source,b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(),&source).unwrap();
        store.prepare(&doc.id,1).unwrap();
        let grid = "单价\t数量\n0.57\t00123";
        store.save_page(&doc.id,Page { metadata:Default::default(),page:1,
            text:format!("直接识别正文保留\n{grid}"),original_text:String::new(),revision:0,status:"completed".into(),warnings:vec![],original_tables:vec![],
            tables:vec![crate::ocr_store::Table{id:"table".into(),title:"".into(),rows:vec![vec!["单价".into(),"数量".into()],vec!["0.57".into(),"00123".into()]]}] },0,true).unwrap();
        let aliases = ["quote","quotes","excerpt","contract_excerpt","source_excerpt","evidence","evidence_quotes","evidence_refs","evidence_ids","source_reference",
            "sourceText","originalText","fullText","rawText","contractExcerpt","sourceExcerpt","evidenceQuotes","evidenceRefs","evidenceIds","sourceReference","_hiddenEvidence","原文片段"];
        let hidden_labels = ["关键合同原文","完整原文","逐字证据","原文引用出处","原文摘录"," 合同 原文 ","补充条款原文","合同全文"];
        let scenarios = ["loan_general","loan_covenant","loan_restrictive","revenue","procurement","invoicing_agreement","statement","invoice","warehouse_io","account_opening","tax_declaration","credit_report","tax_audit_report","custom"];
        let mut ids = vec![];
        for scenario in scenarios {
            let mut row = json!({"description":"有效业务摘要","auditor_summary":"有效审计提示","sourcePage":"1","clause_ref":"第十条"});
            let mut columns = vec![json!({"key":"description","label":"业务摘要"}),json!({"key":"auditor_summary","label":"审计提示"}),json!({"key":"clause_ref","label":"条款位置"})];
            for alias in aliases { row[alias] = json!("附加原文禁止出现"); }
            for (index,label) in hidden_labels.iter().enumerate() {
                let key = format!("opaque_{index}"); row[&key] = json!("动态原文禁止出现");
                columns.push(json!({"key":key,"label":label}));
            }
            // Exercise fallback discovery: source aliases need not be declared.
            let saved = store.save_extraction(&json!({"documentId":doc.id,"sourceRevision":1,"scenarioId":scenario,"columns":columns,"rows":[row],"prompts":[]})).unwrap();
            ids.push(saved["id"].as_str().unwrap().to_owned());
        }
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for mode in ["single_sheet","per_document","individual","combined"] {
            for only in [true,false] {
                let result = export(&store,&json!({"projectId":project["id"],"documentIds":[doc.id],"outputDir":dir.path(),"mode":mode,"extractionsOnly":only,"extractionIds":ids}),&|_,_,_,_|{},&pause).unwrap();
                let mut all = String::new();
                let mut summaries = 0;
                for path in result["outputPaths"].as_array().unwrap() {
                    let mut book = calamine::open_workbook_auto(path.as_str().unwrap()).unwrap();
                    for name in book.sheet_names() {
                        let range = book.worksheet_range(&name).unwrap();
                        for row in range.rows() {
                            if row.iter().any(|v|v.to_string()=="有效业务摘要") {
                                summaries += 1;
                                assert_eq!(row[0].to_string(),"合同.pdf");
                                assert_eq!(row[1].to_string(),"1");
                            }
                            all.push_str(&row.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"));
                            all.push('\n');
                        }
                    }
                }
                assert_eq!(summaries,scenarios.len(),"{mode}, only={only}");
                for unwanted in ["附加原文禁止出现","动态原文禁止出现","关键合同原文","逐字证据","原文引用出处"] {
                    assert!(!all.contains(unwanted),"{mode}, only={only}: {unwanted}");
                }
                assert!(all.contains("有效审计提示") && all.contains("第十条"));
                assert_eq!(all.contains("直接识别正文保留"),!only);
                if !only { assert!(all.contains("单价\n数量") && all.contains("0.57\n00123")); }
            }
        }
    }
    #[test]
    fn only_current_extractions_are_exported_with_sources_empty_results_and_timestamp() {
        use crate::ocr_store::Page;
        use calamine::Reader;
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"本次摘录","customScenarios":[{"id":"saved-covenant","name":"我的财务限制","baseScenarioId":"loan_covenant","version":"1","fields":[],"stages":[{"id":"extract","label":"摘录","prompt":"保留原文"}]}]})).unwrap();
        let source = dir.path().join("合同.pdf");
        fs::write(&source, b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), &source).unwrap();
        store.prepare(&doc.id, 2).unwrap();
        store.save_page(&doc.id, Page { metadata: Default::default(), page:1, text:"不得导出整篇正文".into(), original_text:"不得导出整篇正文".into(), tables:vec![], original_tables:vec![], revision:0,status:"needs_review".into(),warnings:vec!["方向待复核".into()] },0,true).unwrap();
        let data = json!({"documentId":doc.id,"sourceRevision":1,"scenarioId":"saved-covenant","columns":[{"key":"requirement","label":"限制内容"},{"key":"excerpt","label":"合同原文摘录"},{"key":"sourcePage","label":"来源页码"}],"prompts":[]});
        let mut historical = data.clone(); historical["rows"] = json!([{"excerpt":"不得包含历史结果"}]);
        store.save_extraction(&historical).unwrap();
        let mut current = data.clone(); current["rows"] = json!([{"requirement":"借款人负债率不得超过65%","excerpt":"原文证据不应附上","sourcePage":"1"}]);
        let saved = store.save_extraction(&current).unwrap();
        let mut empty = data; empty["rows"] = json!([]);
        let zero = store.save_extraction(&empty).unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        // Updating the source also makes both saved extractions stale. That
        // state belongs to the UI, not to repeated rows in the business output.
        store.save_page(&doc.id, Page { metadata: Default::default(), page:1, text:"不得导出整篇正文".into(), original_text:"不得导出整篇正文".into(), tables:vec![], original_tables:vec![], revision:1,status:"needs_review".into(),warnings:vec!["方向待复核".into()] },1,true).unwrap();
        let mut params = json!({"projectId":project["id"],"documentIds":[doc.id],"outputDir":dir.path(),"mode":"single_sheet","extractionsOnly":true,"extractionIds":[saved["id"],zero["id"]]});
        for mode in ["single_sheet", "per_document", "individual", "combined"] {
        params["mode"] = json!(mode);
        let result = export(&store,&params,&|_,_,_,_|{},&pause).unwrap();
        let output = result["outputPaths"][0].as_str().unwrap();
        if mode != "individual" { assert!(Path::new(output).file_name().unwrap().to_string_lossy().starts_with("本次摘录_场景摘录_")); }
        let mut book = calamine::open_workbook_auto(output).unwrap();
        assert_eq!(book.sheet_names().len(),1);
        let range = book.worksheet_range(&book.sheet_names()[0]).unwrap();
        let text = range.rows().flat_map(|row| row.iter()).map(ToString::to_string).collect::<Vec<_>>().join("\n");
        for expected in ["合同.pdf","页码","不得超过65%","未发现符合场景事项","我的财务限制"] { assert!(text.contains(expected),"缺少 {expected}"); }
        for unwanted in ["尚未扫描页", "第1页待校对", "方向待复核", "不能认定", "已扫描", "摘录需要更新", "原文证据不应附上", "合同原文摘录"] { assert!(!text.contains(unwanted), "不应插入诊断或证据：{unwanted}"); }
        assert_eq!(result["partial"], true);
        assert!(!text.contains("不得导出整篇正文"));
        assert!(!text.contains("不得包含历史结果"));
        }
        let mut invalid = params; invalid["extractionIds"] = json!(["other-project-id"]);
        assert!(export(&store,&invalid,&|_,_,_,_|{},&pause).is_err());
        assert_eq!(store.project(project["id"].as_str().unwrap()).unwrap()["outputDirectory"],json!(dir.path().to_string_lossy()));
    }
    #[test]
    fn extraction_exports_keep_fixed_source_columns_in_every_mode() {
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"分块摘录"})).unwrap();
        let mut docs = vec![];
        let mut ids = vec![];
        let long = "业务😀".repeat(17000);
        for name in ["甲合同.pdf", "乙合同.pdf"] {
            let path = dir.path().join(name); fs::write(&path, b"synthetic").unwrap();
            let doc = store.import(project["id"].as_str().unwrap(), &path).unwrap();
            let saved = store.save_extraction(&json!({"documentId":doc.id,"sourceRevision":0,"scenarioId":"custom","prompts":[],
                "columns":[{"key":"sourceFile","label":"来源文件"},{"key":"sourcePage","label":"来源页码"},{"key":"amount","label":"金额"},{"key":"description","label":"业务摘要"},{"key":"evidence","label":"逐字证据"}],
                "rows":[{"sourceFile":"错误模型文件名.pdf","sourcePage":"2","amount":"00100","description":"同页第一项","evidence":"原文证据不可导出"},
                    {"pages":[3,4],"amount":"=1+1","description":long,"evidence":"原文证据不可导出"},
                    {"sourcePage":"2","amount":"00200","description":"同页第二项"},
                    {"amount":"00300","description":"未定位业务摘要","_trace":"不可导出"}]})).unwrap();
            ids.push(saved["id"].as_str().unwrap().to_owned()); docs.push(doc);
        }
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for mode in ["single_sheet", "per_document", "individual", "combined"] {
            for only in [true, false] {
                let result = export(&store,&json!({"projectId":project["id"],"documentIds":docs.iter().map(|d|&d.id).collect::<Vec<_>>(),"outputDir":dir.path(),"mode":mode,"extractionsOnly":only,"extractionIds":ids}),&|_,_,_,_|{},&pause).unwrap();
                let mut headers = 0;
                let mut entries = 0;
                let mut restored = String::new();
                for output in result["outputPaths"].as_array().unwrap() {
                    let mut book = calamine::open_workbook_auto(output.as_str().unwrap()).unwrap();
                    for name in book.sheet_names() {
                        if !only && (name == "目录" || name.ends_with("完整原文")) { continue; }
                        let range = book.worksheet_range(&name).unwrap();
                        let lines = range.rows().collect::<Vec<_>>();
                        for row in &lines {
                            if row.first() == Some(&Data::String("来源文件".into())) && row.get(2) == Some(&Data::String("业务摘要".into())) {
                                headers += 1;
                                assert_eq!(row[1], Data::String("页码".into()));
                                assert_eq!(row[3], Data::String("金额".into()));
                                continue;
                            }
                            if matches!(row.first(), Some(Data::String(s)) if s == "甲合同.pdf" || s == "乙合同.pdf") {
                                assert!(matches!(row.get(1), Some(Data::String(s)) if ["2", "3\n4", "具体出处待核对"].contains(&s.as_str())));
                                assert!(row[4] == Data::String("自定义摘录".into()) || row[4] == Data::Empty);
                            }
                            if row.get(3).is_some_and(|v| matches!(v, Data::String(s) if ["00100","00200","00300","=1+1"].contains(&s.as_str()))) { entries += 1; }
                            if let Some(Data::String(value)) = row.get(2) {
                                if !value.is_empty() && value.chars().all(|ch| "业务😀".contains(ch)) {
                                    assert!(matches!(row.first(), Some(Data::String(s)) if s == "甲合同.pdf" || s == "乙合同.pdf"));
                                    assert_eq!(row[1], Data::String("3\n4".into()));
                                    restored.push_str(value);
                                }
                            }
                            assert!(!row.iter().any(|v| matches!(v, Data::String(s) if s == "错误模型文件名.pdf" || s == "不可导出" || s == "逐字证据" || s == "原文证据不可导出")));
                        }
                    }
                }
                assert_eq!(headers, if only && mode == "single_sheet" { 1 } else { 2 }, "{mode}, only={only}");
                assert_eq!(entries, 8, "{mode}, only={only}");
                assert_eq!(restored, long.repeat(2));
            }
        }
    }
    #[test]
    fn original_tables_are_cells_in_source_order_with_fixed_provenance() {
        use crate::ocr_store::{Page, Table};
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"原位表格"})).unwrap();
        let path = dir.path().join("合同.pdf"); fs::write(&path, b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), &path).unwrap();
        store.prepare(&doc.id, 5).unwrap();
        let rows = vec![vec!["提款时间".into(),"提款金额".into()],vec!["/".into(),"/".into()],vec!["/".into(),"/".into()],vec!["/".into(),"/".into()]];
        let grid = rows.iter().map(|row| row.join("\t")).collect::<Vec<_>>().join("\n");
        store.save_page(&doc.id, Page {metadata:Default::default(),page:5,text:format!("第一段\n{grid}\n第二段\n{grid}\n第三段\n普通文字\t不推断为表格"),original_text:String::new(),revision:0,status:"completed".into(),warnings:vec![],original_tables:vec![],
            tables:vec![Table{id:"a".into(),title:String::new(),rows:rows.clone()},Table{id:"b".into(),title:String::new(),rows}]},0,true).unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for mode in ["single_sheet","per_document","combined","individual"] {
            let result = export(&store,&json!({"projectId":project["id"],"documentIds":[doc.id],"mode":mode,"outputDir":dir.path()}),&|_,_,_,_|{},&pause).unwrap();
            let mut book = calamine::open_workbook_auto(result["outputPaths"][0].as_str().unwrap()).unwrap();
            let sheet_name = if matches!(mode,"combined"|"individual") { "1_完整原文".to_owned() } else { book.sheet_names()[0].clone() };
            let range = book.worksheet_range(&sheet_name).unwrap();
            let lines=range.rows().collect::<Vec<_>>();
            assert_eq!(lines[0][0],Data::String("来源文件".into())); assert_eq!(lines[0][1],Data::String("页码".into()));
            for row in lines.iter().skip(1) {
                assert_eq!(row[0],Data::String("合同.pdf".into())); assert_eq!(row[1],Data::String("5".into()));
            }
            assert_eq!(lines.iter().filter(|row|row.get(2)==Some(&Data::String("提款时间".into()))).count(),2);
            assert_eq!(lines[2][2],Data::String("提款时间".into())); assert_eq!(lines[2][3],Data::String("提款金额".into()));
            assert_eq!(lines[3][2],Data::String("/".into())); assert_eq!(lines[3][3],Data::String("/".into()));
            assert_eq!(lines[6][2],Data::String("第二段".into()));
            assert!(lines.iter().any(|row|row.get(2)==Some(&Data::String("普通文字\t不推断为表格".into()))));
            assert!(!lines.iter().flat_map(|row| row.iter()).any(|cell|cell==&Data::String("提款时间\t提款金额".into())));
        }
    }
    #[test]
    fn source_hyperlinks_use_retained_files_without_changing_display_or_missing_file_exports() {
        use crate::ocr_store::Page;
        use std::io::{Cursor, Read};
        use calamine::{Data, Reader};
        let temporary = tempfile::tempdir().unwrap();
        let dir = temporary.path().join("原件 #100% 中文"); fs::create_dir(&dir).unwrap();
        let mut store = Store::open(&dir.join("db.sqlite")).unwrap();
        let project = store.save_project(&json!({"name":"原件链接"})).unwrap();
        let path = dir.join("合同原件.pdf"); fs::write(&path, b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), &path).unwrap();
        store.prepare(&doc.id, 1).unwrap();
        let long = "证据".repeat(18000);
        store.save_page(&doc.id,Page{metadata:Default::default(),page:1,text:long.clone(),original_text:String::new(),tables:vec![],original_tables:vec![],revision:0,status:"completed".into(),warnings:vec![]},0,true).unwrap();
        let extraction=store.save_extraction(&json!({"documentId":doc.id,"sourceRevision":1,"scenarioId":"custom","columns":[{"key":"description","label":"业务摘要"}],"rows":[{"sourcePage":"1","sourceFile":"https://model.invalid/","description":long}],"prompts":[]})).unwrap();
        let link = source_link(&store,&doc).unwrap().unwrap();
        assert_eq!(reqwest::Url::parse(&link).unwrap().to_file_path().unwrap(), store.source(&doc.id).unwrap());
        assert!(link.contains("%23") && link.contains("%25") && link.contains("%20"));
        assert!(reqwest::Url::parse(&link).unwrap().fragment().is_none());
        // Moving the original user-selected file leaves the retained scan link usable.
        fs::remove_file(&path).unwrap();
        let pause=PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for only in [false,true] {
            for mode in ["single_sheet","per_document","individual","combined"] {
                let result=export(&store,&json!({"projectId":project["id"],"documentIds":[doc.id],"outputDir":dir,"mode":mode,"extractionsOnly":only,"extractionIds":[extraction["id"]]}),&|_,_,_,_|{},&pause).unwrap();
                let output=result["outputPaths"][0].as_str().unwrap();
                let mut zip=zip::ZipArchive::new(Cursor::new(fs::read(output).unwrap())).unwrap();
                let mut relations=String::new(); let mut worksheets=String::new();
                for i in 0..zip.len() {
                    let mut file=zip.by_index(i).unwrap(); let name=file.name().to_owned();
                    if name.starts_with("xl/worksheets/") && name.ends_with(".rels") { file.read_to_string(&mut relations).unwrap(); }
                    else if name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml") { file.read_to_string(&mut worksheets).unwrap(); }
                }
                assert!(relations.contains("TargetMode=\"External\""));
                assert!(relations.contains("%23") && relations.contains("%25"));
                assert!(worksheets.contains("ref=\"A2\"") && worksheets.contains("ref=\"A3\""));
                assert!(!relations.contains("model.invalid"));
                let mut book=calamine::open_workbook_auto(output).unwrap();
                let range=book.worksheet_range(&book.sheet_names()[0]).unwrap();
                if mode!="combined" && mode!="individual" || only {
                    assert_eq!(range.get((1,0)),Some(&Data::String("合同原件.pdf".into())));
                }
            }
        }
        fs::remove_file(store.source(&doc.id).unwrap()).unwrap();
        assert!(source_link(&store,&doc).unwrap().is_none());
        let result=export(&store,&json!({"projectId":project["id"],"documentIds":[doc.id],"outputDir":dir,"mode":"per_document","extractionsOnly":true,"extractionIds":[extraction["id"]]}),&|_,_,_,_|{},&pause).unwrap();
        let mut zip=zip::ZipArchive::new(Cursor::new(fs::read(result["outputPaths"][0].as_str().unwrap()).unwrap())).unwrap();
        let mut xml=String::new(); zip.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(!xml.contains("<hyperlink "));
    }
    #[test]
    fn unicode_chunks_are_lossless_and_within_excel_limit() {
        let source = "😀长文本".repeat(10000);
        let parts = chunks(&source);
        assert_eq!(parts.concat(), source);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= 32000));
    }
    #[test]
    fn publish_never_overwrites_existing_workbook() {
        let dir = tempfile::tempdir().unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let first = publish(dir.path(), "合成", b"first", &pause).unwrap();
        let second = publish(dir.path(), "合成", b"second", &pause).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"first");
    }
    #[test]
    fn compatibility_publish_preserves_existing_and_removes_cancelled_target() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("compat.xlsx");
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        assert!(write_new_target(&output, b"complete", &pause).unwrap());
        assert!(!write_new_target(&output, b"overwrite", &pause).unwrap());
        assert_eq!(fs::read(&output).unwrap(), b"complete");
        let cancelled = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(true)));
        let interrupted = dir.path().join("cancelled.xlsx");
        assert!(write_new_target(&interrupted, b"partial", &cancelled).is_err());
        assert!(!interrupted.exists());
    }
    #[test]
    fn exported_grid_keeps_long_numbers_formulas_unicode_and_partial_status() {
        use crate::ocr_store::{Page, Table};
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"合成导出测试"})).unwrap();
        let source = dir.path().join("合成.pdf");
        fs::write(&source, b"synthetic").unwrap();
        let doc = store
            .import(project["id"].as_str().unwrap(), &source)
            .unwrap();
        store.prepare(&doc.id, 2).unwrap();
        let account = "00123456789012345678901234567890";
        let long = "😀扫描内容".repeat(9000);
        store
            .save_page(
                &doc.id,
                Page {
                    metadata: Default::default(),
                    page: 1,
                    text: long.clone(),
                    original_text: String::new(),
                    tables: vec![Table {
                        id: "t1".into(),
                        title: "单证".into(),
                        rows: vec![vec![
                            account.into(),
                            "=1+2".into(),
                            "1,234.00".into(),
                            long.clone(),
                        ]],
                    }],
                    original_tables: vec![],
                    revision: 0,
                    status: "completed".into(),
                    warnings: vec![],
                },
                0,
                true,
            )
            .unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let p = json!({"projectId":project["id"],"outputDir":dir.path(),"mode":"combined"});
        let result = export(&store, &p, &|_, _, _, _| {}, &pause).unwrap();
        assert_eq!(result["partial"], true);
        let output = Path::new(result["outputPaths"][0].as_str().unwrap());
        let mut workbook = calamine::open_workbook_auto(output).unwrap();
        let table = workbook.worksheet_range("1_第1页_表1").unwrap();
        assert_eq!(table.get((1, 2)), Some(&Data::String(account.into())));
        assert_eq!(table.get((1, 3)), Some(&Data::String("=1+2".into())));
        let restored = table
            .rows()
            .skip(1)
            .filter_map(|r| r.get(5))
            .map(|c| c.to_string())
            .collect::<String>();
        assert_eq!(restored, long);
        let text = workbook.worksheet_range("1_完整原文").unwrap();
        let restored = text
            .rows()
            .skip(1)
            .take(chunks(&long).len())
            .filter_map(|r| r.get(2))
            .map(|c| c.to_string())
            .collect::<String>();
        assert_eq!(restored, long);
        let directory = workbook.worksheet_range("目录").unwrap();
        assert!(!directory.rows().flatten().any(|c| c.to_string().contains("未完成页")));
    }
    #[test]
    fn selected_documents_support_single_sheet_per_document_and_individual_workbooks() {
        use crate::ocr_store::{Page, Table};
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"十二份扫描件"})).unwrap();
        let mut docs = Vec::new();
        let long = "长".repeat(70000);
        for index in 1..=12 {
            let source = dir.path().join(format!("单证{index}.pdf"));
            fs::write(&source, b"synthetic").unwrap();
            let doc = store
                .import(project["id"].as_str().unwrap(), &source)
                .unwrap();
            store
                .prepare(&doc.id, if index == 1 { 2 } else { 1 })
                .unwrap();
            store
                .save_page(
                    &doc.id,
                    Page {
                        page: 1,
                        text: if index == 1 {
                            long.clone()
                        } else {
                            format!("第{index}份专属正文，合同原文包含待校对字样")
                        },
                        original_text: String::new(),
                        revision: 0,
                        status: "needs_review".into(),
                        warnings: vec!["本页含未能安全还原的排版或公式标记，已保留原内容，请对照扫描件核对。".into()],
                        metadata: Default::default(),
                        tables: vec![Table {
                            id: "table".into(),
                            title: format!("表{index}"),
                            rows: vec![vec![
                                "00012345678901234567890".into(),
                                "=1+2".into(),
                                format!("来自{index}"),
                            ]],
                        }],
                        original_tables: vec![],
                    },
                    0,
                    true,
                )
                .unwrap();
            docs.push(doc);
        }
        store.save_extraction(&json!({"documentId":docs[0].id,"sourceRevision":1,"scenarioId":"custom","columns":[{"key":"amount","label":"金额"}],"rows":[{"amount":"00100","auditor_summary":"履约情况需结合回单复核","_trace":"不可导出内部字段"}],"prompts":[{"id":"x","label":"内部","prompt":"不可导出提示词"}]})).unwrap();
        let selected = vec![docs[0].id.clone(), docs[11].id.clone()];
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for mode in ["single_sheet", "per_document", "individual", "combined"] {
            let result = export(&store, &json!({"projectId":project["id"],"documentIds":selected,"mode":mode,"outputDir":dir.path()}), &|_,_,_,_|{}, &pause).unwrap();
            assert_eq!(result["documentCount"], 2);
            assert_eq!(result["partial"], true);
            let outputs = result["outputPaths"].as_array().unwrap();
            assert_eq!(outputs.len(), if mode == "individual" { 2 } else { 1 });
            let mut all = String::new();
            for output in outputs {
                let mut book = calamine::open_workbook_auto(output.as_str().unwrap()).unwrap();
                let names = book.sheet_names();
                if mode == "single_sheet" {
                    assert_eq!(names.len(), 1);
                }
                if mode == "per_document" {
                    assert_eq!(names.len(), 2);
                }
                let mut literal_formula = false;
                let mut identifier = false;
                let mut restored_long = String::new();
                for name in names {
                    let range = book.worksheet_range(&name).unwrap();
                    for cells in range.rows() {
                        for cell in cells {
                            if cell == &Data::String("=1+2".into()) {
                                literal_formula = true;
                            }
                            if cell == &Data::String("00012345678901234567890".into()) {
                                identifier = true;
                            }
                            let text = cell.to_string();
                            if mode != "individual"
                                && text.starts_with('长')
                                && text.chars().all(|ch| ch == '长')
                            {
                                restored_long.push_str(&text);
                            }
                            all.push_str(&text);
                            all.push('\n');
                        }
                    }
                }
                assert!(literal_formula && identifier);
                if mode != "individual" {
                    assert_eq!(restored_long, long);
                }
            }
            assert!(all.contains("第12份专属正文"));
            assert!(all.contains("合同原文包含待校对字样"));
            assert!(!all.contains("第2份专属正文"));
            assert!(all.contains("00100"));
            assert!(all.contains("履约情况需结合回单复核"));
            assert!(!all.contains("不可导出"));
            for unwanted in ["未完成页：2", "尚未扫描", "待校对：", "本页含未能安全还原", "摘录需要更新", "本页另有"] {
                assert!(!all.contains(unwanted), "{mode} 不应插入技术状态：{unwanted}");
            }
        }
        assert!(export(&store, &json!({"projectId":project["id"],"documentIds":[],"mode":"single_sheet","outputDir":dir.path()}), &|_,_,_,_|{}, &pause).is_err());
        let other = store.save_project(&json!({"name":"其他项目"})).unwrap();
        assert!(export(&store, &json!({"projectId":other["id"],"documentIds":selected,"mode":"single_sheet","outputDir":dir.path()}), &|_,_,_,_|{}, &pause).is_err());
    }
    #[test]
    fn extraction_workbook_has_readable_values_without_internal_trace_or_prompts() {
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"摘录排版"})).unwrap();
        let source = dir.path().join("合同.pdf");
        fs::write(&source, b"synthetic").unwrap();
        let doc = store
            .import(project["id"].as_str().unwrap(), &source)
            .unwrap();
        store.save_extraction(&json!({
            "documentId":doc.id,"sourceRevision":doc.revision,"scenarioId":"loan_general",
            "scenarioVersion":"technical-version-do-not-export",
            "prompts":[{"id":"extract","label":"内部提示词","prompt":"technical-prompt-do-not-export"}],
            "columns":[
                {"key":"amount","label":"借款金额"},
                {"key":"repayment","label":"还款安排"},
                {"key":"title","label":"title"},
                {"key":"clause_ref","label":"clause_ref"},
                {"key":"covenant_scope","label":"covenant_scope"},
                {"key":"source_documents","label":"source_documents"},
                {"key":"pages","label":"pages"},
                {"key":"_covenant_evidence","label":"内部证据"}
            ],
            "rows":[{
                "amount":"00123456789012345678901234567890",
                "repayment":[{"date":r"\(\underline{\text{2026-10-27}}\)","amount":r"\(\underline{\text{100.00}}\)"},{"date":"2027-10-27","amount":"200.00"}],
                "interest":"{\"rate\":\"3.2%\",\"frequency\":\"每年\"}",
                "_covenant_evidence":[{"quote":"technical-trace-do-not-export","bbox":[1,2,3,4]}],
                "_covenant_review_reason":"利率调整日待核对",
                "source_document_id":"technical-document-id-do-not-export",
                "evidence_quotes":[r"\(\underline{\text{第一段逐字证据}}\)","第二段逐字证据"],
                "literal":"=1+1",
                "formula":r"\(\frac{a}{b}\)",
                "title":"独立投资限额",
                "clause_ref":"第二十条",
                "covenant_scope":"repayment",
                "covenant_category_id":"C03",
                "contract_classification":"财务指标契约",
                "is_financial":true,
                "source_documents":"合同.pdf",
                "pages":"重复页码不可导出",
                "sourcePage":"1、2"
            }]
        })).unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let bytes = build(&store, &[doc], &pause).unwrap();
        let output = dir.path().join("readable.xlsx");
        fs::write(&output, bytes).unwrap();
        let mut workbook = calamine::open_workbook_auto(output).unwrap();
        let result = workbook.worksheet_range("1_摘录_借款合同主表").unwrap();
        let all = result
            .rows()
            .flatten()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        for expected in [
            "日期：2026-10-27",
            "金额：100.00",
            "日期：2027-10-27",
            "金额：200.00",
            "利率：3.2%",
            "频率：每年",
        ] {
            assert!(all.contains(expected), "missing {expected}");
        }
        assert!(all.contains("复核提示"));
        assert!(all.contains("利率调整日待核对"));
        assert!(!all.contains("第一段逐字证据"));
        assert!(!all.contains("第二段逐字证据"));
        assert!(!all.contains(r"\underline"));
        assert!(!all.contains(r"\text{"));
        assert!(result.rows().flatten().any(|cell| cell == &Data::String("=1+1".into())));
        assert!(all.contains(r"\frac{a}{b}"));
        assert!(all.contains("页码"));
        assert!(all.contains("事项"));
        assert!(all.contains("条款位置"));
        assert!(all.contains("独立投资限额"));
        assert!(all.contains("第二十条"));
        for hidden in ["covenant_category_id", "covenant_scope", "contract_classification", "is_financial", "source_documents", "pages", "C03", "repayment", "重复页码不可导出"] { assert!(!all.contains(hidden), "不应出现内部字段 {hidden}"); }
        assert!(!all.contains("technical-"));
        assert!(!all.contains("_covenant"));
        assert!(!all.contains("实际使用的提示词"));
        assert!(!all.contains("场景规则版本"));
        assert!(!all.contains("{\""));
        assert!(result.rows().flatten().any(|cell| cell == &Data::String("00123456789012345678901234567890".into())));
        assert_eq!(
            value_text(&json!({"condition":{"value":"=1+1","enabled":true}})),
            "条件：enabled：是\n内容：=1+1"
        );
    }
}
