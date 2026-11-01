# Jivvu - AI Quiz & Coding Companion (QuizZy Engine)

Production-grade, windowless AI quiz and coding practice assistant for **learning.ccbp.in**. Powered by a FastAPI backend with dual LLM provider fallback (Groq + OpenRouter), Chrome Manifest V3 extension, balanced 8px HUD dot, and a zero-latency native lifecycle manager.

---

## Architecture & How It Works

```
                        +----------------------------+
                        |   Google Chrome / Edge     |
                        |   learning.ccbp.in Tab     |
                        +--------------+-------------+
                                       |
                [Navigation Event / Heartbeat (4s)]
                                       v
                        +----------------------------+
                        |  Extension Service Worker  |
                        |     (background.js)        |
                        +--------------+-------------+
                                       |
             +-------------------------+-------------------------+
             | Dual-Channel OS Bridge                            |
             v (Channel A: Fast HTTP)                            v (Channel B: Native stdio)
+----------------------------+              +----------------------------+
|  Dashboard Daemon (:8765)  |              |  Native Messaging Host     |
|   (backend.cli daemon)     |              |   (native_host_win.exe)    |
+--------------+-------------+              +--------------+-------------+
               \                                          /
                \--->  Spawns Windowless Daemon  <-------/
                               |
                               v
                +----------------------------+
                |    FastAPI Solver Backend  |
                |   (127.0.0.1:8000/solve)   |
                +--------------+-------------+
                               |
            +------------------+------------------+
            v                                     v
    +---------------+                     +----------------+
    |  Groq Cloud   | (Primary Cascade)   |   OpenRouter   | (Hedged Secondary)
    +---------------+                     +----------------+
```

