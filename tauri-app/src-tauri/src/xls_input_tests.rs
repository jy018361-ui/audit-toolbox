//! Cross-tool input contract. Fixtures contain synthetic values only.
use crate::{
    confirmation, deposit_interest, fa, fa_subtools, fuzzy_match, fx, loan_interest, tabular,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    sync::{Arc, atomic::AtomicBool},
};

fn check(label: &str, result: Result<Value, crate::AppError>) {
    let value = result.unwrap_or_else(|err| panic!("{label}: {} ({})", err.user_message, err.code));
    let rendered = value.to_string();
    assert!(
        rendered.contains("001"),
        "{label}: leading-zero ID lost: {value}"
    );
    assert!(rendered.contains("123.5"), "{label}: amount lost: {value}");
}

fn check_tools(path: &Path) {
    let source = json!({"inputPath":path, "headerRow":1, "headerDepth":1});
    check(
        "FA List / 政策对比",
        fa::call(
            "fa.inspect",
            json!({"beginPath":path,"endPath":path,"beginHeaderRow":1,"endHeaderRow":1}),
        ),
    );
    check(
        "折旧测算",
        fa_subtools::call("fa.dep_inspect", json!({"path":path,"headerRow":1})),
    );
    for kind in ["je", "tb"] {
        check(
            &format!("汇兑 {kind}"),
            fx::call(&format!("fx.inspect_{kind}"), json!({"source":source})),
        );
        check(
            &format!("存款 / FA TBJE {kind}"),
            deposit_interest::call(&format!("deposit.inspect_{kind}"), json!({"source":source})),
        );
    }
    for kind in ["ledger", "tb", "je", "rateLedger"] {
        check(
            &format!("借款 {kind}"),
            loan_interest::call("loan.inspect", json!({"source":source,"kind":kind})),
        );
    }
    check(
        "两列模糊匹配",
        fuzzy_match::call("fuzzy.inspect", json!({"source":source})),
    );
    for method in ["ts.inspect", "kanzhang.inspect"] {
        check(method, tabular::call(method, source.clone()));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let pause = crate::excel_merger::PauseCheckpoint::unpaused(cancel.clone());
    check(
        "正负数凭证标记",
        tabular::run_job(
            "kanzhang.mark_inspect",
            source.clone(),
            &|_, _, _, _| {},
            cancel,
            &pause,
        ),
    );
    check(
        "函证进度",
        confirmation::call("confirmation.inspect", json!({"inputPath":path})),
    );
    let table = tabular::fx_load_ledger_table_value_cached(path, None, 1);
    // TBJE's confirmed-data route must decode the same original file through Polars.
    check("TBJE 正式读取", table);
}

#[test]
fn xls_inputs_all_data_tools_accept_real_biff8_and_disguised_text() {
    let root = std::env::temp_dir().join(format!("audit-all-xls-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let binary = root.join("真正.XLS");
    fs::write(
        &binary,
        include_bytes!("../../tests/fixtures/Excel Merger/simple-biff8.xls"),
    )
    .unwrap();
    check_tools(&binary);
    let text = "编号\t金额\r\n001\t123.5\r\n";
    let inputs = [
        encoding_rs::GBK.encode(text).0.into_owned(),
        [vec![0xEF, 0xBB, 0xBF], text.as_bytes().to_vec()].concat(),
        [
            vec![0xFF, 0xFE],
            text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
        ]
        .concat(),
    ];
    for (index, bytes) in inputs.into_iter().enumerate() {
        let path = root.join(format!("文本{index}.XLS"));
        fs::write(&path, bytes).unwrap();
        check_tools(&path);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn xls_inputs_all_data_tools_accept_spreadsheetml() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("NetSuite.XLS");
    fs::write(
        &path,
        include_bytes!("../../tests/fixtures/Excel Merger/spreadsheetml.xml.xls"),
    )
    .unwrap();
    assert!(crate::spreadsheet_input::is_xml_workbook(&path));
    assert!(!crate::spreadsheet_input::is_text(&path));
    check_tools(&path);
    let inspected =
        crate::excel_merger::call("excel_merger.inspect", json!({"inputPaths":[path]})).unwrap();
    assert!(inspected.to_string().contains("Data"));
    for (direction, extension) in [
        ("vertical", "csv"),
        ("vertical", "xlsx"),
        ("horizontal", "xlsx"),
    ] {
        let output = root.path().join(format!("{direction}.{extension}"));
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = crate::excel_merger::PauseCheckpoint::unpaused(cancel.clone());
        let result = crate::excel_merger::merge(json!({
            "inputPaths":[path], "outputPath":output, "outputFormat":extension,
            "outputMode":"one_sheet", "direction":direction, "sheetAction":"default", "addHyperlinks":false
        }), &|_,_,_,_|{}, cancel, &pause).unwrap();
        assert!(result["outputPaths"].as_array().unwrap().len() > 0);
        let rows = if extension == "csv" {
            crate::spreadsheet_input::read_rows(&output).unwrap()
        } else {
            use calamine::Reader;
            let mut workbook = crate::spreadsheet_input::open_workbook_auto(&output).unwrap();
            let selected = workbook.sheet_names()[0].clone();
            workbook
                .worksheet_range(&selected)
                .unwrap()
                .rows()
                .map(|row| row.iter().map(crate::fx::data_text).collect())
                .collect::<Vec<Vec<String>>>()
        };
        let rendered = format!("{rows:?}");
        assert!(rendered.contains("001") && rendered.contains("123.5"));
    }
    let source = fs::read(&path).unwrap();
    let converted = crate::spreadsheet_xml::data_copy(&path).unwrap();
    assert_eq!(converted, crate::spreadsheet_xml::data_copy(&path).unwrap());
    assert_eq!(fs::read(&path).unwrap(), source);
}

#[test]
#[ignore = "requires desktop Microsoft Excel for layout-preserving XML templates"]
fn xls_inputs_spreadsheetml_template_preserves_formula_style_and_merge() {
    use calamine::Reader;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("模板.XLS");
    let xml = r#"<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="bold"><Font ss:Bold="1"/><NumberFormat ss:Format="0.00"/></Style></Styles><Worksheet ss:Name="模板"><Table><Column ss:Width="140"/><Row><Cell ss:StyleID="bold"><Data ss:Type="Number">123.5</Data></Cell><Cell ss:Formula="=RC[-1]*2"><Data ss:Type="Number">247</Data></Cell></Row><Row><Cell ss:MergeAcross="1"><Data ss:Type="String">合并标题</Data></Cell></Row></Table></Worksheet></Workbook>"#;
    fs::write(&path, xml).unwrap();
    let converted;
    {
        let prepared = crate::spreadsheet_input::prepare_xlsx(&path).unwrap();
        converted = prepared.path().to_path_buf();
        let mut book = calamine::open_workbook_auto(&converted).unwrap();
        assert_eq!(
            book.worksheet_formula("模板")
                .unwrap()
                .get_value((0, 1))
                .unwrap(),
            "A1*2"
        );
        assert_eq!(
            book.worksheet_range("模板")
                .unwrap()
                .get_value((0, 0))
                .unwrap(),
            &calamine::Data::Float(123.5)
        );
        let styled = umya_spreadsheet::reader::xlsx::read(&converted).unwrap();
        let sheet = styled.get_sheet_by_name("模板").unwrap();
        assert!(
            sheet
                .get_cell("A1")
                .unwrap()
                .get_style()
                .get_font()
                .unwrap()
                .get_bold()
        );
        assert!(
            sheet
                .get_merge_cells()
                .iter()
                .any(|range| range.range() == "A2:B2")
        );
    }
    assert!(!converted.exists());
    assert_eq!(fs::read_to_string(&path).unwrap(), xml);
}

#[test]
#[ignore = "set XML_WORKBOOK_SAMPLE to a local NetSuite export; no business data is committed"]
fn xls_inputs_real_spreadsheetml_reads_through_kanzhang_and_stream() {
    let path = std::env::var_os("XML_WORKBOOK_SAMPLE")
        .map(std::path::PathBuf::from)
        .expect("XML_WORKBOOK_SAMPLE");
    let value = tabular::call("kanzhang.inspect", json!({"inputPath":path,"headerRow":0})).unwrap();
    let selected = value["selectedSheet"].as_str().unwrap();
    let mut rows = 0;
    crate::disk_table::for_each_source_row(
        &path,
        Some(selected),
        &AtomicBool::new(false),
        |_, _| {
            rows += 1;
            Ok(())
        },
    )
    .unwrap();
    assert!(rows > 1);
    println!(
        "XML workbook: physical rows={rows}, dimensions={}",
        value["dimensions"]
    );
}

#[test]
fn xls_inputs_template_text_conversion_preserves_values_and_cleans_up() {
    use calamine::Reader;
    let root = std::env::temp_dir().join(format!("audit-template-xls-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("模板.XLS");
    fs::write(
        &source,
        encoding_rs::GBK
            .encode("编号\t金额\n001\t123.5\n")
            .0
            .as_ref(),
    )
    .unwrap();
    let derived;
    {
        let prepared = crate::spreadsheet_input::prepare_xlsx(&source).unwrap();
        derived = prepared.path().to_path_buf();
        let mut workbook = calamine::open_workbook_auto(&derived).unwrap();
        let cells = workbook.worksheet_range("CSV").unwrap();
        assert_eq!(cells.get_value((1, 0)).unwrap().to_string(), "001");
        assert_eq!(cells.get_value((1, 1)).unwrap().to_string(), "123.5");
    }
    assert!(!derived.exists());
    assert!(source.exists());
    fs::write(&source, "名称\n甲公司\n乙公司\n").unwrap();
    assert!(crate::spreadsheet_input::is_text(&source));
    assert_eq!(
        crate::spreadsheet_input::read_rows(&source).unwrap()[2],
        vec!["乙公司"]
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "requires desktop Microsoft Excel"]
fn xls_inputs_binary_template_conversion_preserves_formulas_and_styles() {
    use calamine::Reader;
    let root = std::env::temp_dir().join(format!("audit-template-com-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("格式.XLS");
    fs::write(
        &source,
        include_bytes!("../../tests/fixtures/Excel Merger/formatted-biff8.xls"),
    )
    .unwrap();
    let prepared = crate::spreadsheet_input::prepare_xlsx(&source).unwrap();
    let mut book = calamine::open_workbook_auto(prepared.path()).unwrap();
    assert_eq!(
        book.worksheet_formula("模板")
            .unwrap()
            .get_value((0, 1))
            .unwrap(),
        "A1*2"
    );
    let styled = umya_spreadsheet::reader::xlsx::read(prepared.path()).unwrap();
    let sheet = styled.get_sheet_by_name("模板").unwrap();
    assert!(
        sheet
            .get_cell("A1")
            .unwrap()
            .get_style()
            .get_font()
            .unwrap()
            .get_bold()
    );
    drop(book);
    drop(prepared);
    fs::remove_dir_all(root).unwrap();
}
