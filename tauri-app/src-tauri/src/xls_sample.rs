//! Bounded BIFF8 preview for upload classification. Calamine eagerly parses every
//! XLS sheet when opening the workbook, so it cannot provide a cheap prefix.
//! Unsupported/irregular BIFF files are handed back to the established full reader.
use crate::AppError;
use std::{collections::BTreeMap, fs, io::Read, path::Path};

const MAX_SAMPLE_ROWS: usize = 256;
const MAX_SAMPLE_COLUMNS: usize = 256;
const MAX_SHARED_STRINGS: usize = 1_000_000;

#[derive(Debug)]
pub(crate) struct SheetSample {
    pub(crate) name: String,
    pub(crate) total_rows: usize,
    pub(crate) rows: Vec<(usize, Vec<String>)>,
}

fn invalid(detail: &str) -> AppError {
    AppError::new(
        "WORKBOOK_READ_FAILED",
        "无法快速识别旧式 Excel 工作簿。",
        false,
        Some(detail.to_owned()),
    )
}

fn u16_at(bytes: &[u8], start: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(start..start + 2)?.try_into().ok()?,
    ))
}

fn u32_at(bytes: &[u8], start: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(start..start + 4)?.try_into().ok()?,
    ))
}

fn record(bytes: &[u8], at: usize) -> Option<(u16, &[u8], usize)> {
    let typ = u16_at(bytes, at)?;
    let len = u16_at(bytes, at + 2)? as usize;
    let end = at.checked_add(4)?.checked_add(len)?;
    Some((typ, bytes.get(at + 4..end)?, end))
}

fn unicode_chars(bytes: &[u8], count: usize, wide: bool) -> Option<String> {
    if wide {
        let needed = count.checked_mul(2)?;
        let bytes = bytes.get(..needed)?;
        Some(String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        ))
    } else {
        Some(
            bytes
                .get(..count)?
                .iter()
                .map(|byte| char::from(*byte))
                .collect(),
        )
    }
}

struct Segments<'a> {
    parts: Vec<&'a [u8]>,
    part: usize,
    offset: usize,
}

impl Segments<'_> {
    fn read_exact(&mut self, mut len: usize) -> Option<Vec<u8>> {
        let mut out = Vec::with_capacity(len);
        while len > 0 {
            let current = *self.parts.get(self.part)?;
            if self.offset == current.len() {
                self.part += 1;
                self.offset = 0;
                continue;
            }
            let take = len.min(current.len() - self.offset);
            out.extend_from_slice(&current[self.offset..self.offset + take]);
            self.offset += take;
            len -= take;
        }
        Some(out)
    }

    fn read_string(&mut self) -> Option<String> {
        let header = self.read_exact(3)?;
        let count = u16_at(&header, 0)? as usize;
        let flags = header[2];
        let rich_runs = if flags & 0x08 != 0 {
            u16_at(&self.read_exact(2)?, 0)? as usize
        } else {
            0
        };
        let extra_bytes = if flags & 0x04 != 0 {
            u32_at(&self.read_exact(4)?, 0)? as usize
        } else {
            0
        };
        let mut wide = flags & 1 != 0;
        let mut chars_left = count;
        let mut text = String::new();
        while chars_left > 0 {
            let current = *self.parts.get(self.part)?;
            if self.offset == current.len() {
                self.part += 1;
                self.offset = 0;
                // An SST CONTINUE record starts with the new character width.
                wide = *self.parts.get(self.part)?.first()? & 1 != 0;
                self.offset = 1;
                continue;
            }
            let bytes_per_char = if wide { 2 } else { 1 };
            let take = chars_left.min((current.len() - self.offset) / bytes_per_char);
            if take == 0 {
                return None;
            }
            text.push_str(&unicode_chars(&current[self.offset..], take, wide)?);
            self.offset += take * bytes_per_char;
            chars_left -= take;
        }
        self.read_exact(rich_runs.checked_mul(4)?)?;
        self.read_exact(extra_bytes)?;
        Some(text)
    }
}

fn shared_strings(parts: Vec<&[u8]>) -> Option<Vec<String>> {
    let header = parts.first()?.get(..8)?;
    let count = u32_at(header, 4)? as usize;
    if count > MAX_SHARED_STRINGS {
        return None;
    }
    let mut cursor = Segments {
        parts,
        part: 0,
        offset: 8,
    };
    let mut strings = Vec::with_capacity(count);
    for _ in 0..count {
        strings.push(cursor.read_string()?);
    }
    Some(strings)
}

fn sheet_name(data: &[u8]) -> Option<(usize, String)> {
    let offset = u32_at(data, 0)? as usize;
    let count = *data.get(6)? as usize;
    let wide = data.get(7)? & 1 != 0;
    let name = unicode_chars(data.get(8..)?, count, wide)?;
    Some((offset, name))
}

