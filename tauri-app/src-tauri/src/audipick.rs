use reqwest::blocking::Client;
use rust_xlsxwriter::{Format, FormatAlign, FormatBorder, Workbook};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

use crate::AppError;

pub fn call(method: &str, params: Value, settings: Value) -> Result<Value, AppError> {
    match method {
        "audipick.config_status" => config_status(&settings),
        "audipick.extract" | "audipick.classify" => llm_text(&params, &settings),
        "audipick.ocr" => ocr(&params, &settings),
        "audipick.export" => export_workpaper(&params),
        _ => Err(error(
            "METHOD_NOT_ALLOWED",
            "不允许调用该 AudiPick 接口。",
            None,
        )),
    }
}

pub fn run_batch(
    params: Value,
    progress: &dyn Fn(&str, usize, usize, &str),
    cancel: Arc<AtomicBool>,
    pause_path: &Path,
) -> Result<Value, AppError> {
    let settings = params.get("__settings").cloned().unwrap_or(json!({}));
    let prompt = params
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let rule_id = params
        .get("ruleId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let documents = params
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if prompt.is_empty() || documents.is_empty() {
        return Err(error(
            "AUDIPICK_BATCH_INVALID",
            "请选择合同并确认提取模板。",
            None,
        ));
    }
    let queue = Arc::new(Mutex::new(VecDeque::from(documents)));
    let (sender, receiver) = mpsc::channel::<Value>();
    let total = queue.lock().map(|rows| rows.len()).unwrap_or(0);
    let pause = pause_path.to_path_buf();
    thread::scope(|scope| {
        for _ in 0..3.min(total) {
            let queue = queue.clone();
            let sender = sender.clone();
            let cancel = cancel.clone();
            let settings = settings.clone();
            let prompt = prompt.clone();
            let pause = pause.clone();
            scope.spawn(move || loop {
                while pause.exists() && !cancel.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(150));
                }
                if cancel.load(Ordering::Relaxed) { break; }
                let document = queue.lock().ok().and_then(|mut rows| rows.pop_front());
                let Some(document) = document else { break; };
                let id = document.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                let name = document.get("name").and_then(Value::as_str).unwrap_or(&id).to_owned();
                let path = document.get("textPath").and_then(Value::as_str).unwrap_or("");
                let result = match fs::read_to_string(path) {
                    Ok(text) if !text.trim().is_empty() => match request_llm(&settings["llm"], &prompt, &text, None) {
                        Ok(content) => json!({"id":id,"name":name,"ok":true,"content":content,"parsed":parse_json_content(&content)}),
                        Err(err) => json!({"id":id,"name":name,"ok":false,"error":{"code":err.code,"userMessage":err.user_message}}),
                    },
                    _ => json!({"id":id,"name":name,"ok":false,"error":{"code":"AUDIPICK_TEXT_MISSING","userMessage":"请先读取并保存合同文字。"}}),
                };
                let _ = sender.send(result);
            });
        }
        drop(sender);
        let mut completed = Vec::new();
        while completed.len() < total {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(150)) {
                Ok(result) => {
                    completed.push(result);
                    progress("extract", completed.len(), total, "正在批量提取合同");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(error("JOB_CANCELLED", "任务已取消。", None));
        }
        Ok(
            json!({"ruleId":rule_id,"documents":completed,"completed":completed.len(),"total":total,"outputPaths":[]}),
        )
    })
}

