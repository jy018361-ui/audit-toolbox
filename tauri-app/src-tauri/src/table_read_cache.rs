//! 有界读取结果缓存。预览与已选列跨 worker 复用，绝不为了缓存提前读取正文。
//! 文件身份和调用参数共同入键；损坏、写入失败或读取期间源文件变化均不发布缓存。
use crate::AppError;
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::SystemTime};

const ENTRY_LIMIT: usize = 256 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 1024 * 1024 * 1024;

fn location(path: &Path, purpose: &str, params: &impl Serialize) -> Option<PathBuf> {
    let identity = crate::disk_table::fingerprint(path, purpose, 0, 0).ok()?;
    let mut hash = Sha256::new();
    hash.update(identity.as_bytes());
    hash.update(serde_json::to_vec(params).ok()?);
    hash.update(crate::header_detection::RULE_VERSION.as_bytes());
    let root = crate::tabular::cache_root().ok()?.join("reads/v1");
    Some(root.join(format!("{}.json", hex::encode(hash.finalize()))))
}

pub(crate) fn read<T: Serialize + DeserializeOwned>(
    source: &Path, purpose: &str, params: &impl Serialize,
    reader: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let cache = location(source, purpose, params);
    if let Some(cache) = &cache {
        if let Ok(meta) = fs::metadata(cache) {
            if meta.len() <= ENTRY_LIMIT as u64 {
                if let Ok(file) = fs::File::open(cache) {
                    if let Ok(value) = serde_json::from_reader(std::io::BufReader::new(file)) {
                        if location(source, purpose, params).as_ref() == Some(cache) {
                            let _ = fs::File::options().write(true).open(cache)
                                .and_then(|file| file.set_modified(SystemTime::now()));
                            return Ok(value);
                        }
                    }
                }
            }
            let _ = fs::remove_file(cache);
        }
    }
    let value = reader()?;
    if let Some(cache) = cache {
        if location(source, purpose, params).as_ref() == Some(&cache) {
            store(&cache, &value);
        }
    }
    Ok(value)
}

struct BoundedWriter<W> { output: W, used: usize }
impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.used.saturating_add(bytes.len()) > ENTRY_LIMIT {
            return Err(std::io::Error::other("读取缓存达到容量上限"));
        }
        let count = self.output.write(bytes)?;
        self.used += count;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.output.flush() }
}

fn store(path: &Path, value: &impl Serialize) {
    let Some(root) = path.parent() else { return; };
    if fs::create_dir_all(root).is_err() { return; }
    let temp = path.with_extension(format!("{}.partial", uuid::Uuid::new_v4().simple()));
    let written = (|| -> std::io::Result<()> {
        let file = fs::File::create(&temp)?;
        let mut output = BoundedWriter { output: std::io::BufWriter::new(file), used: 0 };
        serde_json::to_writer(&mut output, value)?;
        output.flush()
    })();
    if written.is_ok() { let _ = crate::tabular::replace_file(&temp, path); }
    let _ = fs::remove_file(&temp);
    // 与公共缓存清理兼容，同时限制本层自己可以积累的体积。
    let mut entries = fs::read_dir(root).into_iter().flatten().flatten().filter_map(|entry| {
        let path = entry.path();
        if path.extension()?.to_str()? != "json" { return None; }
        let meta = entry.metadata().ok()?;
        Some((meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), path, meta.len()))
    }).collect::<Vec<_>>();
    let mut total = entries.iter().map(|entry| entry.2).sum::<u64>();
    if total > TOTAL_LIMIT {
        entries.sort_by_key(|entry| entry.0);
        for (_, old, len) in entries {
            if old == path { continue; }
            if fs::remove_file(old).is_ok() { total = total.saturating_sub(len); }
            if total <= TOTAL_LIMIT * 3 / 4 { break; }
        }
    }
}

