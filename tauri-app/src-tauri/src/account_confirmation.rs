//! Four audit tools share one round-trip subject confirmation workbook.
//! The hidden key travels with its row when users sort the sheet.
use std::{collections::HashSet, path::Path};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use calamine::{Reader, open_workbook_auto};
use rust_xlsxwriter::{Color, DataValidation, Format, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::AppError;

const SHEET: &str = "科目确认";
const META: &str = "模板信息";
const VERSION: &str = "1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Column {
    key: String,
    title: String,
    #[serde(default)]
    editable: bool,
    #[serde(default)]
    options: Vec<String>,
}

#[derive(Deserialize)]
struct Row {
    key: String,
    values: Vec<String>,
    #[serde(default)]
    editable: Vec<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    tool: String,
    context: String,
    columns: Vec<Column>,
    rows: Vec<Row>,
    output_path: String,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("CONFIRMATION_INVALID", message, false, None)
}

fn context_digest(context: &str) -> String {
    format!("{:x}", Sha256::digest(context.as_bytes()))
}

pub fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "account_confirmation.export" => export(params),
        "account_confirmation.import" => import(params),
        _ => Err(invalid("未知的科目确认表操作。")),
    }
}

fn export(params: Value) -> Result<Value, AppError> {
    let request: Export = serde_json::from_value(params)
        .map_err(|e| invalid(format!("科目确认表参数不完整：{e}")))?;
    if !matches!(request.tool.as_str(), "deposit" | "fx" | "loan" | "fa_tbje")
        || request.context.is_empty()
        || request.columns.is_empty()
        || request.columns.len() > 24
        || request.rows.len() > 100_000
        || request
            .rows
            .iter()
            .any(|r| r.values.len() != request.columns.len())
    {
        return Err(invalid("科目确认表数据格式不正确。"));
    }
    let mut keys = HashSet::new();
    if request
        .rows
        .iter()
        .any(|r| r.key.is_empty() || !keys.insert(&r.key))
    {
        return Err(invalid("科目确认表存在重复或空白行键。"));
    }
    let mut workbook = Workbook::new();
    let header = Format::new()
        .set_bold()
        .set_background_color(Color::RGB(0xE7F4F0));
    let input = Format::new().set_background_color(Color::RGB(0xFFF0BC));
    let sheet = workbook.add_worksheet();
    sheet.set_name(SHEET).map_err(xlsx_error)?;
    sheet.set_column_hidden(0).map_err(xlsx_error)?;
    sheet.write_string(0, 0, "__row_key").map_err(xlsx_error)?;
    for (index, column) in request.columns.iter().enumerate() {
        if column.key.is_empty() || column.title.is_empty() {
            return Err(invalid("科目确认表列定义不完整。"));
        }
        let col = (index + 1) as u16;
        sheet
            .write_string_with_format(0, col, &column.title, &header)
            .map_err(xlsx_error)?;
        sheet.set_column_width(col, 23).map_err(xlsx_error)?;
        if column.editable && !column.options.is_empty() {
            let choices = column
                .options
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            let validation = DataValidation::new()
                .allow_list_strings(&choices)
                .map_err(xlsx_error)?;
            if !request.rows.is_empty() {
                sheet
                    .add_data_validation(1, col, request.rows.len() as u32, col, &validation)
                    .map_err(xlsx_error)?;
            }
        }
    }
    for (index, row) in request.rows.iter().enumerate() {
        let line = (index + 1) as u32;
        sheet
            .write_string(
                line,
                0,
                format!("k:{}", URL_SAFE_NO_PAD.encode(row.key.as_bytes())),
            )
            .map_err(xlsx_error)?;
        for (col, value) in row.values.iter().enumerate() {
            if request.columns[col].editable && row.editable.get(col).copied().unwrap_or(true) {
                sheet
                    .write_string_with_format(line, (col + 1) as u16, value, &input)
                    .map_err(xlsx_error)?;
            } else {
                sheet
                    .write_string(line, (col + 1) as u16, value)
                    .map_err(xlsx_error)?;
            }
        }
    }
    sheet.set_freeze_panes(1, 1).map_err(xlsx_error)?;
    let meta = workbook.add_worksheet();
    meta.set_name(META).map_err(xlsx_error)?;
    meta.write_string(0, 0, VERSION).map_err(xlsx_error)?;
    meta.write_string(1, 0, &request.tool).map_err(xlsx_error)?;
    meta.write_string(2, 0, context_digest(&request.context))
        .map_err(xlsx_error)?;
    meta.set_hidden(true);
    workbook
        .save(Path::new(&request.output_path))
        .map_err(xlsx_error)?;
    Ok(json!({"count": request.rows.len(), "outputPath": request.output_path}))
}

