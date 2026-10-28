//! 百炼 OCR 独立配置；测试和页面 worker 共用相同请求协议。
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

use crate::AppError;
#[path = "ocr_content.rs"]
mod ocr_content;
pub(crate) use ocr_content::{has_latex_layout, has_markdown_heading, looks_like_ocr_payload, readable_ocr_content, readable_ocr_text};

const DEFAULT_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL: &str = "qwen3.5-ocr";
pub(crate) const STRUCTURED_PROMPT: &str = "请逐字识别整张扫描件的全部文字，保留阅读顺序、段落及全部表格内容。同时逐格恢复所有表格的原始行列。不要总结、补写、改写数字、日期、账号或金额，所有单元格均为字符串。合并单元格仅在左上格写文字，其余空串。text 必须含正文和全部表格文字，不能因 tables 已有而省略。仅输出完整 JSON：{\"text\":\"完整原文\",\"tables\":[{\"title\":\"原表名\",\"rows\":[[\"单元格\"]]}],\"warnings\":[\"无法确认的内容及位置\"]}。无表格返回空 tables。";
// Compatibility gateways keep the provider's basic text task. On the official
// Qwen3.5 service, use its native document parser rather than prompting the
// basic task to emulate a layout parser (which omitted cover text in testing).
const TEXT_PROMPT: &str = "Please output only the text content from the image without any additional descriptions or formatting.";

pub(crate) struct OcrConfig {
    endpoint: reqwest::Url,
    model: String,
}

fn failure(code: &str, message: &str, retryable: bool) -> AppError {
    AppError::new(code, message, retryable, None)
}

impl OcrConfig {
    pub(crate) fn from_settings(settings: &Value) -> Result<Self, AppError> {
        let base = settings
            .pointer("/ocr/bailian_base_url")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(DEFAULT_BASE_URL)
            .trim_end_matches('/');
        let invalid = || {
            failure(
                "BAILIAN_OCR_URL_INVALID",
                "百炼 OCR URL 格式不正确，请填写 HTTP(S) 兼容接口地址，不能包含账号、密码、查询参数或片段。",
                false,
            )
        };
        let mut endpoint = reqwest::Url::parse(base).map_err(|_| invalid())?;
        if !matches!(endpoint.scheme(), "http" | "https")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(invalid());
        }
        let path = endpoint.path().trim_end_matches('/');
        if !path.ends_with("/chat/completions") {
            endpoint.set_path(&format!("{path}/chat/completions"));
        }
        Ok(Self {
            endpoint,
            model: settings
                .pointer("/ocr/bailian_model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_owned(),
        })
    }

    pub(crate) fn recognize(&self, image: &str, key: &str) -> Result<Value, AppError> {
        self.recognize_with_prompt(image, key, TEXT_PROMPT)
    }

    pub(crate) fn recognize_structured(&self, image: &str, key: &str) -> Result<Value, AppError> {
        match native_document_endpoint(&self.endpoint, &self.model) {
            Some(endpoint) => self.request(image, key, &endpoint, None),
            None => self.recognize(image, key),
        }
    }

    fn recognize_with_prompt(&self, image: &str, key: &str, prompt: &str) -> Result<Value, AppError> {
        self.request(image, key, &self.endpoint, Some(prompt))
    }

