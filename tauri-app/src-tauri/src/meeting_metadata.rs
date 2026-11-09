//! Facts from native recording/ASR. Never infer meeting dates from file mtimes or job dates.
use crate::bailian_asr::TranscriptionResult;
use chrono::{DateTime, Datelike, Local};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, io::Read, path::Path};

pub(crate) const KEYS: [&str; 3] = ["meetingStartedAt", "meetingEndedAt", "speakerDurationsMs"];

pub(crate) fn recording(audio: &Path) -> Value {
    if audio.file_name().and_then(|v| v.to_str()) != Some("audio-mix.wav") {
        return json!({});
    }
    let Some(parent) = audio.parent() else {
        return json!({});
    };
    if !parent
        .file_name()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.starts_with("record-"))
    {
        return json!({});
    }
    let read = |name: &str| -> Option<Value> {
        let path = parent.join(name).canonicalize().ok()?;
        if path.parent()? != parent.canonicalize().ok()? {
            return None;
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .ok()?
            .take(65537)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > 65536 {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    };
    let summary = read("recording-summary.json");
    let meta = summary
        .or_else(|| read("recording-start.json"))
        .unwrap_or(Value::Null);
    let mut result = json!({});
    if let Some(start) = meta
        .get("startedAt")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
    {
        result["meetingStartedAt"] = json!(start.to_rfc3339());
        let end = meta
            .get("endedAt")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .filter(|end| *end >= start);
        if let Some(end) = end {
            result["meetingEndedAt"] = json!(end.to_rfc3339());
        }
    }
    result
}

pub(crate) fn transcription(asr: &TranscriptionResult) -> Value {
    if asr.speakers == 0 {
        return json!({});
    }
    let mut intervals = BTreeMap::<i64, Vec<(i64, i64)>>::new();
    for sentence in &asr.sentences {
        if (0..999).contains(&sentence.speaker_id)
            && sentence.begin_ms >= 0
            && sentence.end_ms > sentence.begin_ms
            && !sentence.text.trim().is_empty()
        {
            intervals
                .entry(sentence.speaker_id + 1)
                .or_default()
                .push((sentence.begin_ms, sentence.end_ms));
        }
    }
    let mut durations = serde_json::Map::new();
    for (id, mut spans) in intervals {
        spans.sort_unstable();
        let mut total = 0i64;
        let mut merged: Option<(i64, i64)> = None;
        for (start, end) in spans {
            match merged {
                Some((a, b)) if start <= b => merged = Some((a, b.max(end))),
                Some((a, b)) => {
                    total += b - a;
                    merged = Some((start, end));
                }
                None => merged = Some((start, end)),
            }
        }
        if let Some((a, b)) = merged {
            total += b - a;
        }
        durations.insert(id.to_string(), json!(total));
    }
    if durations.is_empty() {
        json!({})
    } else {
        json!({"speakerDurationsMs":durations})
    }
}

pub(crate) fn merge(target: &mut Value, metadata: &Value) {
    for key in KEYS {
        if let Some(value) = metadata.get(key) {
            target[key] = value.clone();
        }
    }
}

fn date(value: &str) -> Option<String> {
    let date = DateTime::parse_from_rfc3339(value)
        .ok()?
        .with_timezone(&Local);
    let weekday =
        ["一", "二", "三", "四", "五", "六", "日"][date.weekday().num_days_from_monday() as usize];
    Some(format!(
        "{}（周{weekday}）{}",
        date.format("%Y-%m-%d"),
        date.format("%H:%M")
    ))
}

pub(crate) fn time_label(metadata: &Value) -> Option<String> {
    let start = date(metadata.get("meetingStartedAt")?.as_str()?)?;
    let end = metadata
        .get("meetingEndedAt")
        .and_then(Value::as_str)
        .and_then(date);
    Some(format!(
        "{start}{}（录音记录）",
        end.map(|v| format!(" 至 {v}")).unwrap_or_default()
    ))
}

pub(crate) fn apply(markdown: &str, metadata: &Value) -> String {
    let Some(time) = time_label(metadata) else {
        return markdown.into();
    };
    let pattern =
        regex::Regex::new(r"(?m)^(?:[-*+]\s+)?(?:\*\*)?会议时间(?:\*\*)?\s*[:：].*$").unwrap();
    if pattern.is_match(markdown) {
        pattern
            .replace_all(markdown, |_: &regex::Captures| format!("会议时间：{time}"))
            .into_owned()
    } else {
        let mut lines = markdown.lines().map(str::to_owned).collect::<Vec<_>>();
        let at = lines
            .iter()
            .position(|v| v.starts_with("## ") && v.contains("会议信息"));
        if let Some(at) = at {
            lines.insert(at + 1, format!("\n会议时间：{time}\n"));
        } else {
            lines.insert(
                usize::from(lines.first().is_some_and(|v| v.starts_with("# "))),
                format!("\n## 一、会议信息\n\n会议时间：{time}\n"),
            );
        }
        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meeting_metadata_uses_actual_turn_durations_and_recording_dates() {
        use crate::bailian_asr::Sentence;
        let asr = TranscriptionResult {
            speakers: 2,
            billed_ms: 100_000,
            sentences: vec![
                Sentence {
                    text: "甲".into(),
                    speaker_id: 0,
                    begin_ms: 0,
                    end_ms: 8000,
                },
                Sentence {
                    text: "重复重叠".into(),
                    speaker_id: 0,
                    begin_ms: 7000,
                    end_ms: 8000,
                },
                Sentence {
                    text: "乙".into(),
                    speaker_id: 1,
                    begin_ms: 20_000,
                    end_ms: 22_000,
                },
                Sentence {
                    text: "无效".into(),
                    speaker_id: 1,
                    begin_ms: 25_000,
                    end_ms: 24_000,
                },
            ],
        };
        assert_eq!(
            transcription(&asr),
            json!({"speakerDurationsMs":{"1":8000,"2":2000}})
        );
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record-test");
        fs::create_dir(&record).unwrap();
        fs::write(
            record.join("recording-summary.json"),
            json!({"startedAt":"2026-11-02T10:00:00+08:00","endedAt":"2026-11-02T11:00:00+08:00"})
                .to_string(),
        )
        .unwrap();
        let meta = recording(&record.join("audio-mix.wav"));
        assert!(time_label(&meta).unwrap().contains("周一"));
        let body = apply(
            "# 测试\n\n## 一、会议信息\n会议时间：未知\n参会人员：说话人1",
            &meta,
        );
        assert!(body.contains("周一"));
        assert!(!body.contains("未知"));
        assert!(body.contains("参会人员：说话人1"));
        assert_eq!(recording(&record.join("import.wav")), json!({}));
        assert_eq!(apply("会议时间：未提供", &json!({})), "会议时间：未提供");
    }
}
