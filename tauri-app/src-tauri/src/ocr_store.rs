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
pub(crate) struct CustomScenario {
    pub id: String,
    pub name: String,
    pub base_scenario_id: String,
    pub version: String,
    pub fields: Vec<ScenarioField>,
    pub stages: Vec<PromptStage>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct ScenarioField {
    pub key: String,
    pub label: String,
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
pub(crate) struct PageMetadata {
    /// Clockwise correction after source/PDF orientation has been applied.
    pub auto_rotation: u16,
    pub auto_orientation_status: String,
}
impl Default for PageMetadata {
    fn default() -> Self {
        Self { auto_rotation: 0, auto_orientation_status: "unknown".into() }
    }
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
    #[serde(default)]
    pub metadata: PageMetadata,
}

/// Read-only projection of legacy provider payloads. The database and its raw
/// original remain untouched. A prior human correction always takes precedence.
fn readable_page(mut page: Page) -> Page {
    let unedited = !page.original_text.is_empty() && page.text == page.original_text;
    let unedited_tables = serde_json::to_value(&page.tables).ok() == serde_json::to_value(&page.original_tables).ok();
    let is_structure = crate::bailian_ocr::looks_like_ocr_payload(&page.original_text)
        || page.original_text.to_ascii_lowercase().contains("<table");
    let is_payload = is_structure
        || crate::bailian_ocr::has_latex_layout(&page.original_text)
        || crate::bailian_ocr::has_markdown_heading(&page.original_text)
        || crate::bailian_ocr::has_image_markup(&page.original_text);
    if is_payload {
        let parsed = crate::bailian_ocr::readable_ocr_content(&page.original_text);
        let parsed_text = parsed["text"].as_str().unwrap_or("").to_owned();
        let recovered: Vec<Table> = parsed["tables"].as_array().into_iter().flatten().enumerate().filter_map(|(index, table)| {
            let mut table = table.clone();
            table["id"] = json!(format!("p{}-legacy-{}", page.page, index + 1));
            serde_json::from_value(table).ok()
        }).collect();
        page.original_text = parsed_text.clone();
        if page.original_tables.is_empty() { page.original_tables = recovered.clone(); }
        if unedited {
            page.text = parsed_text;
            if page.tables.is_empty() && unedited_tables { page.tables = recovered; }
            // A known formatting wrapper may now be readable after an upgrade.
            // Recompute only formatting warnings, preserving OCR quality,
            // orientation and missing-structure warnings from the scan.
            page.warnings.retain(|warning| !format_warning(warning));
            page.warnings.extend(parsed["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
            if is_structure {
                page.warnings.push("历史识别结果已转为可读文字；旧结构可能缺少内容，请重新识别后核对。".into());
            }
            if !page.warnings.is_empty() { page.status = "needs_review".into(); }
        }
    }
    // Table cells have the same source baseline as prose. Normalize only cells
    // still equal to that baseline; individually corrected cells stay intact.
    let baseline = page.original_tables.clone();
    for table in &mut page.original_tables { readable_table(table, None); }
    for table in &mut page.tables {
        if let Some(original) = baseline.iter().find(|source| source.id == table.id) {
            page.warnings.extend(readable_table(table, Some(original)));
        }
    }
    if page.warnings.iter().any(|w| w.contains("表格单元格数据无效") || w.contains("表格行数据无效")) {
        page.warnings.push("旧版未能保存部分表格内容，无法从现有文字恢复，请重新识别本页。".into());
        page.status = "needs_review".into();
    }
    page.warnings.sort(); page.warnings.dedup();
    page
}

fn format_warning(warning: &str) -> bool {
    warning.starts_with("本页含未能安全还原的排版或公式标记")
        || warning.starts_with("本页涉及公式")
}

fn readable_table(table: &mut Table, baseline: Option<&Table>) -> Vec<String> {
    let mut warnings = vec![];
    let mut convert = |text: &mut String, original: Option<&str>| {
        if original.is_some_and(|original| original != text.as_str()) { return; }
        if !crate::bailian_ocr::has_latex_layout(text) && !crate::bailian_ocr::has_markdown_heading(text)
            && !crate::bailian_ocr::has_image_markup(text) { return; }
        let parsed = crate::bailian_ocr::readable_ocr_content(text);
        *text = parsed["text"].as_str().unwrap_or(text).to_owned();
        warnings.extend(parsed["warnings"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
    };
    convert(&mut table.title, baseline.map(|source| source.title.as_str()));
    for (r, row) in table.rows.iter_mut().enumerate() {
        for (c, cell) in row.iter_mut().enumerate() {
            if baseline.is_some() && baseline.and_then(|table| table.rows.get(r)).and_then(|row| row.get(c)).is_none() { continue; }
            convert(cell, baseline.and_then(|table| table.rows.get(r)).and_then(|row| row.get(c)).map(String::as_str));
        }
    }
    warnings
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
          CREATE TABLE IF NOT EXISTS ocr_extractions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ocr_recognition_diagnostics(document_id TEXT NOT NULL REFERENCES ocr_documents(id) ON DELETE CASCADE, page INTEGER NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(document_id,page,revision));").map_err(db_error)?;
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
        let scenarios = p.get("customScenarios").cloned()
            .or_else(|| existing.as_ref().and_then(|v| v.get("customScenarios").cloned()))
            .unwrap_or(json!([]));
        let parsed: Vec<CustomScenario> = serde_json::from_value(scenarios.clone())
            .map_err(|_| failure("OCR_SCENARIO_INVALID", "保存的场景格式无效。"))?;
        let mut scenario_ids = std::collections::BTreeSet::new();
        if parsed.iter().any(|s| s.id.trim().is_empty() || s.name.trim().is_empty()
            || s.base_scenario_id.trim().is_empty() || s.version.trim().is_empty()
            || s.stages.is_empty() || s.stages.iter().any(|stage| stage.id.trim().is_empty() || stage.prompt.trim().is_empty())
            || !scenario_ids.insert(s.id.clone())) {
            return Err(failure("OCR_SCENARIO_INVALID", "请输入有效且不重复的场景、来源场景和提示词。"));
        }
        // Output directories can only be remembered by the validated export
        // path, never injected via a project_save payload.
        let output_directory = existing.as_ref().and_then(|v| v.get("outputDirectory")).cloned().unwrap_or(Value::Null);
        let value = json!({"id":id,"name":name,"prompts":prompts,"customScenarios":scenarios,"outputDirectory":output_directory,"createdAt":existing.as_ref().map(|v|v["createdAt"].clone()).unwrap_or(json!(now())),"updatedAt":now()});
        self.conn.execute("INSERT INTO ocr_projects(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![id,encode(&value)?]).map_err(db_error)?;
        Ok(value)
    }
    pub fn remember_output_directory(&self, project: &str, directory: &Path) -> Result<(), AppError> {
        self.project(project)?;
        self.conn.execute("UPDATE ocr_projects SET data=json_set(data,'$.outputDirectory',?) WHERE id=?", params![directory.to_string_lossy().as_ref(), project]).map_err(db_error)?;
        Ok(())
    }
    pub fn previous_output_directory(&self, project: &str) -> Result<Option<PathBuf>, AppError> {
        let data = self.project(project)?;
        if let Some(directory) = data["outputDirectory"].as_str().filter(|value| !value.trim().is_empty()) {
            return Ok(Some(PathBuf::from(directory)));
        }
        let history_exists: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_history')", [], |row| row.get(0)).map_err(db_error)?;
        if !history_exists { return Ok(None); }
        // Migration of the user's explicit outputDir from a completed export.
        // Never infer/grant an ancestor from imported or generated file paths.
        let previous: Option<String> = self.conn.query_row(
            "SELECT json_extract(params_json,'$.outputDir') FROM task_history WHERE method='ocr.export' AND status='completed' AND json_extract(params_json,'$.projectId')=? AND LENGTH(COALESCE(json_extract(params_json,'$.outputDir'),''))>0 ORDER BY finished_at DESC LIMIT 1",
            [project], |row| row.get(0)).optional().map_err(db_error)?;
        Ok(previous.map(PathBuf::from))
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
        .map(|v| serde_json::from_value(v).map(readable_page).map_err(|_| failure("OCR_DATA", "分页数据无效。")))
        .collect()
    }
    pub fn save_recognition_diagnostics(&self, id: &str, page: u32, revision: u64, responses: &[String]) -> Result<(), AppError> {
        if !responses.is_empty() {
            self.conn.execute("INSERT OR REPLACE INTO ocr_recognition_diagnostics(document_id,page,revision,data) VALUES(?,?,?,?)", params![id,page,revision,encode(&responses)?]).map_err(db_error)?;
        }
        Ok(())
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
        if recognition {
            if let Some(old) = old.as_ref().filter(|old| !old.original_text.is_empty()) {
                // Explicit recognition starts a new source baseline. Keep the
                // previous raw/original internally before replacing the view.
                // An existing provider-response diagnostic is more complete.
                tx.execute("INSERT OR IGNORE INTO ocr_recognition_diagnostics(document_id,page,revision,data) VALUES(?,?,?,?)",params![id,page.page,old.revision,encode(&vec![old.original_text.clone()])?]).map_err(db_error)?;
            }
            page.original_text = page.text.clone();
            page.original_tables = page.tables.clone();
        } else if let Some(old) = old {
            page.original_text = old.original_text;
            page.original_tables = old.original_tables;
            page.metadata = old.metadata;
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
    /// Offline acceptance of saved OCR/extractions in an explicitly supplied
    /// isolated snapshot. No model calls or writes to the live application DB.
    #[test]
    #[ignore]
    fn replay_saved_results_from_stdin() {
        use crate::excel_merger::PauseCheckpoint;
        use std::sync::{Arc, atomic::AtomicBool};
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let request: Value = serde_json::from_str(&input).unwrap();
        let store = Store::open(Path::new(request["snapshotPath"].as_str().unwrap())).unwrap();
        let mut projected = vec![];
        for id in request["documentIds"].as_array().unwrap() {
            projected.push(json!({"documentId":id,"pages":store.pages(id.as_str().unwrap()).unwrap()}));
        }
        let mut fields = vec![];
        for value in request["formatStrings"].as_array().into_iter().flatten() {
            fields.push(crate::bailian_ocr::readable_ocr_text(value.as_str().unwrap()));
        }
        let pause = PauseCheckpoint::unpaused(Arc::new(AtomicBool::new(false)));
        let export = crate::ocr_export::export(&store, &request["export"], &|_,_,_,_|{}, &pause).unwrap();
        std::fs::write(request["reportPath"].as_str().unwrap(), serde_json::to_vec_pretty(&json!({"documents":projected,"formattedStrings":fields,"export":export})).unwrap()).unwrap();
        println!("已保存结果离线回放与导出完成。");
    }
    use super::*;
    #[test]
    fn named_scenarios_round_trip_and_survive_old_project_saves() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let scenario = json!({"id":"saved-one","name":"我的限制性契约","baseScenarioId":"loan_covenant","version":"1","fields":[{"key":"excerpt","label":"原文"}],"stages":[{"id":"financial_metrics","label":"摘录","prompt":"保留65%门槛"}]});
        let project = store.save_project(&json!({"name":"测试","customScenarios":[scenario]})).unwrap();
        let updated = store.save_project(&json!({"id":project["id"],"name":"旧客户端改名","prompts":{}})).unwrap();
        assert_eq!(updated["customScenarios"], json!([scenario]));
        assert!(store.save_project(&json!({"id":project["id"],"name":"测试","customScenarios":[scenario,scenario]})).is_err());
        assert!(store.save_project(&json!({"name":"测试","customScenarios":[{"id":"x","name":""}]})).is_err());
        let legacy = store.save_project(&json!({"name":"旧项目"})).unwrap();
        assert_eq!(legacy["customScenarios"], json!([]));
    }
    #[test]
    fn previous_output_directory_only_reuses_explicit_successful_export_directory() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let project = store.save_project(&json!({"name":"历史目录"})).unwrap();
        let id = project["id"].as_str().unwrap();
        store.conn.execute_batch("CREATE TABLE task_history(method TEXT,status TEXT,params_json TEXT,finished_at TEXT);").unwrap();
        for (method,status,params,stamp) in [
            ("ocr.export","completed",json!({"projectId":id,"outputDir":"C:\\已授权输出目录"}),"1"),
            ("ocr.export","failed",json!({"projectId":id,"outputDir":"C:\\失败目录"}),"2"),
            ("ocr.document_import","completed",json!({"projectId":id,"paths":["C:\\源目录\\合同.pdf"]}),"3"),
            ("ocr.export","completed",json!({"projectId":"other","outputDir":"C:\\其他项目目录"}),"4"),
        ] { store.conn.execute("INSERT INTO task_history VALUES(?,?,?,?)",params![method,status,params.to_string(),stamp]).unwrap(); }
        assert_eq!(store.previous_output_directory(id).unwrap(), Some(PathBuf::from("C:\\已授权输出目录")));
    }
    #[test]
    fn saved_image_markup_projects_without_overwriting_human_text_or_cells() {
        let image = "![0123456789abcdef.jpeg](https://example.com/crop.png?security-token=SYNTHETIC)";
        let raw = format!("{image}\n\n服务请求报告\nSR编号：S000271646");
        let table = Table { id: "t".into(), title: "服务报告".into(), rows: vec![vec![image.into(), r"\(\underline{4.35}\%\)".into()]] };
        let mut page = Page { metadata: Default::default(), page: 1, text: raw.clone(), original_text: raw.clone(), tables: vec![table.clone()], original_tables: vec![table], revision: 8, status: "completed".into(), warnings: vec![] };
        page.tables[0].rows[0][1] = "人工校对4.36%".into();
        let projected = readable_page(page.clone());
        assert_eq!(projected.text, "服务请求报告\nSR编号：S000271646");
        assert_eq!(projected.original_text, projected.text);
        assert_eq!(projected.tables[0].rows[0], vec!["", "人工校对4.36%"]);
        assert_eq!(projected.original_tables[0].rows[0], vec!["", "4.35%"]);
        assert_eq!(projected.revision, 8);
        page.text = "人工校对：![业务符号](保留原样)".into();
        assert_eq!(readable_page(page.clone()).text, page.text);
        assert_eq!(page.original_text, raw);
    }
    #[test]
    fn legacy_latex_is_readable_without_rewriting_storage_or_human_corrections() {
        let raw = r"$\text { 编号：000123 }$";
        let baseline = Page { metadata: Default::default(), page: 1, text: raw.into(), original_text: raw.into(), tables: vec![], original_tables: vec![], revision: 2, status: "completed".into(), warnings: vec![] };
        let projected = readable_page(baseline.clone());
        assert_eq!(projected.text, "编号：000123");
        assert_eq!(projected.original_text, "编号：000123");
        assert_eq!(projected.revision, 2);
        assert_eq!(projected.status, "completed");
        let mut corrected = baseline.clone();
        corrected.text = "人工校对：00123".into();
        assert_eq!(readable_page(corrected).text, "人工校对：00123");
        assert_eq!(baseline.text, raw);
    }
    #[test]
    fn nested_layout_projection_keeps_human_cells_and_recomputes_format_warnings() {
        let raw = r"# 借款金额
\(\underline{\text{金额大写壹仟元}}\)";
        let table = Table { id: "t1".into(), title: "# 金额表".into(), rows: vec![vec![r"\(\underline{\text{00123}}\)".into(), r"\(\text{1000.00}\)".into()]] };
        let mut page = Page { metadata: Default::default(), page: 2, text: raw.into(), original_text: raw.into(), tables: vec![table.clone()], original_tables: vec![table], revision: 3, status: "needs_review".into(), warnings: vec!["本页含未能安全还原的排版或公式标记，已保留原内容，请对照扫描件核对。".into(), "页面方向判断不充分".into()] };
        page.tables[0].rows[0][1] = "人工校对999.00".into();
        let projected = readable_page(page.clone());
        assert_eq!(projected.text, "借款金额\n金额大写壹仟元");
        assert_eq!(projected.tables[0].title, "金额表");
        assert_eq!(projected.tables[0].rows[0], vec!["00123", "人工校对999.00"]);
        assert_eq!(projected.original_tables[0].rows[0], vec!["00123", "1000.00"]);
        assert_eq!(projected.warnings, vec!["页面方向判断不充分"]);
        assert_eq!(projected.revision, 3);
        assert_eq!(page.text, raw);
        let math = r"\(\underline{\frac{1}{2}}\)";
        page.text = math.into(); page.original_text = math.into();
        assert!(readable_page(page).warnings.iter().any(|w| w.contains("排版")));
    }
    #[test]
    fn legacy_projection_does_not_restore_a_table_the_user_deleted() {
        let original_table = Table { id: "t".into(), title: String::new(), rows: vec![vec!["00123".into()]] };
        let raw = r#"{"text":"原文","tables":[{"rows":[["00123"]]}]}"#;
        let page = Page { metadata: Default::default(), page: 1, text: raw.into(), original_text: raw.into(), tables: vec![], original_tables: vec![original_table], revision: 2, status: "needs_review".into(), warnings: vec![] };
        let projected = readable_page(page);
        assert!(projected.tables.is_empty());
        assert!(projected.text.contains("原文"));
    }
    #[test]
    fn legacy_payload_projection_preserves_human_edits_and_raw_storage() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"测试"})).unwrap();
        let source = dir.path().join("x.png"); fs::write(&source, b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), &source).unwrap();
        let raw = r#"{"text":"标题","tables":[{"rows":[{"text":"后续条款"}]}]}"#;
        let page = Page { metadata: Default::default(), page:1, text:raw.into(), original_text:String::new(), tables:vec![], original_tables:vec![], revision:0, status:"completed".into(), warnings:vec![] };
        store.save_page(&doc.id, page, 0, true).unwrap();
        let mut projected = store.pages(&doc.id).unwrap().remove(0);
        assert_eq!(projected.text, "标题\n\n后续条款");
        assert_eq!(projected.status, "needs_review");
        let persisted:String = store.conn.query_row("SELECT data FROM ocr_pages WHERE document_id=?",[&doc.id],|row|row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&persisted).unwrap()["text"], raw);
        projected.text = "用户已校对的完整原文".into();
        store.save_page(&doc.id, projected, 1, false).unwrap();
        assert_eq!(store.pages(&doc.id).unwrap()[0].text, "用户已校对的完整原文");
        store.save_recognition_diagnostics(&doc.id, 1, 2, &[raw.into()]).unwrap();
        let diagnostics:String = store.conn.query_row("SELECT data FROM ocr_recognition_diagnostics WHERE document_id=?",[&doc.id],|row|row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&diagnostics).unwrap()[0], raw);
        assert!(!serde_json::to_string(&store.pages(&doc.id).unwrap()).unwrap().contains("diagnosticResponse"));
    }
    #[test]
    fn explicit_retry_refreshes_source_baseline_but_manual_save_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("db")).unwrap();
        let project = store.save_project(&json!({"name":"测试"})).unwrap();
        let source = dir.path().join("x.png"); fs::write(&source, b"synthetic").unwrap();
        let doc = store.import(project["id"].as_str().unwrap(), &source).unwrap();
        let raw = r#"{"text":"旧内容","rotate_rect":[1><2]}"#;
        let page = Page { metadata: Default::default(), page:1, text:raw.into(), original_text:String::new(), tables:vec![], original_tables:vec![], revision:0, status:"needs_review".into(), warnings:vec![] };
        let mut retry = store.save_page(&doc.id, page, 0, true).unwrap();
        retry.text = "重新识别后的完整原文".into();
        retry.tables = vec![Table{id:"p1-table".into(),title:"原表".into(),rows:vec![vec!["00123".into()]]}];
        let mut current = store.save_page(&doc.id, retry, 1, true).unwrap();
        assert_eq!(current.original_text, "重新识别后的完整原文");
        assert_eq!(current.original_tables[0].rows[0][0], "00123");
        current.tables[0].rows[0][0] = "人工校对".into();
        current.text = "人工校对正文".into();
        let saved = store.save_page(&doc.id, current, 2, false).unwrap();
        assert_eq!(saved.original_text, "重新识别后的完整原文");
        assert_eq!(saved.original_tables[0].rows[0][0], "00123");
        let previous:String = store.conn.query_row("SELECT data FROM ocr_recognition_diagnostics WHERE document_id=? AND revision=1",[&doc.id],|row|row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&previous).unwrap()[0], raw);
    }
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
        let page = Page { metadata: PageMetadata { auto_rotation: 90, auto_orientation_status: "detected".into() },
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
        // Clients cannot erase the recognition direction while editing a table.
        page.metadata = Default::default();
        assert!(store.save_page(&doc.id, page.clone(), 0, false).is_err());
        let edited = store.save_page(&doc.id, page, 1, false).unwrap();
        assert!(edited.original_text.starts_with("原文"));
        assert_eq!(edited.metadata.auto_rotation, 90);
        assert_eq!(store.pages(&doc.id).unwrap()[0].metadata.auto_orientation_status, "detected");
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
