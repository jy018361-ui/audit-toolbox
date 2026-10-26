//! 会议专属索引：列表只读轻量元数据，正文从已归档的确切文件按需读取。
//! 归属以录音／转写稿路径关联，重新生成不会增加一条重复会议。
use super::{Storage, db_error};
use crate::AppError;
use chrono::Utc;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn archived_result(value: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "title",
        "audioPath",
        "transcriptPath",
        "minutesPath",
        "speakerCount",
        "minutesError",
    ] {
        if let Some(value) = value.get(key) {
            result[key] = value.clone();
        }
    }
    // 保存失败时仍保留已生成正文；已落盘正文不再在数据库内重复存储。
    if text(value, "minutesPath").is_empty() {
        if let Some(body) = value.get("minutesMarkdown").and_then(Value::as_str) {
            if body.len() <= 2 * 1024 * 1024 {
                result["minutesMarkdown"] = json!(body);
            }
        }
    }
    if let Some(versions) = value.get("minutesVersions").and_then(Value::as_array) {
        result["minutesVersions"] = json!(
            versions
                .iter()
                .take(2)
                .map(|version| {
                    let mut archived = archived_result(version);
                    archived["kind"] = version["kind"].clone();
                    archived["label"] = version["label"].clone();
                    archived
                })
                .collect::<Vec<_>>()
        );
    }
    result
}

