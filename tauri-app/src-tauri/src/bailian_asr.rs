//! 阿里云百炼（DashScope）语音转写客户端。
//!
//! 流程：本地文件 → 获取上传凭证 → 直传百炼临时 OSS（`oss://` URL，48 小时
//! 有效）→ 提交异步转写任务（paraformer-v2，开说话人分离）→ 轮询任务 →
//! 下载转写结果 JSON。转写按语音内容时长计费，非语音部分不计费。

use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::AppError;

const BASE: &str = "https://dashscope.aliyuncs.com";
const MODEL: &str = "paraformer-v2";
/// 百炼临时存储单文件上限 1GB；说话人分离建议音频不超过 2 小时。
const MAX_UPLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// 转写轮询上限：两小时录音远用不了这么久，只防异常挂死。
const POLL_LIMIT: Duration = Duration::from_secs(60 * 60);

pub(crate) type Progress<'a> = &'a dyn Fn(&str, usize, usize, &str);

#[derive(Debug)]
pub(crate) struct Sentence {
    pub text: String,
    pub speaker_id: i64,
    pub begin_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug)]
pub(crate) struct TranscriptionResult {
    pub sentences: Vec<Sentence>,
    pub speakers: usize,
    pub billed_ms: i64,
}

fn asr_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn cancelled_error() -> AppError {
    AppError::new("JOB_CANCELLED", "任务已取消。", true, None)
}

pub(crate) fn load_api_key(param: Option<&str>) -> Result<String, AppError> {
    if let Some(key) = param.filter(|key| !key.trim().is_empty()) {
        return Ok(key.trim().to_string());
    }
    keyring::Entry::new("AuditToolbox", "bailian_asr_key")
        .and_then(|entry| entry.get_password())
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            asr_error(
                "ASR_KEY_MISSING",
                "未配置百炼语音转写 API 密钥，请到设置页「语音转写（百炼）」卡片填写。",
                None,
            )
        })
}

/// 设置页「测试连接」：调上传凭证接口验证密钥有效性。
pub(crate) fn test_connection(api_key: Option<&str>) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let key = load_api_key(api_key)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(network_error)?;
    let response = client
        .get(format!("{BASE}/api/v1/uploads"))
        .query(&[("action", "getPolicy"), ("model", MODEL)])
        .bearer_auth(&key)
        .send()
        .map_err(network_error)?;
    let status = response.status();
    let body = response.text().map_err(network_error)?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(asr_error(
            "ASR_KEY_INVALID",
            "百炼 API 密钥无效或无权限，请核对后重试。",
            Some(format!("HTTP {status}")),
        ));
    }
    if !status.is_success() {
        return Err(asr_error(
            "ASR_REQUEST_FAILED",
            "百炼服务返回错误。",
            Some(format!("HTTP {status}：{}", snippet(&body))),
        ));
    }
    // 响应里 data.upload_host 存在即认为密钥可用。
    let parsed: Value = serde_json::from_str(&body).map_err(|e| {
        asr_error(
            "ASR_RESPONSE_INVALID",
            "百炼返回内容无法解析。",
            Some(e.to_string()),
        )
    })?;
    if parsed.pointer("/data/upload_host").and_then(Value::as_str).is_none() {
        return Err(asr_error(
            "ASR_RESPONSE_INVALID",
            "百炼返回内容缺少上传凭证。",
            Some(snippet(&body)),
        ));
    }
    Ok(json!({
        "ok": true,
        "message": "百炼语音转写连接测试成功。",
        "elapsedMs": started.elapsed().as_millis()
    }))
}

fn snippet(body: &str) -> String {
    body.trim().chars().take(300).collect()
}

fn network_error(error: impl std::fmt::Display) -> AppError {
    asr_error(
        "NETWORK_ERROR",
        "网络请求失败，请检查网络连接。",
        Some(error.to_string()),
    )
}

