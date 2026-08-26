mod audipick;
mod confirmation;
mod deposit_interest;
#[cfg(windows)]
mod excel_com;
mod excel_merger;
mod fa;
mod fa_subtools;
mod file_list;
mod fuzzy_match;
mod fx;
mod ledger_mapping;
mod loan_interest;
mod pdf_to_excel;
mod roll_forward;
mod storage;
mod tabular;
mod wp;

use directories::ProjectDirs;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use excel_merger::ExcelMergerService;
use storage::Storage;

/// 集成测试（tests/fuzzy_roundtrip.rs）进程内直连任务方法的入口：
/// 不启动 worker 子进程，也不对前端暴露。engine_call_for_test 只放行
/// 只读/存储方法，任务方法（fuzzy.match / fuzzy.export）从这里进。
#[doc(hidden)]
pub use fuzzy_match::run_job_for_test;

#[derive(Clone)]
struct AllowedPaths(Arc<Mutex<HashSet<PathBuf>>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    code: String,
    user_message: String,
    retryable: bool,
    diagnostic_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

impl AppError {
    fn new(
        code: &str,
        message: impl Into<String>,
        retryable: bool,
        detail: Option<String>,
    ) -> Self {
        Self {
            code: code.into(),
            user_message: message.into(),
            retryable,
            diagnostic_id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            detail,
        }
    }
}

fn project_dirs() -> Result<ProjectDirs, AppError> {
    ProjectDirs::from("com", "AuditToolbox", "AuditToolbox").ok_or_else(|| {
        AppError::new(
            "DATA_DIR_UNAVAILABLE",
            "无法确定本机数据目录。",
            false,
            None,
        )
    })
}

#[tauri::command]
fn app_bootstrap() -> Result<Value, AppError> {
    let dirs = project_dirs()?;
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"), "platform": "windows", "arch": std::env::consts::ARCH,
        "webview2": webview2_available(),
        "engine": {"available": true, "version": env!("CARGO_PKG_VERSION"), "mode": "rust-native"},
        "dataDir": dirs.data_local_dir().to_string_lossy(), "migrationRequired": Storage::legacy_paths_exist()
    }))
}

#[tauri::command]
fn tool_catalog() -> Result<Value, AppError> {
    serde_json::from_str(include_str!("../../public/tool-catalog.json")).map_err(|e| {
        AppError::new(
            "CATALOG_INVALID",
            "工具目录无法读取。",
            false,
            Some(e.to_string()),
        )
    })
}

