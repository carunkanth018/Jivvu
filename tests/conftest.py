"""Pytest global configuration and fixtures for QuizZy test suite."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Generator

import pytest

from backend.telemetry_db import init_db


@pytest.fixture(autouse=True, scope="session")
def setup_pytest_telemetry_db() -> Generator[Path, None, None]:
    """
    Ensure every test session uses an isolated temporary telemetry database,
    preventing any test runs or TestClient calls from touching or polluting backend/telemetry.db.
    """
    test_db = Path(tempfile.gettempdir()) / "quizzy_pytest_telemetry.db"
    os.environ["QUIZZY_TELEMETRY_DB"] = str(test_db)
    init_db(test_db)
    yield test_db
    if test_db.exists():
        try:
            test_db.unlink()
        except Exception:
            pass

