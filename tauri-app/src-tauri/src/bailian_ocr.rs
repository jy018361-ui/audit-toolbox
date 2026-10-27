//! 百炼 OCR 独立配置；测试和页面 worker 共用相同请求协议。
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::blocking::Client;
use serde_json::{Value, json};
use std::time::Duration;

use crate::AppError;

const DEFAULT_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL: &str = "qwen3.5-ocr";
pub(crate) const STRUCTURED_PROMPT: &str = "请逐字识别整张扫描件的全部文字，保留阅读顺序、段落及全部表格内容。同时逐格恢复所有表格的原始行列。不要总结、补写、改写数字、日期、账号或金额，所有单元格均为字符串。合并单元格仅在左上格写文字，其余空串。text 必须含正文和全部表格文字，不能因 tables 已有而省略。仅输出完整 JSON：{\"text\":\"完整原文\",\"tables\":[{\"title\":\"原表名\",\"rows\":[[\"单元格\"]]}],\"warnings\":[\"无法确认的内容及位置\"]}。无表格返回空 tables。";

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
        self.recognize_with_prompt(image, key, "请逐字识别图片中的中文和数字，保留段落、表格内容和阅读顺序，只返回识别文字，不要解释、总结或补写。")
    }

    pub(crate) fn recognize_structured(&self, image: &str, key: &str) -> Result<Value, AppError> {
        self.recognize_with_prompt(image, key, STRUCTURED_PROMPT)
    }

    fn recognize_with_prompt(&self, image: &str, key: &str, prompt: &str) -> Result<Value, AppError> {
        if key.trim().is_empty() {
            return Err(failure(
                "OCR_KEY_MISSING",
                "请填写百炼 OCR API Key。",
                false,
            ));
        }
        let image_url = image_data_url(image)?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| failure("BAILIAN_OCR_NETWORK", "无法建立百炼 OCR 连接。", true))?;
        let response = client.post(self.endpoint.clone()).bearer_auth(key.trim()).json(&json!({
            "model": self.model,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": image_url}},
                {"type": "text", "text": prompt}
            ]}],
            "stream": false
        })).send().map_err(|_| failure("BAILIAN_OCR_NETWORK", "百炼 OCR 请求未完成，请检查网络和 URL 后重试。", true))?;
        let status = response.status();
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
        let value: Value = response.json().map_err(|_| {
            failure(
                "BAILIAN_OCR_RESPONSE_INVALID",
                "百炼 OCR 返回内容不是有效 JSON。",
                true,
            )
        })?;
        if value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            == Some("length")
        {
            return Err(failure(
                "BAILIAN_OCR_TRUNCATED",
                "百炼 OCR 识别结果被截断，该页未保存为完成，请拆分页面后重试。",
                false,
            ));
        }
        let text = value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                failure(
                    "BAILIAN_OCR_EMPTY",
                    "百炼 OCR 未返回识别文字，该页未保存为完成。",
                    true,
                )
            })?;
        Ok(json!({"text": text, "engine": "bailian"}))
    }
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
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
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
    fn standalone_structured_mode_is_one_request_with_complete_text_and_cells() {
        let output=json!({"text":"发票 00123","tables":[{"title":"明细","rows":[["金额","00123"]]}],"warnings":[]}).to_string();
        let (base,server)=server("200 OK",json!({"choices":[{"finish_reason":"stop","message":{"content":output}}]}));
        let config=OcrConfig::from_settings(&json!({"ocr":{"bailian_base_url":base}})).unwrap();
        let result=config.recognize_structured(PNG,"synthetic-key").unwrap();
        let parsed:Value=serde_json::from_str(result["text"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["tables"][0]["rows"][0][1],"00123");
        let request=server.join().unwrap();
        let body:Value=serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["messages"][0]["content"][1]["text"],STRUCTURED_PROMPT);
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
}
