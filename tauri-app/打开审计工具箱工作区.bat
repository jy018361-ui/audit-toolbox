@echo off
chcp 65001 >nul
set "WORKSPACE=%~dp0审计工具箱.code-workspace"
set "CURSOR=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if not exist "%CURSOR%" set "CURSOR=%LOCALAPPDATA%\Programs\Cursor\Cursor.exe"
if not exist "%CURSOR%" (
    echo 未找到 Cursor，请确认已安装：%LOCALAPPDATA%\Programs\cursor\Cursor.exe
    pause
    exit /b 1
)
start "" "%CURSOR%" "%WORKSPACE%"
