//! 会议录音：双轨采集（会议系统声 + 麦克风），申请 16 kHz 单声道
//! 16 位格式（共享模式 autoconvert，由 Windows 音频引擎完成格式转换），
//! 两条轨各自落 WAV，停止时混音出上传转写用的成品。
//!
//! 设备选择的教训（真机 2026-09-28 复盘：系统声轨 14 秒后无数据、麦克风
//! 轨 2.6 小时近乎无声）：不能按「系统默认设备」录——Teams 常单独选用
//! 耳机播放/收音，默认扬声器没声音可录、默认麦克风离人很远。因此：
//! - 系统声轨优先按 Teams 活跃播放会话选实际设备，避免进程回环打开成功却无声；
//!   设备不可用才退回进程回环，最后使用默认通信／播放设备；
//! - 麦克风优先按 Teams 活跃采集会话选设备；无法确定时再用音量与默认通信设备。
//!
//! `profile.release` 是 `panic = "abort"`：采集线程里任何错误都必须走
//! `Result` 返回，不允许 panic 带崩整个应用。

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
use wasapi::{
    AudioClient, Device, DeviceEnumerator, Direction, Role, SampleType, StreamMode, WaveFormat,
};

use crate::AppError;

const SAMPLE_RATE: u32 = 16_000;
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// 共享模式缓冲 200ms（单位 100ns）。
const BUFFER_DURATION_HNS: i64 = 2_000_000;
const INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// 麦克风选设备的音量峰值采样：总时长与判定阈值。正常说话峰值在 0.05
/// 以上，无输入流的设备恒为 0；会刚开始的几秒总有人在说话。
const MIC_METER_TOTAL: Duration = Duration::from_millis(1500);
const MIC_METER_STEP: Duration = Duration::from_millis(30);
const MIC_ACTIVE_PEAK_MIN: f32 = 0.005;

/// 一路采集就绪后回报的来源说明（前端展示与诊断用）。
#[derive(Debug, Clone)]
struct CaptureMeta {
    source: String,
    /// 采集可用但有疑点（如退回了默认设备），开录即提示用户。
    caution: Option<String>,
}

impl CaptureMeta {
    fn new(source: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            caution: None,
        }
    }

    fn with_caution(mut self, caution: String) -> Self {
        self.caution = Some(caution);
        self
    }

    fn opt_caution(mut self, caution: Option<String>) -> Self {
        self.caution = caution;
        self
    }
}

struct Track {
    label: &'static str,
    path: PathBuf,
    ok: bool,
    error: Option<String>,
    /// 实际采用的采集来源（如「Teams 进程音频（PID 123）」「麦克风（xxx）」）。
    source: Option<String>,
    /// 采集可用但有疑点（如退回了默认设备），开录即提示用户。
    caution: Option<String>,
    /// 初始化成功后的中途失败（设备被拔、进程退出等）：线程仍持有 WAV，
    /// 只能先记下来，收尾时并进 warnings 告诉用户。
    late_error: Arc<Mutex<Option<String>>>,
}

/// 一次进行中的录音会话。
pub(crate) struct ActiveRecording {
    stop: Arc<AtomicBool>,
    dir: PathBuf,
    started_at: chrono::DateTime<chrono::Local>,
    handles: Mutex<Vec<thread::JoinHandle<()>>>,
    tracks: Mutex<Vec<Track>>,
}

fn record_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