    fn request(&self, image: &str, key: &str, endpoint: &reqwest::Url, prompt: Option<&str>) -> Result<Value, AppError> {
        if key.trim().is_empty() {
            return Err(failure(
                "OCR_KEY_MISSING",
                "请填写百炼 OCR API Key。",
                false,
            ));
        }
        let prepared = Instant::now();
        let image_url = image_data_url(image)?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| failure("BAILIAN_OCR_NETWORK", "无法建立百炼 OCR 连接。", true))?;
        let payload = if let Some(prompt) = prompt { json!({
            "model": self.model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_url}},
                {"type": "text", "text": prompt}
            ]}],
            "stream": false
        }) } else { json!({
            "model": self.model,
            "input": {"messages": [{"role": "user", "content": [{
                "image": image_url, "min_pixels": 3072, "max_pixels": 8388608,
                // The worker already corrected cardinal direction locally.
                "enable_rotate": false
            }]}]},
            "parameters": {"ocr_options": {"task": "document_parsing"}}
        }) };
        let body = serde_json::to_vec(&payload).map_err(|_| failure("BAILIAN_OCR_REQUEST", "无法准备百炼 OCR 请求。", false))?;
        let request_bytes = body.len();
        let request = client.post(endpoint.clone()).bearer_auth(key.trim())
            .header(reqwest::header::CONTENT_TYPE, "application/json").body(body).build()
            .map_err(|_| failure("BAILIAN_OCR_REQUEST", "无法准备百炼 OCR 请求。", false))?;
        let prepare_ms = prepared.elapsed().as_secs_f64() * 1000.0;
        let sent = Instant::now();
        // Blocking reqwest returns after response headers. This interval includes
        // DNS/TCP/TLS, upload and server work; it is NOT pure server processing.
        let response = client.execute(request).map_err(|_| failure("BAILIAN_OCR_NETWORK", "百炼 OCR 请求未完成，请检查网络和 URL 后重试。", true))?;
        let headers_ms = sent.elapsed().as_secs_f64() * 1000.0;
        let status = response.status();
        let request_id = ["x-request-id", "x-dashscope-request-id"].iter()
            .find_map(|name| response.headers().get(*name).and_then(|v| v.to_str().ok()).and_then(safe_request_id));
        if !status.is_success() {
            // 服务端错误可能回显请求、令牌或图片，不附原始响应。
            let (message, retryable) = match status.as_u16() {
                401 => (
                    "百炼 OCR 鉴权失败（401），请检查 API Key 是否有效且属于当前 URL 的业务空间。",
                    false,
                ),
                403 => (
                    "百炼 OCR 无调用权限（403），请检查业务空间、模型权限和 API Key。",
                    false,
                ),
                404 => (
                    "百炼 OCR 接口或模型不存在（404），请检查 URL 和模型名称。",
                    false,
                ),
                429 => (
                    "百炼 OCR 请求受限或额度不足（429），请检查额度后重试。",
                    true,
                ),
                _ => (
                    "百炼 OCR 服务返回错误，请检查 URL、模型、额度及服务状态。",
                    status.is_server_error(),
                ),
            };
            return Err(failure("BAILIAN_OCR_HTTP", message, retryable));
        }
        let received = Instant::now();
        let bytes = response.bytes().map_err(|_| failure("BAILIAN_OCR_NETWORK", "百炼 OCR 响应未接收完整，请重试。", true))?;
        let body_ms = received.elapsed().as_secs_f64() * 1000.0;
        let parsed = Instant::now();
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            failure(
                "BAILIAN_OCR_RESPONSE_INVALID",
                "百炼 OCR 返回内容不是有效 JSON。",
                true,
            )
        })?;
        let parse_ms = parsed.elapsed().as_secs_f64() * 1000.0;
        let choice = if prompt.is_some() { &value["choices"][0] } else { &value["output"]["choices"][0] };
        if choice
            .get("finish_reason")
            .and_then(Value::as_str)
            == Some("length")
        {
            return Err(failure(
                "BAILIAN_OCR_TRUNCATED",
                "百炼 OCR 识别结果被截断，该页未保存为完成，请拆分页面后重试。",
                false,
            ));
        }
        let content = &choice["message"]["content"];
        let text = if prompt.is_some() { content.as_str().map(str::to_owned) } else {
            // `text` contains the provider's assembled document body (including
            // tables). Do not recursively walk layouts/blocks: the native API
            // repeats those structures and would duplicate every paragraph.
            content.as_array().map(|parts| parts.iter().filter_map(|part| part["text"].as_str())
                .filter(|text| !text.trim().is_empty()).collect::<Vec<_>>().join("\n\n"))
        };
        let text = text
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                failure(
                    "BAILIAN_OCR_EMPTY",
                    "百炼 OCR 未返回识别文字，该页未保存为完成。",
                    true,
                )
            })?;
        let request_id = request_id.or_else(|| value["request_id"].as_str().and_then(safe_request_id));
        Ok(json!({"text": text, "engine": "bailian", "httpTiming": {
            "prepareMs": prepare_ms, "headersMs": headers_ms, "bodyMs": body_ms, "parseMs": parse_ms,
            "requestBytes": request_bytes, "responseBytes": bytes.len(), "httpStatus": status.as_u16(),
            "requestId": request_id, "model": self.model, "host": endpoint.host_str().unwrap_or("")
        }}))
    }
}

