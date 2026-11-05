# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**QuizZy** is a production-grade, zero-cost, multi-model AI Quiz Assistant & Automated Solver Chrome Extension (Manifest V3) backed by an asynchronous local FastAPI engine. It achieves sub-3-second p95 latency across Multiple Choice (MCQ), Sequence Ordering, and Free-Text questions with zero DOM mutation, explicit uncertainty handling, and order-invariant cache resiliency.

---

## Repository Structure

```
QuizZy/
├── backend/                      # FastAPI local inference engine
│   ├── app.py                    # FastAPI REST server & lifecycle management
│   ├── cache.py                  # Order-invariant SQLite cache & remapping engine
│   ├── schemas.py                # Pydantic v2 schemas for API contracts
│   ├── run_server.py             # Simple server entry point
│   ├── .env                      # Runtime secrets (gitignored)
│   ├── .env.example              # Template for API keys
│   └── core/
│       ├── llm_client.py         # Groq parallel consensus & hedged fallback racing
│       ├── normalizer.py         # NFKC unicode normalizer & math expression parser
│       ├── parser.py             # Defensive LLM response parsing & extraction
│       ├── prompts.py            # Reason-first system prompts & calculation rules
│       └── searxng_client.py     # Factual grounding client with circuit breaker
├── extension/                    # Chrome MV3 extension (isolated world)
│   ├── manifest.json             # Chrome Manifest V3 configuration
│   ├── background.js             # Service worker message broker & tab listener
│   ├── extractor.js              # Zero-DOM-mutation quiz content extractor
│   ├── executor.js               # Option selection & two-step SUBMIT/NEXT automation
│   ├── floating_hud.js           # Shadow-DOM Rectangular Bar & Movable White Dot HUD
│   ├── sidepanel.html            # Diagnostic sidebar layout
│   ├── sidepanel.css             # Dark-mode styling for sidebar panel
│   ├── sidepanel.js              # Sidebar telemetry, manual solve & feedback controls
│   └── stealth_shield.js         # Read-Only MAIN-world diagnostics & auth gate
├── scripts/                      # Windows automation & daemon management
│   ├── install_autostart.ps1     # Windows Startup & Scheduled Task daemon installer
│   ├── uninstall_autostart.ps1   # Daemon uninstaller
│   ├── keep_backend_alive.ps1    # 15s self-healing supervisor loop
│   ├── launch_backend_hidden.vbs # Silent windowless process launcher
│   └── run_weekly_reeval.bat     # Automated weekly regression benchmark runner
├── tests/                        # 21 test suites, 142 tests (100% pass)
├── eval/                         # Deterministic grading & model benchmarking
├── models.json                   # Root capability-tier model declarations
├── questions.csv                 # Deduplicated evaluation dataset
├── requirements.txt              # Locked Python dependencies
├── .env.example                  # Root environment configuration template
└── LICENSE                       # MIT License
```

---

## Common Development Commands

### Backend Development

```bash
# Start development server with hot-reload
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload

# Or use the dev.bat wrapper (Windows)
dev.bat

# Production silent daemon (Windows)
powershell -ExecutionPolicy Bypass -File scripts/install_autostart.ps1
```

### Testing

```bash
# Run all 142 tests (recommended)
test.bat
# Or directly:
python -m pytest tests -q

# Run specific test file
python -m pytest tests/test_phase1_api.py -v

# Run targeted tests with custom args
test.bat tests/test_phase3_automode.py -v

# Deterministic offline evaluation (no network calls)
python eval/run_eval.py --self-test
```

### Test Suites (21 files, 142 tests)

| Test File | Purpose |
|-----------|---------|
| `test_phase1_api.py` | API contracts & order-invariant dynamic cache |
| `test_phase2_extension.py` | Chrome MV3 security & zero-DOM-mutation audit |
| `test_phase3_automode.py` | Auto Mode guardrails & kill switch simulation |
| `test_phase4_searxng.py` | Search grounding & circuit breaker |
| `test_phase5_feedback_reeval.py` | Cache eviction & weekly benchmark |
| `test_phase6_multikey_hedged_fallback.py` | Key rotation & model racing |
| `test_phase7_coding_and_stealth.py` | Coding mode & stealth defense |
| `test_live_site_compatibility.py` | Node.js DOM VM runtime verification |
| `test_bugfix_selection_and_consensus.py` | Selection logic & consensus verification |
| `test_drag_and_drop_ordering.py` | Sequence ordering drag & drop |
| `test_numeric_mcq_and_auto_skip.py` | Numeric MCQ & auto-skip logic |
| `test_floating_hud_launch.py` | HUD launch behavior |
| `test_hud_redirect_and_interaction_shortcuts.py` | Shortcut routing |
| `test_automode_resilience_and_shortcuts.py` | Auto mode resilience |
| `test_three_question_models.py` | Question model validation |
| `test_two_stage_verification.py` | Two-stage verification |
| `test_sidepanel_deep_scan_and_swipe_advance.py` | Deep scan & swipe advance |
| `test_white_blue_theme_and_exclusive_shortcuts.py` | Theme & exclusive shortcuts |
| `test_phase7_coding_mode.py` | Coding mode tests |
| `test_phase7_self_healing_complete.py` | Self-healing tests |
| `test_audit_order_demo.py` | Order demo audit |