/// 启动双轨录音。返回前会等两路设备初始化出结果，至少一路成功才算开录。
pub(crate) fn start(data_dir: &Path) -> Result<ActiveRecording, AppError> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dir = data_dir
        .join("meeting_records")
        .join(format!("record-{stamp}"));
    fs::create_dir_all(&dir).map_err(|e| {
        record_error(
            "MEETING_RECORD_DIR_FAILED",
            "无法创建会议录音目录。",
            Some(e.to_string()),
        )
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<(&'static str, Result<CaptureMeta, String>)>();
    let mut handles = Vec::new();
    let tracks = Mutex::new(Vec::new());
    for (label, device_direction, file_name) in [
        ("system", Direction::Render, "track-system.wav"),
        ("mic", Direction::Capture, "track-mic.wav"),
    ] {
        let path = dir.join(file_name);
        let track_path = path.clone();
        let stop_flag = stop.clone();
        let sender = ready_tx.clone();
        let late_error = Arc::new(Mutex::new(None));
        let late_error_slot = late_error.clone();
        let handle = thread::Builder::new()
            .name(format!("meeting-record-{label}"))
            .spawn(move || {
                // run_capture 正常返回（无论成败）都会经 ready 通道上报一次；
                // 这里只兜 panic 没能上报的情况，避免重复消息。
                if catch_unwind(AssertUnwindSafe(|| {
                    run_capture(
                        device_direction,
                        &stop_flag,
                        &path,
                        &sender,
                        &late_error_slot,
                    )
                }))
                .is_err()
                {
                    let _ = sender.send((label, Err("采集线程异常退出。".into())));
                }
            });
        match handle {
            Ok(handle) => handles.push(handle),
            Err(e) => {
                return Err(record_error(
                    "MEETING_RECORD_THREAD_FAILED",
                    "无法启动录音线程。",
                    Some(e.to_string()),
                ));
            }
        }
        tracks.lock().push(Track {
            label,
            path: track_path,
            ok: false,
            error: None,
            source: None,
            caution: None,
            late_error,
        });
    }
    drop(ready_tx);
    let mut initialized = Vec::new();
    while initialized.len() < 2 {
        match ready_rx.recv_timeout(INIT_TIMEOUT) {
            Ok((label, result)) => {
                let mut guard = tracks.lock();
                if let Some(track) = guard.iter_mut().find(|track| track.label == label) {
                    track.ok = result.is_ok();
                    match result {
                        Ok(meta) => {
                            track.source = Some(meta.source);
                            track.caution = meta.caution;
                        }
                        Err(message) => track.error = Some(message),
                    }
                }
                initialized.push(label);
            }
            Err(_) => break,
        }
    }
    if !tracks.lock().iter().any(|track| track.ok) {
        stop.store(true, Ordering::Relaxed);
        for handle in handles.drain(..) {
            let _ = handle.join();
        }
        let detail = tracks
            .lock()
            .iter()
            .filter_map(|track| track.error.clone())
            .collect::<Vec<_>>()
            .join("；");
        return Err(record_error(
            "MEETING_DEVICE_UNAVAILABLE",
            "无法打开系统声音或麦克风，请检查音频设备后重试。",
            Some(detail),
        ));
    }
    let active = ActiveRecording {
        stop,
        dir,
        started_at: chrono::Local::now(),
        handles: Mutex::new(handles),
        tracks,
    };
    // 来源与告警保存在录音旁，后续无需依赖当时是否看到了桌面通知。
    let _ = fs::write(
        active.dir.join("recording-start.json"),
        recording_summary(&active).to_string(),
    );
    Ok(active)
}

pub(crate) fn recording_summary(active: &ActiveRecording) -> Value {
    let tracks = active.tracks.lock();
    let source_of = |label: &str| {
        tracks
            .iter()
            .find(|t| t.label == label)
            .and_then(|t| t.source.clone())
    };
    json!({
        "startedAt": active.started_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "recordDir": active.dir.to_string_lossy(),
        "systemOk": tracks.iter().any(|t| t.label == "system" && t.ok),
        "micOk": tracks.iter().any(|t| t.label == "mic" && t.ok),
        "systemSource": source_of("system"),
        "micSource": source_of("mic"),
        "warnings": warnings_of(&tracks),
    })
}

/// 一路录音轨的疑点汇总：初始化告警 + 中途失败。
fn warnings_of(tracks: &[Track]) -> Vec<String> {
    let mut warnings: Vec<String> = tracks
        .iter()
        .filter(|track| !track.ok)
        .filter_map(|track| track.error.clone())
        .collect();
    for track in tracks {
        if let Some(caution) = &track.caution {
            warnings.push(caution.clone());
        }
        if let Some(late) = track.late_error.lock().clone() {
            warnings.push(format!(
                "{}轨中途停止采集：{}",
                if track.label == "system" {
                    "系统声"
                } else {
                    "麦克风"
                },
                late
            ));
        }
    }
    warnings
}

/// 停止录音并混音出成品，返回给前端的结果（audioPath 即混音文件）。
pub(crate) fn finalize(active: Arc<ActiveRecording>) -> Result<Value, AppError> {
    active.stop.store(true, Ordering::Relaxed);
    let handles: Vec<_> = active.handles.lock().drain(..).collect();
    for handle in handles {
        let _ = handle.join();
    }
    let mix_path = active.dir.join("audio-mix.wav");
    let frames = mix_wav_files(
        &mix_path,
        &active.dir.join("track-system.wav"),
        &active.dir.join("track-mic.wav"),
    )?;
    let duration_sec = frames / SAMPLE_RATE as u64;
    let size_bytes = fs::metadata(&mix_path).map(|meta| meta.len()).unwrap_or(0);
    let mut warnings = warnings_of(&active.tracks.lock());
    // 停录即体检：设备没选对（如 Teams 用耳机、系统默认是扬声器）时两轨
    // 都近乎静音，混音里自然没有语音。与其等转写服务报「没有识别到语音
    // 内容」再让用户猜，不如当场把疑点说出来。
    if frames == 0 {
        warnings.push("录音文件没有采集到音频数据，请检查 Teams 与工具箱的音频设备设置。".into());
    } else if let Some(hint) = silence_hint(&mix_path, duration_sec) {
        warnings.push(hint);
    }
    let summary = json!({
        "audioPath": mix_path.to_string_lossy(),
        "recordDir": active.dir.to_string_lossy(),
        "durationSec": duration_sec,
        "sizeBytes": size_bytes,
        "startedAt": active.started_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "warnings": warnings,
        "sources": recording_summary(&active),
        "audioStats": {
            "system": audio_stats(&active.dir.join("track-system.wav")),
            "mic": audio_stats(&active.dir.join("track-mic.wav")),
            "mix": audio_stats(&mix_path),
        },
    });
    let _ = fs::write(
        active.dir.join("recording-summary.json"),
        summary.to_string(),
    );
    Ok(summary)
}

/// 只分析可准确读取的 16 位 PCM WAV；不把音量阈值当作语音检测。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioStats {
    sample_count: u64,
    nonzero_sample_count: u64,
    peak: f64,
    rms: f64,
}

pub(crate) fn audio_stats(path: &Path) -> Option<AudioStats> {
    let mut reader = WavReader::open(path).ok()?;
    if reader.spec().sample_format != SampleFormat::Int || reader.spec().bits_per_sample != 16 {
        return None;
    }
    let mut stats = AudioStats {
        sample_count: 0,
        nonzero_sample_count: 0,
        peak: 0.0,
        rms: 0.0,
    };
    let mut sum_sq = 0.0;
    for sample in reader.samples::<i16>() {
        let sample = sample.ok()?;
        let normalized = f64::from(sample) / 32768.0;
        stats.sample_count += 1;
        stats.nonzero_sample_count += u64::from(sample != 0);
        stats.peak = stats.peak.max(normalized.abs());
        sum_sq += normalized * normalized;
    }
    if stats.sample_count > 0 {
        stats.rms = (sum_sq / stats.sample_count as f64).sqrt();
    }
    Some(stats)
}

/// 仅拦截可确认的空数据／全零样本，安静或低音量录音仍交给识别服务。
pub(crate) fn check_transcription_audio(path: &Path) -> Result<(), AppError> {
    if let Some(stats) = audio_stats(path) {
        if stats.nonzero_sample_count == 0 {
            return Err(record_error(
                "MEETING_AUDIO_SILENT",
                "录音未采集到声音，已停止上传转写。原录音已保留，请检查 Teams 的播放设备、麦克风及耳机静音开关后重新录制。",
                Some(format!(
                    "录音文件：{}；样本数：{}；非零样本数：0",
                    path.display(),
                    stats.sample_count
                )),
            ));
        }
    }
    Ok(())
}

/// 单秒窗口判「有声」的 RMS 阈值（-42dB ≈ 0.008）：正常说话每秒在
/// -35dB 上下，环境噪声通常低于 -55dB。
const LOUD_WINDOW_RMS: f64 = 0.008;
/// 有声时间占比低于此值（且录音超过 5 秒）判定为「疑似没录到人声」。
/// 正常会议绝大部分时间有人说话；真机案例里 86 秒录音只有约 9% 时间
/// 有声（还是挂断提示音），取 15% 既能抓住它又远离正常会议。
const SPEECH_FRACTION_MIN: f64 = 0.15;
const SILENCE_CHECK_MIN_SECONDS: u64 = 5;

/// 逐秒统计混音里的有声占比；疑似空录时返回给用户看的提示。
fn silence_hint(mix_path: &Path, duration_sec: u64) -> Option<String> {
    if duration_sec <= SILENCE_CHECK_MIN_SECONDS {
        return None;
    }
    let Ok(mut reader) = WavReader::open(mix_path) else {
        return None;
    };
    let rate = reader.spec().sample_rate.max(1) as u64;
    let mut loud_windows = 0u64;
    let mut windows = 0u64;
    let mut sum_sq = 0f64;
    let mut count = 0u64;
    let mut push_window = |sum_sq: &mut f64, count: &mut u64, windows: &mut u64, loud: &mut u64| {
        let rms = (*sum_sq / *count as f64).sqrt();
        *windows += 1;
        if rms > LOUD_WINDOW_RMS {
            *loud += 1;
        }
        *sum_sq = 0.0;
        *count = 0;
    };
    for sample in reader.samples::<i16>() {
        let Ok(value) = sample else { continue };
        let normalized = value as f32 / 32768.0;
        sum_sq += (normalized * normalized) as f64;
        count += 1;
        if count == rate {
            push_window(&mut sum_sq, &mut count, &mut windows, &mut loud_windows);
        }
    }
    if count > 0 {
        push_window(&mut sum_sq, &mut count, &mut windows, &mut loud_windows);
    }
    if windows == 0 {
        return None;
    }
    let fraction = loud_windows as f64 / windows as f64;
    (fraction < SPEECH_FRACTION_MIN).then(|| {
        format!(
            "录音里疑似没有录到人声（有声时间仅约 {:.0}%）。设备初始化成功不代表实际录到了声音；\
             请先回放原录音，核对 Teams 的播放设备、麦克风及耳机静音开关。\
             若回放有清晰讲话，可重新导入转写；若没有声音，需要调整设备后重新录制。",
            fraction * 100.0
        )
    })
}

/// 逐样本平均混音两路 16k 单声道 WAV；缺哪一路就用另一路原样。
/// 独立成纯函数便于单测（tempfile 造两份小 WAV）。
pub(crate) fn mix_wav_files(output: &Path, first: &Path, second: &Path) -> Result<u64, AppError> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let open = |path: &Path| WavReader::open(path).ok();
    let mut reader_a = open(first);
    let mut reader_b = open(second);
    if reader_a.is_none() && reader_b.is_none() {
        return Err(record_error(
            "MEETING_MIX_FAILED",
            "两路录音轨都不存在，无法生成混音文件。",
            None,
        ));
    }
    let mut writer = WavWriter::create(output, spec).map_err(|e| {
        record_error(
            "MEETING_MIX_FAILED",
            "无法写入混音文件。",
            Some(e.to_string()),
        )
    })?;
    // 迭代器必须在循环外创建：samples() 每次调用都是从头的新迭代器。
    let mut samples_a = reader_a.as_mut().map(|reader| reader.samples::<i16>());
    let mut samples_b = reader_b.as_mut().map(|reader| reader.samples::<i16>());
    let mut frames: u64 = 0;
    loop {
        let sample_a = samples_a
            .as_mut()
            .and_then(|samples| samples.next())
            .and_then(|sample| sample.ok());
        let sample_b = samples_b
            .as_mut()
            .and_then(|samples| samples.next())
            .and_then(|sample| sample.ok());
        let mixed = match (sample_a, sample_b) {
            (Some(a), Some(b)) => ((a as i32 + b as i32) / 2) as i16,
            // 剩单路时继续读完，保证时间轴完整；两路都尽则收工。
            (Some(rest), None) | (None, Some(rest)) => rest,
            (None, None) => break,
        };
        writer.write_sample(mixed).map_err(write_err)?;
        frames += 1;
    }
    writer.finalize().map_err(write_err)?;
    Ok(frames)
}

