use base64::Engine as _;
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zip::{ZipWriter, write::SimpleFileOptions};

use crate::AppError;

pub struct Storage {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

impl Storage {
    pub fn new(data_dir: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(data_dir).map_err(db_error)?;
        let conn = Connection::open(data_dir.join("audit-toolbox.db")).map_err(db_error)?;
        // busy_timeout：两列匹配的 worker 进程会拿独立连接并发写同一库文件
        // （父进程同时在 UPSERT task_history），锁竞争时等待而不是立刻报
        // SQLITE_BUSY。WAL 是库级持久设置，busy_timeout 是连接级的，
        // 因此 fuzzy_match 里自开的连接也要各自设置。
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS migrations(source TEXT PRIMARY KEY,completed_at TEXT NOT NULL,report_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS task_history(job_id TEXT PRIMARY KEY,tool_id TEXT NOT NULL,status TEXT NOT NULL,summary_json TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT);
          CREATE TABLE IF NOT EXISTS audipick_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS audipick_documents(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,data_json TEXT NOT NULL,FOREIGN KEY(project_id) REFERENCES audipick_projects(id));
          CREATE TABLE IF NOT EXISTS fuzzy_match_results(job_id TEXT NOT NULL,a_index INTEGER NOT NULL,a_value TEXT NOT NULL,level TEXT NOT NULL,match_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(job_id,a_index));
          CREATE TABLE IF NOT EXISTS fuzzy_match_confirmations(job_id TEXT NOT NULL,a_index INTEGER NOT NULL,b_index INTEGER,action TEXT NOT NULL,note TEXT,confirmed_at TEXT NOT NULL,PRIMARY KEY(job_id,a_index));").map_err(db_error)?;
        let storage = Self {
            conn: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
        };
        storage.import_legacy_defaults()?;
        storage.sanitize_roll_forward_settings()?;
        Ok(storage)
    }
    /// SQLite 库文件绝对路径：worker 进程拿不到 Tauri state，lib.rs 会在
    /// job_start 分发前把它注入 params.__dbPath，worker 用它自开连接落库。
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("audit-toolbox.db")
    }
    pub fn settings_get(&self) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT key,value_json FROM settings")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(db_error)?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (k, v) = row.map_err(db_error)?;
            map.insert(k, serde_json::from_str(&v).unwrap_or(Value::Null));
        }
        Ok(Value::Object(map))
    }
    pub fn settings_set(&self, settings: Value) -> Result<(), AppError> {
        let Value::Object(map) = settings else {
            return Err(AppError::new(
                "SETTINGS_INVALID",
                "设置数据格式不正确。",
                false,
                None,
            ));
        };
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        for (k, v) in map {
            tx.execute("INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![k,v.to_string(),Utc::now().to_rfc3339()]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }
    pub fn record_job_event(&self, event: &Value) -> Result<(), AppError> {
        let job = event.get("jobId").and_then(Value::as_str).unwrap_or("");
        if job.is_empty() {
            return Ok(());
        }
        let tool = event
            .get("toolId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let status = event
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or("running");
        let now = Utc::now().to_rfc3339();
        let finished =
            matches!(status, "completed" | "failed" | "cancelled").then_some(now.clone());
        self.conn.lock().execute("INSERT INTO task_history(job_id,tool_id,status,summary_json,started_at,finished_at)VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(job_id)DO UPDATE SET status=excluded.status,summary_json=excluded.summary_json,finished_at=excluded.finished_at",params![job,tool,status,event.to_string(),now,finished]).map_err(db_error)?;
        Ok(())
    }
    pub fn history_get(&self) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let mut stmt=conn.prepare("SELECT job_id,tool_id,status,summary_json,started_at,finished_at FROM task_history ORDER BY started_at DESC LIMIT 200").map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(db_error)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, tool, status, summary, started, finished) = row.map_err(db_error)?;
            let detail: Value = serde_json::from_str(&summary).unwrap_or(json!({}));
            out.push(json!({"jobId":id,"toolId":tool,"status":status,"message":detail.get("message").cloned().unwrap_or(Value::Null),"outputPaths":detail.get("outputPaths").cloned().unwrap_or(json!([])),"startedAt":started,"finishedAt":finished}));
        }
        Ok(Value::Array(out))
    }
    pub fn audipick_projects(&self) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT data_json FROM audipick_projects ORDER BY updated_at DESC")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        let mut projects = Vec::new();
        for row in rows {
            let text = row.map_err(db_error)?;
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                projects.push(value);
            }
        }
        Ok(json!({"projects": projects, "storage": "tauri-sqlite", "migrationRequired": false}))
    }
    pub fn audipick_backup_export(&self, output: &Path) -> Result<Value, AppError> {
        if output.as_os_str().is_empty() {
            return Err(AppError::new(
                "OUTPUT_REQUIRED",
                "请选择备份输出文件。",
                false,
                None,
            ));
        }
        let output = if output
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        {
            output.to_path_buf()
        } else {
            output.with_extension("zip")
        };
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(db_error)?;
        }
        let projects = self
            .audipick_projects()?
            .get("projects")
            .cloned()
            .unwrap_or(json!([]));
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id,project_id,path,sha256,data_json FROM audipick_documents ORDER BY project_id,id").map_err(db_error)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(db_error)?;
        let mut documents = Vec::new();
        for row in rows {
            let (id, project_id, path, hash, metadata) = row.map_err(db_error)?;
            documents.push((
                id,
                project_id,
                PathBuf::from(path),
                hash,
                serde_json::from_str::<Value>(&metadata).unwrap_or(json!({})),
            ));
        }
        drop(stmt);
        drop(conn);
        let mut settings = self
            .settings_get()?
            .get("audipick")
            .cloned()
            .unwrap_or(json!({}));
        strip_secrets(&mut settings);
        let manifest_documents: Vec<_> = documents.iter().map(|(id, project_id, _path, hash, _)| {
            json!({"id":id,"projectId":project_id,"sha256":hash,"entry":format!("pdfs/{id}.pdf")})
        }).collect();
        let data = json!({
            "projects": projects,
            "documents": documents.iter().map(|(id,project_id,_path,hash,metadata)| json!({
                "id":id,"projectId":project_id,"sha256":hash,"metadata":metadata
            })).collect::<Vec<_>>(),
            "settings": settings
        });
        let manifest = json!({
            "format":"audit-toolbox.audipick-backup","version":2,
            "createdAt":Utc::now().to_rfc3339(),
            "projects":projects.as_array().map(Vec::len).unwrap_or(0),
            "documents":manifest_documents
        });
        let temp = output.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let file = fs::File::create(&temp).map_err(db_error)?;
        let mut archive = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        archive
            .start_file("manifest.json", options)
            .map_err(db_error)?;
        archive
            .write_all(manifest.to_string().as_bytes())
            .map_err(db_error)?;
        archive.start_file("data.json", options).map_err(db_error)?;
        archive
            .write_all(data.to_string().as_bytes())
            .map_err(db_error)?;
        for (id, _project_id, path, expected_hash, _) in &documents {
            let bytes = fs::read(path).map_err(db_error)?;
            let actual = hex::encode(Sha256::digest(&bytes));
            if &actual != expected_hash {
                let _ = fs::remove_file(&temp);
                return Err(AppError::new(
                    "AUDIPICK_BACKUP_HASH_MISMATCH",
                    "PDF 哈希校验失败，备份已中止。",
                    false,
                    Some(id.clone()),
                ));
            }
            archive
                .start_file(format!("pdfs/{id}.pdf"), options)
                .map_err(db_error)?;
            archive.write_all(&bytes).map_err(db_error)?;
        }
        archive.finish().map_err(db_error)?;
        if output.exists() {
            fs::remove_file(&output).map_err(db_error)?;
        }
        fs::rename(&temp, &output).map_err(db_error)?;
        Ok(
            json!({"outputPaths":[output.to_string_lossy()],"version":2,"projects":projects.as_array().map(Vec::len).unwrap_or(0),"documents":documents.len(),"verified":true}),
        )
    }
    fn audipick_backup_import_v2(&self, path: &Path) -> Result<Value, AppError> {
        let mut archive =
            zip::ZipArchive::new(fs::File::open(path).map_err(db_error)?).map_err(db_error)?;
        let mut manifest_text = String::new();
        archive
            .by_name("manifest.json")
            .map_err(db_error)?
            .read_to_string(&mut manifest_text)
            .map_err(db_error)?;
        let manifest: Value = serde_json::from_str(&manifest_text).map_err(db_error)?;
        if manifest.get("format").and_then(Value::as_str) != Some("audit-toolbox.audipick-backup")
            || manifest.get("version").and_then(Value::as_u64) != Some(2)
        {
            return Err(AppError::new(
                "IMPORT_FORMAT_UNSUPPORTED",
                "AudiPick 备份版本不受支持。",
                false,
                None,
            ));
        }
        let mut data_text = String::new();
        archive
            .by_name("data.json")
            .map_err(db_error)?
            .read_to_string(&mut data_text)
            .map_err(db_error)?;
        let data: Value = serde_json::from_str(&data_text).map_err(db_error)?;
        let stage = self
            .data_dir
            .join("audipick")
            .join(format!(".import-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&stage).map_err(db_error)?;
        let pdf_root = self.data_dir.join("audipick").join("pdfs");
        fs::create_dir_all(&pdf_root).map_err(db_error)?;
        let mut staged = Vec::<(String, String, PathBuf, PathBuf)>::new();
        let import_result = (|| -> Result<(), AppError> {
            for row in manifest
                .get("documents")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = row.get("id").and_then(Value::as_str).unwrap_or("");
                let expected = row.get("sha256").and_then(Value::as_str).unwrap_or("");
                let entry = row.get("entry").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() || expected.len() != 64 || !entry.starts_with("pdfs/") {
                    return Err(AppError::new(
                        "IMPORT_MANIFEST_INVALID",
                        "备份清单包含无效 PDF 项。",
                        false,
                        None,
                    ));
                }
                let mut source = archive.by_name(entry).map_err(db_error)?;
                let staged_path = stage.join(format!("{id}.pdf"));
                let mut target = fs::File::create(&staged_path).map_err(db_error)?;
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let read = source.read(&mut buffer).map_err(db_error)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                    target.write_all(&buffer[..read]).map_err(db_error)?;
                }
                let actual = hex::encode(hasher.finalize());
                if actual != expected {
                    return Err(AppError::new(
                        "IMPORT_HASH_MISMATCH",
                        "AudiPick PDF 哈希校验失败。",
                        false,
                        Some(id.to_string()),
                    ));
                }
                staged.push((
                    id.to_string(),
                    expected.to_string(),
                    staged_path,
                    pdf_root.join(format!("{expected}.pdf")),
                ));
            }
            Ok(())
        })();
        if let Err(error) = import_result {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
        let now = Utc::now().to_rfc3339();
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        let mut imported = 0usize;
        let mut skipped = 0usize;
        for project_data in data
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let project = project_data.get("project").unwrap_or(project_data);
            let id = project.get("id").and_then(Value::as_str).unwrap_or("");
            let name = project
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未命名项目");
            if id.is_empty() {
                continue;
            }
            let changed = tx.execute(
                "INSERT OR IGNORE INTO audipick_projects(id,name,data_json,created_at,updated_at)VALUES(?1,?2,?3,?4,?4)",
                params![id,name,project_data.to_string(),now],
            ).map_err(db_error)?;
            if changed > 0 {
                imported += 1
            } else {
                skipped += 1
            }
        }
        let document_rows = data
            .get("documents")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for document in document_rows {
            let id = document.get("id").and_then(Value::as_str).unwrap_or("");
            let project_id = document
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let hash = document.get("sha256").and_then(Value::as_str).unwrap_or("");
            let metadata = document.get("metadata").cloned().unwrap_or(json!({}));
            let target = pdf_root.join(format!("{hash}.pdf"));
            tx.execute(
                "INSERT OR IGNORE INTO audipick_documents(id,project_id,path,sha256,data_json)VALUES(?1,?2,?3,?4,?5)",
                params![id,project_id,target.to_string_lossy(),hash,metadata.to_string()],
            ).map_err(db_error)?;
        }
        let mut settings = data.get("settings").cloned().unwrap_or(json!({}));
        strip_secrets(&mut settings);
        tx.execute(
            "INSERT INTO settings(key,value_json,updated_at)VALUES('audipick',?1,?2) ON CONFLICT(key)DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![settings.to_string(),now],
        ).map_err(db_error)?;
        let mut created = Vec::new();
        for (_id, _hash, staged_path, target) in &staged {
            if !target.exists() {
                fs::rename(staged_path, target).map_err(db_error)?;
                created.push(target.clone());
            }
        }
        if let Err(error) = tx.commit().map_err(db_error) {
            for path in created {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
        let _ = fs::remove_dir_all(&stage);
        Ok(
            json!({"source":path.to_string_lossy(),"version":2,"imported":imported,"skipped":skipped,"conflicts":skipped,"failed":0,"verified":true}),
        )
    }
    pub fn audipick_project_save(&self, data: Value) -> Result<Value, AppError> {
        let project = data.get("project").cloned().unwrap_or_else(|| data.clone());
        let id = project
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let name = project
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if id.is_empty() || name.is_empty() {
            return Err(AppError::new(
                "AUDIPICK_PROJECT_INVALID",
                "项目名称不能为空。",
                false,
                None,
            ));
        }
        let now = Utc::now().to_rfc3339();
        self.conn.lock().execute(
            "INSERT INTO audipick_projects(id,name,data_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name,data_json=excluded.data_json,updated_at=excluded.updated_at",
            params![id, name, data.to_string(), now],
        ).map_err(db_error)?;
        Ok(data)
    }
    pub fn audipick_project_delete(&self, id: &str) -> Result<Value, AppError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        let mut paths = Vec::new();
        {
            let mut stmt = tx
                .prepare("SELECT path FROM audipick_documents WHERE project_id=?1")
                .map_err(db_error)?;
            let rows = stmt
                .query_map([id], |row| row.get::<_, String>(0))
                .map_err(db_error)?;
            for row in rows {
                paths.push(PathBuf::from(row.map_err(db_error)?));
            }
        }
        tx.execute("DELETE FROM audipick_documents WHERE project_id=?1", [id])
            .map_err(db_error)?;
        let deleted = tx
            .execute("DELETE FROM audipick_projects WHERE id=?1", [id])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        for path in paths {
            let remaining: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM audipick_documents WHERE path=?1",
                    [path.to_string_lossy().as_ref()],
                    |row| row.get(0),
                )
                .unwrap_or(1);
            if remaining == 0 {
                let _ = fs::remove_file(path);
            }
        }
        Ok(json!({"deleted": deleted > 0, "id": id}))
    }
    pub fn audipick_document_import(
        &self,
        project_id: &str,
        source: &Path,
    ) -> Result<Value, AppError> {
        if !source.is_file()
            || source
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| v.eq_ignore_ascii_case("pdf"))
                != Some(true)
        {
            return Err(AppError::new(
                "AUDIPICK_PDF_INVALID",
                "请选择有效的 PDF 文件。",
                false,
                None,
            ));
        }
        let exists: i64 = self
            .conn
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM audipick_projects WHERE id=?1",
                [project_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists == 0 {
            return Err(AppError::new(
                "AUDIPICK_PROJECT_NOT_FOUND",
                "找不到目标项目。",
                false,
                None,
            ));
        }
        let bytes = fs::read(source).map_err(db_error)?;
        let hash = hex::encode(Sha256::digest(&bytes));
        let root = self.data_dir.join("audipick").join("pdfs");
        fs::create_dir_all(&root).map_err(db_error)?;
        let target = root.join(format!("{hash}.pdf"));
        if !target.exists() {
            let temp = root.join(format!("{hash}.pdf.tmp"));
            fs::write(&temp, &bytes).map_err(db_error)?;
            fs::rename(&temp, &target).map_err(db_error)?;
        }
        let id_hash = Sha256::digest(format!("{project_id}:{hash}").as_bytes());
        let id = hex::encode(id_hash)[..24].to_string();
        let metadata = json!({
            "id": id, "projectId": project_id,
            "name": source.file_name().unwrap_or_default().to_string_lossy(),
            "path": target.to_string_lossy(), "sourcePath": source.to_string_lossy(),
            "sha256": hash, "size": bytes.len(), "status": "imported"
        });
        self.conn.lock().execute(
            "INSERT INTO audipick_documents(id,project_id,path,sha256,data_json) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,path=excluded.path,data_json=excluded.data_json",
            params![id, project_id, target.to_string_lossy(), hash, metadata.to_string()],
        ).map_err(db_error)?;
        Ok(metadata)
    }
    pub fn audipick_documents(&self, project_id: &str) -> Result<Value, AppError> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT data_json FROM audipick_documents WHERE project_id=?1 ORDER BY id")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        let mut documents = Vec::new();
        for row in rows {
            if let Ok(value) = serde_json::from_str::<Value>(&row.map_err(db_error)?) {
                documents.push(value);
            }
        }
        Ok(json!({"projectId": project_id, "documents": documents}))
    }
    pub fn audipick_document_bytes(&self, id: &str) -> Result<Vec<u8>, AppError> {
        let path: String = self
            .conn
            .lock()
            .query_row(
                "SELECT path FROM audipick_documents WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| {
                AppError::new(
                    "AUDIPICK_DOCUMENT_NOT_FOUND",
                    "找不到合同 PDF。",
                    false,
                    None,
                )
            })?;
        fs::read(path).map_err(db_error)
    }
    pub fn audipick_document_text(&self, id: &str) -> Result<Value, AppError> {
        let path = self.audipick_document_text_path(id);
        let text = if path.is_file() {
            fs::read_to_string(path).map_err(db_error)?
        } else {
            String::new()
        };
        Ok(json!({"documentId":id,"text":text}))
    }
    pub fn audipick_document_text_path(&self, id: &str) -> PathBuf {
        self.data_dir
            .join("audipick")
            .join("text")
            .join(format!("{id}.txt"))
    }
    pub fn audipick_document_text_save(&self, id: &str, text: &str) -> Result<Value, AppError> {
        let exists: i64 = self
            .conn
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM audipick_documents WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if exists == 0 {
            return Err(AppError::new(
                "AUDIPICK_DOCUMENT_NOT_FOUND",
                "找不到合同 PDF。",
                false,
                None,
            ));
        }
        let root = self.data_dir.join("audipick").join("text");
        fs::create_dir_all(&root).map_err(db_error)?;
        let target = root.join(format!("{id}.txt"));
        let temp = root.join(format!("{id}.txt.tmp"));
        fs::write(&temp, text.as_bytes()).map_err(db_error)?;
        fs::rename(&temp, &target).map_err(db_error)?;
        Ok(json!({"documentId":id,"textLength":text.chars().count(),"saved":true}))
    }
    pub fn audipick_document_delete(&self, id: &str) -> Result<Value, AppError> {
        let path: Option<String> = self
            .conn
            .lock()
            .query_row(
                "SELECT path FROM audipick_documents WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .ok();
        let deleted = self
            .conn
            .lock()
            .execute("DELETE FROM audipick_documents WHERE id=?1", [id])
            .map_err(db_error)?;
        if let Some(path) = path {
            let remaining: i64 = self
                .conn
                .lock()
                .query_row(
                    "SELECT COUNT(*) FROM audipick_documents WHERE path=?1",
                    [path.as_str()],
                    |row| row.get(0),
                )
                .unwrap_or(1);
            if remaining == 0 {
                let _ = fs::remove_file(path);
            }
        }
        let _ = fs::remove_file(
            self.data_dir
                .join("audipick")
                .join("text")
                .join(format!("{id}.txt")),
        );
        Ok(json!({"deleted":deleted>0,"documentId":id}))
    }
    pub fn legacy_paths_exist() -> bool {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
        appdata.is_some_and(|p| {
            p.join("AuditToolbox/llm_settings.json").exists()
                || p.join("AuditRollForward/settings.json").exists()
                || p.join("AuditRollForward/projects.json").exists()
        })
    }
    pub fn legacy_import(&self, path: &Path) -> Result<Value, AppError> {
        if !path.is_file() {
            return Err(AppError::new(
                "IMPORT_NOT_FOUND",
                "找不到要导入的备份文件。",
                false,
                None,
            ));
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
        {
            return self.audipick_backup_import_v2(path);
        }
        let bytes = fs::read(path).map_err(db_error)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::new(
                "IMPORT_INVALID",
                "备份文件格式不正确。",
                false,
                Some(e.to_string()),
            )
        })?;
        if value.get("format").and_then(Value::as_str) != Some("audit-toolbox.audipick-backup") {
            return Err(AppError::new(
                "IMPORT_FORMAT_UNSUPPORTED",
                "当前只支持 AudiPick 迁移备份。",
                false,
                None,
            ));
        }
        let projects = value
            .get("projects")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let contracts = value
            .get("contracts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let results = value
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let pdf_root = self.data_dir.join("audipick").join("pdfs");
        fs::create_dir_all(&pdf_root).map_err(db_error)?;
        let mut decoded_pdfs = Vec::new();
        let mut failed = 0usize;
        for row in value
            .get("pdfs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                failed += 1;
                continue;
            };
            let encoded = row
                .get("data")
                .and_then(|d| d.get("base64"))
                .and_then(Value::as_str)
                .or_else(|| row.get("data").and_then(Value::as_str));
            let Some(encoded) = encoded else {
                failed += 1;
                continue;
            };
            match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(data) => {
                    let hash = hex::encode(Sha256::digest(&data));
                    let target = pdf_root.join(format!("{hash}.pdf"));
                    if !target.exists() {
                        let temp = target.with_extension("pdf.tmp");
                        fs::write(&temp, &data).map_err(db_error)?;
                        fs::rename(temp, &target).map_err(db_error)?;
                    }
                    decoded_pdfs.push((id.to_string(), target, hash));
                }
                Err(_) => failed += 1,
            }
        }
        let now = Utc::now().to_rfc3339();
        let mut imported = 0usize;
        let mut skipped = 0usize;
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(db_error)?;
        for project in &projects {
            let id = project.get("id").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() {
                failed += 1;
                continue;
            }
            let name = project
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("未命名项目");
            let project_contracts: Vec<_> = contracts
                .iter()
                .filter(|c| c.get("pid").and_then(Value::as_str) == Some(id))
                .cloned()
                .collect();
            let contract_ids: Vec<_> = project_contracts
                .iter()
                .filter_map(|c| c.get("id").and_then(Value::as_str))
                .collect();
            let project_results: Vec<_> = results
                .iter()
                .filter(|r| {
                    r.get("contractId")
                        .or_else(|| r.get("cid"))
                        .and_then(Value::as_str)
                        .is_some_and(|cid| contract_ids.contains(&cid))
                })
                .cloned()
                .collect();
            let data =
                json!({"project":project,"contracts":project_contracts,"results":project_results});
            let changed=tx.execute("INSERT OR IGNORE INTO audipick_projects(id,name,data_json,created_at,updated_at)VALUES(?1,?2,?3,?4,?4)",params![id,name,data.to_string(),now]).map_err(db_error)?;
            if changed > 0 {
                imported += 1
            } else {
                skipped += 1
            }
        }
        for (doc_id, target, hash) in decoded_pdfs {
            let project_id = contracts.iter().find_map(|contract| {
                let direct = contract.get("id").and_then(Value::as_str) == Some(doc_id.as_str());
                let supplement = contract
                    .get("supplements")
                    .and_then(Value::as_array)
                    .is_some_and(|rows| {
                        rows.iter().any(|row| {
                            row.get("id").and_then(Value::as_str) == Some(doc_id.as_str())
                        })
                    });
                (direct || supplement)
                    .then(|| contract.get("pid").and_then(Value::as_str))
                    .flatten()
            });
            if let Some(pid) = project_id {
                let _=tx.execute("INSERT OR IGNORE INTO audipick_documents(id,project_id,path,sha256,data_json)VALUES(?1,?2,?3,?4,'{}')",params![doc_id,pid,target.to_string_lossy(),hash]);
            }
        }
        let mut safe_ocr = value.get("ocr").cloned().unwrap_or(json!({}));
        strip_secrets(&mut safe_ocr);
        let audipick_settings = json!({"customRules":value.get("customRules").cloned().unwrap_or(json!([])),"ocr":safe_ocr});
        tx.execute("INSERT INTO settings(key,value_json,updated_at)VALUES('audipick',?1,?2) ON CONFLICT(key)DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",params![audipick_settings.to_string(),now]).map_err(db_error)?;
        let source = path.to_string_lossy().to_string();
        let report = json!({"source":source,"imported":imported,"skipped":skipped,"conflicts":skipped,"failed":failed,"verified":failed==0,"format":"audit-toolbox.audipick-backup"});
        tx.execute(
            "INSERT OR REPLACE INTO migrations(source,completed_at,report_json)VALUES(?1,?2,?3)",
            params![source, now, report.to_string()],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(report)
    }
    fn import_legacy_defaults(&self) -> Result<(), AppError> {
        let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) else {
            return Ok(());
        };
        let candidates = [
            ("llm", appdata.join("AuditToolbox/llm_settings.json")),
            (
                "rollForward",
                appdata.join("AuditRollForward/settings.json"),
            ),
            (
                "rollForwardProjects",
                appdata.join("AuditRollForward/projects.json"),
            ),
        ];
        for (key, path) in candidates {
            if !path.is_file() {
                continue;
            }
            let source = path.to_string_lossy().to_string();
            let already: i64 = self
                .conn
                .lock()
                .query_row(
                    "SELECT COUNT(*) FROM migrations WHERE source=?1",
                    [&source],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if already > 0 {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if key == "llm" {
                if let Some(secret) = value
                    .get("api_key")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let secret_name =
                        if value.get("api_type").and_then(Value::as_str) == Some("dify_chat") {
                            "dify_api_key"
                        } else {
                            "llm_api_key"
                        };
                    let _ = keyring::Entry::new("AuditToolbox", secret_name)
                        .and_then(|entry| entry.set_password(secret));
                }
                if let Value::Object(ref mut map) = value {
                    map.remove("api_key");
                }
            }
            if key == "rollForward" || key == "rollForwardProjects" {
                strip_secrets(&mut value);
            }
            let mut conn = self.conn.lock();
            let tx = conn.transaction().map_err(db_error)?;
            tx.execute(
                "INSERT OR IGNORE INTO settings(key,value_json,updated_at)VALUES(?1,?2,?3)",
                params![key, value.to_string(), Utc::now().to_rfc3339()],
            )
            .map_err(db_error)?;
            let report = json!({"source":source,"imported":1,"verified":true});
            tx.execute(
                "INSERT INTO migrations(source,completed_at,report_json)VALUES(?1,?2,?3)",
                params![source, Utc::now().to_rfc3339(), report.to_string()],
            )
            .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        Ok(())
    }
    fn sanitize_roll_forward_settings(&self) -> Result<(), AppError> {
        let conn = self.conn.lock();
        for key in ["rollForward", "rollForwardProjects"] {
            let current = conn
                .query_row(
                    "SELECT value_json FROM settings WHERE key=?1",
                    [key],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            let Some(current) = current else { continue };
            let Ok(mut value) = serde_json::from_str::<Value>(&current) else {
                continue;
            };
            strip_secrets(&mut value);
            if value.to_string() != current {
                conn.execute(
                    "UPDATE settings SET value_json=?1,updated_at=?2 WHERE key=?3",
                    params![value.to_string(), Utc::now().to_rfc3339(), key],
                )
                .map_err(db_error)?;
            }
        }
        Ok(())
    }
}
fn db_error<E: std::fmt::Display>(e: E) -> AppError {
    AppError::new(
        "STORAGE_ERROR",
        "本机数据存储操作失败。",
        true,
        Some(e.to_string()),
    )
}

fn strip_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let denied = [
                "k",
                "key",
                "api_key",
                "apikey",
                "token",
                "authorization",
                "headers",
                "ak",
                "sk",
                "secret",
            ];
            map.retain(|key, _| !denied.iter().any(|name| key.eq_ignore_ascii_case(name)));
            for child in map.values_mut() {
                strip_secrets(child);
            }
        }
        Value::Array(rows) => {
            for row in rows {
                strip_secrets(row);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("audit-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn strips_nested_ocr_secrets() {
        let mut value = json!({"engine":"custom","vision":{"k":"secret"},"custom":{"token":"secret","headers":{"x":"y"},"url":"https://example.com"}});
        strip_secrets(&mut value);
        assert!(value.pointer("/vision/k").is_none());
        assert!(value.pointer("/custom/token").is_none());
        assert!(value.pointer("/custom/headers").is_none());
        assert_eq!(
            value.pointer("/custom/url").and_then(Value::as_str),
            Some("https://example.com")
        );
    }

    #[test]
    fn audipick_project_and_pdf_roundtrip() {
        let root = test_root();
        let storage = Storage::new(&root).unwrap();
        storage
            .audipick_project_save(
                json!({"project":{"id":"p1","name":"测试项目"},"contracts":[],"results":[]}),
            )
            .unwrap();
        let source = root.join("合同.pdf");
        fs::write(&source, b"%PDF-1.4 test").unwrap();
        let document = storage.audipick_document_import("p1", &source).unwrap();
        let id = document.get("id").and_then(Value::as_str).unwrap();
        assert_eq!(
            storage.audipick_document_bytes(id).unwrap(),
            b"%PDF-1.4 test"
        );
        storage
            .audipick_document_text_save(id, "---PDF第1页---\n合同文本")
            .unwrap();
        assert!(
            storage.audipick_document_text(id).unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("合同文本")
        );
        let backup = root.join("backup.zip");
        storage.audipick_backup_export(&backup).unwrap();
        let mut archive = zip::ZipArchive::new(fs::File::open(&backup).unwrap()).unwrap();
        assert!(archive.by_name("manifest.json").is_ok());
        assert!(archive.by_name(&format!("pdfs/{id}.pdf")).is_ok());
        drop(archive);
        let import_root = test_root();
        let imported = Storage::new(&import_root).unwrap();
        let report = imported.legacy_import(&backup).unwrap();
        assert_eq!(report["verified"], true);
        assert_eq!(
            imported.audipick_projects().unwrap()["projects"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let _ = fs::remove_dir_all(import_root);
        let _ = fs::remove_dir_all(root);
    }
}