### Chrome Extension

```bash
# Load in Chrome:
# 1. Open chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked" → select extension/ directory
```

---

## Key Architecture Components

### Backend (FastAPI on 127.0.0.1:8000)

**Core Modules:**
- **`llm_client.py`** — Parallel Groq consensus (2 primary models) + hedged OpenRouter fallback + arbiter tie-breaking. Timeouts in `models.json`.
- **`cache.py`** — Order-invariant SQLite cache with SHA-256 canonical keys, dynamic index remapping for scrambled options, zero-poison guarantee.
- **`normalizer.py`** — NFKC normalization, math expression parsing (LaTeX, KaTeX), code preservation.
- **`parser.py`** — Defensive LLM response extraction (JSON fences, regex, ast fallback).
- **`prompts.py`** — Reason-first system prompts enforcing derivation before answer selection.
- **`searxng_client.py`** — Factual grounding with circuit breaker for disagreement cases.

**API Endpoints:**
- `POST /solve` — Main solving endpoint with consensus, cache, search grounding
- `GET /health` — Health status, model catalog, cache count, SearXNG circuit
- `GET /stats` — Accuracy, cache hit rates, model latency averages
- `POST /feedback` — Reports incorrect answers, evicts cache, appends to questions.csv
- `POST /debug/solve` — Full decision trace (dev only)

### Extension (Chrome MV3)

**Key Files:**
- **`background.js`** — Service worker, port router, health monitor, message broker between tabs, HUD, sidepanel, and backend
- **`extractor.js`** — Zero-DOM-mutation extraction: clones DOM, parses questions, code blocks, KaTeX/MathJax, handles multiple frameworks
- **`executor.js`** — Multi-framework click escalation (React/Vue/vanilla), two-step SUBMIT→NEXT automation, drag simulation for ordering
- **`floating_hud.js`** — Shadow DOM rectangular bar (36px) + movable white dot (9px) with double-tap Z toggle, draggable with invisible grab zone
- **`sidepanel.js/html/css`** — Analytics dashboard, manual solve, feedback, deep scan, swipe/advance fallback chain

**Hotkeys (Strictly 4 Exclusive Triggers):**
| Hotkey | Action |
|--------|--------|
| `Shift` (Tap) | Start/Stop Auto Mode |
| `Ctrl` (Tap) | Show/Hide HUD & Reset Dot to Corner |
| `Alt+R` | In-Place Soft Refresh of Extension (< 60ms, No Page Reload) |
| `Ctrl+Shift+Z` | Panic Wipe & Silent Self-Uninstall (`showConfirmDialog: false`) |

**Mutual Exclusivity:** Only one interface open at a time (HUD ↔ Sidepanel). Shortcuts route to active interface.

---

## Configuration

### Environment Variables (backend/.env)
```ini
GROQ_API_KEY=gsk_xxx
OPENROUTER_API_KEYS=sk-or-v1-key1,sk-or-v1-key2
SEARXNG_URL=http://localhost:8080  # Optional
```

### Model Configuration (models.json)
Defines 3-tier model catalog (S/A/B), timeouts, and fallback pool with priorities. Primary models: `openai/gpt-oss-120b` and `qwen/qwen3.8-27b` on Groq. Arbiter: `openai/gpt-oss-20b`. Hedged fallback pool on OpenRouter.

---

## Engineering Invariants

1. **Explicit Uncertainty Consensus** — Multi-model consensus with arbiter tie-breaker; returns `status="uncertain"` when no agreement, halting automation instead of guessing
2. **Order-Invariant Cache** — SHA-256 canonical keys from sorted option texts; dynamic index remapping resolves live permutation on cache hit
3. **Zero-DOM-Mutation** — All extraction on cloned trees; no watermark detectable by proctoring
4. **Reason-First Solving** — Prompts enforce computation in `reason` field before `answer` key population
5. **Zero-Poison Cache** — Low-confidence/fallback answers barred from verified cache; feedback triggers immediate eviction

---

## Verification Rule

**Never claim a task or bug is complete without fresh terminal or test evidence.** Run the relevant test suite (`test.bat` or specific test file) and verify all tests pass before marking complete.

---

## Key Files to Understand First

| File | Why |
|------|-----|
| `backend/app.py` | Main API server, request flow, all endpoints |
| `backend/core/llm_client.py` | Consensus logic, model racing, fallback behavior |
| `backend/cache.py` | Cache key generation, dynamic remapping, eviction |
| `extension/background.js` | Extension message routing, tab coordination |
| `extension/extractor.js` | DOM extraction logic, multi-framework handling |
| `extension/executor.js` | Option selection, React/Vue/vanilla click escalation |
| `extension/floating_hud.js` | HUD UI, hotkey handling, dot/bar toggle |

---

## Python Dependencies (requirements.txt)

```
httpx>=0.27.0
pydantic>=2.6.0
python-dotenv>=1.0.0
fastapi>=0.110.0
uvicorn>=0.29.0
```

Python 3.11+ required. Virtual environment at `.venv/`.