fn import(params: Value) -> Result<Value, AppError> {
    let path = params
        .get("inputPath")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少确认表路径。"))?;
    let expected_tool = params
        .get("tool")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少工具标识。"))?;
    let expected_context = params
        .get("context")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("缺少数据源标识。"))?;
    let expected = params
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("缺少当前科目清单。"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid("当前科目清单格式不正确。"))?;
    let mut workbook =
        open_workbook_auto(path).map_err(|e| invalid(format!("无法打开科目确认表：{e}")))?;
    let meta = workbook
        .worksheet_range(META)
        .map_err(|_| invalid("模板信息缺失，请下载当前工具的新确认表。"))?;
    let cell = |row: usize| {
        meta.get((row, 0))
            .map(ToString::to_string)
            .unwrap_or_default()
    };
    if cell(0) != VERSION || cell(1) != expected_tool || cell(2) != context_digest(expected_context)
    {
        return Err(invalid("确认表与当前工具或数据源不匹配，请重新下载。"));
    }
    let sheet = workbook
        .worksheet_range(SHEET)
        .map_err(|_| invalid("找不到「科目确认」工作表。"))?;
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for (index, row) in sheet.rows().enumerate().skip(1) {
        let encoded = row.first().map(ToString::to_string).unwrap_or_default();
        if encoded.is_empty() {
            if row.iter().any(|cell| !cell.to_string().trim().is_empty()) {
                return Err(invalid(format!(
                    "第 {} 行缺少隐藏行键，请不要删除首列。",
                    index + 1
                )));
            }
            continue;
        }
        let key = encoded
            .strip_prefix("k:")
            .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| {
                invalid(format!(
                    "第 {} 行的隐藏行键已损坏，请重新下载确认表。",
                    index + 1
                ))
            })?;
        if !seen.insert(key.clone()) {
            return Err(invalid(format!("第 {} 行的科目重复。", index + 1)));
        }
        rows.push(json!({"key": key, "values": row.iter().skip(1).map(ToString::to_string).collect::<Vec<_>>() }));
    }
    let expected_set = expected.iter().collect::<HashSet<_>>();
    if seen.len() != expected_set.len() || !seen.iter().all(|key| expected_set.contains(key)) {
        return Err(invalid(
            "确认表科目与当前页面不一致；不能增删科目行，请重新下载后填写。",
        ));
    }
    Ok(json!({"rows": rows}))
}

fn xlsx_error(error: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::new(
        "CONFIRMATION_XLSX_FAILED",
        "科目确认表写入失败。",
        true,
        Some(error.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_confirmation_roundtrip_checks_context_and_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("confirmation.xlsx");
        let path = path.to_string_lossy().to_string();
        export(json!({
            "tool": "fx", "context": "source-a", "outputPath": path,
            "columns": [
                {"key":"account","title":"科目"},
                {"key":"role","title":"分类","editable":true,"options":["货币性资产","非货币性项目"]}
            ],
            "rows": [
                {"key":"主体\u{1f}1002\u{1f}辅助", "values":["1002 银行存款","货币性资产"]},
                {"key":"1601", "values":["1601 固定资产","非货币性项目"]}
            ]
        })).unwrap();
        let result = import(json!({"tool":"fx","context":"source-a","inputPath":path,"keys":["1601","主体\u{1f}1002\u{1f}辅助"]})).unwrap();
        assert_eq!(result["rows"].as_array().unwrap().len(), 2);
        assert_eq!(result["rows"][0]["key"], "主体\u{1f}1002\u{1f}辅助");
        assert!(import(json!({"tool":"fx","context":"other","inputPath":path,"keys":["主体\u{1f}1002\u{1f}辅助","1601"]})).is_err());
        assert!(import(json!({"tool":"fx","context":"source-a","inputPath":path,"keys":["主体\u{1f}1002\u{1f}辅助"]})).is_err());
    }
}
