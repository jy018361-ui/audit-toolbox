//! Local, bounded diagnostics. Arbitrary strings and data are never written verbatim.
use crate::AppError;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime},
};

const FILE_LIMIT: u64 = 2 * 1024 * 1024;
const FILE_COUNT: usize = 12;
const RECENT_LIMIT: usize = 200;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
static LOGGER: OnceLock<Mutex<Logger>> = OnceLock::new();

#[derive(Clone)]
struct Logger {
    root: PathBuf,
    session: String,
    salt: String,
    part: u32,
    last_error: Option<String>,
    progress: std::collections::HashMap<String, (String, Instant)>,
}

impl Logger {
    fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        let salt_path = root.join("fingerprint.key");
        // create_new avoids two processes choosing different fingerprints on first launch.
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&salt_path)
        {
            file.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?;
        }
        let salt = fs::read_to_string(salt_path)?;
        if salt.is_empty() {
            return Err(std::io::Error::other("诊断指纹初始化失败"));
        }
        Ok(Self {
            root,
            session: uuid::Uuid::new_v4().simple().to_string(),
            salt,
            part: 0,
            last_error: None,
            progress: Default::default(),
        })
    }

    fn enabled(&self) -> bool {
        !self.root.join("disabled").exists()
    }

    fn append(&mut self, event: &str, data: Value) -> std::io::Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        if event == "job_event" {
            let id = data["jobId"].as_str().unwrap_or_default();
            let phase = data["phase"].as_str().unwrap_or_default();
            let terminal = matches!(phase, "completed" | "failed" | "cancelled");
            if !terminal
                && data["severity"] == "info"
                && self
                    .progress
                    .get(id)
                    .is_some_and(|(old, at)| old == phase && at.elapsed() < Duration::from_secs(1))
            {
                return Ok(());
            }
            if terminal {
                self.progress.remove(id);
            } else {
                if self.progress.len() > 256 {
                    self.progress.clear();
                }
                self.progress
                    .insert(id.into(), (phase.into(), Instant::now()));
            }
        }
        let record = json!({"at": Utc::now().to_rfc3339(), "session": self.session,
            "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "event": event, "data": data});
        let mut line = serde_json::to_vec(&record)?;
        line.push(b'\n');
        if line.len() as u64 > FILE_LIMIT {
            return Ok(());
        }
        let mut path = self
            .root
            .join(format!("events-{}-{}.jsonl", self.session, self.part));
        if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > FILE_LIMIT {
            self.part += 1;
            path = self
                .root
                .join(format!("events-{}-{}.jsonl", self.session, self.part));
        }
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?
            .write_all(&line)?;
        self.prune()?;
        Ok(())
    }

    fn files(&self) -> std::io::Result<Vec<(SystemTime, PathBuf, u64)>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            // Only our direct regular files; never follow a link or traverse directories.
            if !name.starts_with("events-")
                || !name.ends_with(".jsonl")
                || !entry.file_type()?.is_file()
            {
                continue;
            }
            let meta = entry.metadata()?;
            files.push((meta.modified()?, entry.path(), meta.len()));
        }
        files.sort_by_key(|f| f.0);
        Ok(files)
    }

    fn prune(&self) -> std::io::Result<()> {
        let files = self.files()?;
        let excess = files.len().saturating_sub(FILE_COUNT);
        for (i, (at, path, _)) in files.into_iter().enumerate() {
            if i < excess || SystemTime::now().duration_since(at).unwrap_or_default() > MAX_AGE {
                // Another process may be pruning the same file.
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }
}

pub fn init(root: PathBuf) {
    if let Ok(logger) = Logger::new(root) {
        let _ = LOGGER.set(Mutex::new(logger));
    }
}

pub fn record(event: &str, data: Value) {
    if let Some(logger) = LOGGER.get() {
        let mut logger = logger.lock();
        if let Err(_) = logger.append(event, data) {
            logger.last_error = Some("日志写入失败，请检查磁盘空间和目录权限。".into());
        }
    }
}

pub fn app_error(error: &AppError, location: &std::panic::Location<'_>) {
    // Error creation can also happen inside a failed log export. Never recurse or block.
    if let Some(mut logger) = LOGGER.get().and_then(|l| l.try_lock()) {
        let data = json!({"code":identifier(&error.code),"diagnosticId":error.diagnostic_id,"retryable":error.retryable,
            "message":summarize(&json!(error.user_message), &logger.salt, 0, ""),
            "detail":summarize(&json!(error.detail), &logger.salt, 0, ""),
            "source":source(location)});
        let _ = logger.append("app_error", data);
    }
}

fn source(location: &std::panic::Location<'_>) -> Value {
    json!({"file":location.file().rsplit(['/', '\\']).next(),"line":location.line(),"column":location.column()})
}

pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(mut logger) = LOGGER.get().and_then(|l| l.try_lock()) {
            // Keep code symbols; skip stack lines with build-machine paths and panic text.
            let backtrace = std::backtrace::Backtrace::force_capture()
                .to_string()
                .lines()
                .filter(|line| {
                    line.trim_start()
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_digit())
                })
                .take(60)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let _ = logger.append(
                "panic",
                json!({"source":info.location().map(source),"stack":backtrace}),
            );
        }
        previous(info);
    }));
}

