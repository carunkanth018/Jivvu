@echo off
setlocal enabledelayedexpansion
title QuizZy / Jivvu One-Click Setup
cd /d "%~dp0"

echo =====================================================================
echo                QuizZy / Jivvu Setup & Installer                     
echo =====================================================================
echo [1/6] Checking Python installation...

set "SYS_PYTHON="
for %%P in (python.exe py.exe) do (
    where %%P >nul 2>nul
    if !errorlevel! equ 0 (
        if not defined SYS_PYTHON set "SYS_PYTHON=%%P"
    )
)

if not defined SYS_PYTHON (
    echo [ERROR] Python was not found in your system PATH!
    echo Please download and install Python 3.10+ from https://www.python.org/
    echo IMPORTANT: Make sure to check the box "Add Python to PATH" during installation.
    pause
    exit /b 1
)

echo Found system Python: !SYS_PYTHON!

echo.
echo [2/6] Configuring virtual environment (.venv)...
if not exist "%~dp0.venv\Scripts\python.exe" (
    echo Creating virtual environment at %~dp0.venv ...
    !SYS_PYTHON! -m venv "%~dp0.venv"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create virtual environment!
        pause
        exit /b 1
    )
)
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"
echo Virtual environment ready: !VENV_PYTHON!

echo.
echo [3/6] Installing Python dependencies from requirements.txt...
"!VENV_PYTHON!" -m pip install --upgrade pip -q
"!VENV_PYTHON!" -m pip install -r "%~dp0requirements.txt" -q
if !errorlevel! neq 0 (
    echo [ERROR] Dependency installation failed! Check requirements.txt.
    pause
    exit /b 1
)
echo Dependencies installed successfully.

echo.
echo [4/6] Setting up environment configuration...
if not exist "%~dp0backend\.env" (
    if exist "%~dp0backend\.env.example" (
        copy "%~dp0backend\.env.example" "%~dp0backend\.env" >nul
        echo Created backend\.env from template. (Remember to add your API keys!)
    )
) else (
    echo backend\.env already exists.
)

echo.
echo [5/6] Registering Native Messaging Host & Windows Startup...
rem Ensure native_host_win.exe exists; compile if missing using system csc.exe
if not exist "%~dp0backend\native_host_win.exe" (
    if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
        "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /out:"%~dp0backend\native_host_win.exe" "%~dp0backend\native_host_win.cs" >nul 2>&1
    ) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
        "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /target:winexe /out:"%~dp0backend\native_host_win.exe" "%~dp0backend\native_host_win.cs" >nul 2>&1
    )
)

"!VENV_PYTHON!" "%~dp0backend\native_host.py" --register
if !errorlevel! neq 0 (
    echo [WARNING] Native host registration returned code !errorlevel!.
)

echo.
echo [6/6] Creating Desktop Shortcuts & Startup Daemon...
"!VENV_PYTHON!" -m backend.cli shortcut --name "Jev" >nul 2>&1
"!VENV_PYTHON!" -m backend.cli daemon >nul 2>&1

echo.
echo =====================================================================
echo                      SETUP COMPLETED SUCCESSFULLY!                   
echo =====================================================================
echo.
echo Next Steps (Takes 30 seconds):
echo.
echo 1. CONFIGURE API KEYS:
echo    Open "%~dp0backend\.env" in Notepad and paste your free Groq/OpenRouter keys:
echo    - Groq: https://console.groq.com/keys
echo    - OpenRouter: https://openrouter.ai/settings/keys
echo.
echo 2. LOAD CHROME EXTENSION:
echo    a. In Google Chrome, navigate to: chrome://extensions
echo    b. Turn ON "Developer mode" (toggle in top right corner).
echo    c. Click "Load unpacked" (top left button).
echo    d. Select the folder: "%~dp0extension"
echo.
echo 3. READY TO USE:
echo    Open https://learning.ccbp.in in Chrome.
echo    The backend and assistant will start automatically in the background!
echo    Use Alt+S or the on-screen HUD dot to solve questions instantly.
echo =====================================================================
echo.
pause