fn write_err(error: impl std::fmt::Display) -> AppError {
    record_error(
        "MEETING_MIX_FAILED",
        "写入混音文件失败。",
        Some(error.to_string()),
    )
}

/// 已完成初始化的采集会话：进入轮询循环前创建，就绪信号在此时发回启动方。
struct PreparedCapture {
    capture: wasapi::AudioCaptureClient,
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    client: wasapi::AudioClient,
}

fn target_spec() -> WavSpec {
    WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    }
}

fn target_format() -> WaveFormat {
    WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, 1, None)
}

/// 用给定的 AudioClient 建采集流（16k 单声道 + WAV 落盘）。
/// Render 设备 + Capture 方向 + 共享模式 = AUDCLNT_STREAMFLAGS_LOOPBACK；
/// 进程回环客户端同样按 Capture 方向初始化（激活时已绑定回环语义）。
fn open_stream(mut client: AudioClient, path: &Path) -> Result<PreparedCapture, String> {
    client
        .initialize_client(
            &target_format(),
            &Direction::Capture,
            &StreamMode::PollingShared {
                autoconvert: true,
                buffer_duration_hns: BUFFER_DURATION_HNS,
            },
        )
        .map_err(stringify)?;
    let capture = client.get_audiocaptureclient().map_err(stringify)?;
    // WASAPI 初始化后必须显式 Start 才有数据包流动，否则永远读到空。
    client.start_stream().map_err(stringify)?;
    let writer = WavWriter::create(path, target_spec()).map_err(|e| e.to_string())?;
    Ok(PreparedCapture {
        capture,
        writer,
        client,
    })
}