#[tauri::command]
async fn engine_call(
    _excel_merger: State<'_, ExcelMergerService>,
    storage: State<'_, Storage>,
    method: String,
    mut params: Value,
) -> Result<Value, AppError> {
    if method == "audipick.projects" {
        storage.audipick_projects()
    } else if method == "audipick.backup_export" {
        storage.audipick_backup_export(Path::new(
            params
                .get("outputPath")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ))
    } else if method == "audipick.project_save" {
        storage.audipick_project_save(params)
    } else if method == "audipick.project_delete" {
        storage.audipick_project_delete(params.get("id").and_then(Value::as_str).unwrap_or(""))
    } else if method == "audipick.documents" {
        storage.audipick_documents(
            params
                .get("projectId")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
    } else if method == "audipick.document_text" {
        storage.audipick_document_text(
            params
                .get("documentId")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
    } else if method == "audipick.document_text_save" {
        storage.audipick_document_text_save(
            params
                .get("documentId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            params.get("text").and_then(Value::as_str).unwrap_or(""),
        )
    } else if method == "audipick.document_delete" {
        storage.audipick_document_delete(
            params
                .get("documentId")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
    } else if method == "audipick.document_import" {
        let project_id = params
            .get("projectId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let path = params.get("path").and_then(Value::as_str).unwrap_or("");
        storage.audipick_document_import(project_id, Path::new(path))
    } else if method == "fx.classify_source_llm" {
        let settings = storage.settings_get()?;
        tauri::async_runtime::spawn_blocking(move || {
            audipick::fx_source_llm_call(&params, &settings)
        })
        .await
        .map_err(|e| {
            AppError::new(
                "LLM_TASK_FAILED",
                "LLM 文件分类异常结束。",
                true,
                Some(e.to_string()),
            )
        })?
    } else if matches!(
        method.as_str(),
        "audipick.config_status"
            | "audipick.extract"
            | "audipick.classify"
            | "audipick.ocr"
            | "audipick.export"
    ) {
        let settings = storage.settings_get()?;
        tauri::async_runtime::spawn_blocking(move || audipick::call(&method, params, settings))
            .await
            .map_err(|e| {
                AppError::new(
                    "AUDIPICK_TASK_FAILED",
                    "AudiPick 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("fa.") {
        if is_fa_llm_method(&method) {
            inject_fa_settings(&storage, &mut params)?;
        }
        tauri::async_runtime::spawn_blocking(move || fa::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust FA List 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method == "confirmation.inspect" {
        tauri::async_runtime::spawn_blocking(move || confirmation::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust 函证任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method == "wp.validate" {
        tauri::async_runtime::spawn_blocking(move || wp::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust WP 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method == "file_list.scan" {
        tauri::async_runtime::spawn_blocking(move || file_list::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust 文件扫描任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("excel_merger.") {
        tauri::async_runtime::spawn_blocking(move || excel_merger::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust Excel 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method == "kanzhang.llm_mapping" {
        let settings = storage.settings_get()?;
        tauri::async_runtime::spawn_blocking(move || {
            audipick::kanzhang_llm_call(&params, &settings)
        })
        .await
        .map_err(|e| {
            AppError::new(
                "LLM_TASK_FAILED",
                "LLM 字段复核异常结束。",
                true,
                Some(e.to_string()),
            )
        })?
    } else if method == "ledger.review_mapping" {
        let settings = storage.settings_get()?;
        let kind = params
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("je")
            .to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            audipick::ledger_review_call(&kind, &params, &settings)
        })
        .await
        .map_err(|e| {
            AppError::new(
                "LLM_TASK_FAILED",
                "LLM 字段复核异常结束。",
                true,
                Some(e.to_string()),
            )
        })?
    } else if matches!(
        method.as_str(),
        "fx.review_je_mapping" | "fx.review_tb_mapping"
    ) {
        let settings = storage.settings_get()?;
        tauri::async_runtime::spawn_blocking(move || {
            audipick::fx_mapping_llm_call(&method, &params, &settings)
        })
        .await
        .map_err(|e| {
            AppError::new(
                "LLM_TASK_FAILED",
                "LLM 字段复核异常结束。",
                true,
                Some(e.to_string()),
            )
        })?
    } else if method.starts_with("fx.") {
        tauri::async_runtime::spawn_blocking(move || fx::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "汇兑损益审计任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("deposit.") {
        tauri::async_runtime::spawn_blocking(move || deposit_interest::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "存款利息审计任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("loan.") {
        tauri::async_runtime::spawn_blocking(move || loan_interest::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "借款利息审计任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("fuzzy.") {
        // 只有存取结果库的两个方法需要 Storage（照 audipick 分支同步调：
        // call_with_storage 按库文件自开连接，不占全局连接锁，父进程还要
        // UPSERT task_history）。其余 fuzzy.*（fuzzy.inspect 等无状态读文件）
        // 与 deposit/loan 同款 spawn_blocking 直调 call——不能落进
        // call_with_storage，那里对未知方法一律报 METHOD_NOT_FOUND。
        if matches!(method.as_str(), "fuzzy.get_results" | "fuzzy.save_confirm") {
            fuzzy_match::call_with_storage(&storage, &method, params)
        } else {
            tauri::async_runtime::spawn_blocking(move || fuzzy_match::call(&method, params))
                .await
                .map_err(|e| {
                    AppError::new(
                        "RUST_TASK_FAILED",
                        "两列匹配任务异常结束。",
                        true,
                        Some(e.to_string()),
                    )
                })?
        }
    } else if method.starts_with("ts.")
        || method.starts_with("kanzhang.")
        || method.starts_with("cache.")
    {
        tauri::async_runtime::spawn_blocking(move || tabular::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust Polars 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else if method.starts_with("roll_forward.") {
        inject_roll_forward_llm(&storage, &mut params)?;
        tauri::async_runtime::spawn_blocking(move || roll_forward::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "Rust WP Roll Forward 任务异常结束。",
                    true,
                    Some(e.to_string()),
                )
            })?
    } else {
        Err(AppError::new(
            "METHOD_NOT_FOUND",
            "未找到对应的 Rust 业务方法。",
            false,
            Some(method),
        ))
    }
}

#[tauri::command]
async fn job_start(
    excel_merger: State<'_, ExcelMergerService>,
    storage: State<'_, Storage>,
    method: String,
    mut params: Value,
) -> Result<String, AppError> {
    if method == "audipick.batch_extract" {
        if let Value::Object(ref mut map) = params {
            map.insert("__settings".into(), storage.settings_get()?);
            if let Some(documents) = map.get_mut("documents").and_then(Value::as_array_mut) {
                for document in documents {
                    let id = document
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    if let Some(id) = id {
                        if let Some(object) = document.as_object_mut() {
                            object.insert(
                                "textPath".into(),
                                Value::String(
                                    storage
                                        .audipick_document_text_path(&id)
                                        .to_string_lossy()
                                        .into_owned(),
                                ),
                            );
                        }
                    }
                }
            }
        }
        return excel_merger.start(&method, params);
    }
    if method.starts_with("kanzhang.")
        || method.starts_with("fx.")
        || method.starts_with("loan.")
        || method.starts_with("deposit.")
    {
        if let Value::Object(ref mut map) = params {
            map.insert("__settings".into(), storage.settings_get()?);
        }
    }
    if method.starts_with("fuzzy.") {
        // worker 进程拿不到 Tauri state：把 SQLite 库文件绝对路径注入 params，
        // fuzzy.match 落库 / fuzzy.export 读库都在 worker 里自开连接。
        if let Value::Object(ref mut map) = params {
            map.insert(
                "__dbPath".into(),
                Value::String(storage.db_path().to_string_lossy().into_owned()),
            );
        }
    }
    if is_fa_job_method(&method) {
        inject_fa_settings(&storage, &mut params)?;
        return excel_merger.start(&method, params);
    }
    if method.starts_with("fa.") {
        return Err(AppError::new(
            "METHOD_NOT_FOUND",
            "未找到 Rust FA List 任务方法。",
            false,
            Some(method),
        ));
    }
    if method == "wp.generate"
        || method == "confirmation.process"
        // 扫描与导出共用同一条任务通道，两者都必须登记；此前只登记了
        // export，前端拖放文件夹自动扫描时命中兜底报"未找到对应的 Rust
        // 任务方法"。excel_merger::is_supported_job_method 里两者都在。
        || method == "file_list.export"
        || method == "file_list.scan"
        || method == "excel_merger.merge"
        || method.starts_with("ts.")
        || method.starts_with("kanzhang.")
        || matches!(method.as_str(), "fx.fetch_rates" | "fx.preview" | "fx.export")
        || matches!(method.as_str(), "loan.preview" | "loan.export")
        || matches!(method.as_str(), "deposit.preview" | "deposit.export")
        || method == "pdf2excel.convert"
        // 两列匹配：跑匹配要落结果库，导出要从结果库读回，都走任务通道。
        || matches!(method.as_str(), "fuzzy.match" | "fuzzy.export")
    {
        return excel_merger.start(&method, params);
    }
    if is_roll_forward_job_method(&method) {
        inject_roll_forward_llm(&storage, &mut params)?;
        return excel_merger.start(&method, params);
    }
    if method.starts_with("roll_forward.") {
        return Err(AppError::new(
            "METHOD_NOT_FOUND",
            "未找到 Rust WP Roll Forward 任务方法。",
            false,
            Some(method),
        ));
    }
    Err(AppError::new(
        "METHOD_NOT_FOUND",
        "未找到对应的 Rust 任务方法。",
        false,
        Some(method),
    ))
}

fn is_fa_llm_method(method: &str) -> bool {
    matches!(
        method,
        "fa.review" | "fa.supplement_review" | "fa.dep_review"
    )
}

fn is_fa_job_method(method: &str) -> bool {
    matches!(
        method,
        "fa.match" | "fa.preview" | "fa.export" | "fa.dep_export" | "fa.policy_export"
    )
}

fn is_roll_forward_job_method(method: &str) -> bool {
    matches!(
        method,
        "roll_forward.process" | "roll_forward.process_companies"
    )
}

fn inject_fa_settings(storage: &Storage, params: &mut Value) -> Result<(), AppError> {
    let settings = storage.settings_get()?;
    insert_fa_settings(params, settings)
}

fn insert_fa_settings(params: &mut Value, settings: Value) -> Result<(), AppError> {
    let object = params.as_object_mut().ok_or_else(|| {
        AppError::new(
            "INVALID_PARAMS",
            "FA List 参数格式无效。",
            false,
            Some("FA LLM parameters must be a JSON object".into()),
        )
    })?;
    object.insert("__settings".into(), settings);
    Ok(())
}

fn inject_roll_forward_llm(storage: &Storage, params: &mut Value) -> Result<(), AppError> {
    let settings = storage.settings_get()?;
    let llm = settings.get("llm").cloned().unwrap_or_else(|| json!({}));
    let api_type = llm
        .get("apiType")
        .or_else(|| llm.get("api_type"))
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let secret_name = if api_type == "dify_chat" {
        "dify_api_key"
    } else {
        "llm_api_key"
    };
    let api_key = keyring::Entry::new("AuditToolbox", secret_name)
        .and_then(|entry| entry.get_password())
        .unwrap_or_default();
    if let Value::Object(map) = params {
        map.insert(
            "__llmOptions".into(),
            roll_forward_llm_options(&llm, api_key),
        );
    }
    Ok(())
}

fn roll_forward_llm_options(llm: &Value, api_key: String) -> Value {
    json!({
        "enabled": llm.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "api_type": llm.get("apiType").or_else(|| llm.get("api_type"))
            .and_then(Value::as_str).unwrap_or("openai"),
        "api_key": api_key,
        "model": llm.get("model").and_then(Value::as_str).unwrap_or(""),
        "base_url": llm.get("baseUrl").or_else(|| llm.get("base_url"))
            .and_then(Value::as_str).unwrap_or("https://api.openai.com/v1"),
    })
}

#[tauri::command]
fn job_pause(
    excel_merger: State<'_, ExcelMergerService>,
    job_id: String,
    paused: bool,
) -> Result<bool, AppError> {
    if excel_merger.pause(&job_id, paused) {
        return Ok(true);
    }
    Err(AppError::new(
        "JOB_NOT_FOUND",
        "未找到可暂停的 Rust 任务。",
        false,
        Some(job_id),
    ))
}

#[tauri::command]
fn job_cancel(
    excel_merger: State<'_, ExcelMergerService>,
    job_id: String,
) -> Result<bool, AppError> {
    if excel_merger.cancel(&job_id) {
        return Ok(true);
    }
    Err(AppError::new(
        "JOB_NOT_FOUND",
        "未找到可取消的 Rust 任务。",
        false,
        Some(job_id),
    ))
}

#[tauri::command]
fn settings_get(storage: State<'_, Storage>) -> Result<Value, AppError> {
    storage.settings_get()
}

#[tauri::command]
fn settings_set(storage: State<'_, Storage>, settings: Value) -> Result<(), AppError> {
    storage.settings_set(settings)
}

#[tauri::command]
fn llm_test(settings: Value, api_key: Option<String>) -> Result<Value, AppError> {
    let llm = settings.get("llm").unwrap_or(&settings);
    audipick::test_llm_connection(llm, api_key.as_deref())
}

#[tauri::command]
fn history_get(storage: State<'_, Storage>) -> Result<Value, AppError> {
    storage.history_get()
}

#[tauri::command]
fn audipick_pdf_bytes(
    storage: State<'_, Storage>,
    document_id: String,
) -> Result<tauri::ipc::Response, AppError> {
    Ok(tauri::ipc::Response::new(
        storage.audipick_document_bytes(&document_id)?,
    ))
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), AppError> {
    if !matches!(
        name.as_str(),
        "llm_api_key" | "dify_api_key" | "baidu_ocr_key" | "baidu_ocr_secret"
    ) {
        return Err(AppError::new(
            "SECRET_NAME_DENIED",
            "不允许保存该类型的凭据。",
            false,
            None,
        ));
    }
    keyring::Entry::new("AuditToolbox", &name)
        .and_then(|entry| entry.set_password(&value))
        .map_err(|e| {
            AppError::new(
                "CREDENTIAL_WRITE_FAILED",
                "无法写入 Windows 凭据管理器。",
                true,
                Some(e.to_string()),
            )
        })
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), AppError> {
    keyring::Entry::new("AuditToolbox", &name)
        .and_then(|entry| entry.delete_credential())
        .map_err(|e| {
            AppError::new(
                "CREDENTIAL_DELETE_FAILED",
                "无法删除 Windows 凭据。",
                true,
                Some(e.to_string()),
            )
        })
}

#[tauri::command]
fn legacy_import(storage: State<'_, Storage>, path: String) -> Result<Value, AppError> {
    storage.legacy_import(Path::new(&path))
}

#[tauri::command]
fn pick_path(
    app: tauri::AppHandle,
    allowed: State<'_, AllowedPaths>,
    kind: String,
    title: String,
    extensions: Vec<String>,
    default_name: Option<String>,
    default_directory: Option<String>,
) -> Result<Value, AppError> {
    let mut dialog = app.dialog().file().set_title(title);
    if !extensions.is_empty() {
        let filters: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter("支持的文件", &filters);
    }
    // Pre-fill the save dialog so the user gets a sensible timestamped name
    // instead of an empty field they have to type into.
    if let Some(name) = default_name.as_deref().filter(|v| !v.trim().is_empty()) {
        dialog = dialog.set_file_name(name);
    }
    // Opening position only.  Deliberately no `is_dir()` probe: the legacy
    // default is a corporate UNC share, and probing it off the intranet blocks
    // on the SMB timeout.  The shell resolves the path itself and silently
    // falls back to its default folder when it cannot, so an unreachable share
    // degrades instead of failing.  It is *not* added to `AllowedPaths` — only
    // paths the user actually selects get authorized.
    if let Some(directory) = dialog_start_directory(default_directory.as_deref()) {
        dialog = dialog.set_directory(directory);
    }
    let value = match kind.as_str() {
        "folder" => dialog.blocking_pick_folder().map(|p| json!(p.to_string())),
        "files" => dialog
            .blocking_pick_files()
            .map(|items| json!(items.into_iter().map(|p| p.to_string()).collect::<Vec<_>>())),
        "save" => dialog.blocking_save_file().map(|p| json!(p.to_string())),
        _ => dialog.blocking_pick_file().map(|p| json!(p.to_string())),
    }
    .unwrap_or(Value::Null);
    if let Some(text) = value.as_str() {
        allowed.0.lock().insert(PathBuf::from(text));
    }
    if let Some(items) = value.as_array() {
        for item in items.iter().filter_map(Value::as_str) {
            allowed.0.lock().insert(PathBuf::from(item));
        }
    }
    Ok(value)
}

#[tauri::command]
fn open_output(
    app: tauri::AppHandle,
    allowed: State<'_, AllowedPaths>,
    path: String,
) -> Result<(), AppError> {
    let requested = PathBuf::from(&path);
    let canonical = requested.canonicalize().map_err(|error| {
        AppError::new(
            "OUTPUT_NOT_FOUND",
            "输出文件或目录不存在。",
            false,
            Some(error.to_string()),
        )
    })?;
    let permitted = allowed
        .0
        .lock()
        .iter()
        .any(|allowed_path| path_is_permitted(&canonical, allowed_path));
    if !permitted {
        return Err(AppError::new(
            "PATH_NOT_AUTHORIZED",
            "只能打开本次任务生成或由你选择的路径。",
            false,
            None,
        ));
    }
    let target = if canonical.is_file() {
        canonical.parent().unwrap_or(&canonical)
    } else {
        &canonical
    };
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            AppError::new(
                "OPEN_PATH_FAILED",
                "无法打开输出目录。",
                true,
                Some(e.to_string()),
            )
        })
}

/// Opens one of the built-in official rate-lookup entry points in the system
/// browser.  The URL must be on `deposit_interest::REFERENCE_LINKS`; the
/// frontend cannot use this command to reach an arbitrary address, mirroring
/// the AllowedPaths rule that governs local files.
#[tauri::command]
fn open_reference_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    if !deposit_interest::is_reference_url(&url) {
        return Err(AppError::new(
            "URL_NOT_ALLOWED",
            "只能打开工具内置的官方利率查询入口。",
            false,
            Some(url),
        ));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| {
        AppError::new(
            "OPEN_URL_FAILED",
            "无法打开浏览器。",
            true,
            Some(e.to_string()),
        )
    })
}

/// Normalizes the requested opening folder of a file dialog.  Blank/whitespace
/// input means "let the system decide"; anything else is handed to the shell
/// as-is, without touching the filesystem.
fn dialog_start_directory(requested: Option<&str>) -> Option<&str> {
    requested.map(str::trim).filter(|value| !value.is_empty())
}

/// A selected directory authorizes its descendants, while a selected/generated
/// file only authorizes that exact file.  In particular, an authorized file
/// must never authorize one of its ancestor directories (for example `C:\`).
fn path_is_permitted(requested: &Path, allowed: &Path) -> bool {
    let requested = requested
        .canonicalize()
        .unwrap_or_else(|_| requested.to_path_buf());
    let normalized = allowed
        .canonicalize()
        .unwrap_or_else(|_| allowed.to_path_buf());
    requested == normalized || (normalized.is_dir() && requested.starts_with(&normalized))
}

#[cfg(windows)]
fn webview2_available() -> bool {
    use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for base in [
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients",
    ] {
        if let Ok(clients) = hklm.open_subkey(base) {
            for key in clients.enum_keys().flatten() {
                if let Ok(client) = clients.open_subkey(key) {
                    let name: String = client.get_value("name").unwrap_or_default();
                    if name.contains("WebView2") {
                        return true;
                    }
                }
            }
        }
    }
    false
}
#[cfg(not(windows))]
fn webview2_available() -> bool {
    false
}

/// 给集成测试用的同步调度入口：不经过 Tauri，直接按方法前缀分发到业务模块。
/// 只暴露只读的识别类方法，不碰任务、文件写入与凭据。
#[doc(hidden)]
pub fn engine_call_for_test(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    if let Some(rest) = method.strip_prefix("fx.") {
        if rest.starts_with("inspect")
            || matches!(rest, "account_roles" | "validate_mapping" | "check_mapping_alignment")
        {
            return fx::call(method, params);
        }
        // LLM 映射复核也是只读识别类：不写文件、不动任务，
        // 调查测试要用它逐份样例验证 LLM 推荐质量。API key 由
        // request_llm 自行从凭据管理器读取。
        if matches!(rest, "review_je_mapping" | "review_tb_mapping") {
            let dirs = project_dirs()?;
            let storage = Storage::new(dirs.data_local_dir())?;
            let settings = storage.settings_get()?;
            return audipick::fx_mapping_llm_call(method, &params, &settings);
        }
    }
    if let Some(rest) = method.strip_prefix("deposit.") {
        if rest.starts_with("inspect") || rest == "rate_tiers" {
            return deposit_interest::call(method, params);
        }
    }
    // 看账的只读识别类：不写文件、不动任务，调查测试用它量缓存效果。
    // 余额滚动校验是只读的，调查测试用它拿真实样例定位失配。
    if method == "fx.preview_probe" {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pause = excel_merger::PauseCheckpoint::unpaused(cancel.clone());
        return fx::run_job(
            "fx.preview",
            params,
            &|_, _, _, _| {},
            cancel,
            &pause,
        );
    }
    if method == "fx.sign_probe" {
        return fx::sign_probe_for_test(&params);
    }
    if method == "fx.rollforward_check" {
        return fx::rollforward_check_for_test(&params);
    }
    if matches!(method, "kanzhang.inspect" | "kanzhang.accounts" | "kanzhang.map") {
        return tabular::call(method, params);
    }
    // 两列匹配：inspect 只读；get_results/save_confirm 是集成测试
    // （fuzzy_roundtrip）做 落库→取回→确认 往返的落点，测试用 params.__dbPath
    // 指向临时库，不带时落本机数据目录。该入口不经前端（不在 invoke_handler
    // 里），__dbPath 不会成为外部可控参数。
    if let Some(rest) = method.strip_prefix("fuzzy.") {
        if rest == "inspect" {
            return fuzzy_match::call(method, params);
        }
        if matches!(rest, "get_results" | "save_confirm") {
            let db = params
                .get("__dbPath")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .map(PathBuf::from);
            let path = match db {
                Some(path) => path,
                None => Storage::new(project_dirs()?.data_local_dir())?.db_path(),
            };
            return fuzzy_match::storage_call(&path, method, params);
        }
    }
    Err(AppError {
        code: "METHOD_NOT_FOUND".into(),
        user_message: format!("测试入口不支持该方法：{method}"),
        retryable: false,
        diagnostic_id: String::new(),
        detail: None,
    })
}

pub fn run() {
    let dirs = project_dirs().expect("AuditToolbox data directory");
    std::fs::create_dir_all(dirs.data_local_dir()).expect("create data directory");
    let storage = Storage::new(dirs.data_local_dir()).expect("initialize local storage");
    let allowed = AllowedPaths(Arc::new(Mutex::new(HashSet::new())));
    let engine_allowed = allowed.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    // Development previews may run beside the user's installed release. Only
    // production builds enforce the single-instance hand-off.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        .manage(storage)
        .manage(allowed)
        .setup(move |app| {
            app.manage(ExcelMergerService::new(
                app.handle().clone(),
                engine_allowed.clone(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            tool_catalog,
            engine_call,
            job_start,
            job_cancel,
            job_pause,
            open_reference_url,
            settings_get,
            settings_set,
            llm_test,
            history_get,
            audipick_pdf_bytes,
            secret_set,
            secret_delete,
            legacy_import,
            pick_path,
            open_output
        ])
        .run(tauri::generate_context!())
        .expect("run Tauri application");
}

pub fn run_excel_merger_worker() -> i32 {
    excel_merger::worker_main()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_error_uses_public_contract_field_names() {
        let value = serde_json::to_value(AppError::new("TEST", "测试错误", true, None)).unwrap();
        assert_eq!(value["code"], "TEST");
        assert_eq!(value["userMessage"], "测试错误");
        assert_eq!(value["retryable"], true);
        assert_eq!(value["diagnosticId"].as_str().map(str::len), Some(12));
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn bootstrap_reports_native_rust_core_without_external_health_probe() {
        let value = app_bootstrap().unwrap();
        assert_eq!(value["engine"]["available"], true);
        assert_eq!(value["engine"]["mode"], "rust-native");
        assert_eq!(value["engine"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn bundled_catalog_contains_unique_tools() {
        let catalog = tool_catalog().unwrap();
        let rows = catalog.as_array().unwrap();
        assert_eq!(rows.len(), 17);
        let ids: HashSet<_> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids.len(), 17);
        assert!(rows.iter().all(|row| row["route"].as_str().is_some()));
    }

    #[test]
    fn fa_native_route_contract_is_explicit() {
        assert!(is_fa_llm_method("fa.review"));
        assert!(is_fa_llm_method("fa.supplement_review"));
        assert!(is_fa_llm_method("fa.dep_review"));
        assert!(!is_fa_llm_method("fa.inspect"));
        assert!(!is_fa_llm_method("fa.dep_export"));

        assert!(is_fa_job_method("fa.match"));
        assert!(is_fa_job_method("fa.preview"));
        assert!(is_fa_job_method("fa.export"));
        assert!(is_fa_job_method("fa.dep_export"));
        assert!(is_fa_job_method("fa.policy_export"));
        assert!(!is_fa_job_method("fa.unknown"));
        assert!(!is_fa_job_method("fa.dep_inspect"));

        let error = fa::call("fa.unknown", json!({})).unwrap_err();
        assert_eq!(error.code, "METHOD_NOT_FOUND");

        let mut params = json!({"beginPath":"sample.xlsx"});
        insert_fa_settings(&mut params, json!({"llm":{"enabled":true}})).unwrap();
        assert_eq!(params["__settings"]["llm"]["enabled"], true);
        let error = insert_fa_settings(&mut json!([]), json!({})).unwrap_err();
        assert_eq!(error.code, "INVALID_PARAMS");
    }

    #[test]
    fn roll_forward_native_route_contract_is_explicit() {
        assert!(is_roll_forward_job_method("roll_forward.process"));
        assert!(is_roll_forward_job_method("roll_forward.process_companies"));
        assert!(!is_roll_forward_job_method("roll_forward.unknown"));

        let error = roll_forward::call("roll_forward.unknown", json!({})).unwrap_err();
        assert_eq!(error.code, "METHOD_NOT_FOUND");

        let options = roll_forward_llm_options(
            &json!({
                "enabled": true,
                "apiType": "dify_chat",
                "model": "audit-model",
                "baseUrl": "https://llm.example/v1"
            }),
            "secret".into(),
        );
        assert_eq!(options["enabled"], true);
        assert_eq!(options["api_type"], "dify_chat");
        assert_eq!(options["api_key"], "secret");
        assert_eq!(options["model"], "audit-model");
        assert_eq!(options["base_url"], "https://llm.example/v1");
    }

    #[test]
    fn output_authorization_never_grants_ancestor_directories() {
        let root = std::env::temp_dir().join(format!(
            "audit-toolbox-output-auth-{}",
            uuid::Uuid::new_v4()
        ));
        let selected_dir = root.join("selected");
        std::fs::create_dir_all(&selected_dir).unwrap();
        let nested = selected_dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let output = selected_dir.join("result.xlsx");
        std::fs::write(&output, b"test").unwrap();

        assert!(path_is_permitted(&output, &output));
        assert!(!path_is_permitted(&selected_dir, &output));
        assert!(!path_is_permitted(&root, &output));
        assert!(path_is_permitted(&output, &selected_dir));
        assert!(path_is_permitted(&nested, &selected_dir));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dialog_start_directory_passes_paths_through_without_touching_disk() {
        assert_eq!(dialog_start_directory(None), None);
        assert_eq!(dialog_start_directory(Some("   ")), None);
        assert_eq!(dialog_start_directory(Some("")), None);
        // Unreachable UNC shares must still be forwarded: the shell falls back
        // on its own, and probing here would block until the SMB timeout.
        assert_eq!(
            dialog_start_directory(Some(r"  \\server\share\FY26  ")),
            Some(r"\\server\share\FY26")
        );
        assert_eq!(
            dialog_start_directory(Some(r"C:\does\not\exist")),
            Some(r"C:\does\not\exist")
        );
    }
}
