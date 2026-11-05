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

