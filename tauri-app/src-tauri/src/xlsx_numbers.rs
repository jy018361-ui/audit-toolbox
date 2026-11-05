//! Opt-in number formatting for generated Excel reports. Source identifiers,
//! dates and rates stay on their existing text/specialized formatting paths.

pub(crate) const NUMBER_FORMAT: &str = "#,##0.###############";

pub(crate) fn number_format() -> &'static rust_xlsxwriter::Format {
    static FORMAT: std::sync::OnceLock<rust_xlsxwriter::Format> = std::sync::OnceLock::new();
    FORMAT.get_or_init(|| rust_xlsxwriter::Format::new().set_num_format(NUMBER_FORMAT))
}

pub(crate) fn integer_format() -> &'static rust_xlsxwriter::Format {
    static FORMAT: std::sync::OnceLock<rust_xlsxwriter::Format> = std::sync::OnceLock::new();
    FORMAT.get_or_init(|| rust_xlsxwriter::Format::new().set_num_format("#,##0"))
}

pub(crate) fn text_header(header: &str) -> bool {
    let lower = header.to_lowercase();
    [
        "编号", "编码", "代码", "卡片号", "账号", "帐号", "账户号", "行号", "序号",
        "日期", "时间", "年度", "年份", "期间", "月份", "code", "coding", "率", "比例", "%",
    ].iter().any(|part| lower.contains(part))
        || lower.split(|c: char| !c.is_ascii_alphanumeric()).any(|part|
            ["id", "date", "time", "year", "period", "month", "rate", "ratio", "percent"].contains(&part))
        || ["Id", "ID", "Date", "Time", "Year", "Period", "Rate", "Ratio", "Percent"].iter().any(|suffix| header.ends_with(suffix))
}

/// Convert only plain, finite, Excel-safe numeric text. Keep leading zeros and
/// long identifiers/precise decimals intact rather than silently losing digits.
pub(crate) fn number_from_text(header: &str, text: &str) -> Option<f64> {
    if text_header(header) { return None; }
    let text = text.trim();
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned.is_empty()
        || unsigned.chars().any(|c| !c.is_ascii_digit() && c != '.' && c != ',')
        || unsigned.chars().filter(char::is_ascii_digit).count() > 15
    { return None; }
    let integer = unsigned.split('.').next()?;
    if integer.len() > 1 && integer.starts_with('0') { return None; }
    if unsigned.contains(',') {
        let mut groups = integer.split(',');
        let first = groups.next()?;
        if first.is_empty() || first.len() > 3
            || groups.any(|group| group.len() != 3)
            || unsigned.split('.').skip(1).any(|part| part.contains(','))
        { return None; }
    }
    text.replace(',', "").parse::<f64>().ok().filter(|n| n.is_finite())
}

/// Multi-sheet copying keeps formulas, objects and worksheet XML intact. Only
/// ordinary numeric styles are changed; date, percent, text and currency styles
/// with their own specialized patterns are preserved.
pub(crate) fn normalize_copied_workbook(
    path: &std::path::Path,
    checkpoint: &dyn Fn() -> Result<(), crate::AppError>,
) -> Result<(), crate::AppError> {
    use std::io::{Read, Write};
    let fail = |error: &dyn std::fmt::Display| crate::AppError::new(
        "XLSX_NUMBER_FORMAT_FAILED", "设置 Excel 千分位格式失败。", true, Some(error.to_string()));
    checkpoint()?;
    let mut source = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| fail(&e))?).map_err(|e| fail(&e))?;
    let mut styles = String::new();
    source.by_name("xl/styles.xml").map_err(|e| fail(&e))?.read_to_string(&mut styles).map_err(|e| fail(&e))?;
    let styles = copied_number_styles(&styles);
    struct PartialFile(std::path::PathBuf);
    impl Drop for PartialFile {
        fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
    }
    let temporary = PartialFile(path.with_file_name(format!("xlsx-numbers-{}.partial.xlsx", uuid::Uuid::new_v4())));
    let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary.0).map_err(|e| fail(&e))?;
    {
        let mut output = zip::ZipWriter::new(file);
        for index in 0..source.len() {
            checkpoint()?;
            let entry = source.by_index(index).map_err(|e| fail(&e))?;
            if entry.name() == "xl/styles.xml" {
                output.start_file("xl/styles.xml", zip::write::SimpleFileOptions::default().compression_method(entry.compression())).map_err(|e| fail(&e))?;
                output.write_all(styles.as_bytes()).map_err(|e| fail(&e))?;
            } else {
                output.raw_copy_file(entry).map_err(|e| fail(&e))?;
            }
        }
        output.finish().map_err(|e| fail(&e))?;
    }
    drop(source);
    checkpoint()?;
    crate::fa::replace_output(&temporary.0, path)?;
    Ok(())
}

