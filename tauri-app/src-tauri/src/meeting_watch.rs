//! Teams 会议状态检测：监听新版 Teams 客户端的 SlimCore 通话日志。
//!
//! 新版 Teams 在通话期间会开启“窗口内容保护”（共享屏幕软件因此录不到 Teams
//! 窗口），动作会落进 `%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\
//! LocalCache\Microsoft\MSTeams\Logs\MSTeamsNM_SlimCore_*.log`：
//! `SetWindowContentProtection success` = 通话开始，`UnregisterCall success`
//! = 通话结束。检测到状态翻转时向前端发 `meeting-event` 事件。

use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::Emitter;

use crate::AppError;

const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// 首次扫描整份日志的上限：SlimCore 单文件通常在几百 KB 量级。
const INITIAL_SCAN_CAP: u64 = 32 * 1024 * 1024;
const MAX_READ_PER_POLL: u64 = 4 * 1024 * 1024;
const START_MARKER: &str = "WindowContentProtectionProvider: SetWindowContentProtection success";
const END_MARKER: &str = "WindowContentProtectionProvider: UnregisterCall success";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallState {
    Idle,
    InCall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallEvent {
    Started,
    Ended,
}

/// 单行日志推进通话状态机；只有翻转才产生事件（重复标记忽略）。
pub(crate) fn advance(state: &mut CallState, line: &str) -> Option<CallEvent> {
    if line.contains(START_MARKER) {
        if *state == CallState::Idle {
            *state = CallState::InCall;
            return Some(CallEvent::Started);
        }
    } else if line.contains(END_MARKER) {
        if *state == CallState::InCall {
            *state = CallState::Idle;
            return Some(CallEvent::Ended);
        }
    }
    None
}

/// 首次看到一份日志时从头推断当前状态（不回放历史事件）。
fn infer_initial_state(contents: &str) -> CallState {
    let mut state = CallState::Idle;
    for line in contents.lines() {
        advance(&mut state, line);
    }
    state
}

fn log_dir_under(local_app_data: &Path) -> PathBuf {
    local_app_data.join(
        r"Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\Logs",
    )
}

/// 新版 Teams 日志目录是否存在（不存在只说明没装新版 Teams，不算错误）。
pub(crate) fn teams_log_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dir = log_dir_under(Path::new(&local));
    dir.is_dir().then_some(dir)
}