fn text_number(number: f64, xf: usize, date_xfs: &[bool], epoch_1904: bool) -> String {
    if date_xfs.get(xf).copied().unwrap_or(false) {
        if let Some(date) = super::fx::excel_serial_to_text(number, epoch_1904) {
            return date;
        }
    }
    if number.is_finite() && number.fract() == 0.0 {
        format!("{number:.0}")
    } else {
        number.to_string()
    }
}

fn rk_number(raw: u32) -> f64 {
    let number = if raw & 2 != 0 {
        ((raw as i32) >> 2) as f64
    } else {
        f64::from_bits(((raw & !3) as u64) << 32)
    };
    if raw & 1 != 0 { number / 100.0 } else { number }
}

fn put_cell(
    cells: &mut BTreeMap<usize, BTreeMap<usize, String>>,
    row: usize,
    col: usize,
    value: String,
) {
    if row < MAX_SAMPLE_ROWS && col < MAX_SAMPLE_COLUMNS && !value.is_empty() {
        cells.entry(row).or_default().insert(col, value);
    }
}

fn parse_sheet(
    stream: &[u8],
    offset: usize,
    name: String,
    strings: &[String],
    date_xfs: &[bool],
    epoch_1904: bool,
) -> Option<SheetSample> {
    let mut at = offset;
    let mut total_rows = 0;
    let mut width = 0;
    let mut cells = BTreeMap::<usize, BTreeMap<usize, String>>::new();
    while let Some((typ, data, next)) = record(stream, at) {
        at = next;
        if typ == 0x000A {
            break;
        }
        if typ == 0x0200 && data.len() >= 14 {
            total_rows = u32_at(data, 4)? as usize;
            width = u16_at(data, 10)? as usize;
            continue;
        }
        if data.len() < 6 {
            continue;
        }
        let row = u16_at(data, 0)? as usize;
        if row >= MAX_SAMPLE_ROWS {
            continue;
        }
        let col = u16_at(data, 2)? as usize;
        let xf = u16_at(data, 4)? as usize;
        match typ {
            0x00FD if data.len() >= 10 => {
                let index = u32_at(data, 6)? as usize;
                put_cell(&mut cells, row, col, strings.get(index)?.clone());
            }
            0x0203 if data.len() >= 14 => {
                let number = f64::from_le_bytes(data[6..14].try_into().ok()?);
                put_cell(
                    &mut cells,
                    row,
                    col,
                    text_number(number, xf, date_xfs, epoch_1904),
                );
            }
            0x027E if data.len() >= 10 => {
                let number = rk_number(u32_at(data, 6)?);
                put_cell(
                    &mut cells,
                    row,
                    col,
                    text_number(number, xf, date_xfs, epoch_1904),
                );
            }
            0x00BD if data.len() >= 12 => {
                let last = u16_at(data, data.len() - 2)? as usize;
                for index in col..=last.min(MAX_SAMPLE_COLUMNS - 1) {
                    let pos = 4 + (index - col) * 6;
                    if pos + 6 > data.len() - 2 {
                        break;
                    }
                    let style = u16_at(data, pos)? as usize;
                    let number = rk_number(u32_at(data, pos + 2)?);
                    put_cell(
                        &mut cells,
                        row,
                        index,
                        text_number(number, style, date_xfs, epoch_1904),
                    );
                }
            }
            0x0204 if data.len() >= 9 => {
                let count = u16_at(data, 6)? as usize;
                let wide = data[8] & 1 != 0;
                put_cell(
                    &mut cells,
                    row,
                    col,
                    unicode_chars(&data[9..], count, wide)?,
                );
            }
            0x0006 if data.len() >= 14 && data[12..14] != [0xFF, 0xFF] => {
                let number = f64::from_le_bytes(data[6..14].try_into().ok()?);
                put_cell(
                    &mut cells,
                    row,
                    col,
                    text_number(number, xf, date_xfs, epoch_1904),
                );
            }
            0x0205 if data.len() >= 8 && data[7] == 0 => {
                put_cell(&mut cells, row, col, (data[6] != 0).to_string());
            }
            _ => {}
        }
    }
    let observed_rows = cells.keys().next_back().map_or(0, |row| row + 1);
    total_rows = total_rows.max(observed_rows);
    let observed_width = cells
        .values()
        .filter_map(|row| row.keys().next_back().map(|col| col + 1))
        .max()
        .unwrap_or(0);
    width = width.max(observed_width).min(MAX_SAMPLE_COLUMNS);
    let rows = cells
        .into_iter()
        .map(|(row, values)| {
            let mut line = vec![String::new(); width];
            for (col, value) in values {
                line[col] = value;
            }
            (row + 1, line)
        })
        .collect();
    Some(SheetSample {
        name,
        total_rows,
        rows,
    })
}

