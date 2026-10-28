//! 本地会议词库；独立于设置，避免设置页自动保存覆盖词条。
use super::{Storage, db_error};
use crate::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_ENTRIES: usize = 200;
const MAX_CONTEXT_CHARS: usize = 20_000;
const DEFINITIONS_MIGRATION: &str = "confirmed-definitions-20261028-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VocabularyEntry {
    #[serde(default)]
    pub id: String,
    pub term: String,
    pub category: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub definition: String,
    pub enabled: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::new("MEETING_VOCABULARY_INVALID", message, false, None)
}

fn clean(value: &str, max: usize, required: bool, multiline: bool) -> Result<String, AppError> {
    let value = value.trim();
    if (required && value.is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|ch| ch.is_control() && !(multiline && matches!(ch, '\r' | '\n' | '\t')))
    {
        return Err(invalid(
            "词条格式不正确：名称和简称最多 40 字且不能换行，含义最多 200 字，不能含异常控制字符。",
        ));
    }
    Ok(value.to_owned())
}

fn normalize(mut entry: VocabularyEntry) -> Result<VocabularyEntry, AppError> {
    if !entry.id.is_empty() && uuid::Uuid::parse_str(&entry.id).is_err() {
        return Err(invalid("词条编号不正确，请重新加载词库。"));
    }
    entry.term = clean(&entry.term, 40, true, false)?;
    entry.definition = clean(&entry.definition, 200, false, true)?;
    if !matches!(entry.category.as_str(), "company" | "industry" | "other")
        || entry.aliases.len() > 5
    {
        return Err(invalid("请选择有效分类，每条最多填写 5 个简称。"));
    }
    let mut seen = HashSet::from([entry.term.to_lowercase()]);
    let mut aliases = Vec::new();
    for alias in entry.aliases {
        let alias = clean(&alias, 40, true, false)?;
        if seen.insert(alias.to_lowercase()) {
            aliases.push(alias);
        }
    }
    entry.aliases = aliases;
    Ok(entry)
}

fn validate_collection(entries: &[VocabularyEntry]) -> Result<(), AppError> {
    if entries.len() > MAX_ENTRIES {
        return Err(invalid("词库最多保存 200 条，请先删除不再需要的词条。"));
    }
    let mut names = HashSet::new();
    let mut size = 0;
    for entry in entries {
        for name in std::iter::once(&entry.term).chain(entry.aliases.iter()) {
            if !names.insert(name.to_lowercase()) {
                return Err(invalid("名称或简称与已有词条重复，请合并到同一词条。"));
            }
            size += name.chars().count();
        }
        size += entry.definition.chars().count();
    }
    if size > MAX_CONTEXT_CHARS {
        return Err(invalid(
            "词库内容合计最多 20000 字，请精简名称、简称或含义。",
        ));
    }
    Ok(())
}

fn list(conn: &Connection) -> Result<Vec<VocabularyEntry>, AppError> {
    let mut statement = conn
        .prepare("SELECT entry_json FROM meeting_vocabulary ORDER BY rowid")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    rows.map(|row| serde_json::from_str(&row.map_err(db_error)?).map_err(db_error))
        .collect()
}

fn default_entries() -> Result<Vec<VocabularyEntry>, AppError> {
    let entries: Vec<VocabularyEntry> = serde_json::from_str(include_str!(
        "../../assets/meeting/vocabulary-defaults.json"
    ))
    .map_err(db_error)?;
    let entries = entries
        .into_iter()
        .map(normalize)
        .collect::<Result<Vec<_>, _>>()?;
    validate_collection(&entries)?;
    Ok(entries)
}