fn export_workpaper(params: &Value) -> Result<Value, AppError> {
    let mut output = PathBuf::from(
        params
            .get("outputPath")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if output.as_os_str().is_empty() {
        return Err(error("OUTPUT_REQUIRED", "请选择底稿输出文件。", None));
    }
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("xlsx"))
        != Some(true)
    {
        output.set_extension("xlsx");
    }
    let rows = params
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let rule_id = params.get("ruleId").and_then(Value::as_str).unwrap_or("");
    let mut workbook = Workbook::new();
    let header = Format::new()
        .set_bold()
        .set_border(FormatBorder::Thin)
        .set_align(FormatAlign::Center)
        .set_background_color("#DCE6F1");
    if rule_id == "revenue_workpaper" {
        let intro = workbook.add_worksheet();
        intro.set_name("使用说明").map_err(xlsx_error)?;
        intro
            .write_string_with_format(0, 0, "收入合同审阅底稿填列清单", &header)
            .map_err(xlsx_error)?;
        intro
            .write_string(
                1,
                0,
                "本清单由 AudiPick 根据合同及补充资料生成，所有结论须由项目组人工复核。",
            )
            .map_err(xlsx_error)?;
        intro.set_column_width(0, 100).map_err(xlsx_error)?;
    }
    let sheet = workbook.add_worksheet();
    sheet
        .set_name(if rule_id == "revenue_workpaper" {
            "底稿填列清单"
        } else {
            "提取结果"
        })
        .map_err(xlsx_error)?;
    // The caller may dictate the column order.  The revenue checklist has to
    // keep the legacy layout — 工作表名称 / 底稿行号 / 回答目标单元格 … — because
    // that mapping is what makes the export transcribable back into the real
    // workpaper.  Sorting the raw keys alphabetically loses it.
    let requested = params
        .get("columns")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());
    let columns: Vec<String> = requested.unwrap_or_else(|| {
        let mut keys = BTreeSet::new();
        for row in &rows {
            if let Some(object) = row.as_object() {
                for key in object.keys() {
                    if !matches!(key.as_str(), "id" | "contractId" | "fieldSetId") {
                        keys.insert(key.clone());
                    }
                }
            }
        }
        keys.into_iter().collect()
    });
    const WIDE_COLUMNS: &[&str] = &[
        "excerpt",
        "reason",
        "question",
        "问题描述",
        "建议回答",
        "合同依据",
        "意见",
        "合同条款摘录",
        "支持证据描述",
        "SOP定位",
    ];
    for (column, key) in columns.iter().enumerate() {
        sheet
            .write_string_with_format(0, column as u16, key, &header)
            .map_err(xlsx_error)?;
        sheet
            .set_column_width(
                column as u16,
                if WIDE_COLUMNS.iter().any(|needle| key.contains(needle)) {
                    60
                } else {
                    22
                },
            )
            .map_err(xlsx_error)?;
    }
    for (row_index, row) in rows.iter().enumerate() {
        for (column, key) in columns.iter().enumerate() {
            let value = row.get(key).cloned().unwrap_or(Value::Null);
            let text = match value {
                Value::Null => String::new(),
                Value::String(value) => value,
                other => other.to_string(),
            };
            sheet
                .write_string((row_index + 1) as u32, column as u16, &text)
                .map_err(xlsx_error)?;
        }
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    if !columns.is_empty() {
        sheet
            .autofilter(
                0,
                0,
                rows.len() as u32,
                columns.len().saturating_sub(1) as u16,
            )
            .map_err(xlsx_error)?;
    }
    workbook.save(&output).map_err(xlsx_error)?;
    Ok(json!({"outputPaths":[output.to_string_lossy()],"rows":rows.len(),"ruleId":rule_id}))
}

fn config_status(settings: &Value) -> Result<Value, AppError> {
    let llm = settings.get("llm").cloned().unwrap_or(json!({}));
    let ocr = settings.get("ocr").cloned().unwrap_or(json!({}));
    let api_type = llm
        .get("api_type")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let llm_secret = secret(if api_type == "dify_chat" {
        "dify_api_key"
    } else {
        "llm_api_key"
    });
    let ocr_engine = ocr.get("engine").and_then(Value::as_str).unwrap_or("ai");
    let ocr_ready = match ocr_engine {
        "ai" => llm_secret.is_some(),
        "baidu" => secret("baidu_ocr_key").is_some() && secret("baidu_ocr_secret").is_some(),
        _ => false,
    };
    Ok(json!({
        "llm": {"ready": llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) && llm_secret.is_some(),
                "apiType": api_type, "model": llm.get("model").cloned().unwrap_or(Value::Null)},
        "ocr": {"ready": ocr_ready, "engine": ocr_engine}
    }))
}

