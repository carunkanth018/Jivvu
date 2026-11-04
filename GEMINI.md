# QuizZy Project Instructions & Architecture Manual

## 1. Project Overview & Root Directory
- **Project Name**: QuizZy (AI-assisted Quiz & Coding Practice Companion)
- **Architecture**: Chrome Extension Manifest V3 + FastAPI Python Backend
- **True Project Root**: `c:\Users\jassh\Projects\QuizZy\QuizZy`
  *(Note: If the outer directory `c:\Users\jassh\Projects\QuizZy` is opened in the IDE, all operations, tests, and paths must resolve into the inner `QuizZy` project directory).*
- **Primary Repository**: Git remote `origin` -> `https://github.com/codewithjaswanth/QuizZy.git` (`main` branch).

---

## 2. Component Boundaries & Responsibilities

### 2.1 Backend (`backend/`)
- **Framework**: FastAPI running under Uvicorn (`backend.app:app` on `127.0.0.1:8000`).
- **Core Modules**:
  - `backend/app.py`: REST API routes (`/health`, `/solve`, `/evaluate`, `/cache/*`, `/coding/*`).
  - `backend/core/llm_client.py`: Multi-key hedged fallback engine across LLM providers.
  - `backend/core/prompts.py`: Structured prompt templates for MCQ, ordering, and coding analysis.
  - `backend/core/normalizer.py`: Consensus scoring, answer normalization, and canonical key mapping.
  - `backend/schemas.py`: Pydantic request/response validation models.
  - `backend/cache.py`: In-memory and local disk solution caching.

### 2.2 Extension (`extension/`)
- **Manifest**: Manifest V3 (`extension/manifest.json`).
- **Key Subsystems**:
  - `sidepanel.html` / `sidepanel.js` / `sidepanel.css`: Primary user interface for solver controls, status monitoring, and question previews.
  - `background.js`: Service worker handling inter-context messaging, storage synchronization, and script execution.
  - `extractor.js`: Content script extracting question text, options, drag-and-drop slots, and code blocks from active tabs.
  - `executor.js`: Content script executing DOM selections, drag-and-drop sequences, and editor input.
  - `floating_hud.js`: Draggable on-page HUD overlay with zero DOM interference.
  - `stealth_shield.js`: Early MAIN-world coordination (`window.__QUIZZY_COORDINATION__`) strictly gated to authorized test/staging domains.

### 2.3 Testing & Evaluation (`tests/`, `eval/`)
- **Unit & Integration Suite**: 17 pytest files under `tests/` covering API endpoints, extension messaging, ordering, and coding automation.
- **Evaluation Runner**: `eval/run_eval.py` running offline self-tests and the 15-problem coding benchmark.

---

## 3. Security, Ethical Boundaries & Platform Compliance
- **No Anti-Cheat Evasion**: Never implement stealth techniques, fake keystroke spoofing intended to bypass proctoring controls, or tampering with site security scanners.
- **Zero Global Tampering**: Do not monkey-patch `fetch`/`XHR`, do not tamper with `Event.isTrusted`, and do not alter native DOM prototypes.
- **Environment Gating**: Privileged automation hooks must remain gated to authorized test environments (`localhost`, `127.0.0.1`, `*.test`, `*.staging.quizzy.internal`).
- **Purpose**: All functionality is intended for authorized testing, accessibility assistance, and legitimate personal practice.

---

## 4. Development Workflow & Verification Rules

### 4.1 Strict Verification Gate (Non-Negotiable)
- **Evidence Before Assertions**: Never claim a feature, bugfix, or refactoring is complete or working without executing tests and inspecting the output.
- **Regression Testing**: Run the targeted test file after every logical modification, and run the full test suite (`test.bat` or `pytest tests -q`) before completing any task.
- **Preserve Documentation**: Retain existing docstrings and comments unless specifically asked to update them.

### 4.2 Non-Destructive Editing & Preservation
- **Preserve Uncommitted Work**: Never run `git reset --hard`, `git clean -fd`, or discard unstaged modifications without explicit user instruction.
- **UI Element Invariants**: When modifying `sidepanel.html` or `sidepanel.css`, never change or remove existing element IDs or class hooks expected by `sidepanel.js`.
- **Surgical Changes**: Make minimal, focused edits. Avoid sweeping refactors or unnecessary dependency additions.

### 4.3 Python & Environment Discipline
- **Virtual Environment**: Always use the project virtual environment at `.venv\Scripts\python.exe`.
- **No Global Installs**: Never run global `pip install`. All project dependencies are tracked in `requirements.txt`.

### 4.4 Continuous Memory & Documentation Invariant (Mandatory)
- **Always Update `Jivvu.md` and `progress.md`**: Upon completing any task, bugfix, architectural refactor, or milestone, ALWAYS update both `Jivvu.md` and `progress.md` with the latest system state, root causes, changes made, and verification test counts. Keep documentation synchronized with verified evidence.

---

## 5. Developer Launchers & Common Commands

| Task | Command |
|---|---|
| **Start Backend (Dev/Reload)** | `dev.bat` *(or `.\.venv\Scripts\python.exe -m uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000`)* |
| **Run Full Test Suite** | `test.bat` *(or `.\.venv\Scripts\python.exe -m pytest tests -q`)* |
| **Run Focused Test** | `test.bat tests/test_phase1_api.py` |
| **Run Coding Benchmark** | `.\.venv\Scripts\python.exe eval\run_eval.py --coding-benchmark` |
| **Run Offline Self-Test** | `.\.venv\Scripts\python.exe eval\run_eval.py --self-test` |