/// 最后兜底：优先默认通信播放设备，再用默认播放设备。
fn default_render_loopback(path: &Path) -> Result<(PreparedCapture, CaptureMeta), String> {
    let enumerator = DeviceEnumerator::new().map_err(stringify)?;
    let device = enumerator
        .get_default_device_for_role(&Direction::Render, &Role::Communications)
        .or_else(|_| enumerator.get_default_device(&Direction::Render))
        .map_err(stringify)?;
    let name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "默认播放设备".into());
    let client = device.get_iaudioclient().map_err(stringify)?;
    let prepared = open_stream(client, path)?;
    Ok((
        prepared,
        CaptureMeta::new(format!("默认通信／播放设备（{name}）回环")),
    ))
}

/// 进程回环无法证明目标树确实有播放流，只作为实际播放设备不可用时的兜底。
fn process_or_default_system(path: &Path) -> Result<(PreparedCapture, CaptureMeta), String> {
    if let Some(pid) = find_teams_main_pid() {
        let attempt = AudioClient::new_application_loopback_client(pid, true)
            .map_err(stringify)
            .and_then(|client| open_stream(client, path));
        return match attempt {
            Ok(prepared) => Ok((
                prepared,
                CaptureMeta::new(format!("Teams 进程声音（PID {pid}，含子进程）")),
            )),
            Err(error) => {
                let (prepared, meta) = default_render_loopback(path)?;
                Ok((
                    prepared,
                    meta.with_caution(format!(
                        "按 Teams 进程采集失败（{error}），已改用默认通信／播放设备。"
                    )),
                ))
            }
        };
    }
    let (prepared, meta) = default_render_loopback(path)?;
    Ok((
        prepared,
        meta.with_caution(
            "未找到运行中的 Teams，已按默认通信／播放设备录制；Teams 没在放声音时此轨会没有内容。"
                .into(),
        ),
    ))
}

