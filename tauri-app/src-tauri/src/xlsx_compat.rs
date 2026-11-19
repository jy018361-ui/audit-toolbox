//! SAP exports can label the first row `r="0"` while its cells use A1, B1, ... .
//! Repair only that unambiguous header in a cached package for third-party readers.
//! The native row stream applies the same rule without copying the workbook.
use crate::AppError;
use quick_xml::{Reader, events::Event};
use std::{
    fs,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

fn invalid(detail: impl ToString) -> AppError {
    AppError::new(
        "XLSX_ROW_INVALID",
        "工作表行号无效或顺序异常，请检查文件。",
        true,
        Some(detail.to_string()),
    )
}

pub(crate) fn is_first_row_cell(reference: &str) -> bool {
    let letters = reference.bytes().take_while(u8::is_ascii_uppercase).count();
    letters > 0
        && letters <= 3
        && &reference[letters..] == "1"
        && reference[..letters]
            .bytes()
            .fold(0usize, |n, c| n * 26 + (c - b'A' + 1) as usize)
            <= 16384
}

// Bound inspection to the header, never deserialize a whole large worksheet.
fn header_patch(input: impl Read) -> Result<Option<(u64, u64, Vec<u8>)>, AppError> {
    let mut reader = Reader::from_reader(BufReader::new(input.take(8 * 1024 * 1024)));
    let mut buf = Vec::new();
    let mut patch = None;
    let mut cells = 0;
    loop {
        let position = reader.buffer_position();
        let event = reader.read_event_into(&mut buf).map_err(invalid)?;
        match event {
            Event::Start(ref e) if e.local_name().as_ref() == b"row" => {
                let value = e.try_get_attribute(b"r").map_err(invalid)?;
                if value.as_ref().is_none_or(|v| v.value.as_ref() != b"0") {
                    return Ok(None);
                }
                let mut fixed = e.to_owned();
                fixed.clear_attributes();
                for a in e.attributes() {
                    let a = a.map_err(invalid)?;
                    if a.key.as_ref() == b"r" {
                        fixed.push_attribute(("r", "1"));
                    } else {
                        fixed.push_attribute(a);
                    }
                }
                let mut writer = quick_xml::Writer::new(Vec::new());
                writer.write_event(Event::Start(fixed)).map_err(invalid)?;
                patch = Some((position, reader.buffer_position(), writer.into_inner()));
            }
            Event::Start(ref e) | Event::Empty(ref e)
                if patch.is_some() && e.local_name().as_ref() == b"c" =>
            {
                let reference = e
                    .try_get_attribute(b"r")
                    .map_err(invalid)?
                    .ok_or_else(|| invalid("第 0 行含有未标明地址的单元格"))?;
                if !is_first_row_cell(std::str::from_utf8(&reference.value).map_err(invalid)?) {
                    return Err(invalid("第 0 行的单元格地址未一致指向第 1 行"));
                }
                cells += 1;
            }
            Event::End(ref e) if e.local_name().as_ref() == b"row" && patch.is_some() => {
                return if cells > 0 {
                    Ok(patch)
                } else {
                    Err(invalid("第 0 行没有明确的单元格地址"))
                };
            }
            Event::Empty(ref e) if e.local_name().as_ref() == b"row" => {
                return if e
                    .try_get_attribute(b"r")
                    .map_err(invalid)?
                    .is_some_and(|a| a.value.as_ref() == b"0")
                {
                    Err(invalid("第 0 行没有明确的单元格地址"))
                } else {
                    Ok(None)
                };
            }
            Event::Eof => {
                return if patch.is_some() {
                    Err(invalid("第 0 行表头不完整或超过读取预算"))
                } else {
                    Ok(None)
                };
            }
            _ => {}
        }
        buf.clear();
    }
}

pub(crate) fn compatible_path(path: &Path) -> Result<PathBuf, AppError> {
    if !path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx") || e.eq_ignore_ascii_case("xlsm"))
    {
        return Ok(path.into());
    }
    let key = crate::disk_table::fingerprint(path, "xlsx-zero-header-v1", 0, 0)?;
    let directory = crate::tabular::cache_root()?.join("tables/xlsx-zero-header-v1");
    let extension = path
        .extension()
        .unwrap()
        .to_string_lossy()
        .to_ascii_lowercase();
    let output = directory.join(format!("{key}.{extension}"));
    if output.is_file() {
        return Ok(output);
    }
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(invalid)?).map_err(invalid)?;
    let mut patches = std::collections::HashMap::new();
    // Do not impose the lightweight workbook-metadata parser's restrictions on
    // all Calamine consumers (e.g. valid namespace-prefixed workbook metadata).
    let entries = zip
        .file_names()
        .filter(|name| name.starts_with("xl/worksheets/") && name.ends_with(".xml"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for entry in entries {
        if let Some(patch) = header_patch(zip.by_name(&entry).map_err(invalid)?)? {
            patches.insert(entry, patch);
        }
    }
    if patches.is_empty() {
        return Ok(path.into());
    }
    fs::create_dir_all(&directory).map_err(invalid)?;
    let partial = directory.join(format!(
        "{key}-{}.partial.{extension}",
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut writer = zip::ZipWriter::new(fs::File::create(&partial).map_err(invalid)?);
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(invalid)?;
            if let Some((start, end, replacement)) = patches.get(entry.name()) {
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(entry.compression());
                writer.start_file(entry.name(), options).map_err(invalid)?;
                std::io::copy(&mut Read::by_ref(&mut entry).take(*start), &mut writer)
                    .map_err(invalid)?;
                std::io::copy(
                    &mut Read::by_ref(&mut entry).take(end - start),
                    &mut std::io::sink(),
                )
                .map_err(invalid)?;
                writer.write_all(replacement).map_err(invalid)?;
                std::io::copy(&mut entry, &mut writer).map_err(invalid)?;
            } else {
                writer.raw_copy_file(entry).map_err(invalid)?;
            }
        }
        writer.finish().map_err(invalid)?;
        if crate::disk_table::fingerprint(path, "xlsx-zero-header-v1", 0, 0)? != key {
            return Err(invalid("读取期间源文件发生变化，请重试"));
        }
        // Concurrent readers can finish the same immutable source snapshot.
        if output.is_file() {
            fs::remove_file(&partial).map_err(invalid)?;
        } else if let Err(err) = fs::rename(&partial, &output) {
            if output.is_file() {
                fs::remove_file(&partial).map_err(invalid)?;
            } else {
                return Err(invalid(err));
            }
        }
        Ok(output)
    })();
    if result.is_err() {
        let _ = fs::remove_file(partial);
    }
    result
}

pub(crate) fn normalize_header_prefix(mut bytes: Vec<u8>) -> Result<Vec<u8>, AppError> {
    if let Some((start, end, replacement)) = header_patch(bytes.as_slice())? {
        bytes.splice(start as usize..end as usize, replacement);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zero_header_prefix_only_repairs_evidenced_first_row() {
        let xml = br#"<worksheet><sheetData><row r="0" spans=""><c r="A1"/><c r="XFD1"/></row><row r="2"><c r="A2"><v>42</v></c></row></sheetData></worksheet>"#;
        let normalized = normalize_header_prefix(xml.to_vec()).unwrap();
        assert_eq!(
            String::from_utf8(normalized).unwrap(),
            String::from_utf8_lossy(xml).replacen("r=\"0\"", "r=\"1\"", 1)
        );
        for cells in [
            "",
            "<c/>",
            "<c r=\"A0\"/>",
            "<c r=\"A2\"/>",
            "<c r=\"XFE1\"/>",
        ] {
            let xml =
                format!("<worksheet><sheetData><row r=\"0\">{cells}</row></sheetData></worksheet>");
            assert_eq!(
                normalize_header_prefix(xml.into_bytes()).unwrap_err().code,
                "XLSX_ROW_INVALID"
            );
        }
        let normal = b"<worksheet><sheetData><row r=\"1\"><c r=\"A1\"/></row>";
        assert_eq!(normalize_header_prefix(normal.to_vec()).unwrap(), normal);
    }
}