fn fingerprint(value: &str, salt: &str) -> String {
    hex::encode(Sha256::digest(format!("{salt}\0{value}").as_bytes()))[..16].into()
}

// A closed vocabulary keeps spreadsheet headers, company names, and dynamic map keys out.
fn known_key(key: &str) -> bool {
    matches!(
        key,
        "params"
            | "settings"
            | "path"
            | "paths"
            | "files"
            | "filePath"
            | "inputPath"
            | "outputPath"
            | "inputPaths"
            | "outputDir"
            | "folder"
            | "sheet"
            | "sheetName"
            | "sheetNames"
            | "headerRow"
            | "headerRows"
            | "startRow"
            | "endRow"
            | "mode"
            | "mapping"
            | "columns"
            | "rows"
            | "options"
            | "enabled"
            | "llm"
            | "ocr"
            | "asr"
            | "meeting"
            | "cache"
            | "model"
            | "engine"
            | "apiType"
            | "timeout"
            | "thinkingEnabled"
            | "cleanup"
            | "detect_enabled"
            | "background_resident"
            | "selectedColumns"
            | "filters"
            | "batches"
            | "prefixLength"
            | "paused"
            | "kind"
            | "extensions"
            | "rowCount"
            | "columnCount"
            | "fileCount"
            | "count"
            | "total"
            | "current"
            | "success"
            | "warnings"
            | "errors"
            | "result"
            | "status"
            | "accountCode"
            | "accountName"
            | "voucherNo"
            | "voucherNumber"
            | "voucherDate"
            | "debit"
            | "credit"
            | "amount"
            | "balance"
            | "date"
            | "summary"
            | "data"
            | "items"
    )
}

fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "secret",
        "password",
        "token",
        "apikey",
        "api_key",
        "authorization",
        "credential",
    ]
    .iter()
    .any(|s| key.contains(s))
        || key == "value"
        || key.starts_with("__")
}

fn summarize(value: &Value, salt: &str, depth: usize, key: &str) -> Value {
    summarize_bounded(value, salt, depth, key, &mut 256)
}

fn summarize_bounded(
    value: &Value,
    salt: &str,
    depth: usize,
    key: &str,
    budget: &mut usize,
) -> Value {
    if *budget == 0 {
        return json!({"truncated":true});
    }
    *budget -= 1;
    if sensitive_key(key) {
        return json!({"redacted": true});
    }
    if depth > 5 {
        return json!({"truncated": true});
    }
    match value {
        Value::Null | Value::Bool(_) => value.clone(),
        Value::Number(_)
            if depth <= 2
                && matches!(
                    key,
                    "headerRow"
                        | "headerRows"
                        | "startRow"
                        | "endRow"
                        | "timeout"
                        | "prefixLength"
                        | "rowCount"
                        | "columnCount"
                        | "fileCount"
                        | "count"
                        | "total"
                        | "current"
                ) =>
        {
            value.clone()
        }
        Value::Number(n) => {
            json!({"type":"number", "fingerprint": fingerprint(&n.to_string(), salt)})
        }
        Value::String(s) => {
            json!({"type":"string", "length":s.chars().count(), "fingerprint":fingerprint(s, salt)})
        }
        Value::Array(a) => {
            json!({"type":"array", "length":a.len(), "sample": a.iter().take(12).map(|v| summarize_bounded(v, salt, depth + 1, "", budget)).collect::<Vec<_>>()})
        }
        Value::Object(o) => {
            let fields = o
                .iter()
                .take(48)
                .map(|(k, v)| {
                    let label = if known_key(k) {
                        k.clone()
                    } else {
                        format!("field_{}", fingerprint(k, salt))
                    };
                    (label, summarize_bounded(v, salt, depth + 1, k, budget))
                })
                .collect::<serde_json::Map<_, _>>();
            json!({"type":"object", "length":o.len(), "fields": fields})
        }
    }
}

