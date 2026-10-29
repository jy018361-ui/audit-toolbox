//! Text-only XLSX output: no inferred numeric coercion, truncation or overwrite.
//! Recognition/extraction sheets contain source content, not per-page pipeline
//! warnings. Those remain in the store/UI and in the export's `partial` result.
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
fn visible_field(key: &str) -> bool {
    !key.starts_with('_') && !matches!(key,
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

/// Use the same source-page blocks as recognized text. Cross-page evidence is
/// one verified record with its complete page label, never copied per page.
fn extraction_blocks(
    s: &mut Worksheet,
    r: &mut u32,
    doc: &Document,
    extraction: &Value,
    scenario: &str,
    pause: &PauseCheckpoint,
) -> Result<(), AppError> {
    let rows: Vec<Value> = extraction["rows"].as_array().into_iter().flatten()
        .map(readable_extraction_row).collect();
    section_row(s, r, &["场景摘录".into(), scenario.into(), "摘录结果".into()])?;
    if rows.is_empty() {
        row(s, r, &["未发现符合场景事项".into()])?;
        return Ok(());
    }
    let mut columns = extraction_columns(extraction, false);
    let mut seen: BTreeSet<String> = columns.iter().map(|column| column.0.clone()).collect();
    for data in &rows {
        if let Some(object) = data.as_object() {
            for key in object.keys().filter(|key| visible_field(key)) {
                if seen.insert(key.clone()) { columns.push((key.clone(), field_label(key).into())); }
            }
        }
    }
    columns.retain(|(key, _)| !matches!(canonical_field(key), "sourceFile" | "sourcePage"));
    let mut groups: Vec<(String, Vec<&Value>)> = vec![];
    for data in &rows {
        let page = value_text(&data["sourcePage"]);
        let page = if page.trim().is_empty() { "具体出处待核对".into() } else { page };
        if let Some((_, group)) = groups.iter_mut().find(|(label, _)| label == &page) { group.push(data); }
        else { groups.push((page, vec![data])); }
    }
    for (page, entries) in groups {
        pause.wait()?;
        section_row(s, r, &["来源文件".into(), doc.name.clone(), "来源页码".into(), page, "场景摘录".into()])?;
        row(s, r, &columns.iter().map(|(_, label)| label.clone()).collect::<Vec<_>>())?;
        for data in entries {
            pause.wait()?;
            row(s, r, &columns.iter().map(|(key, _)| value_text(&data[key])).collect::<Vec<_>>())?;
        }
        row(s, r, &[])?;
    }
    for column in 0..columns.len().min(16384) {
        s.set_column_width(column as u16, 45).map_err(xlsx_error)?;
        s.set_column_format(column as u16, &Format::new().set_text_wrap().set_num_format("@")).map_err(xlsx_error)?;
    }
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
        ],
    )?;
    let pages = store.pages(&doc.id)?;
    for page in &pages {
        pause.wait()?;
        let number = page.page;
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
        extraction_blocks(s, r, doc, &extraction,
            scenario_label(extraction["scenarioId"].as_str().unwrap_or("")), pause)?;
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
            extraction_blocks(s, &mut r, doc, &extraction, scenario, pause)?;
            entries.push(vec![
                doc.name.clone(),
                String::new(),
                "摘录".into(),
                extract_name,
            ]);
        }
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
        section_row(target, &mut r, &["来源文件".into(), doc.name.clone()])?;
        let project = store.project(&doc.project_id)?;
        for extraction in extractions {
            found.insert(extraction["id"].as_str().unwrap_or("").to_owned());
            let scenario_id = extraction["scenarioId"].as_str().unwrap_or("");
            let scenario_name = project["customScenarios"].as_array().into_iter().flatten()
                .find(|entry| entry["id"] == scenario_id).and_then(|entry| entry["name"].as_str()).unwrap_or_else(|| scenario_label(scenario_id));
            extraction_blocks(target, &mut r, doc, &extraction, scenario_name, pause)?;
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
        for expected in ["合同.pdf","来源页码","不得超过65%","未发现符合场景事项","我的财务限制"] { assert!(text.contains(expected),"缺少 {expected}"); }
        for unwanted in ["尚未扫描页", "第1页待校对", "方向待复核", "不能认定", "已扫描", "摘录需要更新"] { assert!(!text.contains(unwanted), "不应插入诊断：{unwanted}"); }
        assert_eq!(result["partial"], true);
        assert!(!text.contains("不得导出整篇正文"));
        assert!(!text.contains("不得包含历史结果"));
        }
        let mut invalid = params; invalid["extractionIds"] = json!(["other-project-id"]);
        assert!(export(&store,&invalid,&|_,_,_,_|{},&pause).is_err());
        assert_eq!(store.project(project["id"].as_str().unwrap()).unwrap()["outputDirectory"],json!(dir.path().to_string_lossy()));
    }
    #[test]
    fn extraction_exports_stack_source_page_blocks_in_every_mode() {
        use calamine::{Data, Reader};
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"分块摘录"})).unwrap();
        let mut docs = vec![];
        let mut ids = vec![];
        let long = "证据😀".repeat(17000);
        for name in ["甲合同.pdf", "乙合同.pdf"] {
            let path = dir.path().join(name); fs::write(&path, b"synthetic").unwrap();
            let doc = store.import(project["id"].as_str().unwrap(), &path).unwrap();
            let saved = store.save_extraction(&json!({"documentId":doc.id,"sourceRevision":0,"scenarioId":"custom","prompts":[],
                "columns":[{"key":"sourceFile","label":"来源文件"},{"key":"sourcePage","label":"来源页码"},{"key":"amount","label":"金额"},{"key":"evidence","label":"逐字证据"}],
                "rows":[{"sourceFile":"错误模型文件名.pdf","sourcePage":"2","amount":"00100","evidence":"同页第一项"},
                    {"pages":[3,4],"amount":"=1+1","evidence":long},
                    {"sourcePage":"2","amount":"00200","evidence":"同页第二项"},
                    {"amount":"00300","evidence":"未定位证据","_trace":"不可导出"}]})).unwrap();
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
                        for (i, row) in lines.iter().enumerate() {
                            if row.first() == Some(&Data::String("来源文件".into())) && row.get(2) == Some(&Data::String("来源页码".into())) {
                                headers += 1;
                                assert!(matches!(row.get(1), Some(Data::String(s)) if s == "甲合同.pdf" || s == "乙合同.pdf"));
                                assert!(matches!(row.get(3), Some(Data::String(s)) if ["2", "3\n4", "具体出处待核对"].contains(&s.as_str())));
                                assert_eq!(lines[i+1][0], Data::String("金额".into()));
                                assert!(!lines[i+1].iter().any(|v| matches!(v, Data::String(s) if s == "来源文件" || s == "来源页码")));
                            }
                            if row.first().is_some_and(|v| matches!(v, Data::String(s) if ["00100","00200","00300","=1+1"].contains(&s.as_str()))) { entries += 1; }
                            if let Some(Data::String(value)) = row.get(1) { if !value.is_empty() && value.chars().all(|ch| "证据😀".contains(ch)) { restored.push_str(value); } }
                            assert!(!row.iter().any(|v| matches!(v, Data::String(s) if s == "错误模型文件名.pdf" || s == "不可导出")));
                        }
                    }
                }
                assert_eq!(headers, 6, "{mode}, only={only}");
                assert_eq!(entries, 8, "{mode}, only={only}");
                assert_eq!(restored, long.repeat(2));
            }
        }
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
        assert!(all.contains("第一段逐字证据\n第二段逐字证据"));
        assert!(!all.contains(r"\underline"));
        assert!(!all.contains(r"\text{"));
        assert!(result.rows().flatten().any(|cell| cell == &Data::String("=1+1".into())));
        assert!(all.contains(r"\frac{a}{b}"));
        assert!(all.contains("来源页码"));
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
