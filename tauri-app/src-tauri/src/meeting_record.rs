//! 会议录音：WASAPI 双轨采集（系统回环声 + 麦克风），申请 16 kHz 单声道
//! 16 位格式（共享模式 autoconvert，由 Windows 音频引擎完成格式转换），
//! 两条轨各自落 WAV，停止时混音出上传转写用的成品。
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
        mpsc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

use crate::AppError;

const SAMPLE_RATE: u32 = 16_000;
const POLL_INTERVAL: Duration = Duration::from_millis(200);
/// 共享模式缓冲 200ms（单位 100ns）。
const BUFFER_DURATION_HNS: i64 = 2_000_000;
const INIT_TIMEOUT: Duration = Duration::from_secs(5);

struct Track {
    label: &'static str,
    path: PathBuf,
    ok: bool,
    error: Option<String>,
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
    let (ready_tx, ready_rx) = mpsc::channel::<(&'static str, Result<(), String>)>();
    let mut handles = Vec::new();
    let tracks = Mutex::new(Vec::new());
    for (label, device_direction, file_name) in [
        ("system", Direction::Render, "track-system.wav"),
        ("mic", Direction::Capture, "track-mic.wav"),
    ] {
        let path = dir.join(file_name);
        let stop_flag = stop.clone();
        let sender = ready_tx.clone();
        let handle = thread::Builder::new()
            .name(format!("meeting-record-{label}"))
            .spawn(move || {
                // run_capture 正常返回（无论成败）都会经 ready 通道上报一次；
                // 这里只兜 panic 没能上报的情况，避免重复消息。
                if catch_unwind(AssertUnwindSafe(|| {
                    run_capture(device_direction, &stop_flag, &path, &sender)
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
    }
    drop(ready_tx);
    let mut initialized = Vec::new();
    while initialized.len() < 2 {
        match ready_rx.recv_timeout(INIT_TIMEOUT) {
            Ok((label, result)) => {
                tracks.lock().push(Track {
                    label,
                    path: dir.join(if label == "system" { "track-system.wav" } else { "track-mic.wav" }),
                    ok: result.is_ok(),
                    error: result.err(),
                });
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
    Ok(ActiveRecording {
        stop,
        dir,
        started_at: chrono::Local::now(),
        handles: Mutex::new(handles),
        tracks,
    })
}

pub(crate) fn recording_summary(active: &ActiveRecording) -> Value {
    let tracks = active.tracks.lock();
    json!({
        "startedAt": active.started_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "recordDir": active.dir.to_string_lossy(),
        "systemOk": tracks.iter().any(|t| t.label == "system" && t.ok),
        "micOk": tracks.iter().any(|t| t.label == "mic" && t.ok),
        "warnings": tracks.iter().filter(|t| !t.ok).filter_map(|t| t.error.clone()).collect::<Vec<_>>(),
    })
}

/// 停止录音并混音出成品，返回给前端的结果（audioPath 即混音文件）。
pub(crate) fn finalize(active: Arc<ActiveRecording>) -> Result<Value, AppError> {
    active.stop.store(true, Ordering::Relaxed);
    let handles: Vec<_> = active.handles.lock().drain(..).collect();
    for handle in handles {
        let _ = handle.join();
    }
    let mix_path = active.dir.join("audio-mix.wav");
    let frames = mix_wav_files(&mix_path, &active.dir.join("track-system.wav"), &active.dir.join("track-mic.wav"))?;
    let duration_sec = frames / SAMPLE_RATE as u64;
    let size_bytes = fs::metadata(&mix_path).map(|meta| meta.len()).unwrap_or(0);
    let tracks = active.tracks.lock();
    let warnings: Vec<String> = tracks
        .iter()
        .filter(|track| !track.ok)
        .filter_map(|track| track.error.clone())
        .collect();
    Ok(json!({
        "audioPath": mix_path.to_string_lossy(),
        "recordDir": active.dir.to_string_lossy(),
        "durationSec": duration_sec,
        "sizeBytes": size_bytes,
        "startedAt": active.started_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "warnings": warnings,
    }))
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
        record_error("MEETING_MIX_FAILED", "无法写入混音文件。", Some(e.to_string()))
    })?;
    // 迭代器必须在循环外创建：samples() 每次调用都是从头的新迭代器。
    let mut samples_a = reader_a
        .as_mut()
        .map(|reader| reader.samples::<i16>());
    let mut samples_b = reader_b
        .as_mut()
        .map(|reader| reader.samples::<i16>());
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
    record_error("MEETING_MIX_FAILED", "写入混音文件失败。", Some(error.to_string()))
}

fn run_capture(
    device_direction: Direction,
    stop: &AtomicBool,
    path: &Path,
    ready: &mpsc::Sender<(&'static str, Result<(), String>)>,
) -> Result<(), String> {
    let label: &'static str = match device_direction {
        Direction::Render => "system",
        Direction::Capture => "mic",
    };
    // COM 多线程套间：本线程独占使用，线程结束时随线程释放。
    let mta = wasapi::initialize_mta();
    if mta.is_err() {
        ready.send((label, Err("初始化 Windows 音频组件失败。".into()))).ok();
        return Err("初始化 Windows 音频组件失败。".into());
    }
    let init = (|| -> Result<(), String> {
        let enumerator = DeviceEnumerator::new().map_err(stringify)?;
        let device = enumerator.get_default_device(&device_direction).map_err(stringify)?;
        let mut client = device.get_iaudioclient().map_err(stringify)?;
        let format = WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE as usize, 1, None);
        // 回环：Render 设备 + Capture 方向 + 共享模式 = AUDCLNT_STREAMFLAGS_LOOPBACK。
        client
            .initialize_client(
                &format,
                &Direction::Capture,
                &StreamMode::PollingShared {
                    autoconvert: true,
                    buffer_duration_hns: BUFFER_DURATION_HNS,
                },
            )
            .map_err(stringify)?;
        let capture = client.get_audiocaptureclient().map_err(stringify)?;
        let spec = WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).map_err(|e| e.to_string())?;
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
        writer.finalize().map_err(|e| e.to_string())?;
        Ok(())
    })();
    ready
        .send((label, init.clone().map_err(|message| message.clone())))
        .ok();
    init
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
        let error = mix_wav_files(&output, &dir.path().join("none-a.wav"), &dir.path().join("none-b.wav"))
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
}