fn llm_text(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let prompt = params.get("prompt").and_then(Value::as_str).unwrap_or("");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    if prompt.is_empty() || text.is_empty() {
        return Err(error(
            "AUDIPICK_INPUT_REQUIRED",
            "提取模板和合同文字不能为空。",
            None,
        ));
    }
    let content = request_llm(llm, prompt, text, None)?;
    let parsed = parse_json_content(&content);
    Ok(json!({"content": content, "parsed": parsed}))
}

pub(crate) fn kanzhang_llm_call(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "请先在工具箱设置中配置 LLM。", None))?;
    if !llm.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
        return Err(error("LLM_DISABLED", "工具箱中的 LLM 尚未启用。", None));
    }
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("mapping");
    let payload = params.get("payload").cloned().unwrap_or_else(|| json!({}));
    let prompt = if mode == "analysis" {
        "你是审计看账分析助手。只依据输入的汇总数据，输出严格 JSON：{title:string,sections:[{heading:string,points:[{label:string,text:string}]}],review_notes:[string]}。范围仅限科目发生额、主要对方科目、凭证类型和月度波动；不得虚构凭证、金额或审计结论。"
    } else {
        kanzhang_mapping_prompt()
    };
    let content = request_llm(llm, prompt, &payload.to_string(), None)?;
    let value = parse_json_content(&content);
    if !value.is_object() {
        return Err(error(
            "LLM_RESPONSE_INVALID",
            "LLM 没有返回有效的结构化结果。",
            None,
        ));
    }
    Ok(value)
}

fn kanzhang_mapping_prompt() -> &'static str {
    "你是会计凭证字段映射复核助手。输出严格 JSON：{scheme:\"A\"|\"B\"|\"\",schemeReason:string,fills:[{role:string,suggestedColumn:string,confidence:number,reason:string}],reviews:[{role:string,currentColumn:string,suggestedColumn:string,confidence:number,reason:string}]}。角色仅可为 id/account/entity/date/summary/amount/direction/debit/credit。entity 专指凭证所属的核算主体/记账主体（例如公司代码、公司名称、账套公司、法人实体、business unit、company code），用于区分这笔凭证记在哪个主体；entity 绝不是交易对手方、往来单位、客户、供应商、客商、收付款对象或对方户名。即使交易对手方列包含公司名称或企业名称，也不得映射为 entity；没有明确的核算主体列时应让 entity 保持空缺，不得用对手方字段凑数。方案A=金额列（可加方向）；方案B=借方和贷方两列。只可使用输入 headers 中的原始列名。"
}

fn ocr(params: &Value, settings: &Value) -> Result<Value, AppError> {
    let image = params
        .get("imageBase64")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches("data:image/jpeg;base64,")
        .trim_start_matches("data:image/png;base64,");
    if image.is_empty() {
        return Err(error(
            "OCR_IMAGE_REQUIRED",
            "没有收到需要识别的页面图片。",
            None,
        ));
    }
    let engine = settings
        .get("ocr")
        .and_then(|v| v.get("engine"))
        .and_then(Value::as_str)
        .unwrap_or("ai");
    if engine == "baidu" {
        return baidu_ocr(image);
    }
    if engine != "ai" {
        return Err(error(
            "OCR_ENGINE_UNAVAILABLE",
            "当前仅支持统一 AI 视觉或百度 OCR。",
            None,
        ));
    }
    let llm = settings
        .get("llm")
        .ok_or_else(|| error("LLM_NOT_CONFIGURED", "AI 视觉需要先配置工具箱 LLM。", None))?;
    let content = request_llm(
        llm,
        "请逐字识别图片中的中文和数字，只返回识别文字，不要解释。",
        "",
        Some(image),
    )?;
    Ok(json!({"text": content, "engine": "ai"}))
}

