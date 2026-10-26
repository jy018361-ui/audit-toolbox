//! 百炼 Token Plan 套餐转写通道：realtime 模型的 WebSocket 实时协议。
//!
//! 套餐专属密钥（`sk-sp-`）只能访问套餐端点，语音识别不在通用文件转写服务里，
//! 而是走 `wss://{套餐地址}/api-ws/v1/realtime?model=...` 的实时协议：
//! 建会话 → 逐段喂 WAV → 服务端转写 → `input_audio_transcription.completed`
//! 事件回传文字（2026-09 用 7 秒样音实测逐字准确）。
//!
//! 与通用通道（`bailian_asr` 的 paraformer-v2 文件转写）的差别：
//! - token 计费刷套餐额度，不需要按时长付费的通用密钥；
//! - 不区分说话人（转写稿无「说话人N」标签，纪要提示词按无说话人分支走）；
//! - 仅支持 16 位 WAV（工具箱自录会议即是该格式），导入的 mp3 等请走通用通道。

use base64::Engine as _;
use serde_json::{Value, json};
use std::{
    io::Cursor,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::AppError;
use crate::bailian_asr::{Sentence, TranscriptionResult};

pub(crate) type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

const DEFAULT_BASE_URL: &str = "https://token-plan.cn-beijing.maas.aliyuncs.com";
const DEFAULT_MODEL: &str = "qwen-audio-3.0-realtime-plus";
/// 每段喂给实时通道的音频秒数：太长单会话上下文压力大，太短握手开销高。
const CHUNK_SECONDS: u32 = 120;
/// 单段转写上限：正常远快于实时，超时说明通道异常，避免整个任务挂死。
const CHUNK_TIMEOUT: Duration = Duration::from_secs(300);
/// 单帧 `input_audio_buffer.append` 的 base64 分片（字符数）。
const APPEND_SLICE: usize = 200_000;

fn plan_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn cancelled_error() -> AppError {
    AppError::new("JOB_CANCELLED", "任务已取消。", true, None)
}

pub(crate) struct PlanAsrConfig {
    pub base_url: String,
    pub model: String,
}

impl PlanAsrConfig {
    /// 从注入的 `__settings.meeting` 命名空间读取，缺省值与设置页占位一致。
    pub(crate) fn from_settings(settings: &Value) -> Self {
        let meeting = settings.get("meeting").cloned().unwrap_or(Value::Null);
        let pick = |key: &str, default: &str| {
            meeting
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(default)
                .to_owned()
        };
        PlanAsrConfig {
            base_url: pick("plan_base_url", DEFAULT_BASE_URL),
            model: pick("plan_model", DEFAULT_MODEL),
        }
    }
}

pub(crate) fn load_plan_key() -> Result<String, AppError> {
    keyring::Entry::new("AuditToolbox", "bailian_plan_asr_key")
        .and_then(|entry| entry.get_password())
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            plan_error(
                "PLAN_ASR_KEY_MISSING",
                "未配置百炼套餐转写密钥，请到设置页「语音转写（百炼）」卡片选择套餐通道并填写套餐密钥。",
                None,
            )
        })
}

/// 兼容订阅页文本接口地址、服务根地址及完整实时接口，测试和转写共用。
fn ws_url(base_url: &str, model: &str) -> Result<String, AppError> {
    let invalid_url = || {
        plan_error(
            "PLAN_ASR_URL_INVALID",
            "套餐转写地址格式不正确，请填写 HTTP(S) 服务地址或 WS(S) 实时接口；不能包含账号、密码或其他查询参数。",
            None,
        )
    };
    let base_url = base_url.trim();
    let mut url = reqwest::Url::parse(if base_url.is_empty() {
        DEFAULT_BASE_URL
    } else {
        base_url
    })
    .map_err(|_| invalid_url())?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" => "ws",
        _ => return Err(invalid_url()),
    };
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query_pairs().any(|(name, _)| name != "model")
    {
        return Err(invalid_url());
    }
    let path = url.path().trim_end_matches('/');
    let path = path.strip_suffix("/api-ws/v1/realtime").unwrap_or(path);
    let path = path.strip_suffix("/compatible-mode/v1").unwrap_or(path);
    let path = format!("{path}/api-ws/v1/realtime");
    url.set_scheme(scheme).map_err(|_| invalid_url())?;
    url.set_path(&path);
    url.set_query(None);
    let model = model.trim();
    url.query_pairs_mut().append_pair(
        "model",
        if model.is_empty() {
            DEFAULT_MODEL
        } else {
            model
        },
    );
    Ok(url.to_string())
}