### Key Highlights
- **100% Windowless & Silent**: Uses `pythonw.exe` and `native_host_win.exe` with `CREATE_NO_WINDOW`. Zero annoying black terminal popups or flickering console windows.
- **Auto-Lifecycle on CCBP**: Opening `https://learning.ccbp.in` immediately boots the backend and displays the unobtrusive on-page HUD. Closing all CCBP tabs automatically debounces and shuts down the backend within 3 seconds to save RAM and release port 8000.
- **Dual LLM Consensus Engine**: Free-tier Groq (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`) with automatic hedged fallback to OpenRouter (`nemotron-3.5-super-vl`, `gemma-4-31b-it`).
- **Observability Dashboard**: Built-in real-time telemetry dashboard on `http://127.0.0.1:8765` for model selection, latency charts, and request inspection.

---

## One-Click Quick Setup (Recommended)

### Prerequisites (Install Once)
1. **Windows 10 / 11** (64-bit)
2. **Python 3.10+**: Download from [python.org](https://www.python.org/downloads/).  
   > ⚠️ **CRITICAL**: Check the box **"Add Python to PATH"** in the Python installer!
3. **Google Chrome** (or Microsoft Edge)
4. **Git**: Download from [git-scm.com](https://git-scm.com/)

---

### Step 1: Clone the Repository
Open PowerShell or Command Prompt:
```cmd
git clone https://github.com/codewithjaswanth/Jivvu.git
cd Jivvu
```

### Step 2: Run One-Click Setup
Double-click `setup.bat` (or run in terminal):
```cmd
setup.bat
```
*(Or via PowerShell: `.\setup.ps1`)*

**What `setup.bat` automatically configures:**
- Creates isolated virtual environment at `.venv`
- Installs all dependencies from `requirements.txt`
- Creates `backend\.env` secrets file from template
- Registers the Native Messaging Host in Windows Registry (`HKCU\Software\Google\Chrome\NativeMessagingHosts`)
- Registers the silent background lifecycle daemon in Windows Startup
- Generates a desktop shortcut (`Jev.lnk`) with the custom icon

---

### Step 3: Configure Free API Keys
Open `backend\.env` in Notepad:
```cmd
notepad backend\.env
```
Paste at least one free API key:
- **Groq API Key** (Free, ultra-fast 500+ tok/s): [https://console.groq.com/keys](https://console.groq.com/keys)
  ```env
  GROQ_API_KEY=gsk_your_key_here
  ```
- **OpenRouter API Key** (Free models fallback): [https://openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)
  ```env
  OPENROUTER_API_KEY=sk-or-v1-your_key_here
  ```
Save and close the file.

---

### Step 4: Load Extension in Google Chrome
1. In Google Chrome, go to the extensions management page:
   ```
   chrome://extensions
   ```
2. In the top-right corner, turn **ON** **Developer mode**.
3. In the top-left corner, click **Load unpacked**.
4. In the folder browser, select the **`extension`** folder inside your cloned `Jivvu` directory:
   ```
   C:\path\to\Jivvu\extension
   ```
5. *(Optional)* Click the Puzzle icon in Chrome's toolbar and pin **QuizZy - Side Panel Quiz Assistant**.

---

### Step 5: Test & Verify
1. Open [https://learning.ccbp.in](https://learning.ccbp.in) in Chrome.
2. Notice the small **8px balanced HUD dot** appear on the page.
3. The backend starts automatically on `127.0.0.1:8000` in the background with zero terminal popups.
4. **Hotkeys**:
   - `Alt + S`: Solve current question (MCQ, ordering, multi-select, fill-in-the-blank, coding).
   - `Alt + A`: Apply the answer / input into code editor.
   - `Alt + N`: Navigate to next question.
   - `Shift` (Double-tap): Toggle Auto-Solve mode.
   - `Alt + M`: Open Side Panel assistant.

---

## Manual Installation (Step-by-Step for Senior Developers)

If you prefer to inspect and run every step manually:

### 1. Create Virtual Environment
```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Configure Environment Variables
```powershell
Copy-Item backend\.env.example backend\.env
notepad backend\.env
```

### 3. Register Chrome Native Messaging Host
```powershell
.\.venv\Scripts\python.exe backend\native_host.py --register
```
This dynamically resolves your repository path, writes `backend\com.quizzy.lifecycle.json` with the exact absolute binary path, and writes registry keys:
- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.quizzy.lifecycle`
- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.quizzy.launcher`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.quizzy.lifecycle`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.quizzy.launcher`

### 4. Create Desktop Shortcut & Background Daemon
```powershell
.\.venv\Scripts\python.exe -m backend.cli shortcut --name "Jev"
.\.venv\Scripts\python.exe -m backend.cli daemon
```

### 5. Run Full Test Suite Verification
```powershell
.\test.bat
# or
.\.venv\Scripts\python.exe -m pytest tests -q
```
Expected output: **`222 passed in ~110s`** (100% pass rate).

---

## Managing the Backend & Observability Dashboard

### Desktop Dashboard App
Double-click the **Jev** shortcut on your Desktop, or run:
```powershell
quizzy dashboard
# or
.\.venv\Scripts\python.exe -m backend.cli dashboard
```
Opens the telemetry and model management dashboard at `http://127.0.0.1:8765`:
- **Model Selector**: Switch between Auto Intelligent Cascade, Groq-only, OpenRouter-only, or individual models.
- **Latency & Reliability Metrics**: Real-time request telemetry, consensus agreement, and accuracy scoring.
- **Backend Lifecycle Pill**: Shows live server status (Online / Standby).

### Diagnostic Commands
| Command | Action |
|---|---|
| `.\.venv\Scripts\python.exe backend\native_host.py --status` | Check if backend is currently online |
| `.\.venv\Scripts\python.exe backend\native_host.py --start` | Manually start the backend |
| `.\.venv\Scripts\python.exe backend\native_host.py --stop` | Manually stop the backend |
| `.\.venv\Scripts\python.exe backend\native_host.py --ping` | Ping native messaging stdio host |
| `test.bat` | Run all 222 unit and integration tests |

---

## Troubleshooting Guide

### 1. "Specified native messaging host not found" in Chrome
- Run `setup.bat` or `.\.venv\Scripts\python.exe backend\native_host.py --register`.
- Verify the registry key exists in PowerShell:
  ```powershell
  Get-ItemProperty -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.quizzy.lifecycle"
  ```
- Make sure the path points to `backend\native_host_win.exe` or `backend\native_host.cmd`.

### 2. Backend doesn't start when opening learning.ccbp.in
- Verify the extension is enabled in `chrome://extensions`.
- Click the extension icon in Chrome or inspect the background service worker console.
- Verify `127.0.0.1:8765` is running:
  ```powershell
  curl.exe -s http://127.0.0.1:8765/api/dashboard/ping
  ```
  If not running, run `.\.venv\Scripts\python.exe -m backend.cli daemon`.

### 3. Port 8000 Conflict
If port 8000 is occupied by a stale process:
```powershell
.\.venv\Scripts\python.exe -c "from backend.lifecycle_manager import clean_port_8000; clean_port_8000()"
```

---

## Repository & Remote Tracking
- **Primary Origin**: `https://github.com/codewithjaswanth/Jivvu.git` (`main` branch)
- **Engine Version**: QuizZy 1.0.0 MV3 Production
