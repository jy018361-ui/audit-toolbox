# 审计工具箱 Tauri 版

本目录是新版审计工具箱的完整独立工程，包含 React 前端、Rust/Tauri 核心、
生产资源、验收样例、启动脚本、打包脚本和发布产物。

## 日常启动

双击 `启动审计工具箱.bat`。首次启动或源码变更后会编译；之后复用缓存。
若只使用已发布程序，直接运行 `dist` 目录中的最新版 EXE，不会编译。

## 单文件打包

双击 `打包审计工具箱.bat`。默认执行 Tauri 前端和 Rust 测试、构建单文件、
校验 SHA-256，并执行各 Rust 工具的 EXE 冒烟测试。

如需额外核对上一级旧 Python/Electron 金标，可运行：

```powershell
python scripts/build_tauri_release.py --legacy-regression
```

旧 `launcher`、`tools`、`modules`、`audit_engine` 仅保留在上一级目录作为迁移
基线；新版生产运行和默认打包不依赖它们。
