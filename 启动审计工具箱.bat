@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" suite_main.py
) else (
    python suite_main.py
)
if errorlevel 1 pause
