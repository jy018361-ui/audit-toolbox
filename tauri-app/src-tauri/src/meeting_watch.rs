//! Teams 会议状态检测：并发监听新版 Teams 客户端的全部 SlimCore 通话日志。
//!
//! 新版 Teams 在通话期间会开启“窗口内容保护”（共享屏幕软件因此录不到 Teams
//! 窗口），动作会落进 `%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\
//! LocalCache\Microsoft\MSTeams\Logs\MSTeamsNM_SlimCore_*.log`：
//! `SetWindowContentProtection success` = 通话开始，`UnregisterCall success`
//! = 通话结束。检测到状态翻转时向前端发 `meeting-event` 事件。
//!
//! 新版 Teams 会同时开多个 ms-teams.exe 进程，各自写一份 SlimCore 日志，
//! 通话标记只落在其中一份（真机 2026-10-09 复盘：同一分钟创建 .41/.42 两份，
//! .41 带完整通话标记，.42 全程只有一个遥测进程的错误行）。旧逻辑只盯
//! “最新修改”的一份日志，选到没标记的那份时整场会议都检测不到，两份日志
//! 交替被写时还会来回切换、把状态机反复翻转。因此这里对目录下所有
//! SlimCore 日志各自记读取偏移、增量喂进同一个状态机。

use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::Emitter;

use crate::AppError;

/// 检测轮询间隔：真机反馈「点结束会议时才弹询问窗」，短测试会里 3 秒轮询
/// 加上小窗创建就要 4-6 秒，弹出来会已挂断。降到 1 秒把端到端延迟压住，
/// 日志文件很小，这个频率的增量读没有负担。
const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// 首次扫描单份日志的读取上限：SlimCore 单文件通常在几百 KB 量级。
const INITIAL_SCAN_CAP: u64 = 32 * 1024 * 1024;
const MAX_READ_PER_POLL: u64 = 4 * 1024 * 1024;
/// 启动时只回放「最近仍在写入」的日志：正在进行的通话其日志必然刚写过，
/// 会照常回放；早已结束的历史通话（文件很久没动）直接跳到文件尾，
/// 避免启动瞬间回放出一场旧会、闪一下询问窗又关掉。
const REPLAY_WINDOW: Duration = Duration::from_secs(2 * 60 * 60);
const START_MARKER: &str = "WindowContentProtectionProvider: SetWindowContentProtection success";
const END_MARKER: &str = "WindowContentProtectionProvider: UnregisterCall success";

/// 音频会话是兜底信号：需连续占用麦克风 3 秒才询问；开始后双向音频都
/// 停止 10 秒才收尾，避免短暂静音或设备切换导致提前结束。提示音不触发。
#[derive(Default)]
struct AudioCallState {
    active: bool,
    pending_since: Option<Instant>,
}

