@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0..\.venv\Scripts\pythonw.exe" (
    "%~dp0..\.venv\Scripts\pythonw.exe" -u "%~dp0native_host.py" %*
) else if exist "%~dp0..\.venv\Scripts\python.exe" (
    "%~dp0..\.venv\Scripts\python.exe" -u "%~dp0native_host.py" %*
) else (
    "C:\Users\jassh\Jev\.venv\Scripts\pythonw.exe" -u "%~dp0native_host.py" %*
)