impl Storage {
    pub(super) fn initialize_meeting_history(&self) -> Result<(), AppError> {
        self.conn.lock().execute_batch("CREATE TABLE IF NOT EXISTS meeting_history(
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL, audio_key TEXT NOT NULL DEFAULT '',
            transcript_key TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, started_at TEXT NOT NULL,
            time_label TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '',
            result_json TEXT NOT NULL DEFAULT '{}');
            CREATE INDEX IF NOT EXISTS meeting_history_audio ON meeting_history(audio_key);
            CREATE INDEX IF NOT EXISTS meeting_history_transcript ON meeting_history(transcript_key);
            CREATE INDEX IF NOT EXISTS meeting_history_time ON meeting_history(started_at DESC);")
            .map_err(db_error)?;
        let migrated: bool = self
            .conn
            .lock()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM migrations WHERE source='meeting_history_v1')",
                [],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if migrated {
            return Ok(());
        }
        // 只回填任务历史已记录的文件，不扫描用户磁盘或相邻目录。
        let jobs = {
            let conn = self.conn.lock();
            let mut statement = conn
                .prepare(
                    "SELECT job_id,status,message,output_paths_json FROM task_history
                WHERE tool_id='meeting_minutes' ORDER BY started_at,job_id",
                )
                .map_err(db_error)?;
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)?
        };
        for (job, status, message, paths) in jobs {
            let paths: Vec<String> = serde_json::from_str(&paths).unwrap_or_default();
            let mut result = json!({});
            let mut versions = Vec::new();
            for path in &paths {
                match Path::new(path)
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "md" => {
                        let kind = if path.contains("按时间") {
                            "timeline"
                        } else {
                            "content"
                        };
                        let title = crate::meeting_minutes::read_minutes(Path::new(path))
                            .ok()
                            .and_then(|v| v["title"].as_str().map(str::to_owned));
                        if result.get("minutesPath").is_none() {
                            result["minutesPath"] = json!(path);
                            if let Some(title) = &title {
                                result["title"] = json!(title);
                            }
                        }
                        if !versions.iter().any(|v: &Value| v["kind"] == kind) {
                            versions.push(json!({"kind":kind,"label":if kind == "timeline" {"按时间"} else {"按内容"},
                                "minutesPath":path,"title":title}));
                        }
                    }
                    "txt" => result["transcriptPath"] = json!(path),
                    "wav" | "mp3" | "m4a" | "flac" | "aac" | "mp4" | "webm" | "mov" => {
                        result["audioPath"] = json!(path)
                    }
                    _ => {}
                }
            }
            if !versions.is_empty() {
                result["minutesVersions"] = json!(versions);
            }
            self.record_meeting_history(
                &json!({"jobId":job,"toolId":"meeting_minutes","phase":status,
                "message":message,"result":result}),
            )?;
        }
        self.conn
            .lock()
            .execute(
                "INSERT OR IGNORE INTO migrations(source,completed_at,report_json)
            VALUES('meeting_history_v1',?1,'{}')",
                [Utc::now().to_rfc3339()],
            )
            .map_err(db_error)?;
        Ok(())
    }

    pub(super) fn record_meeting_history(&self, event: &Value) -> Result<(), AppError> {
        if text(event, "toolId") != "meeting_minutes" {
            return Ok(());
        }
        let job = text(event, "jobId");
        let conn = self.conn.lock();
        let task = conn
            .query_row(
                "SELECT params_json,started_at,method FROM task_history WHERE job_id=?1",
                [job],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some((raw_params, started_at, method)) = task else {
            return Ok(());
        };
        if !method.is_empty()
            && !matches!(method.as_str(), "meeting.generate" | "meeting.summarize")
        {
            return Ok(());
        }
        let params: Value = serde_json::from_str(&raw_params).unwrap_or(Value::Null);
        let result = event.get("result").filter(|v| v.is_object());
        if method.is_empty()
            && result.is_none_or(|value| {
                ["audioPath", "transcriptPath", "minutesPath"]
                    .iter()
                    .all(|key| text(value, key).is_empty())
            })
        {
            return Ok(());
        }
        let audio = result
            .map(|v| text(v, "audioPath"))
            .filter(|v| !v.is_empty())
            .unwrap_or(text(&params, "audioPath"));
        let transcript = result
            .map(|v| text(v, "transcriptPath"))
            .filter(|v| !v.is_empty())
            .unwrap_or(text(&params, "transcriptPath"));
        let audio_key = path_key(audio);
        let transcript_key = path_key(transcript);
        let old = conn
            .query_row(
                "SELECT id,title,result_json,job_id FROM meeting_history WHERE job_id=?1
            OR (audio_key<>'' AND audio_key=?2) OR (transcript_key<>'' AND transcript_key=?3)
            ORDER BY started_at LIMIT 1",
                params![job, audio_key, transcript_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        if let Some(previous) = &old {
            if previous.3 != job {
                let latest_started: Option<String> = conn
                    .query_row(
                        "SELECT started_at FROM task_history WHERE job_id=?1",
                        [&previous.3],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(db_error)?;
                if latest_started.is_some_and(|latest| latest > started_at) {
                    return Ok(());
                }
            }
        }
        let id = old.as_ref().map(|v| v.0.as_str()).unwrap_or(job);
        let fallback_title = audio
            .rsplit(['/', '\\'])
            .next()
            .filter(|v| !v.is_empty() && *v != "audio-mix.wav")
            .unwrap_or("未命名会议");
        let title = result
            .map(|v| text(v, "title"))
            .filter(|v| !v.is_empty())
            .or_else(|| old.as_ref().map(|v| v.1.as_str()))
            .unwrap_or(fallback_title);
        let title = title
            .trim_end_matches("（按内容）")
            .trim_end_matches("（按时间）");
        let mut archived = old
            .as_ref()
            .and_then(|v| serde_json::from_str::<Value>(&v.2).ok())
            .unwrap_or(json!({}));
        if let Some(result) = result {
            if result.get("minutesPath").is_some()
                || result.get("minutesVersions").is_some()
                || result.get("transcriptPath").is_some()
            {
                archived = archived_result(result);
            }
        }
        if !audio.is_empty() {
            archived["audioPath"] = json!(audio);
        }
        let phase =
            if text(event, "phase") == "completed" && !text(&archived, "minutesError").is_empty() {
                "partial"
            } else {
                text(event, "phase")
            };
        let label = if audio.contains("record-") || audio.is_empty() {
            "生成时间"
        } else {
            "导入时间"
        };
        conn.execute("INSERT INTO meeting_history(id,job_id,audio_key,transcript_key,title,started_at,time_label,status,message,result_json)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,
            audio_key=CASE WHEN excluded.audio_key='' THEN meeting_history.audio_key ELSE excluded.audio_key END,
            transcript_key=CASE WHEN excluded.transcript_key='' THEN meeting_history.transcript_key ELSE excluded.transcript_key END,
            title=excluded.title,status=excluded.status,message=excluded.message,result_json=excluded.result_json",
            params![id,job,audio_key,transcript_key,title,started_at,label,phase,text(event,"message"),archived.to_string()])
            .map_err(db_error)?;
        Ok(())
    }

    pub fn meeting_history_list(&self) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare("SELECT id,job_id,title,started_at,time_label,status,message FROM meeting_history ORDER BY started_at DESC,id DESC")
            .map_err(db_error)?;
        let rows = statement.query_map([], |row| Ok(json!({"id":row.get::<_,String>(0)?,"jobId":row.get::<_,String>(1)?,
            "title":row.get::<_,String>(2)?,"startedAt":row.get::<_,String>(3)?,"timeLabel":row.get::<_,String>(4)?,
            "status":row.get::<_,String>(5)?,"message":row.get::<_,String>(6)?})))
            .map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
        Ok(json!(rows))
    }

    pub fn meeting_history_result(&self, id: &str) -> Result<Value, AppError> {
        let raw: Option<String> = self
            .conn
            .lock()
            .query_row(
                "SELECT result_json FROM meeting_history WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        let raw = raw.ok_or_else(|| {
            AppError::new(
                "MEETING_HISTORY_NOT_FOUND",
                "未找到这场会议的历史记录。",
                false,
                None,
            )
        })?;
        serde_json::from_str(&raw).map_err(db_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_history_survives_restart_and_groups_regeneration_without_large_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path()).unwrap();
        storage
            .record_job_params(
                "first",
                "meeting_minutes",
                "meeting.generate",
                &json!({"audioPath":"C:/audio.wav"}),
            )
            .unwrap();
        storage.record_job_event(&json!({"jobId":"first","toolId":"meeting_minutes","phase":"completed","result":{
            "title":"预算讨论（按内容）","audioPath":"C:/audio.wav","transcriptPath":"C:/transcript.txt",
            "minutesVersions":[{"kind":"content","label":"按内容","minutesPath":"C:/content.md","minutesMarkdown":"x".repeat(1_000_000)},
            {"kind":"timeline","label":"按时间","minutesMarkdown":"# 未保存正文","minutesError":"无法保存"}]
        }})).unwrap();
        storage
            .record_job_params(
                "retry",
                "meeting_minutes",
                "meeting.summarize",
                &json!({"transcriptPath":"c:\\transcript.txt"}),
            )
            .unwrap();
        storage.record_job_event(&json!({"jobId":"retry","toolId":"meeting_minutes","phase":"failed","message":"生成失败"})).unwrap();
        storage
            .conn
            .lock()
            .execute(
                "UPDATE task_history SET started_at='2026-10-20T00:00:00Z' WHERE job_id='first'",
                [],
            )
            .unwrap();
        storage
            .conn
            .lock()
            .execute(
                "UPDATE task_history SET started_at='2026-10-21T00:00:00Z' WHERE job_id='retry'",
                [],
            )
            .unwrap();
        storage
            .record_job_event(
                &json!({"jobId":"first","toolId":"meeting_minutes","phase":"completed",
            "result":{"title":"不应回灌的旧结果","audioPath":"C:/audio.wav"}}),
            )
            .unwrap();
        drop(storage);
        let storage = Storage::new(dir.path()).unwrap();
        let rows = storage.meeting_history_list().unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["title"], "预算讨论");
        assert_eq!(rows[0]["status"], "failed");
        assert_eq!(rows[0]["jobId"], "retry");
        let result = storage.meeting_history_result("first").unwrap();
        assert!(
            result["minutesVersions"][0]
                .get("minutesMarkdown")
                .is_none()
        );
        assert_eq!(
            result["minutesVersions"][1]["minutesMarkdown"],
            "# 未保存正文"
        );
        assert!(rows.to_string().len() < 2000);
        assert_eq!(
            storage.meeting_history_result("missing").unwrap_err().code,
            "MEETING_HISTORY_NOT_FOUND"
        );
    }

    #[test]
    fn meeting_history_backfills_only_registered_outputs_once() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path()).unwrap();
        let minutes = dir.path().join("会议纪要-按内容-old.md");
        std::fs::write(&minutes, "# 已有会议（按内容）\n\n正文").unwrap();
        storage
            .conn
            .lock()
            .execute(
                "DELETE FROM migrations WHERE source='meeting_history_v1'",
                [],
            )
            .unwrap();
        storage.conn.lock().execute("INSERT INTO task_history(job_id,tool_id,status,summary_json,started_at,output_paths_json)
            VALUES('old','meeting_minutes','completed','{}','2026-10-20',?1)",[json!([minutes]).to_string()]).unwrap();
        drop(storage);
        let storage = Storage::new(dir.path()).unwrap();
        assert_eq!(
            storage.meeting_history_list().unwrap()[0]["title"],
            "已有会议"
        );
        drop(storage);
        let storage = Storage::new(dir.path()).unwrap();
        assert_eq!(
            storage
                .meeting_history_list()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn meeting_history_fast_failure_before_params_does_not_create_duplicate_meeting() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path()).unwrap();
        storage
            .record_job_params(
                "first",
                "meeting_minutes",
                "meeting.generate",
                &json!({"audioPath":"C:/same.wav"}),
            )
            .unwrap();
        storage.record_job_event(&json!({"jobId":"first","toolId":"meeting_minutes","phase":"completed",
            "result":{"audioPath":"C:/same.wav","transcriptPath":"C:/saved.txt","title":"已保存会议"}})).unwrap();
        storage
            .record_job_event(
                &json!({"jobId":"fast","toolId":"meeting_minutes","phase":"failed",
            "result":{"error":{"userMessage":"快速失败"}}}),
            )
            .unwrap();
        storage
            .record_job_params(
                "fast",
                "meeting_minutes",
                "meeting.generate",
                &json!({"audioPath":"c:\\same.wav"}),
            )
            .unwrap();
        let rows = storage.meeting_history_list().unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["jobId"], "fast");
        assert_eq!(rows[0]["status"], "failed");
        assert_eq!(rows[0]["title"], "已保存会议");
    }
}
