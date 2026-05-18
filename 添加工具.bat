@echo off
chcp 65001 >nul
echo ================================
echo    添加新工具到审计工具箱
echo ================================
echo.
echo 正在启动添加工具界面...
echo.
python "%~dp0添加工具.py"
pause