fn request_llm(
    config: &Value,
    prompt: &str,
    text: &str,
    image: Option<&str>,
) -> Result<String, AppError> {
    request_llm_with_key(config, prompt, text, image, None)
}

pub(crate) fn test_llm_connection(
    config: &Value,
    api_key: Option<&str>,
) -> Result<Value, AppError> {
    let started = std::time::Instant::now();
    let content = request_llm_with_key(
        config,
        "这是连接测试。请只回复 OK。",
        "OK",
        None,
        api_key.filter(|value| !value.trim().is_empty()),
    )?;
    if content.trim().is_empty() {
        return Err(error(
            "LLM_EMPTY_RESPONSE",
            "连接成功，但模型返回了空内容。请检查模型名称或服务配置。",
            None,
        ));
    }
    Ok(json!({
        "ok": true,
        "message": "LLM 连接测试成功。",
        "apiType": config.get("api_type").and_then(Value::as_str).unwrap_or("openai"),
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "elapsedMs": started.elapsed().as_millis()
    }))
}

fn request_llm_with_key(
    config: &Value,
    prompt: &str,
    text: &str,
    image: Option<&str>,
    api_key: Option<&str>,
) -> Result<String, AppError> {
    let api_type = config
        .get("api_type")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let base = config
        .get("base_url")
        .and_then(Value::as_str)
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(error(
            "LLM_URL_INVALID",
            "LLM Base URL 必须使用 HTTP 或 HTTPS。",
            None,
        ));
    }
    let timeout = config
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(10, 300);
    let client = Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(network_error)?;
    if api_type == "dify_chat" {
        let key = api_key
            .map(str::to_owned)
            .or_else(|| secret("dify_api_key"))
            .ok_or_else(|| error("LLM_KEY_MISSING", "未找到 Dify API Key。", None))?;
        let url = if base.ends_with("/chat-messages") {
            base.to_string()
        } else {
            format!("{base}/chat-messages")
        };
        let query = format!("{prompt}\n\n{text}");
        let response = client.post(url).bearer_auth(key).json(&json!({"inputs":{},"query":query,"response_mode":"blocking","user":"audit-toolbox"})).send().map_err(network_error)?;
        let value = read_llm_response(response, "Dify 提取请求失败。")?;
        return Ok(value
            .get("answer")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string());
    }
    let key = api_key
        .map(str::to_owned)
        .or_else(|| secret("llm_api_key"))
        .ok_or_else(|| error("LLM_KEY_MISSING", "未找到 LLM API Key。", None))?;
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    let user_content = if let Some(data) = image {
        json!([{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{data}")}}])
    } else {
        Value::String(text.to_string())
    };
    let mut request = client.post(url);
    if config.get("auth_mode").and_then(Value::as_str) == Some("raw") {
        request = request.header("Authorization", key);
    } else {
        request = request.bearer_auth(key);
    }
    // 同 fa.rs：旧版每次调用都关闭思维链、对 DeepSeek 打开 JSON 输出模式，
    // 迁移时两个参数都漏了。
    let mut body = json!({
        "model": config.get("model").and_then(Value::as_str).unwrap_or(""),
        "temperature": 0,
        "messages": [{"role":"system","content":prompt},{"role":"user","content":user_content}],
        "thinking": {"type": if thinking_enabled(config) { "enabled" } else { "disabled" }},
    });
    if wants_json_response(base) {
        body["response_format"] = json!({"type": "json_object"});
    }
    let response = request.json(&body).send().map_err(network_error)?;
    let value = read_llm_response(response, "LLM 提取请求失败。")?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("");
    if content.trim().is_empty() {
        return Err(empty_content_error(&value));
    }
    Ok(content.to_string())
}

/// Error for a response whose assistant message carried no text.
///
/// An empty body used to fall through as `""`, parse into zero items and reach
/// the user as "extracted 0 rows" — indistinguishable from a contract that
/// genuinely says nothing.  The usual causes are the model spending its output
/// budget on reasoning tokens or hitting the length limit, so name them.
fn empty_content_error(value: &Value) -> AppError {
    let finish = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("");
    let reasoning = value
        .pointer("/choices/0/message/reasoning_content")
        .and_then(Value::as_str)
        .map(str::len)
        .unwrap_or(0);
    let mut detail = Vec::new();
    if !finish.is_empty() {
        detail.push(format!("finish_reason={finish}"));
    }
    if reasoning > 0 {
        detail.push(format!("思维内容{reasoning}字"));
    }
    if finish == "length" {
        detail.push("输出额度已用尽".into());
    }
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("（{}）", detail.join("，"))
    };
    error(
        "EMPTY_ASSISTANT_CONTENT",
        &format!(
            "模型返回正文为空{suffix}。程序已请求关闭思维模式，但当前模型或接口可能未执行；\
             请改用较短的资料重试，或在设置中更换模型。"
        ),
        None,
    )
}

fn baidu_ocr(image: &str) -> Result<Value, AppError> {
    let ak = secret("baidu_ocr_key")
        .ok_or_else(|| error("OCR_KEY_MISSING", "未找到百度 OCR API Key。", None))?;
    let sk = secret("baidu_ocr_secret")
        .ok_or_else(|| error("OCR_KEY_MISSING", "未找到百度 OCR Secret Key。", None))?;
    let client = Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(network_error)?;
    let token: Value = client
        .post("https://aip.baidubce.com/oauth/2.0/token")
        .query(&[
            ("grant_type", "client_credentials"),
            ("client_id", ak.as_str()),
            ("client_secret", sk.as_str()),
        ])
        .send()
        .map_err(network_error)?
        .json()
        .map_err(network_error)?;
    let access = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            error(
                "OCR_TOKEN_FAILED",
                "百度 OCR 鉴权失败。",
                Some(safe_error(&token)),
            )
        })?;
    let value: Value = client
        .post("https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic")
        .query(&[("access_token", access)])
        .form(&[("image", image), ("paragraph", "true")])
        .send()
        .map_err(network_error)?
        .json()
        .map_err(network_error)?;
    if value.get("error_code").is_some() {
        return Err(error(
            "OCR_REQUEST_FAILED",
            "百度 OCR 识别失败。",
            Some(safe_error(&value)),
        ));
    }
    let text = value
        .get("words_result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("words").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(json!({"text":text,"engine":"baidu"}))
}