pub fn summary(value: &Value) -> Value {
    LOGGER
        .get()
        .map(|l| {
            let l = l.lock();
            if l.enabled() {
                summarize(value, &l.salt, 0, "")
            } else {
                Value::Null
            }
        })
        .unwrap_or(Value::Null)
}

/// Internal identifiers only. Frontend-supplied free text must go through summary().
pub fn identifier(value: &str) -> String {
    if value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-/".contains(&c))
    {
        value.into()
    } else {
        "redacted".into()
    }
}

pub struct Span {
    id: String,
    started: Instant,
}
impl Span {
    pub fn start(kind: &str, method: &str, params: &Value) -> Self {
        let span = Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
        };
        record(
            "call_start",
            json!({"callId":span.id, "kind":kind, "method":identifier(method), "params":summary(params)}),
        );
        span
    }
    pub fn finish<T>(
        &self,
        result: &Result<T, AppError>,
        job_id: Option<&str>,
        output: Option<&Value>,
    ) {
        record(
            "call_end",
            json!({"callId":self.id, "elapsedMs": self.started.elapsed().as_millis() as u64,
            "ok":result.is_ok(), "jobId":job_id.map(identifier),
            "result":output.map(summary),
            "error":result.as_ref().err().map(|e| json!({"code":e.code,"diagnosticId":e.diagnostic_id}))}),
        );
    }
}

pub fn status() -> Result<Value, AppError> {
    let logger = LOGGER.get().ok_or_else(unavailable)?.lock();
    logger.prune().map_err(io_error)?;
    let files = logger.files().map_err(io_error)?;
    Ok(
        json!({"enabled":logger.enabled(),"bytes":files.iter().map(|f| f.2).sum::<u64>(),"files":files.len(),
        "retentionDays":7,"maxBytes":FILE_LIMIT * FILE_COUNT as u64,"writeError":logger.last_error}),
    )
}

#[derive(Deserialize, Serialize)]
pub struct LogEntry {
    at: DateTime<Utc>,
    session: String,
    pid: u32,
    version: String,
    event: String,
    data: serde_json::Map<String, Value>,
}

pub fn recent() -> Result<Vec<LogEntry>, AppError> {
    let logger = LOGGER.get().ok_or_else(unavailable)?.lock().clone();
    recent_entries(&logger)
}

fn recent_entries(logger: &Logger) -> Result<Vec<LogEntry>, AppError> {
    logger.prune().map_err(io_error)?;
    let mut entries = Vec::new();
    for (_, path, _) in logger.files().map_err(io_error)? {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            // A worker may rotate a file after we list the directory.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error(error)),
        };
        let mut bytes = Vec::new();
        file.take(FILE_LIMIT)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        // The writer may still be appending the last record.
        let Some(last_newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
            continue;
        };
        entries.extend(
            bytes[..last_newline]
                .rsplit(|byte| *byte == b'\n')
                .filter_map(|line| serde_json::from_slice::<LogEntry>(line).ok())
                .take(RECENT_LIMIT),
        );
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.at));
    entries.truncate(RECENT_LIMIT);
    Ok(entries)
}

pub fn set_enabled(enabled: bool) -> Result<(), AppError> {
    let mut logger = LOGGER.get().ok_or_else(unavailable)?.lock();
    let path = logger.root.join("disabled");
    if enabled {
        if path.exists() {
            fs::remove_file(path).map_err(io_error)?;
        }
    } else {
        fs::write(path, b"disabled").map_err(io_error)?;
    }
    logger.last_error = None;
    Ok(())
}

pub fn clear() -> Result<(), AppError> {
    let mut logger = LOGGER.get().ok_or_else(unavailable)?.lock();
    for (_, path, _) in logger.files().map_err(io_error)? {
        if let Err(e) = fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(io_error(e));
            }
        }
    }
    logger.last_error = None;
    Ok(())
}

pub fn export(path: &Path) -> Result<(), AppError> {
    // Compression and a potentially slow user-selected destination must not hold up logging.
    let logger = LOGGER.get().ok_or_else(unavailable)?.lock().clone();
    export_logger(&logger, path)
}

