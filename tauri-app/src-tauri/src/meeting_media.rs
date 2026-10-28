//! Windows 原生媒体解码：只取音轨，不启动外部程序、不上传视频画面。
//! https://learn.microsoft.com/windows/win32/medfound/tutorial--decoding-audio

use crate::{AppError, bailian_asr::Progress};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use windows::{
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
    },
    core::{HSTRING, PCWSTR},
};

pub(super) struct PreparedAudio {
    path: PathBuf,
    temporary_dir: Option<PathBuf>,
}

impl PreparedAudio {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PreparedAudio {
    fn drop(&mut self) {
        if let Some(directory) = &self.temporary_dir {
            // 只删除本任务明确创建的单个文件与空目录，不递归操作。
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_dir(directory);
        }
    }
}

fn cancelled(cancel: &Arc<AtomicBool>) -> Result<(), AppError> {
    if cancel.load(Ordering::Relaxed) {
        Err(AppError::new("JOB_CANCELLED", "任务已取消。", true, None))
    } else {
        Ok(())
    }
}

fn media_error(stage: &str, error: windows::core::Error) -> AppError {
    let no_audio = error.code() == MF_E_INVALIDSTREAMNUMBER;
    AppError::new(
        if no_audio {
            "MEETING_MEDIA_NO_AUDIO"
        } else {
            "MEETING_MEDIA_DECODE_FAILED"
        },
        if no_audio {
            "此文件没有可读取的音轨，请选择带声音的视频或音频。"
        } else {
            "无法读取此音视频的声音。文件可能已损坏、受保护，或当前 Windows 缺少对应解码器；请另存为 MP4（AAC 音轨）或 WAV 后重试。"
        },
        true,
        Some(format!("{stage}：0x{:08X}", error.code().0 as u32)),
    )
}

fn io_error(error: impl std::fmt::Display) -> AppError {
    AppError::new(
        "MEETING_MEDIA_WRITE_FAILED",
        "音轨暂存失败，请检查临时目录权限和磁盘空间。",
        true,
        Some(error.to_string()),
    )
}

struct MediaRuntime {
    uninitialize_com: bool,
}
impl MediaRuntime {
    fn start() -> Result<Self, AppError> {
        unsafe {
            let result = CoInitializeEx(None, COINIT_MULTITHREADED);
            // 已在另一 apartment 初始化的调用线程仍可使用同步 Source Reader。
            let uninitialize_com = if result.is_ok() {
                true
            } else if result == windows::Win32::Foundation::RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(media_error(
                    "初始化本地媒体组件",
                    windows::core::Error::from_hresult(result),
                ));
            };
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                if uninitialize_com {
                    CoUninitialize();
                }
                return Err(media_error("启动本地媒体组件", error));
            }
            Ok(Self { uninitialize_com })
        }
    }
}
impl Drop for MediaRuntime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            if self.uninitialize_com {
                CoUninitialize();
            }
        }
    }
}

pub(super) fn prepare_audio(
    path: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
) -> Result<PreparedAudio, AppError> {
    prepare_audio_in(
        path,
        progress,
        cancel,
        &std::env::temp_dir()
            .join("AuditToolbox")
            .join("meeting-media"),
    )
}

fn prepare_audio_in(
    path: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
    temporary_root: &Path,
) -> Result<PreparedAudio, AppError> {
    cancelled(cancel)?;
    // 应用录音和已兼容的 PCM 文件保留逐样本原貌，无额外有损编码。
    if let Ok(reader) = hound::WavReader::open(path) {
        let spec = reader.spec();
        if spec.sample_format == hound::SampleFormat::Int && spec.bits_per_sample == 16 {
            cancelled(cancel)?;
            return Ok(PreparedAudio {
                path: path.into(),
                temporary_dir: None,
            });
        }
    }
    progress("running", 0, 5, "正在本地读取音轨，视频画面不会上传…");
    let directory = temporary_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).map_err(io_error)?;
    let prepared = PreparedAudio {
        path: directory.join("audio.wav"),
        temporary_dir: Some(directory),
    };
    decode_audio(path, &prepared.path, progress, cancel)?;
    cancelled(cancel)?;
    Ok(prepared)
}

