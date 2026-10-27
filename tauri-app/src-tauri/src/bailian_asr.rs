//! 阿里云百炼（DashScope）语音转写客户端。
//!
//! 流程：本地文件 → 获取上传凭证 → 直传百炼临时 OSS（`oss://` URL，48 小时
//! 有效）→ 提交异步转写任务（默认 paraformer-v2，开说话人分离）→ 轮询任务 →
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

const DEFAULT_BASE_URL: &str = "https://dashscope.aliyuncs.com";
const DEFAULT_MODEL: &str = "paraformer-v2";

/// 设置页测试与 worker 转写共用配置，旧设置和空值沿用原默认值。
#[derive(Debug)]
pub(crate) struct AsrConfig {
    base_url: String,
    model: String,
}

impl AsrConfig {
    pub(crate) fn new(base_url: Option<&str>, model: Option<&str>) -> Result<Self, AppError> {
        let base_url = base_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_BASE_URL)
            .trim_end_matches('/');
        let parsed = reqwest::Url::parse(base_url).map_err(|_| {
            asr_error(
                "ASR_URL_INVALID",
                "通用转写服务地址格式不正确，请填写以 https:// 或 http:// 开头的服务根地址。",
                None,
            )
        })?;
        if !matches!(parsed.scheme(), "https" | "http")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(asr_error(
                "ASR_URL_INVALID",
                "通用转写服务地址需为 HTTP(S) 服务根地址，不能包含账号、密码、查询参数或片段。",
                None,
            ));
        }
        Ok(Self {
            base_url: base_url.to_owned(),
            model: model
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_owned(),
        })
    }

    pub(crate) fn from_settings(settings: &Value) -> Result<Self, AppError> {
        Self::new(
            settings
                .pointer("/meeting/asr_base_url")
                .and_then(Value::as_str),
            settings
                .pointer("/meeting/asr_model")
                .and_then(Value::as_str),
        )
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }
}
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
    keyring::Entry::new(crate::release_channel::credential_service(), "bailian_asr_key")
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
pub(crate) fn test_connection(
    api_key: Option<&str>,
    config: &AsrConfig,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let key = load_api_key(api_key)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(network_error)?;
    let response = client
        .get(config.endpoint("/api/v1/uploads"))
        .query(&[("action", "getPolicy"), ("model", config.model.as_str())])
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
    if parsed
        .pointer("/data/upload_host")
        .and_then(Value::as_str)
        .is_none()
    {
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

fn get_policy(
    client: &reqwest::blocking::Client,
    key: &str,
    config: &AsrConfig,
) -> Result<UploadPolicy, AppError> {
    let response = client
        .get(config.endpoint("/api/v1/uploads"))
        .query(&[("action", "getPolicy"), ("model", config.model.as_str())])
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
        oss_access_key_id: pick("oss_access_key_id")
            .ok_or_else(|| asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少访问标识。", None))?,
        policy: pick("policy")
            .ok_or_else(|| asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少 policy。", None))?,
        signature: pick("signature")
            .ok_or_else(|| asr_error("ASR_POLICY_INVALID", "百炼上传凭证缺少签名。", None))?,
        object_acl: pick("x_oss_object_acl").unwrap_or_else(|| "private".into()),
        forbid_overwrite: pick("x_oss_forbid_overwrite").unwrap_or_else(|| "true".into()),
        max_file_size_mb: data.get("max_file_size_mb").and_then(Value::as_u64),
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
            .map(|value| task_error_detail(&value, None))
            .unwrap_or_else(|| snippet(&body));
        let code = if status.as_u16() == 401 || status.as_u16() == 403 {
            "ASR_KEY_INVALID"
        } else {
            "ASR_REQUEST_FAILED"
        };
        return Err(asr_error(
            code,
            label,
            Some(format!("HTTP {status}：{detail}")),
        ));
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
    config: &AsrConfig,
) -> Result<String, AppError> {
    let policy = get_policy(client, key, config)?;
    let size = std::fs::metadata(path)
        .map(|meta| meta.len())
        .map_err(|e| {
            asr_error(
                "ASR_FILE_MISSING",
                "找不到要转写的录音文件。",
                Some(e.to_string()),
            )
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
        .map_err(|e| {
            asr_error(
                "ASR_UPLOAD_FAILED",
                "读取录音文件失败。",
                Some(e.to_string()),
            )
        })?;
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
    config: &AsrConfig,
) -> Result<String, AppError> {
    let mut parameters = json!({"diarization_enabled": true});
    // language_hints 仅适用于 paraformer-v2；自定义兼容模型沿用其默认语言识别。
    if config.model == DEFAULT_MODEL {
        parameters["language_hints"] = json!(["zh", "en"]);
    }
    let response = client
        .post(config.endpoint("/api/v1/services/audio/asr/transcription"))
        .bearer_auth(key)
        .header("X-DashScope-Async", "enable")
        // oss:// 临时地址需要服务端代为解析。
        .header("X-DashScope-OssResourceResolve", "enable")
        .json(&json!({
            "model": config.model,
            "input": {"file_urls": [oss_url]},
            "parameters": parameters
        }))
        .send()
        .map_err(network_error)?;
    let value = read_json_response(response, "提交百炼转写任务失败。")?;
    value
        .pointer("/output/task_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            asr_error(
                "ASR_SUBMIT_INVALID",
                "百炼未返回任务编号。",
                Some(task_error_detail(&value, None)),
            )
        })
}

fn poll_transcription(
    client: &reqwest::blocking::Client,
    key: &str,
    task_id: &str,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
    config: &AsrConfig,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        let value = query_task(client, key, task_id, config)?;
        match task_finished(&value, task_id)? {
            true => return Ok(value),
            false => {
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

fn query_task(
    client: &reqwest::blocking::Client,
    key: &str,
    task_id: &str,
    config: &AsrConfig,
) -> Result<Value, AppError> {
    let response = client
        .post(config.endpoint(&format!("/api/v1/tasks/{task_id}")))
        .bearer_auth(key)
        .send()
        .map_err(network_error)?;
    read_json_response(response, "查询百炼转写任务失败。")
}

/// HTTP 正式响应在 output.results；兼容已有的扁平任务快照。
/// 缺字段是协议/结果异常，不能据此断言录音中没有人声。
fn task_results(task: &Value) -> Option<&Vec<Value>> {
    task.pointer("/output/results")
        .or_else(|| task.get("results"))?
        .as_array()
}

fn nonempty_string<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value
        .get(field)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// 只保留诊断字段，不把临时文件 URL、签名或整个响应当作错误详情。
fn task_error_detail(task: &Value, task_id: Option<&str>) -> String {
    let mut reasons = Vec::new();
    let mut add_reason = |value: &Value| {
        let code = nonempty_string(value, "code");
        let message = nonempty_string(value, "message").filter(|message| Some(*message) != code);
        let reason = [code, message]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("：");
        if !reason.is_empty() && !reasons.contains(&reason) {
            reasons.push(reason);
        }
    };
    if let Some(output) = task.get("output") {
        add_reason(output);
    }
    add_reason(task);
    if let Some(rows) = task_results(task) {
        for row in rows {
            add_reason(row);
        }
    }
    if reasons.is_empty() {
        reasons.push("服务端未返回具体失败原因".into());
    }
    let output = task.get("output").unwrap_or(task);
    if let Some(status) = nonempty_string(output, "task_status") {
        reasons.push(format!("任务状态：{status}"));
    }
    if let Some(id) = nonempty_string(output, "task_id").or(task_id) {
        reasons.push(format!("任务编号：{id}"));
    }
    if let Some(id) = nonempty_string(task, "request_id") {
        reasons.push(format!("请求编号：{id}"));
    }
    reasons.join("；")
}

fn failed_task_error(task: &Value, task_id: Option<&str>) -> AppError {
    let no_speech = std::iter::once(task)
        .chain(task.get("output"))
        .chain(task_results(task).into_iter().flatten())
        .any(|value| nonempty_string(value, "code") == Some("SUCCESS_WITH_NO_VALID_FRAGMENT"));
    if no_speech {
        return asr_error(
            "ASR_EMPTY_TRANSCRIPT",
            "百炼未检测到有效语音。请先回放原录音；若无声请检查录音设备后重新录制，若有清晰讲话请保留录音排查识别问题。",
            Some(task_error_detail(task, task_id)),
        );
    }
    asr_error(
        "ASR_TASK_FAILED",
        "百炼转写任务失败，原录音已保留，可重新导入重试。",
        Some(task_error_detail(task, task_id)),
    )
}

/// 兼容 HTTP 信封和扁平快照；明确失败立即退出，缺状态不再轮询一小时。
fn task_finished(task: &Value, task_id: &str) -> Result<bool, AppError> {
    let output = task.get("output").unwrap_or(task);
    let file_failed = task_results(task)
        .and_then(|rows| rows.first())
        .is_some_and(|row| {
            matches!(
                nonempty_string(row, "subtask_status"),
                Some("FAILED" | "CANCELED" | "CANCELLED")
            ) || nonempty_string(row, "code").is_some()
        });
    match nonempty_string(output, "task_status") {
        Some("FAILED" | "CANCELED" | "CANCELLED") => Err(failed_task_error(task, Some(task_id))),
        Some("SUCCEEDED") if file_failed => Err(failed_task_error(task, Some(task_id))),
        Some("SUCCEEDED") => Ok(true),
        Some("PENDING" | "RUNNING") => Ok(false),
        _ if nonempty_string(task, "code").is_some()
            || nonempty_string(output, "code").is_some() =>
        {
            Err(failed_task_error(task, Some(task_id)))
        }
        _ => Err(asr_error(
            "ASR_RESPONSE_INVALID",
            "百炼返回了无法识别的任务状态，请稍后重试。",
            Some(task_error_detail(task, Some(task_id))),
        )),
    }
}

fn transcription_url(task: &Value) -> Option<&str> {
    task_results(task)?
        .first()?
        .get("transcription_url")?
        .as_str()
        .map(str::trim)
        .filter(|url| !url.is_empty())
}

fn missing_url_error(task: &Value) -> AppError {
    let results = task_results(task);
    if results.is_some_and(|rows| rows.is_empty()) {
        return asr_error(
            "ASR_RESULT_MISSING",
            "转写服务未返回文件识别结果，原录音已保留，请稍后重试。",
            None,
        );
    }
    if let Some(first) = results.and_then(|rows| rows.first()) {
        if nonempty_string(first, "code").is_some() || nonempty_string(first, "message").is_some() {
            return failed_task_error(task, None);
        }
    }
    asr_error(
        "ASR_RESULT_MISSING",
        "百炼任务成功但没有返回结果地址。",
        Some(task_error_detail(task, None)),
    )
}

/// 转写主入口：上传 → 提交 → 轮询 → 下载结果。
pub(crate) fn transcribe_file(
    path: &Path,
    progress: Progress,
    cancel: &Arc<AtomicBool>,
    config: &AsrConfig,
) -> Result<TranscriptionResult, AppError> {
    let key = load_api_key(None)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15 * 60))
        .build()
        .map_err(network_error)?;
    let oss_url = upload_audio(&client, &key, path, progress, config)?;
    let task_id = submit_transcription(&client, &key, &oss_url, config)?;
    let mut task = poll_transcription(&client, &key, &task_id, progress, cancel, config)?;
    // 任务标记成功后结果地址偶尔滞后一步：补拉几次再判缺失。
    let mut retries = 3u8;
    let transcription_url = loop {
        if let Some(url) = transcription_url(&task) {
            break url.to_owned();
        }
        if retries == 0 {
            return Err(missing_url_error(&task));
        }
        retries -= 1;
        std::thread::sleep(POLL_INTERVAL);
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        task = query_task(&client, &key, &task_id, config)?;
        task_finished(&task, &task_id)?;
    };
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

    #[test]
    fn general_config_defaults_and_custom_values() {
        for settings in [
            json!({}),
            json!({"meeting": {"asr_base_url": " ", "asr_model": ""}}),
        ] {
            let config = AsrConfig::from_settings(&settings).unwrap();
            assert_eq!(config.base_url, DEFAULT_BASE_URL);
            assert_eq!(config.model, DEFAULT_MODEL);
        }
        let config = AsrConfig::from_settings(&json!({"meeting": {
            "asr_base_url": " https://example.cn/proxy/// ", "asr_model": " custom-file-model ",
            "plan_base_url": "https://other.cn", "plan_model": "other-model"
        }}))
        .unwrap();
        assert_eq!(config.base_url, "https://example.cn/proxy");
        assert_eq!(config.model, "custom-file-model");
        for address in [
            "bad",
            "file:///c:/audio",
            "wss://example.cn",
            "https://u:p@example.cn",
            "https://example.cn?key=hidden",
            "https://example.cn/#hidden",
        ] {
            let error = AsrConfig::new(Some(address), None).unwrap_err();
            assert_eq!(error.code, "ASR_URL_INVALID");
            assert!(error.detail.is_none());
        }
    }

    #[test]
    fn custom_config_is_used_for_connection_policy_submission_and_polling() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..4 {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(std::time::Instant::now() < deadline, "未收到预期的本地请求");
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&mut socket);
                let mut first_line = String::new();
                reader.read_line(&mut first_line).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let response = if first_line.contains("/uploads?") {
                    json!({"data": {"upload_host": "http://127.0.0.1", "upload_dir": "tmp", "oss_access_key_id": "test", "policy": "test", "signature": "test"}})
                } else if first_line.contains("/transcription ") {
                    json!({"output": {"task_id": "test-task"}})
                } else {
                    json!({"output": {"task_status": "SUCCEEDED"}})
                }.to_string();
                requests.push((first_line.trim().to_owned(), body));
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
            requests
        });
        let config = AsrConfig::new(
            Some(&format!("http://{address}/proxy/")),
            Some("custom-file-model"),
        )
        .unwrap();
        assert_eq!(
            test_connection(Some("test-only-key"), &config).unwrap()["ok"],
            true
        );
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        get_policy(&client, "test-only-key", &config).unwrap();
        let task_id =
            submit_transcription(&client, "test-only-key", "oss://test.wav", &config).unwrap();
        let task = poll_transcription(
            &client,
            "test-only-key",
            &task_id,
            &|_, _, _, _| {},
            &Arc::new(AtomicBool::new(false)),
            &config,
        )
        .unwrap();
        assert_eq!(task["output"]["task_status"], "SUCCEEDED");
        let requests = server.join().unwrap();
        for request in &requests[..2] {
            assert!(request.0.starts_with("GET /proxy/api/v1/uploads?"));
            assert!(request.0.contains("model=custom-file-model"));
        }
        assert_eq!(
            requests[2].0,
            "POST /proxy/api/v1/services/audio/asr/transcription HTTP/1.1"
        );
        assert_eq!(requests[2].1["model"], "custom-file-model");
        assert_eq!(requests[2].1["input"]["file_urls"][0], "oss://test.wav");
        assert_eq!(requests[2].1["parameters"]["diarization_enabled"], true);
        assert!(requests[2].1["parameters"].get("language_hints").is_none());
        assert_eq!(requests[3].0, "POST /proxy/api/v1/tasks/test-task HTTP/1.1");
    }

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

    #[test]
    fn http_success_extracts_nested_result_url() {
        // HTTP 查询接口的完整信封；此前测试只造顶层 results，漏掉真实契约。
        let task = json!({"request_id": "request", "output": {
            "task_status": "SUCCEEDED", "results": [{
                "subtask_status": "SUCCEEDED", "transcription_url": "https://example.com/result.json"
            }]
        }});
        assert_eq!(
            transcription_url(&task),
            Some("https://example.com/result.json")
        );
        let flat = json!({"results": [{"transcription_url": "https://example.com/flat.json"}]});
        assert_eq!(
            transcription_url(&flat),
            Some("https://example.com/flat.json")
        );
        assert_eq!(
            transcription_url(&json!({"output": {"results": [{"transcription_url": " "}]}})),
            None
        );
    }

    #[test]
    fn missing_results_field_does_not_claim_silent_recording() {
        let error = missing_url_error(&json!({"output": {"task_status": "SUCCEEDED"}}));
        assert_eq!(error.code, "ASR_RESULT_MISSING");
        assert!(!error.user_message.contains("无人说话"));
    }

    #[test]
    fn missing_url_error_explains_empty_results() {
        let task: Value =
            serde_json::from_str(r#"{"output": {"task_status": "SUCCEEDED", "results": []}}"#)
                .unwrap();
        let error = missing_url_error(&task);
        assert_eq!(error.code, "ASR_RESULT_MISSING");
        assert!(error.user_message.contains("原录音已保留"));
    }

    #[test]
    fn missing_url_error_surfaces_per_file_failure() {
        let task: Value = serde_json::from_str(
            r#"{"output": {"task_status": "SUCCEEDED", "results": [
                {"code": "AUDIO_FILE_INVALID", "message": "audio too short"}
            ]}}"#,
        )
        .unwrap();
        let error = missing_url_error(&task);
        assert_eq!(error.code, "ASR_TASK_FAILED");
        let detail = error.detail.clone().unwrap_or_default();
        assert!(detail.contains("AUDIO_FILE_INVALID"));
        assert!(detail.contains("audio too short"));
    }

    #[test]
    fn missing_url_error_keeps_generic_fallback() {
        let task: Value = serde_json::from_str(
            r#"{"output": {"task_status": "SUCCEEDED"}, "results": [{"other": 1}]}"#,
        )
        .unwrap();
        let error = missing_url_error(&task);
        assert_eq!(error.code, "ASR_RESULT_MISSING");
    }

    #[test]
    fn failed_task_keeps_top_level_reason_and_tracking_ids() {
        let task = json!({
            "request_id": "request-123", "code": "InvalidApiKey", "message": "Invalid API-key",
            "output": {"task_id": "task-123", "task_status": "FAILED", "message": " "}
        });
        let error = task_finished(&task, "fallback-task").unwrap_err();
        assert_eq!(error.code, "ASR_TASK_FAILED");
        let detail = error.detail.unwrap();
        for expected in [
            "InvalidApiKey",
            "Invalid API-key",
            "task-123",
            "request-123",
            "FAILED",
        ] {
            assert!(detail.contains(expected), "缺少 {expected}：{detail}");
        }
    }

    #[test]
    fn no_valid_fragment_explains_provider_vad_without_claiming_recording_is_silent() {
        let code = "SUCCESS_WITH_NO_VALID_FRAGMENT";
        for task in [
            json!({"code": code, "message": code, "output": {"task_status": "FAILED"}, "request_id": "request-vad"}),
            json!({"output": {"task_status": "FAILED", "code": code, "message": code}}),
            json!({"output": {"task_status": "SUCCEEDED", "results": [{"subtask_status": "FAILED", "code": code, "message": code}]}}),
        ] {
            let error = task_finished(&task, "task-vad").unwrap_err();
            assert_eq!(error.code, "ASR_EMPTY_TRANSCRIPT");
            assert!(error.user_message.contains("百炼未检测到有效语音"));
            assert!(error.user_message.contains("若有清晰讲话"));
            let detail = error.detail.unwrap();
            assert_eq!(detail.matches(code).count(), 1, "不应重复输出相同错误码");
            assert!(detail.contains("task-vad"));
        }
    }

    #[test]
    fn failed_task_keeps_nested_and_file_reasons_without_urls() {
        let task = json!({"output": {
            "task_status": "FAILED", "code": "TaskFailed", "message": "转写服务异常",
            "results": [{"subtask_status": "FAILED", "code": "InvalidFile.DownloadFailed",
                "message": "The audio file cannot be downloaded.",
                "file_url": "oss://private-file", "transcription_url": "https://example.com/?Signature=secret"}]
        }});
        let error = task_finished(&task, "submitted-task").unwrap_err();
        let detail = error.detail.unwrap();
        assert!(detail.contains("转写服务异常"));
        assert!(detail.contains("InvalidFile.DownloadFailed"));
        assert!(detail.contains("submitted-task"));
        assert!(!detail.contains("private-file"));
        assert!(!detail.contains("secret"));
    }

    #[test]
    fn successful_task_with_failed_file_is_not_retried_as_missing_url() {
        let task = json!({"task_id": "flat-task", "task_status": "SUCCEEDED", "results": [{
            "subtask_status": "FAILED", "code": "InvalidFile.AudioFormatError", "message": "Invalid audio format"
        }]});
        let error = task_finished(&task, "flat-task").unwrap_err();
        assert_eq!(error.code, "ASR_TASK_FAILED");
        assert!(
            error
                .detail
                .unwrap()
                .contains("InvalidFile.AudioFormatError")
        );
    }

    #[test]
    fn failed_task_without_reason_still_has_tracking_context() {
        for status in ["FAILED", "CANCELED", "CANCELLED"] {
            let error =
                task_finished(&json!({"output": {"task_status": status}}), "task-123").unwrap_err();
            let detail = error.detail.unwrap();
            assert!(detail.contains("服务端未返回具体失败原因"));
            assert!(detail.contains("task-123"));
            assert!(detail.contains(status));
        }
    }

    #[test]
    fn task_status_checks_waiting_success_and_invalid_responses() {
        for status in ["PENDING", "RUNNING"] {
            assert!(!task_finished(&json!({"output": {"task_status": status}}), "id").unwrap());
        }
        assert!(task_finished(&json!({"task_status": "SUCCEEDED"}), "id").unwrap());
        let error = task_finished(
            &json!({"request_id": "req", "code": "AccessDenied", "message": "No permission"}),
            "id",
        )
        .unwrap_err();
        assert_eq!(error.code, "ASR_TASK_FAILED");
        assert!(error.detail.unwrap().contains("AccessDenied"));
        for task in [json!({}), json!({"output": {"task_status": "UNKNOWN"}})] {
            assert_eq!(
                task_finished(&task, "id").unwrap_err().code,
                "ASR_RESPONSE_INVALID"
            );
        }
    }

    #[test]
    fn http_error_keeps_provider_code_and_request_id() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 2048];
            socket.read(&mut request).unwrap();
            let body = r#"{"code":"Throttling","message":"Rate limit exceeded","request_id":"request-http"}"#;
            write!(socket, "HTTP/1.1 429 Too Many Requests\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .unwrap();
        let error = read_json_response(response, "查询百炼转写任务失败。").unwrap_err();
        server.join().unwrap();
        assert_eq!(error.code, "ASR_REQUEST_FAILED");
        let detail = error.detail.unwrap();
        for expected in ["429", "Throttling", "Rate limit exceeded", "request-http"] {
            assert!(detail.contains(expected));
        }
    }
}