fn connection_error(error: tokio_tungstenite::tungstenite::Error) -> AppError {
    use tokio_tungstenite::tungstenite::Error;
    if let Error::Http(response) = &error {
        let status = response.status().as_u16();
        let message = match status {
            401 | 403 => "套餐实时语音鉴权失败，请核对套餐专用密钥及该模型的访问权限。",
            404 => "未找到套餐实时语音接口，请核对套餐服务地址及模型名称。",
            429 => "套餐实时语音请求受限，请检查套餐额度或稍后重试。",
            _ => "套餐实时语音服务拒绝连接，请核对地址、模型及套餐权限。",
        };
        return plan_error(
            "PLAN_ASR_CONNECT_FAILED",
            message,
            Some(format!("HTTP {status}")),
        );
    }
    let detail = error.to_string();
    if detail.to_ascii_lowercase().contains("certificate") {
        return plan_error(
            "PLAN_ASR_TLS_FAILED",
            "套餐实时语音证书校验失败，请检查 Windows 系统证书、系统时间及网络代理证书。",
            Some(detail),
        );
    }
    plan_error(
        "PLAN_ASR_CONNECT_FAILED",
        "套餐实时语音连接失败，请检查网络连接并查看详细原因。",
        Some(detail),
    )
}

type PlanSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 使用 Windows 原生证书链校验（包括中间证书补全及系统信任），保留域名和有效期校验。
async fn connect(url: &str, key: &str) -> Result<PlanSocket, AppError> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let tls_error = |error: rustls::Error| {
        plan_error(
            "PLAN_ASR_TLS_FAILED",
            "无法初始化 Windows 证书校验。",
            Some(error.to_string()),
        )
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(tls_error)?
    .with_platform_verifier()
    .map_err(tls_error)?
    .with_no_client_auth();
    let request = build_request(url, key)?;
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(20),
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            None,
            false,
            Some(tokio_tungstenite::Connector::Rustls(Arc::new(config))),
        ),
    )
    .await
    .map_err(|_| {
        plan_error(
            "PLAN_ASR_TIMEOUT",
            "套餐实时语音连接超时，请检查网络后重试。",
            None,
        )
    })?
    .map_err(connection_error)?;
    Ok(socket)
}

#[derive(Debug)]
struct PlanChunk {
    b64: String,
    begin_ms: i64,
    end_ms: i64,
}

/// 样本序列编回独立 WAV（带文件头）。hound 的 `finalize` 会消费写入器且
/// 不回传缓冲，所以借用 Cursor 写完再取回字节。
fn wav_bytes(spec: hound::WavSpec, samples: &[i16]) -> Result<Vec<u8>, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut writer = hound::WavWriter::new(&mut buffer, spec).map_err(|error| {
            plan_error(
                "PLAN_ASR_WRITE_FAILED",
                "生成转写音频分段失败。",
                Some(error.to_string()),
            )
        })?;
        for &sample in samples {
            writer.write_sample(sample).map_err(|error| {
                plan_error(
                    "PLAN_ASR_WRITE_FAILED",
                    "生成转写音频分段失败。",
                    Some(error.to_string()),
                )
            })?;
        }
        writer.finalize().map_err(|error| {
            plan_error(
                "PLAN_ASR_WRITE_FAILED",
                "生成转写音频分段失败。",
                Some(error.to_string()),
            )
        })?;
    }
    Ok(buffer.into_inner())
}