fn pcm_spec(format: &IMFMediaType) -> Result<hound::WavSpec, AppError> {
    unsafe {
        let rate = format
            .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
            .map_err(|error| media_error("读取采样率", error))?;
        let channels = format
            .GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)
            .map_err(|error| media_error("读取声道", error))?;
        let bits = format
            .GetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE)
            .map_err(|error| media_error("读取位数", error))?;
        // 验证原始 u32，再缩窄，防止格式变更通知里的异常值被截断。
        if bits != 16 || channels == 0 || channels > u16::MAX as u32 || rate == 0 {
            return Err(AppError::new(
                "MEETING_MEDIA_FORMAT",
                "当前音轨无法转换为可转写的 16 位 PCM 音频。",
                true,
                None,
            ));
        }
        Ok(hound::WavSpec {
            channels: channels as u16,
            sample_rate: rate,
            bits_per_sample: bits as u16,
            sample_format: hound::SampleFormat::Int,
        })
    }
}

fn decode_audio(
    source: &Path,
    destination: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    let _runtime = MediaRuntime::start()?;
    // Source Reader 的 URL 入口误读 canonical 的 \\?\ 前缀；UTF-8 百分号编码的
    // 中文文件 URL 也会误解。先以原生路径打开只读字节流，保留长路径、中文、#/%。
    // 这里只打开 canonical 文件，不把用户输入解释为服务地址。
    let canonical = fs::canonicalize(source).map_err(io_error)?;
    let source = HSTRING::from(canonical.as_os_str());
    unsafe {
        let stream = MFCreateFile(
            MF_ACCESSMODE_READ,
            MF_OPENMODE_FAIL_IF_NOT_EXIST,
            MF_FILEFLAGS_NONE,
            PCWSTR(source.as_ptr()),
        )
        .map_err(|error| media_error("打开音视频文件", error))?;
        let reader = MFCreateSourceReaderFromByteStream(&stream, None)
            .map_err(|error| media_error("打开音视频", error))?;
        let audio = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(|error| media_error("选择音轨", error))?;
        let requested = MFCreateMediaType().map_err(|error| media_error("创建音频格式", error))?;
        requested
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .map_err(|error| media_error("设置音频格式", error))?;
        requested
            .SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)
            .map_err(|error| media_error("设置音频格式", error))?;
        requested
            .SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
            .map_err(|error| media_error("设置采样位数", error))?;
        reader
            .SetCurrentMediaType(audio, None, &requested)
            .map_err(|error| media_error("解码音轨", error))?;
        reader
            .SetStreamSelection(audio, true)
            .map_err(|error| media_error("启用音轨", error))?;
        let format = reader
            .GetCurrentMediaType(audio)
            .map_err(|error| media_error("读取音轨格式", error))?;
        let mut spec = pcm_spec(&format)?;
        let mut writer = hound::WavWriter::create(destination, spec).map_err(io_error)?;
        let mut written = 0u64;
        let mut next_progress = 0u64;
        loop {
            cancelled(cancel)?;
            let mut flags = 0u32;
            let mut sample = None;
            reader
                .ReadSample(audio, 0, None, Some(&mut flags), None, Some(&mut sample))
                .map_err(|error| media_error("读取音轨数据", error))?;
            if flags & MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
                return Err(AppError::new(
                    "MEETING_MEDIA_DECODE_FAILED",
                    "本地音轨解码中断，请检查文件是否完整或受保护。",
                    true,
                    None,
                ));
            }
            if flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
                // AAC 通常在首个样本才公布完整格式；同样格式的通知也并非中途变化。
                let actual = reader
                    .GetCurrentMediaType(audio)
                    .map_err(|error| media_error("读取解码格式", error))?;
                let new_spec = pcm_spec(&actual)?;
                if new_spec != spec {
                    if written > 0 {
                        return Err(AppError::new(
                            "MEETING_MEDIA_FORMAT_CHANGED",
                            "音轨中途改变格式，暂不支持直接转写；请先另存为 WAV。",
                            true,
                            None,
                        ));
                    }
                    writer.finalize().map_err(io_error)?;
                    writer = hound::WavWriter::create(destination, new_spec).map_err(io_error)?;
                    spec = new_spec;
                }
            }
            if let Some(sample) = sample {
                let buffer = sample
                    .ConvertToContiguousBuffer()
                    .map_err(|error| media_error("读取音轨缓冲", error))?;
                let mut pointer = std::ptr::null_mut();
                let mut length = 0u32;
                buffer
                    .Lock(&mut pointer, None, Some(&mut length))
                    .map_err(|error| media_error("读取音轨缓冲", error))?;
                let result = (|| {
                    if length as usize % (spec.channels as usize * 2) != 0
                        || (pointer.is_null() && length > 0)
                    {
                        return Err(AppError::new(
                            "MEETING_MEDIA_FORMAT",
                            "音轨数据不完整，请先另存为 WAV 后重试。",
                            true,
                            None,
                        ));
                    }
                    if written + length as u64 > u32::MAX as u64 - 1024 {
                        return Err(AppError::new(
                            "MEETING_MEDIA_TOO_LARGE",
                            "解码后的音轨超过 WAV 容量限制，请拆分会议文件后重试。",
                            true,
                            None,
                        ));
                    }
                    if length > 0 {
                        let bytes = std::slice::from_raw_parts(pointer, length as usize);
                        for bytes in bytes.chunks_exact(2) {
                            writer
                                .write_sample(i16::from_le_bytes([bytes[0], bytes[1]]))
                                .map_err(io_error)?;
                        }
                    }
                    written += length as u64;
                    Ok(())
                })();
                // Unlock runs even when writing or validation fails.
                let unlocked = buffer
                    .Unlock()
                    .map_err(|error| media_error("释放音轨缓冲", error));
                result?;
                unlocked?;
                if written > next_progress {
                    let bytes_per_second = spec.sample_rate as u64 * spec.channels as u64 * 2;
                    progress(
                        "running",
                        0,
                        5,
                        &format!(
                            "正在本地读取音轨（已处理 {:.1} 秒）…",
                            written as f64 / bytes_per_second as f64
                        ),
                    );
                    next_progress = written.saturating_add(bytes_per_second);
                }
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        cancelled(cancel)?;
        writer.finalize().map_err(io_error)?;
        if written == 0 {
            return Err(AppError::new(
                "MEETING_MEDIA_NO_AUDIO",
                "此文件没有可读取的声音数据，请选择带声音的视频或音频。",
                true,
                None,
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(_: &str, _: usize, _: usize, _: &str) {}
    fn cancel_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn native_decoding_reads_video_audio_tracks_and_cleans_up() {
        let fixtures: &[(&str, &[u8])] = &[
            (
                "中文 录像#100%.mp4",
                include_bytes!("../../tests/fixtures/meeting-media/tone.mp4"),
            ),
            (
                "中文录像.wmv",
                include_bytes!("../../tests/fixtures/meeting-media/tone.wmv"),
            ),
            (
                "中文录像.avi",
                include_bytes!("../../tests/fixtures/meeting-media/tone.avi"),
            ),
            (
                "中文录像.mov",
                include_bytes!("../../tests/fixtures/meeting-media/tone.mov"),
            ),
            (
                "中文录音.mp3",
                include_bytes!("../../tests/fixtures/meeting-media/tone.mp3"),
            ),
            (
                "中文录音.m4a",
                include_bytes!("../../tests/fixtures/meeting-media/tone.m4a"),
            ),
            (
                "中文录音.aac",
                include_bytes!("../../tests/fixtures/meeting-media/tone.aac"),
            ),
        ];
        for (name, bytes) in fixtures {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join(name);
            fs::write(&source, bytes).unwrap();
            let original = fs::read(&source).unwrap();
            let prepared = prepare_audio(&source, &progress, &cancel_flag())
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let output = prepared.path().to_path_buf();
            assert_ne!(output, source);
            let mut reader = hound::WavReader::open(&output).unwrap();
            assert_eq!(reader.spec().bits_per_sample, 16);
            assert_eq!(reader.spec().sample_format, hound::SampleFormat::Int);
            assert!(reader.duration() as f64 / reader.spec().sample_rate as f64 >= 0.4);
            assert!(
                reader
                    .samples::<i16>()
                    .any(|sample| sample.unwrap().abs() > 100)
            );
            drop(reader);
            drop(prepared);
            assert!(!output.exists(), "临时音轨必须清理");
            assert!(!output.parent().unwrap().exists(), "本任务临时目录必须清理");
            assert_eq!(fs::read(&source).unwrap(), original);
        }
    }

    #[test]
    #[ignore = "仅在已安装 WebM 和 FLAC 媒体解码器的 Windows 上运行"]
    fn optional_windows_codecs_decode_audio_tracks() {
        for (name, bytes) in [
            (
                "tone.webm",
                include_bytes!("../../tests/fixtures/meeting-media/tone.webm").as_slice(),
            ),
            (
                "tone.flac",
                include_bytes!("../../tests/fixtures/meeting-media/tone.flac").as_slice(),
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join(name);
            fs::write(&source, bytes).unwrap();
            let prepared = prepare_audio(&source, &progress, &cancel_flag())
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            assert!(hound::WavReader::open(prepared.path()).unwrap().duration() > 0);
        }
    }

    #[test]
    fn pcm_recording_keeps_original_samples_and_path() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("recording.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&source, spec).unwrap();
        for sample in [1i16, -1, 100, -100] {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        let original = fs::read(&source).unwrap();
        let prepared = prepare_audio(&source, &progress, &cancel_flag()).unwrap();
        assert_eq!(prepared.path(), source);
        drop(prepared);
        assert_eq!(fs::read(&source).unwrap(), original);
    }

    #[test]
    fn video_without_audio_and_invalid_media_fail_locally() {
        for (name, bytes) in [
            (
                "silent-video.mp4",
                include_bytes!("../../tests/fixtures/meeting-media/no-audio.mp4").as_slice(),
            ),
            ("corrupt.wmv", b"not a media file".as_slice()),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join(name);
            let temporary_root = directory.path().join("decoded");
            fs::create_dir(&temporary_root).unwrap();
            fs::write(&source, bytes).unwrap();
            let error = prepare_audio_in(&source, &progress, &cancel_flag(), &temporary_root)
                .err()
                .unwrap();
            if name == "silent-video.mp4" {
                assert_eq!(error.code, "MEETING_MEDIA_NO_AUDIO");
            } else {
                assert_eq!(error.code, "MEETING_MEDIA_DECODE_FAILED");
            }
            assert_eq!(fs::read(&source).unwrap(), bytes);
            assert_eq!(
                fs::read_dir(&temporary_root).unwrap().count(),
                0,
                "失败后必须清理暂存文件及其目录"
            );
        }
    }

    #[test]
    fn cancellation_prevents_native_decode_and_file_changes() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("cancelled.mp4");
        fs::write(
            &source,
            include_bytes!("../../tests/fixtures/meeting-media/tone.mp4"),
        )
        .unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let error = prepare_audio(&source, &progress, &cancel).err().unwrap();
        assert_eq!(error.code, "JOB_CANCELLED");
        assert!(source.is_file());
    }

    #[test]
    fn cancellation_during_native_decode_cleans_partial_audio() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("cancel-during-decode.mp4");
        let temporary_root = directory.path().join("decoded");
        fs::create_dir(&temporary_root).unwrap();
        let bytes = include_bytes!("../../tests/fixtures/meeting-media/tone.mp4");
        fs::write(&source, bytes).unwrap();
        let cancel = cancel_flag();
        let saw_audio = AtomicBool::new(false);
        let progress = |_: &str, _: usize, _: usize, message: &str| {
            if message.contains("已处理") {
                saw_audio.store(true, Ordering::Relaxed);
                cancel.store(true, Ordering::Relaxed);
            }
        };
        let error = prepare_audio_in(&source, &progress, &cancel, &temporary_root)
            .err()
            .unwrap();
        assert!(
            saw_audio.load(Ordering::Relaxed),
            "必须确实解码并写入部分声音后再取消"
        );
        assert_eq!(error.code, "JOB_CANCELLED");
        assert_eq!(fs::read_dir(&temporary_root).unwrap().count(), 0);
        assert_eq!(fs::read(&source).unwrap(), bytes);
    }
}
