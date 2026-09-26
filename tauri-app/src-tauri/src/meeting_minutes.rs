//! 会议纪要任务：录音（或导入的音频）→ 百炼转写 → LLM 生成结构化纪要。
//!
//! 两条任务通道方法：
//! - `meeting.generate`：从音频文件走完整流水线；
//! - `meeting.summarize`：从已有转写稿重新生成纪要（换档位重出，不再付转写费）。
//!
//! 转写成功而 LLM 失败时任务不判失败：纪要错误放进结果字段 `minutesError`，
//! 转写稿照常落盘，前端可用 `meeting.summarize` 重试。

use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::{AppError, bailian_asr, excel_merger::PauseCheckpoint};

type Progress<'a> = bailian_asr::Progress<'a>;

fn job_error(code: &str, message: &str, detail: Option<String>) -> AppError {
    AppError::new(code, message, true, detail)
}

fn cancelled() -> AppError {
    AppError::new("JOB_CANCELLED", "任务已取消。", true, None)
}

pub(crate) fn run_job(
    method: &str,
    params: Value,
    progress: Progress,
    cancel: Arc<AtomicBool>,
    _pause: &PauseCheckpoint,
) -> Result<Value, AppError> {
    match method {
        "meeting.generate" => generate(&params, progress, &cancel),
        "meeting.summarize" => summarize(&params, progress, &cancel),
        other => Err(job_error(
            "METHOD_NOT_FOUND",
            "未找到会议纪要任务方法。",
            Some(other.into()),
        )),
    }
}

