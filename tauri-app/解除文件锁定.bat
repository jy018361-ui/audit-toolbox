@echo off
cd /d "%~dp0"
echo Unblocking files in this folder (Zone.Identifier)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '.' -Recurse -Force | Unblock-File -ErrorAction SilentlyContinue"
echo Done. Try pack bat again.
pause
