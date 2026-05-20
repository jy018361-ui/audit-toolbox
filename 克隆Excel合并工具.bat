@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MODULE=modules\excel_merger
set REPO=https://github.com/JY01013232/Excel-Merger.git

echo 正在克隆 Excel-Merger 到 %MODULE% ...
if exist "%MODULE%\.git" (
    echo 目录已存在，执行 git pull ...
    cd "%MODULE%"
    git pull
    cd /d "%~dp0"
) else (
    if exist "%MODULE%" rmdir /s /q "%MODULE%"
    git clone --depth 1 "%REPO%" "%MODULE%"
    if errorlevel 1 (
        echo 克隆失败，请检查网络与 Git 是否已安装。
        pause
        exit /b 1
    )
)

echo 复制 Hub 入口 main.py ...
copy /Y "module_entries\excel_merger\main.py" "%MODULE%\main.py" >nul

echo.
echo 完成。请运行: python suite_main.py
echo 或在 tools.json 中确认已注册 id=excel_merger 后执行: python build_suite.py
echo.
pause
