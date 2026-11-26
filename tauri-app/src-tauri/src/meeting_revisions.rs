use super::{
    Storage, db_error,
    meeting_documents::{read_document, store_document},
    meeting_history::{archived_result, has_minutes, path_key, text},
};
use crate::{AppError, meeting_minutes};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use uuid::Uuid;

fn missing() -> AppError {
    AppError::new(
        "MEETING_REVISION_NOT_FOUND",
        "未找到这场会议的纪要版本。",
        false,
        None,
    )
}

fn file_error(error: std::io::Error) -> AppError {
    AppError::new(
        "MEETING_REVISION_WRITE_FAILED",
        "无法保存此纪要版本。",
        true,
        Some(error.to_string()),
    )
}

fn current(conn: &Connection, source: &str) -> Result<Option<(String, Value, String)>, AppError> {
    if source.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, String, String)> = conn.query_row(
        "SELECT id,result_json,status FROM meeting_history
         WHERE id=?2 OR transcript_key=?1 OR audio_key=?1 ORDER BY id=?2 DESC,transcript_key=?1 DESC,started_at LIMIT 1",
        params![path_key(source), source], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(db_error)?;
    row.map(|(id, raw, status)| Ok((id, serde_json::from_str(&raw).map_err(db_error)?, status)))
        .transpose()
}

fn capture_document(conn: &Connection, document: &mut Value) -> Result<(), AppError> {
    let path = Path::new(text(document, "minutesPath"));
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    if path.try_exists().map_err(file_error)? {
        let read = read_document(conn, path, meeting_minutes::read_minutes(path)?)?;
        for key in ["title", "minutesMarkdown", "sourceMarkdown", "speakerNames"] {
            if let Some(value) = read.get(key) {
                document[key] = value.clone();
            }
        }
    }
    document
        .as_object_mut()
        .expect("meeting document object")
        .remove("minutesPath");
    Ok(())
}

fn update_primary(snapshot: &mut Value) {
    let primary = snapshot["minutesVersions"].as_array().and_then(|versions| {
        versions
            .iter()
            .find(|version| has_minutes(version))
            .cloned()
    });
    if let Some(primary) = primary {
        for key in [
            "title",
            "minutesPath",
            "minutesMarkdown",
            "sourceMarkdown",
            "speakerNames",
        ] {
            if let Some(value) = primary.get(key) {
                snapshot[key] = value.clone();
            }
        }
    }
}

fn archive(conn: &Connection, id: &str, mut snapshot: Value) -> Result<(), AppError> {
    if !has_minutes(&snapshot) {
        return Ok(());
    }
    if let Some(versions) = snapshot["minutesVersions"]
        .as_array_mut()
        .filter(|v| !v.is_empty())
    {
        for document in versions {
            capture_document(conn, document)?;
        }
        let object = snapshot.as_object_mut().expect("meeting result object");
        for key in [
            "minutesPath",
            "minutesMarkdown",
            "sourceMarkdown",
            "speakerNames",
        ] {
            object.remove(key);
        }
        update_primary(&mut snapshot);
    } else {
        capture_document(conn, &mut snapshot)?;
    }
    if !has_minutes(&snapshot) {
        return Ok(());
    }
    // Job error messages can change without any changes to a saved document.
    snapshot
        .as_object_mut()
        .expect("meeting result object")
        .remove("minutesError");
    let raw = snapshot.to_string();
    let digest = format!("{:x}", Sha256::digest(raw.as_bytes()));
    conn.execute(
        "INSERT OR IGNORE INTO meeting_revisions(id,meeting_id,created_at,title,digest,snapshot_json)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![Uuid::new_v4().to_string(), id, Utc::now().to_rfc3339(), text(&snapshot, "title"), digest, raw],
    ).map_err(db_error)?;
    Ok(())
}

fn revision(conn: &Connection, meeting_id: &str, revision_id: &str) -> Result<Value, AppError> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM meeting_revisions WHERE meeting_id=?1 AND id=?2",
            [meeting_id, revision_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    serde_json::from_str(&raw.ok_or_else(missing)?).map_err(db_error)
}

