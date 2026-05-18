@echo off
cd /d "%~dp0"
if /i not "%~1"=="GO" (
    start "Suite-Pack" cmd /k "%~f0" GO
    exit /b 0
)

set EXIT_CODE=1
echo [%date% %time%] start > pack_build.log

title Audit Suite Pack

echo ========================================
echo   Audit Toolbox - sync and pack
echo ========================================
echo.

if exist ".venv\Scripts\python.exe" goto use_venv
where py >NUL 2>&1
if %ERRORLEVEL%==0 goto use_py
where python >NUL 2>&1
if %ERRORLEVEL%==0 goto use_python
echo [ERROR] Python not found.
goto done

:use_venv
set PY=.venv\Scripts\python.exe
goto run

:use_py
set PY=py -3
goto run

:use_python
set PY=python
goto run

:run
echo Using %PY%
echo sync vendor...
%PY% "%~dp0build_suite.py" --sync-only
if not %ERRORLEVEL%==0 goto done
echo.
echo packing...
%PY% "%~dp0build_suite.py" --no-baseline
set EXIT_CODE=%ERRORLEVEL%
goto done

:done
echo [%date% %time%] exit %EXIT_CODE% >> pack_build.log
echo.
if %EXIT_CODE%==0 (
    echo [OK] dist:
    dir /b "%~dp0dist\*.exe" 2>NUL
) else (
    echo [FAIL] code=%EXIT_CODE%
)
echo.
pause
exit /b %EXIT_CODE%
