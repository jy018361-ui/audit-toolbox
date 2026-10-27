//! 数据流（DataFlow）第一期 Rust 执行引擎。
//!
//! 结构：
//! - [`model`]：工作流 JSON 的 serde 模型（camelCase，与前端契约一致）；
//! - [`value`]：列值类型系统（文本/整数/定点十进制/日期 + 空值/布尔中间类型）；
//! - [`formula`]：自写递归下降公式求值器（设计文档第 5 节函数集）；
//! - [`nodes`]：8 个节点实现（excel_in / csv_in / select / clean / formula /
//!   filter / excel_out / csv_out）；
//! - [`engine`]：拓扑排序执行与响应契约（`run_workflow`）。
//!
//! 已接线 lib.rs 的 engine_call：dataflow_preview / dataflow_run 由 lib.rs
//! 注入 __allowedPaths（本会话已授权路径）后转 run_workflow；
//! dataflow_save_workflow 落盘流程文件。全量运行接入 job/worker 体系属
//! 第三期，届时须同时登记 excel_merger::SUPPORTED_JOB_METHODS 与
//! lib.rs::is_direct_job_method 两份清单。

#![allow(dead_code)]

use crate::AppError;

pub(crate) mod engine;
pub(crate) mod formula;
pub(crate) mod model;
pub(crate) mod nodes;
pub(crate) mod value;

#[allow(unused_imports)]
pub(crate) use engine::run_workflow;

/// engine_call("dataflow_save_workflow")：UTF-8 写入流程 JSON 文本。
/// 路径授权由 lib.rs 分支按 pickPath("save") 登记的路径先行校验。
pub(crate) fn save_workflow(path: &str, content: &str) -> Result<serde_json::Value, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::new(
            "DATAFLOW_CONFIG_INVALID",
            "流程文件保存路径为空。",
            false,
            None,
        ));
    }
    let target = std::path::Path::new(path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::new(
                    "DATAFLOW_SAVE_FAILED",
                    format!("流程文件目录创建失败：{error}"),
                    true,
                    None,
                )
            })?;
        }
    }
    std::fs::write(target, content).map_err(|error| {
        AppError::new(
            "DATAFLOW_SAVE_FAILED",
            format!("流程文件写入失败：{error}"),
            true,
            None,
        )
    })?;
    Ok(serde_json::json!({ "path": path }))
}
