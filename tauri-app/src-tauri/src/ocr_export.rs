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
        "covenant_category" => "财务契约类型",
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
        "loan_covenant" => "借款限制性契约",
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
    let combined = match p["mode"].as_str() {
        Some("combined") => true,
        Some("individual") => false,
        _ => return Err(failure("OCR_EXPORT_MODE", "请选择按文件或项目合并导出。")),
    };
    let mut outputs = vec![];
    if combined {
        progress("export", 0, 1, "正在生成项目 Excel");
        let bytes = build(store, &docs, pause)?;
        outputs.push(publish(
            dir,
            &format!("{}_OCR", project_data["name"].as_str().unwrap_or("项目")),
            &bytes,
            pause,
        )?);
    } else {
        for (index, doc) in docs.iter().enumerate() {
            pause.wait()?;
            progress("export", index, docs.len(), "正在生成文件 Excel");
            let bytes = build(store, std::slice::from_ref(doc), pause)?;
            let stem = Path::new(&doc.name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            outputs.push(publish(dir, &format!("{stem}_OCR"), &bytes, pause)?);
        }
    }
    progress("export", docs.len(), docs.len(), "Excel 导出完成");
    Ok(
        json!({"outputPaths":outputs.iter().map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>(),"documentCount":docs.len(),"partial":docs.iter().any(|d|d.status!="completed")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicBool};
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