fn prepare_system(path: &Path) -> Result<(PreparedCapture, CaptureMeta), String> {
    prefer_teams_render(
        || {
            let enumerator = DeviceEnumerator::new().map_err(stringify)?;
            let Some(device) = crate::meeting_audio::active_render_device(&enumerator) else {
                return Ok(None);
            };
            let name = device
                .get_friendlyname()
                .unwrap_or_else(|_| "Teams 播放设备".into());
            let prepared = open_stream(device.get_iaudioclient().map_err(stringify)?, path)?;
            Ok(Some((
                prepared,
                CaptureMeta::new(format!("Teams 正在使用的播放设备（{name}）回环")).with_caution(
                    "系统声按 Teams 播放设备采集，同一设备上其他应用的声音也会被录入。".into(),
                ),
            )))
        },
        || process_or_default_system(path),
    )
}

fn prefer_teams_render<T>(
    endpoint: impl FnOnce() -> Result<Option<(T, CaptureMeta)>, String>,
    fallback: impl FnOnce() -> Result<(T, CaptureMeta), String>,
) -> Result<(T, CaptureMeta), String> {
    match endpoint() {
        Ok(Some(prepared)) => Ok(prepared),
        result => {
            let (prepared, mut meta) = fallback()?;
            let reason = match result {
                Err(error) => format!("无法采集 Teams 实际播放设备（{error}）"),
                _ => "未找到 Teams 活跃播放会话".into(),
            };
            let caution = format!(
                "{reason}，已使用备用系统声来源；请先录制短片确认有声。{}",
                meta.caution.as_deref().unwrap_or("")
            );
            meta.caution = Some(caution);
            Ok((prepared, meta))
        }
    }
}

/// 麦克风轨：自动挑「正在收音」的设备（会议中 Teams 一直占用所选麦克风）。
fn prepare_mic(path: &Path) -> Result<(PreparedCapture, CaptureMeta), String> {
    let enumerator = DeviceEnumerator::new().map_err(stringify)?;
    // 音量为零不等于没使用：会议刚开场、Teams 静音时仍能从会话归属确定
    // 正确设备。先按设备 ID 选 Teams 实际占用的麦克风，再考虑音量兜底。
    let teams_device = crate::meeting_audio::active_capture_device(&enumerator);
    if let Some(device) = teams_device {
        let name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "Teams 麦克风".into());
        let prepared = open_stream(device.get_iaudioclient().map_err(stringify)?, path)?;
        return Ok((
            prepared,
            CaptureMeta::new(format!("Teams 正在使用的麦克风（{name}）")),
        ));
    }
    let default = enumerator
        .get_default_device_for_role(&Direction::Capture, &Role::Communications)
        .or_else(|_| enumerator.get_default_device(&Direction::Capture))
        .map_err(stringify)?;
    let default_name = default
        .get_friendlyname()
        .unwrap_or_else(|_| "默认麦克风".into());
    let picked = pick_active_capture_device(&enumerator, &default_name);
    let (device, name, caution) = match picked {
        Some(picked) => picked,
        None => {
            let caution = format!(
                "无法确认 Teams 正在使用的麦克风，且未检测到明显输入，已使用默认通信麦克风「{default_name}」。请确认与 Teams 的麦克风设置一致。"
            );
            (default, default_name, Some(caution))
        }
    };
    let client = device.get_iaudioclient().map_err(stringify)?;
    let prepared = open_stream(client, path)?;
    let meta = CaptureMeta::new(format!("麦克风（{name}）")).opt_caution(caution);
    Ok((prepared, meta))
}

/// 各麦克风的音量表同时采样一小段时间，找出「正在收音」的那个：
/// 无输入流的设备峰值恒为 0，会议刚开始总有人在说话。全都无声则返回
/// None，由调用方退回系统默认（与旧行为一致，不强猜）。
fn pick_active_capture_device(
    enumerator: &DeviceEnumerator,
    default_name: &str,
) -> Option<(Device, String, Option<String>)> {
    let collection = enumerator.get_device_collection(&Direction::Capture).ok()?;
    let count = collection.get_nbr_devices().ok()?;
    let mut candidates: Vec<(Device, String, wasapi::AudioMeterInformation, f32)> = Vec::new();
    for idx in 0..count {
        let Ok(device) = collection.get_device_at_index(idx) else {
            continue;
        };
        let Ok(name) = device.get_friendlyname() else {
            continue;
        };
        let Ok(meter) = device.get_audiometerinformation() else {
            continue;
        };
        candidates.push((device, name, meter, 0.0));
    }
    if candidates.is_empty() {
        return None;
    }
    let steps = (MIC_METER_TOTAL.as_millis() / MIC_METER_STEP.as_millis()).max(1);
    for _ in 0..steps {
        for (_, _, meter, peak) in candidates.iter_mut() {
            if let Ok(value) = meter.get_peak_value() {
                *peak = peak.max(value);
            }
        }
        thread::sleep(MIC_METER_STEP);
    }
    let mut best_idx: Option<usize> = None;
    for idx in 0..candidates.len() {
        let better = best_idx.is_none_or(|best| {
            candidates[idx]
                .3
                .partial_cmp(&candidates[best].3)
                .is_some_and(|order| order == std::cmp::Ordering::Greater)
        });
        if better {
            best_idx = Some(idx);
        }
    }
    let idx = best_idx?;
    if candidates[idx].3 < MIC_ACTIVE_PEAK_MIN {
        return None;
    }
    let (device, name, _, _) = candidates.swap_remove(idx);
    let caution = (name != default_name).then(|| {
        format!(
            "检测到麦克风「{name}」正在收音（系统默认是「{default_name}」），已自动改用它录制。"
        )
    });
    Some((device, name, caution))
}

