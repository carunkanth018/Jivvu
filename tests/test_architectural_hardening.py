"""Tests for architectural hardening: follower remapping, relative options, duplicate order items, and memory bounds."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from typing import List
from unittest.mock import AsyncMock, patch

import pytest

from backend.app import (
    COALESCE_TTL_SECONDS,
    MAX_COALESCE_ENTRIES,
    _prune_coalesce_cache,
    _recent_solved_coalesce,
    _solve_core,
    remap_response_to_follower_options,
)
from backend.cache import (
    cache_solution,
    compute_cache_key,
    get_cached_solution,
    init_db,
)
from backend.core.llm_client import SolverResponse
from backend.core.normalizer import (
    normalize_mcq_answer,
    normalize_order_answer,
    parse_math_numeric_value,
)
from backend.schemas import SolveRequest, SolveResponse


def test_in_flight_follower_scrambled_options_remapping_mcq():
    """Verify that follower requests with scrambled options remap selected_index and answer."""
    leader_options = ["Alpha", "Beta", "Gamma", "Delta"]
    follower_options = ["Delta", "Gamma", "Beta", "Alpha"]

    leader_res = SolveResponse(
        status="ok",
        q_type="mcq",
        answer="B",
        selected_index=1,
        selected_text="Beta",
        reason="Beta is correct",
        confidence_tier="HIGH_CONSENSUS",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=15.0,
    )

    follower_res = remap_response_to_follower_options(leader_res, follower_options)

    # In follower_options: "Beta" is at index 2 (Letter 'C')
    assert follower_res.selected_index == 2
    assert follower_res.answer == "C"
    assert follower_res.selected_text == "Beta"


def test_in_flight_follower_scrambled_options_remapping_order():
    """Verify that follower ordering requests remap permutation_indices and answer."""
    follower_options = ["Step 3", "Step 1", "Step 2"]
    leader_ordered_texts = ["Step 1", "Step 2", "Step 3"]

    leader_res = SolveResponse(
        status="ok",
        q_type="order",
        answer="B,C,A",
        permutation_indices=[1, 2, 0],
        ordered_texts=leader_ordered_texts,
        reason="Sequential flow",
        confidence_tier="HIGH_CONSENSUS",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=20.0,
    )

    follower_res = remap_response_to_follower_options(leader_res, follower_options)

    # In follower_options: "Step 1" is at 1, "Step 2" is at 2, "Step 3" is at 0
    assert follower_res.permutation_indices == [1, 2, 0]
    assert follower_res.ordered_texts == ["Step 1", "Step 2", "Step 3"]
    assert follower_res.answer == "B,C,A"


def test_in_flight_follower_scrambled_options_remapping_multi():
    """Verify that follower multi-select requests remap selected_indices and canonical answer."""
    follower_options = ["Cherry", "Apple", "Banana", "Date"]
    leader_selected_texts = ["Apple", "Date"]

    leader_res = SolveResponse(
        status="ok",
        q_type="multi",
        answer="A,B",
        selected_indices=[0, 1],
        selected_texts=leader_selected_texts,
        reason="Selected two",
        confidence_tier="HIGH_CONSENSUS",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=18.0,
    )

    follower_res = remap_response_to_follower_options(leader_res, follower_options)

    # In follower_options: "Apple" is at 1, "Date" is at 3 -> sorted [1, 3] -> 'B,D'
    assert follower_res.selected_indices == [1, 3]
    assert follower_res.selected_texts == ["Apple", "Date"]
    assert follower_res.answer == "B,D"


def test_relative_options_disable_order_invariance():
    """Verify relative options (e.g. 'Both A and B', 'All of the above') disable order-invariant caching."""
    q = "Which of the following are prime numbers?"

    # 1. Normal options should produce identical cache keys when scrambled
    normal_opts_1 = ["Two", "Three", "Four", "Five"]
    normal_opts_2 = ["Five", "Two", "Four", "Three"]
    key_normal_1 = compute_cache_key("Math", "mcq", q, normal_opts_1)
    key_normal_2 = compute_cache_key("Math", "mcq", q, normal_opts_2)
    assert key_normal_1 == key_normal_2, "Standard options must be order-invariant"

    # 2. Relative options must produce DIFFERENT cache keys when scrambled
    rel_opts_1 = ["Two", "Three", "Both A and B", "None of the above"]
    rel_opts_2 = ["Both A and B", "None of the above", "Two", "Three"]
    key_rel_1 = compute_cache_key("Math", "mcq", q, rel_opts_1)
    key_rel_2 = compute_cache_key("Math", "mcq", q, rel_opts_2)
    assert key_rel_1 != key_rel_2, "Relative options must preserve visual order to prevent misclicks"


def test_order_duplicate_texts_unique_permutation_indices():
    """Verify ordering with duplicate step texts resolves to unique [0..N-1] permutation indices."""
    options = ["Initialize loop", "Compute delta", "Print value", "Compute delta"]
    raw_answer = ["Initialize loop", "Compute delta", "Compute delta", "Print value"]

    res = normalize_order_answer(raw_answer, options)
    assert len(res.permutation_indices) == 4
    assert set(res.permutation_indices) == {0, 1, 2, 3}, "Must contain all 4 distinct indices"
    # First Compute delta -> index 1, second Compute delta -> index 3
    assert res.permutation_indices == [0, 1, 3, 2]
    assert res.canonical_key == "A,B,D,C"


def test_bounded_coalesce_memory_cleanup():
    """Verify _recent_solved_coalesce strictly enforces MAX_COALESCE_ENTRIES and TTL eviction."""
    now = time.time()
    _recent_solved_coalesce.clear()

    mock_res = SolveResponse(
        status="ok",
        q_type="mcq",
        answer="A",
        selected_index=0,
        selected_text="Test",
        reason="test",
        confidence_tier="HIGH_CONSENSUS",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=10.0,
    )

    # 1. Populate 150 items
    for i in range(150):
        _recent_solved_coalesce[f"key_{i}"] = (now - (150 - i), mock_res, {})

    assert len(_recent_solved_coalesce) == 150

    # 2. Prune should trim down to MAX_COALESCE_ENTRIES (128)
    _prune_coalesce_cache(now)
    assert len(_recent_solved_coalesce) <= MAX_COALESCE_ENTRIES

    # 3. Old entries (> 2.5s) should be evicted
    _recent_solved_coalesce.clear()
    _recent_solved_coalesce["stale_1"] = (now - 3.0, mock_res, {})
    _recent_solved_coalesce["stale_2"] = (now - 10.0, mock_res, {})
    _recent_solved_coalesce["fresh_1"] = (now - 1.0, mock_res, {})

    _prune_coalesce_cache(now)
    assert "stale_1" not in _recent_solved_coalesce
    assert "stale_2" not in _recent_solved_coalesce
    assert "fresh_1" in _recent_solved_coalesce

    _recent_solved_coalesce.clear()


def test_zero_tab_lease_env_override(monkeypatch: pytest.MonkeyPatch):
    """Verify QUIZZY_ZERO_TAB_LEASE_SECONDS configuration in dashboard_server."""
    monkeypatch.setenv("QUIZZY_ZERO_TAB_LEASE_SECONDS", "12.5")
    val = float(os.getenv("QUIZZY_ZERO_TAB_LEASE_SECONDS", "60.0"))
    assert val == 12.5


def test_relative_option_regex_no_false_positive_on_prose():
    """Verify prose options containing 'only a' are NOT flagged as relative options and remain order-invariant."""
    q = "What does the copy method do in Python?"

    # Prose containing "only a" or "only single"
    prose_opts_1 = [
        "Creates only a shallow copy",
        "Creates a deep copy of elements",
        "Returns only a single reference",
        "Modifies the original object in place",
    ]
    prose_opts_2 = [
        "Modifies the original object in place",
        "Creates only a shallow copy",
        "Returns only a single reference",
        "Creates a deep copy of elements",
    ]
    k1 = compute_cache_key("Python", "mcq", q, prose_opts_1)
    k2 = compute_cache_key("Python", "mcq", q, prose_opts_2)
    assert k1 == k2, "Prose options like 'Creates only a shallow copy' must remain order-invariant"

    # True relative options MUST produce different cache keys
    rel_tests = [
        ["Only A", "Only B", "Both A and B", "Neither"],
        ["Option 1", "Option 2", "Only (B) is correct", "None of the above"],
        ["Statement 1", "Statement 2", "Only A and C are true", "All of the above"],
    ]
    for rel_opts in rel_tests:
        scrambled = list(reversed(rel_opts))
        rk1 = compute_cache_key("Python", "mcq", "Which is correct?", rel_opts)
        rk2 = compute_cache_key("Python", "mcq", "Which is correct?", scrambled)
        assert rk1 != rk2, f"Relative options {rel_opts} must preserve visual order"


def test_sqlite_cache_hit_duplicate_ordering_remapping(tmp_path):
    """Verify get_cached_solution on ordering problems with duplicate option texts returns unique permutation indices."""
    db_path = str(tmp_path / "test_order_cache.db")
    init_db(db_path)

    options = ["Init array", "Compute delta", "Print result", "Compute delta"]
    ordered_texts = ["Init array", "Compute delta", "Compute delta", "Print result"]
    mock_res = SolveResponse(
        status="ok",
        q_type="order",
        answer="A,B,D,C",
        permutation_indices=[0, 1, 3, 2],
        ordered_texts=ordered_texts,
        reason="Ordered correctly",
        confidence_tier="HIGH_CONSENSUS",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=12.0,
    )

    cached_ok = cache_solution("Algorithm", "order", "Sort the sequence", options, mock_res, db_path=db_path)
    assert cached_ok is True

    # Scramble options
    scrambled_options = ["Print result", "Compute delta", "Init array", "Compute delta"]
    cached_hit = get_cached_solution("Algorithm", "order", "Sort the sequence", scrambled_options, db_path=db_path)

    assert cached_hit is not None
    perm = cached_hit["permutation_indices"]
    assert len(perm) == 4
    assert set(perm) == {0, 1, 2, 3}, "Every index [0..N-1] must be uniquely represented (no duplicates)"
    # In scrambled_options: "Init array" is at 2, first "Compute delta" at 1, second "Compute delta" at 3, "Print result" at 0
    assert perm == [2, 1, 3, 0]
    assert cached_hit["ordered_texts"] == ordered_texts


@pytest.mark.anyio
async def test_coalesce_cache_bypass_and_confidence_filtering():
    """Verify coalesce cache respects 2.5s TTL, bypass_cache eviction, and filters UNCERTAIN/LOW_FALLBACK_RESCUE."""
    _recent_solved_coalesce.clear()

    req = SolveRequest(
        subject="Python",
        q_type="mcq",
        question="What is the result of 2 ** 3 in Python unique coalesce test?",
        options=["6", "8", "9", "5"],
        bypass_cache=False,
    )
    c_key = compute_cache_key(req.subject, req.q_type, req.question, req.options)

    with patch("backend.app.get_cached_solution", return_value=None):
        # 1. When solver returns UNCERTAIN, it must NOT be cached in _recent_solved_coalesce
        uncertain_solver = SolverResponse(
            status="OK",
            answer="B",
            raw_answer="8",
            selected_text="8",
            selected_index=1,
            reason="uncertain guess",
            confidence_tier="UNCERTAIN",
            model_name="test-model",
        )
        with patch("backend.app.solve_question", new_callable=AsyncMock) as mock_solve:
            mock_solve.return_value = uncertain_solver
            res, _ = await _solve_core(req)
            assert res.confidence_tier == "UNCERTAIN"
            assert c_key not in _recent_solved_coalesce, "UNCERTAIN responses must not be cached in coalesce"

        # 2. When solver returns LOW_FALLBACK_RESCUE, it must NOT be cached in _recent_solved_coalesce
        low_solver = SolverResponse(
            status="OK",
            answer="B",
            raw_answer="8",
            selected_text="8",
            selected_index=1,
            reason="low fallback",
            confidence_tier="LOW_FALLBACK_RESCUE",
            model_name="test-model",
        )
        with patch("backend.app.solve_question", new_callable=AsyncMock) as mock_solve:
            mock_solve.return_value = low_solver
            res, _ = await _solve_core(req)
            assert res.confidence_tier == "LOW_FALLBACK_RESCUE"
            assert c_key not in _recent_solved_coalesce, "LOW_FALLBACK_RESCUE must not be cached in coalesce"

        # 3. When solver returns HIGH_CONSENSUS, it MUST be cached in _recent_solved_coalesce
        high_solver = SolverResponse(
            status="OK",
            answer="B",
            raw_answer="8",
            selected_text="8",
            selected_index=1,
            reason="definitive math",
            confidence_tier="HIGH_CONSENSUS",
            model_name="test-model",
        )
        with patch("backend.app.solve_question", new_callable=AsyncMock) as mock_solve:
            mock_solve.return_value = high_solver
            res, _ = await _solve_core(req)
            assert res.confidence_tier == "HIGH_CONSENSUS"
            assert c_key in _recent_solved_coalesce, "HIGH_CONSENSUS must be cached in coalesce"

        # 4. Immediate follower request within 2.5s should hit coalesce cache without calling solve_question
        with patch("backend.app.solve_question", new_callable=AsyncMock) as mock_solve:
            follower_res, _ = await _solve_core(req)
            assert follower_res.cache_hit is True
            mock_solve.assert_not_called()

        # 5. When bypass_cache=True, coalesce cache MUST be evicted and solve_question called
        req_bypass = SolveRequest(
            subject="Python",
            q_type="mcq",
            question="What is the result of 2 ** 3 in Python unique coalesce test?",
            options=["6", "8", "9", "5"],
            bypass_cache=True,
        )
        with patch("backend.app.solve_question", new_callable=AsyncMock) as mock_solve:
            mock_solve.return_value = high_solver
            res, _ = await _solve_core(req_bypass)
            mock_solve.assert_called_once()
            assert c_key not in _recent_solved_coalesce, "bypass_cache=True must evict entry from coalesce cache"

    _recent_solved_coalesce.clear()


def test_negative_numeric_mcq_normalization():
    """Verify that negative numbers and fractions are normalized correctly without losing sign."""
    # 1. Direct math numeric parsing
    assert parse_math_numeric_value("Option B: -2") == -2.0
    assert parse_math_numeric_value("B) -2") == -2.0
    assert parse_math_numeric_value("-2") == -2.0
    assert parse_math_numeric_value("-15") == -15.0
    assert parse_math_numeric_value("0") == 0.0
    assert parse_math_numeric_value("5") == 5.0
    assert parse_math_numeric_value("-1/2") == -0.5
    assert parse_math_numeric_value("C. -1/2") == -0.5
    assert parse_math_numeric_value("Option D: -3/4") == -0.75

    # 2. MCQ normalization with negative numbers in options
    options = ["-15", "-2", "0", "5"]
    
    # Matching "-2"
    norm1 = normalize_mcq_answer("-2", options)
    assert norm1.canonical_key == "B"
    assert norm1.selected_index == 1
    assert norm1.selected_text == "-2"

    # Matching "Option B: -2"
    norm2 = normalize_mcq_answer("Option B: -2", options)
    assert norm2.canonical_key == "B"
    assert norm2.selected_index == 1

    # Matching "B) -2"
    norm3 = normalize_mcq_answer("B) -2", options)
    assert norm3.canonical_key == "B"
    assert norm3.selected_index == 1

    # Matching "Option A: -15"
    norm4 = normalize_mcq_answer("Option A: -15", options)
    assert norm4.canonical_key == "A"
    assert norm4.selected_index == 0

    # Matching fraction "-1/2" against decimal options
    dec_options = ["1", "0", "-0.5", "-10"]
    norm5 = normalize_mcq_answer("C. -1/2", dec_options)
    assert norm5.canonical_key == "C"
    assert norm5.selected_index == 2
    assert norm5.selected_text == "-0.5"


def test_lightweight_fingerprint_countdown_timer_tick_immunity():
    """Verify that getLightweightQuestionFingerprint ignores live ticking countdown timers."""
    hud_path = (Path(__file__).resolve().parent.parent / "extension" / "floating_hud.js").as_posix()
    
    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockNode {{
      constructor(tag) {{
        this.tagName = tag.toUpperCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.style = {{}};
      }}
      setAttribute(k, v) {{ this[k] = v; }}
      getAttribute(k) {{ return this[k] || null; }}
      appendChild(c) {{ this.children.push(c); return c; }}
      attachShadow() {{ return new MockNode('shadow'); }}
      querySelector(selector) {{
        if (selector.includes('question-stem') && this._stem) return this._stem;
        if (selector.includes('question-number') && this._counter) return this._counter;
        if (selector.includes('quiz-option') && this._opt) return this._opt;
        return null;
      }}
    }}

    const sandbox = {{
      window: {{
        location: {{ pathname: '/course/quiz/1', search: '' }}
      }},
      document: Object.assign(new MockNode('document'), {{
        createElement: (tag) => new MockNode(tag),
        getElementById: () => null,
        body: new MockNode('body'),
        documentElement: new MockNode('html'),
      }}),
      console: console,
      setTimeout: () => {{}},
      clearTimeout: () => {{}},
      setInterval: () => {{}},
      clearInterval: () => {{}},
      requestAnimationFrame: () => {{}},
      cancelAnimationFrame: () => {{}},
      chrome: {{
        runtime: {{ onMessage: {{ addListener: () => {{}} }}, sendMessage: () => {{}} }},
        storage: {{ local: {{ get: () => {{}}, set: () => {{}}, onChanged: {{ addListener: () => {{}} }} }} }}
      }}
    }};

    vm.createContext(sandbox);
    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    vm.runInContext(hudCode, sandbox);

    const getFingerprint = sandbox.window.__QUIZZY_GET_LIGHTWEIGHT_FINGERPRINT__;
    if (typeof getFingerprint !== 'function') {{
      throw new Error('__QUIZZY_GET_LIGHTWEIGHT_FINGERPRINT__ not found on sandbox.window');
    }}

    // Construct mock question DOM with a countdown timer in counter and stem
    const doc1 = new MockNode('document');
    doc1._counter = new MockNode('div');
    doc1._counter.textContent = 'Question 3 of 10 (Time Remaining: 09:42)';
    doc1._stem = new MockNode('div');
    doc1._stem.textContent = 'What is the time complexity of binary search?';
    doc1._opt = new MockNode('div');
    doc1._opt.textContent = 'O(log N)';

    // Next tick: 1 second later (timer ticks from 09:42 -> 09:41)
    const doc2 = new MockNode('document');
    doc2._counter = new MockNode('div');
    doc2._counter.textContent = 'Question 3 of 10 (Time Remaining: 09:41)';
    doc2._stem = new MockNode('div');
    doc2._stem.textContent = 'What is the time complexity of binary search?';
    doc2._opt = new MockNode('div');
    doc2._opt.textContent = 'O(log N)';

    // Question 4: Actual different question
    const doc3 = new MockNode('document');
    doc3._counter = new MockNode('div');
    doc3._counter.textContent = 'Question 4 of 10 (Time Remaining: 09:40)';
    doc3._stem = new MockNode('div');
    doc3._stem.textContent = 'What is the space complexity of merge sort?';
    doc3._opt = new MockNode('div');
    doc3._opt.textContent = 'O(N)';

    const fp1 = getFingerprint(doc1);
    const fp2 = getFingerprint(doc2);
    const fp3 = getFingerprint(doc3);

    console.log(JSON.stringify({{ fp1, fp2, fp3, identical: fp1 === fp2, different: fp1 !== fp3 }}));
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip())

    assert out["identical"] is True, f"Fingerprints should match across timer ticks: {out['fp1']} vs {out['fp2']}"
    assert out["different"] is True, f"Fingerprints should differ on actual question change: {out['fp1']} vs {out['fp3']}"


def test_three_question_soft_memory_recycle():
    """Verify that 3 solved questions trigger soft memory recycle, clearing heap while preserving auto-mode."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockNode {{
      constructor(tag) {{
        this.tagName = tag.toUpperCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.style = {{}};
        this.classList = {{
          classes: new Set(),
          add(c) {{ this.classes.add(c); }},
          remove(c) {{ this.classes.delete(c); }},
          contains(c) {{ return this.classes.has(c); }}
        }};
      }}
      setAttribute(k, v) {{ this[k] = v; }}
      getAttribute(k) {{ return this[k] || null; }}
      appendChild(c) {{ this.children.push(c); return c; }}
      remove() {{}}
      attachShadow() {{ return new MockNode('shadow'); }}
      querySelector() {{ return null; }}
      querySelectorAll() {{ return []; }}
    }}

    const sentMessages = [];
    const sandbox = {{
      window: {{
        __QUIZZY_RECYCLE_INTERVAL__: 3,
        location: {{ pathname: '/course/quiz/1', search: '', hostname: 'learning.ccbp.in' }}
      }},
      document: Object.assign(new MockNode('document'), {{
        createElement: (tag) => new MockNode(tag),
        getElementById: () => null,
        querySelectorAll: () => [],
        body: new MockNode('body'),
        documentElement: new MockNode('html'),
        head: new MockNode('head')
      }}),
      console: console,
      setTimeout: () => {{}},
      clearTimeout: () => {{}},
      setInterval: () => {{}},
      clearInterval: () => {{}},
      requestAnimationFrame: () => {{}},
      cancelAnimationFrame: () => {{}},
      chrome: {{
        runtime: {{
          id: 'test-ext-id',
          onMessage: {{ addListener: () => {{}} }},
          sendMessage: (msg, cb) => {{
            sentMessages.push(msg);
            if (cb) cb({{ success: true }});
          }}
        }},
        storage: {{ local: {{ get: () => {{}}, set: () => {{}}, onChanged: {{ addListener: () => {{}} }} }} }}
      }}
    }};

    vm.createContext(sandbox);

    // 1. Run extractor
    const extractorCode = fs.readFileSync('{ext_dir}/extractor.js', 'utf8');
    vm.runInContext(extractorCode, sandbox);

    // 2. Run executor
    const executorCode = fs.readFileSync('{ext_dir}/executor.js', 'utf8');
    vm.runInContext(executorCode, sandbox);

    // 3. Run floating HUD
    const hudCode = fs.readFileSync('{ext_dir}/floating_hud.js', 'utf8');
    vm.runInContext(hudCode, sandbox);

    // Populate mock cached memory state
    sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__ = [new MockNode('div'), new MockNode('div')];
    sandbox.window.__QUIZZY_LAST_EXTRACTION__ = {{ question: 'What is 2+2?', options: ['4'] }};

    // Cycle 1: Solve question 1
    sandbox.window.__QUIZZY_RECORD_SOLVE_CYCLE__();
    const countAfter1 = sandbox.window.__QUIZZY_GET_SOLVES_SINCE_RECYCLE__();
    const lenAfter1 = sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__.length;

    // Cycle 2: Solve question 2
    sandbox.window.__QUIZZY_RECORD_SOLVE_CYCLE__();
    const countAfter2 = sandbox.window.__QUIZZY_GET_SOLVES_SINCE_RECYCLE__();
    const lenAfter2 = sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__.length;

    // Cycle 3: Solve question 3 -> Triggers soft recycle!
    sandbox.window.__QUIZZY_RECORD_SOLVE_CYCLE__();
    const countAfter3 = sandbox.window.__QUIZZY_GET_SOLVES_SINCE_RECYCLE__();
    const lenAfter3 = sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__.length;
    const lastExtAfter3 = sandbox.window.__QUIZZY_LAST_EXTRACTION__;

    const recycleMsgSent = sentMessages.some(m => m.type === 'QUIZZY_PERFORM_SOFT_RECYCLE');

    console.log(JSON.stringify({{
      countAfter1,
      lenAfter1,
      countAfter2,
      lenAfter2,
      countAfter3,
      lenAfter3,
      lastExtAfter3,
      recycleMsgSent
    }}));
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip())

    assert out["countAfter1"] == 1
    assert out["lenAfter1"] == 2
    assert out["countAfter2"] == 2
    assert out["lenAfter2"] == 2
    assert out["countAfter3"] == 0, f"Counter should reset to 0 after 3rd solve: {out['countAfter3']}"
    assert out["lenAfter3"] == 0, f"Option elements should be flushed on recycle: {out['lenAfter3']}"
    assert out["lastExtAfter3"] is None, "Last extraction should be set to null on recycle"
    assert out["recycleMsgSent"] is True, "QUIZZY_PERFORM_SOFT_RECYCLE message should be dispatched to background"