fn string_param(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn participants_param(params: &Value) -> Vec<String> {
    string_param(params, "participants")
        .map(|raw| {
            raw.split(&[',', '，', '、', ';', '；', '\n'][..])
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn detail_param(params: &Value) -> &'static str {
    match string_param(params, "detailLevel").as_deref() {
        Some("brief") => "brief",
        Some("detailed") => "detailed",
        _ => "standard",
    }
}

fn generate(params: &Value, progress: Progress, cancel: &Arc<AtomicBool>) -> Result<Value, AppError> {
    let audio_path = string_param(params, "audioPath").ok_or_else(|| {
        job_error("MEETING_PARAM_MISSING", "缺少录音文件路径。", None)
    })?;
    let audio_path = PathBuf::from(&audio_path);
    if !audio_path.is_file() {
        return Err(job_error(
            "ASR_FILE_MISSING",
            "找不到录音文件，可能已被移动或删除。",
            Some(audio_path.to_string_lossy().into_owned()),
        ));
    }
    let transcription = bailian_asr::transcribe_file(&audio_path, progress, cancel)?;
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let transcript = bailian_asr::transcript_text(&transcription.sentences);
    let title = string_param(params, "title").unwrap_or_else(default_title);
    let stamp = output_stamp();
    let output_dir = output_dir_for(&audio_path, &stamp);
    let transcript_path = output_dir.join(format!("转写稿-{stamp}.txt"));
    fs::create_dir_all(&output_dir).map_err(|e| {
        job_error("MEETING_OUTPUT_DIR_FAILED", "无法创建纪要输出目录。", Some(e.to_string()))
    })?;
    fs::write(&transcript_path, &transcript).map_err(|e| {
        job_error("MEETING_TRANSCRIPT_WRITE_FAILED", "转写稿写入失败。", Some(e.to_string()))
    })?;
    progress("running", 2, 4, "转写完成，正在生成会议纪要…");
    let detail = detail_param(params);
    let participants = participants_param(params);
    let (minutes, minutes_error) = match summarize_with_llm(params, detail, &participants, &title, &transcript) {
        Ok(markdown) => (Some(markdown), None),
        Err(error) => (None, Some(error)),
    };
    finish_output(
        &output_dir,
        &stamp,
        &title,
        &transcript_path,
        minutes,
        minutes_error,
        transcription.speakers,
        transcription.billed_ms,
        Some(&audio_path),
    )
}

fn summarize(params: &Value, progress: Progress, cancel: &Arc<AtomicBool>) -> Result<Value, AppError> {
    let transcript_path = string_param(params, "transcriptPath").ok_or_else(|| {
        job_error("MEETING_PARAM_MISSING", "缺少转写稿路径。", None)
    })?;
    let transcript_path = PathBuf::from(&transcript_path);
    let transcript = fs::read_to_string(&transcript_path).map_err(|e| {
        job_error(
            "MEETING_TRANSCRIPT_READ_FAILED",
            "无法读取转写稿文件。",
            Some(e.to_string()),
        )
    })?;
    if cancel.load(Ordering::Relaxed) {
        return Err(cancelled());
    }
    let title = string_param(params, "title").unwrap_or_else(default_title);
    let stamp = output_stamp();
    let output_dir = output_dir_for(&transcript_path, &stamp);
    let detail = detail_param(params);
    let participants = participants_param(params);
    progress("running", 0, 2, "正在根据转写稿生成会议纪要…");
    let (minutes, minutes_error) = match summarize_with_llm(params, detail, &participants, &title, &transcript) {
        Ok(markdown) => (Some(markdown), None),
        Err(error) => (None, Some(error)),
    };
    finish_output(
        &output_dir,
        &stamp,
        &title,
        &transcript_path,
        minutes,
        minutes_error,
        0,
        0,
        None,
    )
}

fn default_title() -> String {
    format!(
        "会议纪要 {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    )
}

fn output_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 输出目录：录音所在会议目录优先（回填同一场会），否则新建 minutes 目录。
fn output_dir_for(source: &Path, stamp: &str) -> PathBuf {
    if let Some(parent) = source.parent() {
        if parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("record-"))
        {
            return parent.to_path_buf();
        }
    }
    let data_dir = crate::project_dirs()
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = data_dir
        .join("meeting_records")
        .join(format!("minutes-{stamp}"));
    let _ = fs::create_dir_all(&dir);
    dir
}

/// 生成纪要文本。提示词里绝不能出现英文单词「json」——
/// 公共 LLM 请求器对 DeepSeek 会按该词切换 JSON 输出模式，纪要需要 Markdown。
fn build_minutes_prompt(detail: &str, participants: &[String], title: &str) -> String {
    let detail_rules = match detail {
        "brief" => "本纪要为简要档：只输出「三、会议结论」和「四、待办事项」两个栏目，其余栏目省略。",
        "detailed" => "本纪要为详细档：「二、讨论要点」按议题分小节详细展开，归纳各方发言立场与理由，可引用关键原话。",
        _ => "本纪要为标准档：「二、讨论要点」按议题归纳，每个议题 2-5 条要点。",
    };
    let participant_rules = if participants.is_empty() {
        "转写稿中的说话人以「说话人1、说话人2」标注，请原样保留。".to_string()
    } else {
        format!(
            "本次会议的参会人名单：{}。请结合发言内容把「说话人N」对应到名单中的真实姓名；确实无法判断的保留原标签，不得张冠李戴。",
            participants.join("、")
        )
    };
    format!(
        "你是审计团队的会议秘书。请根据下面的会议转写稿，输出一份 Markdown 格式的会议纪要，标题为「# {title}」。\n\n\
        必须包含以下栏目（简要档按规则省略）：\n\
        ## 一、会议信息\n（会议时间与时长、参会人、记录方式）\n\
        ## 二、讨论要点\n\
        ## 三、会议结论\n\
        ## 四、待办事项\n（用 Markdown 表格，列为：| 事项 | 责任人 | 截止时间 |；没有待办就写「无」）\n\n\
        {detail_rules}\n{participant_rules}\n\
        其他要求：\n\
        1. 只依据转写稿内容归纳，不得编造未提及的信息；\n\
        2. 截止时间转写稿中没有提到时填「待定」；\n\
        3. 直接输出 Markdown 正文，不要任何额外解释或代码块包裹。"
    )
}

/// 转写稿过长时截断（2 小时会议约 4 万字，正常不会触发；只防异常输入撑爆模型）。
const TRANSCRIPT_LIMIT: usize = 100_000;

fn summarize_with_llm(
    params: &Value,
    detail: &str,
    participants: &[String],
    title: &str,
    transcript: &str,
) -> Result<String, String> {
    let llm = params.pointer("/__settings/llm").cloned().unwrap_or(Value::Null);
    if llm.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("未启用统一 LLM 配置，请到设置页开启后再生成纪要。".into());
    }
    let mut config = llm;
    // 长转写的纪要生成可能超过默认超时，给到 4 分钟。
    if let Some(object) = config.as_object_mut() {
        let bumped = object
            .get("timeout")
            .and_then(Value::as_u64)
            .unwrap_or(60)
            .max(240);
        object.insert("timeout".into(), json!(bumped));
    }
    let mut body = transcript.to_string();
    if body.chars().count() > TRANSCRIPT_LIMIT {
        let truncated: String = body.chars().take(TRANSCRIPT_LIMIT).collect();
        body = format!("{truncated}\n\n（转写稿过长，已截断，仅依据以上内容生成纪要。）");
    }
    let prompt = build_minutes_prompt(detail, participants, title);
    crate::audipick::request_llm(&config, &prompt, &body, None)
        .map(|markdown| markdown.trim().to_string())
        .map_err(|error| {
            format!(
                "纪要生成失败：{}（诊断号 {}）",
                error.user_message, error.diagnostic_id
            )
        })
}

#[allow(clippy::too_many_arguments)]
fn finish_output(
    output_dir: &Path,
    stamp: &str,
    title: &str,
    transcript_path: &Path,
    minutes: Option<String>,
    minutes_error: Option<String>,
    speakers: usize,
    billed_ms: i64,
    audio_path: Option<&Path>,
) -> Result<Value, AppError> {
    let minutes_path = match &minutes {
        Some(markdown) => {
            let path = output_dir.join(format!("会议纪要-{stamp}.md"));
            fs::write(&path, markdown).map_err(|e| {
                job_error("MEETING_MINUTES_WRITE_FAILED", "会议纪要写入失败。", Some(e.to_string()))
            })?;
            Some(path)
        }
        None => None,
    };
    let mut output_paths = vec![transcript_path.to_string_lossy().into_owned()];
    if let Some(path) = &minutes_path {
        output_paths.push(path.to_string_lossy().into_owned());
    }
    if let Some(audio) = audio_path {
        output_paths.push(audio.to_string_lossy().into_owned());
    }
    Ok(json!({
        "title": title,
        "minutesPath": minutes_path.map(|path| path.to_string_lossy().into_owned()),
        "transcriptPath": transcript_path.to_string_lossy(),
        "audioPath": audio_path.map(|path| path.to_string_lossy().into_owned()),
        "speakerCount": speakers,
        "billedMs": billed_ms,
        "minutesError": minutes_error,
        "outputPaths": output_paths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_contains_fixed_sections_and_never_triggers_llm_json_mode() {
        for detail in ["brief", "standard", "detailed"] {
            let prompt = build_minutes_prompt(detail, &["张三".into(), "李四".into()], "测试会议");
            assert!(prompt.contains("## 一、会议信息"));
            assert!(prompt.contains("## 二、讨论要点"));
            assert!(prompt.contains("## 三、会议结论"));
            assert!(prompt.contains("## 四、待办事项"));
            assert!(prompt.contains("张三、李四"));
            // DeepSeek JSON 模式以提示词中的小写 json 为开关，纪要必须避开。
            assert!(!prompt.to_ascii_lowercase().contains("json"));
        }
        let brief = build_minutes_prompt("brief", &[], "测试会议");
        assert!(brief.contains("只输出「三、会议结论」和「四、待办事项」"));
        assert!(brief.contains("原样保留"));
    }

    #[test]
    fn participants_split_on_common_separators() {
        let params = json!({"participants": "张三，李四；王五、赵六\n钱七"});
        assert_eq!(
            participants_param(&params),
            vec!["张三", "李四", "王五", "赵六", "钱七"]
        );
        assert!(participants_param(&json!({})).is_empty());
    }

    #[test]
    fn detail_level_defaults_to_standard() {
        assert_eq!(detail_param(&json!({"detailLevel": "brief"})), "brief");
        assert_eq!(detail_param(&json!({"detailLevel": "detailed"})), "detailed");
        assert_eq!(detail_param(&json!({})), "standard");
        assert_eq!(detail_param(&json!({"detailLevel": "别的"})), "standard");
    }

    #[test]
    fn unknown_method_is_rejected() {
        let error = run_job(
            "meeting.nope",
            json!({}),
            &|_, _, _, _| {},
            Arc::new(AtomicBool::new(false)),
            &test_pause(),
        )
        .unwrap_err();
        assert_eq!(error.code, "METHOD_NOT_FOUND");
    }

    fn test_pause() -> PauseCheckpoint {
        PauseCheckpoint::new(PathBuf::from("NUL"), Arc::new(AtomicBool::new(false)))
    }
}
