<#
.SYNOPSIS
    QuizZy / Jivvu One-Click Setup Script for Windows PowerShell.
.DESCRIPTION
    Configures virtual environment, installs requirements, registers Native Messaging Host,
    sets up background daemon, creates desktop shortcuts, and verifies environment.
#>

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "               QuizZy / Jivvu Setup & Installer (PowerShell)         " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Check Python
Write-Host "`n[1/6] Checking Python installation..." -ForegroundColor Yellow
$sysPython = (Get-Command python.exe -ErrorAction SilentlyContinue)
if (-not $sysPython) {
    $sysPython = (Get-Command py.exe -ErrorAction SilentlyContinue)
}
if (-not $sysPython) {
    Write-Host "[ERROR] Python was not found in PATH!" -ForegroundColor Red
    Write-Host "Please install Python 3.10+ from https://www.python.org/ and check 'Add Python to PATH'." -ForegroundColor Red
    exit 1
}
Write-Host "Found Python: $($sysPython.Source)" -ForegroundColor Green

# 2. Virtual environment
Write-Host "`n[2/6] Configuring virtual environment (.venv)..." -ForegroundColor Yellow
$venvDir = Join-Path $repoRoot ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Host "Creating virtual environment at $venvDir ..."
    & $sysPython.Source -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create virtual environment."
    }
}
Write-Host "Virtual environment ready: $venvPython" -ForegroundColor Green

# 3. Dependencies
Write-Host "`n[3/6] Installing dependencies from requirements.txt..." -ForegroundColor Yellow
$reqFile = Join-Path $repoRoot "requirements.txt"
& $venvPython -m pip install --upgrade pip -q
& $venvPython -m pip install -r $reqFile -q
if ($LASTEXITCODE -ne 0) {
    throw "pip install failed."
}
Write-Host "Dependencies installed successfully." -ForegroundColor Green

# 4. Configuration
Write-Host "`n[4/6] Setting up environment configuration..." -ForegroundColor Yellow
$envPath = Join-Path $repoRoot "backend\.env"
$envExample = Join-Path $repoRoot "backend\.env.example"
if (-not (Test-Path $envPath) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envPath
    Write-Host "Created backend\.env template. (Remember to configure your API keys!)" -ForegroundColor Green
} else {
    Write-Host "backend\.env already present." -ForegroundColor Green
}

# 5. Native Host & Windows Registry
Write-Host "`n[5/6] Registering Native Messaging Host & Windows Startup..." -ForegroundColor Yellow
$nativeExe = Join-Path $repoRoot "backend\native_host_win.exe"
$nativeCs = Join-Path $repoRoot "backend\native_host_win.cs"

if (-not (Test-Path $nativeExe) -and (Test-Path $nativeCs)) {
    $csc64 = "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    $csc32 = "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    $csc = if (Test-Path $csc64) { $csc64 } elseif (Test-Path $csc32) { $csc32 } else { $null }
    if ($csc) {
        Write-Host "Compiling native_host_win.exe via system csc.exe..."
        & $csc /target:winexe /out:"$nativeExe" "$nativeCs" | Out-Null
    }
}

$nativePy = Join-Path $repoRoot "backend\native_host.py"
& $venvPython "$nativePy" --register
Write-Host "Native Messaging Host registered in Windows Registry." -ForegroundColor Green

# 6. Desktop Shortcut & Background Daemon
Write-Host "`n[6/6] Creating Desktop Shortcuts & Startup Daemon..." -ForegroundColor Yellow
& $venvPython -m backend.cli shortcut --name "Jev"
& $venvPython -m backend.cli daemon
Write-Host "Desktop shortcut created & daemon registered." -ForegroundColor Green

Write-Host "`n=====================================================================" -ForegroundColor Cyan
Write-Host "                      SETUP COMPLETED SUCCESSFULLY!                  " -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "`nNext Steps:" -ForegroundColor Yellow
Write-Host "1. CONFIGURE API KEYS: Open 'backend\.env' and paste your free Groq / OpenRouter keys."
Write-Host "2. LOAD EXTENSION: Open Chrome -> chrome://extensions -> Toggle 'Developer mode' -> 'Load unpacked' -> Select the 'extension' folder."
Write-Host "3. START: Open https://learning.ccbp.in. The backend and desktop app will start automatically!`n"

