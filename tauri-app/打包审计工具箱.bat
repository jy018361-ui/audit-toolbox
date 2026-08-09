@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 打包审计工具箱

echo ========================================
echo   审计工具箱 Tauri 单文件打包
echo ========================================
echo.

where python >nul 2>nul || goto :missing_python
where npm >nul 2>nul || goto :missing_node
if not exist "%USERPROFILE%\.cargo\bin\cargo.exe" goto :missing_rust

python scripts\build_tauri_release.py
if errorlevel 1 goto :failed

echo.
echo 打包成功，正在打开输出目录...
start "" "%~dp0dist"
exit /b 0

:missing_python
echo 未找到 Python，请安装 Python 3.12 x64。
goto :failed

:missing_node
echo 未找到 npm，请安装 Node.js 22 x64。
goto :failed

:missing_rust
echo 未找到 Rust，请安装 rustup stable-msvc 与 Visual Studio C++ Build Tools。
goto :failed

:failed
echo.
echo 打包失败。现有稳定版 EXE 不受影响。
pause
exit /b 1
