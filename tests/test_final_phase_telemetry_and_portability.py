"""
Final Production Phase Verification Suite:
- VALIDATION_ERROR Prevention
- SCHEMA_PARSE_ERROR Prevention
- HALLUCINATED_OPTION Prevention
- Portability & Zero-Secret Security Audit
"""

from __future__ import annotations

import os
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.schemas import SolveRequest
from backend.core.parser import parse_llm_response, ParsedLLMResponse
from backend.core.normalizer import (
    snap_to_closest_option,
    normalize_mcq_answer,
    normalize_multi_mcq_answer,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


class TestValidationErrorPrevention:
    """Verifies that malformed or edge-case SolveRequest payloads validate cleanly."""

    def test_options_none_coercion(self):
        req = SolveRequest(q_type="text", question="What is the capital of France?", options=None)
        assert req.options == []
        assert req.subject == "General"
        assert req.q_type == "text"

    def test_uppercase_q_type_and_numeric_options(self):
        req = SolveRequest(q_type="MCQ", question="Calculate 10 + 20", options=[10, 20, 30, 40])
        assert req.q_type == "mcq"
        assert req.options == ["10", "20", "30", "40"]

    def test_multiple_alias_normalization(self):
        req = SolveRequest(
            q_type="multiple",
            question="Select prime numbers",
            options=["2", "3", "4", "5"],
        )
        assert req.q_type == "multi"

    def test_blank_question_with_image_fallback(self):
        req = SolveRequest(
            q_type="mcq",
            question="   ",
            image_data="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            options=["Alpha", "Beta"],
        )
        assert "Solve the given problem based on the provided code or diagram." in req.question
        assert req.image_hash is not None

    def test_blank_question_with_starter_code_fallback(self):
        req = SolveRequest(
            q_type="code",
            question="",
            starter_code="def solution():\n    pass",
        )
        assert "Solve the given problem based on the provided code or diagram." in req.question
        assert req.q_type == "code"

    def test_empty_options_mcq_coerced_to_text(self):
        req = SolveRequest(
            q_type="mcq",
            question="What is the speed of light?",
            options=[],
        )
        assert req.q_type == "text"


class TestSchemaParseErrorPrevention:
    """Verifies 5-stage defensive parser recovery against truncated, unescaped, and non-JSON output."""

    def test_truncated_json_auto_closure(self):
        raw = '{"answer": "B", "reason": "Because the step-by-step derivation shows'
        res = parse_llm_response(raw)
        assert res.answer == "B"
        assert len(res.reason) > 0

    def test_unescaped_newlines_and_tabs_in_reason(self):
        raw = '{"answer": "C", "reason": "Step 1: Compute derivative.\nStep 2: Set to 0.\tStep 3: Solve for x."}'
        res = parse_llm_response(raw)
        assert res.answer == "C"
        assert "Step 1" in res.reason

    def test_trailing_commas_repair(self):
        raw = '{"answer": "A", "reason": "Option A is verified directly.",}'
        res = parse_llm_response(raw)
        assert res.answer == "A"

    def test_python_literal_single_quotes(self):
        raw = "{'answer': 'D', 'reason': 'Option D satisfies the boundary condition.'}"
        res = parse_llm_response(raw)
        assert res.answer == "D"

    def test_think_and_workspace_wrapped_output(self):
        raw = (
            "<think>\nNeed to verify if option B is prime.\n2 is prime.\n</think>\n"
            "<verification_workspace>\nCalculation: 2 has divisors 1 and 2.\n</verification_workspace>\n"
            "Final Answer: B"
        )
        res = parse_llm_response(raw)
        assert res.answer == "B"
        assert res.verification_workspace is not None

    def test_array_answer_rescue(self):
        raw = "<think>Analyzing checkboxes...</think>\nAnswer: [A, C]"
        res = parse_llm_response(raw)
        assert res.answer == ["A", "C"]


class TestHallucinatedOptionPrevention:
    """Verifies deterministic snap-to-option fallback and post-check bounds enforcement."""

    def test_snap_to_closest_option_similarity(self):
        options = [
            "Nucleus controls gene expression",
            "Ribosome synthesizes polypeptides",
            "Mitochondria generates cellular ATP energy",
            "Endoplasmic reticulum folds proteins",
        ]
        # LLM slightly paraphrased the Mitochondria option
        hallucinated_candidate = "Mitochondria is the organelle generating ATP energy"
        best_idx = snap_to_closest_option(hallucinated_candidate, options)
        assert best_idx == 2

    def test_snap_to_closest_option_number_bonus(self):
        options = ["Value is 2.71828", "Value is 1.41421", "Value is 3.14159", "Value is 0.57721"]
        candidate = "The calculated constant is 3.14159"
        best_idx = snap_to_closest_option(candidate, options)
        assert best_idx == 2

    def test_normalize_mcq_answer_with_hallucinated_phrasing(self):
        options = ["Stack LIFO", "Queue FIFO", "Tree Hierarchical", "Graph Network"]
        raw = "Queue First In First Out"
        norm = normalize_mcq_answer(raw, options)
        assert norm.canonical_key == "B"
        assert norm.selected_index == 1
        assert norm.selected_text == "Queue FIFO"

    def test_normalize_multi_mcq_answer_with_hallucinated_phrasing(self):
        options = ["Python dynamic", "C++ compiled", "HTML markup", "Assembly low-level"]
        raw = ["Python dynamically typed", "C++ compiled language"]
        norm = normalize_multi_mcq_answer(raw, options)
        assert norm.canonical_key == "A,B"
        assert norm.selected_indices == [0, 1]


class TestPortabilityAndZeroSecretAudit:
    """Audits zero hardcoded paths, setup modes, and .gitignore security boundaries."""

    def test_gitignore_blocks_secrets_and_runtime_state(self):
        gitignore_path = REPO_ROOT / ".gitignore"
        assert gitignore_path.is_file(), ".gitignore must exist"
        content = gitignore_path.read_text(encoding="utf-8")
        assert ".env" in content
        assert "*.db" in content
        assert "*.log" in content
        assert "runtime_state.json" in content
        assert "com.quizzy.lifecycle.json" in content or "com.quizzy.*.json" in content or "com.quizzy.launcher.json" in content

    def test_setup_scripts_support_recommended_and_quick(self):
        setup_bat = REPO_ROOT / "setup.bat"
        setup_ps1 = REPO_ROOT / "setup.ps1"
        assert setup_bat.is_file(), "setup.bat must exist"
        assert setup_ps1.is_file(), "setup.ps1 must exist"

        bat_text = setup_bat.read_text(encoding="utf-8")
        ps1_text = setup_ps1.read_text(encoding="utf-8")

        assert "--quick" in bat_text or "-q" in bat_text
        assert "RECOMMENDED" in bat_text
        assert "Quick" in ps1_text
        assert "Recommended" in ps1_text

    def test_zero_hardcoded_user_paths_in_code_and_scripts(self):
        targets = [
            REPO_ROOT / "setup.bat",
            REPO_ROOT / "setup.ps1",
            REPO_ROOT / "backend" / "native_host.py",
            REPO_ROOT / "backend" / "schemas.py",
            REPO_ROOT / "backend" / "app.py",
            REPO_ROOT / "extension" / "background.js",
            REPO_ROOT / "extension" / "extractor.js",
            REPO_ROOT / "extension" / "floating_hud.js",
        ]
        for p in targets:
            if p.is_file():
                text = p.read_text(encoding="utf-8", errors="ignore")
                assert "C:\\Users\\jassh" not in text, f"Hardcoded path found in {p.name}"
                assert "c:\\Users\\jassh" not in text, f"Hardcoded path found in {p.name}"


class TestMultiSelectConsensusAndTelemetryAuditor:
    """Verifies per-option 2-of-3 consensus, intersection rescue, and telemetry auditor multi-answer validation."""

    def test_telemetry_multi_answer_accuracy_audit(self):
        from types import SimpleNamespace
        from backend.telemetry_db import validate_accuracy_and_classify_error

        options = [
            "head = head->next",
            "temp = head",
            "delete temp",
            "return head",
        ]

        # Valid multi-select answer response object
        valid_resp = SimpleNamespace(
            answer="A, C, D",
            canonical_keys=["A", "C", "D"],
            selected_texts=["head = head->next", "delete temp", "return head"],
            selected_indices=[0, 2, 3],
            status="ok",
        )
        is_acc, err, status = validate_accuracy_and_classify_error(
            q_type="multi",
            options=options,
            response=valid_resp,
        )
        assert is_acc is True
        assert err == "NONE"
        assert status == "SUCCESS"

        # Hallucinated option not in options list
        bad_resp = SimpleNamespace(
            answer="A, Z",
            canonical_keys=["A", "Z"],
            selected_texts=["head = head->next", "Non-existent hallucinated option"],
            selected_indices=[0, 25],
            status="ok",
        )
        is_acc_bad, err_bad, status_bad = validate_accuracy_and_classify_error(
            q_type="multi",
            options=options,
            response=bad_resp,
        )
        assert is_acc_bad is False
        assert err_bad == "HALLUCINATED_OPTION"
        assert status_bad == "FAILURE"

    def test_per_option_two_of_three_majority_voting(self):
        from backend.core.consensus import compute_multi_majority_indices

        # Primary A: {0, 2, 3}, Primary B: {0, 2}, Arbiter C: {0, 2} -> 3 stripped
        indices, method = compute_multi_majority_indices({0, 2, 3}, {0, 2}, {0, 2}, 4)
        assert indices == [0, 2]
        assert method == "majority_2_of_3"

        # Primary A: {0, 1}, Primary B: {1, 2}, Arbiter C: {0, 1, 2} -> all items supported by >= 2
        indices2, method2 = compute_multi_majority_indices({0, 1}, {1, 2}, {0, 1, 2}, 4)
        assert indices2 == [0, 1, 2]
        assert method2 == "majority_2_of_3"

    def test_intersection_rescue_when_arbiter_offline(self):
        from backend.core.consensus import compute_multi_majority_indices

        # Primary A: {1, 2, 3}, Primary B: {1, 2}, Arbiter is None -> intersection {1, 2}
        indices, method = compute_multi_majority_indices({1, 2, 3}, {1, 2}, None, 4)
        assert indices == [1, 2]
        assert method == "intersection_rescue"

        # Disjoint: Primary A: {0, 1}, Primary B: {2, 3}, Arbiter None -> falls back to A
        indices_disjoint, method_disjoint = compute_multi_majority_indices({0, 1}, {2, 3}, None, 4)
        assert indices_disjoint == [0, 1]
        assert method_disjoint == "primary_fallback"

    def test_retrospective_telemetry_db_repair(self, tmp_path):
        import json
        import sqlite3
        from backend.telemetry_db import repair_historical_hallucinated_options

        test_db = tmp_path / "test_telemetry.db"
        conn = sqlite3.connect(str(test_db))
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                q_type TEXT,
                options_json TEXT,
                canonical_key TEXT,
                selected_answer TEXT,
                is_accurate INTEGER,
                error_type TEXT,
                status TEXT,
                error_message TEXT
            )
        """)
        # Row 1: False positive HALLUCINATED_OPTION on valid multi answer
        cur.execute(
            """
            INSERT INTO request_logs (
                q_type, options_json, canonical_key, selected_answer, is_accurate, error_type, status, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "multi",
                json.dumps(["Opt 1", "Opt 2", "Opt 3"]),
                "A, C",
                "A, C",
                0,
                "HALLUCINATED_OPTION",
                "FAILURE",
                "Falsely marked hallucinated",
            ),
        )
        conn.commit()
        conn.close()

        repaired = repair_historical_hallucinated_options(test_db)
        assert repaired == 1

        conn = sqlite3.connect(str(test_db))
        cur = conn.cursor()
        cur.execute("SELECT is_accurate, error_type, status FROM request_logs WHERE id = 1")
        row = cur.fetchone()
        conn.close()

        assert row == (1, "NONE", "SUCCESS")

    def test_snap_to_closest_option_substring_and_keyword_bonus(self):
        from backend.core.normalizer import snap_to_closest_option

        # Substring bonus: "Max-Heap" in "Max-Heap property"
        idx = snap_to_closest_option("Max-Heap", ["Min-Heap property", "Max-Heap property", "Binary Tree"])
        assert idx == 1

        # Numerical sequence match
        idx_num = snap_to_closest_option(
            "[6, 50, 40, 45, 10, 60, 30]",
            ["Array [1, 2, 3]", "Array [6, 50, 40, 45, 10, 60, 30]", "Array [10, 20]"]
        )
        assert idx_num == 1

    def test_ordering_accuracy_logging_and_repair(self, tmp_path):
        import json
        import sqlite3
        from types import SimpleNamespace
        from backend.telemetry_db import validate_accuracy_and_classify_error, repair_historical_hallucinated_options

        options = ["Init variables", "Process loop", "Accumulate sum", "Return result"]
        order_resp = SimpleNamespace(
            answer="A, B, C, D",
            permutation_indices=[0, 1, 2, 3],
            canonical_key="A, B, C, D",
            status="ok",
        )
        is_acc, err, status = validate_accuracy_and_classify_error(
            q_type="order",
            options=options,
            response=order_resp,
        )
        assert is_acc is True
        assert err == "NONE"
        assert status == "SUCCESS"

        # Test repair on order question with JSON-encoded letters
        test_db = tmp_path / "test_order_telemetry.db"
        conn = sqlite3.connect(str(test_db))
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                q_type TEXT,
                options_json TEXT,
                canonical_key TEXT,
                selected_answer TEXT,
                is_accurate INTEGER,
                error_type TEXT,
                status TEXT,
                error_message TEXT
            )
        """)
        cur.execute(
            """
            INSERT INTO request_logs (
                q_type, options_json, canonical_key, selected_answer, is_accurate, error_type, status, error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "order",
                json.dumps(options),
                "A, B, C, D",
                json.dumps(["A", "B", "C", "D"]),
                0,
                "HALLUCINATED_OPTION",
                "FAILURE",
                "False positive order hallucination",
            ),
        )
        conn.commit()
        conn.close()

        repaired = repair_historical_hallucinated_options(test_db)
        assert repaired == 1

        conn = sqlite3.connect(str(test_db))
        cur = conn.cursor()
        cur.execute("SELECT is_accurate, error_type, status FROM request_logs WHERE id = 1")
        row = cur.fetchone()
        conn.close()

        assert row == (1, "NONE", "SUCCESS")