/// 旧版首次导入的词条均为行业分类、启用、空解释、无别名。
/// 只对仍保留这组原始值的词条做一次补充，不重建已删除或更名的条目。
fn backfill_confirmed_definitions(
    entries: &mut [VocabularyEntry],
    defaults: &[VocabularyEntry],
) -> Vec<usize> {
    let mut changed = Vec::new();
    for index in 0..entries.len() {
        let entry = &entries[index];
        if entry.category != "industry"
            || !entry.enabled
            || !entry.definition.is_empty()
            || !entry.aliases.is_empty()
        {
            continue;
        }
        let Some(default) = defaults.iter().find(|default| default.term == entry.term) else {
            continue;
        };
        if default.definition.is_empty() && default.aliases.is_empty() {
            continue;
        }
        let mut candidate = entry.clone();
        candidate.definition = default.definition.clone();
        // 用户已有同名词条/别名时，保留用户数据，仍可补全解释。
        candidate.aliases = default
            .aliases
            .iter()
            .filter(|alias| {
                let name = alias.to_lowercase();
                !entries.iter().any(|other| {
                    std::iter::once(&other.term)
                        .chain(other.aliases.iter())
                        .any(|word| word.to_lowercase() == name)
                })
            })
            .cloned()
            .collect();
        let original = std::mem::replace(&mut entries[index], candidate);
        // 补充不能让原本处于容量上限附近的用户词库变为不可用。
        if validate_collection(entries).is_ok() {
            changed.push(index);
        } else {
            entries[index] = original;
        }
    }
    changed
}

