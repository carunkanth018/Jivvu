"""Unit and integration tests for QuizZy Observability Dashboard and Telemetry."""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Generator

import pytest

from backend.telemetry_db import (
    VALID_ERROR_TYPES,
    clear_logs,
    get_dashboard_summary,
    get_db_connection,
    get_request_detail,
    get_request_logs,
    init_db,
    record_request_log,
)


@pytest.fixture
def temp_db() -> Generator[Path, None, None]:
    """Provide an isolated temporary telemetry database."""
    fd, path = tempfile.mkstemp(suffix=".db", prefix="test_telemetry_")
    os.close(fd)
    db_path = Path(path)
    init_db(db_path)
    try:
        yield db_path
    finally:
        if db_path.exists():
            try:
                db_path.unlink()
            except Exception:
                pass


def test_telemetry_db_init_and_wal_mode(temp_db: Path) -> None:
    """Verify that database initialization enables WAL mode and creates schema."""
    conn = get_db_connection(temp_db)
    try:
        mode_row = conn.execute("PRAGMA journal_mode;").fetchone()
        assert mode_row[0].upper() == "WAL"

        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='request_logs';"
        ).fetchall()
        assert len(tables) == 1

        indexes = [
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index';"
            ).fetchall()
        ]
        assert "idx_req_timestamp" in indexes
        assert "idx_req_status" in indexes
        assert "idx_req_error_type" in indexes
        assert "idx_req_is_accurate" in indexes
    finally:
        conn.close()


def test_telemetry_record_and_summary_metrics(temp_db: Path) -> None:
    """Verify aggregation of success rate, error rate, accuracy rate, and latency metrics."""
    # 1. Empty state (Standby)
    empty_summary = get_dashboard_summary(db_path=temp_db)
    assert empty_summary["total_requests"] == 0
    assert empty_summary["overall_performance"] == 100.0
    assert empty_summary["health_grade"] == "STANDBY"
    assert empty_summary["success_rate"] == 0.0
    assert empty_summary["error_rate"] == 0.0
    assert empty_summary["accuracy_rate"] == 0.0

    # 2. Record 4 diverse requests:
    # Req 1: Fast accurate success (1000ms)
    id1 = record_request_log(
        endpoint="/solve",
        subject="Python",
        q_type="mcq",
        question_text="What is 2+2?",
        options=["3", "4", "5"],
        selected_answer="4",
        selected_index=1,
        canonical_key="B",
        status="SUCCESS",
        is_accurate=True,
        error_type="NONE",
        latency_ms=1000.0,
        model_name="deepseek/chat",
        cache_hit=False,
        db_path=temp_db,
    )
    assert id1 is not None

    # Req 2: Inaccurate success due to hallucinated option (2000ms)
    id2 = record_request_log(
        endpoint="/solve",
        subject="Python",
        q_type="mcq",
        question_text="Capital of France?",
        options=["Rome", "Berlin", "Madrid"],
        selected_answer="Paris",  # Hallucinated: Paris not in options
        selected_index=None,
        status="FAILURE",
        is_accurate=False,
        error_type="HALLUCINATED_OPTION",
        error_message="Selected answer Paris not in options",
        latency_ms=2000.0,
        model_name="deepseek/chat",
        cache_hit=False,
        db_path=temp_db,
    )
    assert id2 is not None

    # Req 3: Empty answer error (1500ms)
    id3 = record_request_log(
        endpoint="/solve",
        subject="History",
        q_type="text",
        question_text="Who was the first president?",
        selected_answer="",
        status="FAILURE",
        is_accurate=False,
        error_type="EMPTY_ANSWER",
        error_message="Model returned empty answer string",
        latency_ms=1500.0,
        model_name="openai/gpt-4o-mini",
        cache_hit=False,
        db_path=temp_db,
    )
    assert id3 is not None

    # Req 4: Timeout failure (5500ms)
    id4 = record_request_log(
        endpoint="/solve",
        subject="Math",
        q_type="mcq",
        question_text="Complex integral...",
        options=["0", "1"],
        status="FAILURE",
        is_accurate=False,
        error_type="LLM_TIMEOUT",
        error_message="Upstream request timed out after 5000ms",
        latency_ms=5500.0,
        model_name="qwen/coder",
        cache_hit=False,
        db_path=temp_db,
    )
    assert id4 is not None

    # 3. Verify Aggregated Metrics
    summary = get_dashboard_summary(db_path=temp_db)
    assert summary["total_requests"] == 4
    assert summary["success_count"] == 1
    assert summary["failure_count"] == 3
    assert summary["accurate_count"] == 1

    # success_rate: 1 / 4 = 25.0%
    assert summary["success_rate"] == 25.0
    # error_rate: 3 / 4 = 75.0%
    assert summary["error_rate"] == 75.0
    # accuracy_rate: 1 / 4 = 25.0%
    assert summary["accuracy_rate"] == 25.0

    # Latencies: [1000.0, 1500.0, 2000.0, 5500.0]
    # avg = 10000.0 / 4 = 2500.0ms
    assert summary["avg_latency_ms"] == 2500.0
    assert summary["min_latency_ms"] == 1000.0
    assert summary["max_latency_ms"] == 5500.0
    assert summary["p95_latency_ms"] == 5500.0

    # Latency score for 2500ms:
    # 100 - ((2500 - 1500) / 8500) * 100 = 100 - (1000/85) = 100 - 11.7647 = 88.235
    # Overall score = 0.50*25.0 + 0.30*25.0 + 0.20*88.2 = 12.5 + 7.5 + 17.6 = 37.6
    assert 35.0 <= summary["overall_performance"] <= 40.0
    assert summary["health_grade"] == "F"

    # Error breakdown counts
    eb = summary["error_breakdown"]
    assert eb["NONE"]["count"] == 1
    assert eb["HALLUCINATED_OPTION"]["count"] == 1
    assert eb["EMPTY_ANSWER"]["count"] == 1
    assert eb["LLM_TIMEOUT"]["count"] == 1
    assert eb["RATE_LIMIT_429"]["count"] == 0

    # Timeline has 4 entries
    assert len(summary["timeline"]) == 4