fn secret(name: &str) -> Option<String> {
    keyring::Entry::new("AuditToolbox", name)
        .ok()?
        .get_password()
        .ok()
        .filter(|value| !value.is_empty())
}
fn parse_json_content(content: &str) -> Value {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).unwrap_or_else(|_| json!({"items":[],"raw":content}))
}
fn safe_error(value: &Value) -> String {
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .unwrap_or("远程服务返回错误")
        .chars()
        .take(300)
        .collect()
}
/// 见 `fa.rs` 同名函数：结构化任务默认关闭思维链。
fn thinking_enabled(config: &Value) -> bool {
    config
        .get("thinking_enabled")
        .or_else(|| config.get("thinkingEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn wants_json_response(base: &str) -> bool {
    base.to_ascii_lowercase().contains("api.deepseek.com")
}

fn body_snippet(body: &str) -> String {
    let text: String = body.trim().chars().take(300).collect();
    if text.is_empty() {
        "响应体为空".into()
    } else {
        text
    }
}

/// 先取文本，再判状态，最后解析 JSON——理由同 `fa.rs` 的同名函数：
/// 直接 `.json()` 会把网关的 HTML 错误页和被截断的响应都变成
/// "error decoding response body"，真正的服务端信息全部丢失。
fn read_llm_response(
    response: reqwest::blocking::Response,
    label: &str,
) -> Result<Value, AppError> {
    let status = response.status();
    let body = response.text().map_err(network_error)?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&body)
            .as_ref()
            .map(safe_error)
            .unwrap_or_else(|_| body_snippet(&body));
        return Err(error(
            "LLM_REQUEST_FAILED",
            label,
            Some(format!("HTTP {status}：{detail}")),
        ));
    }
    serde_json::from_str(&body).map_err(|e| {
        error(
            "LLM_RESPONSE_INVALID",
            "LLM 返回的内容不是有效 JSON，可能被网关、代理或安全设备改写。",
            Some(format!("{e}；响应开头：{}", body_snippet(&body))),
        )
    })
}

