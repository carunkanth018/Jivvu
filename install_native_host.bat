@echo off
setlocal
cd /d "%~dp0"

echo =========================================================
echo       QuizZy Native Messaging Host Registration          
echo =========================================================
echo.

set "PYTHON_EXE="
if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0.venv\Scripts\python.exe"
) else if exist "%~dp0..\.venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0..\.venv\Scripts\python.exe"
)

if "%PYTHON_EXE%"=="" (
    echo [ERROR] Virtual environment python.exe not found!
    exit /b 1
)

"%PYTHON_EXE%" "%~dp0backend\native_host.py" --register %*

echo.
pause