/// 真实 ZIP/工作簿结构，尾部含无效数值；预览必须成功，完整读取必须报错。
#[cfg(test)]
pub(crate) fn workbook_with_bad_tail(path: &Path, headers: &[&str]) {
    use std::io::{Cursor, Read};
    let mut book = rust_xlsxwriter::Workbook::new();
    let sheet = book.add_worksheet();
    sheet.set_name("数据").unwrap();
    sheet.write_row(0, 0, headers.iter().copied()).unwrap();
    for row in 1..301 {
        for col in 0..headers.len() {
            sheet.write_string(row, col as u16, format!("ID-{row}-{col}")).unwrap();
        }
    }
    let bytes = book.save_to_buffer().unwrap();
    let mut source = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut output = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for i in 0..source.len() {
        let mut entry = source.by_index(i).unwrap();
        let name = entry.name().to_owned();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        if name == "xl/worksheets/sheet1.xml" {
            bytes = String::from_utf8(bytes).unwrap().replace("</sheetData>",
                "<row r=\"400\"><c r=\"A400\" t=\"n\"><v>INVALID_TAIL</v></c></row></sheetData>").into_bytes();
        }
        output.start_file(name, options).unwrap();
        output.write_all(&bytes).unwrap();
    }
    output.finish().unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "需要设置 FA_SUPPLEMENT_BENCH_DIR，仅读取实际资产清单"]
    fn unified_real_file_preview_bench() {
        let root = PathBuf::from(std::env::var_os("FA_SUPPLEMENT_BENCH_DIR").expect("设置样例目录"));
        let path = root.join("资产减少业务查询 25年5-10月.xlsx");
        let start = std::time::Instant::now();
        let result = crate::excel_merger::call("excel_merger.match_preview", serde_json::json!({
            "inputPaths":[path], "templatePath":path, "templateSheet":"Sheet1"
        })).unwrap();
        assert!(!result["rows"].as_array().unwrap().is_empty());
        eprintln!("合并匹配预览 {:.3}s", start.elapsed().as_secs_f64());
        let start = std::time::Instant::now();
        let result = crate::fuzzy_match::call("fuzzy.inspect", serde_json::json!({
            "source":{"path":path,"sheet":"Sheet1","headerRow":3,"headerDepth":1}
        })).unwrap();
        assert_eq!(result["previewOnly"], true);
        eprintln!("模糊匹配上传预览 {:.3}s", start.elapsed().as_secs_f64());
        for (file, sheet) in [("科技FA存量清单-202412.xlsx", "FA241231"),
            ("2025年12月FA资产清单 (2)(1).xlsx", "IT账套")] {
            let path = root.join(file);
            let start = std::time::Instant::now();
            let result = crate::fa_subtools::call("fa.dep_inspect", serde_json::json!({
                "path":path,"sheet":sheet,"headerRow":1,"headerDepth":1
            })).unwrap();
            assert!(result["dimensions"]["rows"].as_u64().unwrap() > 200);
            assert!(result["preview"].as_array().unwrap().len() <= 12);
            eprintln!("折旧上传预览 {file} {:.3}s", start.elapsed().as_secs_f64());
        }
    }
    #[test]
    fn reuses_across_calls_separates_parameters_and_recovers_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("input.csv");
        fs::write(&source, "id\n1").unwrap();
        let load = |params: usize, value: &str| read(&source, "read-cache-test", &params, || Ok(value.to_string())).unwrap();
        assert_eq!(load(1, "first"), "first");
        assert_eq!(load(1, "must not run"), "first");
        assert_eq!(load(2, "other header"), "other header");
        let cache = location(&source, "read-cache-test", &1usize).unwrap();
        fs::write(&cache, "broken").unwrap();
        assert_eq!(load(1, "recovered"), "recovered");
        fs::write(&source, "id\n1\n2").unwrap();
        assert_eq!(load(1, "changed source"), "changed source");
    }

    #[test]
    fn changed_source_during_read_is_not_cached_and_errors_are_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("input.csv");
        fs::write(&source, "a").unwrap();
        let before = location(&source, "race-test", &()).unwrap();
        let _: String = read(&source, "race-test", &(), || {
            fs::write(&source, "different content").unwrap();
            Ok("old snapshot".into())
        }).unwrap();
        assert!(!before.exists());
        assert!(!location(&source, "race-test", &()).unwrap().exists());
        let result: Result<String, _> = read(&source, "race-test", &(), || Err(crate::fa::error("TEST", "测试错误", None)));
        assert!(result.is_err());
        assert!(!location(&source, "race-test", &()).unwrap().exists());
    }
}