fn network_error(error: impl std::fmt::Display) -> AppError {
    self::error(
        "NETWORK_ERROR",
        "网络请求失败，请检查地址、代理和网络连接。",
        Some(error.to_string()),
    )
}
fn xlsx_error(error: impl std::fmt::Display) -> AppError {
    self::error(
        "AUDIPICK_EXPORT_FAILED",
        "AudiPick 底稿导出失败。",
        Some(error.to_string()),
    )
}
fn error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    /// An empty assistant message must surface as an error rather than as a
    /// successful extraction of nothing.
    #[test]
    fn empty_content_names_the_reason() {
        let value = json!({"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"abc"}}]});
        let error = empty_content_error(&value);
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains("EMPTY_ASSISTANT_CONTENT"), "{text}");
        assert!(text.contains("finish_reason=length"), "{text}");
        assert!(text.contains("输出额度已用尽"), "{text}");
    }

    #[test]
    fn empty_content_without_diagnostics_still_explains_itself() {
        let error = empty_content_error(&json!({"choices":[{"message":{"content":""}}]}));
        let text = serde_json::to_string(&error).unwrap();
        assert!(text.contains("模型返回正文为空"), "{text}");
    }

    #[test]
    fn parses_fenced_json() {
        assert_eq!(
            parse_json_content("```json\n{\"items\":[{\"a\":1}]}\n```")["items"][0]["a"],
            1
        );
    }
    #[test]
    fn kanzhang_entity_prompt_means_accounting_entity_not_counterparty() {
        let prompt = kanzhang_mapping_prompt();
        assert!(prompt.contains("核算主体/记账主体"), "{prompt}");
        assert!(prompt.contains("绝不是交易对手方"), "{prompt}");
        assert!(prompt.contains("客户"), "{prompt}");
        assert!(prompt.contains("供应商"), "{prompt}");
        assert!(prompt.contains("保持空缺"), "{prompt}");
    }
    #[test]
    fn rejects_missing_ocr_image() {
        assert_eq!(
            ocr(&json!({}), &json!({})).unwrap_err().code,
            "OCR_IMAGE_REQUIRED"
        );
    }
    #[test]
    fn llm_connection_test_validates_url_before_network() {
        let error = test_llm_connection(
            &json!({
                "api_type": "openai",
                "base_url": "ftp://invalid.example",
                "model": "test-model",
                "timeout": 10
            }),
            Some("temporary-test-key"),
        )
        .unwrap_err();
        assert_eq!(error.code, "LLM_URL_INVALID");
    }
    #[test]
    fn batch_keeps_per_document_failures() {
        let cancel = Arc::new(AtomicBool::new(false));
        let result = run_batch(
            json!({
                "__settings":{"llm":{"enabled":false}},
                "prompt":"【字段定义】\npage: 页码",
                "ruleId":"loan_covenant",
                "documents":[{"id":"d1","name":"missing.pdf","textPath":"Z:/definitely-missing-audipick.txt"}]
            }),
            &|_, _, _, _| {},
            cancel,
            Path::new("Z:/definitely-missing-audipick.pause"),
        ).unwrap();
        assert_eq!(result["completed"], 1);
        assert_eq!(result["documents"][0]["ok"], false);
        assert_eq!(
            result["documents"][0]["error"]["code"],
            "AUDIPICK_TEXT_MISSING"
        );
    }
}