fn write_document(
    conn: &Connection,
    directory: &Path,
    name: &str,
    document: &mut Value,
    files: &mut Vec<std::path::PathBuf>,
) -> Result<(), AppError> {
    let Some(body) = document["minutesMarkdown"].as_str() else {
        return Ok(());
    };
    let path = directory.join(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(file_error)?;
    files.push(path.clone());
    file.write_all(body.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(file_error)?;
    if let (Some(source), Some(names)) = (
        document["sourceMarkdown"].as_str(),
        document["speakerNames"].as_object(),
    ) {
        store_document(conn, &path, source, body, &json!(names))?;
    }
    document["minutesPath"] = json!(path);
    Ok(())
}

impl Storage {
    pub(super) fn initialize_meeting_revisions(&self) -> Result<(), AppError> {
        self.conn.lock().execute_batch(
            "CREATE TABLE IF NOT EXISTS meeting_revisions(
                id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meeting_history(id),
                created_at TEXT NOT NULL, title TEXT NOT NULL, digest TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                UNIQUE(meeting_id,digest));
             CREATE INDEX IF NOT EXISTS meeting_revisions_time ON meeting_revisions(meeting_id,created_at DESC);",
        ).map_err(db_error)
    }

    pub(crate) fn meeting_archive_revision(&self, source: &str) -> Result<(), AppError> {
        let conn = self.conn.lock();
        if let Some((id, snapshot, _)) = current(&conn, source)? {
            archive(&conn, &id, snapshot)?;
        }
        Ok(())
    }

    pub(crate) fn meeting_revision_list(&self, source: &str) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let Some((id, _, _)) = current(&conn, source)? else {
            return Ok(json!([]));
        };
        let mut statement = conn.prepare(
            "SELECT id,created_at,title FROM meeting_revisions WHERE meeting_id=?1 ORDER BY created_at DESC",
        ).map_err(db_error)?;
        let rows = statement.query_map([id], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "createdAt": row.get::<_, String>(1)?, "title": row.get::<_, String>(2)?,
        }))).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
        Ok(json!(rows))
    }

    pub(crate) fn meeting_revision_get(
        &self,
        source: &str,
        revision_id: &str,
    ) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let (id, _, _) = current(&conn, source)?.ok_or_else(missing)?;
        revision(&conn, &id, revision_id)
    }

    pub(crate) fn meeting_revision_restore(
        &self,
        source: &str,
        revision_id: &str,
    ) -> Result<Value, AppError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        let (id, active, status) = current(&tx, source)?.ok_or_else(missing)?;
        if matches!(
            status.as_str(),
            "queued" | "running" | "paused" | "cancelling"
        ) {
            return Err(AppError::new(
                "MEETING_REVISION_BUSY",
                "请等待当前会议处理完成后再恢复版本。",
                true,
                None,
            ));
        }
        let mut snapshot = revision(&tx, &id, revision_id)?;
        archive(&tx, &id, active)?;
        let directory = self
            .data_dir
            .join("meeting_restored")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).map_err(file_error)?;
        let mut files = Vec::new();
        let restored = (|| {
            if let Some(versions) = snapshot["minutesVersions"]
                .as_array_mut()
                .filter(|v| !v.is_empty())
            {
                for document in versions {
                    let name = if document["kind"] == "timeline" {
                        "会议纪要-按时间.md"
                    } else {
                        "会议纪要-按内容.md"
                    };
                    write_document(&tx, &directory, name, document, &mut files)?;
                }
                update_primary(&mut snapshot);
            } else {
                write_document(&tx, &directory, "会议纪要.md", &mut snapshot, &mut files)?;
            }
            let index = archived_result(&snapshot);
            tx.execute(
                "UPDATE meeting_history SET title=?2,result_json=?3,transcript_key=?4,audio_key=?5,status='completed',message='已恢复纪要版本' WHERE id=?1",
                params![id, text(&index, "title"), index.to_string(), path_key(text(&index, "transcriptPath")), path_key(text(&index, "audioPath"))],
            ).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            Ok(snapshot)
        })();
        if restored.is_err() {
            for path in files {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir(directory);
        }
        restored
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn meeting_revisions_restore_both_edited_versions_and_preserve_the_newer_draft() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path()).unwrap();
        let transcript = dir.path().join("转写稿.txt");
        let content = dir.path().join("内容.md");
        let timeline = dir.path().join("时间.md");
        let generated = "# 自动纪要\n说话人1。";
        let edited = "# 人工复核\n说话人1核对金额。";
        let names = BTreeMap::from([("1".into(), "张三".into())]);
        fs::write(&transcript, "原文").unwrap();
        for path in [&content, &timeline] {
            fs::write(path, generated).unwrap();
            storage
                .meeting_document_save(path, edited, generated, &names)
                .unwrap();
        }
        let event = |job: &str, result: Value| {
            json!({
                "jobId":job,"toolId":"meeting_minutes","phase":"completed","result":result,
            })
        };
        storage
            .record_job_event(&event(
                "first",
                json!({
                    "transcriptPath":transcript, "minutesPath": content,
                    "minutesVersions":[
                        {"kind":"content", "label":"按内容", "minutesPath":content},
                        {"kind":"timeline", "label":"按时间", "minutesPath":timeline},
                    ]
                }),
            ))
            .unwrap();
        let key = transcript.to_str().unwrap();
        storage.meeting_archive_revision(key).unwrap();
        storage.meeting_archive_revision(key).unwrap();
        let revisions = storage.meeting_revision_list(key).unwrap();
        assert_eq!(revisions.as_array().unwrap().len(), 1);
        let revision_id = revisions[0]["id"].as_str().unwrap();
        let snapshot = storage.meeting_revision_get(key, revision_id).unwrap();
        assert_eq!(snapshot["minutesVersions"][1]["sourceMarkdown"], edited);
        assert_eq!(snapshot["speakerNames"]["1"], "张三");
        assert!(snapshot["minutesPath"].is_null());
        assert!(storage.meeting_revision_get(key, "another-id").is_err());

        storage
            .record_job_event(&event(
                "failed",
                json!({
                    "transcriptPath":transcript, "minutesError": "服务失败", "minutesVersions": [],
                }),
            ))
            .unwrap();
        assert_eq!(
            storage.meeting_history_result("first").unwrap()["minutesPath"],
            json!(content)
        );
        let newest = dir.path().join("新.md");
        fs::write(&newest, "# 新生成稿\n新内容。").unwrap();
        storage
            .record_job_event(&event(
                "latest",
                json!({"transcriptPath":transcript, "minutesPath":newest}),
            ))
            .unwrap();

        let restored = storage.meeting_revision_restore(key, revision_id).unwrap();
        for version in restored["minutesVersions"].as_array().unwrap() {
            let path = Path::new(version["minutesPath"].as_str().unwrap());
            let read = storage
                .meeting_document_read(path, meeting_minutes::read_minutes(path).unwrap())
                .unwrap();
            assert_eq!(read["sourceMarkdown"], edited);
            assert_eq!(read["minutesMarkdown"], "# 人工复核\n张三核对金额。");
        }
        assert_eq!(
            storage.meeting_history_result("first").unwrap()["minutesPath"],
            restored["minutesPath"]
        );
        assert_eq!(
            storage
                .meeting_revision_list(key)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(fs::read_to_string(newest).unwrap(), "# 新生成稿\n新内容。");
    }
}