def test_telemetry_request_logs_filters_and_detail(temp_db: Path) -> None:
    """Verify filtering, search, pagination, and detail inspection."""
    for i in range(10):
        record_request_log(
            endpoint="/solve",
            subject="General",
            q_type="mcq",
            question_text=f"Question number {i}",
            options=["Option A", "Option B"],
            selected_answer="Option A" if i % 2 == 0 else "Bad",
            status="SUCCESS" if i % 2 == 0 else "FAILURE",
            is_accurate=(i % 2 == 0),
            error_type="NONE" if i % 2 == 0 else "HALLUCINATED_OPTION",
            latency_ms=100.0 * (i + 1),
            db_path=temp_db,
        )

    # Filter status SUCCESS
    success_logs = get_request_logs(status_filter="SUCCESS", db_path=temp_db)
    assert success_logs["total"] == 5
    assert len(success_logs["logs"]) == 5
    assert all(l["status"] == "SUCCESS" for l in success_logs["logs"])

    # Filter error_type HALLUCINATED_OPTION
    halluc_logs = get_request_logs(error_filter="HALLUCINATED_OPTION", db_path=temp_db)
    assert halluc_logs["total"] == 5
    assert all(l["error_type"] == "HALLUCINATED_OPTION" for l in halluc_logs["logs"])

    # Search keyword
    search_res = get_request_logs(search="number 7", db_path=temp_db)
    assert search_res["total"] == 1
    assert "number 7" in search_res["logs"][0]["question_text"]

    # Detail query
    target_id = search_res["logs"][0]["id"]
    detail = get_request_detail(target_id, db_path=temp_db)
    assert detail is not None
    assert detail["id"] == target_id
    assert detail["error_type"] == "HALLUCINATED_OPTION"
    assert len(detail["options"]) == 2


def test_telemetry_clear_logs(temp_db: Path) -> None:
    """Verify log clearing truncates request_logs."""
    record_request_log(endpoint="/solve", status="SUCCESS", db_path=temp_db)
    record_request_log(endpoint="/solve", status="FAILURE", db_path=temp_db)

    logs_before = get_request_logs(db_path=temp_db)
    assert logs_before["total"] == 2

    deleted_count = clear_logs(db_path=temp_db)
    assert deleted_count == 2

    logs_after = get_request_logs(db_path=temp_db)
    assert logs_after["total"] == 0