def test_orphaned_context_self_healer():
    """Verify that orphaned content scripts detect context invalidation and safely tear down."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockNode {{
      constructor(tag) {{
        this.tagName = tag.toUpperCase();
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.style = {{}};
      }}
      setAttribute(k, v) {{ this[k] = v; }}
      getAttribute(k) {{ return this[k] || null; }}
      appendChild(c) {{ this.children.push(c); return c; }}
      remove() {{ this._removed = true; }}
      attachShadow() {{ return new MockNode('shadow'); }}
      querySelector() {{ return null; }}
      querySelectorAll() {{ return []; }}
    }}

    let unmounted = false;
    let clearedIntervalCount = 0;
    const intervalCallbacks = [];
    const mockHost = new MockNode('div');
    mockHost.id = '__quizzy_hud_host__';
    mockHost.remove = () => {{ unmounted = true; }};

    const sandbox = {{
      window: {{
        location: {{ pathname: '/course/quiz/1', search: '' }}
      }},
      document: Object.assign(new MockNode('document'), {{
        createElement: (tag) => new MockNode(tag),
        getElementById: (id) => (id === '__quizzy_hud_host__' ? mockHost : null),
        querySelectorAll: () => [mockHost],
        body: new MockNode('body'),
        documentElement: new MockNode('html'),
      }}),
      console: console,
      setTimeout: () => {{}},
      clearTimeout: () => {{}},
      setInterval: (fn) => {{
        intervalCallbacks.push(fn);
        return intervalCallbacks.length;
      }},
      clearInterval: () => {{ clearedIntervalCount++; }},
      requestAnimationFrame: () => {{}},
      cancelAnimationFrame: () => {{}},
      chrome: {{
        runtime: {{
          id: 'test-ext-id',
          onMessage: {{ addListener: () => {{}} }},
          sendMessage: () => {{}}
        }},
        storage: {{ local: {{ get: () => {{}}, set: () => {{}}, onChanged: {{ addListener: () => {{}} }} }} }}
      }}
    }};

    vm.createContext(sandbox);

    // Run HUD
    const hudCode = fs.readFileSync('{ext_dir}/floating_hud.js', 'utf8');
    vm.runInContext(hudCode, sandbox);

    const isContextValidFn = sandbox.window.__QUIZZY_IS_EXTENSION_CONTEXT_VALID__;
    const initialValid = isContextValidFn();

    // Invalidate context by deleting runtime.id (exact Chrome MV3 orphaned context state)
    delete sandbox.chrome.runtime.id;
    const afterInvalid = isContextValidFn();

    // Trigger registered repeating interval ticks after invalidation
    // This should immediately detect invalid context, cancel interval, and unmount HUD host
    let threwException = false;
    try {{
      for (const fn of intervalCallbacks) {{
        fn();
      }}
    }} catch (err) {{
      threwException = true;
    }}

    console.log(JSON.stringify({{
      initialValid,
      afterInvalid,
      unmounted,
      clearedIntervalCount,
      threwException
    }}));
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip())

    assert out["initialValid"] is True, "Context should be valid when chrome.runtime.id is present"
    assert out["afterInvalid"] is False, "Context should be invalid when chrome.runtime.id is deleted"
    assert out["unmounted"] is True, "Orphaned HUD host should be unmounted upon interval tick"
    assert out["clearedIntervalCount"] > 0, "Interval should be cleared on invalid context tick"
    assert out["threwException"] is False, "Should not throw exceptions when context is invalidated"


def test_per_question_atomic_reset():
    """Verifies that every single question solve triggers the atomic reset (QUESTIONS_PER_RECYCLE = 1) while keeping Auto Mode active."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockNode {{
      constructor(tag) {{
        this.tagName = (tag || 'div').toUpperCase();
        this.className = '';
        this.textContent = '';
        this.innerText = '';
        this.children = [];
        this.style = {{}};
        this.attrs = {{}};
        this.classList = {{
          classes: new Set(),
          add(c) {{ this.classes.add(c); }},
          remove(c) {{ this.classes.delete(c); }},
          contains(c) {{ return this.classes.has(c); }}
        }};
      }}
      setAttribute(k, v) {{ this.attrs[k] = String(v); this[k] = v; }}
      getAttribute(k) {{ return this.attrs[k] !== undefined ? this.attrs[k] : (this[k] || null); }}
      removeAttribute(k) {{ delete this.attrs[k]; delete this[k]; }}
      appendChild(c) {{ this.children.push(c); return c; }}
      remove() {{}}
      attachShadow() {{ return new MockNode('shadow'); }}
      querySelector() {{ return null; }}
      querySelectorAll() {{ return []; }}
    }}

    const highlightedNode = new MockNode('div');
    highlightedNode.setAttribute('data-quizzy-highlight', 'true');
    highlightedNode.style.outline = '2px solid blue';

    const sentMessages = [];
    const sandbox = {{
      window: {{
        location: {{ pathname: '/course/quiz/1', search: '', hostname: 'learning.ccbp.in' }}
      }},
      document: Object.assign(new MockNode('document'), {{
        createElement: (tag) => new MockNode(tag),
        getElementById: () => null,
        querySelectorAll: (sel) => {{
          if (sel && sel.includes('data-quizzy-highlight')) return [highlightedNode];
          return [];
        }},
        body: new MockNode('body'),
        documentElement: new MockNode('html'),
        head: new MockNode('head')
      }}),
      console: console,
      setTimeout: () => {{}},
      clearTimeout: () => {{}},
      setInterval: () => {{}},
      clearInterval: () => {{}},
      requestAnimationFrame: () => {{}},
      cancelAnimationFrame: () => {{}},
      AbortController: class AbortController {{
        constructor() {{
          this.signal = {{ aborted: false }};
        }}
        abort() {{
          this.signal.aborted = true;
        }}
      }},
      chrome: {{
        runtime: {{
          id: 'test-ext-id',
          onMessage: {{ addListener: () => {{}} }},
          sendMessage: (msg, cb) => {{
            sentMessages.push(msg);
            if (cb) cb({{ success: true }});
          }}
        }},
        storage: {{ local: {{ get: () => {{}}, set: () => {{}}, onChanged: {{ addListener: () => {{}} }} }} }}
      }}
    }};

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('{ext_dir}/extractor.js', 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync('{ext_dir}/executor.js', 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync('{ext_dir}/floating_hud.js', 'utf8'), sandbox);

    // Seed stale state from Question N
    sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__ = [new MockNode('div'), new MockNode('div')];
    sandbox.window.__QUIZZY_LAST_EXTRACTION__ = {{ question: 'Question N?', options: ['A', 'B'] }};
    sandbox.window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ = highlightedNode;
    sandbox.window.__QUIZZY_PRE_CLICK_SNAPSHOTS__ = [{{ checked: false }}];
    const prevController = sandbox.window.QuizZyExecutor.getActiveAbortController ? sandbox.window.QuizZyExecutor.getActiveAbortController() : null;

    // Solve 1 single question -> must trigger atomic reset immediately (QUESTIONS_PER_RECYCLE === 1)
    sandbox.window.__QUIZZY_RECORD_SOLVE_CYCLE__();

    const nextController = sandbox.window.QuizZyExecutor.getActiveAbortController ? sandbox.window.QuizZyExecutor.getActiveAbortController() : null;
    const countAfter1 = sandbox.window.__QUIZZY_GET_SOLVES_SINCE_RECYCLE__();
    const lenAfter1 = sandbox.window.__QUIZZY_LAST_OPTION_ELEMENTS__.length;
    const lastExtAfter1 = sandbox.window.__QUIZZY_LAST_EXTRACTION__;
    const highlightRemoved = highlightedNode.getAttribute('data-quizzy-highlight') === null;
    const recycleMsgSent = sentMessages.some(m => m.type === 'QUIZZY_PERFORM_SOFT_RECYCLE' || m.action === 'QUIZZY_PERFORM_SOFT_RECYCLE');
    const hasResetFn = typeof sandbox.window.resetQuestionLifecycleState === 'function';

    console.log(JSON.stringify({{
      countAfter1,
      lenAfter1,
      lastExtAfter1,
      highlightRemoved,
      prevAborted: prevController ? prevController.signal.aborted : false,
      freshController: Boolean(nextController && nextController !== prevController && !nextController.signal.aborted),
      recycleMsgSent,
      hasResetFn
    }}));
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip())

    assert out["hasResetFn"] is True, "resetQuestionLifecycleState() must be exposed"
    assert out["countAfter1"] == 0, f"QUESTIONS_PER_RECYCLE must be 1 so counter resets after every question: {out['countAfter1']}"
    assert out["lenAfter1"] == 0, "window.__QUIZZY_LAST_OPTION_ELEMENTS__ must be cleared after 1 question"
    assert out["lastExtAfter1"] is None, "window.__QUIZZY_LAST_EXTRACTION__ must be cleared after 1 question"
    assert out["highlightRemoved"] is True, "[data-quizzy-highlight] must be stripped on atomic reset"
    assert out["prevAborted"] is True, "Previous activeExecutionAbortController must be aborted"
    assert out["freshController"] is True, "Fresh AbortController must be instantiated"
    assert out["recycleMsgSent"] is True, "Background recycle message must be sent after 1 question"