impl AudioCallState {
    fn observe(&mut self, capture: bool, render: bool, now: Instant) -> Option<CallEvent> {
        let pending = if self.active {
            !capture && !render
        } else {
            capture
        };
        if !pending {
            self.pending_since = None;
            return None;
        }
        let since = self.pending_since.get_or_insert(now);
        let delay = Duration::from_secs(if self.active { 10 } else { 3 });
        if now.duration_since(*since) < delay {
            return None;
        }
        self.pending_since = None;
        self.active = !self.active;
        Some(if self.active {
            CallEvent::Started
        } else {
            CallEvent::Ended
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum CallState {
    #[default]
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

fn log_dir_under(local_app_data: &Path) -> PathBuf {
    local_app_data.join(r"Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\Logs")
}

/// 新版 Teams 日志目录是否存在（不存在只说明没装新版 Teams，不算错误）。
pub(crate) fn teams_log_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dir = log_dir_under(Path::new(&local));
    dir.is_dir().then_some(dir)
}

fn is_slimcore_log(name: &str) -> bool {
    name.starts_with("MSTeamsNM_SlimCore_") && name.ends_with(".log")
}

/// 单份日志的读取进度：已读偏移 + 末尾尚未换行的半行。
#[derive(Default)]
struct TailState {
    offset: u64,
    partial: String,
}

/// 一轮扫描的结果，交给 watch_loop 决定发不发事件。
#[derive(Debug, PartialEq, Eq)]
enum ScanOutcome {
    /// 首轮扫描：历史标记只推断现状、不回放成事件；`in_call` 为推断结果。
    FirstScan { in_call: bool },
    /// 后续增量：新出现的完整标记行翻转出的真实事件。
    Events(Vec<CallEvent>),
}

/// 目录下全部 SlimCore 日志的增量读取器。所有文件的行喂进同一台状态机：
/// 同一场通话的标记只会出现在其中一份日志里，选错主日志就会整场漏检。
#[derive(Default)]
struct TailSet {
    files: HashMap<PathBuf, TailState>,
    call_state: CallState,
    first_scan_done: bool,
}

impl TailSet {
    /// 各文件只提取完整标记行，整轮按时间合并后再推进状态机。
    fn drain_file(&mut self, path: &Path, meta_len: u64, cap: u64, markers: &mut Vec<String>) {
        let state = self.files.get_mut(path).expect("tail state exists");
        if meta_len < state.offset {
            // 文件被截断（日志清理后重建）：旧偏移作废，从零重读新内容，
            // 新写入的结束标记才不会被跳过。
            state.offset = 0;
            state.partial.clear();
        }
        if meta_len <= state.offset {
            return;
        }
        let mut bytes = Vec::new();
        let read = fs::File::open(path)
            .and_then(|mut handle| {
                handle.seek(SeekFrom::Start(state.offset))?;
                let mut limited = handle.take(cap);
                limited.read_to_end(&mut bytes)
            })
            .unwrap_or(0);
        if read == 0 {
            return;
        }
        state.offset += read as u64;
        state.partial.push_str(&String::from_utf8_lossy(&bytes));
        let mut lines: Vec<&str> = state.partial.split('\n').collect();
        let trailing = lines.pop();
        for line in lines {
            if line.contains(START_MARKER) || line.contains(END_MARKER) {
                markers.push(line.to_owned());
            }
        }
        match trailing {
            Some(tail) => state.partial = tail.to_string(),
            None => state.partial.clear(),
        }
    }

    fn scan(&mut self, dir: &Path) -> ScanOutcome {
        let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
        for entry in fs::read_dir(dir).ok().into_iter().flatten().flatten() {
            let name = entry.file_name();
            if !is_slimcore_log(&name.to_string_lossy()) {
                continue;
            }
            let (len, modified) = match entry.metadata() {
                Ok(meta) => (
                    meta.len(),
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                ),
                Err(_) => continue,
            };
            entries.push((entry.path(), len, modified));
        }
        // 已被清理的日志不再跟踪，防止偏移表无限增长。
        self.files
            .retain(|path, _| entries.iter().any(|(p, _, _)| p == path));
        if !self.first_scan_done {
            let fresh = SystemTime::now()
                .checked_sub(REPLAY_WINDOW)
                .unwrap_or(SystemTime::UNIX_EPOCH);
            for (path, len, modified) in &entries {
                let tail = TailState {
                    offset: if *modified >= fresh { 0 } else { *len },
                    partial: String::new(),
                };
                self.files.insert(path.clone(), tail);
            }
            let cap = INITIAL_SCAN_CAP;
            let mut markers = Vec::new();
            for (path, len, _) in &entries {
                self.drain_file(path, *len, cap, &mut markers);
            }
            self.apply_markers(markers);
            self.first_scan_done = true;
            return ScanOutcome::FirstScan {
                in_call: self.call_state == CallState::InCall,
            };
        }
        for (path, _, _) in &entries {
            self.files.entry(path.clone()).or_default();
        }
        let cap = MAX_READ_PER_POLL;
        let mut markers = Vec::new();
        for (path, len, _) in &entries {
            self.drain_file(path, *len, cap, &mut markers);
        }
        ScanOutcome::Events(self.apply_markers(markers))
    }

    fn apply_markers(&mut self, mut markers: Vec<String>) -> Vec<CallEvent> {
        // 文件遍历顺序与会议时间无关。两份日志各含不同会议时，必须先处理
        // 较早事件，否则已结束的旧会可能覆盖新会状态。
        markers.sort_by_cached_key(|line| {
            line.split_whitespace()
                .next()
                .and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok())
                .map(|stamp| stamp.timestamp_micros())
                .unwrap_or_default()
        });
        markers
            .iter()
            .filter_map(|line| advance(&mut self.call_state, line))
            .collect()
    }
}

/// 会议功能的运行时状态：检测开关、当前是否在会、录音会话由 `meeting_record` 侧管理。
pub(crate) struct MeetingState {
    pub watch_enabled: Arc<AtomicBool>,
    resident: Arc<AtomicBool>,
    in_call: Arc<AtomicBool>,
    log_found: Arc<AtomicBool>,
    audio_available: AtomicBool,
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
            audio_available: AtomicBool::new(false),
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

    pub(crate) fn start_watcher(self: &Arc<Self>, app: tauri::AppHandle) {
        let state = self.clone();
        let handle = thread::Builder::new()
            .name("meeting-watch".into())
            .spawn(move || {
                watch_loop(&app, &state);
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
            "audioDetectionAvailable": self.audio_available.load(Ordering::Relaxed),
            "recording": self.recording.lock().is_some(),
        })
    }

    pub(crate) fn begin_recording(&self, data_dir: &Path) -> Result<Value, AppError> {
        let mut guard = self.recording.lock();
        if guard.is_some() {
            return Err(record_error(
                "MEETING_RECORD_BUSY",
                "已有会议录音正在进行。",
                None,
            ));
        }
        let active = Arc::new(crate::meeting_record::start(data_dir)?);
        let summary = crate::meeting_record::recording_summary(&active);
        *guard = Some(active);
        Ok(summary)
    }

    pub(crate) fn finish_recording(&self) -> Result<Value, AppError> {
        let active = self.recording.lock().take().ok_or_else(|| {
            record_error("MEETING_RECORD_NONE", "当前没有进行中的会议录音。", None)
        })?;
        crate::meeting_record::finalize(active)
    }
}

fn record_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn watch_loop(app: &tauri::AppHandle, state: &Arc<MeetingState>) {
    let mut tails = TailSet::default();
    let mut audio_call = AudioCallState::default();
    let enumerator = wasapi::initialize_mta()
        .is_ok()
        .then(|| wasapi::DeviceEnumerator::new().ok())
        .flatten();
    loop {
        if state.watcher_stop.load(Ordering::Relaxed) {
            break;
        }
        if state.watch_enabled.load(Ordering::Relaxed) {
            poll_once(app, state, &mut tails);
            let audio = enumerator
                .as_ref()
                .and_then(|enumerator| crate::meeting_audio::snapshot(enumerator).ok());
            state
                .audio_available
                .store(audio.is_some(), Ordering::Relaxed);
            if let Some(audio) = audio {
                if let Some(event) = audio_call.observe(
                    !audio.capture_devices.is_empty(),
                    audio.rendering,
                    Instant::now(),
                ) {
                    let started = event == CallEvent::Started;
                    // 同一场会议两种信号只发一次事件。
                    if state.in_call.swap(started, Ordering::Relaxed) != started {
                        emit_event(
                            app,
                            if started {
                                "call_started"
                            } else {
                                "call_ended"
                            },
                        );
                        if !started {
                            tails.call_state = CallState::Idle;
                            auto_finalize_recording(app, state);
                        }
                    }
                }
            } else {
                // 枚举失败是未知状态，不能累计成十秒“音频已停止”。
                audio_call.pending_since = None;
            }
        } else {
            audio_call.pending_since = None;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// 通话结束时的统一收尾：无论录音从哪个入口开始（询问小窗、工具页手动），
/// 都在检测线程里停录混音，成品信息用 `recording_auto_finished` 事件交给
/// 前端去跑转写纪要任务。此前只有全局弹窗发起的录音会被前端代停，
/// 工具页手动开始的录音会议一结束就悬着，用户还得回去手点停止。
fn auto_finalize_recording(app: &tauri::AppHandle, state: &Arc<MeetingState>) {
    let active = state.recording.lock().take();
    let Some(active) = active else {
        return;
    };
    let at = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    match crate::meeting_record::finalize(active) {
        Ok(summary) => {
            let _ = app.emit(
                "meeting-event",
                json!({"type": "recording_auto_finished", "at": at, "summary": summary}),
            );
        }
        Err(error) => {
            let _ = app.emit(
                "meeting-event",
                json!({
                    "type": "recording_failed",
                    "at": at,
                    "message": error.user_message,
                    "detail": error.detail,
                }),
            );
        }
    }
}

fn poll_once(app: &tauri::AppHandle, state: &Arc<MeetingState>, tails: &mut TailSet) {
    let Some(dir) = teams_log_dir() else {
        state.log_found.store(false, Ordering::Relaxed);
        return;
    };
    state.log_found.store(
        fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| is_slimcore_log(&entry.file_name().to_string_lossy())),
        Ordering::Relaxed,
    );
    match tails.scan(&dir) {
        ScanOutcome::FirstScan { in_call } => {
            // 启动时正在开会：历史标记推断出「在会」，照常询问，不算回放。
            if in_call {
                if !state.in_call.swap(true, Ordering::Relaxed) {
                    emit_event(app, "call_started");
                }
            }
        }
        ScanOutcome::Events(events) => {
            for event in events {
                let started = event == CallEvent::Started;
                if state.in_call.swap(started, Ordering::Relaxed) == started {
                    continue;
                }
                emit_event(
                    app,
                    if started {
                        "call_started"
                    } else {
                        "call_ended"
                    },
                );
                if !started {
                    auto_finalize_recording(app, state);
                }
            }
        }
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
    fn audio_fallback_detects_silent_streams_and_waits_for_both_directions_to_stop() {
        let mut state = AudioCallState::default();
        let now = Instant::now();
        assert_eq!(state.observe(false, true, now), None); // Teams 提示音不能触发
        assert_eq!(state.observe(true, false, now), None);
        assert_eq!(
            state.observe(true, false, now + Duration::from_secs(3)),
            Some(CallEvent::Started)
        );
        // 麦克风静音后，播放流仍在，不能提前结束。
        assert_eq!(
            state.observe(false, true, now + Duration::from_secs(20)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(21)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(30)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(31)),
            Some(CallEvent::Ended)
        );
    }

    #[test]
    fn audio_fallback_resets_debounce_after_short_device_switch() {
        let mut state = AudioCallState {
            active: true,
            pending_since: None,
        };
        let now = Instant::now();
        assert_eq!(state.observe(false, false, now), None);
        assert_eq!(
            state.observe(true, false, now + Duration::from_secs(9)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(11)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(20)),
            None
        );
        assert_eq!(
            state.observe(false, false, now + Duration::from_secs(21)),
            Some(CallEvent::Ended)
        );
    }

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

    fn append(path: &Path, line: &str) {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{line}").unwrap();
    }

    /// 真机 2026-10-09 复盘场景：同一分钟两份 SlimCore 日志，通话标记只在
    /// 其中一份。首轮扫描必须合并两份推断出「在会」。
    #[test]
    fn first_scan_merges_concurrent_logs() {
        let dir = tempfile::tempdir().unwrap();
        append(
            &dir.path()
                .join("MSTeamsNM_SlimCore_2026-10-09_17-02-22.41.log"),
            &format!("{NOISE_LINE}\n{START_LINE}\n"),
        );
        append(
            &dir.path()
                .join("MSTeamsNM_SlimCore_2026-10-09_17-02-26.42.log"),
            &format!("{NOISE_LINE}\n"),
        );
        let mut tails = TailSet::default();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::FirstScan { in_call: true }
        );
    }

    #[test]
    fn log_markers_across_files_follow_timestamp_order() {
        let mut tails = TailSet::default();
        // 后一场会议开始于旧会结束之后，文件顺序相反也应保持在会。
        let later_start = START_LINE.replace("09:26:04", "10:26:04");
        assert_eq!(
            tails.apply_markers(vec![later_start, END_LINE.into(), START_LINE.into()]),
            vec![CallEvent::Started, CallEvent::Ended, CallEvent::Started]
        );
        assert_eq!(tails.call_state, CallState::InCall);
    }

    /// 状态机是全局一台：没标记那份日志再怎么写噪声，都不能翻转通话状态
    /// （旧逻辑盯单份日志，两份交替更新时会来回误报开始/结束）。
    #[test]
    fn noise_in_markerless_log_does_not_flip_state() {
        let dir = tempfile::tempdir().unwrap();
        let with_marker = dir.path().join("MSTeamsNM_SlimCore_a.41.log");
        let noise_only = dir.path().join("MSTeamsNM_SlimCore_b.42.log");
        append(&with_marker, &format!("{START_LINE}\n"));
        append(&noise_only, &format!("{NOISE_LINE}\n"));
        let mut tails = TailSet::default();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::FirstScan { in_call: true }
        );
        // 无标记日志持续追加内容：不得产生任何事件。
        append(&noise_only, &format!("{NOISE_LINE}\n{NOISE_LINE}\n"));
        assert_eq!(tails.scan(dir.path()), ScanOutcome::Events(vec![]));
        // 通话结束标记写在带标记那份：正常出结束事件。
        append(&with_marker, &format!("{END_LINE}\n"));
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::Events(vec![CallEvent::Ended])
        );
    }

    /// 启动时早已结束的通话（日志很久没写）不回放、不误报在会。
    #[test]
    fn first_scan_skips_stale_logs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("MSTeamsNM_SlimCore_old.39.log");
        append(&path, &format!("{START_LINE}\n{NOISE_LINE}\n"));
        let stale = SystemTime::now() - Duration::from_secs(3 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(stale))
            .unwrap();
        let mut tails = TailSet::default();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::FirstScan { in_call: false }
        );
    }

    /// 运行中新出现的日志（Teams 重启）从零读起，标记行照常出事件。
    #[test]
    fn new_log_mid_run_emits_events() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("MSTeamsNM_SlimCore_a.40.log");
        append(&old, &format!("{START_LINE}\n"));
        let mut tails = TailSet::default();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::FirstScan { in_call: true }
        );
        let fresh = dir.path().join("MSTeamsNM_SlimCore_b.41.log");
        append(&fresh, &format!("{END_LINE}\n"));
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::Events(vec![CallEvent::Ended])
        );
    }

    /// 日志被清理截断后重写：从零重读，新内容里的结束标记照常出事件。
    #[test]
    fn truncated_log_rereads_new_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("MSTeamsNM_SlimCore_a.40.log");
        append(&path, &format!("{START_LINE}\n{NOISE_LINE}\n"));
        let mut tails = TailSet::default();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::FirstScan { in_call: true }
        );
        fs::write(&path, format!("{END_LINE}\n")).unwrap();
        assert_eq!(
            tails.scan(dir.path()),
            ScanOutcome::Events(vec![CallEvent::Ended])
        );
    }

    #[test]
    fn log_dir_points_at_new_teams_package() {
        let dir = log_dir_under(Path::new(r"C:\Users\demo\AppData\Local"));
        assert!(
            dir.to_string_lossy()
                .contains(r"Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\Logs")
        );
    }
}
