//! Tax return grid export. Grid coordinates are zero-based and inclusive.

use crate::AppError;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::PathBuf};

const GRID_START: u32 = 6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    company_name: String,
    #[serde(default)]
    period: String,
    #[serde(default)]
    form_code: String,
    form_name: String,
    source_file: String,
    pages: Vec<u32>,
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    merges: Vec<Merge>,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_sections")]
    sections: Option<Vec<Section>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Section {
    page: u32,
    table_index: usize,
    rows: Vec<Vec<Value>>,
    #[serde(default)]
    merges: Vec<Merge>,
    #[serde(default)]
    notes: Vec<String>,
}

fn deserialize_sections<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<Section>>, D::Error> {
    Vec::<Section>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Merge {
    first_row: usize,
    last_row: usize,
    first_col: usize,
    last_col: usize,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("TAX_GRID_INVALID", message, false, None)
}

fn xlsx_error(error: impl std::fmt::Display) -> AppError {
    AppError::new("AUDIPICK_EXPORT_FAILED", "纳税申报表导出失败。", true, Some(error.to_string()))
}

fn valid_text(text: &str) -> bool {
    text.chars().count() <= 32_767
}

fn empty(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn validate(table: &Table) -> Result<(), AppError> {
    if table.company_name.trim().is_empty() || table.form_name.trim().is_empty() {
        return Err(invalid("请先确认公司名称和表单名称后再导出。"));
    }
    if [&table.company_name, &table.period, &table.form_code, &table.form_name, &table.source_file]
        .iter().any(|text| !valid_text(text)) {
        return Err(invalid("公司或来源信息超过 Excel 单元格文字上限。"));
    }
    if table.pages.is_empty() || table.pages.contains(&0)
        || table.pages.iter().collect::<BTreeSet<_>>().len() != table.pages.len() {
        return Err(invalid("表单的 PDF 页码必须是互不重复的正整数。"));
    }
    validate_grid(&table.rows, &table.merges, &table.notes)?;
    if let Some(sections) = &table.sections {
        if sections.is_empty() || sections.len() > 10_000 {
            return Err(invalid("独立表格分区数量无效。"));
        }
        let mut counts = vec![0usize; table.pages.len()];
        let mut last_page = 0;
        let mut total_rows = 0usize;
        let mut width = 0usize;
        for section in sections {
            let order = table.pages.iter().position(|page| *page == section.page)
                .ok_or_else(|| invalid("独立分区来源页码不在所选范围。"))?;
            if order < last_page || section.table_index != counts[order] + 1 {
                return Err(invalid("独立分区页序或表格序号无效。"));
            }
            counts[order] += 1;
            last_page = order;
            validate_grid(&section.rows, &section.merges, &section.notes)?;
            total_rows += section.rows.len();
            width = width.max(section.rows[0].len());
            if total_rows > 20_000 || total_rows * width > 1_000_000 {
                return Err(invalid("独立分区总规模超出限制。"));
            }
        }
        if counts.contains(&0) { return Err(invalid("独立分区缺少所选页面。")); }
        let section_notes: BTreeSet<&str> = sections.iter().flat_map(|section| section.notes.iter().map(String::as_str)).collect();
        if table.notes.iter().any(|note| !section_notes.contains(note.as_str())) {
            return Err(invalid("独立分区遗漏原页说明，导出会丢失顶层原注，请复核后导出。"));
        }
        if total_rows != table.rows.len() || width != table.rows[0].len() {
            return Err(invalid("独立分区与兼容网格规模不一致。"));
        }
        let mut offset = 0;
        let mut merge_index = 0;
        for section in sections {
            for (row, values) in section.rows.iter().enumerate() {
                for col in 0..width {
                    let expected = values.get(col).unwrap_or(&Value::Null);
                    if &table.rows[offset + row][col] != expected {
                        return Err(invalid("独立分区与兼容网格内容不一致，不能导出矛盾的数据。"));
                    }
                }
            }
            for merge in &section.merges {
                let expected = Merge { first_row: merge.first_row + offset, last_row: merge.last_row + offset,
                    first_col: merge.first_col, last_col: merge.last_col };
                if table.merges.get(merge_index) != Some(&expected) {
                    return Err(invalid("独立分区与兼容网格合并不一致，不能导出矛盾的数据。"));
                }
                merge_index += 1;
            }
            offset += section.rows.len();
        }
        if merge_index != table.merges.len() {
            return Err(invalid("独立分区与兼容网格合并数量不一致。"));
        }
    }
    Ok(())
}

fn validate_grid(rows: &[Vec<Value>], merges: &[Merge], notes: &[String]) -> Result<(), AppError> {
    if notes.iter().any(|note| !valid_text(note)) || !valid_text(&notes.join("\n")) {
        return Err(invalid("原页说明超过 Excel 单元格文字上限，请复核后导出。"));
    }
    let columns = rows.first().map(Vec::len).unwrap_or(0);
    if rows.is_empty() || columns == 0 || rows.len() > 1_048_576 - GRID_START as usize
        || columns > 16_384 || rows.iter().any(|row| row.len() != columns) {
        return Err(invalid("表格行列为空、不规则或超出 Excel 行列上限。"));
    }
    for row in rows {
        for cell in row {
            match cell {
                Value::Null => (),
                Value::String(text) if valid_text(text) => (),
                Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => (),
                _ => return Err(invalid("表格单元格必须为文字、有限数字或空白，且不得超过 Excel 文字上限。")),
            }
        }
    }
    for (index, merge) in merges.iter().enumerate() {
        if merge.first_row > merge.last_row || merge.first_col > merge.last_col
            || merge.last_row >= rows.len() || merge.last_col >= columns
            || (merge.first_row == merge.last_row && merge.first_col == merge.last_col) {
            return Err(invalid("合并单元格范围无效或超出原表网格。"));
        }
        if merges[..index].iter().any(|other| {
            merge.first_row <= other.last_row && other.first_row <= merge.last_row
                && merge.first_col <= other.last_col && other.first_col <= merge.last_col
        }) {
            return Err(invalid("原表存在相互重叠的合并单元格，请复核后导出。"));
        }
        for row in merge.first_row..=merge.last_row {
            for col in merge.first_col..=merge.last_col {
                if (row, col) != (merge.first_row, merge.first_col) && !empty(&rows[row][col]) {
                    return Err(invalid("合并区域含有多个非空单元格，合并会丢失内容，请先复核。"));
                }
            }
        }
    }
    Ok(())
}

fn sheet_name(table: &Table, section: Option<&Section>, used: &mut BTreeSet<String>) -> String {
    let clean: String = format!("{}-{}", table.company_name, table.form_name).chars()
        .map(|c| if c.is_control() || "[]:*?/\\'".contains(c) { ' ' } else { c }).collect();
    let base = clean.trim();
    let section_suffix = section.map(|part| format!("-P{}-T{}", part.page, part.table_index)).unwrap_or_default();
    let mut candidate = format!("{}{}", base.chars().take(31 - section_suffix.chars().count()).collect::<String>(), section_suffix);
    let mut index = 2;
    while used.contains(&candidate.to_lowercase()) {
        let suffix = format!("{section_suffix} ({index})");
        candidate = format!("{}{}", base.chars().take(31 - suffix.chars().count()).collect::<String>(), suffix);
        index += 1;
    }
    used.insert(candidate.to_lowercase());
    candidate
}

/// All tables are validated before opening the output file; string cells are
/// always written with write_string (never interpreted as formulas).
pub(crate) fn export(params: &Value) -> Result<Value, AppError> {
    let path = params.get("outputPath").and_then(Value::as_str).unwrap_or("").trim();
    if path.is_empty() {
        return Err(AppError::new("OUTPUT_REQUIRED", "请选择纳税申报表输出文件。", false, None));
    }
    let tables: Vec<Table> = serde_json::from_value(params.get("tables").cloned().unwrap_or(Value::Null))
        .map_err(|_| invalid("纳税申报表导出数据格式无效。"))?;
    if tables.is_empty() { return Err(invalid("没有可导出的纳税申报表。")); }
    for table in &tables { validate(table)?; }
    let output = PathBuf::from(path);
    if !output.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("xlsx")) {
        return Err(AppError::new("TAX_OUTPUT_EXTENSION_INVALID", "请在保存对话框中选择明确以 .xlsx 结尾的文件名，导出不会自动更换保存路径。", false, None));
    }
    let mut workbook = Workbook::new();
    let header = Format::new().set_bold().set_background_color("#DCE6F1").set_border(FormatBorder::Thin);
    let cell_format = Format::new().set_border(FormatBorder::Thin).set_text_wrap().set_align(FormatAlign::VerticalCenter);
    let mut used = BTreeSet::from(["提取索引".to_string()]);
    // Compatibility rows are only a projection for older callers. Each section
    // retains its own width and merges in an actual worksheet.
    let mut sheets = Vec::new();
    for table in &tables {
        if let Some(sections) = &table.sections {
            sheets.extend(sections.iter().map(|section| (table, Some(section))));
        } else {
            sheets.push((table, None));
        }
    }
    if sheets.len() > 1_048_575 { return Err(invalid("导出索引行数超出 Excel 上限。")); }
    let names: Vec<_> = sheets.iter().map(|(table, section)| sheet_name(table, *section, &mut used)).collect();
    let has_sections = sheets.iter().any(|(_, section)| section.is_some());
    {
        let sheet = workbook.add_worksheet();
        sheet.set_name("提取索引").map_err(xlsx_error)?;
        for (col, name) in ["公司名称", "所属期", "表单名称", "表单编号", "来源文件", "PDF页码", "工作表"].iter().enumerate() {
            sheet.write_string_with_format(0, col as u16, *name, &header).map_err(xlsx_error)?;
            sheet.set_column_width(col as u16, if col == 0 || col == 2 || col == 4 || col == 6 { 32 } else { 20 }).map_err(xlsx_error)?;
        }
        if has_sections {
            sheet.write_string_with_format(0, 7, "页内表序", &header).map_err(xlsx_error)?;
            sheet.set_column_width(7, 16).map_err(xlsx_error)?;
        }
        for (index, (table, section)) in sheets.iter().enumerate() {
            let pages = section.map(|part| part.page.to_string())
                .unwrap_or_else(|| table.pages.iter().map(u32::to_string).collect::<Vec<_>>().join("、"));
            for (col, text) in [&table.company_name, &table.period, &table.form_name, &table.form_code, &table.source_file, &pages, &names[index]].iter().enumerate() {
                sheet.write_string((index + 1) as u32, col as u16, text.as_str()).map_err(xlsx_error)?;
            }
            if let Some(part) = section {
                sheet.write_string((index + 1) as u32, 7, part.table_index.to_string()).map_err(xlsx_error)?;
            }
        }
        sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    }
    for (index, (table, section)) in sheets.iter().enumerate() {
        let sheet = workbook.add_worksheet();
        sheet.set_name(&names[index]).map_err(xlsx_error)?;
        let mut form = format!("{} {}", table.form_code, table.form_name).trim().to_string();
        if let Some(part) = section { form.push_str(&format!("（第{}表）", part.table_index)); }
        let pages = section.map(|part| part.page.to_string())
            .unwrap_or_else(|| table.pages.iter().map(u32::to_string).collect::<Vec<_>>().join("、"));
        let (rows, merges, notes) = section.map(|part| (&part.rows, &part.merges, &part.notes))
            .unwrap_or((&table.rows, &table.merges, &table.notes));
        for (row, (label, value)) in [("公司名称", &table.company_name), ("表单名称", &form),
            ("所属期", &table.period), ("来源文件", &table.source_file), ("PDF页码", &pages)].iter().enumerate() {
            sheet.write_string_with_format(row as u32, 0, *label, &header).map_err(xlsx_error)?;
            sheet.write_string(row as u32, 1, value.as_str()).map_err(xlsx_error)?;
        }
        if !notes.is_empty() {
            sheet.write_string_with_format(5, 0, "原页说明", &header).map_err(xlsx_error)?;
            sheet.write_string_with_format(5, 1, notes.join("\n"), &cell_format).map_err(xlsx_error)?;
        }
        for col in 0..rows[0].len() {
            sheet.set_column_width(col as u16, if col == 0 { 32 } else { 20 }).map_err(xlsx_error)?;
        }
        for merge in merges {
            sheet.merge_range(GRID_START + merge.first_row as u32, merge.first_col as u16,
                GRID_START + merge.last_row as u32, merge.last_col as u16, "", &cell_format).map_err(xlsx_error)?;
        }
        for (row, values) in rows.iter().enumerate() {
            for (col, value) in values.iter().enumerate() {
                let r = GRID_START + row as u32;
                let c = col as u16;
                match value {
                    Value::String(text) if !text.is_empty() => { sheet.write_string_with_format(r, c, text, &cell_format).map_err(xlsx_error)?; }
                    Value::Number(number) => {
                        let text = number.to_string();
                        // Excel numbers retain only 15 significant digits.
                        // Preserve longer source values as text instead of rounding them.
                        if text.chars().filter(char::is_ascii_digit).count() > 15 {
                            sheet.write_string_with_format(r, c, &text, &cell_format).map_err(xlsx_error)?;
                        } else {
                            sheet.write_number_with_format(r, c, number.as_f64().unwrap(), &cell_format).map_err(xlsx_error)?;
                        }
                    }
                    _ => { sheet.write_blank(r, c, &cell_format).map_err(xlsx_error)?; }
                }
            }
        }
        sheet.set_freeze_panes(GRID_START, 0).map_err(xlsx_error)?;
    }
    workbook.save(&output).map_err(xlsx_error)?;
    Ok(json!({"outputPath":output.to_string_lossy(),"outputPaths":[output.to_string_lossy()],"tableCount":tables.len(),"sheetCount":sheets.len(),"sheets":names}))
}

#[cfg(test)]
mod tests {
    use calamine::{Data, Reader, Xlsx};
    use serde_json::json;
    use std::io::{Cursor, Read};

    fn mixed_section_table() -> serde_json::Value {
        json!({"companyName":"多区块回归测试公司","period":"2025年度","formCode":"A105080",
            "formName":"资产折旧、摊销及纳税调整明细表","sourceFile":"虚构原表.pdf","pages":[14,15],
            "rows":[["项目",null,null],["一","12345678901234567.89",null],["项目","账载金额","税收金额"],["二",-12.5,0],["说明","=1+1",null]],
            "merges":[{"firstRow":0,"lastRow":0,"firstCol":0,"lastCol":1}],
            "sections":[
                {"page":14,"tableIndex":1,"rows":[["项目",null],["一","12345678901234567.89"]],
                    "merges":[{"firstRow":0,"lastRow":0,"firstCol":0,"lastCol":1}],"notes":["金额单位：元","=原注原样保留"]},
                {"page":14,"tableIndex":2,"rows":[["项目","账载金额","税收金额"],["二",-12.5,0]],"merges":[]},
                {"page":15,"tableIndex":1,"rows":[["说明","=1+1"]],"merges":[],"notes":["续页说明"]}
            ]})
    }

    #[test]
    fn tax_export_preserves_independent_section_widths_pages_merges_and_literal_text() {
        let path = std::env::temp_dir().join(format!("tax-sections-{}.xlsx", uuid::Uuid::new_v4()));
        let mut table = mixed_section_table();
        // Parent notes may be deduplicated or repeated; only membership in an
        // actually exported section is required, never multiset equality.
        table["notes"] = json!(["金额单位：元", "金额单位：元", "续页说明"]);
        let result = super::export(&json!({"outputPath":path,"tables":[table]})).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(result["tableCount"], 1);
        assert_eq!(result["sheetCount"], 3);
        let names = result["sheets"].as_array().unwrap();
        assert_eq!(names.len(), 3);
        let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(workbook.sheet_names().len(), 4);
        let index = workbook.worksheet_range("提取索引").unwrap();
        for (i, (page, ordinal, width)) in [(14,1,2),(14,2,3),(15,1,2)].iter().enumerate() {
            let name = names[i].as_str().unwrap();
            assert!(name.contains(&format!("P{page}-T{ordinal}")));
            assert_eq!(index.get_value((i as u32+1,5)), Some(&Data::String(page.to_string())));
            assert_eq!(index.get_value((i as u32+1,6)), Some(&Data::String(name.into())));
            assert_eq!(index.get_value((i as u32+1,7)), Some(&Data::String(ordinal.to_string())));
            let grid = workbook.worksheet_range(name).unwrap();
            assert_eq!(grid.get_value((0,1)), Some(&Data::String("多区块回归测试公司".into())));
            assert_eq!(grid.get_value((4,1)), Some(&Data::String(page.to_string())));
            assert!(grid.get_value((1,1)).unwrap().to_string().contains(&format!("第{ordinal}表")));
            assert_eq!(grid.end().unwrap().1, width-1);
        }
        let first = workbook.worksheet_range(names[0].as_str().unwrap()).unwrap();
        assert_eq!(first.get_value((7,1)), Some(&Data::String("12345678901234567.89".into())));
        assert_eq!(first.get_value((5,1)), Some(&Data::String("金额单位：元\n=原注原样保留".into())));
        let second = workbook.worksheet_range(names[1].as_str().unwrap()).unwrap();
        assert_eq!(second.get_value((7,1)), Some(&Data::Float(-12.5)));
        assert_eq!(second.get_value((7,2)), Some(&Data::Float(0.0)));
        let third = workbook.worksheet_range(names[2].as_str().unwrap()).unwrap();
        assert_eq!(third.get_value((6,1)), Some(&Data::String("=1+1".into())));
        assert_eq!(third.get_value((5,1)), Some(&Data::String("续页说明".into())));
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for sheet in 2..=4 {
            let mut xml = String::new();
            archive.by_name(&format!("xl/worksheets/sheet{sheet}.xml")).unwrap().read_to_string(&mut xml).unwrap();
            assert!(!xml.contains("<f>"));
            if sheet == 2 { assert!(xml.contains("mergeCell ref=\"A7:B7\"")); }
            if sheet != 3 { assert!(!xml.contains("r=\"C7\""), "兼容投影的空补列不得写成原表网格"); }
        }
    }

    #[test]
    fn tax_export_rejects_conflicting_or_invalid_sections_before_creating_output() {
        let path = std::env::temp_dir().join(format!("tax-sections-invalid-{}.xlsx", uuid::Uuid::new_v4()));
        let base = mixed_section_table();
        let mut cases = Vec::new();
        let mut changed = base.clone(); changed["rows"][1][1] = json!("矛盾金额"); cases.push(changed);
        let mut padding = base.clone(); padding["rows"][0][2] = json!(""); cases.push(padding);
        let mut missing_merge = base.clone(); missing_merge["merges"] = json!([]); cases.push(missing_merge);
        let mut outside_page = base.clone(); outside_page["sections"][0]["page"] = json!(16); cases.push(outside_page);
        let mut duplicate = base.clone(); duplicate["sections"][1]["tableIndex"] = json!(1); cases.push(duplicate);
        let mut reversed = base.clone(); reversed["sections"].as_array_mut().unwrap().swap(0,2); cases.push(reversed);
        let mut missing_page = base.clone(); missing_page["pages"] = json!([14,15,16]); cases.push(missing_page);
        let mut empty = base.clone(); empty["sections"] = json!([]); cases.push(empty);
        let mut irregular = base.clone(); irregular["sections"][0]["rows"][1] = json!(["缺列"]); cases.push(irregular);
        let mut hidden_data = base.clone(); hidden_data["sections"][0]["rows"][0][1] = json!("不得丢弃"); cases.push(hidden_data);
        let mut notes = base; notes["sections"][0]["notes"] = json!(["甲".repeat(32768)]); cases.push(notes);
        for (i, table) in cases.into_iter().enumerate() {
            let result = super::export(&json!({"outputPath":path,"tables":[table]}));
            let created = path.exists();
            if created { std::fs::remove_file(&path).unwrap(); }
            assert!(result.is_err(), "矛盾或无效分区未拦截 case {i}");
            assert_eq!(result.unwrap_err().code, "TAX_GRID_INVALID");
            assert!(!created, "校验失败前不得创建文件 case {i}");
        }
    }

    #[test]
    fn tax_export_rejects_unassigned_parent_notes_without_touching_output() {
        let path = std::env::temp_dir().join(format!("tax-sections-notes-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"existing output").unwrap();
        let mut table = mixed_section_table();
        table["notes"] = json!(["金额单位：元", "仅在顶层存在的原注不得丢失"]);
        let result = super::export(&json!({"outputPath":path,"tables":[table]}));
        let actual = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(result.is_err(), "分区遗漏的顶层原注不得静默丢失");
        assert_eq!(result.unwrap_err().code, "TAX_GRID_INVALID");
        assert_eq!(actual, b"existing output");
    }

    #[test]
    fn tax_export_preserves_grid_metadata_numbers_and_literal_formula_text() {
        let path = std::env::temp_dir().join(format!("tax-grid-{}.xlsx", uuid::Uuid::new_v4()));
        let params = json!({"outputPath":path,"tables":[{
            "companyName":"测试公司甲","period":"2025年度","formCode":"A105000",
            "formName":"纳税调整项目明细表","sourceFile":"甲.pdf","pages":[7,8],
            "rows":[["项目","金额",null],["项目一",-12.5,"*"],["项目二",0,"=1+1"],["项目三",null,""],["长数字",12345678901234567u64,null]],
            "merges":[{"firstRow":0,"lastRow":0,"firstCol":1,"lastCol":2}]
        }]});
        let result = crate::audipick::call("audipick.tax_export", params, json!({})).unwrap();
        assert_eq!(result["tableCount"], 1);
        let bytes = std::fs::read(&path).unwrap();
        let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).unwrap();
        let names = workbook.sheet_names().to_vec();
        assert_eq!(names.len(), 2);
        assert!(names[1].contains("测试公司甲"));
        let grid = workbook.worksheet_range(&names[1]).unwrap();
        assert_eq!(grid.get_value((0, 1)), Some(&Data::String("测试公司甲".into())));
        assert_eq!(grid.get_value((4, 1)), Some(&Data::String("7、8".into())));
        assert!(grid.get_value((5, 0)).is_none() || grid.get_value((5, 0)) == Some(&Data::Empty));
        assert_eq!(grid.get_value((6, 0)), Some(&Data::String("项目".into())));
        assert_eq!(grid.get_value((7, 1)), Some(&Data::Float(-12.5)));
        assert_eq!(grid.get_value((7, 2)), Some(&Data::String("*".into())));
        assert_eq!(grid.get_value((8, 1)), Some(&Data::Float(0.0)));
        assert_eq!(grid.get_value((8, 2)), Some(&Data::String("=1+1".into())));
        assert_eq!(grid.get_value((10, 1)), Some(&Data::String("12345678901234567".into())));
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(xml.contains("mergeCell ref=\"B7:C7\""));
        assert!(!xml.contains("<f>"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn tax_export_preserves_original_page_notes_without_moving_the_grid() {
        let path = std::env::temp_dir().join(format!("tax-notes-{}.xlsx", uuid::Uuid::new_v4()));
        let notes = ["A106000 企业所得税弥补亏损明细表", "金额单位：元（列至角分）", "原注：空白格与零分别保留", "=原页文字按文字保留"];
        let result = crate::audipick::call("audipick.tax_export", json!({"outputPath":path,"tables":[{
            "companyName":"说明回归测试公司","formName":"企业所得税弥补亏损明细表","sourceFile":"合成测试.pdf",
            "pages":[1],"notes":notes,"rows":[["行次","金额"],["1","0.00"]]
        }]}), json!({})).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).unwrap();
        let grid = workbook.worksheet_range(result["sheets"][0].as_str().unwrap()).unwrap();
        assert_eq!(grid.get_value((5, 0)), Some(&Data::String("原页说明".into())));
        assert_eq!(grid.get_value((5, 1)), Some(&Data::String(notes.join("\n"))));
        assert_eq!(grid.get_value((6, 0)), Some(&Data::String("行次".into())));
        assert_eq!(grid.get_value((7, 1)), Some(&Data::String("0.00".into())));
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(!xml.contains("<f>"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn tax_export_rejects_notes_exceeding_one_cell_without_creating_output() {
        let path = std::env::temp_dir().join(format!("tax-long-notes-{}.xlsx", uuid::Uuid::new_v4()));
        let result = crate::audipick::call("audipick.tax_export", json!({"outputPath":path,"tables":[{
            "companyName":"说明回归测试公司","formName":"测试表","sourceFile":"合成测试.pdf","pages":[1],
            "notes":["甲".repeat(16_384),"乙".repeat(16_384)],"rows":[["表头"]]
        }]}), json!({}));
        assert_eq!(result.unwrap_err().code, "TAX_GRID_INVALID");
        assert!(!path.exists());
    }

    #[test]
    fn tax_export_preserves_a106000_fourteen_column_spans_and_single_merged_footer() {
        let path = std::env::temp_dir().join(format!("tax-a106000-spans-{}.xlsx", uuid::Uuid::new_v4()));
        // Synthetic layout only: the grid contract represents HTML rowspan and
        // colspan with one anchor value and null in every covered cell.
        let mut rows = vec![vec![serde_json::Value::Null; 14]; 3];
        for (col, text) in [(0, "行次"), (1, "年度"), (2, "纳税调整后所得"),
            (3, "可弥补亏损额"), (8, "已弥补亏损额"), (13, "当年剩余亏损额")] {
            rows[0][col] = json!(text);
        }
        for (col, text) in [(3, "五年结转"), (6, "十年结转"), (8, "本期弥补"), (11, "前期弥补")] {
            rows[1][col] = json!(text);
        }
        for col in 3..13 { rows[2][col] = json!(format!("明细列{}", col + 1)); }
        for index in 0..15 {
            let mut row = vec![json!(format!("{}", index + 1)), json!(format!("{}年度", 2000 + index))];
            row.extend((2..14).map(|col| if (index + col) % 4 == 0 { serde_json::Value::Null }
                else { json!(format!("{}.00", index * 10 + col)) }));
            rows.push(row);
        }
        let footer = "说明：本行用于验证表尾较长说明在原表末行跨列时仍完整保留。".repeat(8);
        let footer_row = rows.len();
        let mut last = vec![serde_json::Value::Null; 14];
        last[1] = json!(footer);
        last[13] = json!("123.45");
        rows.push(last);
        let merges = json!([
            {"firstRow":0,"lastRow":2,"firstCol":0,"lastCol":0},
            {"firstRow":0,"lastRow":2,"firstCol":1,"lastCol":1},
            {"firstRow":0,"lastRow":2,"firstCol":2,"lastCol":2},
            {"firstRow":0,"lastRow":0,"firstCol":3,"lastCol":7},
            {"firstRow":0,"lastRow":0,"firstCol":8,"lastCol":12},
            {"firstRow":0,"lastRow":2,"firstCol":13,"lastCol":13},
            {"firstRow":1,"lastRow":1,"firstCol":3,"lastCol":5},
            {"firstRow":1,"lastRow":1,"firstCol":6,"lastCol":7},
            {"firstRow":1,"lastRow":1,"firstCol":8,"lastCol":10},
            {"firstRow":1,"lastRow":1,"firstCol":11,"lastCol":12},
            {"firstRow":footer_row,"lastRow":footer_row,"firstCol":1,"lastCol":12}
        ]);
        let result = crate::audipick::call("audipick.tax_export", json!({"outputPath":path,"tables":[{
            "companyName":"网格回归测试公司","period":"测试年度","formCode":"A106000",
            "formName":"企业所得税弥补亏损明细表","sourceFile":"虚构表单.pdf","pages":[12],
            "rows":rows,"merges":merges
        }]}), json!({})).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(&bytes)).unwrap();
        let grid = workbook.worksheet_range(result["sheets"][0].as_str().unwrap()).unwrap();
        assert_eq!(grid.end(), Some((footer_row as u32 + super::GRID_START, 13)));
        for (r, row) in rows.iter().enumerate() {
            for (c, expected) in row.iter().enumerate() {
                let actual = grid.get_value((super::GRID_START + r as u32, c as u32));
                if expected.is_null() {
                    assert!(actual.is_none() || actual == Some(&Data::Empty), "覆盖格不得复制合并锚点：{r},{c} {actual:?}");
                } else {
                    assert_eq!(actual, Some(&Data::String(expected.as_str().unwrap().to_string())), "网格内容位置改变：{r},{c}");
                }
            }
        }
        assert_eq!(grid.rows().flatten().filter(|cell| **cell == Data::String(footer.clone())).count(), 1);
        assert_eq!(grid.get_value((footer_row as u32 + super::GRID_START, 13)), Some(&Data::String("123.45".into())));
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        archive.by_name("xl/worksheets/sheet2.xml").unwrap().read_to_string(&mut xml).unwrap();
        for reference in ["A7:A9", "B7:B9", "C7:C9", "D7:H7", "I7:M7", "N7:N9", "D8:F8", "G8:H8", "I8:K8", "L8:M8"] {
            assert!(xml.contains(&format!("mergeCell ref=\"{reference}\"")), "缺少合并范围 {reference}");
        }
        let footer_excel_row = footer_row as u32 + super::GRID_START + 1;
        assert!(xml.contains(&format!("mergeCell ref=\"B{footer_excel_row}:M{footer_excel_row}\"")));
        assert!(!xml.contains(&format!("mergeCell ref=\"B{footer_excel_row}:N{footer_excel_row}\"")));
        assert!(xml.contains("mergeCells count=\"11\""));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn tax_export_rejects_overlapping_merges_before_creating_file() {
        let path = std::env::temp_dir().join(format!("tax-invalid-{}.xlsx", uuid::Uuid::new_v4()));
        let params = json!({"outputPath":path,"tables":[{
            "companyName":"测试","formName":"测试表","sourceFile":"测试.pdf","pages":[1],
            "rows":[["表头",null,null],[null,null,null]],"merges":[
                {"firstRow":0,"lastRow":1,"firstCol":0,"lastCol":1},
                {"firstRow":0,"lastRow":0,"firstCol":1,"lastCol":2}
            ]
        }]});
        let failure = crate::audipick::call("audipick.tax_export", params, json!({})).unwrap_err();
        assert_eq!(failure.code, "TAX_GRID_INVALID");
        assert!(!path.exists());
    }

    #[test]
    fn tax_export_deduplicates_truncated_names_and_keeps_full_company_metadata() {
        let path = std::env::temp_dir().join(format!("tax-names-{}.xlsx", uuid::Uuid::new_v4()));
        let company = "测试超长公司名称".repeat(6);
        let table = json!({"companyName":company,"formName":"企业所得税弥补亏损明细表",
            "sourceFile":"测试.pdf","pages":[20],"rows":[["行次","金额"],["一",null]]});
        let result = crate::audipick::call("audipick.tax_export",
            json!({"outputPath":path,"tables":[table.clone(),table]}), json!({})).unwrap();
        let names = result["sheets"].as_array().unwrap();
        assert_ne!(names[0], names[1]);
        assert!(names.iter().all(|name| name.as_str().unwrap().chars().count() <= 31));
        let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(std::fs::read(&path).unwrap())).unwrap();
        for name in names {
            let range = workbook.worksheet_range(name.as_str().unwrap()).unwrap();
            assert_eq!(range.get_value((0, 1)), Some(&Data::String(company.clone())));
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn tax_export_rejects_invalid_grids_without_overwriting_existing_output() {
        let path = std::env::temp_dir().join(format!("tax-preserve-{}.xlsx", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"existing output").unwrap();
        let base = json!({"companyName":"测试公司","formName":"增值税纳税申报表",
            "sourceFile":"测试.pdf","pages":[1],"rows":[["表头",null],["项目",1]]});
        let mut invalid_tables = Vec::new();
        let mut ragged = base.clone(); ragged["rows"] = json!([["表头",null],[1]]); invalid_tables.push(ragged);
        let mut missing_company = base.clone(); missing_company["companyName"] = json!(""); invalid_tables.push(missing_company);
        let mut invalid_page = base.clone(); invalid_page["pages"] = json!([0]); invalid_tables.push(invalid_page);
        let mut bounds = base.clone(); bounds["merges"] = json!([{"firstRow":0,"lastRow":2,"firstCol":0,"lastCol":1}]); invalid_tables.push(bounds);
        let mut data_loss = base; data_loss["merges"] = json!([{"firstRow":0,"lastRow":1,"firstCol":0,"lastCol":1}]); invalid_tables.push(data_loss);
        for table in invalid_tables {
            let failure = crate::audipick::call("audipick.tax_export",
                json!({"outputPath":path,"tables":[table]}), json!({})).unwrap_err();
            assert_eq!(failure.code, "TAX_GRID_INVALID");
            assert_eq!(std::fs::read(&path).unwrap(), b"existing output");
        }
        std::fs::remove_file(path).unwrap();
    }

    fn check_rejected_extension(file_name: &str) {
        let root = std::env::temp_dir().join(format!("tax-extension-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sibling = root.join("chosen.xlsx");
        std::fs::write(&sibling, b"existing workbook").unwrap();
        let table = json!({"companyName":"测试公司","formName":"纳税调整项目明细表",
            "sourceFile":"测试.pdf","pages":[1],"rows":[["项目","金额"],["项目一",1]]});
        let requested = root.join(file_name);
        let result = crate::audipick::call("audipick.tax_export",
            json!({"outputPath":requested,"tables":[table]}), json!({}));
        // The old implementation silently writes chosen.xlsx instead.
        // Require an error before either the chosen or sibling path is touched.
        assert!(result.is_err(), "非 .xlsx 目标不得悄悄更换保存路径：{result:?}");
        assert_eq!(result.unwrap_err().code, "TAX_OUTPUT_EXTENSION_INVALID");
        assert!(!requested.exists());
        assert_eq!(std::fs::read(&sibling).unwrap(), b"existing workbook");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tax_export_rejects_extensionless_target_without_touching_sibling_workbook() {
        check_rejected_extension("chosen");
    }

    #[test]
    fn tax_export_rejects_other_extension_without_touching_sibling_workbook() {
        check_rejected_extension("chosen.txt");
    }

    #[test]
    fn tax_export_accepts_explicit_uppercase_extension_without_renaming() {
        let root = std::env::temp_dir().join(format!("tax-extension-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let table = json!({"companyName":"测试公司","formName":"纳税调整项目明细表",
            "sourceFile":"测试.pdf","pages":[1],"rows":[["项目","金额"],["项目一",1]]});
        let explicit = root.join("explicit.XLSX");
        let result = crate::audipick::call("audipick.tax_export",
            json!({"outputPath":explicit,"tables":[table]}), json!({})).unwrap();
        assert_eq!(result["outputPath"], explicit.to_string_lossy().as_ref());
        assert!(explicit.is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}
