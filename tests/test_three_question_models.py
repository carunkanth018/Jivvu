"""
Unit and integration tests for the Three Question Models hardening:
1. Drag-and-sequence questions ("Drag and Drop to Order")
2. Multiple-choice questions with several correct answers (Square checkboxes / multi-select)
3. Fill-in-the-box questions (Numerical / textual answers)
"""

import os
import pytest
from fastapi.testclient import TestClient

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"

from backend.app import app
from backend.schemas import SolveRequest, SolveResponse
from backend.core.normalizer import (
    normalize_multi_mcq_answer,
    normalize_order_answer,
    normalize_text_answer,
    grade_answer,
    NormalizedAnswer,
)
from backend.cache import cache_solution, get_cached_solution, compute_cache_key


client = TestClient(app)


# =============================================================================
# Model 1: Drag-and-Sequence Questions ("Drag and Drop to Order")
# =============================================================================

def test_linear_probing_ordering_normalization():
    """Verify ordering normalization for Linear Probing steps."""
    options = [
        "Repeat until an empty slot is found",
        "Check if the calculated index is already occupied",
        "If occupied, move to the next slot (index + 1)",
    ]
    # Expected chronological sequence:
    # 1. Check if occupied (index 1)
    # 2. If occupied, move next (index 2)
    # 3. Repeat until empty slot (index 0)
    raw_answer = "B, C, A"
    normalized = normalize_order_answer(raw_answer, options)

    assert normalized.canonical_key == "B,C,A"
    assert normalized.permutation_indices == [1, 2, 0]
    assert normalized.ordered_texts == [
        "Check if the calculated index is already occupied",
        "If occupied, move to the next slot (index + 1)",
        "Repeat until an empty slot is found",
    ]


def test_linear_probing_solve_endpoint():
    """Verify solve_endpoint returns verified sequence for Linear Probing."""
    payload = {
        "subject": "Computer Science",
        "q_type": "order",
        "question": "Arrange the steps in correct order for resolving collisions using Linear Probing.",
        "options": [
            "Repeat until an empty slot is found",
            "Check if the calculated index is already occupied",
            "If occupied, move to the next slot (index + 1)",
        ],
    }
    response = client.post("/solve", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "ok"
    assert data["q_type"] == "order"
    assert data["permutation_indices"] == [1, 2, 0]
    assert data["ordered_texts"][0] == "Check if the calculated index is already occupied"
    assert data["ordered_texts"][1] == "If occupied, move to the next slot (index + 1)"
    assert data["ordered_texts"][2] == "Repeat until an empty slot is found"
    assert data["confidence_label"] in ("high", "medium")


# =============================================================================
# Model 2: Multiple-Choice Questions with Several Correct Answers (Multi-select)
# =============================================================================

def test_multi_select_double_hashing_normalization():
    """Verify multi-select normalizer maps combinations correctly."""
    options = [
        "Uses a second hash function",
        "Increases computation time",
        "Requires more memory",
        "Reduces clustering",
    ]

    # Test comma-separated letters
    norm1 = normalize_multi_mcq_answer("A, D", options)
    assert norm1.canonical_keys == ["A", "D"]
    assert norm1.selected_indices == [0, 3]
    assert norm1.canonical_key == "A,D"
    assert norm1.selected_texts == ["Uses a second hash function", "Reduces clustering"]

    # Test list of letters
    norm2 = normalize_multi_mcq_answer(["D", "A"], options)
    assert norm2.canonical_keys == ["A", "D"]
    assert norm2.selected_indices == [0, 3]

    # Test text phrases with conjunction
    norm3 = normalize_multi_mcq_answer("Reduces clustering and Uses a second hash function", options)
    assert norm3.canonical_keys == ["A", "D"]
    assert norm3.selected_indices == [0, 3]


def test_multi_select_grading_zero_error_strictness():
    """Verify that multi-select requires ALL correct options and rejects partial selections."""
    options = [
        "Uses a second hash function",
        "Increases computation time",
        "Requires more memory",
        "Reduces clustering",
    ]
    # Complete match -> True
    user_full = normalize_multi_mcq_answer(["A", "D"], options)
    assert grade_answer(user_full, "A, D", "multi", options) is True

    # Partial match (only A, like prior buggy behavior) -> False!
    user_partial = normalize_multi_mcq_answer("A", options)
    assert grade_answer(user_partial, "A, D", "multi", options) is False

    # Extra wrong option -> False!
    user_extra = normalize_multi_mcq_answer("A, B, D", options)
    assert grade_answer(user_extra, "A, D", "multi", options) is False


def test_multi_select_solve_endpoint():
    """Verify solve endpoint returns multi-select fields for double hashing advantages."""
    payload = {
        "subject": "Computer Science",
        "q_type": "multi",
        "question": "Which of the following are advantages of double hashing?",
        "options": [
            "Uses a second hash function",
            "Increases computation time",
            "Requires more memory",
            "Reduces clustering",
        ],
    }
    response = client.post("/solve", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "ok"
    assert data["q_type"] == "multi"
    assert data["canonical_keys"] == ["A", "D"]
    assert data["selected_indices"] == [0, 3]
    assert "Uses a second hash function" in data["selected_texts"]
    assert "Reduces clustering" in data["selected_texts"]


def test_multi_select_cache_roundtrip():
    """Verify caching preserves multi-select indices, canonical keys, and texts."""
    q = "Test unique multi select question for caching"
    opts = ["Option 1", "Option 2", "Option 3"]

    class MockSolverRes:
        status = "ok"
        confidence_tier = "HIGH_BOTH_AGREE"
        confidence_label = "high"
        confidence_score = 0.95
        reason = "Test multi caching"
        selected_index = 0
        selected_indices = [0, 2]
        canonical_keys = ["A", "C"]
        selected_texts = ["Option 1", "Option 3"]
        searxng_used = False
        search_sources = []
        normalized_answer = normalize_multi_mcq_answer("A, C", opts)

    cache_solution(
        subject="Computer Science",
        q_type="multi",
        question=q,
        options=opts,
        solver_res=MockSolverRes(),
    )

    cached = get_cached_solution("Computer Science", "multi", q, opts)
    assert cached is not None
    assert cached["selected_indices"] == [0, 2]
    assert cached["canonical_keys"] == ["A", "C"]
    assert cached["selected_texts"] == ["Option 1", "Option 3"]


# =============================================================================
# Model 3: Fill-in-the-Box Questions (Numerical / Textual)
# =============================================================================

def test_multiplication_method_calculation():
    """
    Mathematical verification of multiplication hashing:
    h(k) = floor(m * (k*A mod 1))
    For k = 123, A = 0.618, m = 10:
    123 * 0.618 = 76.014
    76.014 mod 1 = 0.014
    floor(10 * 0.014) = floor(0.14) = 0.
    """
    k = 123
    A = 0.618
    m = 10
    product = k * A
    frac = product - int(product)
    expected_result = int(m * frac)
    assert expected_result == 0


def test_multiplication_method_solve_endpoint():
    """Verify solve_endpoint returns exact value 0 for multiplication hashing."""
    payload = {
        "subject": "Computer Science",
        "q_type": "text",
        "question": "What is the result of h(123) using the multiplication method where A = 0.618 and m = 10 ?",
        "options": [],
    }
    response = client.post("/solve", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "ok"
    assert data["q_type"] == "text"
    assert data["answer"] == "0"
    assert "0" in data["reason"]
