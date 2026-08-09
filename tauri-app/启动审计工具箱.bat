@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 启动 Tauri 迁移版审计工具箱
if exist "..\.venv\Scripts\python.exe" (
    "..\.venv\Scripts\python.exe" scripts\start_tauri_dev.py
) else (
    python scripts\start_tauri_dev.py
)
if errorlevel 1 pause
