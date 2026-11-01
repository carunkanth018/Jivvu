@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0..\.venv\Scripts\python.exe" (
    "%~dp0..\.venv\Scripts\python.exe" -u "%~dp0launcher.py" %*
) else (
    "C:\Users\jassh\Jev\.venv\Scripts\python.exe" -u "%~dp0launcher.py" %*
)