def test_strict_accuracy_and_error_classification() -> None:
    """Verify strict non-hallucination validation and deterministic error classification."""
    from backend.telemetry_db import validate_accuracy_and_classify_error

    class MockResp:
        def __init__(self, answer="", selected_text=None, selected_index=None, status="ok", error=None):
            self.answer = answer
            self.selected_text = selected_text
            self.selected_index = selected_index
            self.status = status
            self.error = error
            self.canonical_key = None
            self.selected_indices = None
            self.permutation_indices = None
            self.canonical_keys = None

    opts = ["Oxygen", "Nitrogen", "Hydrogen"]

    # 1. Valid answer matching option text
    resp_valid = MockResp(selected_text="Nitrogen", selected_index=1)
    acc, err_type, stat = validate_accuracy_and_classify_error("mcq", opts, response=resp_valid)
    assert acc is True
    assert err_type == "NONE"
    assert stat == "SUCCESS"

    # 2. Valid answer matching letter index
    resp_letter = MockResp(selected_text="B", selected_index=1)
    acc, err_type, stat = validate_accuracy_and_classify_error("mcq", opts, response=resp_letter)
    assert acc is True
    assert err_type == "NONE"
    assert stat == "SUCCESS"

    # 3. Hallucinated option text not in options
    resp_halluc = MockResp(selected_text="Helium", selected_index=None)
    acc, err_type, stat = validate_accuracy_and_classify_error("mcq", opts, response=resp_halluc)
    assert acc is False
    assert err_type == "HALLUCINATED_OPTION"
    assert stat == "FAILURE"

    # 4. Hallucinated out-of-bounds option index
    resp_bad_idx = MockResp(selected_text="Oxygen", selected_index=99)
    acc, err_type, stat = validate_accuracy_and_classify_error("mcq", opts, response=resp_bad_idx)
    assert acc is False
    assert err_type == "HALLUCINATED_OPTION"
    assert stat == "FAILURE"

    # 5. Empty answer string
    resp_empty = MockResp(answer="", selected_text="", selected_index=None)
    acc, err_type, stat = validate_accuracy_and_classify_error("mcq", opts, response=resp_empty)
    assert acc is False
    assert err_type == "EMPTY_ANSWER"
    assert stat == "FAILURE"

    # 6. LLM timeout
    acc, err_type, stat = validate_accuracy_and_classify_error(
        "mcq", opts, error_msg="Upstream request timed out after 4000ms"
    )
    assert acc is False
    assert err_type == "LLM_TIMEOUT"
    assert stat == "FAILURE"

    # 7. Rate limit 429
    acc, err_type, stat = validate_accuracy_and_classify_error(
        "mcq", opts, error_msg="HTTP 429: Too Many Requests - Provider quota reached"
    )
    assert acc is False
    assert err_type == "RATE_LIMIT_429"
    assert stat == "FAILURE"

    # 8. Schema parse error
    acc, err_type, stat = validate_accuracy_and_classify_error(
        "mcq", opts, error_msg="JSONDecodeError: Unterminated string in schema response"
    )
    assert acc is False
    assert err_type == "SCHEMA_PARSE_ERROR"
    assert stat == "FAILURE"

    # 9. Validation error
    acc, err_type, stat = validate_accuracy_and_classify_error(
        "mcq", opts, error_msg="ValidationError: 1 validation error for SolveRequest"
    )
    assert acc is False
    assert err_type == "VALIDATION_ERROR"
    assert stat == "FAILURE"

    # 10. Provider API error
    acc, err_type, stat = validate_accuracy_and_classify_error(
        "mcq", opts, error_msg="OpenRouter 502 Bad Gateway from upstream model"
    )
    assert acc is False
    assert err_type == "PROVIDER_API_ERROR"
    assert stat == "FAILURE"