/// 找 ms-teams.exe 主进程：新版 Teams 开多个同名进程，媒体渲染在子进程
/// 里，进程回环必须从主进程开始并带上整棵进程树才能全部录到。
fn find_teams_main_pid() -> Option<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    let mut procs: Vec<(u32, u32, String)> = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return None;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&ch| ch == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                procs.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    pick_teams_main(&procs)
}

/// 纯函数便于单测：进程表里挑 Teams 主进程——父进程不是 ms-teams.exe 的
/// 那个（多个则取最小 pid）；全是子进程的异常表里退回任取最小 pid。
fn pick_teams_main(procs: &[(u32, u32, String)]) -> Option<u32> {
    let is_teams = |name: &str| name.eq_ignore_ascii_case("ms-teams.exe");
    let team_pids: std::collections::HashSet<u32> = procs
        .iter()
        .filter(|(_, _, name)| is_teams(name))
        .map(|(pid, _, _)| *pid)
        .collect();
    procs
        .iter()
        .filter(|(_, ppid, name)| is_teams(name) && !team_pids.contains(ppid))
        .map(|(pid, _, _)| *pid)
        .min()
        .or_else(|| team_pids.into_iter().min())
}

fn capture_loop(
    capture: &wasapi::AudioCaptureClient,
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    stop: &AtomicBool,
) -> Result<(), String> {
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(frames)) => {
                    let mut buffer = vec![0u8; frames as usize * 2];
                    let (read, _info) = capture.read_from_device(&mut buffer).map_err(stringify)?;
                    for pair in buffer[..read as usize * 2].chunks_exact(2) {
                        let sample = i16::from_le_bytes([pair[0], pair[1]]);
                        writer.write_sample(sample).map_err(|e| e.to_string())?;
                    }
                }
                Err(error) => return Err(stringify(error)),
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

fn run_capture(
    device_direction: Direction,
    stop: &AtomicBool,
    path: &Path,
    ready: &mpsc::Sender<(&'static str, Result<CaptureMeta, String>)>,
    late_error: &Mutex<Option<String>>,
) -> Result<(), String> {
    let label: &'static str = match device_direction {
        Direction::Render => "system",
        Direction::Capture => "mic",
    };
    // COM 多线程套间：本线程独占使用，线程结束时随线程释放。
    if wasapi::initialize_mta().is_err() {
        let message = "初始化 Windows 音频组件失败。".to_string();
        ready.send((label, Err(message.clone()))).ok();
        return Err(message);
    }
    // 就绪信号必须在进入采集循环【之前】发回：麦克风选设备要采样 1.5 秒
    // 音量表，加上 WASAPI 初始化，整体给到 10 秒（与启动方等待一致）。
    let attempt = match device_direction {
        Direction::Render => prepare_system(path),
        Direction::Capture => prepare_mic(path),
    };
    let PreparedCapture {
        capture,
        mut writer,
        client,
    } = match attempt {
        Ok((prepared, meta)) => {
            ready.send((label, Ok(meta))).ok();
            prepared
        }
        Err(message) => {
            ready.send((label, Err(message.clone()))).ok();
            return Err(message);
        }
    };
    if let Err(message) = capture_loop(&capture, &mut writer, stop) {
        // 中途失败（设备被拔、Teams 退出等）：尽力封盘并把原因留给收尾时
        // 汇总成警告——WAV 头不写完文件就损坏，静默丢轨用户无从得知。
        *late_error.lock() = Some(message.clone());
        let _ = client.stop_stream();
        let _ = writer.finalize();
        return Err(message);
    }
    let _ = client.stop_stream();
    writer.finalize().map_err(|e| {
        *late_error.lock() = Some(e.to_string());
        e.to_string()
    })?;
    Ok(())
}

