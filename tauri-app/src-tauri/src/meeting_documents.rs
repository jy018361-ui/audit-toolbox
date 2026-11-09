//! Editable minutes retain speaker placeholders separately from the rendered
//! file, so changing a name never performs a global replacement of real names.
use super::{Storage, db_error};
use crate::{AppError, meeting_minutes};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub(crate) type SpeakerNames = BTreeMap<String, String>;

fn path_key(path: &Path) -> String {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy().replace('/', "\\").to_lowercase()
}

pub(crate) fn render_names(source: &str, names: &SpeakerNames) -> Result<String, AppError> {
    if names.len() > 100 || names.iter().any(|(id, name)| {
        id.parse::<u16>().map_or(true, |id| id == 0 || id > 999) || id.starts_with('0') ||
        name.chars().count() > 60 || name.chars().any(char::is_control)
    }) {
        return Err(AppError::new("MEETING_SPEAKERS_INVALID", "说话人姓名格式不正确，姓名最多60字。", false, None));
    }
    // No lookaround in Rust regex: consume every digit, then look up exact ID.
    let labels = regex::Regex::new(r"说话人[ \t]*([1-9][0-9]*)").unwrap();
    Ok(labels.replace_all(source, |caps: &regex::Captures| {
        match names.get(&caps[1]).map(|name| name.trim()).filter(|name| !name.is_empty()) {
            None => caps[0].to_owned(),
            Some(name) => name.chars().flat_map(|ch| {
                if "\\`*_{}[]()#+-.!|>~<".contains(ch) { vec!['\\', ch] } else { vec![ch] }
            }).collect(),
        }
    }).into_owned())
}

impl Storage {
    pub(super) fn initialize_meeting_documents(&self) -> Result<(), AppError> {
        self.conn.lock().execute_batch("CREATE TABLE IF NOT EXISTS meeting_documents(
            path_key TEXT PRIMARY KEY, source_markdown TEXT NOT NULL,
            rendered_markdown TEXT NOT NULL, speaker_names_json TEXT NOT NULL);").map_err(db_error)
    }

    pub fn meeting_document_read(&self, path: &Path, mut result: Value) -> Result<Value, AppError> {
        let stored: Option<(String, String, String)> = self.conn.lock().query_row(
            "SELECT source_markdown,rendered_markdown,speaker_names_json FROM meeting_documents WHERE path_key=?1",
            [path_key(path)], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        ).optional().map_err(db_error)?;
        if let Some((source, rendered, names)) = stored {
            // An external edit invalidates provenance. Never reverse-replace a
            // person's name in arbitrary text or discard external changes.
            if result["minutesMarkdown"].as_str() == Some(rendered.as_str()) {
                result["sourceMarkdown"] = json!(source);
                result["speakerNames"] = serde_json::from_str(&names).map_err(db_error)?;
            }
        }
        Ok(result)
    }

    pub fn meeting_document_save(&self, path: &Path, source: &str, expected: &str, names: &SpeakerNames) -> Result<Value, AppError> {
        if source.len() > 2 * 1024 * 1024 {
            return Err(AppError::new("MEETING_MINUTES_TOO_LARGE", "会议纪要超过 2 MB，请缩短正文后保存。", false, None));
        }
        let rendered = render_names(source, names)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(db_error)?;
        tx.execute("INSERT INTO meeting_documents(path_key,source_markdown,rendered_markdown,speaker_names_json)
            VALUES(?1,?2,?3,?4) ON CONFLICT(path_key) DO UPDATE SET source_markdown=excluded.source_markdown,
            rendered_markdown=excluded.rendered_markdown,speaker_names_json=excluded.speaker_names_json",
            params![path_key(path), source, rendered, serde_json::to_string(names).map_err(db_error)?]).map_err(db_error)?;
        let mut saved = meeting_minutes::save_minutes(path, &rendered, expected)?;
        if let Err(error) = tx.commit() {
            // Preserve the previous file when the metadata transaction fails;
            // the revision check also protects an intervening external edit.
            let _ = meeting_minutes::save_minutes(path, expected, &rendered);
            return Err(db_error(error));
        }
        saved["sourceMarkdown"] = json!(source);
        saved["speakerNames"] = json!(names);
        Ok(saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meeting_names_are_reversible_after_restart_and_never_cross_meetings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("会议.md");
        let other = dir.path().join("另一场.md");
        let source = "# 会议\n说话人1与说话人10讨论。张三负责复核。\n|说话人2|任务|";
        std::fs::write(&path, source).unwrap();
        std::fs::write(&other, source).unwrap();
        let storage = Storage::new(&dir.path().join("data")).unwrap();
        let names = BTreeMap::from([("1".into(), "张三".into()), ("2".into(), "李|四".into())]);
        let saved = storage.meeting_document_save(&path, source, source, &names).unwrap();
        assert_eq!(saved["minutesMarkdown"], "# 会议\n张三与说话人10讨论。张三负责复核。\n|李\\|四|任务|");
        drop(storage);
        let storage = Storage::new(&dir.path().join("data")).unwrap();
        let read = storage.meeting_document_read(&path, meeting_minutes::read_minutes(&path).unwrap()).unwrap();
        assert_eq!(read["sourceMarkdown"], source);
        assert_eq!(read["speakerNames"]["1"], "张三");
        let renamed = BTreeMap::from([("1".into(), "王五".into())]);
        storage.meeting_document_save(&path, source, read["minutesMarkdown"].as_str().unwrap(), &renamed).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("王五与说话人10讨论。张三负责复核。"));
        assert!(storage.meeting_document_read(&other, meeting_minutes::read_minutes(&other).unwrap()).unwrap().get("speakerNames").is_none());
        std::fs::write(&path, "# 外部修改\n张三").unwrap();
        assert!(storage.meeting_document_read(&path, meeting_minutes::read_minutes(&path).unwrap()).unwrap().get("sourceMarkdown").is_none());
        assert!(storage.meeting_document_save(&path, source, "过时正文", &names).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# 外部修改\n张三");
    }

    #[test]
    fn meeting_names_reject_invalid_input_and_escape_markdown() {
        assert!(render_names("正文", &BTreeMap::from([("0".into(), "张三".into())])).is_err());
        assert!(render_names("正文", &BTreeMap::from([("1".into(), "张\n三".into())])).is_err());
        assert_eq!(render_names("说话人1 说话人10 说话人1000", &BTreeMap::from([("1".into(), "*李四*".into())])).unwrap(), "\\*李四\\* 说话人10 说话人1000");
    }
}