struct UploadPolicy {
    upload_host: String,
    upload_dir: String,
    oss_access_key_id: String,
    policy: String,
    signature: String,
    object_acl: String,
    forbid_overwrite: String,
    max_file_size_mb: Option<u64>,
}

fn get_policy(client: &reqwest::blocking::Client, key: &str) -> Result<UploadPolicy, AppError> {
    let response = client
        .get(format!("{BASE}/api/v1/uploads"))
        .query(&[("action", "getPolicy"), ("model", MODEL)])
        .bearer_auth(key)
        .send()
        .map_err(network_error)?;
    let value = read_json_response(response, "获取百炼上传凭证失败。")?;
    let data = value.get("data").cloned().unwrap_or(Value::Null);
    let pick = |field: &str| -> Option<String> {
        data.get(field).and_then(Value::as_str).map(str::to_owned)
    };
    Ok(UploadPolicy {
        upload_host: pick("upload_host").ok_or_else(|| {
            asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少 upload_host。", None)
        })?,
        upload_dir: pick("upload_dir").ok_or_else(|| {
            asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少 upload_dir。", None)
        })?,
        oss_access_key_id: pick("oss_access_key_id").ok_or_else(|| {
            asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少访问标识。", None)
        })?,
        policy: pick("policy").ok_or_else(|| {
            asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少 policy。", None)
        })?,
        signature: pick("signature").ok_or_else(|| {
            asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少签名。", None)
        })?,
        object_acl: pick("x_oss_object_acl").unwrap_or_else(|| "private".into()),
        forbid_overwrite: pick("x_oss_forbid_overwrite").unwrap_or_else(|| "true".into()),
        max_file_size_mb: data
            .get("max_file_size_mb")
            .and_then(Value::as_u64),
    })
}

/// 先取文本再判状态，错误体里保留服务端信息。
fn read_json_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<Value, AppError> {
    let status = response.status();
    let body = response.text().map_err(network_error)?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/message")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| snippet(&body));
        let code = if status.as_u16() == 401 || status.as_u16() == 403 {
            "ASR_KEY_INVALID"
        } else {
            "ASR_REQUEST_FAILED"
        };
        return Err(asr_error(code, label, Some(format!("HTTP {status}：{detail}"))));
    }
    serde_json::from_str(&body).map_err(|e| {
        asr_error(
            "ASR_RESPONSE_INVALID",
            "百炼返回内容无法解析。",
            Some(format!("{e}；响应开头：{}", snippet(&body))),
        )
    })
}

fn upload_audio(
    client: &reqwest::blocking::Client,
    key: &str,
    path: &Path,
    progress: Progress,
) -> Result<String, AppError> {
    let policy = get_policy(client, key)?;
    let size = std::fs::metadata(path).map(|meta| meta.len()).map_err(|e| {
        asr_error("ASR_FILE_MISSING", "找不到要转写的录音文件。", Some(e.to_string()))
    })?;
    if size > MAX_UPLOAD_BYTES
        || policy
            .max_file_size_mb
            .is_some_and(|limit| size > limit * 1024 * 1024)
    {
        return Err(asr_error(
            "ASR_FILE_TOO_LARGE",
            "录音文件超出百炼上传上限，请缩短录音时长后重试。",
            Some(format!("{size} 字节")),
        ));
    }
    let file_name = format!(
        "meeting-{}{}",
        uuid::Uuid::new_v4().simple(),
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| format!(".{extension}"))
            .unwrap_or_else(|| ".wav".into())
    );
    let object_key = format!("{}/{}", policy.upload_dir.trim_end_matches('/'), file_name);
    // OSS 表单校验要求 file 必须是最后一个域。
    let form = reqwest::blocking::multipart::Form::new()
        .text("OSSAccessKeyId", policy.oss_access_key_id)
        .text("Signature", policy.signature)
        .text("policy", policy.policy)
        .text("x-oss-object-acl", policy.object_acl)
        .text("x-oss-forbid-overwrite", policy.forbid_overwrite)
        .text("key", object_key.clone())
        .text("success_action_status", "200")
        .file("file", path)
        .map_err(|e| asr_error("ASR_UPLOAD_FAILED", "读取录音文件失败。", Some(e.to_string())))?;
    progress("running", 0, 4, "正在上传录音到百炼临时存储…");
    let response = client
        .post(&policy.upload_host)
        .multipart(form)
        .send()
        .map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(asr_error(
            "ASR_UPLOAD_FAILED",
            "录音上传百炼失败。",
            Some(format!("HTTP {status}：{}", snippet(&body))),
        ));
    }
    Ok(format!("oss://{object_key}"))
}

