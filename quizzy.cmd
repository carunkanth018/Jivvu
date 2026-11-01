@echo off
setlocal
set "PYTHONPATH=%~dp0;%PYTHONPATH%"
"%~dp0.venv\Scripts\python.exe" -m backend.cli %*
endlocal

