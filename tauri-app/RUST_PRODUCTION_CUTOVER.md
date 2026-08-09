# 全 Rust 生产切换记录

## 当前状态

- 九个注册工具的生产 RPC 均使用显式 Rust 白名单；未知直接方法返回 `METHOD_NOT_FOUND`，未知任务返回 `METHOD_NOT_FOUND`，未知任务编号返回 `JOB_NOT_FOUND`。
- `app_bootstrap()` 报告 `engine.mode = rust-native`，不再启动或探测 Python 进程。
- Rust 任务统一进入 Tauri EXE 自身的独立 worker，保留任务事件、暂停、取消、崩溃隔离和受限输出路径授权。
- `EngineSupervisor` 已从 Tauri state 和编译模块中移除；`build.rs` 不再读取或嵌入 `audit-engine-runtime.zip`。
- 发布脚本不调用 PyInstaller，不生成、压缩、解压或健康检查 Python sidecar。
- Python 源码、`audit_engine.spec` 和基线测试继续保留，用于迁移结果对照；它们不参与用户机器运行，也不进入发布 EXE。

## 生产路由

直接 Rust 方法包括 AudiPick、函证检查、文件清单扫描、Excel Merger 检查、TS、看账、WP 校验、FA 检查/复核，以及 Roll Forward 目录、识别、项目导出、CRA 解析和校验。

耗时 Rust worker 方法包括：

- `wp.generate`
- `confirmation.process`
- `file_list.export`
- `excel_merger.merge`
- TS 与看账的缓存、筛选、透视和导出任务
- `audipick.batch_extract`
- `fa.match`、`fa.preview`、`fa.export`
- `roll_forward.process`、`roll_forward.process_companies`

FA 和 Roll Forward 的全局 LLM 设置仍由 Rust 主进程注入，密钥只从 Windows Credential Manager 读取。

## 发布门禁

`scripts/build_tauri_release.py` 继续运行 Python 历史金标、React、AudiPick 和 Rust 测试，但只构建 Tauri/Rust 发布物。发布后会通过 Tauri EXE 自身的 worker 入口验收 Excel Merger、TS、看账、FA、WP 和 Roll Forward，并检查输出文件和完成事件。

桌面冷启动执行两项反向断言：

1. Tauri 进程没有名为 `audit-engine.exe` 的子进程。
2. `%LOCALAPPDATA%\AuditToolbox\AuditToolbox\data\runtime` 没有新增 Python runtime 文件。

发布脚本生成单文件 EXE 和 SHA-256，不覆盖旧稳定包。本记录不替代九工具真实脱敏样例验收；尤其 FA、AudiPick 和 Roll Forward 的高风险边界仍需继续做语义金标对比。