fn export_logger(logger: &Logger, path: &Path) -> Result<(), AppError> {
    logger.prune().map_err(io_error)?;
    // Finish ZIP generation before touching the selected destination.
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let manifest = json!({"formatVersion":1,"exportedAt":Utc::now().to_rfc3339(),"appVersion":env!("CARGO_PKG_VERSION"),
        "platform":"windows","arch":std::env::consts::ARCH,"channel":crate::release_channel::application_name(),
        "enabled":logger.enabled(),"retentionDays":7,"windowsBuild":windows_build(),"webview2Available":crate::webview2_available(),
        "memory":crate::resource_budget::memory_status().ok().map(|m| json!({"totalBytes":m.total,"availableBytes":m.available,"commitAvailableBytes":m.commit_available})),
        "privacy":"结构摘要；自由文本与路径使用本机加盐指纹；无凭据、数据库或源文件。"});
    let zip_error = |_: zip::result::ZipError| {
        AppError::new(
            "DIAGNOSTICS_EXPORT_FAILED",
            "诊断包生成失败，请重试。",
            true,
            None,
        )
    };
    zip.start_file("manifest.json", options)
        .map_err(zip_error)?;
    zip.write_all(
        serde_json::to_string_pretty(&manifest)
            .unwrap_or_default()
            .as_bytes(),
    )
    .map_err(io_error)?;
    zip.start_file("使用说明.txt", options).map_err(zip_error)?;
    zip.write_all("这是审计工具箱本地诊断包，不会自动上传。\n时间为 UTC（北京时间/新加坡时间加 8 小时）。按 at 排序，用 session/pid 区分进程，以 callId/jobId/diagnosticId 关联调用与错误。\nparams 为结构摘要；自由文本、文件路径、动态字段名和业务数值仅保留加盐指纹；相同指纹表示本机相同输入。凭据与内部注入参数被移除。错误包含代码位置及内容指纹，不包含完整报错原文。\n请同时描述预期结果、实际现象和大致发生时间；涉及数据问题可能仍需提供脱敏样例。日志不能自动重放原始账表，也不能捕获所有系统级强退。\n日志保留最近 7 天且总量约不超过 24 MiB；关闭开关停止新记录，旧记录可单独清空。\n".as_bytes()).map_err(io_error)?;
    for (_, file, _) in logger.files().map_err(io_error)? {
        let Ok(source) = fs::File::open(&file) else {
            continue;
        };
        let mut bytes = Vec::new();
        source
            .take(FILE_LIMIT)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        // A different process may be appending. Export only complete JSON lines.
        if let Some(end) = bytes.iter().rposition(|b| *b == b'\n') {
            bytes.truncate(end + 1);
        } else {
            continue;
        }
        zip.start_file(
            format!("logs/{}", file.file_name().unwrap().to_string_lossy()),
            options,
        )
        .map_err(zip_error)?;
        zip.write_all(&bytes).map_err(io_error)?;
    }
    let bytes = zip.finish().map_err(zip_error)?.into_inner();
    fs::write(path, bytes).map_err(io_error)
}

fn unavailable() -> AppError {
    AppError::new(
        "DIAGNOSTICS_UNAVAILABLE",
        "诊断日志未能初始化，请检查本机数据目录权限。",
        true,
        None,
    )
}
fn io_error(_: std::io::Error) -> AppError {
    AppError::new(
        "DIAGNOSTICS_IO_FAILED",
        "日志操作失败，请检查磁盘空间、文件占用和目录权限。",
        true,
        None,
    )
}