def test_swipeable_code_mcq_and_order_extraction_validation():
    """Verifies that swipeable/scrollable code boxes inside stems and options (including single-char options like '0' and off-screen scrollable <pre><code> blocks) extract cleanly and pass isValidExtractedQuestion without 422 validation errors."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    // Load background.js isValidExtractedQuestion & extractor.js in a mock DOM with off-screen swipeable code stem and single-char options
    const extCode = fs.readFileSync('{ext_dir}/extractor.js', 'utf8');
    const bgCode = fs.readFileSync('{ext_dir}/background.js', 'utf8');
    const fnMatch = bgCode.match(/function isValidExtractedQuestion\\([\\s\\S]*?\\n\\}}/);

    class MockElement {{
      constructor(tag, text = '', styles = {{}}, rect = null) {{
        this.tagName = (tag || 'div').toUpperCase();
        this.nodeType = 1;
        this.className = '';
        this.id = '';
        this._text = text;
        this.children = [];
        this.childNodes = [];
        this.parentElement = null;
        this.parentNode = null;
        this.attrs = {{}};
        this.style = Object.assign({{ display: 'block', visibility: 'visible', opacity: '1' }}, styles);
        this._rect = rect || {{ top: 100, left: 20, bottom: 150, right: 320, width: 300, height: 50, x: 20, y: 100 }};
        this.scrollWidth = this._rect.width || 300;
        this.scrollHeight = this._rect.height || 50;
      }}
      get innerText() {{
        if (this.children.length === 0) return this._text;
        return [this._text, ...this.children.map(c => c.innerText)].filter(Boolean).join('\\n');
      }}
      set innerText(v) {{ this._text = v; }}
      get textContent() {{ return this.innerText; }}
      set textContent(v) {{ this._text = v; }}
      setAttribute(k, v) {{ this.attrs[k] = String(v); }}
      getAttribute(k) {{ return this.attrs[k] !== undefined ? this.attrs[k] : null; }}
      hasAttribute(k) {{ return this.attrs[k] !== undefined; }}
      removeAttribute(k) {{ delete this.attrs[k]; }}
      appendChild(c) {{
        c.parentElement = this;
        c.parentNode = this;
        this.children.push(c);
        this.childNodes.push(c);
        return c;
      }}
      getBoundingClientRect() {{ return this._rect; }}
      cloneNode(deep) {{
        const copy = new MockElement(this.tagName, this._text, Object.assign({{}}, this.style), Object.assign({{}}, this._rect));
        copy.className = this.className;
        copy.attrs = Object.assign({{}}, this.attrs);
        if (deep) {{
          for (const ch of this.children) copy.appendChild(ch.cloneNode(true));
        }}
        return copy;
      }}
      matches(sel) {{
        const t = this.tagName.toLowerCase();
        const cls = String(this.className || '');
        if (sel.includes('pre') && t === 'pre') return true;
        if (sel.includes('code') && t === 'code') return true;
        if (sel.includes('option') && cls.includes('option-card')) return true;
        if (sel.includes('[role="radio"]') && this.getAttribute('role') === 'radio') return true;
        return false;
      }}
      closest(sel) {{
        let cur = this;
        while (cur) {{
          if (cur.matches && cur.matches(sel)) return cur;
          cur = cur.parentElement;
        }}
        return null;
      }}
      contains(other) {{
        let cur = other;
        while (cur) {{
          if (cur === this) return true;
          cur = cur.parentElement;
        }}
        return false;
      }}
      querySelectorAll(sel) {{
        const out = [];
        const visit = (node) => {{
          for (const ch of node.children || []) {{
            const t = ch.tagName.toLowerCase();
            const cls = String(ch.className || '');
            let matched = false;
            if (sel === '*' || (sel.includes(t) && new RegExp('\\\\b' + t + '\\\\b').test(sel))) matched = true;
            if (sel.includes('option') && cls.includes('option-card')) matched = true;
            if (sel.includes("role='radio'") && ch.getAttribute('role') === 'radio') matched = true;
            if (sel.includes('pre') && t === 'pre') matched = true;
            if (sel.includes('code') && t === 'code') matched = true;
            if (matched) out.push(ch);
            visit(ch);
          }}
        }};
        visit(this);
        return out;
      }}
      querySelector(sel) {{
        const all = this.querySelectorAll(sel);
        return all[0] || null;
      }}
    }}

    // Build swipeable container where code block is shifted horizontally (left: -500, right: -200, width: 0 bounding rect clip, but scrollWidth: 420)
    const body = new MockElement('body', '', {{}}, {{ top: 0, left: 0, bottom: 900, right: 1200, width: 1200, height: 900 }});
    const quizContainer = new MockElement('main', '', {{}}, {{ top: 40, left: 40, bottom: 800, right: 1000, width: 960, height: 760 }});
    body.appendChild(quizContainer);

    const swipeWrapper = new MockElement('div', '', {{ overflowX: 'auto', overflowY: 'hidden' }}, {{ top: 60, left: 40, bottom: 220, right: 600, width: 560, height: 160 }});
    swipeWrapper.className = 'swipeable-code-container';
    // Off-screen shifted pre>code inside swipeable container
    const preNode = new MockElement('pre', '', {{ overflowX: 'scroll' }}, {{ top: 70, left: -450, bottom: 200, right: -50, width: 0, height: 0 }});
    preNode.scrollWidth = 480;
    preNode.scrollHeight = 120;
    const codeNode = new MockElement('code', 'const arr = [10, 20, 30];\\nconsole.log(arr.indexOf(40));', {{}}, {{ top: 70, left: -450, bottom: 200, right: -50, width: 0, height: 0 }});
    codeNode.scrollWidth = 480;
    codeNode.scrollHeight = 120;
    preNode.appendChild(codeNode);
    swipeWrapper.appendChild(preNode);
    quizContainer.appendChild(swipeWrapper);

    // 4 single-character / code-box options: "-1", "0", "1", "A"
    const optValues = ['-1', '0', '1', 'A'];
    optValues.forEach((val, idx) => {{
      const optCard = new MockElement('div', '', {{ cursor: 'pointer' }}, {{ top: 260 + idx * 60, left: 50, bottom: 310 + idx * 60, right: 450, width: 400, height: 48 }});
      optCard.className = 'option-card';
      optCard.setAttribute('role', 'radio');
      const optCode = new MockElement('code', val, {{}}, {{ top: 265 + idx * 60, left: 60, bottom: 305 + idx * 60, right: 200, width: 140, height: 40 }});
      optCard.appendChild(optCode);
      quizContainer.appendChild(optCard);
    }});

    const sandbox = {{
      window: {{
        innerWidth: 1200,
        innerHeight: 900,
        location: {{ href: 'https://learning.ccbp.in/course/quiz', hostname: 'learning.ccbp.in', pathname: '/course/quiz' }},
        getComputedStyle: (el) => (el && el.style) ? el.style : {{ display: 'block', visibility: 'visible', opacity: '1' }}
      }},
      document: {{
        title: 'CCBP Quiz',
        body: body,
        documentElement: body,
        querySelector: (s) => body.querySelector(s),
        querySelectorAll: (s) => body.querySelectorAll(s),
        createTreeWalker: () => ({{ nextNode: () => null }})
      }},
      NodeFilter: {{ SHOW_TEXT: 4 }},
      HTMLElement: MockElement,
      Element: MockElement,
      Node: {{ ELEMENT_NODE: 1, TEXT_NODE: 3 }},
      console: console,
      setTimeout: (fn) => fn(),
      clearTimeout: () => {{}}
    }};
    sandbox.window.document = sandbox.document;
    sandbox.window.getComputedStyle = sandbox.window.getComputedStyle;

    vm.createContext(sandbox);
    vm.runInContext(extCode, sandbox);
    vm.runInContext(fnMatch[0], sandbox);

    const extracted = sandbox.window.QuizZyExtractor.extractQuizFromDom();
    const isValid = sandbox.isValidExtractedQuestion(extracted);

    console.log(JSON.stringify({{
      success: extracted.success,
      q_type: extracted.q_type,
      question: extracted.question,
      options: extracted.options,
      isValid
    }}));
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip())

    assert out["success"] is True, f"Extraction must succeed on swipeable code stem + single-char options: {out}"
    assert out["q_type"] == "mcq", f"Must classify as mcq (never code) when >= 2 options exist: {out['q_type']}"
    assert "arr.indexOf(40)" in out["question"], f"Swipeable code block must be included in question stem: {out['question']}"
    assert out["options"] == ["-1", "0", "1", "A"], f"Single-char code options ('0', '1', 'A') must be preserved intact: {out['options']}"
    assert out["isValid"] is True, "Extracted question must pass isValidExtractedQuestion()"


def test_smooth_order_swap_and_post_swap_submit_next():
    """Verifies that executeOrderAction swaps items using live DOM re-querying, normalizes step badges during verification, returns { ok: true, selected: true }, blurs the drag handle, and triggers Submit -> Next."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    const execCode = fs.readFileSync('{ext_dir}/executor.js', 'utf8');

    let blurredActiveElement = false;
    let submitClicked = false;
    let nextClicked = false;
    let keyboardEvents = [];

    class MockOrderCard {{
      constructor(id, text, idx) {{
        this.id = id;
        this.tagName = 'DIV';
        this.className = 'draggable-item';
        this._rawText = text;
        this.tabIndex = 0;
        this.style = {{ display: 'block', visibility: 'visible', opacity: '1' }};
        this.attrs = {{
          'draggable': 'true',
          'data-rbd-draggable-id': id,
          'data-rbd-drag-handle-draggable-id': id
        }};
        this.parentElement = null;
        this.children = [];
        this.classList = {{
          add() {{}},
          remove() {{}},
          contains() {{ return false; }}
        }};
      }}
      get innerText() {{ return this._rawText; }}
      get textContent() {{ return this._rawText; }}
      getAttribute(k) {{ return this.attrs[k] !== undefined ? this.attrs[k] : null; }}
      hasAttribute(k) {{ return this.attrs[k] !== undefined; }}
      setAttribute(k, v) {{ this.attrs[k] = String(v); }}
      removeAttribute(k) {{ delete this.attrs[k]; }}
      focus() {{ mockDoc.activeElement = this; }}
      blur() {{ blurredActiveElement = true; if (mockDoc.activeElement === this) mockDoc.activeElement = mockDoc.body; }}
      getBoundingClientRect() {{
        const idx = container.children.indexOf(this);
        return {{ top: 100 + idx * 60, bottom: 150 + idx * 60, left: 50, right: 450, width: 400, height: 50, x: 50, y: 100 + idx * 60 }};
      }}
      querySelector() {{ return null; }}
      querySelectorAll() {{ return []; }}
      closest() {{ return null; }}
      matches(sel) {{ return sel.includes('draggable'); }}
      dispatchEvent(ev) {{
        if (ev && ev.type === 'keydown') {{
          keyboardEvents.push(ev.keyCode || ev.key);
          const idx = container.children.indexOf(this);
          if ((ev.key === 'ArrowUp' || ev.keyCode === 38) && idx > 0) {{
            const temp = container.children[idx - 1];
            container.children[idx - 1] = this;
            container.children[idx] = temp;
          }} else if ((ev.key === 'ArrowDown' || ev.keyCode === 40) && idx < container.children.length - 1) {{
            const temp = container.children[idx + 1];
            container.children[idx + 1] = this;
            container.children[idx] = temp;
          }}
        }}
        return true;
      }}
    }}

    const container = {{
      tagName: 'DIV',
      className: 'order-list',
      style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
      children: [
        new MockOrderCard('c1', '1. ⋮⋮ console.log(res);', 0),
        new MockOrderCard('c2', '2. ⋮⋮ const a = 5;', 1),
        new MockOrderCard('c3', '3. ⋮⋮ const res = a * 2;', 2)
      ],
      querySelectorAll(sel) {{
        if (sel.includes('draggable') || sel.includes('rbd')) return this.children.slice();
        return [];
      }},
      querySelector(sel) {{ return this.children[0] || null; }},
      getBoundingClientRect() {{ return {{ top: 80, left: 40, bottom: 320, right: 460, width: 420, height: 240 }}; }}
    }};
    container.children.forEach(c => c.parentElement = container);

    const submitBtn = {{
      tagName: 'BUTTON',
      className: 'submit-btn',
      innerText: 'Submit',
      textContent: 'Submit',
      disabled: false,
      style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: () => null,
      matches: () => false,
      getBoundingClientRect: () => ({{ top: 400, left: 200, bottom: 440, right: 320, width: 120, height: 40 }}),
      click() {{
        submitClicked = true;
        // After submit is clicked, transform into Next button
        this.innerText = 'Next';
        this.textContent = 'Next';
      }},
      dispatchEvent(ev) {{
        if (ev && ev.type === 'click') {{
          if (this.innerText === 'Submit') {{
            submitClicked = true;
            this.innerText = 'Next';
            this.textContent = 'Next';
          }} else if (this.innerText === 'Next') {{
            nextClicked = true;
          }}
        }}
        return true;
      }}
    }};

    const mockDoc = {{
      body: {{
        tagName: 'BODY',
        style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
        querySelectorAll: (sel) => {{
          if (sel.includes('button')) return [submitBtn];
          if (sel.includes('draggable') || sel.includes('rbd')) return container.children.slice();
          return [];
        }},
        querySelector: () => null
      }},
      documentElement: {{ clientWidth: 1200, clientHeight: 900 }},
      activeElement: container.children[0],
      querySelectorAll(sel) {{
        if (sel.includes('button')) return [submitBtn];
        if (sel.includes('draggable') || sel.includes('rbd')) return container.children.slice();
        return [];
      }},
      querySelector(sel) {{
        if (sel.includes('button')) return submitBtn;
        return null;
      }},
      elementFromPoint: () => submitBtn
    }};

    const sandbox = {{
      window: {{
        innerWidth: 1200,
        innerHeight: 900,
        location: {{ hostname: 'learning.ccbp.in', pathname: '/course/quiz' }},
        getComputedStyle: (el) => (el && el.style) ? el.style : {{ display: 'block', visibility: 'visible', opacity: '1' }},
        PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        KeyboardEvent: class KeyboardEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }}
      }},
      document: mockDoc,
      PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      KeyboardEvent: class KeyboardEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      Element: MockOrderCard,
      HTMLElement: MockOrderCard,
      console: console,
      setTimeout: (fn) => {{ Promise.resolve().then(fn); return 1; }},
      clearTimeout: () => {{}}
    }};
    sandbox.window.document = mockDoc;

    vm.createContext(sandbox);
    vm.runInContext(execCode, sandbox);

    (async () => {{
      const res = await sandbox.window.QuizZyExecutor.executeQuizAction({{
        q_type: 'order',
        action: 'submit_then_next',
        ordered_texts: [
          'const a = 5;',
          'const res = a * 2;',
          'console.log(res);'
        ]
      }});

      const finalOrder = container.children.map(c => c.id);
      console.log(JSON.stringify({{
        ok: res.ok,
        selected: res.selected,
        verified: res.verified,
        q_type: res.q_type,
        finalOrder,
        blurredActiveElement,
        submitClicked,
        nextClicked
      }}));
    }})();
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip().splitlines()[-1])

    assert out["finalOrder"] == ["c2", "c3", "c1"], f"Cards must be reordered into ['c2', 'c3', 'c1']: {out['finalOrder']}"
    assert out["ok"] is True, f"executeOrderAction must return ok: true: {out}"
    assert out["selected"] is True, f"executeOrderAction must return selected: true: {out}"
    assert out["verified"] is True, f"executeOrderAction must return verified: true: {out}"
    assert out["blurredActiveElement"] is True, "Focused drag handle must be blurred before Submit"
    assert out["submitClicked"] is True, "Submit button must be clicked after order verification"