fn submit_transcription(
    client: &reqwest::blocking::Client,
    key: &str,
    oss_url: &str,
) -> Result<String, AppError> {
    let response = client
        .post(format!("{BASE}/api/v1/services/audio/asr/transcription"))
        .bearer_auth(key)
        .header("X-DashScope-Async", "enable")
        // oss:// 临时地址需要服务端代为解析。
        .header("X-DashScope-OssResourceResolve", "enable")
        .json(&json!({
            "model": MODEL,
            "input": {"file_urls": [oss_url]},
            "parameters": {"language_hints": ["zh", "en"], "diarization_enabled": true}
        }))
        .send()
        .map_err(network_error)?;
    let value = read_json_response(response, "提交百炼转写任务失败。")?;
    value
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| asr_error("ASR_SUBMIT_INVALID", "百炼未返回任务编号。", None))
}

fn poll_transcription(
    client: &reqwest::blocking::Client,
    key: &str,
    task_id: &str,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        let response = client
            .post(format!("{BASE}/api/v1/tasks/{task_id}"))
            .bearer_auth(key)
            .send()
            .map_err(network_error)?;
        let value = read_json_response(response, "查询百炼转写任务失败。")?;
        let status = value
            .pointer("/output/task_status")
            .and_then(Value::as_str)
            .unwrap_or("");
        match status {
            "SUCCEEDED" => return Ok(value),
            "FAILED" | "CANCELED" | "CANCELLED" => {
                let message = value
                    .pointer("/output/message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        value
                            .pointer("/results/0/message")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| "任务失败".into());
                return Err(asr_error(
                    "ASR_TASK_FAILED",
                    "百炼转写任务失败。",
                    Some(message),
                ));
            }
            _ => {
                let elapsed = started.elapsed().as_secs() / 60;
                progress(
                    "running",
                    1,
                    4,
                    &format!("百炼转写进行中（已等待 {elapsed} 分钟）…"),
                );
            }
        }
        if started.elapsed() > POLL_LIMIT {
            return Err(asr_error(
                "ASR_TASK_TIMEOUT",
                "百炼转写超时，请稍后重试。",
                Some(format!("任务编号 {task_id}")),
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// 转写主入口：上传 → 提交 → 轮询 → 下载结果。
pub(crate) fn transcribe_file(
    path: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
) -> Result<TranscriptionResult, AppError> {
    let key = load_api_key(None)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(network_error)?;
    let oss_url = upload_audio(&client, &key, path, progress)?;
    let task_id = submit_transcription(&client, &key, &oss_url)?;
    let task = poll_transcription(&client, &key, &task_id, progress, cancel)?;
    let transcription_url = task
        .pointer("/results/0/transcription_url")
        .and_then(Value::as_str)
        .ok_or_else(|| asr_error("ASR_RESULT_MISSING", "百炼任务成功但没有返回结果地址。", None))?;
    let download = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(network_error)?;
    let response = download
        .get(transcription_url)
        .send()
        .map_err(network_error)?;
    let result = read_json_response(response, "下载百炼转写结果失败。")?;
    parse_transcription(&result)
}

fn parse_transcription(result: &Value) -> Result<TranscriptionResult, AppError> {
    let empty = vec![];
    let sentences_value = result
        .pointer("/transcripts/0/sentences")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut speakers: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    let mut sentences = Vec::with_capacity(sentences_value.len());
    for item in sentences_value {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let speaker_id = item.get("speaker_id").and_then(Value::as_i64).unwrap_or(0);
        speakers.insert(speaker_id);
        sentences.push(Sentence {
            text,
            speaker_id,
            begin_ms: item.get("begin_time").and_then(Value::as_i64).unwrap_or(0),
            end_ms: item.get("end_time").and_then(Value::as_i64).unwrap_or(0),
        });
    }
    if sentences.is_empty() {
        return Err(asr_error(
            "ASR_EMPTY_TRANSCRIPT",
            "转写完成但没有识别到语音内容，请确认录音中有清晰人声。",
            None,
        ));
    }
    let billed_ms = result
        .pointer("/transcripts/0/content_duration_in_milliseconds")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok(TranscriptionResult {
        sentences,
        speakers: speakers.len(),
        billed_ms,
    })
}

/// 把带说话人标签的句子整理成文本稿：同一个人的连续发言合段。
pub(crate) fn transcript_text(sentences: &[Sentence]) -> String {
    let mut output = String::new();
    let mut current_speaker: Option<i64> = None;
    for sentence in sentences {
        if current_speaker != Some(sentence.speaker_id) {
            if !output.is_empty() {
                output.push('\n');
            }
            let stamp = format_timestamp(sentence.begin_ms);
            output.push_str(&format!("[{stamp}] 说话人{}：", sentence.speaker_id + 1));
            current_speaker = Some(sentence.speaker_id);
        } else {
            output.push(' ');
        }
        output.push_str(&sentence.text);
    }
    output.push('\n');
    output
}

pub(crate) fn format_timestamp(ms: i64) -> String {
    let total_seconds = ms / 1000;
    format!("{:02}:{:02}", total_seconds / 60, total_seconds % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence(text: &str, speaker_id: i64, begin_ms: i64) -> Sentence {
        Sentence {
            text: text.into(),
            speaker_id,
            begin_ms,
            end_ms: begin_ms + 1500,
        }
    }

    #[test]
    fn transcript_text_groups_by_speaker() {
        let sentences = vec![
            sentence("大家好，我们开始。", 0, 0),
            sentence("先看上季度的数据。", 0, 4100),
            sentence("好的，我这边准备好了。", 1, 9000),
            sentence("那我们过一遍。", 0, 15000),
        ];
        let text = transcript_text(&sentences);
        assert!(text.contains("[00:00] 说话人1：大家好，我们开始。 先看上季度的数据。"));
        assert!(text.contains("[00:09] 说话人2：好的，我这边准备好了。"));
        assert!(text.contains("[00:15] 说话人1：那我们过一遍。"));
    }

    #[test]
    fn parse_transcription_reads_sentences_and_speakers() {
        let result: Value = serde_json::from_str(
            r#"{"transcripts":[{"content_duration_in_milliseconds":65000,"sentences":[
                {"text":"第一句","speaker_id":0,"begin_time":0,"end_time":900},
                {"text":"第二句","speaker_id":1,"begin_time":1000,"end_time":2000},
                {"text":"","speaker_id":1,"begin_time":2100,"end_time":2200}
            ]}]}"#,
        )
        .unwrap();
        let parsed = parse_transcription(&result).unwrap();
        assert_eq!(parsed.sentences.len(), 2);
        assert_eq!(parsed.speakers, 2);
        assert_eq!(parsed.billed_ms, 65000);
    }

    #[test]
    fn parse_transcription_rejects_empty() {
        let result: Value = serde_json::from_str(r#"{"transcripts":[{"sentences":[]}]}"#).unwrap();
        let error = parse_transcription(&result).unwrap_err();
        assert_eq!(error.code, "ASR_EMPTY_TRANSCRIPT");
    }

    #[test]
    fn timestamp_formats_minutes_and_seconds() {
        assert_eq!(format_timestamp(0), "00:00");
        assert_eq!(format_timestamp(59_999), "00:59");
        assert_eq!(format_timestamp(75_000), "01:15");
        assert_eq!(format_timestamp(3_661_000), "61:01");
    }
}