fn windows_build() -> Option<String> {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")
        .ok()?;
    let build = key.get_value::<String, _>("CurrentBuildNumber").ok()?;
    let revision = key.get_value::<u32, _>("UBR").ok()?;
    Some(format!("{}.{}", identifier(&build), revision))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_logs_merge_sessions_and_skip_incomplete_records() {
        let dir = tempfile::tempdir().unwrap();
        let logger = Logger::new(dir.path().to_path_buf()).unwrap();
        let entry = |offset: usize| {
            json!({
                "at": DateTime::from_timestamp(1_780_000_000 + offset as i64, 0).unwrap(),
                "session": "test", "pid": 42, "version": "test", "event": "call_start",
                "data": {"offset": offset}
            })
        };
        let first: String = (0..RECENT_LIMIT)
            .map(|i| format!("{}\n", entry(i)))
            .collect();
        fs::write(dir.path().join("events-main.jsonl"), first).unwrap();
        fs::write(
            dir.path().join("events-worker.jsonl"),
            format!(
                "invalid\n{}\n{}",
                entry(RECENT_LIMIT),
                entry(RECENT_LIMIT + 1)
            ),
        )
        .unwrap();
        fs::write(dir.path().join("disabled"), "").unwrap();
        let logs = recent_entries(&logger).unwrap();
        assert_eq!(logs.len(), RECENT_LIMIT);
        assert_eq!(logs[0].data["offset"], json!(RECENT_LIMIT));
        assert_eq!(logs.last().unwrap().data["offset"], json!(1));
    }

    #[test]
    fn summaries_remove_secrets_paths_dynamic_keys_and_business_values() {
        let input = json!({"path":"C:\\客户甲\\工资.xlsx","apiKey":"sk-private","__settings":{"password":"pass"},
            "mapping":{"客户甲":"期末金额"},"rows":[[123456.78,"张三"]],"headerRow":9,"enabled":true});
        let output = summarize(&input, "test-salt", 0, "").to_string();
        for secret in [
            "客户甲",
            "工资",
            "sk-private",
            "password",
            "pass",
            "期末金额",
            "123456.78",
            "张三",
        ] {
            assert!(!output.contains(secret), "{secret}");
        }
        assert_eq!(summarize(&json!(9), "test", 0, "headerRow"), json!(9));
        assert_ne!(
            fingerprint("客户甲", "salt1"),
            fingerprint("客户甲", "salt2")
        );
    }
    #[test]
    fn rotation_disable_clear_and_age_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let mut logger = Logger::new(dir.path().to_path_buf()).unwrap();
        for _ in 0..30 {
            logger
                .append("test", json!({"padding":"x".repeat(1024 * 1024)}))
                .unwrap();
        }
        let files = logger.files().unwrap();
        assert!(files.len() <= FILE_COUNT);
        assert!(files.iter().all(|f| f.2 <= FILE_LIMIT));
        let count = files.iter().map(|f| f.2).sum::<u64>();
        fs::write(dir.path().join("disabled"), "").unwrap();
        logger.append("test", json!({})).unwrap();
        assert_eq!(
            count,
            logger.files().unwrap().iter().map(|f| f.2).sum::<u64>()
        );
        fs::remove_file(dir.path().join("disabled")).unwrap();
        let old = dir.path().join("events-old.jsonl");
        let file = fs::File::create(&old).unwrap();
        file.set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(1))
            .unwrap();
        logger.prune().unwrap();
        assert!(!old.exists());
        // Unrelated files are never exported, pruned, or cleared.
        fs::write(dir.path().join("keep.txt"), "keep").unwrap();
        for (_, path, _) in logger.files().unwrap() {
            fs::remove_file(path).unwrap();
        }
        assert!(dir.path().join("keep.txt").exists());
        assert!(dir.path().join("fingerprint.key").exists());
    }

    #[test]
    fn successful_calls_and_export_keep_structure_without_source_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut logger = Logger::new(dir.path().join("logs")).unwrap();
        let input =
            json!({"mapping":{"voucherNo":"参照凭证号"},"rows":[[98765.43,"客户甲"]],"rowCount":1});
        logger
            .append(
                "call_end",
                json!({"ok":true,"result":summarize(&input,&logger.salt,0,"")}),
            )
            .unwrap();
        fs::write(logger.root.join("settings.json"), "private-settings").unwrap();
        let path = dir.path().join("bundle.zip");
        export_logger(&logger, &path).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
        let names = zip.file_names().map(str::to_owned).collect::<Vec<_>>();
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(
            !names
                .iter()
                .any(|n| n.contains("fingerprint") || n.contains("settings"))
        );
        let name = names.iter().find(|n| n.ends_with(".jsonl")).unwrap();
        let mut text = String::new();
        zip.by_name(name)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert!(
            text.contains("voucherNo") && text.contains("rowCount") && text.contains("call_end")
        );
        assert!(
            !text.contains("参照凭证号") && !text.contains("客户甲") && !text.contains("98765.43")
        );
        for line in text.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        // A second process observes the same disable marker and fingerprints.
        let other = Logger::new(logger.root.clone()).unwrap();
        assert_eq!(other.salt, logger.salt);
        fs::write(logger.root.join("disabled"), "").unwrap();
        assert!(!other.enabled());
    }
}