/// Read the OLE Workbook stream and materialize at most 256 rows per sheet.
/// The BIFF shared-string table is still read once because cell values index it.
pub(crate) fn read(path: &Path, requested: Option<&str>) -> Result<Vec<SheetSample>, AppError> {
    let file = fs::File::open(path).map_err(|e| invalid(&e.to_string()))?;
    let mut ole = cfb::CompoundFile::open(file).map_err(|e| invalid(&e.to_string()))?;
    let mut workbook = ole
        .open_stream("/Workbook")
        .or_else(|_| ole.open_stream("/Book"))
        .map_err(|e| invalid(&e.to_string()))?;
    let mut stream = Vec::new();
    workbook
        .read_to_end(&mut stream)
        .map_err(|e| invalid(&e.to_string()))?;
    let mut sheets = Vec::new();
    let mut strings = Vec::new();
    let mut date_xfs = Vec::new();
    let mut epoch_1904 = false;
    let mut at = 0;
    let mut biff8 = false;
    while let Some((typ, data, next)) = record(&stream, at) {
        at = next;
        match typ {
            0x0809 => biff8 = u16_at(data, 0) == Some(0x0600),
            0x0085 => sheets.push(sheet_name(data).ok_or_else(|| invalid("Sheet 名称损坏"))?),
            0x0022 => epoch_1904 = u16_at(data, 0) == Some(1),
            0x00E0 => {
                let format = u16_at(data, 2).ok_or_else(|| invalid("单元格格式损坏"))? as usize;
                date_xfs.push(super::fx::xlsx_builtin_format_is_date(format));
            }
            0x00FC => {
                let mut parts = vec![data];
                while let Some((0x003C, continuation, end)) = record(&stream, at) {
                    parts.push(continuation);
                    at = end;
                }
                strings = shared_strings(parts).ok_or_else(|| invalid("共享字符串表损坏"))?;
            }
            0x000A => break,
            _ => {}
        }
    }
    if !biff8 || sheets.is_empty() {
        return Err(invalid("只支持 BIFF8 工作簿的快速采样"));
    }
    let chosen = sheets
        .iter()
        .filter(|(_, name)| requested.is_none_or(|wanted| wanted == name))
        .collect::<Vec<_>>();
    if chosen.is_empty() {
        return Err(invalid("找不到指定的 Sheet"));
    }
    chosen
        .into_iter()
        .map(|(offset, name)| {
            parse_sheet(
                &stream,
                *offset,
                name.clone(),
                &strings,
                &date_xfs,
                epoch_1904,
            )
            .ok_or_else(|| invalid("工作表记录损坏"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{Reader, open_workbook_auto};

    #[test]
    fn fixture_biff8_prefix_matches_full_reader() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/Excel Merger");
        for name in ["simple-biff8.xls", "formatted-biff8.xls"] {
            let path = root.join(name);
            let sampled = read(&path, None).unwrap();
            let mut workbook = open_workbook_auto(&path).unwrap();
            assert_eq!(
                sampled.iter().map(|sheet| &sheet.name).collect::<Vec<_>>(),
                workbook.sheet_names().iter().collect::<Vec<_>>()
            );
            for sheet in sampled {
                let full = workbook.worksheet_range(&sheet.name).unwrap();
                for (number, values) in &sheet.rows {
                    let row = full.rows().nth(number - 1).unwrap();
                    for (index, value) in values.iter().enumerate() {
                        if !value.is_empty() {
                            assert_eq!(value, &super::super::fx::data_text(&row[index]));
                        }
                    }
                }
            }
        }
    }

    #[test]
    #[ignore = "set FX_SAMPLE_XLS to a real large BIFF8 workbook"]
    fn real_large_biff8_uses_bounded_rows() {
        let path = std::env::var_os("FX_SAMPLE_XLS")
            .map(std::path::PathBuf::from)
            .expect("FX_SAMPLE_XLS is required");
        let started = std::time::Instant::now();
        let sheets = read(&path, None).unwrap();
        assert!(!sheets.is_empty());
        assert!(sheets.iter().all(|sheet| sheet.rows.len() <= MAX_SAMPLE_ROWS));
        let classified = crate::fx::classify_source(&serde_json::json!({"source": {
            "inputPath": path, "sheet": "", "headerRow": 0, "headerDepth": 0
        }})).unwrap();
        assert!(classified["headers"].as_array().is_some_and(|headers| !headers.is_empty()));
        eprintln!("BIFF8 sampled {} Sheet(s) in {:?}", sheets.len(), started.elapsed());
    }
}
