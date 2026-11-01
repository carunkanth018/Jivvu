# QuizZy Observability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade, real-time QuizZy Observability Dashboard served on `http://127.0.0.1:8765` and a global CLI launcher (`quizzy dashboard`) that opens in Google Chrome and visualizes live and historical telemetry for the QuizZy backend (`http://127.0.0.1:8000`).

**Architecture:** Decoupled dual-server architecture:
1. `backend/telemetry_db.py` uses SQLite with WAL mode (`journal_mode=WAL`) allowing concurrent reads and writes between the main solver backend (port 8000) and the dashboard server (port 8765) with zero locks.
2. `backend/app.py` instruments all solve/evaluation requests, computing latency via `perf_counter()` and evaluating Strict Accuracy (Zero-Hallucination option validation).
3. `backend/dashboard_server.py` runs on port 8765, actively polling `127.0.0.1:8000/health` every 2s and providing REST APIs for dashboard telemetry.
4. `backend/static/dashboard/` contains a zero-build dark-mode observability SPA.
5. `backend/cli.py` + global wrappers provide the `quizzy dashboard` CLI command.

**Tech Stack:** Python 3.12, FastAPI, SQLite3 (WAL mode), HTML5/CSS3/Vanilla JS (ES6+), Google Chrome launcher, Pytest.

**Spec:** Direct requirements in USER_REQUEST.

## Global Constraints
- Decoupled server: `dashboard_server.py` on `127.0.0.1:8765` must run independently and report `OFF` if port 8000 is stopped.
- Never crash solver: Telemetry logging errors must never cause a solve request to fail.
- Strict non-hallucination check: Options-based questions must verify the chosen option strictly belongs to the input options.
- Zero-build frontend: Vanilla HTML/CSS/JS in `backend/static/dashboard/`.
- Strict launch rule: Dashboard server/browser opens ONLY via `quizzy dashboard`.
- Deterministic runtime: Use `.\.venv\Scripts\python.exe`.

## Review Focus
1. Port 8000 is down: Dashboard UI and `/api/dashboard/backend-status` must cleanly return `{"online": false, "status_label": "OFF"}` without throwing 500s.
2. Hallucinated option in solve: Solver returning an option not in `req.options` must score `is_accurate = 0` and `error_type = 'HALLUCINATED_OPTION'`.
3. Empty answer in solve: Succeeded request returning null/blank answer must score `is_accurate = 0` and `error_type = 'EMPTY_ANSWER'`.
4. Concurrent database access: Both servers read and write `backend/telemetry.db` simultaneously without database locked errors.
5. Global CLI launcher: `quizzy dashboard` executes seamlessly from any directory in PowerShell and cmd.

---

### Task 1: Persistent Telemetry Storage (`backend/telemetry_db.py`)

**Files:**
- Create: `backend/telemetry_db.py`
- Test: `tests/test_dashboard.py`

