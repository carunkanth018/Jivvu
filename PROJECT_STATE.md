# QuizZy / Jivvu Project State

## Current Milestone: Multi-Machine Deployment & Production Distribution
- **Status**: Production-Ready / 222 Pytest Tests Passing (100% Pass Rate).
- **Primary Repository Remote**: `https://github.com/codewithjaswanth/Jivvu.git` (`main` branch).
- **Core Architecture**:
  - Chrome MV3 Extension (`extension/`) with balanced 8px HUD dot, Shift auto-mode, and CCBP lifecycle keeper.
  - FastAPI Backend (`127.0.0.1:8000`) with multi-key hedged LLM consensus engine (Groq + OpenRouter).
  - Windowless Observability Dashboard Daemon (`127.0.0.1:8765`) with live telemetry and model switching.
  - Native Messaging Bridge (`com.quizzy.lifecycle` / `com.quizzy.launcher`) for silent auto-start.
- **One-Click Multi-Machine Installer**:
  - `setup.bat` and `setup.ps1` for deterministic, zero-configuration setup across any Windows laptop.
  - Automated virtual environment initialization, dependency resolution, and registry configuration.
  - Automated Chrome/Edge profile scanning for dynamic extension origin registration.
  - Automated Windows Startup integration and desktop shortcut creation (`Jev.lnk`).
- **Test Integrity & Verification**:
  - 222 passed in 116s across unit, API, extension, lifecycle, and coding benchmark tests.
  - Telemetry DB isolated under test runs (`tests/conftest.py`).
- **Project Root**: `C:\Users\jassh\Jev`
