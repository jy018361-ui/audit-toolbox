//! Text-only XLSX output: no inferred numeric coercion, truncation or overwrite.
use crate::{
    AppError,
    excel_merger::PauseCheckpoint,
    ocr_store::{Document, Store, failure, io_error},
};
use rust_xlsxwriter::{Format, Workbook, Worksheet};
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
    s.set_column_width(0, 24).map_err(xlsx_error)?;
    s.set_column_width(1, 60).map_err(xlsx_error)?;
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
            s.clone()
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
fn visible_field(key: &str) -> bool {
    !key.starts_with('_') && !matches!(key, "source_document_id" | "evidence_quotes")
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
    // Keep the actionable review reason, while hiding pipeline traces, raw model
    // links and internal document identifiers from the user's workbook.
    if let Some(reason) = row.get("_covenant_review_reason").cloned()
        && !value_text(&reason).trim().is_empty()
    {
        row.insert("review_note".into(), reason);
    }
    if !["evidence", "excerpt", "contract_excerpt", "source_excerpt"]
        .iter()
        .any(|key| {
            row.get(*key)
                .is_some_and(|v| !value_text(v).trim().is_empty())
        })
        && let Some(quotes) = row.get("evidence_quotes").cloned()
    {
        row.insert("evidence".into(), quotes);
    }
    row.retain(|key, _| visible_field(key));
    Value::Object(row)
}
fn status_label(status: &str) -> &str {
    match status {
        "pending" => "未识别",
        "partial" => "部分完成",
        "needs_review" => "待校对",
        "completed" => "已完成",
        _ => "状态待确认",
    }
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

/// Keep unlike table schemas in separate blocks. All content is written as
/// strings, including long identifiers and text starting with an Excel formula.
fn document_blocks(
    store: &Store,
    doc: &Document,
    s: &mut Worksheet,
    r: &mut u32,
    pause: &PauseCheckpoint,
) -> Result<(), AppError> {
    pause.wait()?;
    section_row(
        s,
        r,
        &[
            "来源文件".into(),
            doc.name.clone(),
            "状态".into(),
            status_label(&doc.status).into(),
        ],
    )?;
    let pages = store.pages(&doc.id)?;
    let total = doc
        .total_pages
        .max(pages.iter().map(|page| page.page).max().unwrap_or(0));
    if total == 0 {
        row(s, r, &["页数待准备，尚未扫描".into()])?;
    }
    for number in 1..=total {
        pause.wait()?;
        let Some(page) = pages.iter().find(|page| page.page == number) else {
            section_row(
                s,
                r,
                &[
                    "来源文件".into(),
                    doc.name.clone(),
                    "来源页码".into(),
                    number.to_string(),
                    "尚未扫描".into(),
                ],
            )?;
            continue;
        };
        section_row(
            s,
            r,
            &[
                "来源文件".into(),
                doc.name.clone(),
                "来源页码".into(),
                number.to_string(),
                "完整原文".into(),
            ],
        )?;
        for text in page.text.split('\n') {
            pause.wait()?;
            row(s, r, &[text.into()])?;
        }
        for warning in &page.warnings {
            row(s, r, &[format!("待校对：{warning}")])?;
        }
        for (index, table) in page.tables.iter().enumerate() {
            pause.wait()?;
            section_row(
                s,
                r,
                &[
                    "表格".into(),
                    if table.title.is_empty() {
                        format!("表格 {}", index + 1)
                    } else {
                        table.title.clone()
                    },
                    "来源页码".into(),
                    number.to_string(),
                ],
            )?;
            let columns = table.rows.iter().map(Vec::len).max().unwrap_or(0);
            if columns > 16384 {
                return Err(failure(
                    "OCR_EXPORT_COLUMNS",
                    "表格超过 Excel 列数限制，请拆分表格后导出。",
                ));
            }
            for column in 0..columns {
                s.set_column_width(column as u16, 26).map_err(xlsx_error)?;
                s.set_column_format(
                    column as u16,
                    &Format::new().set_text_wrap().set_num_format("@"),
                )
                .map_err(xlsx_error)?;
            }
            for cells in &table.rows {
                pause.wait()?;
                row(s, r, cells)?;
            }
            row(s, r, &[])?;
        }
    }
    for extraction in store.extractions(&doc.id)? {
        pause.wait()?;
        section_row(
            s,
            r,
            &[
                "场景摘录".into(),
                scenario_label(extraction["scenarioId"].as_str().unwrap_or("")).into(),
                if extraction["stale"] == true {
                    "原文已修改，摘录需要更新".into()
                } else {
                    "摘录结果".into()
                },
            ],
        )?;
        let rows: Vec<Value> = extraction["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(readable_extraction_row)
            .collect();
        let mut columns: Vec<(String, String)> = extraction["columns"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|column| {
                let key = column["key"].as_str()?;
                if !visible_field(key) {
                    return None;
                }
                let label = column["label"].as_str().unwrap_or(key);
                Some((
                    key.into(),
                    if label == key {
                        field_label(key)
                    } else {
                        label
                    }
                    .into(),
                ))
            })
            .collect();
        let mut seen: BTreeSet<String> = columns.iter().map(|column| column.0.clone()).collect();
        for data in &rows {
            if let Some(object) = data.as_object() {
                for key in object.keys() {
                    if seen.insert(key.clone()) {
                        columns.push((key.clone(), field_label(key).into()));
                    }
                }
            }
        }
        row(
            s,
            r,
            &columns
                .iter()
                .map(|column| column.1.clone())
                .collect::<Vec<_>>(),
        )?;
        for data in rows {
            pause.wait()?;
            row(
                s,
                r,
                &columns
                    .iter()
                    .map(|(key, _)| value_text(&data[key]))
                    .collect::<Vec<_>>(),
            )?;
        }
    }
    row(s, r, &[])?;
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
    for (dindex, doc) in docs.iter().enumerate() {
        pause.wait()?;
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
        for page in &pages {
            pause.wait()?;
            for text in page.text.split('\n') {
                for chunk in chunks(text) {
                    row(s, &mut r, &[doc.name.clone(), page.page.to_string(), chunk])?;
                }
            }
            if !page.tables.is_empty() {
                row(
                    s,
                    &mut r,
                    &[
                        doc.name.clone(),
                        page.page.to_string(),
                        format!(
                            "本页另有 {} 张表格，请查看目录中对应的表格工作表。",
                            page.tables.len()
                        ),
                    ],
                )?;
            }
            for warning in &page.warnings {
                row(
                    s,
                    &mut r,
                    &[
                        doc.name.clone(),
                        page.page.to_string(),
                        format!("待校对：{warning}"),
                    ],
                )?;
            }
        }
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
                let columns = table.rows.iter().map(Vec::len).max().unwrap_or(1);
                for column in 0..columns.min(16384) {
                    s.set_column_width(column as u16, 26).map_err(xlsx_error)?;
                    s.set_column_format(
                        column as u16,
                        &Format::new().set_text_wrap().set_num_format("@"),
                    )
                    .map_err(xlsx_error)?;
                }
                row(
                    s,
                    &mut r,
                    &[
                        "来源文件".into(),
                        doc.name.clone(),
                        "来源页码".into(),
                        page.page.to_string(),
                        table.title.clone(),
                    ],
                )?;
                for cells in &table.rows {
                    row(s, &mut r, cells)?;
                }
                entries.push(vec![
                    doc.name.clone(),
                    status_label(&doc.status).into(),
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
            row(
                s,
                &mut r,
                &[
                    "来源文件".into(),
                    doc.name.clone(),
                    if extraction["stale"] == true {
                        "原文已修改，摘录需要更新".into()
                    } else {
                        "摘录结果".into()
                    },
                ],
            )?;
            let rows: Vec<Value> = extraction["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(readable_extraction_row)
                .collect();
            let mut columns: Vec<(String, String)> = extraction["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| {
                    let key = v["key"].as_str()?;
                    if !visible_field(key) {
                        return None;
                    }
                    let label = v["label"].as_str().unwrap_or(key);
                    Some((
                        key.into(),
                        if label == key {
                            field_label(key)
                        } else {
                            label
                        }
                        .into(),
                    ))
                })
                .collect();
            let mut seen: BTreeSet<String> = columns.iter().map(|v| v.0.clone()).collect();
            for data in &rows {
                if let Some(object) = data.as_object() {
                    for key in object.keys() {
                        if seen.insert(key.clone()) {
                            columns.push((key.clone(), field_label(key).into()));
                        }
                    }
                }
            }
            row(
                s,
                &mut r,
                &columns.iter().map(|v| v.1.clone()).collect::<Vec<_>>(),
            )?;
            for column in 0..columns.len().min(16384) {
                s.set_column_width(column as u16, 32).map_err(xlsx_error)?;
                s.set_column_format(
                    column as u16,
                    &Format::new().set_text_wrap().set_num_format("@"),
                )
                .map_err(xlsx_error)?;
            }
            for data in rows {
                row(
                    s,
                    &mut r,
                    &columns
                        .iter()
                        .map(|(key, _)| value_text(&data[key]))
                        .collect::<Vec<_>>(),
                )?;
            }
            entries.push(vec![
                doc.name.clone(),
                if extraction["stale"] == true {
                    "需要更新".into()
                } else {
                    "已摘录".into()
                },
                String::new(),
                "摘录".into(),
                extract_name,
            ]);
        }
        let completed: BTreeSet<u32> = pages.iter().map(|p| p.page).collect();
        let missing = (1..=doc.total_pages)
            .filter(|p| !completed.contains(p))
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join("、");
        entries.push(vec![
            doc.name.clone(),
            status_label(&doc.status).into(),
            if doc.total_pages == 0 {
                "页数待准备".into()
            } else if missing.is_empty() {
                format!("共 {} 页", doc.total_pages)
            } else {
                format!("未完成页：{missing}")
            },
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
            "状态".into(),
            "页码/未完成部分".into(),
            "内容类型".into(),
            "工作表".into(),
        ],
    )?;
    for item in entries {
        row(s, &mut r, &item)?;
    }
    s.set_column_width(0, 36).map_err(xlsx_error)?;
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
        let pages = store.pages(&doc.id)?;
        let completed: BTreeSet<u32> = pages.iter().map(|page| page.page).collect();
        let missing = (1..=doc.total_pages).filter(|page| !completed.contains(page)).map(|page| page.to_string()).collect::<Vec<_>>().join("、");
        section_row(target, &mut r, &["来源文件".into(), doc.name.clone()])?;
        row(target, &mut r, &[if doc.total_pages == 0 { "页数尚未确认，不能认定已完整检查".into() }
            else if !missing.is_empty() { format!("已扫描 {} / {} 页；尚未扫描页：{missing}，摘录仅基于已扫描内容", pages.len(), doc.total_pages) }
            else { format!("已扫描 {} / {} 页", pages.len(), doc.total_pages) }])?;
        for page in &pages {
            if page.status == "needs_review" || !page.warnings.is_empty() || !page.text.chars().any(char::is_alphanumeric) {
                row(target, &mut r, &[format!("第{}页待校对，不能认定原扫描内容完整识别", page.page)])?;
                for warning in &page.warnings { row(target, &mut r, &[format!("第{}页：{warning}",page.page)])?; }
            }
        }
        let project = store.project(&doc.project_id)?;
        for extraction in extractions {
            found.insert(extraction["id"].as_str().unwrap_or("").to_owned());
            let scenario_id = extraction["scenarioId"].as_str().unwrap_or("");
            let scenario_name = project["customScenarios"].as_array().into_iter().flatten()
                .find(|entry| entry["id"] == scenario_id).and_then(|entry| entry["name"].as_str()).unwrap_or_else(|| scenario_label(scenario_id));
            section_row(target, &mut r, &["场景摘录".into(), scenario_name.into(),
                if extraction["stale"] == true { "原文已修改，摘录需要更新".into() } else { "本次摘录结果".into() }])?;
            let rows: Vec<Value> = extraction["rows"].as_array().into_iter().flatten().map(readable_extraction_row).collect();
            if rows.is_empty() {
                row(target, &mut r, &["未发现符合场景事项".into(), "仅代表上述已扫描范围的摘录结果".into()])?;
                continue;
            }
            let mut columns = vec![("sourceFile".to_string(), "来源文件".to_string())];
            for column in extraction["columns"].as_array().into_iter().flatten() {
                if let Some(key) = column["key"].as_str().filter(|key| visible_field(key) && *key != "sourceFile") {
                    columns.push((key.into(), column["label"].as_str().unwrap_or_else(|| field_label(key)).into()));
                }
            }
            let mut seen: BTreeSet<String> = columns.iter().map(|column| column.0.clone()).collect();
            for data in &rows {
                if let Some(object) = data.as_object() {
                    for key in object.keys().filter(|key| visible_field(key)) {
                        if seen.insert(key.clone()) { columns.push((key.clone(), field_label(key).into())); }
                    }
                }
            }
            if !seen.contains("sourcePage") { columns.push(("sourcePage".into(), "来源页码".into())); }
            row(target, &mut r, &columns.iter().map(|column| column.1.clone()).collect::<Vec<_>>())?;
            for data in rows {
                pause.wait()?;
                row(target, &mut r, &columns.iter().map(|(key, _)| if key == "sourceFile" { doc.name.clone() }
                    else if key == "sourcePage" && data[key].is_null() { "具体出处待核对".into() }
                    else { value_text(&data[key]) }).collect::<Vec<_>>())?;
            }
            for column in 0..columns.len().min(16384) {
                target.set_column_width(column as u16, if column == 0 { 36 } else { 45 }).map_err(xlsx_error)?;
                target.set_column_format(column as u16, &Format::new().set_text_wrap().set_num_format("@")).map_err(xlsx_error)?;
            }
        }
        row(target, &mut r, &[])?;
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
        let data = json!({"documentId":doc.id,"sourceRevision":1,"scenarioId":"saved-covenant","columns":[{"key":"excerpt","label":"合同原文摘录"},{"key":"sourcePage","label":"来源页码"}],"prompts":[]});
        let mut historical = data.clone(); historical["rows"] = json!([{"excerpt":"不得包含历史结果"}]);
        store.save_extraction(&historical).unwrap();
        let mut current = data.clone(); current["rows"] = json!([{"excerpt":"借款人负债率不得超过65%","sourcePage":"1"}]);
        let saved = store.save_extraction(&current).unwrap();
        let mut empty = data; empty["rows"] = json!([]);
        let zero = store.save_extraction(&empty).unwrap();
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let params = json!({"projectId":project["id"],"documentIds":[doc.id],"outputDir":dir.path(),"mode":"single_sheet","extractionsOnly":true,"extractionIds":[saved["id"],zero["id"]]});
        let result = export(&store,&params,&|_,_,_,_|{},&pause).unwrap();
        let output = result["outputPaths"][0].as_str().unwrap();
        assert!(Path::new(output).file_name().unwrap().to_string_lossy().starts_with("本次摘录_场景摘录_"));
        let mut book = calamine::open_workbook_auto(output).unwrap();
        assert_eq!(book.sheet_names().len(),1);
        let range = book.worksheet_range("场景摘录").unwrap();
        let text = range.rows().flat_map(|row| row.iter()).map(ToString::to_string).collect::<Vec<_>>().join("\n");
        for expected in ["合同.pdf","来源页码","不得超过65%","未发现符合场景事项","尚未扫描页：2","第1页待校对","方向待复核","我的财务限制"] { assert!(text.contains(expected),"缺少 {expected}"); }
        assert!(!text.contains("不得导出整篇正文"));
        assert!(!text.contains("不得包含历史结果"));
        let mut invalid = params; invalid["extractionIds"] = json!(["other-project-id"]);
        assert!(export(&store,&invalid,&|_,_,_,_|{},&pause).is_err());
        assert_eq!(store.project(project["id"].as_str().unwrap()).unwrap()["outputDirectory"],json!(dir.path().to_string_lossy()));
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
        assert_eq!(table.get((1, 0)), Some(&Data::String(account.into())));
        assert_eq!(table.get((1, 1)), Some(&Data::String("=1+2".into())));
        let restored = table
            .rows()
            .skip(1)
            .filter_map(|r| r.get(3))
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
        assert!(
            directory
                .rows()
                .flatten()
                .any(|c| c.to_string().contains("未完成页：2"))
        );
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
                            format!("第{index}份专属正文")
                        },
                        original_text: String::new(),
                        revision: 0,
                        status: "completed".into(),
                        warnings: vec![],
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
        store.save_extraction(&json!({"documentId":docs[0].id,"sourceRevision":1,"scenarioId":"custom","columns":[{"key":"amount","label":"金额"}],"rows":[{"amount":"00100","_trace":"不可导出内部字段"}],"prompts":[{"id":"x","label":"内部","prompt":"不可导出提示词"}]})).unwrap();
        let selected = vec![docs[0].id.clone(), docs[11].id.clone()];
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        for mode in ["single_sheet", "per_document", "individual"] {
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
            assert!(!all.contains("第2份专属正文"));
            assert!(all.contains("00100"));
            assert!(!all.contains("不可导出"));
            assert!(all.contains("未完成页：2") || all.contains("尚未扫描"));
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
                {"key":"_covenant_evidence","label":"内部证据"}
            ],
            "rows":[{
                "amount":"00123456789012345678901234567890",
                "repayment":[{"date":"2026-10-27","amount":"100.00"},{"date":"2027-10-27","amount":"200.00"}],
                "interest":"{\"rate\":\"3.2%\",\"frequency\":\"每年\"}",
                "_covenant_evidence":[{"quote":"technical-trace-do-not-export","bbox":[1,2,3,4]}],
                "_covenant_review_reason":"利率调整日待核对",
                "source_document_id":"technical-document-id-do-not-export",
                "evidence_quotes":["第一段逐字证据","第二段逐字证据"],
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
        assert!(all.contains("第一段逐字证据\n第二段逐字证据"));
        assert!(all.contains("来源页码"));
        assert!(!all.contains("technical-"));
        assert!(!all.contains("_covenant"));
        assert!(!all.contains("实际使用的提示词"));
        assert!(!all.contains("场景规则版本"));
        assert!(!all.contains("{\""));
        assert_eq!(
            result.get((2, 0)),
            Some(&Data::String("00123456789012345678901234567890".into()))
        );
        assert_eq!(
            value_text(&json!({"condition":{"value":"=1+1","enabled":true}})),
            "条件：enabled：是\n内容：=1+1"
        );
    }
}