def test_multi_answer_sequential_verification_all_options():
    """Verifies that executeMultiMcqAction clicks multiple checkboxes ([0, 2, 3]) sequentially with async React render delays, re-resolves replaced DOM nodes, and verifies all 3 options are checked."""
    ext_dir = (Path(__file__).resolve().parent.parent / "extension").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    const execCode = fs.readFileSync('{ext_dir}/executor.js', 'utf8');

    const clickTimestamps = [];
    let currentPerfTime = 1000;

    function createOptionRow(text, idx, isChecked = false) {{
      const boxIndicator = {{
        tagName: 'DIV',
        className: isChecked ? 'checkbox-box checked-indicator' : 'checkbox-box',
        style: {{
          display: 'inline-block',
          visibility: 'visible',
          opacity: '1',
          backgroundColor: isChecked ? 'rgb(37, 99, 235)' : 'rgb(255, 255, 255)',
          borderColor: isChecked ? 'rgb(37, 99, 235)' : 'rgb(203, 213, 225)'
        }},
        attrs: {{}},
        getAttribute(k) {{ return this.attrs[k] || null; }},
        hasAttribute(k) {{ return this.attrs[k] !== undefined; }},
        querySelector() {{ return null; }},
        querySelectorAll() {{ return []; }}
      }};

      const svgCheck = isChecked ? {{ tagName: 'SVG', className: 'check-icon' }} : null;

      const row = {{
        tagName: 'DIV',
        className: isChecked ? 'multi-option-card selected-row' : 'multi-option-card',
        innerText: text,
        textContent: text,
        _checked: isChecked,
        style: {{
          display: 'flex',
          visibility: 'visible',
          opacity: '1',
          backgroundColor: isChecked ? 'rgb(239, 246, 255)' : 'rgb(255, 255, 255)',
          borderColor: isChecked ? 'rgb(37, 99, 235)' : 'rgb(226, 232, 240)'
        }},
        attrs: {{ 'role': 'checkbox', 'aria-checked': isChecked ? 'true' : 'false' }},
        classList: {{
          add(c) {{ row.className += ' ' + c; }},
          remove(c) {{}},
          contains(c) {{ return row.className.includes(c); }}
        }},
        getAttribute(k) {{ return this.attrs[k] !== undefined ? this.attrs[k] : null; }},
        hasAttribute(k) {{ return this.attrs[k] !== undefined; }},
        setAttribute(k, v) {{ this.attrs[k] = String(v); }},
        removeAttribute(k) {{ delete this.attrs[k]; }},
        getBoundingClientRect() {{
          return {{ top: 120 + idx * 60, bottom: 170 + idx * 60, left: 60, right: 460, width: 400, height: 50, x: 60, y: 120 + idx * 60 }};
        }},
        closest() {{ return null; }},
        matches(sel) {{ return sel.includes('checkbox') || sel.includes('option'); }},
        querySelector(sel) {{
          if (sel.includes('svg') && svgCheck) return svgCheck;
          if (sel.includes('box') || sel.includes('check') || sel.includes('indicator')) return boxIndicator;
          return null;
        }},
        querySelectorAll(sel) {{
          const res = [boxIndicator];
          if (svgCheck) res.push(svgCheck);
          return res;
        }},
        click() {{
          clickTimestamps.push({{ idx, time: currentPerfTime }});
          // Simulate React re-rendering & replacing the DOM node in liveOptionRows on click!
          const nextChecked = !this._checked;
          liveOptionRows[idx] = createOptionRow(text, idx, nextChecked);
        }},
        dispatchEvent(ev) {{
          if (ev && ev.type === 'click') {{
            this.click();
          }}
          return true;
        }}
      }};
      return row;
    }}

    const optionTexts = ['Option Alpha', 'Option Beta', 'Option Gamma', 'Option Delta'];
    const liveOptionRows = optionTexts.map((t, i) => createOptionRow(t, i, false));

    const mockDoc = {{
      body: {{
        tagName: 'BODY',
        style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
        querySelectorAll: () => liveOptionRows.slice(),
        querySelector: () => liveOptionRows[0]
      }},
      documentElement: {{ clientWidth: 1200, clientHeight: 900 }},
      querySelectorAll(sel) {{
        if (sel.includes('checkbox') || sel.includes('option') || sel.includes('div')) return liveOptionRows.slice();
        return [];
      }},
      querySelector(sel) {{ return liveOptionRows[0] || null; }}
    }};

    const sandbox = {{
      window: {{
        innerWidth: 1200,
        innerHeight: 900,
         __QUIZZY_LAST_OPTION_ELEMENTS__: liveOptionRows.map(el => ({{ deref: () => el }})),
        location: {{ hostname: 'learning.ccbp.in', pathname: '/course/quiz' }},
        getComputedStyle: (el) => (el && el.style) ? el.style : {{ display: 'block', visibility: 'visible', opacity: '1' }},
        PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }}
      }},
      document: mockDoc,
      PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      console: console,
      setTimeout: (fn, ms) => {{
        currentPerfTime += (ms || 0);
        Promise.resolve().then(fn);
        return 1;
      }},
      clearTimeout: () => {{}}
    }};
    sandbox.window.document = mockDoc;

    vm.createContext(sandbox);
    vm.runInContext(execCode, sandbox);

    (async () => {{
      const res = await sandbox.window.QuizZyExecutor.executeQuizAction({{
        q_type: 'multi',
        action: 'select_only',
        selected_indices: [0, 2, 3],
        options: optionTexts
      }});

      const checkedStates = liveOptionRows.map(r => r._checked);
      console.log(JSON.stringify({{
        ok: res.ok,
        selected: res.selected,
        verified: res.verified,
        checkedStates,
        clickTimestamps
      }}));
    }})();
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip().splitlines()[-1])

    assert out["checkedStates"] == [True, False, True, True], f"All target options [0, 2, 3] must be checked and [1] unchecked: {out['checkedStates']}"
    assert out["ok"] is True, f"executeMultiMcqAction must return ok: true: {out}"
    assert out["selected"] is True, f"executeMultiMcqAction must return selected: true: {out}"
    assert out["verified"] is True, f"executeMultiMcqAction must return verified: true: {out}"
    assert len(out["clickTimestamps"]) >= 3, f"Must sequentially click all 3 target checkboxes: {out['clickTimestamps']}"
    assert out["clickTimestamps"][1]["time"] - out["clickTimestamps"][0]["time"] >= 110, f"Must wait >= 110ms between sequential checkbox clicks: {out['clickTimestamps']}"