fn native_document_endpoint(compatible: &reqwest::Url, model: &str) -> Option<reqwest::Url> {
    let host = compatible.host_str()?;
    let official_host = matches!(host, "dashscope.aliyuncs.com" | "dashscope-intl.aliyuncs.com" | "dashscope-us.aliyuncs.com")
        || host.ends_with(".maas.aliyuncs.com");
    if model != "qwen3.5-ocr" || !official_host || compatible.scheme() != "https"
        || compatible.port().is_some() || compatible.path() != "/compatible-mode/v1/chat/completions" {
        return None;
    }
    let mut endpoint = compatible.clone();
    endpoint.set_path("/api/v1/services/aigc/multimodal-generation/generation");
    Some(endpoint)
}

fn safe_request_id(value: &str) -> Option<String> {
    (!value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)))
        .then(|| value.to_owned())
}

fn image_data_url(image: &str) -> Result<String, AppError> {
    let image = image.trim();
    let invalid = || {
        failure(
            "OCR_IMAGE_INVALID",
            "百炼 OCR 图片无效，仅支持 PNG 或 JPEG 页面图片。",
            false,
        )
    };
    let data = if image.starts_with("data:") {
        image
            .strip_prefix("data:image/png;base64,")
            .or_else(|| image.strip_prefix("data:image/jpeg;base64,"))
            .ok_or_else(invalid)?
    } else {
        image
    };
    let bytes = STANDARD.decode(data).map_err(|_| invalid())?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else {
        return Err(invalid());
    };
    Ok(format!("data:{mime};base64,{data}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

    fn server(status: &str, body: Value) -> (String, thread::JoinHandle<String>) {
        delayed_server(status, body, Duration::ZERO, Duration::ZERO)
    }

    fn delayed_server(status: &str, body: Value, headers_delay: Duration, body_delay: Duration) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body = body.to_string();
            thread::sleep(headers_delay);
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nX-Request-Id: synthetic-request-123\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.flush().unwrap();
            thread::sleep(body_delay);
            stream.write_all(body.as_bytes()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        (format!("http://{address}/compatible-mode/v1"), handle)
    }

    #[test]
    fn defaults_url_normalization_and_validation() {
        let config = OcrConfig::from_settings(&json!({})).unwrap();
        assert_eq!(config.model, "qwen3.5-ocr");
        assert_eq!(
            config.endpoint.as_str(),
            format!("{DEFAULT_BASE_URL}/chat/completions")
        );
        for base in [
            "https://example.test/proxy/v1/",
            "https://example.test/proxy/v1/chat/completions",
        ] {
            let config = OcrConfig::from_settings(
                &json!({"ocr":{"bailian_base_url":base,"bailian_model":" custom-ocr "}}),
            )
            .unwrap();
            assert_eq!(
                config.endpoint.as_str(),
                "https://example.test/proxy/v1/chat/completions"
            );
            assert_eq!(config.model, "custom-ocr");
        }
        for base in [
            "invalid",
            "file:///c:/test",
            "https://user:pass@example.test/v1",
            "https://example.test/v1?token=secret",
            "https://example.test/v1#test",
        ] {
            assert!(OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).is_err());
        }
    }

    #[test]
    fn native_document_task_only_uses_known_official_qwen35_routes() {
        for host in ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com", "workspace.cn-beijing.maas.aliyuncs.com"] {
            let url = reqwest::Url::parse(&format!("https://{host}/compatible-mode/v1/chat/completions")).unwrap();
            let native = native_document_endpoint(&url, "qwen3.5-ocr").unwrap();
            assert_eq!(native.host_str(), Some(host));
            assert_eq!(native.path(), "/api/v1/services/aigc/multimodal-generation/generation");
            assert!(native_document_endpoint(&url, "custom-model").is_none());
        }
        for url in ["https://example.test/compatible-mode/v1/chat/completions", "https://dashscope.aliyuncs.com.example.test/compatible-mode/v1/chat/completions",
            "https://dashscope.aliyuncs.com:8443/compatible-mode/v1/chat/completions", "http://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "https://dashscope.aliyuncs.com/proxy/compatible-mode/v1/chat/completions"] {
            assert!(native_document_endpoint(&reqwest::Url::parse(url).unwrap(), "qwen3.5-ocr").is_none());
        }
    }
    #[test]
    fn native_document_parser_preserves_cover_body_and_cells_without_repeating_layouts() {
        let body = "流动资金借款合同\n\n交通银行股份有限公司\n<table><tr><td>账号</td><td>金额</td></tr><tr><td>00123</td><td>6.00</td></tr></table>合同尾页";
        let (base, server) = server("200 OK", json!({"output":{"choices":[{"finish_reason":"stop","message":{"content":[
            {"text":body,"ocr_result":{"layouts":[{"text":"不能再加一遍的正文"}]}}, {"text":"第二内容块"}
        ]}}]},"request_id":"native-test-123"}));
        let config = OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap();
        let native = reqwest::Url::parse(&format!("{base}/native")).unwrap();
        let result = config.request(PNG, "private-api-key", &native, None).unwrap();
        let parsed = readable_ocr_content(result["text"].as_str().unwrap());
        assert!(parsed["text"].as_str().unwrap().contains("流动资金借款合同"));
        assert!(parsed["text"].as_str().unwrap().contains("交通银行股份有限公司"));
        assert!(parsed["text"].as_str().unwrap().contains("合同尾页"));
        assert!(parsed["text"].as_str().unwrap().contains("第二内容块"));
        assert!(!parsed["text"].as_str().unwrap().contains("不能再加一遍"));
        assert_eq!(parsed["tables"][0]["rows"][1], json!(["00123", "6.00"]));
        let request = server.join().unwrap();
        let payload: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(payload["parameters"]["ocr_options"]["task"], "document_parsing");
        assert_eq!(payload["input"]["messages"][0]["content"][0]["image"], format!("data:image/png;base64,{PNG}"));
        assert_eq!(payload["input"]["messages"][0]["content"][0]["enable_rotate"], false);
        assert!(payload.get("messages").is_none());
        assert!(!payload.to_string().contains("private-api-key"));
    }
    #[test]
    fn native_empty_truncated_and_error_responses_are_not_saved_as_success() {
        for (payload, code) in [
            (json!({"output":{"choices":[{"finish_reason":"length","message":{"content":[{"text":"未完成"}]}}]}}), "BAILIAN_OCR_TRUNCATED"),
            (json!({"output":{"choices":[{"finish_reason":"stop","message":{"content":[{"ocr_result":{"layouts":[{"text":"诊断元数据"}]}}]}}]}}), "BAILIAN_OCR_EMPTY"),
            (json!({"code":"Error","message":"private-key or document"}), "BAILIAN_OCR_EMPTY"),
        ] {
            let (base, server) = server("200 OK", payload);
            let config = OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap();
            let error = config.request(PNG, "synthetic-key", &config.endpoint, None).unwrap_err();
            assert_eq!(error.code, code);
            assert!(!error.user_message.contains("private-key"));
            server.join().unwrap();
        }
    }
    #[test]
    fn standalone_structured_mode_is_one_request_with_complete_text_and_cells() {
        let output="合同标题\n\n| 金额 | 账号 |\n| --- | --- |\n| 6.00 | 00123 |\n\n合同尾页";
        let (base,server)=server("200 OK",json!({"choices":[{"finish_reason":"stop","message":{"content":output}}]}));
        let config=OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap();
        let result=config.recognize_structured(PNG,"synthetic-key").unwrap();
        let parsed=readable_ocr_content(result["text"].as_str().unwrap());
        assert_eq!(parsed["tables"][0]["rows"][1][1],"00123");
        assert!(parsed["text"].as_str().unwrap().contains("合同标题"));
        assert!(parsed["text"].as_str().unwrap().contains("合同尾页"));
        let request=server.join().unwrap();
        let body:Value=serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["messages"][0]["content"][1]["text"],TEXT_PROMPT);
    }

    #[test]
    fn http_timing_separates_headers_from_body_without_credentials_or_content() {
        let (base, server) = delayed_server("200 OK", json!({"choices":[{"message":{"content":"私密合同 00123"}}]}),
            Duration::from_millis(140), Duration::from_millis(140));
        let result = OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap()
            .recognize(PNG, "private-api-key").unwrap();
        let request = server.join().unwrap();
        let timing = &result["httpTiming"];
        assert!(timing["headersMs"].as_f64().unwrap() >= 120.0);
        assert!(timing["bodyMs"].as_f64().unwrap() >= 120.0);
        assert!(timing["parseMs"].as_f64().unwrap() >= 0.0);
        assert_eq!(timing["requestBytes"].as_u64().unwrap() as usize, request.split_once("\r\n\r\n").unwrap().1.len());
        assert_eq!(timing["requestId"], "synthetic-request-123");
        assert_eq!(timing["httpStatus"], 200);
        assert_eq!(timing["model"], DEFAULT_MODEL);
        let serialized = timing.to_string();
        for private in ["private-api-key", PNG, "私密合同", "Authorization", "messages"] {
            assert!(!serialized.contains(private));
        }
        assert!(safe_request_id("rejected secret or content").is_none());
        assert!(safe_request_id(&"x".repeat(129)).is_none());
    }

    #[test]
    fn png_and_jpeg_mime_follow_image_bytes() {
        assert_eq!(
            image_data_url(PNG).unwrap(),
            format!("data:image/png;base64,{PNG}")
        );
        assert_eq!(
            image_data_url(&format!("data:image/png;base64,{PNG}")).unwrap(),
            format!("data:image/png;base64,{PNG}")
        );
        let jpeg = STANDARD.encode([0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(
            image_data_url(&jpeg).unwrap(),
            format!("data:image/jpeg;base64,{jpeg}")
        );
        for image in ["", "invalid", "dGVzdA==", "data:text/plain;base64,dGVzdA=="] {
            assert!(image_data_url(image).is_err());
        }
    }

    #[test]
    fn draft_test_uses_independent_url_model_key_and_png() {
        let (base, server) = server(
            "200 OK",
            json!({"choices":[{"finish_reason":"stop","message":{"content":"审计测试 12345"}}]}),
        );
        let result = crate::audipick::test_ocr_connection(
            json!({"llm":{"enabled":false},"ocr":{"engine":"baidu","bailian_base_url":"invalid-saved-url","bailian_model":"saved-model"}}),
            "bailian", PNG, Some("synthetic-draft-key"), None,
            Some(&json!({"bailian_base_url":base,"bailian_model":"qwen3.5-ocr"})),
            false,
        ).unwrap();
        assert!(result["message"].as_str().unwrap().contains("识别成功"));
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /compatible-mode/v1/chat/completions HTTP/1.1"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer synthetic-draft-key")
        );
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["model"], "qwen3.5-ocr");
        assert_eq!(
            body["messages"][0]["content"][0]["image_url"]["url"],
            format!("data:image/png;base64,{PNG}")
        );
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert!(body.get("thinking").is_none());
    }

    #[test]
    fn rejects_failed_empty_and_truncated_recognition_without_leaking_response() {
        for (status, body, code) in [
            (
                "401 Unauthorized",
                json!({"error":{"message":"synthetic-key and private-image"}}),
                "BAILIAN_OCR_HTTP",
            ),
            (
                "200 OK",
                json!({"choices":[{"finish_reason":"length","message":{"content":"partial 12345"}}]}),
                "BAILIAN_OCR_TRUNCATED",
            ),
            (
                "200 OK",
                json!({"choices":[{"message":{"content":" "}}]}),
                "BAILIAN_OCR_EMPTY",
            ),
        ] {
            let (base, server) = server(status, body);
            let config =
                OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap();
            let error = config.recognize(PNG, "synthetic-key").unwrap_err();
            assert_eq!(error.code, code);
            assert!(error.detail.is_none());
            assert!(!error.user_message.contains("synthetic-key"));
            server.join().unwrap();
        }
    }

    #[test]
    fn worker_routes_bailian_independently_of_disabled_llm() {
        let error = crate::audipick::run_ocr_page(
            json!({"imageBase64":PNG,"page":2,"totalPages":3,"__settings":{"llm":{"enabled":false},"ocr":{"engine":"bailian","bailian_base_url":"invalid"}}}),
            &|stage, current, total, _| { assert_eq!((stage, current, total), ("ocr", 1, 3)); },
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            std::path::Path::new("unused-bailian-test.pause"),
        ).unwrap_err();
        assert_eq!(error.code, "BAILIAN_OCR_URL_INVALID");
    }

    /// 仅人工运行；凭据从 stdin 读取，不写文件、不打印请求或密钥。
    #[test]
    #[ignore]
    fn live_connection_from_stdin() {
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let request: Value = serde_json::from_str(&input).expect("测试输入须为 JSON");
        let result = crate::audipick::test_ocr_connection(
            json!({"llm":{"enabled":false}}),
            "bailian",
            request["imageBase64"].as_str().expect("缺少合成测试图片"),
            request["apiKey"].as_str(),
            None,
            Some(&request["ocr"]),
            false,
        )
        .unwrap_or_else(|error| panic!("{}：{}", error.code, error.user_message));
        println!("{}", result);
    }

    /// Manual acceptance only: requires an explicitly authorized document,
    /// selected rendered page paths, and the user's existing Dev OCR credential.
    #[test]
    #[ignore]
    fn live_document_sample_from_stdin() {
        use std::{fs, path::Path, sync::{Arc, atomic::AtomicBool}};
        use crate::{ocr_store::{Store, Page, Table}, excel_merger::PauseCheckpoint};
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let request: Value = serde_json::from_str(&input).expect("需提供明确授权的测试文件参数");
        let output = Path::new(request["outputDir"].as_str().unwrap());
        fs::create_dir_all(output).unwrap();
        let key = keyring::Entry::new("AuditToolboxDev", "bailian_ocr_key")
            .and_then(|entry| entry.get_password()).expect("Dev OCR 密钥未保存");
        let config = OcrConfig::from_settings(&json!({"ocr": request["ocr"]})).unwrap();
        let mut store = Store::open(&output.join("test.sqlite")).unwrap();
        let project = store.save_project(&json!({"name":"合同 OCR 实测"})).unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), Path::new(request["sourcePath"].as_str().unwrap())).unwrap();
        store.prepare(&doc.id, request["totalPages"].as_u64().unwrap() as u32).unwrap();
        let mut summary = vec![];
        for item in request["pages"].as_array().unwrap() {
            let number = item["page"].as_u64().unwrap() as u32;
            let old = store.pages(&doc.id).unwrap().into_iter().find(|p|p.page == number);
            let image = STANDARD.encode(fs::read(item["imagePath"].as_str().unwrap()).unwrap());
            let response = match request["prompt"].as_str() {
                Some(prompt) => config.recognize_with_prompt(&image, &key, prompt),
                None => config.recognize_structured(&image, &key),
            }
                .unwrap_or_else(|error| panic!("第{number}页：{}", error.user_message));
            let raw = response["text"].as_str().unwrap();
            fs::write(output.join(format!("page-{number:02}-response.txt")),raw).unwrap();
            let parsed = readable_ocr_content(raw);
            let text = parsed["text"].as_str().unwrap().to_owned();
            assert!(!text.trim().is_empty(), "第{number}页没有可读原文");
            let tables: Vec<Table> = parsed["tables"].as_array().unwrap().iter().enumerate().map(|(i,t)|{
                let mut t=t.clone();t["id"]=json!(format!("p{number}-t{i}"));serde_json::from_value(t).unwrap()
            }).collect();
            let warnings:Vec<String> = parsed["warnings"].as_array().unwrap().iter().filter_map(Value::as_str).map(str::to_owned).collect();
            summary.push(json!({"page":number,"characters":text.chars().count(),"tables":tables.len(),"warnings":warnings,"httpTiming":response["httpTiming"]}));
            fs::write(output.join(format!("page-{number:02}-parsed.json")),serde_json::to_vec_pretty(&parsed).unwrap()).unwrap();
            let page=Page{metadata:Default::default(),page:number,text,original_text:String::new(),tables,original_tables:vec![],revision:0,status:if warnings.is_empty(){"completed"}else{"needs_review"}.into(),warnings};
            let saved=store.save_page(&doc.id,page,old.map_or(0,|p|p.revision),true).unwrap();
            store.save_recognition_diagnostics(&doc.id,number,saved.revision,&[raw.to_owned()]).unwrap();
            println!("第{number}页实测完成。");
        }
        let pause=PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let exported=crate::ocr_export::export(&store,&json!({"projectId":project["id"],"outputDir":output.to_str().unwrap(),"mode":"combined"}),&|_,_,_,_|{},&pause).unwrap();
        let report=json!({"model":request["ocr"]["bailian_model"],"pages":summary,"export":exported});
        fs::write(output.join("live-report.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("实测及原生导出完成。");
    }
}
