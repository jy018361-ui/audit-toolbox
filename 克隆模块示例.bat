@echo off
chcp 65001 >nul
cd /d "%~dp0modules"
echo 请将下面的示例地址改成同事仓库的真实 URL
echo 目录名必须与 tools.json 中的 vendor_dir 一致
echo.
echo 示例:
echo   git clone https://github.com/xxx/fa_list.git fa_list
echo   git clone https://github.com/xxx/kanzhang.git kanzhang
echo.
pause