def test_ccbp_box_type_controlled_textarea_and_katex_order_reorder():
    """Verify React 18 controlled textarea input with _valueTracker and KaTeX order list reordering."""
    executor_path = (Path(__file__).resolve().parent.parent / "extension" / "executor.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');
    const execCode = fs.readFileSync('{executor_path}', 'utf8');

    let reactControlledValue = '';
    let trackerValue = '';
    const textareaEl = {{
      tagName: 'TEXTAREA',
      placeholder: 'Enter your answer',
      disabled: false,
      readOnly: false,
      style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
      _attrs: {{ placeholder: 'Enter your answer' }},
      _valueTracker: {{
        getValue: () => trackerValue,
        setValue: (v) => {{ trackerValue = v; }}
      }},
      getAttribute(k) {{ return this._attrs[k] || null; }},
      setAttribute(k, v) {{ this._attrs[k] = String(v); }},
      getBoundingClientRect: () => ({{ left: 200, top: 300, width: 400, height: 110, right: 600, bottom: 410 }}),
      focus: () => {{}},
      click: () => {{}},
      dispatchEvent(ev) {{
        if (ev && (ev.type === 'input' || ev.type === 'change')) {{
          if (this.value !== trackerValue) {{
            reactControlledValue = this.value;
            trackerValue = this.value;
          }}
        }}
        return true;
      }},
      value: ''
    }};

    // KaTeX draggable rows where raw textContent duplicates math token (temp1temp1)
    let fiberStateOrder = [
      {{ id: 'a', text: 'Merge temp1 and temp2 lists' }},
      {{ id: 'b', text: 'Initialize temp1 to head and temp2 to the next node' }},
      {{ id: 'c', text: 'Store the next node of temp2' }},
      {{ id: 'd', text: 'Move temp2 to the next stored node' }}
    ];
    let setStateCalls = [];
    const listContainer = {{
      tagName: 'DIV',
      style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
      __reactFiber$xyz: {{
        memoizedState: {{
          memoizedState: fiberStateOrder,
          queue: {{
            dispatch: (updater) => {{
              const next = typeof updater === 'function' ? updater(fiberStateOrder) : updater;
              fiberStateOrder = next;
              setStateCalls.push(next.map(x => x.id));
            }}
          }},
          next: null
        }},
        memoizedProps: {{}},
        return: null
      }},
      get children() {{
        return fiberStateOrder.map((item, idx) => ({{
          tagName: 'DIV',
          innerText: (idx + 1) + ' ' + item.text.replace(/temp1/g, 'temp1temp1').replace(/temp2/g, 'temp2temp2'),
          textContent: (idx + 1) + ' ' + item.text.replace(/temp1/g, 'temp1temp1').replace(/temp2/g, 'temp2temp2'),
          style: {{ display: 'flex', visibility: 'visible', opacity: '1' }},
          parentElement: listContainer,
          getAttribute: () => null,
          querySelector: () => null,
          querySelectorAll: () => [],
          cloneNode: function() {{
            return {{
              innerText: (idx + 1) + ' ' + item.text,
              textContent: (idx + 1) + ' ' + item.text,
              querySelectorAll: () => []
            }};
          }},
          getBoundingClientRect: () => ({{ left: 230, top: 200 + idx * 60, width: 540, height: 50, right: 770, bottom: 250 + idx * 60 }})
        }}));
      }},
      querySelectorAll: () => []
    }};

    const mockDoc = {{
      body: {{
        tagName: 'BODY',
        style: {{ display: 'block', visibility: 'visible', opacity: '1' }},
        querySelectorAll: (sel) => {{
          if (sel.includes('textarea')) return [textareaEl];
          if (sel.includes('div')) return listContainer.children;
          return [];
        }},
        querySelector: (sel) => sel.includes('textarea') ? textareaEl : null
      }},
      documentElement: {{ clientWidth: 1280, clientHeight: 800 }},
      querySelectorAll: (sel) => {{
        if (sel.includes('textarea')) return [textareaEl];
        if (sel.includes('div')) return listContainer.children;
        return [];
      }},
      querySelector: (sel) => sel.includes('textarea') ? textareaEl : null
    }};

    const sandbox = {{
      window: {{
        innerWidth: 1280,
        innerHeight: 800,
        location: {{ hostname: 'learning.ccbp.in', pathname: '/primitive-coding/practice' }},
        getComputedStyle: () => ({{ display: 'block', visibility: 'visible', opacity: '1' }}),
        HTMLTextAreaElement: {{ prototype: {{}} }},
        HTMLInputElement: {{ prototype: {{}} }},
        InputEvent: class InputEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        KeyboardEvent: class KeyboardEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
        Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }}
      }},
      document: mockDoc,
      InputEvent: class InputEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      KeyboardEvent: class KeyboardEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      PointerEvent: class PointerEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      MouseEvent: class MouseEvent {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      Event: class Event {{ constructor(t, o) {{ this.type = t; Object.assign(this, o); }} }},
      console: console,
      setTimeout: (fn) => {{ Promise.resolve().then(fn); return 1; }},
      clearTimeout: () => {{}}
    }};
    sandbox.window.document = mockDoc;

    vm.createContext(sandbox);
    vm.runInContext(execCode, sandbox);

    (async () => {{
      const textRes = await sandbox.window.QuizZyExecutor.executeQuizAction({{
        q_type: 'text',
        action: 'select_only',
        answer: '1 2 3 4 5 7 8 9 10 11 12 15 20',
        selected_text: '1 2 3 4 5 7 8 9 10 11 12 15 20'
      }});

      const orderedTargets = [
        'Initialize temp1 to head and temp2 to the next node',
        'Store the next node of temp2',
        'Move temp2 to the next stored node',
        'Merge temp1 and temp2 lists'
      ];
      const fiberRes = sandbox.window.QuizZyExecutor.reorderReactListInMainWorld({{
        ordered_texts: orderedTargets
      }});

      console.log(JSON.stringify({{
        textOk: textRes.ok,
        reactControlledValue,
        dataQuizzySelected: textareaEl.getAttribute('data-quizzy-selected'),
        fiberSuccess: fiberRes.success,
        finalIds: fiberStateOrder.map(x => x.id)
      }}));
    }})();
    """

    res = subprocess.run(["node", "-e", node_script], capture_output=True, text=True, check=True)
    out = json.loads(res.stdout.strip().splitlines()[-1])

    assert out["textOk"] is True
    assert out["reactControlledValue"] == "1 2 3 4 5 7 8 9 10 11 12 15 20"
    assert out["dataQuizzySelected"] == "true"
    assert out["fiberSuccess"] is True
    assert out["finalIds"] == ["b", "c", "d", "a"]


@pytest.mark.anyio
async def test_groq_qwen_vision_multimodal_and_decorative_logo_filtering():
    """Verify qwen/qwen3.8-27b preserves image_url payloads with OTPM-safe max_tokens and text questions ignore decorative logo URLs."""
    from backend.core.providers import call_single_completion
    from backend.core.llm_client import solve_question

    captured_payloads = []

    class FakeResp:
        status_code = 200
        headers = {}
        text = ""
        def json(self):
            return {
                "choices": [{
                    "message": {
                        "content": '<verification_workspace>Roof=9, Box=8 -> 17</verification_workspace><verified_json>{"reason":"9+8=17","answer":"A"}</verified_json>'
                    }
                }]
            }

    class FakeClient:
        is_closed = False
        async def post(self, url, headers=None, json=None, timeout=None):
            captured_payloads.append(json)
            return FakeResp()

    vision_msgs = [{
        "role": "user",
        "content": [
            {"type": "text", "text": "Find the number of triangles"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}
        ]
    }]

    raw, el, err = await call_single_completion(
        FakeClient(), "groq", "meta-llama/llama-4-scout-17b-16e-instruct", vision_msgs, "gsk_test", 4500, max_tokens=1024
    )
    assert err is None
    assert len(captured_payloads) == 1
    sent = captured_payloads[0]
    assert sent["model"] == "qwen/qwen3.8-27b", "Decommissioned scout model must map to qwen/qwen3.8-27b"
    assert sent["max_tokens"] <= 512, "Groq qwen3.8-27b max_tokens must stay <= 512 to respect 1000 OTPM limit"
    assert isinstance(sent["messages"][0]["content"], list), "Multimodal image_url list must NOT be stripped for qwen/qwen3.8-27b"