/// 读取 16 位 WAV 并按 `chunk_seconds` 切成独立的小 WAV（带各自文件头）。
/// 逐段处理控制内存：两小时录音同一时刻只在内存里保留一段样本。
fn wav_chunks_with(
    path: &Path,
    chunk_seconds: u32,
) -> Result<(hound::WavSpec, Vec<PlanChunk>), AppError> {
    let mut reader = hound::WavReader::open(path).map_err(|error| {
        plan_error(
            "PLAN_ASR_UNSUPPORTED_FORMAT",
            "套餐转写通道仅支持 WAV 录音（工具箱自录会议即为 WAV）；其他格式请切换通用转写通道。",
            Some(error.to_string()),
        )
    })?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(plan_error(
            "PLAN_ASR_UNSUPPORTED_FORMAT",
            "套餐转写通道仅支持 16 位 WAV 录音，其他编码请切换通用转写通道。",
            Some(format!(
                "采样格式 {:?}/{} 位",
                spec.sample_format, spec.bits_per_sample
            )),
        ));
    }
    let samples_per_chunk =
        (spec.sample_rate as u64 * spec.channels as u64 * chunk_seconds as u64).max(1) as usize;
    let ms_per_frame = 1000.0 / (spec.sample_rate as f64 * spec.channels as f64);
    let mut chunks: Vec<PlanChunk> = Vec::new();
    let mut pending: Vec<i16> = Vec::with_capacity(samples_per_chunk);
    let mut written: u64 = 0;
    let mut chunk_first_sample: u64 = 0;
    let mut flush =
        |pending: &mut Vec<i16>, chunk_first_sample: u64, written: u64| -> Result<(), AppError> {
            if pending.is_empty() {
                return Ok(());
            }
            let bytes = wav_bytes(spec, pending)?;
            chunks.push(PlanChunk {
                b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                begin_ms: (chunk_first_sample as f64 * ms_per_frame) as i64,
                end_ms: (written as f64 * ms_per_frame) as i64,
            });
            pending.clear();
            Ok(())
        };
    for sample in reader.samples::<i16>() {
        let sample = sample.map_err(|error| {
            plan_error(
                "PLAN_ASR_READ_FAILED",
                "读取录音样本失败。",
                Some(error.to_string()),
            )
        })?;
        pending.push(sample);
        written += 1;
        if pending.len() >= samples_per_chunk {
            flush(&mut pending, chunk_first_sample, written)?;
            chunk_first_sample = written;
        }
    }
    flush(&mut pending, chunk_first_sample, written)?;
    Ok((spec, chunks))
}

fn wav_chunks(path: &Path) -> Result<(hound::WavSpec, Vec<PlanChunk>), AppError> {
    wav_chunks_with(path, CHUNK_SECONDS)
}

fn runtime() -> Result<tokio::runtime::Runtime, AppError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            plan_error(
                "PLAN_ASR_RUNTIME_FAILED",
                "转写任务初始化失败。",
                Some(error.to_string()),
            )
        })
}

/// 实时协议鉴权：浏览器式 WebSocket 无法带自定义头，服务端只认
/// Authorization 头，必须手工构造 upgrade 请求。
fn build_request(
    url: &str,
    key: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, AppError> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url.into_client_request().map_err(|error| {
        plan_error(
            "PLAN_ASR_URL_INVALID",
            "套餐转写地址无法解析。",
            Some(error.to_string()),
        )
    })?;
    let header_value =
        tokio_tungstenite::tungstenite::http::HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|error| {
                plan_error(
                    "PLAN_ASR_URL_INVALID",
                    "套餐密钥包含非法字符。",
                    Some(error.to_string()),
                )
            })?;
    request.headers_mut().insert("Authorization", header_value);
    Ok(request)
}