impl Storage {
    pub(super) fn initialize_meeting_vocabulary(&self) -> Result<(), AppError> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='meeting_vocabulary')", [], |row| row.get(0)).map_err(db_error)?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS meeting_vocabulary(id TEXT PRIMARY KEY, entry_json TEXT NOT NULL)").map_err(db_error)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS meeting_vocabulary_migrations(version TEXT PRIMARY KEY)",
        )
        .map_err(db_error)?;
        let migrated: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM meeting_vocabulary_migrations WHERE version=?1)",
                [DEFINITIONS_MIGRATION],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        // 只在首次建表时提供行业起始词；用户删掉的词不能在重启后复活。
        if !exists {
            for mut entry in default_entries()? {
                entry.id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO meeting_vocabulary(id,entry_json) VALUES(?1,?2)",
                    params![entry.id, json!(entry).to_string()],
                )
                .map_err(db_error)?;
            }
        } else if !migrated {
            let mut entries = list(&tx)?;
            for index in backfill_confirmed_definitions(&mut entries, &default_entries()?) {
                let entry = &entries[index];
                tx.execute(
                    "UPDATE meeting_vocabulary SET entry_json=?2 WHERE id=?1",
                    params![entry.id, json!(entry).to_string()],
                )
                .map_err(db_error)?;
            }
        }
        if !migrated {
            tx.execute(
                "INSERT INTO meeting_vocabulary_migrations(version) VALUES(?1)",
                [DEFINITIONS_MIGRATION],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }

    pub(crate) fn meeting_vocabulary_list(&self) -> Result<Vec<VocabularyEntry>, AppError> {
        list(&self.conn.lock())
    }

    pub(crate) fn meeting_vocabulary_save(
        &self,
        entry: VocabularyEntry,
    ) -> Result<Vec<VocabularyEntry>, AppError> {
        let mut entry = normalize(entry)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        let mut entries = list(&tx)?;
        if entry.id.is_empty() {
            entry.id = uuid::Uuid::new_v4().to_string();
            entries.push(entry.clone());
        } else {
            let existing = entries
                .iter_mut()
                .find(|item| item.id == entry.id)
                .ok_or_else(|| invalid("该词条已被删除，请重新加载词库。"))?;
            *existing = entry.clone();
        }
        validate_collection(&entries)?;
        tx.execute("INSERT INTO meeting_vocabulary(id,entry_json) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET entry_json=excluded.entry_json", params![entry.id, json!(entry).to_string()]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(entries)
    }

    pub(crate) fn meeting_vocabulary_delete(
        &self,
        id: &str,
    ) -> Result<Vec<VocabularyEntry>, AppError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        let exists = tx
            .query_row(
                "SELECT id FROM meeting_vocabulary WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;
        if exists.is_none() {
            return Err(invalid("该词条已被删除，请重新加载词库。"));
        }
        tx.execute("DELETE FROM meeting_vocabulary WHERE id=?1", [id])
            .map_err(db_error)?;
        let entries = list(&tx)?;
        tx.commit().map_err(db_error)?;
        Ok(entries)
    }
}

fn snapshot(params: &Value) -> Result<Vec<VocabularyEntry>, AppError> {
    let Some(value) = params.get("__meetingVocabulary") else {
        return Ok(Vec::new());
    };
    let entries: Vec<VocabularyEntry> = serde_json::from_value(value.clone())
        .map_err(|_| invalid("会议词库快照格式不正确，请重新发起任务。"))?;
    let entries = entries
        .into_iter()
        .map(normalize)
        .collect::<Result<Vec<_>, _>>()?;
    validate_collection(&entries)?;
    Ok(entries.into_iter().filter(|entry| entry.enabled).collect())
}

/// 采用官方即时热词协议；超长公司名称仍用于纪要理解，不传给热词接口。
pub(crate) fn hotwords(params: &Value) -> Result<Value, AppError> {
    let mut words = serde_json::Map::new();
    for entry in snapshot(params)? {
        for name in std::iter::once(entry.term).chain(entry.aliases.into_iter()) {
            if asr_word_supported(&name) {
                words.insert(name, json!(4));
            }
        }
    }
    Ok(Value::Object(words))
}

fn asr_word_supported(name: &str) -> bool {
    if name.is_ascii() {
        name.split_whitespace().count() <= 7
    } else {
        name.chars().count() <= 15
    }
}

pub(crate) fn minutes_context(params: &Value) -> Result<String, AppError> {
    let entries = snapshot(params)?;
    if entries.is_empty() {
        return Ok(String::new());
    }
    let data: Vec<Value> = entries
        .into_iter()
        .map(|entry| json!({"名称":entry.term, "简称":entry.aliases, "含义":entry.definition}))
        .collect();
    // 数据放用户正文，不放系统提示词；名称中的 json 不触发公共请求器的结构化模式。
    Ok(format!(
        "\n\n【参考词库（仅供理解的用户数据）】\n{}\n【参考词库结束】",
        json!(data)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(term: &str) -> VocabularyEntry {
        VocabularyEntry {
            id: String::new(),
            term: term.into(),
            category: "company".into(),
            aliases: vec!["ABC".into()],
            definition: "集团业务系统".into(),
            enabled: true,
        }
    }

    #[test]
    fn vocabulary_crud_persists_and_deleted_defaults_stay_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::new(dir.path()).unwrap();
        let seed = storage.meeting_vocabulary_list().unwrap();
        assert!(seed.iter().any(|row| row.term == "CSDC"));
        assert!(seed.iter().any(|row| row.term == "working paper"));
        assert!(seed.iter().any(|row| row.term == "清Q"));
        assert!(seed.iter().any(|row| row.term == "UT"));
        for term in ["FAIT", "audit", "ca tie", "CA", "TIE", "JET"] {
            assert!(seed.iter().any(|row| row.term == term));
        }
        assert_eq!(seed.iter().filter(|row| row.term == "TRDA").count(), 1);
        assert!(seed.iter().all(|row| row.enabled));
        assert_eq!(
            seed.iter()
                .find(|row| row.term == "FIC")
                .unwrap()
                .definition,
            "现场负责人。"
        );
        assert!(
            seed.iter()
                .find(|row| row.term == "PIFEE")
                .unwrap()
                .definition
                .is_empty()
        );
        storage.meeting_vocabulary_delete(&seed[0].id).unwrap();
        let saved = storage
            .meeting_vocabulary_save(entry("  公司平台  "))
            .unwrap();
        let mut company = saved.last().unwrap().clone();
        assert_eq!(company.term, "公司平台");
        let duplicate = storage
            .meeting_vocabulary_save(entry("别的公司"))
            .unwrap_err();
        assert!(duplicate.user_message.contains("重复"));
        company.enabled = false;
        company.definition = "修改后的含义".into();
        storage.meeting_vocabulary_save(company.clone()).unwrap();
        storage
            .settings_set(json!({"meeting":{"asr_model":"test"}}))
            .unwrap();
        drop(storage);
        let reopened = Storage::new(dir.path()).unwrap();
        let rows = reopened.meeting_vocabulary_list().unwrap();
        assert!(!rows.iter().any(|row| row.id == seed[0].id));
        assert_eq!(rows.last().unwrap().definition, "修改后的含义");
        assert!(!rows.last().unwrap().enabled);
        reopened.meeting_vocabulary_delete(&company.id).unwrap();
        assert!(reopened.meeting_vocabulary_save(company).is_err());
    }

    #[test]
    fn vocabulary_snapshot_respects_disabled_and_hotword_limits() {
        let mut enabled = entry("公司平台");
        enabled
            .aliases
            .push("这是一个长度超过十五个字的公司正式全称".into());
        let mut disabled = entry("不用的词");
        disabled.aliases.clear();
        disabled.enabled = false;
        let params = json!({"__meetingVocabulary":[enabled,disabled]});
        let words = hotwords(&params).unwrap();
        assert_eq!(words["公司平台"], 4);
        assert_eq!(words["ABC"], 4);
        assert_eq!(words.as_object().unwrap().len(), 2);
        let context = minutes_context(&params).unwrap();
        assert!(context.contains("集团业务系统"));
        assert!(context.contains("正式全称"));
        assert!(!context.contains("不用的词"));
        assert_eq!(hotwords(&json!({})).unwrap(), json!({}));
        assert_eq!(minutes_context(&json!({})).unwrap(), "");
        assert!(hotwords(&json!({"__meetingVocabulary":{}})).is_err());
    }

    fn legacy_entries() -> Vec<VocabularyEntry> {
        default_entries()
            .unwrap()
            .into_iter()
            .map(|mut entry| {
                entry.id = uuid::Uuid::new_v4().to_string();
                entry.definition.clear();
                entry.aliases.clear();
                entry
            })
            .collect()
    }

    fn write_legacy_database(path: &std::path::Path, entries: &[VocabularyEntry]) {
        let conn = Connection::open(path.join("audit-toolbox.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meeting_vocabulary(id TEXT PRIMARY KEY, entry_json TEXT NOT NULL)",
        )
        .unwrap();
        for entry in entries {
            conn.execute(
                "INSERT INTO meeting_vocabulary(id,entry_json) VALUES(?1,?2)",
                params![entry.id, json!(entry).to_string()],
            )
            .unwrap();
        }
    }

    #[test]
    fn confirmed_defaults_reach_minutes_context_and_hotwords() {
        let defaults = default_entries().unwrap();
        let definition = |term| {
            defaults
                .iter()
                .find(|entry| entry.term == term)
                .unwrap()
                .definition
                .as_str()
        };
        for term in ["EDC", "CSDC"] {
            assert!(definition(term).contains("安永交付中心"));
        }
        assert_eq!(definition("FIC"), "现场负责人。");
        assert_eq!(definition("FDE"), "现场部署工程师。");
        assert_eq!(definition("A3"), "试算平衡表。");
        assert_eq!(definition("SWP"), "标准审计工作底稿。");
        assert!(definition("CCP").contains("PBC 收发存管理门户"));
        assert!(definition("TRDA").contains("安永数字化团队"));
        assert!(definition("TR").contains("TRDA 的简称"));
        assert!(definition("UT").contains("工时利用率"));
        assert!(definition("AI").contains("审计指令"));
        assert!(definition("AI").contains("人工智能"));
        assert!(definition("PMTE").contains("两项概念"));
        for term in ["PIFEE", "EYC", "CA", "ca tie"] {
            assert!(definition(term).is_empty());
        }
        let params = json!({"__meetingVocabulary":defaults});
        let words = hotwords(&params).unwrap();
        for term in ["skywind", "天风", "TR", "TRDA", "FIC", "A3"] {
            assert_eq!(words[term], 4);
        }
        let context = minutes_context(&params).unwrap();
        assert!(context.contains("现场负责人"));
        assert!(context.contains("天风"));
        assert!(context.contains("综合风险评估"));
    }

    #[test]
    fn legacy_definitions_backfill_once_without_overwriting_user_changes() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = legacy_entries();
        let fic_id = old
            .iter()
            .find(|entry| entry.term == "FIC")
            .unwrap()
            .id
            .clone();
        old.retain(|entry| entry.term != "EDC");
        old.iter_mut()
            .find(|entry| entry.term == "FDE")
            .unwrap()
            .definition = "人工维护的解释".into();
        old.iter_mut()
            .find(|entry| entry.term == "A3")
            .unwrap()
            .enabled = false;
        old.iter_mut()
            .find(|entry| entry.term == "TB")
            .unwrap()
            .category = "company".into();
        old.iter_mut()
            .find(|entry| entry.term == "TR")
            .unwrap()
            .aliases
            .push("团队自定简称".into());
        old.iter_mut()
            .find(|entry| entry.term == "UT")
            .unwrap()
            .term = "改名后的UT".into();
        let original = json!(old);
        write_legacy_database(dir.path(), &old);
        let storage = Storage::new(dir.path()).unwrap();
        let rows = storage.meeting_vocabulary_list().unwrap();
        assert_eq!(rows.len(), old.len());
        assert!(
            !rows
                .iter()
                .any(|entry| entry.term == "EDC" || entry.term == "UT")
        );
        for term in ["FDE", "A3", "TB", "TR", "改名后的UT"] {
            assert_eq!(
                json!(rows.iter().find(|entry| entry.term == term).unwrap()),
                *original
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|value| value["term"] == term)
                    .unwrap()
            );
        }
        let mut fic = rows
            .iter()
            .find(|entry| entry.term == "FIC")
            .unwrap()
            .clone();
        assert_eq!(fic.id, fic_id);
        assert_eq!(fic.definition, "现场负责人。");
        assert_eq!(
            rows.iter()
                .find(|entry| entry.term == "skywind")
                .unwrap()
                .aliases,
            vec!["天风"]
        );
        fic.definition.clear();
        storage.meeting_vocabulary_save(fic).unwrap();
        let skywind = rows.iter().find(|entry| entry.term == "skywind").unwrap();
        storage.meeting_vocabulary_delete(&skywind.id).unwrap();
        let persisted = json!(storage.meeting_vocabulary_list().unwrap());
        drop(storage);
        let reopened = Storage::new(dir.path()).unwrap();
        assert_eq!(
            json!(reopened.meeting_vocabulary_list().unwrap()),
            persisted
        );
    }

    #[test]
    fn backfill_skips_alias_collisions_and_respects_total_context_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = legacy_entries();
        let mut custom = entry("天风");
        custom.id = uuid::Uuid::new_v4().to_string();
        old.push(custom);
        write_legacy_database(dir.path(), &old);
        let storage = Storage::new(dir.path()).unwrap();
        let rows = storage.meeting_vocabulary_list().unwrap();
        let skywind = rows.iter().find(|entry| entry.term == "skywind").unwrap();
        assert!(skywind.aliases.is_empty());
        assert_eq!(skywind.definition, "天风。");
        assert!(validate_collection(&rows).is_ok());
        assert_eq!(
            rows.iter()
                .find(|entry| entry.term == "天风")
                .unwrap()
                .definition,
            "集团业务系统"
        );

        let mut full = legacy_entries();
        full.retain(|entry| entry.term == "FIC");
        let mut used = 3;
        for index in 0..110 {
            let term = format!("自定义{index}");
            let definition_length = (MAX_CONTEXT_CHARS - used - term.chars().count()).min(200);
            let mut custom = entry(&term);
            custom.aliases.clear();
            custom.definition = "释".repeat(definition_length);
            used += term.chars().count() + definition_length;
            full.push(custom);
            if MAX_CONTEXT_CHARS - used < 10 {
                break;
            }
        }
        // 把最后一个词条补齐，精确到总容量上限。
        let remaining = MAX_CONTEXT_CHARS - used;
        if remaining > 0 {
            full[1].aliases.push("补".repeat(remaining));
        }
        validate_collection(&full).unwrap();
        let before = json!(full);
        assert!(backfill_confirmed_definitions(&mut full, &default_entries().unwrap()).is_empty());
        assert_eq!(json!(full), before);
    }

    #[test]
    fn vocabulary_database_is_outside_the_cache_cleanup_root() {
        let database = crate::project_dirs()
            .unwrap()
            .data_local_dir()
            .join("audit-toolbox.db");
        let cache = crate::tabular::cache_root().unwrap();
        assert!(!database.starts_with(&cache));
        assert_ne!(database.parent().unwrap(), cache.as_path());
    }

    #[test]
    fn vocabulary_rejects_invalid_lengths_categories_and_oversized_context() {
        assert!(normalize(entry("")).is_err());
        assert!(normalize(entry("换\n行")).is_err());
        assert!(normalize(entry(&"词".repeat(41))).is_err());
        let mut bad = entry("合法词");
        bad.category = "invalid".into();
        assert!(normalize(bad).is_err());
        let rows: Vec<_> = (0..110)
            .map(|index| {
                let mut item = entry(&format!("词{index}"));
                item.aliases.clear();
                item.definition = "释".repeat(200);
                item
            })
            .collect();
        assert!(validate_collection(&rows).is_err());
        let mut first = entry("合法词");
        first.aliases = vec!["abc".into(), "ABC".into(), "合法词".into()];
        assert_eq!(normalize(first).unwrap().aliases, vec!["abc"]);
    }
}
