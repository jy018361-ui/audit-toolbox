//! 数据流（DataFlow）Rust 执行引擎（第一期 8 类节点 + 第二期 12 类节点、
//! 「运行到选中节点」、数据库表清单）。
//!
//! 结构：
//! - [`model`]：工作流 JSON 的 serde 模型（camelCase，与前端契约一致）；
//! - [`value`]：列值类型系统（文本/整数/定点十进制/日期 + 空值/布尔中间类型）；
//! - [`formula`]：自写递归下降公式求值器（设计文档第 5 节函数集）；
//! - [`nodes`]：20 类节点实现 + 数据库表清单 `db_tables`；
//! - [`engine`]：拓扑排序执行与响应契约（`run_workflow`，支持 uptoNodeId
//!   「运行到选中节点」——只执行该节点及其全部上游的反向闭包）。
//!
//! 已接线 lib.rs 的 engine_call：dataflow_preview / dataflow_run 由 lib.rs
//! 注入 __allowedPaths（本会话已授权路径）后转 run_workflow；
//! dataflow_save_workflow 落盘流程文件。`db_tables` 期望接线为
//! engine_call("dataflow_db_tables", {path})（lib.rs 先做与 pick_path 相同
//! 语义的路径授权校验再调用，见第二期交付报告）。全量运行接入 job/worker
//! 体系属第三期，届时须同时登记 excel_merger::SUPPORTED_JOB_METHODS 与
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
#[allow(unused_imports)]
pub(crate) use nodes::inputs2::db_tables;

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
