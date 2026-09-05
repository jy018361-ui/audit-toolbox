mod audipick;
mod confirmation;
mod deposit_interest;
#[cfg(windows)]
mod excel_com;
mod excel_merger;
mod fa;
mod fa_subtools;
mod fa_tbje;
mod file_list;
mod fuzzy_match;
mod fx;
#[cfg(test)]
mod ledger_engine_parity_tests;
mod ledger_mapping;
mod loan_interest;
mod lpr;
mod pdf_to_excel;
mod roll_forward;
mod spreadsheet_input;
#[cfg(test)]
mod xls_input_tests;
mod storage;
mod tabular;
mod resource_budget;
mod telemetry;
mod tbje_check;
mod update_notes;
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
async fn update_release_notes(
    target_version: Option<String>,
) -> Result<update_notes::ReleaseNotes, AppError> {
    let current = env!("CARGO_PKG_VERSION");
    let target = target_version.unwrap_or_else(|| current.to_string());
    tauri::async_runtime::spawn_blocking(move || update_notes::load(current, &target))
        .await
        .map_err(|_| {
            AppError::new(
                "UPDATE_NOTES_UNAVAILABLE",
                "读取更新说明失败，请重试。",
                true,
                None,
            )
        })?
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
    } else if matches!(
        method.as_str(),
        "fx.classify_source_llm" | "deposit.classify_source_llm" | "fa_tbje.classify_source_llm"
    ) {
        let settings = storage.settings_get()?;
        let tool = match method.as_str() {
            "deposit.classify_source_llm" => "deposit_interest",
            "fa_tbje.classify_source_llm" => "fa_tbje",
            _ => "fx",
        }
        .to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            audipick::ledger_source_llm_call(&tool, &params, &settings)
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
    } else if method == "ledger.forms" {
        Ok(ledger_form_catalog(
            params.get("kind").and_then(Value::as_str).unwrap_or("tb"),
        ))
    } else if method == "ledger.check_mapping_alignment" {
        // TB与JE的跨表对齐是公共账表能力。`fx.*` 旧入口仍保留
        // 兼容，新工具必须从 ledger 命名空间调用。
        fx::check_mapping_alignment(&params)
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
    } else if method == "ledger.review_pair_mapping" {
        let settings = storage.settings_get()?;
        tauri::async_runtime::spawn_blocking(move || {
            audipick::ledger_pair_review_call(&params, &settings)
        })
        .await
        .map_err(|e| {
            AppError::new(
                "LLM_TASK_FAILED",
                "LLM 联合字段复核异常结束。",
                true,
                Some(e.to_string()),
            )
        })?
    } else if matches!(
        method.as_str(),
        "fx.review_je_mapping" | "fx.review_tb_mapping"
    ) {
        // 旧方法名只作兼容转发；实际规则、提示词和卫生过滤都走公共 TB/JE 引擎。
        let settings = storage.settings_get()?;
        let kind = if method.contains("tb") { "tb" } else { "je" }.to_owned();
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
    } else if method.starts_with("tbje_check.") {
        tauri::async_runtime::spawn_blocking(move || tbje_check::call(&method, params))
            .await
            .map_err(|e| {
                AppError::new(
                    "RUST_TASK_FAILED",
                    "TBJE 完整性核对任务异常结束。",
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

/// `job_start` 里直接转给任务通道的方法。
///
/// 与 [`excel_merger::SUPPORTED_JOB_METHODS`] 是两份清单，必须同步——
/// 只登记一处的后果是前端点下去报「未找到对应的 Rust 任务方法」，
/// `file_list.scan` 与 `tbje_check.*` 都这么栽过。测试里有一致性断言。
fn is_direct_job_method(method: &str) -> bool {
    method == "wp.generate"
        || method == "confirmation.process"
        // 扫描与导出共用同一条任务通道，两者都必须登记；此前只登记了
        // export，前端拖放文件夹自动扫描时命中兜底报"未找到对应的 Rust
        // 任务方法"。excel_merger::is_supported_job_method 里两者都在。
        || method == "file_list.export"
        || method == "file_list.scan"
        || method == "excel_merger.merge"
        || method.starts_with("ts.")
        || method.starts_with("kanzhang.")
        || matches!(method, "fx.fetch_rates" | "fx.preview" | "fx.export")
        || matches!(method, "loan.preview" | "loan.export")
        || matches!(method, "deposit.preview" | "deposit.export")
        || method == "pdf2excel.convert"
        // 两列匹配：跑匹配要落结果库，导出要从结果库读回，都走任务通道。
        || matches!(method, "fuzzy.match" | "fuzzy.export")
        // TBJE 完整性核对：单组、多组、导出三条都走任务通道——序时账动辄
        // 几十万行，读取与汇总都得能报进度、能取消。
        || method.starts_with("tbje_check.")
}

#[tauri::command]
async fn job_start(
    excel_merger: State<'_, ExcelMergerService>,
    storage: State<'_, Storage>,
    method: String,
    params: Value,
) -> Result<String, AppError> {
    // 历史记录「继续任务」要能还原现场：在注入 __settings/__llmOptions/
    // __dbPath/textPath 之前克隆用户原始参数存档。存档失败不拦任务本身，
    // 只是该条历史记录没有恢复按钮。
    let user_params = params.clone();
    let job_id = job_start_inner(excel_merger, &storage, &method, params).await?;
    let _ = storage.record_job_params(
        &job_id,
        excel_merger::tool_id(&method),
        &user_params,
    );
    Ok(job_id)
}

async fn job_start_inner(
    excel_merger: State<'_, ExcelMergerService>,
    storage: &State<'_, Storage>,
    method: &str,
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
        return excel_merger.start(method, params);
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
        inject_fa_settings(storage, &mut params)?;
        return excel_merger.start(method, params);
    }
    if method.starts_with("fa.") {
        return Err(AppError::new(
            "METHOD_NOT_FOUND",
            "未找到 Rust FA List 任务方法。",
            false,
            Some(method.to_owned()),
        ));
    }
    if is_direct_job_method(method) {
        return excel_merger.start(method, params);
    }
    if is_roll_forward_job_method(method) {
        inject_roll_forward_llm(storage, &mut params)?;
        return excel_merger.start(method, params);
    }
    if method.starts_with("roll_forward.") {
        return Err(AppError::new(
            "METHOD_NOT_FOUND",
            "未找到 Rust WP Roll Forward 任务方法。",
            false,
            Some(method.to_owned()),
        ));
    }
    Err(AppError::new(
        "METHOD_NOT_FOUND",
        "未找到对应的 Rust 任务方法。",
        false,
        Some(method.to_owned()),
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
        "fa.match"
            | "fa.preview"
            | "fa.export"
            | "fa.dep_export"
            | "fa.policy_export"
            | "fa.tbje_preview"
            | "fa.tbje_export"
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

/// 使用统计入口（前端只允许报「打开工具」；启动/任务/退出由 Rust 侧自己记录，
/// 防止任意事件名从这里灌进统计）。
#[tauri::command]
fn telemetry_track(
    telemetry: State<'_, telemetry::Telemetry>,
    event: String,
    tool_id: Option<String>,
    tool_name: Option<String>,
) -> Result<(), AppError> {
    if event != "tool_open" {
        return Err(AppError::new(
            "TELEMETRY_EVENT_DENIED",
            "不支持该统计事件。",
            false,
            Some(event),
        ));
    }
    telemetry.track(&event, tool_id.as_deref(), tool_name.as_deref(), None, None);
    Ok(())
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
fn history_clear(storage: State<'_, Storage>) -> Result<Value, AppError> {
    storage.history_clear()
}

/// 「继续任务」：取回该任务的用户参数存档，把其中仍存在的文件/目录重新
/// 授权（与 pick_path 同语义：目录授权后代，文件只授权文件本身；这是一次
/// 显式的用户点击，等价于用户重新选了一次这些文件）。已消失的路径单独
/// 返回，前端据此提醒用户重新选择。前端拿到参数后跳到对应工具页回填。
#[tauri::command]
fn history_restore(
    storage: State<'_, Storage>,
    allowed: State<'_, AllowedPaths>,
    job_id: String,
) -> Result<Value, AppError> {
    let record = storage.history_params(job_id.as_str())?;
    let params = record.get("params").cloned().unwrap_or_else(|| json!({}));
    let mut collected: Vec<String> = Vec::new();
    collect_path_like(&params, &mut collected);
    let mut missing: Vec<String> = Vec::new();
    let mut authorized = 0usize;
    for path in collected {
        let candidate = PathBuf::from(&path);
        if candidate.exists() {
            allowed.0.lock().insert(candidate);
            authorized += 1;
        } else {
            missing.push(path);
        }
    }
    Ok(json!({
        "jobId": job_id,
        "toolId": record.get("toolId").cloned().unwrap_or_else(|| json!("")),
        "params": params,
        "missingPaths": missing,
        "authorizedPathCount": authorized
    }))
}

/// 递归收集 params 里形如 Windows 绝对路径的字符串（盘符或 UNC 开头）。
/// 参数全部来自自家前端表单的文件选择，误判空间极小；相对路径、URL、
/// 普通文本一律不碰，宁少勿滥。
fn collect_path_like(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let bytes = text.as_bytes();
            let drive_like = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'/' || bytes[2] == b'\\');
            let unc_like = text.starts_with(r"\\");
            if (drive_like || unc_like) && !out.iter().any(|x| x == text) {
                out.push(text.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_path_like(item, out);
            }
        }
        Value::Object(map) => {
            for item in map.values() {
                collect_path_like(item, out);
            }
        }
        _ => {}
    }
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

/// TB 六型／JE 三型／台账四型的槽位定义下发给前端。
///
/// 型号的**唯一定义在 Rust**（`ledger_mapping::forms`）；前端据此判断当前映射
/// 命中哪一型、哪些角色在这一型里必填，不再各自抄一份。台账那份随
/// `loan.inspect` 一起下发，形状与这里一致。
fn ledger_form_catalog(kind: &str) -> Value {
    Value::Array(
        ledger_mapping::forms(kind)
            .iter()
            .map(|f| {
                serde_json::json!({
                    "id": f.id,
                    "display": f.display,
                    "label": f.label,
                    "anyOf": f.any_of,
                    "required": f.required,
                    "optional": f.optional,
                })
            })
            .collect(),
    )
}

/// 给集成测试用的同步调度入口：不经过 Tauri，直接按方法前缀分发到业务模块。
/// 只暴露只读的识别类方法，不碰任务、文件写入与凭据。
#[doc(hidden)]
pub fn engine_call_for_test(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    if method == "ledger.forms" {
        return Ok(ledger_form_catalog(
            params
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("tb"),
        ));
    }
    if method == "ledger.check_mapping_alignment" {
        return fx::check_mapping_alignment(&params);
    }
    if method == "ledger.review_mapping" || method == "ledger.review_pair_mapping" {
        let dirs = project_dirs()?;
        let storage = Storage::new(dirs.data_local_dir())?;
        let settings = storage.settings_get()?;
        if method == "ledger.review_pair_mapping" {
            return audipick::ledger_pair_review_call(&params, &settings);
        }
        let kind = params
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("je");
        return audipick::ledger_review_call(kind, &params, &settings);
    }
    if let Some(rest) = method.strip_prefix("fx.") {
        if rest == "classify_source"
            || rest.starts_with("inspect")
            || matches!(
                rest,
                "account_roles" | "validate_mapping" | "check_mapping_alignment"
            )
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
            let kind = if rest.contains("tb") { "tb" } else { "je" };
            return audipick::ledger_review_call(kind, &params, &settings);
        }
    }
    if let Some(rest) = method.strip_prefix("deposit.") {
        if rest == "classify_source" || rest.starts_with("inspect") || rest == "rate_tiers" {
            return deposit_interest::call(method, params);
        }
    }
    // 看账的只读识别类：不写文件、不动任务，调查测试用它量缓存效果。
    // 余额滚动校验是只读的，调查测试用它拿真实样例定位失配。
    if method == "fx.preview_probe" {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pause = excel_merger::PauseCheckpoint::unpaused(cancel.clone());
        return fx::run_job("fx.preview", params, &|_, _, _, _| {}, cancel, &pause);
    }
    if method == "fx.export_probe" {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let pause = excel_merger::PauseCheckpoint::unpaused(cancel.clone());
        return fx::run_job("fx.export", params, &|_, _, _, _| {}, cancel, &pause);
    }
    if method == "fx.sign_probe" {
        return fx::sign_probe_for_test(&params);
    }
    if method == "fx.rollforward_check" {
        return fx::rollforward_check_for_test(&params);
    }
    if matches!(
        method,
        "kanzhang.inspect" | "kanzhang.accounts" | "kanzhang.map"
    ) {
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
    // 使用统计只在主窗口进程启动（worker 重入走 main.rs 的提前退出，不会到这里）。
    let telemetry = telemetry::Telemetry::start(storage.db_path());
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
        .manage(telemetry.clone())
        .setup(move |app| {
            app.manage(ExcelMergerService::new(
                app.handle().clone(),
                engine_allowed.clone(),
            ));
            app.state::<telemetry::Telemetry>()
                .track("app_start", None, None, None, None);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_bootstrap,
            update_release_notes,
            tool_catalog,
            engine_call,
            job_start,
            job_cancel,
            job_pause,
            open_reference_url,
            settings_get,
            settings_set,
            telemetry_track,
            llm_test,
            history_get,
            history_clear,
            history_restore,
            audipick_pdf_bytes,
            secret_set,
            secret_delete,
            legacy_import,
            pick_path,
            open_output
        ])
        .build(tauri::generate_context!())
        .expect("build Tauri application")
        .run(|handle, event| {
            // 退出时记会话时长并尽力补发，超时即放弃（不拖慢关窗）。
            if let tauri::RunEvent::Exit = event {
                let telemetry = handle.state::<telemetry::Telemetry>();
                telemetry.track("app_exit", None, None, None, Some(telemetry.session_ms()));
                telemetry.shutdown();
            }
        });
}

pub fn run_excel_merger_worker() -> i32 {
    excel_merger::worker_main()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_path_like_only_takes_absolute_windows_paths() {
        let params = json!({
            "mode": "bank",
            "note": "C:盘见附件",
            "jePath": "C:\\data\\je.xlsx",
            "lowerDrive": "d:/tb/余额表.xlsx",
            "unc": "\\\\server\\share\\out.xlsx",
            "relative": "downloads/je.xlsx",
            "url": "https://example.com/C:/fake.xlsx",
            "nested": {"sheets": ["C:\\a.xlsx", "C:\\a.xlsx"], "depth": {"log": "E:\\logs\\"}}
        });
        let mut out = Vec::new();
        collect_path_like(&params, &mut out);
        out.sort();
        let mut expected = vec![
            "C:\\data\\je.xlsx".to_owned(),
            "d:/tb/余额表.xlsx".to_owned(),
            "\\\\server\\share\\out.xlsx".to_owned(),
            "C:\\a.xlsx".to_owned(),
            "E:\\logs\\".to_owned()
        ];
        expected.sort();
        assert_eq!(out, expected);
    }

    /// 前端按型号分组、按型号标必填，全靠这份下发的槽位定义；型号名也必须是
    /// 用户读得懂的那个（`TB-类型C`），而不是内部 id。
    #[test]
    fn ledger_form_catalog_ships_slots_and_display_names() {
        let tb = ledger_form_catalog("tb");
        let items = tb.as_array().expect("形态表应是数组");
        assert_eq!(items.len(), 6);
        assert_eq!(items[0]["id"], "TB1");
        assert_eq!(items[0]["display"], "TB-类型A");
        assert_eq!(items[5]["display"], "TB-类型F");
        // 本年累计借贷是六型共有的必填槽，缺了前端要能指名道姓。
        assert!(items.iter().all(|form| {
            form["required"]
                .as_array()
                .expect("必填槽")
                .iter()
                .any(|slot| {
                    slot.as_array()
                        .expect("槽是角色数组")
                        .contains(&serde_json::json!("ytdFunctionalDebit"))
                })
        }));
        let je = ledger_form_catalog("je");
        let je_items = je.as_array().expect("形态表应是数组");
        assert_eq!(je_items.len(), 3);
        assert!(je_items.iter().all(|form| {
            form["display"]
                .as_str()
                .unwrap_or("")
                .starts_with("JE-类型")
        }));
        let loan = ledger_form_catalog("loan");
        assert_eq!(loan.as_array().map(Vec::len), Some(4));
    }

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
        assert_eq!(rows.len(), 18);
        let ids: HashSet<_> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
        assert_eq!(ids.len(), 18);
        assert!(rows.iter().all(|row| row["route"].as_str().is_some()));
    }

    /// 任务通道的方法白名单分散在两处：`excel_merger::SUPPORTED_JOB_METHODS`
    /// 决定 worker 认不认，`is_direct_job_method` 决定 `job_start` 转不转。
    /// 只登记一处的后果是前端点下去报「未找到对应的 Rust 任务方法」——
    /// `file_list.scan` 与 `tbje_check.*` 都这么栽过，这条断言堵住它。
    #[test]
    fn 任务通道的两份白名单必须一致() {
        // 这些在 job_start 里走专属分支：转出去之前要先注入设置或文档路径，
        // 所以不经 is_direct_job_method。
        const 专属分支: &[&str] = &["audipick.batch_extract"];
        for method in excel_merger::SUPPORTED_JOB_METHODS {
            assert!(
                is_direct_job_method(method)
                    || is_fa_job_method(method)
                    || is_roll_forward_job_method(method)
                    || 专属分支.contains(method),
                "{method} 登记在 worker 白名单里，但 job_start 不会把它转过去"
            );
        }
    }

    #[test]
    fn tbje核对的四条任务方法都能进任务通道() {
        for method in [
            "tbje_check.run",
            "tbje_check.run_batch",
            "tbje_check.export",
            "tbje_check.export_batch",
        ] {
            assert!(is_direct_job_method(method), "{method}");
            assert!(
                excel_merger::SUPPORTED_JOB_METHODS.contains(&method),
                "{method}"
            );
        }
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
        assert!(is_fa_job_method("fa.tbje_preview"));
        assert!(is_fa_job_method("fa.tbje_export"));
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
