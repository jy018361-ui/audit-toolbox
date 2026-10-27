//! OCR-owned persistence. Revisions are compared inside immediate transactions.
use crate::AppError;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) fn failure(code: &str, message: &str) -> AppError {
    AppError::new(code, message, false, None)
}
fn db_error(_: rusqlite::Error) -> AppError {
    failure("OCR_STORAGE", "OCR 项目数据读写失败，请重试。")
}
pub(crate) fn io_error(_: std::io::Error) -> AppError {
    failure("OCR_FILE", "OCR 文件读写失败，请检查目录权限和磁盘空间。")
}
fn encode<T: Serialize>(v: &T) -> Result<String, AppError> {
    serde_json::to_string(v).map_err(|_| failure("OCR_DATA", "OCR 数据格式无效。"))
}
fn decode<T: serde::de::DeserializeOwned>(v: String) -> Result<T, AppError> {
    serde_json::from_str(&v).map_err(|_| failure("OCR_DATA", "保存的 OCR 数据格式无效。"))
}
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptStage {
    pub id: String,
    pub label: String,
    pub prompt: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Table {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub rows: Vec<Vec<String>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub page: u32,
    pub text: String,
    #[serde(default)]
    pub original_text: String,
    #[serde(default)]
    pub tables: Vec<Table>,
    #[serde(default)]
    pub original_tables: Vec<Table>,
    #[serde(default)]
    pub revision: u64,
    pub status: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub mime_type: String,
    pub total_pages: u32,
    pub revision: u64,
    pub status: String,
    pub sha256: String,
}
pub(crate) struct Store {
    pub conn: Connection,
    pub root: PathBuf,
}
impl Store {
    pub fn open(db: &Path) -> Result<Self, AppError> {
        let conn = Connection::open(db).map_err(db_error)?;
        conn.busy_timeout(Duration::from_secs(30))
            .map_err(db_error)?;
        conn.execute_batch("PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS ocr_projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ocr_documents(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ocr_projects(id) ON DELETE CASCADE, data TEXT NOT NULL, source TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ocr_pages(document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(document_id,page));
          CREATE TABLE IF NOT EXISTS ocr_extractions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, data TEXT NOT NULL);").map_err(db_error)?;
        Ok(Self {
            conn,
            root: db.parent().unwrap_or(Path::new(".")).join("ocr-files"),
        })
    }
    fn list(&self, sql: &str, id: Option<&str>) -> Result<Vec<Value>, AppError> {
        let mut stmt = self.conn.prepare(sql).map_err(db_error)?;
        let mut rows = if let Some(id) = id {
            stmt.query([id])
        } else {
            stmt.query([])
        }
        .map_err(db_error)?;
        let mut values = vec![];
        while let Some(row) = rows.next().map_err(db_error)? {
            values.push(decode(row.get(0).map_err(db_error)?)?);
        }
        Ok(values)
    }
    pub fn projects(&self) -> Result<Vec<Value>, AppError> {
        self.list(
            "SELECT data FROM ocr_projects ORDER BY json_extract(data,'$.updatedAt') DESC",
            None,
        )
    }
    pub fn project(&self, id: &str) -> Result<Value, AppError> {
        self.conn
            .query_row("SELECT data FROM ocr_projects WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(db_error)?
            .map(decode)
            .transpose()?
            .ok_or_else(|| failure("OCR_PROJECT_NOT_FOUND", "OCR 项目不存在。"))
    }
    pub fn save_project(&self, p: &Value) -> Result<Value, AppError> {
        let name = p["name"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            return Err(failure("OCR_PROJECT_NAME", "请输入项目名称。"));
        }
        let existing = p["id"].as_str().map(|id| self.project(id)).transpose()?;
        let id = existing
            .as_ref()
            .and_then(|v| v["id"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let prompts = p
            .get("prompts")
            .cloned()
            .or_else(|| existing.as_ref().map(|v| v["prompts"].clone()))
            .unwrap_or(json!({}));
        serde_json::from_value::<std::collections::BTreeMap<String, Vec<PromptStage>>>(
            prompts.clone(),
        )
        .map_err(|_| failure("OCR_PROMPT_INVALID", "场景提示词格式无效。"))?;
        let value = json!({"id":id,"name":name,"prompts":prompts,"createdAt":existing.as_ref().map(|v|v["createdAt"].clone()).unwrap_or(json!(now())),"updatedAt":now()});
        self.conn.execute("INSERT INTO ocr_projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![id,encode(&value)?]).map_err(db_error)?;
        Ok(value)
    }
    pub fn delete_project(&self, id: &str) -> Result<Value, AppError> {
        // Remove rows first. Unreferenced copies can be safely cleaned without affecting another project.
        let sources = self.sources_for_project(id)?;
        self.conn
            .execute("DELETE FROM ocr_projects WHERE id=?", [id])
            .map_err(db_error)?;
        for source in sources {
            let _ = fs::remove_file(source);
        }
        Ok(json!({"deleted":true}))
    }
    fn sources_for_project(&self, id: &str) -> Result<Vec<String>, AppError> {
        let mut stmt = self
            .conn
            .prepare("SELECT source FROM ocr_documents WHERE project_id=?")
            .map_err(db_error)?;
        stmt.query_map([id], |r| r.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)
    }
    pub fn documents(&self, id: &str) -> Result<Vec<Value>, AppError> {
        self.project(id)?;
        self.list(
            "SELECT data FROM ocr_documents WHERE project_id=? ORDER BY rowid",
            Some(id),
        )
    }
    pub fn document(&self, id: &str) -> Result<Document, AppError> {
        self.conn
            .query_row("SELECT data FROM ocr_documents WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(db_error)?
            .map(decode)
            .transpose()?
            .ok_or_else(|| failure("OCR_DOCUMENT_NOT_FOUND", "OCR 文件不存在。"))
    }
    pub fn source(&self, id: &str) -> Result<PathBuf, AppError> {
        self.document(id)?;
        self.conn
            .query_row("SELECT source FROM ocr_documents WHERE id=?", [id], |r| {
                r.get::<_, String>(0)
            })
            .map(PathBuf::from)
            .map_err(db_error)
    }
    pub fn pages(&self, id: &str) -> Result<Vec<Page>, AppError> {
        self.list(
            "SELECT data FROM ocr_pages WHERE document_id=? ORDER BY page",
            Some(id),
        )?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|_| failure("OCR_DATA", "分页数据无效。")))
        .collect()
    }
    pub fn extractions(&self, id: &str) -> Result<Vec<Value>, AppError> {
        let rev = self.document(id)?.revision;
        let mut values = self.list(
            "SELECT data FROM ocr_extractions WHERE document_id=? ORDER BY rowid DESC",
            Some(id),
        )?;
        for v in &mut values {
            v["stale"] = json!(v["sourceRevision"].as_u64() != Some(rev));
        }
        Ok(values)
    }
    pub fn import(&self, project: &str, path: &Path) -> Result<Document, AppError> {
        self.project(project)?;
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "pdf" => "application/pdf",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "bmp" => "image/bmp",
            "tif" | "tiff" => "image/tiff",
            _ => {
                return Err(failure(
                    "OCR_FILE_TYPE",
                    "仅支持 PDF、PNG、JPEG、BMP 和 TIFF 文件。",
                ));
            }
        };
        let bytes = fs::read(path).map_err(io_error)?;
        if bytes.is_empty() {
            return Err(failure("OCR_FILE_EMPTY", "不能导入空文件。"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(&self.root).map_err(io_error)?;
        let target = self.root.join(format!("{id}.{ext}"));
        use std::io::Write;
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(io_error)?;
        if let Err(error) = out.write_all(&bytes).and_then(|_| out.sync_all()) {
            drop(out);
            let _ = fs::remove_file(&target);
            return Err(io_error(error));
        }
        drop(out);
        let doc = Document {
            id: id.clone(),
            project_id: project.into(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            mime_type: mime.into(),
            total_pages: if mime == "application/pdf" || mime == "image/tiff" {
                0
            } else {
                1
            },
            revision: 0,
            status: "pending".into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        if let Err(e) = self.conn.execute(
            "INSERT INTO ocr_documents(id,project_id,data,source) VALUES(?,?,?,?)",
            params![
                id,
                project,
                encode(&doc)?,
                target.to_string_lossy().as_ref()
            ],
        ) {
            let _ = fs::remove_file(target);
            return Err(db_error(e));
        }
        Ok(doc)
    }
    pub fn delete_document(&self, id: &str) -> Result<Value, AppError> {
        let source = self.source(id)?;
        self.conn
            .execute("DELETE FROM ocr_documents WHERE id=?", [id])
            .map_err(db_error)?;
        let _ = fs::remove_file(source);
        Ok(json!({"deleted":true}))
    }
    pub fn prepare(&mut self, id: &str, total: u32) -> Result<Document, AppError> {
        if total == 0 {
            return Err(failure("OCR_PAGE_COUNT", "文件页数必须大于零。"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut doc: Document = decode(
            tx.query_row("SELECT data FROM ocr_documents WHERE id=?", [id], |r| {
                r.get(0)
            })
            .map_err(db_error)?,
        )?;
        let max: u32 = tx
            .query_row(
                "SELECT COALESCE(MAX(page),0) FROM ocr_pages WHERE document_id=?",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if max > total || doc.total_pages > 0 && doc.total_pages != total {
            return Err(failure(
                "OCR_PAGE_COUNT",
                "页数与已保存文件不一致，请重新导入。",
            ));
        }
        doc.total_pages = total;
        tx.execute(
            "UPDATE ocr_documents SET data=? WHERE id=?",
            params![encode(&doc)?, id],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(doc)
    }
    pub fn save_page(
        &mut self,
        id: &str,
        mut page: Page,
        expected: u64,
        recognition: bool,
    ) -> Result<Page, AppError> {
        if page.page == 0 || !matches!(page.status.as_str(), "completed" | "needs_review") {
            return Err(failure("OCR_PAGE_INVALID", "页码或页面状态无效。"));
        }
        if page.tables.iter().any(|t| t.id.trim().is_empty()) {
            return Err(failure("OCR_TABLE_INVALID", "表格标识不能为空。"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let mut doc: Document = decode(
            tx.query_row("SELECT data FROM ocr_documents WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| failure("OCR_DOCUMENT_NOT_FOUND", "OCR 文件不存在。"))?,
        )?;
        if doc.total_pages == 0 || page.page > doc.total_pages {
            return Err(failure(
                "OCR_PAGE_INVALID",
                "页码超出文件范围，请先准备文件页数。",
            ));
        }
        let old: Option<Page> = tx
            .query_row(
                "SELECT data FROM ocr_pages WHERE document_id=? AND page=?",
                params![id, page.page],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?
            .map(decode)
            .transpose()?;
        if old.as_ref().map_or(0, |p| p.revision) != expected {
            return Err(failure(
                "OCR_REVISION_CONFLICT",
                "页面已被修改，本次结果未覆盖人工修订，请刷新后重试。",
            ));
        }
        if let Some(old) = old {
            if recognition && old.original_text.is_empty() {
                page.original_text = page.text.clone();
                page.original_tables = page.tables.clone();
            } else {
                page.original_text = old.original_text;
                page.original_tables = old.original_tables;
            }
        } else if recognition {
            page.original_text = page.text.clone();
            page.original_tables = page.tables.clone();
        } else {
            page.original_text.clear();
            page.original_tables.clear();
        }
        page.revision = expected + 1;
        doc.revision += 1;
        tx.execute("INSERT INTO ocr_pages(document_id,page,data) VALUES(?,?,?) ON CONFLICT(document_id,page) DO UPDATE SET data=excluded.data",params![id,page.page,encode(&page)?]).map_err(db_error)?;
        let count: u32 = tx
            .query_row(
                "SELECT COUNT(*) FROM ocr_pages WHERE document_id=?",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let review:u32=tx.query_row("SELECT COUNT(*) FROM ocr_pages WHERE document_id=? AND json_extract(data,'$.status')='needs_review'",[id],|r|r.get(0)).map_err(db_error)?;
        doc.status = if count < doc.total_pages {
            "partial"
        } else if review > 0 {
            "needs_review"
        } else {
            "completed"
        }
        .into();
        tx.execute(
            "UPDATE ocr_documents SET data=? WHERE id=?",
            params![encode(&doc)?, id],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(page)
    }
    pub fn save_extraction(&mut self, p: &Value) -> Result<Value, AppError> {
        let id = p["documentId"].as_str().unwrap_or("");
        let revision = p["sourceRevision"]
            .as_u64()
            .ok_or_else(|| failure("OCR_REVISION_REQUIRED", "缺少摘录来源版本。"))?;
        let prompts: Vec<PromptStage> = serde_json::from_value(p["prompts"].clone())
            .map_err(|_| failure("OCR_PROMPT_INVALID", "摘录提示词格式无效。"))?;
        let scenario_version = match p.get("scenarioVersion") {
            Some(value) => value
                .as_str()
                .ok_or_else(|| failure("OCR_EXTRACTION_INVALID", "场景规则版本必须为文字。"))?,
            None => "",
        };
        if let Some(columns) = p.get("columns") {
            if !columns.is_array()
                || columns.as_array().unwrap().iter().any(|column| {
                    column["key"].as_str().is_none() || column["label"].as_str().is_none()
                })
            {
                return Err(failure("OCR_EXTRACTION_INVALID", "摘录结果字段格式无效。"));
            }
        }
        if p["scenarioId"].as_str().unwrap_or("").trim().is_empty()
            || !p["rows"].is_array()
            || p["rows"].as_array().unwrap().iter().any(|v| !v.is_object())
        {
            return Err(failure(
                "OCR_EXTRACTION_INVALID",
                "摘录场景或结果格式无效。",
            ));
        }
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let doc: Document = decode(
            tx.query_row("SELECT data FROM ocr_documents WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| failure("OCR_DOCUMENT_NOT_FOUND", "OCR 文件不存在。"))?,
        )?;
        if doc.revision != revision {
            return Err(failure(
                "OCR_REVISION_CONFLICT",
                "原文已修改，摘录结果未保存，请基于新版本重新摘录。",
            ));
        }
        let result = json!({"id":uuid::Uuid::new_v4().to_string(),"scenarioId":p["scenarioId"],"scenarioVersion":scenario_version,"prompts":prompts,"sourceRevision":revision,"rows":p["rows"],"columns":p.get("columns").cloned().unwrap_or(json!([])),"createdAt":now(),"stale":false});
        tx.execute(
            "INSERT INTO ocr_extractions(id,document_id,data) VALUES(?,?,?)",
            params![result["id"].as_str(), id, encode(&result)?],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revisions_preserve_original_and_invalidate_extractions() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("data.sqlite");
        let mut store = Store::open(&db).unwrap();
        let project = store.save_project(&json!({"name":"合成样例"})).unwrap();
        let source = dir.path().join("sample.png");
        fs::write(&source, b"synthetic").unwrap();
        let doc = store
            .import(project["id"].as_str().unwrap(), &source)
            .unwrap();
        let page = Page {
            page: 1,
            text: "原文 001234567890123456789".into(),
            original_text: String::new(),
            tables: vec![],
            original_tables: vec![],
            revision: 0,
            status: "completed".into(),
            warnings: vec![],
        };
        let mut page = store.save_page(&doc.id, page, 0, true).unwrap();
        store.save_extraction(&json!({"documentId":doc.id,"scenarioId":"custom","prompts":[],"sourceRevision":1,"rows":[{"金额":"001"}]})).unwrap();
        page.text = "修订".into();
        assert!(store.save_page(&doc.id, page.clone(), 0, false).is_err());
        let edited = store.save_page(&doc.id, page, 1, false).unwrap();
        assert!(edited.original_text.starts_with("原文"));
        assert_eq!(store.document(&doc.id).unwrap().revision, 2);
        assert_eq!(store.extractions(&doc.id).unwrap()[0]["stale"], true);
        assert!(store.save_extraction(&json!({"documentId":doc.id,"scenarioId":"custom","prompts":[],"sourceRevision":1,"rows":[]})).is_err());
    }
    #[test]
    fn project_delete_cascades_only_owned_document() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let project=store.save_project(&json!({"name":"测试","prompts":{"custom":[{"id":"a","label":"摘录","prompt":"自定义"}]}})).unwrap();
        let source = dir.path().join("x.pdf");
        fs::write(&source, b"%PDF synthetic").unwrap();
        let doc = store
            .import(project["id"].as_str().unwrap(), &source)
            .unwrap();
        let copy = store.source(&doc.id).unwrap();
        store
            .delete_project(project["id"].as_str().unwrap())
            .unwrap();
        assert!(source.exists());
        assert!(!copy.exists());
        assert!(store.document(&doc.id).is_err());
    }
}