def test_app_health_and_solve_instrumentation(monkeypatch: pytest.MonkeyPatch, temp_db: Path) -> None:
    """Verify that backend app /health returns uptime and /solve records telemetry."""
    from fastapi.testclient import TestClient
    from backend.app import app
    import backend.telemetry_db as tdb

    # Point telemetry recording to our temp_db
    monkeypatch.setattr(tdb, "DEFAULT_DB_PATH", temp_db)

    with TestClient(app) as client:
        # 1. Health check returns uptime and timestamp
        res_health = client.get("/health")
        assert res_health.status_code == 200
        data = res_health.json()
        assert data["status"] == "ok"
        assert "timestamp" in data
        assert "uptime_seconds" in data
        assert data["uptime_seconds"] >= 0

        # 2. Validation error on bad solve request (422) is recorded in telemetry
        bad_req = {"q_type": "mcq", "question": "Too few options", "options": ["Only one"]}
        res_422 = client.post("/solve", json=bad_req)
        assert res_422.status_code == 422

        logs = get_request_logs(db_path=temp_db)
        assert logs["total"] >= 1
        val_log = logs["logs"][0]
        assert val_log["error_type"] == "VALIDATION_ERROR"
        assert val_log["status"] == "FAILURE"
        assert val_log["is_accurate"] is False
        assert val_log["question_text"] == "Too few options"
        assert val_log["latency_ms"] > 0.0
        assert "options" in val_log["error_message"].lower()


def test_dashboard_server_endpoints(monkeypatch: pytest.MonkeyPatch, temp_db: Path) -> None:
    """Verify all dashboard server REST endpoints."""
    from fastapi.testclient import TestClient
    from backend.dashboard_server import app as dash_app
    import backend.telemetry_db as tdb
    import httpx

    monkeypatch.setattr(tdb, "DEFAULT_DB_PATH", temp_db)

    # Pre-populate sample logs
    record_request_log(
        endpoint="/solve",
        subject="Python",
        q_type="mcq",
        question_text="Sample Q1",
        options=["A", "B"],
        selected_answer="A",
        status="SUCCESS",
        is_accurate=True,
        error_type="NONE",
        latency_ms=250.0,
        db_path=temp_db,
    )
    record_request_log(
        endpoint="/solve",
        subject="Math",
        q_type="mcq",
        question_text="Sample Q2",
        options=["1", "2"],
        selected_answer="99",
        status="FAILURE",
        is_accurate=False,
        error_type="HALLUCINATED_OPTION",
        latency_ms=1200.0,
        db_path=temp_db,
    )

    with TestClient(dash_app) as client:
        # 1. Ping
        ping_res = client.get("/api/dashboard/ping")
        assert ping_res.status_code == 200
        assert ping_res.json() == {"dashboard": "online"}

        # 2. Backend status (Mock online)
        class MockOnlineResp:
            status_code = 200
            def json(self):
                return {"status": "ok", "uptime_seconds": 12.5}

        async def mock_get_online(self, url, *args, **kwargs):
            return MockOnlineResp()

        monkeypatch.setattr(httpx.AsyncClient, "get", mock_get_online)
        st_online = client.get("/api/dashboard/backend-status")
        assert st_online.status_code == 200
        d_online = st_online.json()
        assert d_online["online"] is True
        assert d_online["status_label"] == "ON"
        assert d_online["ping_ms"] is not None

        # 3. Backend status (Mock offline / exception)
        async def mock_get_offline(self, url, *args, **kwargs):
            raise httpx.ConnectError("Connection refused by target machine")

        monkeypatch.setattr(httpx.AsyncClient, "get", mock_get_offline)
        st_offline = client.get("/api/dashboard/backend-status")
        assert st_offline.status_code == 200
        d_offline = st_offline.json()
        assert d_offline["online"] is False
        assert d_offline["status_label"] == "OFF"
        assert d_offline["ping_ms"] is None
        assert "Connection refused" in d_offline["error"]

        # 4. Metrics
        m_res = client.get("/api/dashboard/metrics")
        assert m_res.status_code == 200
        m_data = m_res.json()
        assert m_data["total_requests"] == 2
        assert m_data["success_count"] == 1
        assert m_data["failure_count"] == 1
        assert m_data["success_rate"] == 50.0

        # 5. Requests list & filter
        r_res = client.get("/api/dashboard/requests")
        assert r_res.status_code == 200
        r_data = r_res.json()
        assert r_data["total"] == 2
        assert len(r_data["logs"]) == 2

        # 6. Request detail
        first_id = r_data["logs"][0]["id"]
        det_res = client.get(f"/api/dashboard/requests/{first_id}")
        assert det_res.status_code == 200
        assert det_res.json()["id"] == first_id

        # 404 for invalid id
        det_404 = client.get("/api/dashboard/requests/999999")
        assert det_404.status_code == 404

        # 7. Clear
        clear_res = client.post("/api/dashboard/clear")
        assert clear_res.status_code == 200
        assert clear_res.json()["deleted"] >= 2

        # Check total is now 0
        r_empty = client.get("/api/dashboard/requests")
        assert r_empty.json()["total"] == 0

        # 8. Static UI assets
        ui_res = client.get("/")
        assert ui_res.status_code == 200
        assert "QuizZy Observability Dashboard" in ui_res.text

        css_res = client.get("/static/styles.css")
        assert css_res.status_code == 200
        assert "dark-theme" in css_res.text

        js_res = document_js = client.get("/static/dashboard.js")
        assert js_res.status_code == 200
        assert "pollBackendStatus" in js_res.text