async fn wait_cancelled(cancel: &AtomicBool) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// 单段转写：建会话 → 声明纯文字输出（关自动断句检测）→ 喂音频 → 提交 →
/// 等 `input_audio_transcription.completed` 的整段文字。绝不能发
/// `response.create`：那会让模型接着音频「回话」，白费输出 token。
fn transcribe_chunk(
    rt: &tokio::runtime::Runtime,
    url: &str,
    key: &str,
    chunk_b64: &str,
    cancel: &AtomicBool,
) -> Result<String, AppError> {
    rt.block_on(async {
        use futures_util::{SinkExt, StreamExt};
        let mut socket = connect(url, key).await?;
        let session_update = json!({
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "input_audio_format": "wav",
                "turn_detection": null
            }
        });
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                session_update.to_string().into(),
            ))
            .await
            .map_err(|error| plan_error("PLAN_ASR_SEND_FAILED", "发送转写会话配置失败。", Some(error.to_string())))?;
        for start in (0..chunk_b64.len()).step_by(APPEND_SLICE) {
            let end = (start + APPEND_SLICE).min(chunk_b64.len());
            let append = json!({
                "type": "input_audio_buffer.append",
                "audio": &chunk_b64[start..end]
            });
            socket
                .send(tokio_tungstenite::tungstenite::Message::Text(append.to_string().into()))
                .await
                .map_err(|error| plan_error("PLAN_ASR_SEND_FAILED", "发送转写音频失败。", Some(error.to_string())))?;
        }
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"type": "input_audio_buffer.commit"}).to_string().into(),
            ))
            .await
            .map_err(|error| plan_error("PLAN_ASR_SEND_FAILED", "提交转写音频失败。", Some(error.to_string())))?;
        let deadline = tokio::time::Instant::now() + CHUNK_TIMEOUT;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(plan_error("PLAN_ASR_TIMEOUT", "套餐转写超时，请稍后重试。", None));
                }
                _ = wait_cancelled(cancel) => {
                    return Err(cancelled_error());
                }
                message = socket.next() => {
                    let message = match message {
                        Some(Ok(message)) => message,
                        Some(Err(error)) => {
                            return Err(plan_error("PLAN_ASR_STREAM_BROKEN", "套餐转写连接中断。", Some(error.to_string())));
                        }
                        None => {
                            return Err(plan_error("PLAN_ASR_STREAM_BROKEN", "套餐转写连接提前关闭。", None));
                        }
                    };
                    let text = match message {
                        tokio_tungstenite::tungstenite::Message::Text(text) => text,
                        tokio_tungstenite::tungstenite::Message::Close(_) => {
                            return Err(plan_error("PLAN_ASR_STREAM_BROKEN", "套餐转写连接被服务端关闭。", None));
                        }
                        _ => continue,
                    };
                    let event: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        plan_error("PLAN_ASR_RESPONSE_INVALID", "套餐转写返回内容无法解析。", Some(error.to_string()))
                    })?;
                    match event.get("type").and_then(Value::as_str).unwrap_or("") {
                        "conversation.item.input_audio_transcription.completed" => {
                            return Ok(event
                                .get("transcript")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .trim()
                                .to_owned());
                        }
                        "conversation.item.input_audio_transcription.failed" => {
                            let detail = event.get("error").map(|error| error.to_string());
                            return Err(plan_error(
                                "PLAN_ASR_SERVER_ERROR",
                                "套餐转写服务未能处理该段音频。",
                                detail,
                            ));
                        }
                        "error" => {
                            return Err(plan_error(
                                "PLAN_ASR_SERVER_ERROR",
                                "套餐转写服务返回错误。",
                                Some(event.to_string()),
                            ));
                        }
                        _ => continue,
                    }
                }
            }
        }
    })
}

/// 套餐转写主入口：切段 → 逐段实时转写 → 汇成无说话人标签的转写结果。
/// `speakers` 恒为 0，纪要侧据此走「无说话人」提示词分支。
pub(crate) fn transcribe_file(
    path: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
    config: &PlanAsrConfig,
) -> Result<TranscriptionResult, AppError> {
    let url = ws_url(&config.base_url, &config.model)?;
    let key = load_plan_key()?;
    let (_spec, chunks) = wav_chunks(path)?;
    if chunks.is_empty() {
        return Err(plan_error(
            "ASR_EMPTY_TRANSCRIPT",
            "录音文件里没有音频数据。",
            None,
        ));
    }
    let runtime = runtime()?;
    let total = chunks.len();
    let mut sentences = Vec::new();
    let mut total_ms: i64 = 0;
    for (index, chunk) in chunks.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        progress(
            "running",
            0,
            4,
            &format!("套餐通道转写中：第 {} / {} 段…", index + 1, total),
        );
        let transcript = transcribe_chunk(&runtime, &url, &key, &chunk.b64, cancel)?;
        if !transcript.is_empty() {
            sentences.push(Sentence {
                text: transcript,
                speaker_id: 0,
                begin_ms: chunk.begin_ms,
                end_ms: chunk.end_ms,
            });
        }
        total_ms = chunk.end_ms;
    }
    if sentences.is_empty() {
        return Err(plan_error(
            "ASR_EMPTY_TRANSCRIPT",
            "转写完成但没有识别到语音内容，请确认录音中有清晰人声。",
            None,
        ));
    }
    Ok(TranscriptionResult {
        sentences,
        speakers: 0,
        billed_ms: total_ms,
    })
}