fn newest_slimcore_log(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("MSTeamsNM_SlimCore_") && name.ends_with(".log")) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if best
            .as_ref()
            .is_none_or(|(time, _)| modified >= *time)
        {
            best = Some((modified, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

/// 会议功能的运行时状态：检测开关、当前是否在会、录音会话由 `meeting_record` 侧管理。
pub(crate) struct MeetingState {
    pub watch_enabled: Arc<AtomicBool>,
    resident: Arc<AtomicBool>,
    in_call: Arc<AtomicBool>,
    log_found: Arc<AtomicBool>,
    watcher_stop: Arc<AtomicBool>,
    watcher_join: Mutex<Option<thread::JoinHandle<()>>>,
    recording: Mutex<Option<Arc<crate::meeting_record::ActiveRecording>>>,
}

impl MeetingState {
    pub(crate) fn new(watch_enabled: bool, resident: bool) -> Self {
        Self {
            watch_enabled: Arc::new(AtomicBool::new(watch_enabled)),
            resident: Arc::new(AtomicBool::new(resident)),
            in_call: Arc::new(AtomicBool::new(false)),
            log_found: Arc::new(AtomicBool::new(false)),
            watcher_stop: Arc::new(AtomicBool::new(false)),
            watcher_join: Mutex::new(None),
            recording: Mutex::new(None),
        }
    }

    /// 后台常驻：开启后关窗只是隐藏到托盘，检测与录音继续。
    pub(crate) fn set_resident(&self, enabled: bool) {
        self.resident.store(enabled, Ordering::Relaxed);
    }

    pub(crate) fn resident_enabled(&self) -> bool {
        self.resident.load(Ordering::Relaxed)
    }

    pub(crate) fn set_watch_enabled(&self, enabled: bool) {
        self.watch_enabled.store(enabled, Ordering::Relaxed);
    }

    pub(crate) fn start_watcher(&self, app: tauri::AppHandle) {
        let enabled = self.watch_enabled.clone();
        let stop = self.watcher_stop.clone();
        let in_call = self.in_call.clone();
        let log_found = self.log_found.clone();
        let handle = thread::Builder::new()
            .name("meeting-watch".into())
            .spawn(move || {
                watch_loop(&app, &enabled, &stop, &in_call, &log_found);
            });
        if let Ok(handle) = handle {
            *self.watcher_join.lock() = Some(handle);
        }
    }

    /// 应用退出时收尾：停检测线程；若还在录音，尽力封盘（WAV 头不写完文件会损坏）。
    pub(crate) fn shutdown(&self) {
        self.watcher_stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.watcher_join.lock().take() {
            let _ = handle.join();
        }
        let active = self.recording.lock().take();
        if let Some(active) = active {
            let _ = crate::meeting_record::finalize(active);
        }
    }

    pub(crate) fn status(&self) -> Value {
        json!({
            "watchEnabled": self.watch_enabled.load(Ordering::Relaxed),
            "resident": self.resident.load(Ordering::Relaxed),
            "inCall": self.in_call.load(Ordering::Relaxed),
            "logFound": self.log_found.load(Ordering::Relaxed),
            "recording": self.recording.lock().is_some(),
        })
    }

    pub(crate) fn begin_recording(
        &self,
        data_dir: &Path,
    ) -> Result<Value, AppError> {
        let mut guard = self.recording.lock();
        if guard.is_some() {
            return Err(record_error("MEETING_RECORD_BUSY", "已有会议录音正在进行。", None));
        }
        let active = Arc::new(crate::meeting_record::start(data_dir)?);
        let summary = crate::meeting_record::recording_summary(&active);
        *guard = Some(active);
        Ok(summary)
    }

    pub(crate) fn finish_recording(&self) -> Result<Value, AppError> {
        let active = self
            .recording
            .lock()
            .take()
            .ok_or_else(|| record_error("MEETING_RECORD_NONE", "当前没有进行中的会议录音。", None))?;
        crate::meeting_record::finalize(active)
    }
}

fn record_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn watch_loop(
    app: &tauri::AppHandle,
    enabled: &AtomicBool,
    stop: &AtomicBool,
    in_call: &AtomicBool,
    log_found: &AtomicBool,
) {
    let mut state = CallState::Idle;
    // (当前文件, 已读偏移)。Teams 重启或日志滚动会换文件，此时整份新文件
    // 重新推断状态——文件很小，代价可忽略。
    let mut current: Option<(PathBuf, u64)> = None;
    let mut partial = String::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if enabled.load(Ordering::Relaxed) {
            poll_once(app, &mut state, &mut current, &mut partial, in_call, log_found);
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn poll_once(
    app: &tauri::AppHandle,
    state: &mut CallState,
    current: &mut Option<(PathBuf, u64)>,
    partial: &mut String,
    in_call: &AtomicBool,
    log_found: &AtomicBool,
) {
    let Some(dir) = teams_log_dir() else {
        log_found.store(false, Ordering::Relaxed);
        return;
    };
    log_found.store(true, Ordering::Relaxed);
    let Some(file) = newest_slimcore_log(&dir) else {
        return;
    };
    let rolled = current.as_ref().is_none_or(|(path, _)| *path != file);
    let mut offset = if rolled { 0 } else { current.as_ref().map(|(_, off)| *off).unwrap_or(0) };
    let length = fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
    if length < offset {
        // 文件被截断（日志清理），从头再来。
        partial.clear();
        offset = 0;
    }
    let cap = if rolled { INITIAL_SCAN_CAP } else { MAX_READ_PER_POLL };
    if length <= offset && !rolled {
        if let Some(entry) = current.as_mut() {
            entry.1 = offset;
        }
        return;
    }
    let mut bytes = Vec::new();
    let read = fs::File::open(&file)
        .and_then(|mut handle| {
            handle.seek(SeekFrom::Start(offset))?;
            let mut limited = handle.take(cap);
            limited.read_to_end(&mut bytes)
        })
        .unwrap_or(0);
    let consumed = offset + read as u64;
    *current = Some((file, consumed));
    partial.push_str(&String::from_utf8_lossy(&bytes));
    let scanned_all = consumed >= length;
    let mut lines: Vec<&str> = partial.split('\n').collect();
    let trailing = if scanned_all || bytes.last() == Some(&b'\n') {
        lines.pop().filter(|tail| !tail.is_empty())
    } else {
        // 末尾是半行，留在 partial 下一轮再判。
        lines.pop()
    };
    if rolled {
        // 首见/滚动：整份内容只用来推断现状，正在会中才提示一次。
        *state = infer_initial_state(partial);
        if *state == CallState::InCall && !in_call.swap(true, Ordering::Relaxed) {
            emit_event(app, "call_started");
        } else {
            in_call.store(*state == CallState::InCall, Ordering::Relaxed);
        }
    } else {
        for line in lines {
            if let Some(event) = advance(state, line) {
                let started = event == CallEvent::Started;
                in_call.store(started, Ordering::Relaxed);
                emit_event(app, if started { "call_started" } else { "call_ended" });
            }
        }
    }
    match trailing {
        Some(tail) => *partial = tail.to_string(),
        None => partial.clear(),
    }
}

fn emit_event(app: &tauri::AppHandle, kind: &str) {
    let at = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let _ = app.emit("meeting-event", json!({"type": kind, "at": at}));
}

#[cfg(test)]
mod tests {
    use super::*;

    const START_LINE: &str = "2026-09-04T09:26:04.171217+08:00 0x0001e1cc <INFO> SlimCoreModule::WindowContentProtectionProvider: SetWindowContentProtection success result";
    const END_LINE: &str = "2026-09-04T09:45:17.546156+08:00 0x0001e1cc <INFO> SlimCoreModule::WindowContentProtectionProvider: UnregisterCall success result";
    const NOISE_LINE: &str = "2026-09-04T09:26:04.170217+08:00 0x0001e1cc <INFO> SlimCoreModule::HostServiceFactory: GetService host_services::IWindowContentProtectionProvider_1";
    const PRE_START_LINE: &str = "2026-09-04T09:26:04.170217+08:00 0x0001e1cc <INFO> SlimCoreModule::WindowContentProtectionProvider: SetWindowContentProtection 103";

    #[test]
    fn start_marker_flips_idle_to_in_call_once() {
        let mut state = CallState::Idle;
        assert_eq!(advance(&mut state, NOISE_LINE), None);
        assert_eq!(advance(&mut state, PRE_START_LINE), None);
        assert_eq!(advance(&mut state, START_LINE), Some(CallEvent::Started));
        assert_eq!(state, CallState::InCall);
        // 重复的开始标记不重复触发。
        assert_eq!(advance(&mut state, START_LINE), None);
    }

    #[test]
    fn end_marker_flips_in_call_to_idle() {
        let mut state = CallState::InCall;
        assert_eq!(advance(&mut state, END_LINE), Some(CallEvent::Ended));
        assert_eq!(state, CallState::Idle);
        assert_eq!(advance(&mut state, END_LINE), None);
    }

    #[test]
    fn end_marker_while_idle_is_ignored() {
        let mut state = CallState::Idle;
        assert_eq!(advance(&mut state, END_LINE), None);
    }

    #[test]
    fn infer_state_detects_ongoing_meeting() {
        assert_eq!(infer_initial_state(&format!("{NOISE_LINE}\n{START_LINE}\n")), CallState::InCall);
        assert_eq!(
            infer_initial_state(&format!("{START_LINE}\n{NOISE_LINE}\n{END_LINE}\n")),
            CallState::Idle
        );
        assert_eq!(infer_initial_state(NOISE_LINE), CallState::Idle);
    }

    #[test]
    fn log_dir_points_at_new_teams_package() {
        let dir = log_dir_under(Path::new(r"C:\Users\demo\AppData\Local"));
        assert!(dir
            .to_string_lossy()
            .contains(r"Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\Logs"));
    }
}