def test_cli_launcher_parsing_and_dry_run(capsys: pytest.CaptureFixture[str]) -> None:
    """Verify CLI argument parsing and dry-run execution."""
    from backend.cli import (
        build_parser,
        find_chrome_executable,
        get_python_executable,
        is_dashboard_online,
        launch_dashboard,
        main,
    )

    # 1. Chrome executable detection
    chrome_path = find_chrome_executable()
    # On Windows test environment, chrome path was detected
    assert chrome_path is not None
    assert "chrome.exe" in chrome_path.lower()

    # 2. Python executable
    py_exe = get_python_executable()
    assert py_exe is not None
    assert "python" in py_exe.lower()

    # 3. Argument parser
    parser = build_parser()
    args = parser.parse_args(["dashboard", "--port", "9999", "--dry-run", "--no-browser"])
    assert args.command == "dashboard"
    assert args.port == 9999
    assert args.dry_run is True
    assert args.no_browser is True

    # 4. Dry-run launch execution
    exit_code = launch_dashboard(port=9999, dry_run=True, no_browser=True)
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "Dry run" in captured.out
    assert "9999" in captured.out

    # 5. CLI main invocation with dry-run
    main_exit = main(["dashboard", "--dry-run"])
    assert main_exit == 0

    # 6. Check non-existent dashboard port reports offline
    online = is_dashboard_online(port=59999, timeout=0.1)
    assert online is False


def test_hallucination_and_empty_answer_increment_failure_count(temp_db: Path) -> None:
    """Verify HALLUCINATED_OPTION and EMPTY_ANSWER are marked FAILURE and increment failure_count/error_rate."""
    # 1 accurate success
    record_request_log(endpoint="/solve", status="SUCCESS", is_accurate=True, error_type="NONE", db_path=temp_db)
    # 1 hallucinated option (even if input status was passed as SUCCESS)
    record_request_log(endpoint="/solve", status="SUCCESS", is_accurate=False, error_type="HALLUCINATED_OPTION", db_path=temp_db)
    # 1 empty answer
    record_request_log(endpoint="/solve", status="SUCCESS", is_accurate=False, error_type="EMPTY_ANSWER", db_path=temp_db)

    summary = get_dashboard_summary(db_path=temp_db)
    assert summary["total_requests"] == 3
    assert summary["success_count"] == 1
    assert summary["failure_count"] == 2
    assert summary["accurate_count"] == 1
    assert summary["success_rate"] == 33.33
    assert summary["error_rate"] == 66.67
    # Success Count + Failure Count == Total Requests 100% of the time
    assert summary["success_count"] + summary["failure_count"] == summary["total_requests"]
    # Error Breakdown matches failure count
    eb = summary["error_breakdown"]
    assert eb["NONE"]["count"] == 1
    assert eb["HALLUCINATED_OPTION"]["count"] == 1
    assert eb["EMPTY_ANSWER"]["count"] == 1


