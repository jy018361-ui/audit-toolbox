use super::*;
use std::io::Write;

fn fixture(path: &Path, worksheet: &str, strings: Option<&str>) {
    let mut book = rust_xlsxwriter::Workbook::new();
    book.add_worksheet()
        .write_string(0, 0, "placeholder")
        .unwrap();
    book.save(path).unwrap();
    let mut source = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let tmp = path.with_extension("new");
    let mut target = zip::ZipWriter::new(fs::File::create(&tmp).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for i in 0..source.len() {
        let mut entry = source.by_index(i).unwrap();
        target.start_file(entry.name(), options).unwrap();
        if entry.name() == "xl/worksheets/sheet1.xml" {
            target.write_all(worksheet.as_bytes()).unwrap();
        } else if entry.name() == "xl/sharedStrings.xml" && strings.is_some() {
            target.write_all(strings.unwrap().as_bytes()).unwrap();
        } else {
            std::io::copy(&mut entry, &mut target).unwrap();
        }
    }
    target.finish().unwrap();
    drop(source);
    fs::remove_file(path).unwrap();
    fs::rename(tmp, path).unwrap();
}

#[test]
fn disk_xlsx_string_space_escapes_and_empty_cells_match_calamine() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("文本语义.xlsx");
    let strings = r#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>  首尾_x000D_中文  </t></si><si><r><t>  A </t></r><r><t xml:space="preserve"> B_x005F_x000D_ </t></r><rPh sb="0" eb="1"><t>拼音</t></rPh></si><si/><si><t xml:space="preserve"> &#xA0;保留&#xA0; </t></si></sst>"#;
    let worksheet = r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:K1"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><v>重复缓存不计入</v><is><r><t>  内联_x000D_ </t></r><r><t xml:space="preserve"> 保留_x005F_x000D_ </t></r><rPh sb="0" eb="1"><t>忽略</t></rPh></is></c><c r="D1" t="s"><v/></c><c r="E1" t="b"><v></v></c><c r="F1"><v>隐式文本</v></c><c r="G1" t="str"><v> &#xA0;缓存值 </v></c><c r="H1" t="s"><v>3</v></c><c r="I1" t="s"><v>2</v></c><c r="J1" t="e"><v/></c><c r="K1" t="b"><v>1</v></c></row></sheetData></worksheet>"#;
    fixture(&path, worksheet, Some(strings));
    let mut book = calamine::open_workbook_auto(&path).unwrap();
    let expected = book
        .worksheet_range("Sheet1")
        .unwrap()
        .rows()
        .map(|r| r.iter().map(crate::fx::data_text).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut actual = Vec::new();
    visit(&path, "Sheet1", &AtomicBool::new(false), false, |row, _| {
        actual.push(row);
        Ok(())
    })
    .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(actual[0][0], "首尾\r中文");
    assert_eq!(actual[0][1], "A B_x000D_ ");
    assert_eq!(actual[0][2], "内联\r 保留_x000D_ ");
}

#[test]
fn disk_xlsx_cancel_and_token_budget_before_expansion() {
    let active = AtomicBool::new(false);
    let input = vec![b'x'; MAX_ROW_BYTES + 8192];
    let (mut xml, used) = reader(input.as_slice(), &active);
    let mut buffer = Vec::new();
    used.set(0);
    let err = xml.read_event_into(&mut buffer).unwrap_err();
    assert!(err.to_string().contains("安全预算"));
    assert!(buffer.len() <= MAX_ROW_BYTES + 4096);
    let (mut xml, _) = reader(b"<a/>".as_slice(), &active);
    active.store(true, Ordering::Relaxed);
    assert_eq!(
        stream_error(xml.read_event_into(&mut Vec::new()).unwrap_err(), &active).code,
        "JOB_CANCELLED"
    );

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("取消间隔.xlsx");
    fixture(
        &path,
        r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1024"/></sheetData></worksheet>"#,
        None,
    );
    active.store(false, Ordering::Relaxed);
    let mut rows = 0;
    let err = visit(&path, "Sheet1", &active, false, |_, _| {
        rows += 1;
        if rows == 1 {
            active.store(true, Ordering::Relaxed);
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(err.code, "JOB_CANCELLED");
    assert!(rows <= 256);
}

#[test]
fn disk_xlsx_rejects_out_of_order_and_out_of_range_rows() {
    let dir = tempfile::tempdir().unwrap();
    for (i, body) in [
        r#"<row r="0"/>"#,
        r#"<row r="1048577"/>"#,
        r#"<row r="2"/><row r="1"/>"#,
    ]
    .iter()
    .enumerate()
    {
        let path = dir.path().join(format!("异常行{i}.xlsx"));
        fixture(
            &path,
            &format!(
                r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>"#
            ),
            None,
        );
        let err = visit(&path, "Sheet1", &AtomicBool::new(false), false, |_, _| {
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code, "XLSX_ROW_INVALID");
    }
}