**Steps:**
- [x] Implement `init_db(db_path=None)` with SQLite WAL mode (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`).
- [x] Create `request_logs` table with columns: `id`, `timestamp`, `endpoint`, `subject`, `q_type`, `question_text`, `options_json`, `selected_answer`, `selected_index`, `canonical_key`, `status`, `is_accurate`, `error_type`, `error_message`, `latency_ms`, `model_name`, `cache_hit`, `raw_response_preview`.
- [x] Create indexes on `timestamp`, `status`, `error_type`, `is_accurate`.
- [x] Implement `record_request_log(...)` wrapped in try/except to ensure safe persistence.
- [x] Implement `get_dashboard_summary(window="all", db_path=None)` computing:
  - `total_requests`, `success_count`, `failure_count`, `success_rate`, `error_rate`, `accuracy_rate`
  - `avg_latency_ms`, `min_latency_ms`, `max_latency_ms`, `p95_latency_ms`
  - `overall_performance` (50% accuracy + 30% success + 20% latency score, grade)
  - `error_breakdown` (counts and % for all enum error types)
  - `timeline` (last 50 requests)
- [x] Implement `get_request_logs(...)`, `get_request_detail(...)`, and `clear_logs(...)`.
- [x] Write unit tests in `tests/test_dashboard.py` verifying database operations and KPI calculations.

---

### Task 2: Instrument `backend/app.py` & Solver Pipeline

**Files:**
- Modify: `backend/app.py`
- Modify: `backend/schemas.py`
- Test: `tests/test_dashboard.py`

**Steps:**
- [x] Update `backend/schemas.py` `HealthResponse` to include `timestamp: float` and `uptime_seconds: float` with defaults.
- [x] Update `GET /health` in `backend/app.py` to return current timestamp and uptime based on server start time.
- [x] Implement `validate_accuracy_and_classify_error` in `backend/app.py` (or helper module) for strict non-hallucination validation and deterministic error classification.
- [x] Instrument `/solve` and `/debug/solve` using high-precision `time.perf_counter()`, capturing both success responses and exceptions (`HTTPException`, `ValidationError`, timeouts, 500s) into `telemetry_db.record_request_log`.
- [x] Add exception handling / middleware to log unhandled endpoint errors to telemetry.
- [x] Run targeted tests in `tests/test_dashboard.py` to verify instrumentation.

---

### Task 3: Build Standalone Dashboard Server (`backend/dashboard_server.py`)

**Files:**
- Create: `backend/dashboard_server.py`
- Test: `tests/test_dashboard.py`

**Steps:**
- [x] Create FastAPI application on port 8765 with CORS and static file mounting.
- [x] Implement `GET /` serving `backend/static/dashboard/index.html`.
- [x] Implement `GET /api/dashboard/ping` returning `{"dashboard": "online"}`.
- [x] Implement `GET /api/dashboard/backend-status` actively pinging `http://127.0.0.1:8000/health` with a 1.5s timeout, returning `ON` or `OFF`.
- [x] Implement `GET /api/dashboard/metrics` returning summary from `telemetry_db.get_dashboard_summary`.
- [x] Implement `GET /api/dashboard/requests` returning filtered requests list.
- [x] Implement `GET /api/dashboard/requests/{request_id}` returning single request details.
- [x] Implement `POST /api/dashboard/clear` invoking `telemetry_db.clear_logs()`.
- [x] Add unit tests verifying all dashboard server endpoints.

---

### Task 4: Build Professional Dashboard UI (`backend/static/dashboard/`)

**Files:**
- Create: `backend/static/dashboard/index.html`
- Create: `backend/static/dashboard/styles.css`
- Create: `backend/static/dashboard/dashboard.js`

**Steps:**
- [x] Build `index.html` with modern dark-mode layout:
  - Header with title, pulsing Backend Status Pill (`ON` / `OFF`), time window selector, auto-refresh toggle, manual refresh, clear data.
  - 6 KPI Cards: Overall Performance (0-100 score + grade + progress), Total Requests (Success / Failure pills), Success vs Error Rate split bar, Strict Accuracy Rate, Latency metrics (Avg, P95, Min, Max), Backend Status Card.
  - Error Types Breakdown panel with percentage bars.
  - Latency & Outcome timeline visual (last 50 requests).
  - Searchable, filterable requests data table.
  - Deep Request Inspector drawer / modal.
- [x] Build `styles.css` with dark theme, responsive grid, pulsing animations, badge colors, and drawer styling.
- [x] Build `dashboard.js` with polling (every 2s), data binding, chart rendering, filter handling, search debounce, and request detail drawer.

---

### Task 5: Global CLI Launcher `quizzy dashboard`

**Files:**
- Create: `backend/cli.py`
- Create: `quizzy.cmd`
- Create: `quizzy.ps1`
- Create: `pyproject.toml`
- Register global command wrapper in Windows user PATH.

**Steps:**
- [x] Create `backend/cli.py` with argument parsing for `dashboard` command and flags (`--port`, `--no-browser`, `--dry-run`).
- [x] Implement server health check (`/api/dashboard/ping`), detached process spawner if not running, ready poller.
- [x] Implement Google Chrome launcher discovering standard Windows Chrome paths with fallback to `webbrowser`.
- [x] Create `quizzy.cmd` and `quizzy.ps1` in repository root.
- [x] Create `pyproject.toml` with console script entry point `quizzy = "backend.cli:main"`.
- [x] Register `quizzy.cmd` in Windows User PATH (e.g. `%LOCALAPPDATA%\Microsoft\WindowsApps\quizzy.cmd` or `%USERPROFILE%\.local\bin\quizzy.cmd`) so `quizzy dashboard` works from any directory.
- [x] Test CLI launcher with `--dry-run` and `--no-browser`.

---

### Task 6: Verification & Full Regression Test Suite

**Files:**
- Modify/Extend: `tests/test_dashboard.py`
- Execute: Full regression suite `pytest tests -q`

**Steps:**
- [x] Run `tests/test_dashboard.py` and inspect test outputs.
- [x] Run full test suite `.\.venv\Scripts\python.exe -m pytest tests -q` to confirm all 151+ tests pass with 0 failures.
- [x] Update `PROJECT_STATE.md` with new Observability Dashboard milestone.