fn stringify(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn read_wav_samples(path: &Path) -> Vec<i16> {
        WavReader::open(path)
            .unwrap()
            .samples::<i16>()
            .map(|sample| sample.unwrap())
            .collect()
    }

    #[test]
    fn teams_render_endpoint_wins_over_successful_process_fallback() {
        let (value, meta) = prefer_teams_render(
            || Ok(Some(("headset", CaptureMeta::new("Teams 耳机")))),
            || panic!("已识别 Teams 实际播放设备，不应退回可能无声的进程来源"),
        )
        .unwrap();
        assert_eq!(value, "headset");
        assert_eq!(meta.source, "Teams 耳机");
    }

    #[test]
    fn unavailable_render_endpoint_keeps_fallback_and_explains_source() {
        for endpoint in [Ok(None), Err("设备已断开".to_string())] {
            let (value, meta) = prefer_teams_render(
                || endpoint,
                || {
                    Ok((
                        "process",
                        CaptureMeta::new("进程").with_caution("原有提醒".into()),
                    ))
                },
            )
            .unwrap();
            assert_eq!(value, "process");
            let caution = meta.caution.unwrap();
            assert!(caution.contains("备用系统声来源"));
            assert!(caution.contains("原有提醒"));
        }
        let error =
            prefer_teams_render::<()>(|| Ok(None), || Err("两种来源均不可用".into())).unwrap_err();
        assert_eq!(error, "两种来源均不可用");
    }

    #[test]
    fn pcm_stats_distinguish_silence_quiet_audio_and_full_negative_peak() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        write_test_wav(&path, &[0, 0]);
        let stats = audio_stats(&path).unwrap();
        assert_eq!(stats.sample_count, 2);
        assert_eq!(stats.nonzero_sample_count, 0);
        assert_eq!(stats.peak, 0.0);
        assert_eq!(stats.rms, 0.0);
        assert_eq!(
            check_transcription_audio(&path).unwrap_err().code,
            "MEETING_AUDIO_SILENT"
        );
        write_test_wav(&path, &[0, 1, -1, 0]);
        assert_eq!(audio_stats(&path).unwrap().nonzero_sample_count, 2);
        assert!(
            check_transcription_audio(&path).is_ok(),
            "低音量不等于无有效语音，不能拦截"
        );
        write_test_wav(&path, &[i16::MIN]);
        let stats = audio_stats(&path).unwrap();
        assert_eq!(stats.peak, 1.0);
        assert_eq!(stats.rms, 1.0);
        write_test_wav(&path, &[]);
        assert_eq!(
            check_transcription_audio(&path).unwrap_err().code,
            "MEETING_AUDIO_SILENT"
        );
        assert!(audio_stats(&dir.path().join("missing.wav")).is_none());
    }

    #[test]
    fn unsupported_audio_still_goes_to_existing_cloud_decoder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("import.mp3");
        fs::write(&path, b"ID3test").unwrap();
        assert!(check_transcription_audio(&path).is_ok());
        let path = dir.path().join("float.wav");
        let mut writer = WavWriter::create(
            &path,
            WavSpec {
                bits_per_sample: 32,
                sample_format: SampleFormat::Float,
                ..target_spec()
            },
        )
        .unwrap();
        writer.write_sample(0.0f32).unwrap();
        writer.finalize().unwrap();
        assert!(audio_stats(&path).is_none());
        assert!(check_transcription_audio(&path).is_ok());
    }

    #[test]
    fn finalized_silent_recording_keeps_per_track_stats_and_original_files() {
        let dir = tempfile::tempdir().unwrap();
        for track in ["track-system.wav", "track-mic.wav"] {
            write_test_wav(&dir.path().join(track), &[0; 160]);
        }
        let active = Arc::new(ActiveRecording {
            stop: Arc::new(AtomicBool::new(false)),
            dir: dir.path().to_path_buf(),
            started_at: chrono::Local::now(),
            handles: Mutex::new(vec![]),
            tracks: Mutex::new(vec![]),
        });
        let summary = finalize(active).unwrap();
        for track in ["system", "mic", "mix"] {
            assert_eq!(summary["audioStats"][track]["sampleCount"], 160);
            assert_eq!(summary["audioStats"][track]["nonzeroSampleCount"], 0);
        }
        assert!(dir.path().join("audio-mix.wav").is_file());
        let saved: Value =
            serde_json::from_slice(&fs::read(dir.path().join("recording-summary.json")).unwrap())
                .unwrap();
        assert_eq!(saved["audioStats"], summary["audioStats"]);
    }

    /// 空录体检：全程静音的「会议」必须被点名，且提示里要说清设备原因。
    #[test]
    fn silence_hint_flags_quiet_recording() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("quiet.wav");
        // 10 秒：9 秒近乎静音 + 1 秒提示音量级的尾巴。
        let mut samples = vec![30i16; SAMPLE_RATE as usize * 9];
        samples.extend(vec![8000i16; SAMPLE_RATE as usize]);
        write_test_wav(&path, &samples);
        let hint = silence_hint(&path, 10).expect("疑似空录应给出提示");
        assert!(hint.contains("疑似没有录到人声"));
        assert!(hint.contains("Teams"));
    }

    /// 正常会议（大部分时间有人说话）不应误报。
    #[test]
    fn silence_hint_passes_normal_speech() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("talk.wav");
        let loud = vec![6000i16; SAMPLE_RATE as usize * 8];
        let quiet = vec![40i16; SAMPLE_RATE as usize * 2];
        let mut samples = quiet.clone();
        samples.extend_from_slice(&loud);
        samples.extend_from_slice(&quiet);
        write_test_wav(&path, &samples);
        assert_eq!(silence_hint(&path, 12), None);
    }

    /// 太短的录音（调试性点击）不做判断。
    #[test]
    fn silence_hint_skips_short_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("short.wav");
        write_test_wav(&path, &vec![0i16; SAMPLE_RATE as usize * 3]);
        assert_eq!(silence_hint(&path, 3), None);
    }

    #[test]
    fn mix_averages_two_tracks() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.wav");
        let second = dir.path().join("b.wav");
        let output = dir.path().join("mix.wav");
        write_test_wav(&first, &[100, 200, 300]);
        write_test_wav(&second, &[200, 400, 600]);
        let frames = mix_wav_files(&output, &first, &second).unwrap();
        assert_eq!(frames, 3);
        assert_eq!(read_wav_samples(&output), vec![150, 300, 450]);
    }

    #[test]
    fn mix_pads_shorter_track() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.wav");
        let second = dir.path().join("b.wav");
        let output = dir.path().join("mix.wav");
        write_test_wav(&first, &[100, 200, 300, 400]);
        write_test_wav(&second, &[60]);
        let frames = mix_wav_files(&output, &first, &second).unwrap();
        assert_eq!(frames, 4);
        // 首帧两轨平均 (100+60)/2=80；短轨读尽后长轨原样补齐时间轴。
        assert_eq!(read_wav_samples(&output), vec![80, 200, 300, 400]);
    }

    #[test]
    fn mix_with_missing_track_copies_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("a.wav");
        let second = dir.path().join("b.wav");
        let output = dir.path().join("mix.wav");
        write_test_wav(&first, &[10, -20, 30]);
        let frames = mix_wav_files(&output, &first, &second).unwrap();
        assert_eq!(frames, 3);
        assert_eq!(read_wav_samples(&output), vec![10, -20, 30]);
    }

    #[test]
    fn mix_without_any_track_fails() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("mix.wav");
        let error = mix_wav_files(
            &output,
            &dir.path().join("none-a.wav"),
            &dir.path().join("none-b.wav"),
        )
        .unwrap_err();
        assert_eq!(error.code, "MEETING_MIX_FAILED");
    }

    #[test]
    fn silence_flag_bytes_are_zero_samples() {
        // 16 位单声道的"静音包"就是全 0 字节，i16 解读为 0，混音路径无需特判。
        let bytes = [0u8, 0];
        assert_eq!(i16::from_le_bytes(bytes), 0);
        let _ = std::io::sink().write_all(&bytes);
    }

    fn procs(list: &[(u32, u32, &str)]) -> Vec<(u32, u32, String)> {
        list.iter()
            .map(|(pid, ppid, name)| (*pid, *ppid, name.to_string()))
            .collect()
    }

    /// 真机 2026-10-09 快照：explorer 下挂一个 Teams 主进程，主进程下再挂
    /// 两个同名子进程——回环必须选主进程（父进程不是 ms-teams.exe 的那个）。
    #[test]
    fn teams_main_pid_prefers_process_tree_root() {
        let table = procs(&[
            (1000, 900, "explorer.exe"),
            (79600, 1000, "ms-teams.exe"),
            (83148, 79600, "ms-teams.exe"),
            (85276, 79600, "MS-Teams.exe"),
        ]);
        assert_eq!(pick_teams_main(&table), Some(79600));
    }

    /// 全是子进程（主进程已退出、父 pid 失效）时退回任取一个，不能 None：
    /// 子进程带 include_tree 依然能录到整棵树的播放。
    #[test]
    fn teams_main_pid_falls_back_to_any_teams_process() {
        let table = procs(&[
            (83148, 79600, "ms-teams.exe"),
            (85276, 83148, "ms-teams.exe"),
        ]);
        assert_eq!(pick_teams_main(&table), Some(83148));
    }

    #[test]
    fn teams_main_pid_none_without_teams() {
        let table = procs(&[(1000, 900, "explorer.exe"), (2000, 1000, "OUTLOOK.EXE")]);
        assert_eq!(pick_teams_main(&table), None);
    }

    /// 真实设备链路诊断（手动运行）：
    /// `cargo test --lib meeting_record -- --ignored --nocapture`
    #[test]
    #[ignore = "需要真实音频设备，仅手动诊断运行"]
    fn live_start_and_finalize() {
        let dir = tempfile::tempdir().unwrap();
        match start(dir.path()) {
            Ok(recording) => {
                let record_dir = recording.dir.clone();
                println!("启动成功: {}", recording_summary(&recording));
                std::thread::sleep(std::time::Duration::from_secs(3));
                let active = Arc::new(recording);
                match finalize(active) {
                    Ok(result) => println!("收尾成功: {result}"),
                    Err(error) => {
                        println!("收尾失败: code={} detail={:?}", error.code, error.detail)
                    }
                }
                if let Ok(entries) = fs::read_dir(&record_dir) {
                    for entry in entries.flatten() {
                        println!(
                            "文件: {} -> {} 字节",
                            entry.path().display(),
                            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
                        );
                    }
                }
            }
            Err(error) => {
                println!(
                    "启动失败: code={} user={} detail={:?}",
                    error.code, error.user_message, error.detail
                );
            }
        }
    }
}