def test_clear_logs_concurrent_connection_no_vacuum_lock(temp_db: Path) -> None:
    """Verify clear_logs uses wal_checkpoint(TRUNCATE) and does not lock when another connection is open."""
    record_request_log(endpoint="/solve", status="SUCCESS", db_path=temp_db)
    record_request_log(endpoint="/solve", status="FAILURE", db_path=temp_db)

    # Open another active connection in WAL mode
    conn2 = get_db_connection(temp_db)
    try:
        # Read from active connection to simulate concurrent app.py activity
        r = conn2.execute("SELECT COUNT(*) FROM request_logs;").fetchone()[0]
        assert r == 2

        # clear_logs must succeed without sqlite3.OperationalError: database is locked
        deleted = clear_logs(db_path=temp_db)
        assert deleted == 2

        summary = get_dashboard_summary(db_path=temp_db)
        assert summary["total_requests"] == 0
        assert summary["health_grade"] == "STANDBY"
    finally:
        conn2.close()


def test_cli_live_spawn_and_ping() -> None:
    """Verify live background process spawn and ping readiness from outside repository root."""
    import os
    import subprocess
    from backend.cli import is_dashboard_online, launch_dashboard

    test_port = 8799
    assert not is_dashboard_online(port=test_port)

    # Simulate running from outside repo root (e.g. Temp directory or C:\)
    orig_cwd = os.getcwd()
    outside_dir = tempfile.gettempdir()
    os.chdir(outside_dir)
    try:
        code = launch_dashboard(port=test_port, no_browser=True)
        assert code == 0
        assert is_dashboard_online(port=test_port)
    finally:
        os.chdir(orig_cwd)
        # Safely cleanup process listening on test_port
        netstat = subprocess.run(["netstat", "-ano"], capture_output=True, text=True)
        for line in netstat.stdout.splitlines():
            if f":{test_port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                pid = parts[-1]
                subprocess.run(["taskkill", "/F", "/PID", pid, "/T"], capture_output=True)


def test_schema_hardening_and_zero_validation_error_leakage(monkeypatch: pytest.MonkeyPatch, temp_db: Path) -> None:
    """Verify SolveRequest payload coercion and telemetry DB isolation under test runs."""
    from backend.schemas import SolveRequest
    import backend.telemetry_db as tdb

    # 1. Alias stem / prompt / text / question_text -> question
    req_stem = SolveRequest.model_validate({"stem": "What is Python?", "options": ["Lang", "Snake"]})
    assert req_stem.question == "What is Python?"
    assert req_stem.q_type == "mcq"

    req_prompt = SolveRequest.model_validate({"prompt": "Solve 2+2", "options": ["3", "4"]})
    assert req_prompt.question == "Solve 2+2"

    req_text = SolveRequest.model_validate({"text": "Fill in the blank: ___", "options": []})
    assert req_text.question == "Fill in the blank: ___"
    assert req_text.q_type == "text"  # Auto-coerced from mcq default because options is empty

    # 2. Options as objects/dicts are normalized to strings
    req_objs = SolveRequest.model_validate({
        "question": "Choose the best option",
        "options": [{"text": "Option Alpha"}, {"label": "Option Beta"}]
    })
    assert req_objs.options == ["Option Alpha", "Option Beta"]

    # 3. Both stem and options empty -> cleanly raises ValueError
    with pytest.raises(Exception) as exc_info:
        SolveRequest.model_validate({"question": "   ", "options": []})
    assert "no question text or options detected" in str(exc_info.value).lower()

    # 4. Telemetry isolation: resolve_db_path isolates test runs from PROD_DB_PATH
    resolved = tdb.resolve_db_path()
    assert resolved != tdb.PROD_DB_PATH
    temp_conn = sqlite3.connect(str(temp_db))
    temp_count = temp_conn.execute("SELECT COUNT(*) FROM request_logs WHERE error_type = 'VALIDATION_ERROR'").fetchone()[0]
    temp_conn.close()
    assert temp_count == 0, "Test database must have 0 validation error logs"


def test_create_desktop_shortcut_jev() -> None:
    """Verify create_desktop_shortcut creates Jev.lnk with valid icon and arguments."""
    import sys
    from backend.cli import REPO_ROOT, create_desktop_shortcut

    shortcut_path = create_desktop_shortcut(app_name="Jev")
    if sys.platform == "win32":
        assert shortcut_path is not None
        assert shortcut_path.is_file()
        assert shortcut_path.name == "Jev.lnk"

        ico_path = REPO_ROOT / "backend" / "static" / "dashboard" / "jev.ico"
        assert ico_path.is_file(), "jev.ico must exist"
        assert ico_path.stat().st_size > 1000