/// 无说话人标签的转写稿：每段一行，行首时间戳。
pub(crate) fn transcript_text_plain(sentences: &[Sentence]) -> String {
    let mut output = String::new();
    for sentence in sentences {
        let stamp = crate::bailian_asr::format_timestamp(sentence.begin_ms);
        output.push_str(&format!("[{stamp}] {}\n", sentence.text));
    }
    output
}

pub(crate) struct PlanTestParams {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// 设置页「测试连接」（套餐通道）：建会话等 `session.created` 即可，
/// 不喂音频、不产生 token 消耗。
pub(crate) fn test_connection(params: &PlanTestParams) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let url = ws_url(&params.base_url, &params.model)?;
    let key = params
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .map_or_else(load_plan_key, Ok)?;
    let runtime = runtime()?;
    runtime.block_on(async {
        use futures_util::StreamExt;
        let mut socket = connect(&url, &key).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(plan_error("PLAN_ASR_TIMEOUT", "套餐通道响应超时。", None));
                }
                message = socket.next() => {
                    let text = match message {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => text,
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) | None => {
                            return Err(plan_error("PLAN_ASR_STREAM_BROKEN", "套餐通道连接被关闭。", None));
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(error)) => {
                            return Err(plan_error("PLAN_ASR_STREAM_BROKEN", "套餐通道连接中断。", Some(error.to_string())));
                        }
                    };
                    let event: Value = serde_json::from_str(text.as_str()).map_err(|error| {
                        plan_error("PLAN_ASR_RESPONSE_INVALID", "套餐通道返回内容无法解析。", Some(error.to_string()))
                    })?;
                    match event.get("type").and_then(Value::as_str).unwrap_or("") {
                        "session.created" | "session.updated" => {
                            let _ = socket.close(None).await;
                            return Ok(json!({
                                "ok": true,
                                "message": format!("套餐转写通道连接测试成功（模型 {}）。", if params.model.trim().is_empty() { DEFAULT_MODEL } else { params.model.trim() }),
                                "elapsedMs": started.elapsed().as_millis()
                            }));
                        }
                        "error" => {
                            return Err(plan_error(
                                "PLAN_ASR_SERVER_ERROR",
                                "套餐转写服务返回错误。",
                                Some(event.to_string()),
                            ));
                        }
                        _ => continue,
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_converts_scheme_and_appends_realtime_path() {
        assert_eq!(
            ws_url("https://token-plan.cn-beijing.maas.aliyuncs.com", "m1").unwrap(),
            "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=m1"
        );
        assert_eq!(
            ws_url("https://host.cn/", "m1").unwrap(),
            "wss://host.cn/api-ws/v1/realtime?model=m1"
        );
        assert_eq!(
            ws_url("wss://host.cn", "m1").unwrap(),
            "wss://host.cn/api-ws/v1/realtime?model=m1"
        );
        assert_eq!(
            ws_url("http://host.cn", "m1").unwrap(),
            "ws://host.cn/api-ws/v1/realtime?model=m1"
        );
        assert!(ws_url("token-plan.cn-beijing.maas.aliyuncs.com", "m1").is_err());
    }

    #[test]
    fn ws_url_accepts_subscription_and_full_realtime_addresses() {
        let expected = format!(
            "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model={DEFAULT_MODEL}"
        );
        for suffix in [
            "",
            "/compatible-mode/v1",
            "/compatible-mode/v1/",
            "/api-ws/v1/realtime",
            "/api-ws/v1/realtime?model=old",
            "/compatible-mode/v1/api-ws/v1/realtime",
        ] {
            assert_eq!(
                ws_url(&format!("{DEFAULT_BASE_URL}{suffix}"), DEFAULT_MODEL).unwrap(),
                expected
            );
        }
        assert_eq!(ws_url(" ", " ").unwrap(), expected);
        let url = reqwest::Url::parse(
            &ws_url(
                "https://proxy.example.cn/voice/compatible-mode/v1",
                " model&extra=1 ",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(url.path(), "/voice/api-ws/v1/realtime");
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![("model".into(), "model&extra=1".into())]
        );
        for address in [
            "file:///c:/test",
            "https://user:secret@host.cn",
            "https://host.cn?key=secret",
            "https://host.cn/#secret",
        ] {
            let error = ws_url(address, "m1").unwrap_err();
            assert_eq!(error.code, "PLAN_ASR_URL_INVALID");
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn connection_errors_distinguish_certificate_auth_and_endpoint_failures() {
        use tokio_tungstenite::tungstenite::{Error, http::Response};
        let error = connection_error(Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid peer certificate: UnknownIssuer",
        )));
        assert_eq!(error.code, "PLAN_ASR_TLS_FAILED");
        assert!(error.user_message.contains("证书校验"));
        for (status, hint) in [(401, "鉴权"), (403, "鉴权"), (404, "接口"), (429, "额度")] {
            let error = connection_error(Error::Http(
                Response::builder().status(status).body(None).unwrap(),
            ));
            assert_eq!(error.code, "PLAN_ASR_CONNECT_FAILED");
            assert!(error.user_message.contains(hint));
            assert_eq!(error.detail.unwrap(), format!("HTTP {status}"));
        }
    }

    #[test]
    fn connection_test_normalizes_subscription_path_before_websocket_handshake() {
        use tokio_tungstenite::tungstenite::{
            Message, accept_hdr,
            handshake::server::{Request, Response},
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "未收到本地测试连接");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut socket = accept_hdr(socket, |request: &Request, response: Response| {
                assert_eq!(request.uri(), "/api-ws/v1/realtime?model=test-model");
                assert_eq!(request.headers()["authorization"], "Bearer test-only-key");
                Ok(response)
            })
            .unwrap();
            socket
                .send(Message::Text(
                    json!({"type": "session.created"}).to_string().into(),
                ))
                .unwrap();
            // 连接测试只建立会话并关闭，不发送音频。
            assert!(matches!(socket.read().unwrap(), Message::Close(_)));
        });
        let result = test_connection(&PlanTestParams {
            base_url: format!("http://{address}/compatible-mode/v1"),
            model: "test-model".into(),
            api_key: Some("test-only-key".into()),
        })
        .unwrap();
        server.join().unwrap();
        assert_eq!(result["ok"], true);
    }

    /// 仅建立官方服务会话；不发送音频、不打印密钥或服务端原始响应。
    #[test]
    #[ignore = "在线连接测试：需 AUDIT_TOOLBOX_PLAN_ASR_KEY，不上传音频"]
    fn online_connection_only() {
        let key = std::env::var("AUDIT_TOOLBOX_PLAN_ASR_KEY").expect("缺少在线测试密钥环境变量");
        match test_connection(&PlanTestParams {
            base_url: format!("{DEFAULT_BASE_URL}/compatible-mode/v1"),
            model: DEFAULT_MODEL.into(),
            api_key: Some(key),
        }) {
            Ok(result) => assert_eq!(result["ok"], true),
            Err(error) => panic!("在线连接测试失败：{}；{}", error.code, error.user_message),
        }
    }

    #[test]
    fn config_reads_plan_fields_with_defaults() {
        let settings = json!({"meeting": {
            "asr_channel": "token_plan",
            "plan_base_url": " https://example.cn/ ",
            "plan_model": "my-model"
        }});
        let config = PlanAsrConfig::from_settings(&settings);
        assert_eq!(config.base_url, "https://example.cn/");
        assert_eq!(config.model, "my-model");
        let fallback = PlanAsrConfig::from_settings(&json!({}));
        assert_eq!(fallback.base_url, DEFAULT_BASE_URL);
        assert_eq!(fallback.model, DEFAULT_MODEL);
    }

    fn write_wav(path: &Path, sample_rate: u32, seconds: f64) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for i in 0..(sample_rate as f64 * seconds) as u32 {
            let value = (i % 97 * 100) as i16;
            writer.write_sample(value).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn wav_chunks_split_by_seconds_with_timestamps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.wav");
        write_wav(&path, 16_000, 2.5);
        let (_spec, chunks) = wav_chunks_with(&path, 1).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].begin_ms, 0);
        assert!(chunks[0].end_ms >= 990 && chunks[0].end_ms <= 1010);
        assert!(chunks[1].begin_ms >= 990 && chunks[1].begin_ms <= 1010);
        assert!(chunks[2].end_ms >= 2490);
        // 每段都是独立 WAV：能重新解析出 RIFF 头。
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&chunks[0].b64)
            .unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert!(hound::WavReader::new(Cursor::new(bytes)).is_ok());
    }

    #[test]
    fn wav_chunks_rejects_non_16bit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t32.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        writer.write_sample(0_i32).unwrap();
        writer.finalize().unwrap();
        let error = wav_chunks_with(&path, 1).unwrap_err();
        assert_eq!(error.code, "PLAN_ASR_UNSUPPORTED_FORMAT");
    }

    #[test]
    fn plain_transcript_has_no_speaker_labels() {
        let sentences = vec![
            Sentence {
                text: "第一段话".into(),
                speaker_id: 0,
                begin_ms: 0,
                end_ms: 1000,
            },
            Sentence {
                text: "第二段话".into(),
                speaker_id: 0,
                begin_ms: 65_000,
                end_ms: 66_000,
            },
        ];
        let text = transcript_text_plain(&sentences);
        assert_eq!(text, "[00:00] 第一段话\n[01:05] 第二段话\n");
        assert!(!text.contains("说话人"));
    }

    /// 在线探针（默认 ignored）：设 `AUDIT_TOOLBOX_PLAN_ASR_KEY`（套餐
    /// sk-sp 密钥）后用 `-- --ignored 套餐` 运行，端到端验证 Rust WS 客户端。
    /// 可选 `AUDIT_TOOLBOX_PLAN_ASR_WAV` 指向含人声的样音，此时断言转写非空。
    #[test]
    #[ignore = "在线探针：需环境变量 AUDIT_TOOLBOX_PLAN_ASR_KEY，可选 AUDIT_TOOLBOX_PLAN_ASR_WAV"]
    fn 在线探针_套餐通道整段转写() {
        let key =
            std::env::var("AUDIT_TOOLBOX_PLAN_ASR_KEY").expect("缺 AUDIT_TOOLBOX_PLAN_ASR_KEY");
        let path = match std::env::var("AUDIT_TOOLBOX_PLAN_ASR_WAV") {
            Ok(wav) => std::path::PathBuf::from(wav),
            Err(_) => {
                // 无样音时用 1 秒正弦波：只验证协议链路（能收到 completed 事件），
                // 不指望转出文字。
                let path = std::env::temp_dir().join("audit-toolbox-plan-asr-probe.wav");
                let spec = hound::WavSpec {
                    channels: 1,
                    sample_rate: 16_000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                };
                let mut writer = hound::WavWriter::create(&path, spec).unwrap();
                for i in 0..16_000 {
                    let value = ((i as f32 / 16_000.0 * 440.0 * std::f32::consts::PI * 2.0).sin()
                        * 6000.0) as i16;
                    writer.write_sample(value).unwrap();
                }
                writer.finalize().unwrap();
                path
            }
        };
        let has_speech = std::env::var("AUDIT_TOOLBOX_PLAN_ASR_WAV").is_ok();
        let (_spec, chunks) = wav_chunks(&path).unwrap();
        assert_eq!(chunks.len(), 1, "样音应短于一个分段");
        let url = ws_url(DEFAULT_BASE_URL, DEFAULT_MODEL).unwrap();
        let runtime = runtime().unwrap();
        let transcript = transcribe_chunk(
            &runtime,
            &url,
            key.trim(),
            &chunks[0].b64,
            &AtomicBool::new(false),
        )
        .unwrap();
        if has_speech {
            assert!(
                !transcript.is_empty(),
                "含人声样音应转写出文字，实际：{transcript:?}"
            );
        }
        println!("套餐通道在线探针转写结果：{transcript:?}");
    }
}
