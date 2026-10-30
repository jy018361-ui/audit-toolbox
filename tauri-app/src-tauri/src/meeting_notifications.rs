//! Windows 通知点击只传任务编号；文件与历史读取继续走已有授权边界。
use crate::AppError;
use serde_json::json;
use tauri::{Emitter, Manager};

#[tauri::command]
pub(crate) async fn meeting_notify(
    app: tauri::AppHandle,
    job_id: String,
    title: String,
    body: String,
) -> Result<(), AppError> {
    if job_id.len() > 200 || title.len() > 200 || body.len() > 4000 {
        return Err(AppError::new(
            "MEETING_NOTIFICATION_INVALID",
            "会议通知内容过长。",
            false,
            None,
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let activated_app = app.clone();
        tauri_winrt_notification::Toast::new(&app.config().identifier)
            .title(&title)
            .text1(&body)
            .on_activated(move |_| {
                if let Some(window) = activated_app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("meeting-notification-open", json!({"jobId": job_id}));
                }
                Ok(())
            })
            .show()
            .map_err(|_| {
                AppError::new(
                    "MEETING_NOTIFICATION_FAILED",
                    "Windows 通知未能显示，请在会议历史中查看结果。",
                    true,
                    None,
                )
            })
    })
    .await
    .map_err(|_| {
        AppError::new(
            "MEETING_NOTIFICATION_FAILED",
            "会议通知任务未完成。",
            true,
            None,
        )
    })?
}
