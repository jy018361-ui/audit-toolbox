use crate::spreadsheet_input::is_text;
use calamine::{Data, Reader, open_workbook_auto};
use chrono::{Local, NaiveDateTime, NaiveTime};
#[cfg(test)]
use encoding_rs::GBK;
use parking_lot::Mutex;
use rust_xlsxwriter::{
    Format, FormatAlign, FormatBorder, FormatUnderline, Url, Workbook, Worksheet,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

use crate::{AllowedPaths, AppError, storage::Storage};

const SUPPORTED: &[&str] = &["xlsx", "xls", "xlsm", "csv", "txt"];
const EXCEL_MAX_ROWS: usize = 1_048_576;
const EXCEL_MAX_COLS: usize = 16_384;
/// Excel refuses to open a worksheet holding more hyperlinks than this and
/// offers to "repair" the file, which strips them all.  Past this point the
/// source column degrades to plain text, exactly like the legacy writer did.
const EXCEL_MAX_HYPERLINKS: usize = 65_530;

#[derive(Clone)]
pub(crate) struct ExcelMergerService {
    app: AppHandle,
    allowed: AllowedPaths,
    jobs: Arc<Mutex<HashMap<String, (PathBuf, PathBuf, String)>>>,
    /// 每个任务的启动时刻，终态事件到达时用于计算「执行任务」统计的耗时。
    job_starts: Arc<Mutex<HashMap<String, Instant>>>,
    heavy: Arc<Mutex<()>>,
    cancel_root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest {
    job_id: String,
    #[serde(default = "default_worker_method")]
    method: String,
    params: Value,
    cancel_path: String,
    pause_path: String,
}

/// Cooperative pause gate shared by all native heavy jobs.
///
/// A checkpoint never busy-spins: while the marker exists it sleeps in short
/// intervals and continues to observe cancellation.  Callers place checkpoints
/// between workbook/file operations so a paused task cannot advance to its next
/// safe stage or publish another progress event.
#[derive(Clone, Debug)]
pub(crate) struct PauseCheckpoint {
    pause_path: PathBuf,
    cancel: Arc<AtomicBool>,
}

impl PauseCheckpoint {
    fn new(pause_path: PathBuf, cancel: Arc<AtomicBool>) -> Self {
        Self { pause_path, cancel }
    }

    pub(crate) fn wait(&self) -> Result<(), AppError> {
        while self.pause_path.exists() {
            if self.cancel.load(Ordering::Relaxed) {
                return Err(error("JOB_CANCELLED", "任务已取消。", None));
            }
            thread::sleep(Duration::from_millis(50));
        }
        if self.cancel.load(Ordering::Relaxed) {
            Err(error("JOB_CANCELLED", "任务已取消。", None))
        } else {
            Ok(())
        }
    }

    /// 永不暂停的检查点（标记文件指向绝不存在的随机临时路径）。
    /// 单测与 fuzzy_match::run_job_for_test（集成测试进程内直连）共用。
    pub(crate) fn unpaused(cancel: Arc<AtomicBool>) -> Self {
        Self::new(
            std::env::temp_dir().join(format!(
                "AuditToolbox-never-paused-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            )),
            cancel,
        )
    }
}

fn default_worker_method() -> String {
    "excel_merger.merge".into()
}

impl ExcelMergerService {
    pub fn new(app: AppHandle, allowed: AllowedPaths) -> Self {
        let cancel_root = std::env::temp_dir()
            .join("AuditToolbox")
            .join("rust-job-cancel");
        let _ = fs::create_dir_all(&cancel_root);
        Self {
            app,
            allowed,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            job_starts: Arc::new(Mutex::new(HashMap::new())),
            heavy: Arc::new(Mutex::new(())),
            cancel_root,
        }
    }

    pub fn start(&self, method: &str, params: Value) -> Result<String, AppError> {
        if !is_supported_job_method(method) {
            return Err(error(
                "METHOD_NOT_FOUND",
                "未找到 Rust 表格任务方法。",
                Some(method.into()),
            ));
        }
        let job_id = uuid::Uuid::new_v4().simple().to_string();
        let cancel_path = self.cancel_root.join(format!("{job_id}.cancel"));
        let pause_path = self.cancel_root.join(format!("{job_id}.pause"));
        let _ = fs::remove_file(&cancel_path);
        let _ = fs::remove_file(&pause_path);
        self.jobs.lock().insert(
            job_id.clone(),
            (cancel_path.clone(), pause_path, method.to_owned()),
        );
        self.job_starts
            .lock()
            .insert(job_id.clone(), Instant::now());
        let service = self.clone();
        let worker_job_id = job_id.clone();
        let worker_method = method.to_owned();
        thread::spawn(move || service.monitor(worker_job_id, worker_method, params, cancel_path));
        Ok(job_id)
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let Some((path, _pause, method)) = self.jobs.lock().get(job_id).cloned() else {
            return false;
        };
        if fs::write(path, b"cancel").is_err() {
            return false;
        }
        self.emit(event_for(
            tool_id(&method),
            job_id,
            "cancelling",
            0,
            1,
            "正在取消任务…",
            "warning",
            Vec::new(),
            None,
        ));
        true
    }

    pub fn pause(&self, job_id: &str, paused: bool) -> bool {
        let Some((_cancel, path, method)) = self.jobs.lock().get(job_id).cloned() else {
            return false;
        };
        let changed = if paused {
            fs::write(&path, b"pause").is_ok()
        } else {
            !path.exists() || fs::remove_file(&path).is_ok()
        };
        if changed {
            self.emit(event_for(
                tool_id(&method),
                job_id,
                if paused { "paused" } else { "running" },
                0,
                1,
                if paused {
                    "任务已暂停；正在进行的单项请求完成后暂停。"
                } else {
                    "任务已继续。"
                },
                "info",
                Vec::new(),
                None,
            ));
        }
        changed
    }

    fn monitor(&self, job_id: String, method: String, params: Value, cancel_path: PathBuf) {
        let worker_tool_id = tool_id(&method);
        self.emit(event_for(
            worker_tool_id,
            &job_id,
            "queued",
            0,
            1,
            "任务已进入队列",
            "info",
            Vec::new(),
            None,
        ));
        let _guard = self.heavy.lock();
        if cancel_path.exists() {
            self.emit(event_for(
                worker_tool_id,
                &job_id,
                "cancelled",
                1,
                1,
                "任务已取消。",
                "warning",
                Vec::new(),
                None,
            ));
            self.finish(&job_id, &cancel_path);
            return;
        }
        let request = WorkerRequest {
            job_id: job_id.clone(),
            method,
            params,
            cancel_path: cancel_path.to_string_lossy().into_owned(),
            pause_path: self
                .cancel_root
                .join(format!("{job_id}.pause"))
                .to_string_lossy()
                .into_owned(),
        };
        let mut command = match std::env::current_exe() {
            // 重任务靠"再启动一份自己"来跑。程序文件在运行期间被移走或重新构建过时
            // （开发机上很常见），这里会失败——直接说清楚该怎么办，
            // 否则用户只看到"无法启动"，无从下手。
            Ok(exe) if !exe.is_file() => {
                self.emit(event_for(
                    worker_tool_id,
                    &job_id,
                    "failed",
                    1,
                    1,
                    "程序文件已不在原位置，无法启动后台任务进程。这通常是应用运行期间被重新构建或移动过，请关闭并重新打开审计工具箱。",
                    "error",
                    Vec::new(),
                    Some(json!({
                        "code": "WORKER_EXE_MISSING",
                        "detail": exe.to_string_lossy(),
                    })),
                ));
                self.finish(&job_id, &cancel_path);
                return;
            }
            Ok(exe) => {
                let mut command = Command::new(exe);
                command.arg("--rust-table-worker");
                command
            }
            Err(err) => {
                self.emit(event_for(
                    worker_tool_id,
                    &job_id,
                    "failed",
                    1,
                    1,
                    "无法启动 Rust 表格处理进程。",
                    "error",
                    Vec::new(),
                    Some(json!({"code":"WORKER_START_FAILED","detail":err.to_string()})),
                ));
                self.finish(&job_id, &cancel_path);
                return;
            }
        };
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child_result = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child_result {
            Ok(child) => child,
            Err(err) => {
                self.emit(event_for(
                    worker_tool_id,
                    &job_id,
                    "failed",
                    1,
                    1,
                    "无法启动 Rust 表格处理进程。",
                    "error",
                    Vec::new(),
                    Some(json!({"code":"WORKER_START_FAILED","detail":err.to_string()})),
                ));
                self.finish(&job_id, &cancel_path);
                return;
            }
        };
        let protected = request.method.starts_with("kanzhang.");
        let _memory_limit = if protected {
            match crate::resource_budget::WorkerLimit::attach(&child) {
                Ok(limit) => Some(limit),
                Err(err) => {
                    terminate_process_tree(&mut child);
                    self.emit(event_for(
                        worker_tool_id,
                        &job_id,
                        "failed",
                        1,
                        1,
                        &err.user_message,
                        "error",
                        Vec::new(),
                        None,
                    ));
                    self.finish(&job_id, &cancel_path);
                    return;
                }
            }
        } else {
            None
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(
                stdin,
                "{}",
                serde_json::to_string(&request).unwrap_or_default()
            );
        }
        let (sender, receiver) = mpsc::channel::<Value>();
        if let Some(stdout) = child.stdout.take() {
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Ok(value) = serde_json::from_str(&line) {
                        let _ = sender.send(value);
                    }
                }
            });
        }
        let mut terminal = false;
        let mut cancel_started = None::<Instant>;
        loop {
            if protected && !terminal && crate::resource_budget::check_available().is_err() {
                terminate_process_tree(&mut child);
                self.emit(event_for(
                    worker_tool_id,
                    &job_id,
                    "failed",
                    1,
                    1,
                    "系统内存不足，已停止任务以保护电脑。请关闭其他大型程序后重试。",
                    "error",
                    Vec::new(),
                    None,
                ));
                let _ = child.wait();
                break;
            }
            while let Ok(payload) = receiver.try_recv() {
                terminal |= payload
                    .get("phase")
                    .and_then(Value::as_str)
                    .is_some_and(|phase| matches!(phase, "completed" | "failed" | "cancelled"));
                self.emit(payload);
            }
            if cancel_path.exists() {
                let started = cancel_started.get_or_insert_with(Instant::now);
                if started.elapsed() > Duration::from_secs(5) {
                    terminate_process_tree(&mut child);
                    if !terminal {
                        self.emit(event_for(
                            worker_tool_id,
                            &job_id,
                            "cancelled",
                            1,
                            1,
                            "任务已强制停止。",
                            "warning",
                            Vec::new(),
                            None,
                        ));
                    }
                    terminal = true;
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    while let Ok(payload) = receiver.recv_timeout(Duration::from_millis(100)) {
                        terminal |=
                            payload
                                .get("phase")
                                .and_then(Value::as_str)
                                .is_some_and(|phase| {
                                    matches!(phase, "completed" | "failed" | "cancelled")
                                });
                        self.emit(payload);
                        if terminal {
                            break;
                        }
                    }
                    if !terminal {
                        let (phase, severity, message) = if status.success() {
                            ("completed", "success", "任务已结束。")
                        } else {
                            (
                                "failed",
                                "error",
                                if protected {
                                    "看账任务异常退出，可能达到内存保护上限。请减小数据范围后重试。"
                                } else {
                                    "Rust Excel 处理进程异常退出。"
                                },
                            )
                        };
                        self.emit(event_for(
                            worker_tool_id,
                            &job_id,
                            phase,
                            1,
                            1,
                            message,
                            severity,
                            Vec::new(),
                            None,
                        ));
                    }
                    break;
                }
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(err) => {
                    self.emit(event_for(
                        worker_tool_id,
                        &job_id,
                        "failed",
                        1,
                        1,
                        "无法读取处理进程状态。",
                        "error",
                        Vec::new(),
                        Some(json!({"detail":err.to_string()})),
                    ));
                    break;
                }
            }
        }
        self.finish(&job_id, &cancel_path);
    }

    fn emit(&self, payload: Value) {
        if let Some(paths) = payload.get("outputPaths").and_then(Value::as_array) {
            for path in paths.iter().filter_map(Value::as_str) {
                self.allowed.0.lock().insert(PathBuf::from(path));
            }
        }
        let _ = self.app.state::<Storage>().record_job_event(&payload);
        // 使用统计：任务首次到达终态时记一条 job_run（取消/失败都算未成功）。
        // 从 job_starts 里取走时刻天然去重——同一任务重复的终态事件不会重复上报。
        let phase = payload.get("phase").and_then(Value::as_str);
        if matches!(phase, Some("completed" | "failed" | "cancelled")) {
            if let (Some(tool_id), Some(job_id)) = (
                payload.get("toolId").and_then(Value::as_str),
                payload.get("jobId").and_then(Value::as_str),
            ) {
                if let Some(started) = self.job_starts.lock().remove(job_id) {
                    if let Some(telemetry) = self.app.try_state::<crate::telemetry::Telemetry>() {
                        telemetry.track(
                            "job_run",
                            Some(tool_id),
                            None,
                            Some(phase == Some("completed")),
                            Some(started.elapsed().as_millis() as i64),
                        );
                    }
                }
            }
        }
        let _ = self.app.emit("job-event", payload);
    }

    fn finish(&self, job_id: &str, cancel_path: &Path) {
        let _ = fs::remove_file(cancel_path);
        self.job_starts.lock().remove(job_id);
        if let Some((_cancel, pause, _method)) = self.jobs.lock().remove(job_id) {
            let _ = fs::remove_file(pause);
        }
    }
}

/// 走任务通道的方法全集。
///
/// **提成常量数组而不是写在 `matches!` 里**：`lib.rs` 的 `job_start` 另有一份
/// 分发白名单，两处必须同步。此前 `file_list.scan`、`tbje_check.*` 都栽在
/// 「只登记了一处」上——前端点下去只报「未找到对应的 Rust 任务方法」。
/// 现在有了这个数组，一致性可以直接用测试断言。
pub(crate) const SUPPORTED_JOB_METHODS: &[&str] = &[
    "wp.generate",
    "confirmation.process",
    "file_list.export",
    "file_list.scan",
    "ts.inspect",
    "kanzhang.inspect",
    "excel_merger.merge",
    "ts.cache",
    "ts.filter",
    "ts.pivot",
    "ts.export",
    "kanzhang.map",
    "kanzhang.filter",
    "kanzhang.pivot",
    "kanzhang.export",
    "kanzhang.mark_inspect",
    "kanzhang.mark_export",
    "audipick.batch_extract",
    "fa.match",
    "fa.preview",
    "fa.export",
    "fa.dep_export",
    "fa.policy_export",
    "fa.tbje_preview",
    "fa.tbje_export",
    "roll_forward.process",
    "roll_forward.process_companies",
    "fx.fetch_rates",
    "fx.preview",
    "fx.export",
    "loan.preview",
    "loan.export",
    "deposit.preview",
    "deposit.export",
    "pdf2excel.convert",
    "fuzzy.match",
    "fuzzy.export",
    "tbje_check.run",
    "tbje_check.run_batch",
    "tbje_check.export",
    "tbje_check.export_batch",
];

fn is_supported_job_method(method: &str) -> bool {
    SUPPORTED_JOB_METHODS.contains(&method)
}

pub fn worker_main() -> i32 {
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return 2;
    }
    let request: WorkerRequest = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(_) => return 2,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let watch = cancel.clone();
    let cancel_path = PathBuf::from(&request.cancel_path);
    thread::spawn(move || {
        while !watch.load(Ordering::Relaxed) {
            if cancel_path.exists() {
                watch.store(true, Ordering::Relaxed);
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let job_id = request.job_id.clone();
    let worker_tool_id = tool_id(&request.method);
    let pause = PauseCheckpoint::new(PathBuf::from(&request.pause_path), cancel.clone());
    let progress_pause = pause.clone();
    let progress = |phase: &str, current: usize, total: usize, message: &str| {
        if progress_pause.wait().is_err() {
            return;
        }
        print_event(event_for(
            worker_tool_id,
            &job_id,
            phase,
            current,
            total,
            message,
            "info",
            Vec::new(),
            None,
        ));
    };
    let running_message = if request.method == "file_list.export" {
        "正在生成文件夹超链接清单…"
    } else if request.method == "wp.generate" {
        "Rust WP 服务单引擎正在生成…"
    } else if request.method == "confirmation.process" {
        "Rust 函证统计引擎正在处理…"
    } else if request.method == "fa.dep_export" {
        "Rust 固定资产折旧测算引擎正在处理…"
    } else if request.method == "fa.policy_export" {
        "Rust 固定资产折旧政策对比引擎正在处理…"
    } else if request.method.starts_with("fa.") {
        "Rust FA List 引擎正在处理…"
    } else if request.method.starts_with("roll_forward.") {
        "Rust WP Roll Forward 引擎正在处理…"
    } else if request.method.starts_with("tbje_check.") {
        "Rust TBJE 完整性核对引擎正在处理…"
    } else if request.method.starts_with("fuzzy.") {
        "Rust 两列匹配引擎正在处理…"
    } else {
        "Rust Polars 表格引擎正在处理…"
    };
    print_event(event_for(
        worker_tool_id,
        &request.job_id,
        "running",
        0,
        1,
        running_message,
        "info",
        Vec::new(),
        None,
    ));
    let result = if request.method == "wp.generate" {
        crate::wp::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method == "confirmation.process" {
        crate::confirmation::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method == "file_list.export" {
        crate::file_list::export(request.params, &progress, cancel, &pause)
    } else if request.method == "file_list.scan" {
        crate::file_list::scan_job(request.params, &progress, cancel, &pause)
    } else if request.method == "excel_merger.merge" {
        merge(request.params, &progress, cancel, &pause)
    } else if request.method == "audipick.batch_extract" {
        crate::audipick::run_batch(
            request.params,
            &progress,
            cancel,
            Path::new(&request.pause_path),
        )
    } else if request.method.starts_with("fa.") {
        crate::fa::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("roll_forward.") {
        crate::roll_forward::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("fx.") {
        crate::fx::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("deposit.") {
        crate::deposit_interest::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("loan.") {
        crate::loan_interest::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("pdf2excel.") {
        crate::pdf_to_excel::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("tbje_check.") {
        crate::tbje_check::run_job(&request.method, request.params, &progress, cancel, &pause)
    } else if request.method.starts_with("fuzzy.") {
        // 匹配结果按 jobId 落本机结果库（导出与跨会话恢复都靠它），worker 拿
        // 不到 Tauri state，这里把 WorkerRequest 自带的 jobId 注入 params。
        let mut params = request.params;
        if let Value::Object(ref mut map) = params {
            map.insert("__jobId".into(), json!(job_id));
        }
        crate::fuzzy_match::run_job(&request.method, params, &progress, cancel, &pause)
    } else {
        crate::tabular::run_job(&request.method, request.params, &progress, cancel, &pause)
    };
    match result {
        Ok(result) => {
            let outputs = result
                .get("outputPaths")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            print_event(event_for(
                worker_tool_id,
                &request.job_id,
                "completed",
                1,
                1,
                "处理完成。",
                "success",
                outputs,
                Some(result),
            ));
            0
        }
        Err(err) if err.code == "JOB_CANCELLED" => {
            print_event(event_for(
                worker_tool_id,
                &request.job_id,
                "cancelled",
                1,
                1,
                "任务已取消。",
                "warning",
                Vec::new(),
                Some(json!({"error":err})),
            ));
            0
        }
        Err(err) => {
            print_event(event_for(
                worker_tool_id,
                &request.job_id,
                "failed",
                1,
                1,
                &err.user_message,
                "error",
                Vec::new(),
                Some(json!({"error":err})),
            ));
            1
        }
    }
}

fn event_for(
    tool_id: &str,
    job_id: &str,
    phase: &str,
    current: usize,
    total: usize,
    message: &str,
    severity: &str,
    output_paths: Vec<String>,
    result: Option<Value>,
) -> Value {
    json!({"protocol":1,"jobId":job_id,"toolId":tool_id,"phase":phase,"current":current,"total":total,"message":message,"severity":severity,"outputPaths":output_paths,"result":result})
}

fn tool_id(method: &str) -> &'static str {
    if method.starts_with("wp.") {
        "wp_service_generator"
    } else if method.starts_with("confirmation.") {
        "confirmation_progress"
    } else if method.starts_with("file_list.") {
        "file_list_directory"
    } else if method.starts_with("ts.") {
        "ts_manager"
    } else if method.starts_with("kanzhang.mark_") {
        "je_sign_mark"
    } else if method.starts_with("kanzhang.") {
        "kanzhang"
    } else if method.starts_with("audipick.") {
        "audipick"
    } else if method.starts_with("tbje_check.") {
        "tbje_check"
    } else if method.starts_with("fa.dep_") {
        "fa_dep_calc"
    } else if method.starts_with("fa.policy_") {
        "fa_policy_compare"
    } else if method.starts_with("fa.") {
        "fa_list"
    } else if method.starts_with("roll_forward.") {
        "audit_roll_forward"
    } else if method.starts_with("fx.") {
        "fx_audit"
    } else if method.starts_with("deposit.") {
        "deposit_interest"
    } else if method.starts_with("loan.") {
        "loan_interest"
    } else if method.starts_with("pdf2excel.") {
        "pdf_to_excel"
    } else if method.starts_with("fuzzy.") {
        "fuzzy_match"
    } else {
        "Excel_Merger"
    }
}

fn print_event(value: Value) {
    println!("{}", value);
    let _ = std::io::stdout().flush();
}

#[cfg(windows)]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}
#[cfg(not(windows))]
fn terminate_process_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeParams {
    pub input_paths: Vec<String>,
    pub output_path: Option<String>,
    pub output_directory: Option<String>,
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default = "default_output_mode")]
    pub output_mode: String,
    #[serde(default = "default_direction")]
    pub direction: String,
    #[serde(default = "default_sheet_action")]
    pub sheet_action: String,
    #[serde(default)]
    pub target_sheets: Vec<String>,
    #[serde(default = "default_true")]
    pub add_hyperlinks: bool,
}

fn default_output_format() -> String {
    "xlsx".into()
}
fn default_output_mode() -> String {
    "one_sheet".into()
}
fn default_direction() -> String {
    "vertical".into()
}
fn default_sheet_action() -> String {
    "default".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectedFile {
    path: String,
    name: String,
    size: u64,
    sheets: Vec<String>,
    format: String,
    error: Option<String>,
}

#[derive(Debug, Clone)]
enum Cell {
    Empty,
    String(String),
    Float(f64),
    Int(i64),
    Bool(bool),
    DateTime(NaiveDateTime),
}

impl Cell {
    fn from_excel(value: &Data) -> Self {
        match value {
            Data::Empty => Self::Empty,
            Data::String(value) => Self::String(value.clone()),
            Data::Float(value) => Self::Float(*value),
            Data::Int(value) => Self::Int(*value),
            Data::Bool(value) => Self::Bool(*value),
            Data::DateTime(value) => value
                .as_datetime()
                .map(Self::DateTime)
                .unwrap_or_else(|| Self::Float(value.as_f64())),
            other => Self::String(other.to_string()),
        }
    }

    fn is_empty(&self) -> bool {
        matches!(self, Cell::Empty) || matches!(self, Cell::String(value) if value.is_empty())
    }

    fn display(&self) -> String {
        match self {
            Cell::Empty => String::new(),
            Cell::String(value) => value.clone(),
            Cell::Float(value) => value.to_string(),
            Cell::Int(value) => value.to_string(),
            Cell::Bool(value) => value.to_string(),
            Cell::DateTime(value) if value.time() == NaiveTime::MIN => {
                value.format("%Y-%m-%d").to_string()
            }
            Cell::DateTime(value) => value.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }

    fn is_number_like(&self) -> bool {
        match self {
            Cell::Float(_) | Cell::Int(_) => true,
            Cell::String(value) => value.replace(',', "").parse::<f64>().is_ok(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
struct SheetRows {
    file_path: PathBuf,
    file_name: String,
    sheet_name: String,
    include_sheet_column: bool,
    rows: Vec<Vec<Cell>>,
}

type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

pub fn call(method: &str, params: Value) -> Result<Value, AppError> {
    match method {
        "excel_merger.scan_folder" => {
            let folder = required_string(&params, "folder")?;
            scan_folder(Path::new(&folder))
        }
        "excel_merger.expand_paths" => {
            let values = params
                .get("paths")
                .and_then(Value::as_array)
                .ok_or_else(|| error("INVALID_ARGUMENT", "请选择文件或文件夹。", None))?;
            let paths = values
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            let files = expand_paths(&paths);
            Ok(json!({"inputPaths": strings(&files), "fileCount": files.len()}))
        }
        "excel_merger.inspect" => {
            let paths = parse_input_paths(&params)?;
            inspect(&paths)
        }
        _ => Err(error(
            "METHOD_NOT_FOUND",
            "未找到 Excel 合并方法。",
            Some(method.into()),
        )),
    }
}

pub fn merge(
    params: Value,
    progress: Progress<'_>,
    cancel: Arc<AtomicBool>,
    pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    pause.wait()?;
    let params: MergeParams = serde_json::from_value(params).map_err(|e| {
        error(
            "INVALID_ARGUMENT",
            "Excel 合并参数不完整。",
            Some(e.to_string()),
        )
    })?;
    validate_params(&params)?;
    let inputs = normalize_files(
        &params
            .input_paths
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>(),
    )?;
    let output = resolve_output(&params, &inputs)?;
    let normalized_output = output.canonicalize().unwrap_or_else(|_| output.clone());
    if inputs
        .iter()
        .any(|input| input.canonicalize().unwrap_or_else(|_| input.clone()) == normalized_output)
    {
        return Err(error(
            "OUTPUT_OVERWRITES_INPUT",
            "输出文件不能覆盖输入文件。",
            Some(output.display().to_string()),
        ));
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let working_output = partial_output_path(&output);
    let _ = fs::remove_file(&working_output);
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    progress("inspect", 0, inputs.len(), "正在检查输入文件…");

    let operation = (|| -> Result<Vec<String>, AppError> {
        if params.output_mode == "one_workbook" {
            merge_workbook_exact(&inputs, &working_output, &params, progress, &cancel)?;
            return Ok(Vec::new());
        }
        if params.direction == "vertical" {
            if working_output
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("csv"))
            {
                return write_vertical_csv_stream(
                    &inputs,
                    &working_output,
                    &params,
                    progress,
                    &cancel,
                );
            } else {
                return write_vertical_xlsx_stream(
                    &inputs,
                    &working_output,
                    &params,
                    progress,
                    &cancel,
                );
            }
        }
        let (sheets, warnings) = load_selected_sheets(&inputs, &params, progress, &cancel)?;
        if working_output
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("csv"))
        {
            write_horizontal_csv(&sheets, &working_output, progress, &cancel)?;
        } else {
            write_horizontal_xlsx(&sheets, &working_output, &params, progress, &cancel)?;
        }
        Ok(warnings)
    })();
    let warnings = match operation {
        Ok(warnings) => warnings,
        Err(err) => {
            let _ = fs::remove_file(&working_output);
            return Err(err);
        }
    };
    if output.exists() {
        fs::remove_file(&output).map_err(io_error)?;
    }
    fs::rename(&working_output, &output).map_err(io_error)?;
    pause.wait()?;
    progress("finalize", 1, 1, "正在完成并校验输出…");
    Ok(json!({
        "engine": "rust",
        "inputFiles": inputs.len(),
        "outputMode": params.output_mode,
        "direction": params.direction,
        "sheetAction": params.sheet_action,
        "targetSheets": params.target_sheets,
        "excelAutomation": params.output_mode == "one_workbook",
        "warnings": warnings,
        "outputPaths": [output.to_string_lossy()]
    }))
}

fn scan_folder(root: &Path) -> Result<Value, AppError> {
    if !root.is_dir() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到所选文件夹。",
            Some(root.display().to_string()),
        ));
    }
    let files = expand_paths(&[root.to_path_buf()]);
    Ok(
        json!({"folder": root.to_string_lossy(), "inputPaths": strings(&files), "fileCount": files.len()}),
    )
}

fn expand_paths(values: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let candidates: Vec<PathBuf> = if value.is_dir() {
            let mut paths = WalkDir::new(value)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
                .map(|e| e.into_path())
                .collect::<Vec<_>>();
            paths.sort_by_key(|path| path.to_string_lossy().to_lowercase());
            paths
        } else {
            vec![value.clone()]
        };
        for path in candidates {
            if !supported(&path) || !path.is_file() {
                continue;
            }
            let key = path.to_string_lossy().to_lowercase();
            if seen.insert(key) {
                files.push(path);
            }
        }
    }
    files
}

fn inspect(paths: &[PathBuf]) -> Result<Value, AppError> {
    let files = normalize_files(paths)?;
    let mut rows = Vec::new();
    let mut available = Vec::<String>::new();
    for path in files {
        let mut sheets = Vec::new();
        let mut issue = None;
        let text_input = is_text(&path);
        if !text_input {
            match open_workbook_auto(&path) {
                Ok(workbook) => sheets = workbook.sheet_names().to_vec(),
                Err(err) => issue = Some(format!("无法读取工作簿：{err}")),
            }
        }
        for sheet in &sheets {
            if !available.contains(sheet) {
                available.push(sheet.clone());
            }
        }
        rows.push(InspectedFile {
            format: if text_input {
                "分隔文本"
            } else if issue.is_some() {
                "格式未识别"
            } else {
                "Excel 工作簿"
            }
            .into(),
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            size: fs::metadata(&path).map(|v| v.len()).unwrap_or(0),
            sheets,
            error: issue,
        });
    }
    Ok(
        json!({"fileCount": rows.len(), "files": rows, "availableSheets": available, "engine": "rust"}),
    )
}

fn load_selected_sheets(
    inputs: &[PathBuf],
    params: &MergeParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(Vec<SheetRows>, Vec<String>), AppError> {
    let mut result = Vec::new();
    let mut warnings = Vec::new();
    for (index, path) in inputs.iter().enumerate() {
        check_cancel(cancel)?;
        progress(
            "read",
            index,
            inputs.len(),
            &format!("正在读取：{}", file_name(path)),
        );
        if is_text(path) {
            let mut rows = Vec::new();
            let read = for_each_text_row(path, cancel, |row| {
                rows.push(row);
                Ok(())
            });
            match read {
                Ok(()) => result.push(SheetRows {
                    file_path: path.clone(),
                    file_name: file_name(path),
                    sheet_name: "CSV".into(),
                    include_sheet_column: params.sheet_action != "default",
                    rows,
                }),
                Err(err) if err.code == "JOB_CANCELLED" => return Err(err),
                Err(err) => warnings.push(format!("{}: {}", file_name(path), err.user_message)),
            }
            continue;
        }
        let mut workbook = match open_workbook_auto(path) {
            Ok(workbook) => workbook,
            Err(err) => {
                warnings.push(format!("{}: 无法读取工作簿（{err}）", file_name(path)));
                continue;
            }
        };
        let names = target_sheet_names(&workbook.sheet_names(), params);
        if names.is_empty() {
            warnings.push(format!("{}: 未找到符合条件的 Sheet", file_name(path)));
            continue;
        }
        let include_sheet = names.len() > 1 || params.sheet_action != "default";
        for name in names {
            check_cancel(cancel)?;
            let range = match workbook.worksheet_range(&name) {
                Ok(range) => range,
                Err(err) => {
                    warnings.push(format!("{} / {}: 无法读取（{err}）", file_name(path), name));
                    continue;
                }
            };
            let rows = range
                .rows()
                .map(|row| row.iter().map(Cell::from_excel).collect())
                .collect();
            result.push(SheetRows {
                file_path: path.clone(),
                file_name: file_name(path),
                sheet_name: name,
                include_sheet_column: include_sheet,
                rows,
            });
        }
    }
    if result.iter().all(|sheet| sheet.rows.is_empty()) {
        return Err(no_data_error(&warnings));
    }
    Ok((result, warnings))
}

fn write_vertical_xlsx_stream(
    inputs: &[PathBuf],
    output: &Path,
    params: &MergeParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Vec<String>, AppError> {
    let mut workbook = Workbook::new();
    let mut sheet_no = 1usize;
    let mut worksheet = new_constant_sheet(&mut workbook, sheet_no)?;
    let mut out_row = 0usize;
    let mut wrote = false;
    let mut warnings = Vec::new();
    for (file_index, path) in inputs.iter().enumerate() {
        check_cancel(cancel)?;
        progress(
            "read",
            file_index,
            inputs.len(),
            &format!("正在流式读取：{}", file_name(path)),
        );
        if is_text(path) {
            let source = text_source(path, params);
            for_each_text_row(path, cancel, |row| {
                if row.iter().any(|cell| !cell.is_empty()) {
                    write_vertical_row(
                        &mut workbook,
                        &mut worksheet,
                        &mut sheet_no,
                        &mut out_row,
                        &source,
                        row.iter(),
                        params,
                        cancel,
                    )?;
                    wrote = true;
                }
                Ok(())
            })?;
            continue;
        }
        let mut source_workbook = match open_workbook_auto(path) {
            Ok(value) => value,
            Err(err) => {
                warnings.push(format!("{}: 无法读取工作簿（{err}）", file_name(path)));
                continue;
            }
        };
        let names = target_sheet_names(&source_workbook.sheet_names(), params);
        if names.is_empty() {
            warnings.push(format!("{}: 未找到符合条件的 Sheet", file_name(path)));
            continue;
        }
        let include_sheet = names.len() > 1 || params.sheet_action != "default";
        for name in names {
            check_cancel(cancel)?;
            progress(
                "read",
                file_index,
                inputs.len(),
                &format!("正在流式处理：{} / {}", file_name(path), name),
            );
            let range = match source_workbook.worksheet_range(&name) {
                Ok(v) => v,
                Err(err) => {
                    warnings.push(format!("{} / {}: 无法读取（{err}）", file_name(path), name));
                    continue;
                }
            };
            let source = SheetRows {
                file_path: path.clone(),
                file_name: file_name(path),
                sheet_name: name,
                include_sheet_column: include_sheet,
                rows: Vec::new(),
            };
            for data_row in range.rows().filter(|row| {
                row.iter().any(|cell| {
                    !matches!(cell, Data::Empty) && !matches!(cell,Data::String(v) if v.is_empty())
                })
            }) {
                let cells = data_row.iter().map(Cell::from_excel).collect::<Vec<_>>();
                write_vertical_row(
                    &mut workbook,
                    &mut worksheet,
                    &mut sheet_no,
                    &mut out_row,
                    &source,
                    cells.iter(),
                    params,
                    cancel,
                )?;
                wrote = true;
            }
        }
    }
    if !wrote {
        return Err(no_data_error(&warnings));
    }
    if params.add_hyperlinks && (sheet_no > 0 || out_row > EXCEL_MAX_HYPERLINKS) {
        warnings.push(format!(
            "每张工作表最多 {EXCEL_MAX_HYPERLINKS} 个超链接，超出部分的来源文件已改为纯文本，文件仍可正常打开。"
        ));
    }
    workbook.push_worksheet(worksheet);
    workbook.save(output).map_err(xlsx_error)?;
    Ok(warnings)
}

fn write_vertical_row<'a, I: Iterator<Item = &'a Cell>>(
    workbook: &mut Workbook,
    worksheet: &mut Worksheet,
    sheet_no: &mut usize,
    out_row: &mut usize,
    source: &SheetRows,
    row: I,
    params: &MergeParams,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    if *out_row % 1000 == 0 {
        check_cancel(cancel)?;
    }
    if *out_row >= EXCEL_MAX_ROWS {
        let old = std::mem::replace(worksheet, new_constant_sheet(workbook, *sheet_no + 1)?);
        workbook.push_worksheet(old);
        *sheet_no += 1;
        *out_row = 0;
    }
    // One source cell per row, so the row index is also the number of
    // hyperlinks already written to this worksheet.
    let hyperlink = params.add_hyperlinks && *out_row < EXCEL_MAX_HYPERLINKS;
    write_source_cell(worksheet, *out_row, 0, source, hyperlink)?;
    let mut col = 1usize;
    if source.include_sheet_column {
        worksheet
            .write_string(*out_row as u32, col as u16, &source.sheet_name)
            .map_err(xlsx_error)?;
        col += 1;
    }
    let values = row.collect::<Vec<_>>();
    let end = values
        .iter()
        .rposition(|value| !value.is_empty())
        .map(|v| v + 1)
        .unwrap_or(0);
    for value in values.into_iter().take(end) {
        if col >= EXCEL_MAX_COLS {
            return Err(error(
                "EXCEL_COLUMN_LIMIT",
                "合并结果超过 Excel 最大列数。",
                None,
            ));
        }
        write_cell(worksheet, *out_row, col, value)?;
        col += 1;
    }
    *out_row += 1;
    Ok(())
}

fn write_vertical_csv_stream(
    inputs: &[PathBuf],
    output: &Path,
    params: &MergeParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<Vec<String>, AppError> {
    let mut file = fs::File::create(output).map_err(io_error)?;
    file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().flexible(true).from_writer(file);
    let mut count = 0usize;
    let mut warnings = Vec::new();
    for (index, path) in inputs.iter().enumerate() {
        check_cancel(cancel)?;
        progress(
            "write",
            index,
            inputs.len(),
            &format!("正在合并：{}", file_name(path)),
        );
        let mut write_row = |source: &SheetRows, row: &[Cell]| -> Result<(), AppError> {
            if row.iter().all(Cell::is_empty) {
                return Ok(());
            }
            if count % 1000 == 0 {
                check_cancel(cancel)?;
                progress(
                    "write",
                    index,
                    inputs.len(),
                    &format!("正在合并：{}，已写出 {} 行", file_name(path), count),
                );
            }
            let mut record = vec![source.file_name.clone()];
            if source.include_sheet_column {
                record.push(source.sheet_name.clone());
            }
            record.extend(row.iter().map(Cell::display));
            writer.write_record(record).map_err(csv_error)?;
            count += 1;
            Ok(())
        };
        if is_text(path) {
            let source = text_source(path, params);
            // A late text decoding error must abort, never publish a partially read file.
            for_each_text_row(path, cancel, |row| write_row(&source, &row))?;
        } else {
            match load_selected_sheets(std::slice::from_ref(path), params, progress, cancel) {
                Ok((sheets, issues)) => {
                    warnings.extend(issues);
                    for source in &sheets {
                        for row in &source.rows {
                            write_row(source, row)?;
                        }
                    }
                }
                Err(err) if err.code == "MERGER_NO_DATA" => {
                    warnings.push(format!("{}：{}", file_name(path), err.user_message))
                }
                Err(err) => return Err(err),
            }
        }
    }
    if count == 0 {
        return Err(no_data_error(&warnings));
    }
    writer.flush().map_err(io_error)?;
    Ok(warnings)
}

fn horizontal_blocks(sheets: &[SheetRows]) -> Vec<(SheetRows, Vec<String>, Vec<Vec<Cell>>)> {
    sheets
        .iter()
        .cloned()
        .map(|sheet| {
            let (headers, rows) = normalize_horizontal(&sheet.rows);
            (sheet, headers, rows)
        })
        .collect()
}

fn write_horizontal_xlsx(
    sheets: &[SheetRows],
    output: &Path,
    params: &MergeParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let blocks = horizontal_blocks(sheets);
    let width: usize = blocks.iter().map(|(_, headers, _)| headers.len()).sum();
    if width > EXCEL_MAX_COLS {
        return Err(error(
            "EXCEL_COLUMN_LIMIT",
            "横向合并超过 Excel 最大 16,384 列。",
            None,
        ));
    }
    let height = blocks
        .iter()
        .map(|(_, _, rows)| rows.len())
        .max()
        .unwrap_or(0);
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    worksheet.set_name("合并结果").map_err(xlsx_error)?;
    let header_format = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_background_color("#D7E4BC");
    let link_format = header_format
        .clone()
        .set_font_color("#0563C1")
        .set_underline(FormatUnderline::Single);
    let mut start_col = 0usize;
    for (block, headers, rows) in &blocks {
        progress(
            "write",
            start_col,
            width,
            &format!("正在横向写入：{} / {}", block.file_name, block.sheet_name),
        );
        for (offset, header) in headers.iter().enumerate() {
            write_horizontal_source_cell(
                worksheet,
                start_col + offset,
                block,
                params,
                &header_format,
                &link_format,
            )?;
            worksheet
                .write_string_with_format(1, (start_col + offset) as u16, header, &header_format)
                .map_err(xlsx_error)?;
        }
        for (row_index, row) in rows.iter().enumerate() {
            if row_index % 1000 == 0 {
                check_cancel(cancel)?;
            }
            for (offset, value) in row.iter().enumerate() {
                write_cell(worksheet, row_index + 2, start_col + offset, value)?;
            }
        }
        start_col += headers.len();
    }
    if height + 2 > EXCEL_MAX_ROWS {
        return Err(error(
            "EXCEL_ROW_LIMIT",
            "横向合并超过 Excel 最大行数。",
            None,
        ));
    }
    workbook.save(output).map_err(xlsx_error)
}

fn write_horizontal_csv(
    sheets: &[SheetRows],
    output: &Path,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let blocks = horizontal_blocks(sheets);
    let mut file = fs::File::create(output).map_err(io_error)?;
    file.write_all(&[0xEF, 0xBB, 0xBF]).map_err(io_error)?;
    let mut writer = csv::WriterBuilder::new().from_writer(file);
    let mut source_row = Vec::new();
    let mut header_row = Vec::new();
    for (block, headers, _) in &blocks {
        let display = if block.include_sheet_column {
            format!("{} ({})", block.file_name, block.sheet_name)
        } else {
            block.file_name.clone()
        };
        source_row.extend(std::iter::repeat_n(display, headers.len()));
        header_row.extend(headers.clone());
    }
    writer.write_record(source_row).map_err(csv_error)?;
    writer.write_record(header_row).map_err(csv_error)?;
    let height = blocks
        .iter()
        .map(|(_, _, rows)| rows.len())
        .max()
        .unwrap_or(0);
    for row_index in 0..height {
        if row_index % 1000 == 0 {
            check_cancel(cancel)?;
        }
        progress("write", row_index, height, "正在横向写出 CSV…");
        let mut record = Vec::new();
        for (_, headers, rows) in &blocks {
            for col in 0..headers.len() {
                record.push(
                    rows.get(row_index)
                        .and_then(|row| row.get(col))
                        .map(Cell::display)
                        .unwrap_or_default(),
                );
            }
        }
        writer.write_record(record).map_err(csv_error)?;
    }
    writer.flush().map_err(io_error)
}

#[cfg(windows)]
fn merge_workbook_exact(
    inputs: &[PathBuf],
    output: &Path,
    params: &MergeParams,
    progress: Progress<'_>,
    cancel: &AtomicBool,
) -> Result<(), AppError> {
    let mut used = HashSet::new();
    used.insert("reference".to_string());
    let mut plans = Vec::new();
    let mut prepared_inputs = Vec::new();
    for path in inputs {
        check_cancel(cancel)?;
        let prepared = crate::spreadsheet_input::prepare_xlsx(path)?;
        let source_path = prepared.path().to_path_buf();
        let names = if is_text(&source_path) {
            vec![String::new()]
        } else {
            let workbook = open_workbook_auto(&source_path).map_err(|e| {
                error(
                    "WORKBOOK_READ_FAILED",
                    "无法读取工作簿。",
                    Some(format!("{}: {e}", path.display())),
                )
            })?;
            target_sheet_names(&workbook.sheet_names(), params)
        };
        for sheet_name in &names {
            let preferred = if names.len() > 1 || params.sheet_action != "default" {
                format!(
                    "{}_{}",
                    stem(path),
                    if sheet_name.is_empty() {
                        "Sheet1"
                    } else {
                        sheet_name
                    }
                )
            } else {
                stem(path)
            };
            plans.push(crate::excel_com::CopySheet {
                source_path: source_path.clone(),
                source_sheet: sheet_name.clone(),
                output_sheet: unique_sheet_name(&preferred, &mut used),
                source_file: file_name(path),
            });
        }
        prepared_inputs.push(prepared);
    }
    crate::excel_com::copy_sheets_exact(&plans, output, params.add_hyperlinks, progress, &|| {
        check_cancel(cancel)
    })
}

#[cfg(not(windows))]
fn merge_workbook_exact(
    _inputs: &[PathBuf],
    _output: &Path,
    _params: &MergeParams,
    _progress: Progress<'_>,
    _cancel: &AtomicBool,
) -> Result<(), AppError> {
    Err(error(
        "EXCEL_COM_UNAVAILABLE",
        "多 Sheet 原样复制仅支持 Windows 与 Microsoft Excel。",
        None,
    ))
}

fn normalize_horizontal(rows: &[Vec<Cell>]) -> (Vec<String>, Vec<Vec<Cell>>) {
    let mut first_row = None;
    let mut first_col = 0usize;
    for (row_index, row) in rows.iter().take(20).enumerate() {
        if let Some(col) = row.iter().position(|cell| !cell.is_empty()) {
            first_row = Some(row_index);
            first_col = col;
            break;
        }
    }
    let Some(row_index) = first_row else {
        return (Vec::new(), Vec::new());
    };
    let candidate = rows[row_index][first_col..].to_vec();
    let has_number = candidate
        .iter()
        .filter(|v| !v.is_empty())
        .any(Cell::is_number_like);
    let headers: Vec<String> = if has_number {
        (0..candidate.len())
            .map(|index| format!("column_{}", index + 1))
            .collect()
    } else {
        candidate.iter().map(Cell::display).collect()
    };
    let start = if has_number { row_index } else { row_index + 1 };
    let data = rows[start..]
        .iter()
        .filter_map(|row| {
            let mut values = row.get(first_col..).unwrap_or(&[]).to_vec();
            if values.iter().all(Cell::is_empty) {
                return None;
            }
            values.resize(headers.len(), Cell::Empty);
            values.truncate(headers.len());
            Some(values)
        })
        .collect();
    (headers, data)
}

#[cfg(test)]
fn read_text_rows(path: &Path) -> Result<Vec<Vec<Cell>>, AppError> {
    let mut rows = Vec::new();
    for_each_text_row(path, &AtomicBool::new(false), |row| {
        rows.push(row);
        Ok(())
    })?;
    Ok(rows)
}

fn for_each_text_row(
    path: &Path,
    cancel: &AtomicBool,
    mut visit: impl FnMut(Vec<Cell>) -> Result<(), AppError>,
) -> Result<(), AppError> {
    crate::spreadsheet_input::for_each_text_row(path, cancel, |row| {
        visit(row.into_iter().map(Cell::String).collect())
    })
}

fn text_source(path: &Path, params: &MergeParams) -> SheetRows {
    SheetRows {
        file_path: path.to_path_buf(),
        file_name: file_name(path),
        sheet_name: "CSV".into(),
        include_sheet_column: params.sheet_action != "default",
        rows: Vec::new(),
    }
}

fn new_constant_sheet(workbook: &mut Workbook, number: usize) -> Result<Worksheet, AppError> {
    let mut worksheet = workbook.new_worksheet_with_constant_memory();
    worksheet
        .set_name(if number == 1 {
            "Merged".into()
        } else {
            format!("Merged_{number}")
        })
        .map_err(xlsx_error)?;
    Ok(worksheet)
}

fn write_source_cell(
    worksheet: &mut Worksheet,
    row: usize,
    col: usize,
    source: &SheetRows,
    hyperlink: bool,
) -> Result<(), AppError> {
    if hyperlink {
        let link = format!("file:///{}", source.file_path.to_string_lossy());
        worksheet
            .write(
                row as u32,
                col as u16,
                Url::new(link).set_text(&source.file_name),
            )
            .map_err(xlsx_error)?;
    } else {
        worksheet
            .write_string(row as u32, col as u16, &source.file_name)
            .map_err(xlsx_error)?;
    }
    Ok(())
}

fn write_horizontal_source_cell(
    worksheet: &mut Worksheet,
    col: usize,
    source: &SheetRows,
    params: &MergeParams,
    header_format: &Format,
    link_format: &Format,
) -> Result<(), AppError> {
    let display = if params.sheet_action != "default" {
        format!("{} ({})", source.file_name, source.sheet_name)
    } else {
        source.file_name.clone()
    };
    if params.add_hyperlinks {
        let link = format!("file:///{}", source.file_path.to_string_lossy());
        worksheet
            .write_url_with_format(
                0,
                col as u16,
                Url::new(link).set_text(&display),
                link_format,
            )
            .map_err(xlsx_error)?;
    } else {
        worksheet
            .write_string_with_format(0, col as u16, &display, header_format)
            .map_err(xlsx_error)?;
    }
    Ok(())
}

fn write_cell(
    worksheet: &mut Worksheet,
    row: usize,
    col: usize,
    value: &Cell,
) -> Result<(), AppError> {
    match value {
        Cell::Empty => {}
        Cell::String(value) => {
            worksheet
                .write_string(row as u32, col as u16, value)
                .map_err(xlsx_error)?;
        }
        Cell::Float(value) => {
            worksheet
                .write_number(row as u32, col as u16, *value)
                .map_err(xlsx_error)?;
        }
        Cell::Int(value) => {
            worksheet
                .write_number(row as u32, col as u16, *value as f64)
                .map_err(xlsx_error)?;
        }
        Cell::Bool(value) => {
            worksheet
                .write_boolean(row as u32, col as u16, *value)
                .map_err(xlsx_error)?;
        }
        Cell::DateTime(value) => {
            let number_format = if value.time() == NaiveTime::MIN {
                "yyyy-mm-dd"
            } else {
                "yyyy-mm-dd hh:mm:ss"
            };
            let format = Format::new().set_num_format(number_format);
            worksheet
                .write_with_format(row as u32, col as u16, value, &format)
                .map_err(xlsx_error)?;
        }
    }
    Ok(())
}

fn validate_params(params: &MergeParams) -> Result<(), AppError> {
    if params.input_paths.is_empty() {
        return Err(error("INVALID_ARGUMENT", "请至少添加一个输入文件。", None));
    }
    if !matches!(params.output_mode.as_str(), "one_sheet" | "one_workbook") {
        return Err(error("MERGER_MODE_INVALID", "输出模式不正确。", None));
    }
    if !matches!(params.direction.as_str(), "vertical" | "horizontal") {
        return Err(error("MERGER_DIRECTION_INVALID", "拼接方向不正确。", None));
    }
    if !matches!(
        params.sheet_action.as_str(),
        "default" | "match_selected" | "merge_all"
    ) {
        return Err(error(
            "MERGER_SHEET_ACTION_INVALID",
            "Sheet 范围不正确。",
            None,
        ));
    }
    if params.sheet_action == "match_selected" && params.target_sheets.is_empty() {
        return Err(error(
            "MERGER_SHEETS_REQUIRED",
            "请至少选择一个 Sheet。",
            None,
        ));
    }
    if params.output_mode == "one_workbook" && params.output_format.eq_ignore_ascii_case("csv") {
        return Err(error(
            "MERGER_WORKBOOK_REQUIRES_XLSX",
            "多 Sheet 工作簿必须输出 XLSX。",
            None,
        ));
    }
    Ok(())
}

fn resolve_output(params: &MergeParams, inputs: &[PathBuf]) -> Result<PathBuf, AppError> {
    if let Some(path) = params
        .output_path
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        return Ok(PathBuf::from(path));
    }
    let directory = params
        .output_directory
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| inputs[0].parent().unwrap_or(Path::new(".")).to_path_buf());
    if !directory.is_dir() {
        return Err(error(
            "PATH_NOT_FOUND",
            "找不到输出目录。",
            Some(directory.display().to_string()),
        ));
    }
    let extension = if params.output_mode == "one_workbook" {
        "xlsx"
    } else if params.output_format.eq_ignore_ascii_case("csv") {
        "csv"
    } else {
        "xlsx"
    };
    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    let mut output = directory.join(format!("Excel合并结果_{stamp}.{extension}"));
    let mut index = 1;
    while output.exists() {
        output = directory.join(format!("Excel合并结果_{stamp}_{index}.{extension}"));
        index += 1;
    }
    Ok(output)
}

fn partial_output_path(output: &Path) -> PathBuf {
    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("xlsx");
    let stem = output.file_stem().unwrap_or_default().to_string_lossy();
    output.with_file_name(format!(
        ".{stem}.{}.partial.{extension}",
        uuid::Uuid::new_v4().simple()
    ))
}

fn target_sheet_names(all: &[String], params: &MergeParams) -> Vec<String> {
    match params.sheet_action.as_str() {
        "merge_all" => all.to_vec(),
        "match_selected" => all
            .iter()
            .filter(|name| params.target_sheets.contains(name))
            .cloned()
            .collect(),
        _ => all.first().cloned().into_iter().collect(),
    }
}

fn unique_sheet_name(preferred: &str, used: &mut HashSet<String>) -> String {
    let cleaned: String = preferred
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { '_' } else { c })
        .collect();
    let base: String = cleaned.chars().take(31).collect();
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("_{index}")
        };
        let keep = 31usize.saturating_sub(suffix.chars().count());
        let candidate = format!("{}{}", base.chars().take(keep).collect::<String>(), suffix);
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    "Sheet".into()
}

fn parse_input_paths(params: &Value) -> Result<Vec<PathBuf>, AppError> {
    let values = params
        .get("inputPaths")
        .and_then(Value::as_array)
        .ok_or_else(|| error("INVALID_ARGUMENT", "请至少添加一个输入文件。", None))?;
    Ok(values
        .iter()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect())
}

fn normalize_files(values: &[PathBuf]) -> Result<Vec<PathBuf>, AppError> {
    let files = expand_paths(values);
    if files.is_empty() {
        return Err(error("INVALID_ARGUMENT", "没有找到支持的输入文件。", None));
    }
    Ok(files)
}

fn strings(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}
fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| SUPPORTED.contains(&v.to_ascii_lowercase().as_str()))
}
fn no_data_error(warnings: &[String]) -> AppError {
    let detail = warnings
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let message = if detail.is_empty() {
        "没有读取到有效数据，请检查源文件是否为空。".into()
    } else {
        format!("没有读取到有效数据。\n{detail}")
    };
    error("MERGER_NO_DATA", &message, None)
}
fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn required_string(params: &Value, key: &str) -> Result<String, AppError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error("INVALID_ARGUMENT", "缺少必填路径。", Some(key.into())))
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn cancelled() -> AppError {
    error("JOB_CANCELLED", "任务已取消。", None)
}
fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}
fn io_error(error_value: std::io::Error) -> AppError {
    error("IO_ERROR", "文件读写失败。", Some(error_value.to_string()))
}
fn csv_error(error_value: csv::Error) -> AppError {
    error(
        "CSV_ERROR",
        "CSV 文件处理失败。",
        Some(error_value.to_string()),
    )
}
fn xlsx_error(error_value: rust_xlsxwriter::XlsxError) -> AppError {
    error(
        "XLSX_WRITE_FAILED",
        "Excel 文件写出失败。",
        Some(error_value.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader;
    use std::io::Read;

    fn test_merge(params: Value, cancel: Arc<AtomicBool>) -> Result<Value, AppError> {
        let pause = PauseCheckpoint::unpaused(cancel.clone());
        merge(params, &|_, _, _, _| {}, cancel, &pause)
    }

    #[test]
    fn pause_checkpoint_blocks_progress_and_output_until_resumed() {
        let root =
            std::env::temp_dir().join(format!("audit-pause-resume-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("job.pause");
        fs::write(&marker, b"pause").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let gate = PauseCheckpoint::new(marker.clone(), cancel);
        let progress_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let output = root.join("output.done");
        let count = progress_count.clone();
        let output_in_worker = output.clone();
        let worker = thread::spawn(move || {
            gate.wait().unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            fs::write(output_in_worker, b"complete").unwrap();
        });

        thread::sleep(Duration::from_millis(200));
        assert_eq!(progress_count.load(Ordering::SeqCst), 0);
        assert!(!output.exists());
        fs::remove_file(marker).unwrap();
        worker.join().unwrap();
        assert_eq!(progress_count.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(&output).unwrap(), b"complete");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pause_checkpoint_cancels_promptly_while_paused() {
        let root =
            std::env::temp_dir().join(format!("audit-pause-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("job.pause");
        fs::write(&marker, b"pause").unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let gate = PauseCheckpoint::new(marker, cancel.clone());
        let started = Instant::now();
        let worker = thread::spawn(move || gate.wait());
        thread::sleep(Duration::from_millis(100));
        cancel.store(true, Ordering::Relaxed);
        let error = worker.join().unwrap().unwrap_err();
        assert_eq!(error.code, "JOB_CANCELLED");
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = fs::remove_dir_all(root);
    }

    fn sample_book(path: &Path, sheet: &str, rows: &[&[&str]]) {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(sheet).unwrap();
        for (row, values) in rows.iter().enumerate() {
            for (col, value) in values.iter().enumerate() {
                worksheet
                    .write_string(row as u32, col as u16, *value)
                    .unwrap();
            }
        }
        workbook.save(path).unwrap();
    }

    #[cfg(windows)]
    fn rich_book(path: &Path, sheet: &str, label: &str) {
        let mut workbook = Workbook::new();
        let worksheet = workbook.add_worksheet();
        worksheet.set_name(sheet).unwrap();
        let title = Format::new().set_bold().set_background_color("#FFF2CC");
        worksheet.merge_range(0, 0, 0, 1, label, &title).unwrap();
        worksheet.write_number(1, 0, 1).unwrap();
        worksheet.write_formula(1, 1, "=A2+1").unwrap();
        worksheet.set_column_width(0, 24).unwrap();
        workbook.save(path).unwrap();
    }

    fn base_params(inputs: &[PathBuf], output: &Path) -> Value {
        json!({
            "inputPaths": strings(inputs),
            "outputPath": output.to_string_lossy(),
            "outputFormat": "xlsx",
            "outputMode": "one_sheet",
            "direction": "vertical",
            "sheetAction": "default",
            "targetSheets": [],
            "addHyperlinks": false
        })
    }

    #[test]
    fn real_biff8_xls_and_text_xls_merge_together() {
        let root = std::env::temp_dir().join(format!("audit-biff8-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let binary = root.join("真正.XLS");
        fs::write(
            &binary,
            include_bytes!("../../tests/fixtures/Excel Merger/simple-biff8.xls"),
        )
        .unwrap();
        assert!(!is_text(&binary));
        assert_eq!(
            inspect(std::slice::from_ref(&binary)).unwrap()["files"][0]["sheets"][0],
            "明细"
        );
        let text = root.join("文本.xls");
        fs::write(&text, GBK.encode("编号\t金额\n002\t456.50\n").0.as_ref()).unwrap();
        for extension in ["csv", "xlsx"] {
            let output = root.join(format!("混合.{extension}"));
            let mut params = base_params(&[binary.clone(), text.clone()], &output);
            params["outputFormat"] = extension.into();
            test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
            let rows: Vec<Vec<Cell>> = if extension == "csv" {
                read_text_rows(&output).unwrap()
            } else {
                open_workbook_auto(&output)
                    .unwrap()
                    .worksheet_range("Merged")
                    .unwrap()
                    .rows()
                    .map(|row| row.iter().map(Cell::from_excel).collect())
                    .collect()
            };
            assert_eq!(rows.len(), 4);
            assert_eq!(rows[1][1].display(), "001");
            assert_eq!(rows[1][2].display(), "123.5");
            assert_eq!(rows[3][1].display(), "002");
            assert_eq!(rows[3][2].display(), "456.50");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn text_xls_encodings_stream_to_csv_and_xlsx() {
        let root = std::env::temp_dir().join(format!("audit-text-xls-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let text = "公司代码\t公司名称\t金额\r\n001009\t\"中文\t名称\"\t1,234.50\r\n001010\t\"跨行\r\n名称\"\t-2\r\n";
        let mut encodings = vec![GBK.encode(text).0.into_owned(), text.as_bytes().to_vec()];
        encodings.push([vec![0xEF, 0xBB, 0xBF], text.as_bytes().to_vec()].concat());
        encodings.push(
            [
                vec![0xFF, 0xFE],
                text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
            ]
            .concat(),
        );
        encodings.push(
            [
                vec![0xFE, 0xFF],
                text.encode_utf16().flat_map(u16::to_be_bytes).collect(),
            ]
            .concat(),
        );
        for (index, bytes) in encodings.iter().enumerate() {
            let input = root.join(format!("输入{index}.XLS"));
            fs::write(&input, bytes).unwrap();
            assert!(is_text(&input));
            let inspected = inspect(std::slice::from_ref(&input)).unwrap();
            assert_eq!(inspected["files"][0]["format"], "分隔文本");
            assert!(inspected["files"][0]["error"].is_null());
            for extension in ["csv", "xlsx"] {
                let output = root.join(format!("输出{index}.{extension}"));
                let mut params = base_params(std::slice::from_ref(&input), &output);
                params["outputFormat"] = extension.into();
                params["sheetAction"] = "merge_all".into();
                test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
                let rows = if extension == "csv" {
                    read_text_rows(&output).unwrap()
                } else {
                    open_workbook_auto(&output)
                        .unwrap()
                        .worksheet_range("Merged")
                        .unwrap()
                        .rows()
                        .map(|row| row.iter().map(Cell::from_excel).collect())
                        .collect()
                };
                assert_eq!(rows.len(), 3);
                assert_eq!(rows[0][2].display(), "公司代码");
                assert_eq!(rows[1][2].display(), "001009");
                assert_eq!(rows[1][3].display(), "中文\t名称");
                assert_eq!(rows[1][4].display(), "1,234.50");
                assert_eq!(rows[2][3].display(), "跨行\r\n名称");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn text_xls_stream_boundaries_cancel_and_late_decode_failure() {
        let root = std::env::temp_dir().join(format!("audit-text-stream-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("长文本.XLS");
        let text = format!("编号\t名称\n{}", "001\t中文名称\n".repeat(20_000));
        fs::write(&input, GBK.encode(&text).0.as_ref()).unwrap();
        let cancel = AtomicBool::new(false);
        let mut count = 0;
        for_each_text_row(&input, &cancel, |row| {
            if count > 0 {
                assert_eq!(row[1].display(), "中文名称");
            }
            count += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(count, 20_001);
        let err = for_each_text_row(&input, &cancel, |_| {
            cancel.store(true, Ordering::Relaxed);
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.code, "JOB_CANCELLED");
        let mut bytes = GBK.encode(&text).0.into_owned();
        bytes.push(0x81); // dangling GBK lead byte, beyond the sniff sample
        fs::write(&input, bytes).unwrap();
        let output = root.join("结果.csv");
        let mut params = base_params(&[input], &output);
        params["outputFormat"] = "csv".into();
        let err = test_merge(params, Arc::new(AtomicBool::new(false))).unwrap_err();
        assert_eq!(err.code, "TEXT_READ_FAILED");
        assert!(err.user_message.contains("长文本.XLS"));
        assert!(!output.exists());
        assert!(!partial_output_path(&output).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn xls_detection_does_not_swallow_workbooks_or_markup_and_keeps_errors() {
        let root = std::env::temp_dir().join(format!("audit-xls-detect-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("源.XLS");
        sample_book(&input, "明细", &[&["编号", "金额"], &["001", "2"]]);
        assert!(!is_text(&input));
        assert_eq!(
            inspect(std::slice::from_ref(&input)).unwrap()["files"][0]["sheets"][0],
            "明细"
        );
        let output = root.join("结果.csv");
        let mut params = base_params(std::slice::from_ref(&input), &output);
        params["outputFormat"] = "csv".into();
        test_merge(params.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(read_text_rows(&output).unwrap()[1][1].display(), "001");
        fs::remove_file(&output).unwrap();
        for bytes in [
            b"<html>\t<table>\na\tb".as_slice(),
            b"\xD0\xCF\x11\xE0\ta\nb\tc",
            b"broken workbook",
        ] {
            fs::write(&input, bytes).unwrap();
            assert!(!is_text(&input));
            let err = test_merge(params.clone(), Arc::new(AtomicBool::new(false))).unwrap_err();
            assert_eq!(err.code, "MERGER_NO_DATA");
            assert!(err.user_message.contains("源.XLS"));
            assert!(!output.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fa_jobs_have_a_dedicated_native_tool_id() {
        for method in [
            "fa.match",
            "fa.preview",
            "fa.export",
            "fa.tbje_preview",
            "fa.tbje_export",
        ] {
            assert_eq!(tool_id(method), "fa_list");
            assert!(is_supported_job_method(method));
        }
        assert_eq!(tool_id("fa.unknown"), "fa_list");
        assert!(!is_supported_job_method("fa.unknown"));
    }

    /// 正负数智能标记复用 kanzhang. 前缀（读取、科目取值都是同一套），
    /// 但它的 job 事件必须走自己的 toolId，否则会被看账页面接走。
    #[test]
    fn je_mark_jobs_route_to_their_own_tool() {
        for method in ["kanzhang.mark_inspect", "kanzhang.mark_export"] {
            assert_eq!(tool_id(method), "je_sign_mark");
            assert!(is_supported_job_method(method));
        }
        // 看账自己的方法不能被 mark_ 分支顺手带走。
        for method in ["kanzhang.inspect", "kanzhang.filter", "kanzhang.export"] {
            assert_eq!(tool_id(method), "kanzhang");
        }
        assert!(!is_supported_job_method("kanzhang.mark_unknown"));
    }

    /// FA 子工具的 job 事件必须路由到各自的页面（useJobEvents 按 toolId 过滤），
    /// 不能落进 fa. 前缀兜底被当成 fa_list。
    #[test]
    fn fa_subtool_jobs_route_to_their_own_tools() {
        assert_eq!(tool_id("fa.dep_export"), "fa_dep_calc");
        assert!(is_supported_job_method("fa.dep_export"));
        assert_eq!(tool_id("fa.policy_export"), "fa_policy_compare");
        assert!(is_supported_job_method("fa.policy_export"));
        // 主工具路由不受影响。
        assert_eq!(tool_id("fa.preview"), "fa_list");
    }

    #[test]
    fn roll_forward_jobs_have_a_dedicated_native_tool_id() {
        for method in ["roll_forward.process", "roll_forward.process_companies"] {
            assert_eq!(tool_id(method), "audit_roll_forward");
            assert!(is_supported_job_method(method));
        }
        assert_eq!(tool_id("roll_forward.unknown"), "audit_roll_forward");
        assert!(!is_supported_job_method("roll_forward.unknown"));
    }

    #[test]
    fn scan_inspect_and_vertical_merge_are_rust_native() {
        let root = std::env::temp_dir().join(format!("audit-rust-merger-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("一.xlsx");
        let second = root.join("二.xlsx");
        let output = root.join("结果.xlsx");
        sample_book(&first, "明细", &[&["姓名", "金额"], &["甲", "100"]]);
        sample_book(&second, "明细", &[&["姓名", "金额"], &["乙", "200"]]);

        let scanned = call("excel_merger.scan_folder", json!({"folder":root})).unwrap();
        assert_eq!(scanned["fileCount"], 2);
        let inspected = call(
            "excel_merger.inspect",
            json!({"inputPaths":[first, second]}),
        )
        .unwrap();
        assert_eq!(inspected["engine"], "rust");
        assert_eq!(inspected["availableSheets"], json!(["明细"]));

        let params = base_params(&[root.join("一.xlsx"), root.join("二.xlsx")], &output);
        let result = test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
        assert_eq!(result["engine"], "rust");
        let mut book = open_workbook_auto(&output).unwrap();
        let range = book.worksheet_range("Merged").unwrap();
        let values = range
            .rows()
            .map(|row| row.iter().map(ToString::to_string).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        assert_eq!(values.len(), 4);
        assert_eq!(values[0][1], "姓名");
        assert_eq!(values[3][2], "200");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn horizontal_merge_detects_headers_and_pads_short_tables() {
        let root =
            std::env::temp_dir().join(format!("audit-rust-horizontal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("左.xlsx");
        let second = root.join("右.xlsx");
        let output = root.join("横向.csv");
        sample_book(
            &first,
            "数据",
            &[&["姓名", "金额"], &["甲", "100"], &["乙", "200"]],
        );
        sample_book(&second, "数据", &[&["合同", "日期"], &["A", "2026-01-01"]]);
        let mut params = base_params(&[first, second], &output);
        params["outputFormat"] = "csv".into();
        params["direction"] = "horizontal".into();
        test_merge(params, Arc::new(AtomicBool::new(false))).unwrap();
        let bytes = fs::read(&output).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8_lossy(&bytes[3..]);
        assert!(text.contains("姓名,金额,合同,日期"));
        assert!(text.contains("乙,200,,"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancelled_job_does_not_create_output() {
        let root = std::env::temp_dir().join(format!("audit-rust-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("输入.xlsx");
        let output = root.join("结果.xlsx");
        sample_book(&input, "Sheet1", &[&["A"]]);
        let cancel = Arc::new(AtomicBool::new(true));
        let error = test_merge(base_params(&[input], &output), cancel).unwrap_err();
        assert_eq!(error.code, "JOB_CANCELLED");
        assert!(!output.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn automatic_output_names_do_not_overwrite_and_csv_has_bom() {
        let root = std::env::temp_dir().join(format!("audit-rust-output-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("输入.xlsx");
        sample_book(&input, "Sheet1", &[&["编号", "金额"], &["1", "100"]]);
        let params = json!({
            "inputPaths":[input], "outputDirectory":root, "outputFormat":"xlsx",
            "outputMode":"one_sheet", "direction":"vertical", "sheetAction":"default",
            "targetSheets":[], "addHyperlinks":false
        });
        let first = test_merge(params.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        let second = test_merge(params.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        assert_ne!(first["outputPaths"][0], second["outputPaths"][0]);
        let mut csv_params = params;
        csv_params["outputFormat"] = "csv".into();
        let csv = test_merge(csv_params, Arc::new(AtomicBool::new(false))).unwrap();
        let csv_path = PathBuf::from(csv["outputPaths"][0].as_str().unwrap());
        assert!(fs::read(csv_path).unwrap().starts_with(&[0xEF, 0xBB, 0xBF]));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn unreadable_workbook_is_reported_without_losing_valid_files() {
        let root =
            std::env::temp_dir().join(format!("audit-rust-warning-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let valid = root.join("正常.xlsx");
        let broken = root.join("损坏.xlsx");
        let output = root.join("结果.xlsx");
        sample_book(&valid, "Sheet1", &[&["A"], &["1"]]);
        fs::write(&broken, b"not an xlsx").unwrap();
        let result = test_merge(
            base_params(&[broken, valid], &output),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(result["warnings"].as_array().unwrap().len(), 1);
        assert!(output.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn output_cannot_replace_an_input_file() {
        let root =
            std::env::temp_dir().join(format!("audit-rust-overwrite-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("输入.xlsx");
        sample_book(&input, "Sheet1", &[&["A"]]);
        let error = test_merge(
            base_params(std::slice::from_ref(&input), &input),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(error.code, "OUTPUT_OVERWRITES_INPUT");
        assert!(input.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sheet_names_are_excel_safe_and_case_insensitively_unique() {
        let mut used = HashSet::new();
        assert_eq!(unique_sheet_name("A/B:*?[]\\", &mut used), "A_B______");
        assert_eq!(unique_sheet_name("a_b______", &mut used), "a_b_______1");
        assert!(
            unique_sheet_name(&"中".repeat(40), &mut used)
                .chars()
                .count()
                <= 31
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires desktop Microsoft Excel"]
    fn excel_com_preserves_formula_and_sheet_order() {
        let root = std::env::temp_dir().join(format!("audit-rust-com-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("甲.xlsx");
        let second = root.join("乙.xlsx");
        let output = root.join("原样复制.xlsx");
        rich_book(&first, "底稿一", "甲标题");
        rich_book(&second, "底稿二", "乙标题");
        let plans = vec![
            crate::excel_com::CopySheet {
                source_path: first,
                source_sheet: "底稿一".into(),
                output_sheet: "甲".into(),
                source_file: "甲.xlsx".into(),
            },
            crate::excel_com::CopySheet {
                source_path: second,
                source_sheet: "底稿二".into(),
                output_sheet: "乙".into(),
                source_file: "乙.xlsx".into(),
            },
        ];
        crate::excel_com::copy_sheets_exact(&plans, &output, true, &|_, _, _, _| {}, &|| Ok(()))
            .unwrap();
        let mut workbook = open_workbook_auto(&output).unwrap();
        assert_eq!(workbook.sheet_names(), &["Reference", "甲", "乙"]);
        let formulas = workbook.worksheet_formula("甲").unwrap();
        assert!(
            formulas
                .rows()
                .flatten()
                .any(|formula| formula.contains("A2+1"))
        );
        drop(workbook);
        let mut archive = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
        let mut reference_xml = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut reference_xml)
            .unwrap();
        assert!(reference_xml.contains("<hyperlink"));
        let mut copied_xml = String::new();
        archive
            .by_name("xl/worksheets/sheet2.xml")
            .unwrap()
            .read_to_string(&mut copied_xml)
            .unwrap();
        assert!(copied_xml.contains("mergeCell ref=\"A1:B1\""));
        let _ = fs::remove_dir_all(root);
    }
}