fn copied_number_styles(styles: &str) -> String {
    use regex::{Captures, Regex};
    let ids = Regex::new(r#"numFmtId="(\d+)""#).unwrap();
    let next_id = ids.captures_iter(styles).filter_map(|c| c[1].parse::<u32>().ok()).max().unwrap_or(163).max(163) + 1;
    let xf = Regex::new(r#"<xf\b[^>]*>"#).unwrap();
    let plain_id = Regex::new(r#"numFmtId="([012])""#).unwrap();
    let apply = Regex::new(r#"applyNumberFormat="[01]""#).unwrap();
    let mut styles = xf.replace_all(styles, |c: &Captures<'_>| {
        let tag = &c[0];
        if !plain_id.is_match(tag) { return tag.to_owned(); }
        let tag = plain_id.replace(tag, |c: &Captures<'_>| format!("numFmtId=\"{}\"", match &c[1] { "1" => 3, "2" => 4, _ => next_id })).into_owned();
        if apply.is_match(&tag) { apply.replace(&tag, "applyNumberFormat=\"1\"").into_owned() }
        else { tag.replacen("<xf ", "<xf applyNumberFormat=\"1\" ", 1) }
    }).into_owned();
    // An explicit plain decimal format retains exactly its existing precision.
    let plain_code = Regex::new(r#"formatCode="0(\.[0#?]+)?""#).unwrap();
    styles = plain_code.replace_all(&styles, |c: &Captures<'_>| format!("formatCode=\"#,##0{}\"", c.get(1).map_or("", |m| m.as_str()))).into_owned();
    let entry = format!("<numFmt numFmtId=\"{next_id}\" formatCode=\"{NUMBER_FORMAT}\"/>");
    let formats = Regex::new(r#"<numFmts\b[^>]*>"#).unwrap();
    if let Some(tag) = formats.find(&styles) {
        let count = Regex::new(r#"count="\d+""#).unwrap();
        let body = if tag.as_str().ends_with("/>") { "" } else {
            styles[tag.end()..].split("</numFmts>").next().unwrap_or("")
        };
        let total = Regex::new(r#"<numFmt\s"#).unwrap().find_iter(body).count() + 1;
        let opening = count.replace(tag.as_str(), format!("count=\"{total}\"")).into_owned();
        if opening.ends_with("/>") {
            let replacement = format!("{}>{entry}</numFmts>", opening.trim_end_matches("/>"));
            styles.replace_range(tag.range(), &replacement);
        } else {
            styles.replace_range(tag.range(), &opening);
            styles = styles.replacen("</numFmts>", &format!("{entry}</numFmts>"), 1);
        }
    } else {
        styles = styles.replacen("<fonts", &format!("<numFmts count=\"1\">{entry}</numFmts><fonts"), 1);
    }
    styles
}

#[cfg(test)]
pub(crate) fn assert_cell_format(bytes: &[u8], sheet: usize, cell: &str, expected: &str) {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut styles = String::new();
    zip.by_name("xl/styles.xml").unwrap().read_to_string(&mut styles).unwrap();
    let mut xml = String::new();
    zip.by_name(&format!("xl/worksheets/sheet{sheet}.xml")).unwrap().read_to_string(&mut xml).unwrap();
    let tag = xml.split(&format!("<c r=\"{cell}\"")).nth(1).expect("cell exists").split('>').next().unwrap();
    let style: usize = tag.split(" s=\"").nth(1).map(|v| v.split('"').next().unwrap().parse().unwrap()).unwrap_or(0);
    let xfs = styles.split("<cellXfs").nth(1).unwrap().split("</cellXfs>").next().unwrap();
    let xf = xfs.split("<xf ").nth(style + 1).unwrap().split('>').next().unwrap();
    let id = xf.split("numFmtId=\"").nth(1).unwrap().split('"').next().unwrap();
    let actual = if id == "0" { "General" } else if id == "3" { "#,##0" } else if id == "4" { "#,##0.00" } else {
        styles.split(&format!("<numFmt numFmtId=\"{id}\" formatCode=\"")).nth(1).unwrap().split('"').next().unwrap()
    };
    assert_eq!(actual, expected, "sheet{sheet}!{cell}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thousands_copied_workbook_preserves_every_other_part_and_special_formats() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        use std::io::Read;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("复制工作簿.xlsx");
        let mut book = Workbook::new();
        let sheet = book.add_worksheet();
        sheet.write_number(0, 0, 1234567.89123).unwrap();
        sheet.write_number_with_format(0, 1, 1234.56, &Format::new().set_num_format("0.00")).unwrap();
        sheet.write_number_with_format(0, 2, 0.035, &Format::new().set_num_format("0.0000%")).unwrap();
        sheet.write_datetime_with_format(0, 3, &ExcelDateTime::from_ymd(2026, 11, 5).unwrap(), &Format::new().set_num_format("yyyy-mm-dd")).unwrap();
        sheet.write_string(0, 4, "001234").unwrap();
        sheet.write_formula(0, 5, "=A1+B1").unwrap();
        sheet.write_number_with_format(0, 6, 1234.12345, &Format::new().set_num_format("0.00000")).unwrap();
        book.save(&path).unwrap();
        let original = std::fs::read(&path).unwrap();
        normalize_copied_workbook(&path, &|| Ok(())).unwrap();
        let result = std::fs::read(&path).unwrap();
        for (cell, expected) in [("A1", NUMBER_FORMAT), ("B1", "#,##0.00"), ("C1", "0.0000%"),
            ("D1", "yyyy-mm-dd"), ("F1", NUMBER_FORMAT), ("G1", "#,##0.00000")] {
            assert_cell_format(&result, 1, cell, expected);
        }
        let mut before = zip::ZipArchive::new(std::io::Cursor::new(original)).unwrap();
        let mut after = zip::ZipArchive::new(std::io::Cursor::new(result)).unwrap();
        assert_eq!(before.len(), after.len());
        for index in 0..before.len() {
            let mut entry = before.by_index(index).unwrap();
            if entry.name() == "xl/styles.xml" { continue; }
            let mut a = Vec::new(); let mut b = Vec::new();
            let mut copied = after.by_name(entry.name()).unwrap();
            entry.read_to_end(&mut a).unwrap(); copied.read_to_end(&mut b).unwrap();
            assert_eq!(a, b, "{} must remain byte-for-byte unchanged", entry.name());
        }
    }

    #[test]
    fn thousands_copied_styles_without_custom_formats_get_a_valid_format_table() {
        let xml = r#"<styleSheet><fonts count="1"/><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>"#;
        for xml in [xml.to_owned(), xml.replace("<fonts", "<numFmts count=\"0\"/><fonts")] {
            let output = copied_number_styles(&xml);
            assert!(output.contains("<numFmts count=\"1\"><numFmt"));
            assert!(output.contains("formatCode=\"#,##0.###############\""));
            assert_eq!(output.matches("numFmtId=\"164\"").count(), 3);
            let mut reader = quick_xml::Reader::from_str(&output);
            loop { if matches!(reader.read_event().unwrap(), quick_xml::events::Event::Eof) { break; } }
        }
        let with_conditional_format = r#"<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="1"/><cellXfs count="1"><xf numFmtId="164"/></cellXfs><dxfs count="1"><dxf><numFmt numFmtId="165" formatCode="0.00"/></dxf></dxfs></styleSheet>"#;
        let output = copied_number_styles(with_conditional_format);
        assert!(output.contains("<numFmts count=\"2\">"));
        assert!(output.contains("<dxfs count=\"1\">"));
    }

    #[test]
    fn thousands_text_conversion_preserves_identifiers_dates_rates_and_precision() {
        assert_eq!(number_from_text("原值", "1,234,567.89"), Some(1234567.89));
        assert_eq!(number_from_text("数量", "-1234"), Some(-1234.0));
        assert_eq!(number_from_text("paid_amount", "1234.56"), Some(1234.56));
        assert_eq!(number_from_text("candidate_amount", "1234.56"), Some(1234.56));
        for (header, text) in [
            ("资产编号", "123456"), ("银行账号", "123456"), ("日期", "45000"),
            ("年度", "2026"), ("利率", "0.035"), ("比例", "0.05"),
            ("contractId", "1234"), ("contract_id", "1234"), ("taxRate", "0.13"),
            ("值", "00123"), ("值", "1234567890123456"), ("值", "1,2,3"),
            ("值", "NaN"), ("值", "1,234.5,67"), ("值", ""),
        ] { assert_eq!(number_from_text(header, text), None, "{header}: {text}"); }
    }
}
