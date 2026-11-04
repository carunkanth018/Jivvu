"""Order-invariant SQLite cache for QuizZy with dynamic index remapping."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Tuple

from backend.core.normalizer import (
    normalize_mcq_answer,
    normalize_order_answer,
    normalize_text_answer,
)
from backend.db_util import connect_sqlite_wal


DEFAULT_DB_PATH = Path(__file__).resolve().parent / "quizzy_cache.db"


def get_db_path(custom_path: Optional[str] = None) -> Path:
    """Resolve database path from argument, environment, or default."""
    if custom_path:
        return Path(custom_path)
    env_path = os.getenv("QUIZZY_DB_PATH", "").strip()
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def get_connection(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Open SQLite connection with WAL mode enabled."""
    return connect_sqlite_wal(get_db_path(db_path), timeout=10.0)


@contextmanager
def get_db(db_path: Optional[str] = None) -> Generator[sqlite3.Connection, None, None]:
    """Context manager ensuring connection is always closed cleanly."""
    conn = get_connection(db_path)
    try:
        yield conn
    finally:
        conn.close()


def init_db(db_path: Optional[str] = None) -> None:
    """Initialize database tables and indexes."""
    with get_db(db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS solve_cache (
                cache_key TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                q_type TEXT NOT NULL,
                question TEXT NOT NULL,
                canonical_answer_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                confidence_tier TEXT NOT NULL,
                confidence_label TEXT NOT NULL,
                confidence_score REAL NOT NULL,
                model_a TEXT,
                model_b TEXT,
                fallback_used INTEGER DEFAULT 0,
                hit_count INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS wrong_answers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cache_key TEXT UNIQUE,
                subject TEXT NOT NULL,
                q_type TEXT NOT NULL,
                question TEXT NOT NULL,
                options_json TEXT NOT NULL,
                wrong_model_answer TEXT,
                correct_canonical_json TEXT,
                confidence_tier_at_failure TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS cache_stats (
                metric TEXT PRIMARY KEY,
                value INTEGER DEFAULT 0
            );
        """)
        conn.execute("INSERT OR IGNORE INTO cache_stats (metric, value) VALUES ('hits', 0);")
        conn.execute("INSERT OR IGNORE INTO cache_stats (metric, value) VALUES ('misses', 0);")

        # Dynamic schema migration for SearXNG tracking
        cursor = conn.execute("PRAGMA table_info(solve_cache);")
        cols = {row["name"] for row in cursor.fetchall()}
        if "searxng_used" not in cols:
            conn.execute("ALTER TABLE solve_cache ADD COLUMN searxng_used INTEGER DEFAULT 0;")
        if "search_sources" not in cols:
            conn.execute("ALTER TABLE solve_cache ADD COLUMN search_sources TEXT DEFAULT '[]';")

        conn.commit()


_LABEL_PATTERN = r"(?:\(?[a-f1-6]\)?|\(?(?:iv|iii|ii|i)\)?)"
_RELATIVE_OPTION_REGEX = re.compile(
    r"\b(?:all|none)\s+of\s+(?:the\s+above|these)\b|"
    rf"\bboth\s+{_LABEL_PATTERN}\s*(?:and|&)\s*{_LABEL_PATTERN}\b|"
    rf"\bneither\s+{_LABEL_PATTERN}\s+nor\s+{_LABEL_PATTERN}\b|"
    r"\b(?:only|options?)\s+\([a-f1-6]\)|"
    r"\b(?:only|options?)\s+[a-f1-6]\s*$|"
    r"\b(?:only|options?)\s+[a-f1-6]\s+(?:is|are|and|or)\b|"
    rf"\boptions?\s+{_LABEL_PATTERN}\s+(?:and|or)\s+{_LABEL_PATTERN}\b",
    re.IGNORECASE,
)


def is_relative_or_positional_option(text: str) -> bool:
    """Return True if the option text contains positional/relative references to other options."""
    if not text:
        return False
    return bool(_RELATIVE_OPTION_REGEX.search(str(text).strip()))


def compute_cache_key(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
    image_data: Optional[str] = None,
    image_url: Optional[str] = None,
) -> str:
    """
    Deterministic order-invariant cache key:
    - Normalizes subject and question.
    - If image_data or image_url is provided, includes a SHA-256 digest of the visual asset.
    - For code: hashes subject, 'code', question, language, and starter_code.
    - For mcq and order: normalizes each option string and sorts alphabetically (unless positional options exist).
    - For text: options list is empty.
    - Returns SHA-256 hex digest.
    """
    norm_subject = normalize_text_answer(subject)
    norm_type = q_type.strip().lower()
    norm_question = normalize_text_answer(question)

    img_hash = ""
    img_source = (image_data or "").strip() or (image_url or "").strip()
    if img_source:
        img_hash = hashlib.sha256(img_source.encode("utf-8")).hexdigest()[:16]

    if norm_type == "code":
        lang = (language or "").strip().lower()
        starter = (starter_code or "").strip()
        payload = f"{norm_subject}|code|{norm_question}|{lang}|{starter}|{img_hash}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()
    elif norm_type in ("mcq", "order", "multi") and options:
        # Detect positional / relative options (e.g. "Both A and B", "All of the above", "None of the above")
        # When present, preserve unsorted order in the cache key so positional answers remain accurate.
        has_relative = any(is_relative_or_positional_option(opt) for opt in options)
        if has_relative:
            norm_opts = [normalize_text_answer(opt) for opt in options]
            opts_repr = "positional:" + json.dumps(norm_opts, separators=(",", ":"))
        else:
            norm_opts = sorted([normalize_text_answer(opt) for opt in options])
            opts_repr = json.dumps(norm_opts, separators=(",", ":"))
    else:
        opts_repr = "[]"

    payload = f"{norm_subject}|{norm_type}|{norm_question}|{opts_repr}|{img_hash}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def get_cached_solution(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    db_path: Optional[str] = None,
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
    image_data: Optional[str] = None,
    image_url: Optional[str] = None,
) -> Optional[dict]:
    """
    Lookup answer in SQLite cache and dynamically remap synthetic keys
    and indices to the current request's visual option order.
    Returns None on cache miss or incompatible remapping.
    """
    init_db(db_path)
    key = compute_cache_key(
        subject, q_type, question, options,
        language=language,
        starter_code=starter_code,
        image_data=image_data,
        image_url=image_url,
    )
    norm_type = q_type.strip().lower()

    with get_db(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM solve_cache WHERE cache_key = ?", (key,)
        ).fetchone()

        if not row:
            conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
            conn.commit()
            return None

        # Cache hit found - unpack canonical answer
        canonical_raw = json.loads(row["canonical_answer_json"])

        # Dynamic Remapping by question type
        if norm_type == "mcq":
            target_norm = normalize_text_answer(str(canonical_raw))
            found_idx = None
            for idx, opt in enumerate(options):
                if normalize_text_answer(opt) == target_norm:
                    found_idx = idx
                    break

            if found_idx is None:
                conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
                conn.commit()
                return None

            remapped_answer = chr(65 + found_idx)
            remapped_index = found_idx
            remapped_text = options[found_idx]
            permutation_indices = None
            ordered_texts = None

        elif norm_type == "order":
            if not isinstance(canonical_raw, list) or len(canonical_raw) != len(options):
                conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
                conn.commit()
                return None

            used_indices: set = set()
            remapped_indices: List[int] = []
            for target_item in canonical_raw:
                target_item_norm = normalize_text_answer(str(target_item))
                found_i = None
                for idx, opt in enumerate(options):
                    if idx not in used_indices and normalize_text_answer(opt) == target_item_norm:
                        found_i = idx
                        break
                if found_i is None:
                    cand = [
                        idx for idx, opt in enumerate(options)
                        if idx not in used_indices and target_item_norm and (target_item_norm in normalize_text_answer(opt) or normalize_text_answer(opt) in target_item_norm)
                    ]
                    if len(cand) == 1:
                        found_i = cand[0]

                if found_i is not None and found_i not in used_indices:
                    used_indices.add(found_i)
                    remapped_indices.append(found_i)
                else:
                    break

            if len(remapped_indices) != len(options):
                conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
                conn.commit()
                return None

            remapped_answer = ",".join([chr(65 + idx) for idx in remapped_indices])
            remapped_index = None
            remapped_text = None
            permutation_indices = remapped_indices
            ordered_texts = [options[idx] for idx in remapped_indices]

        elif norm_type in ("multi", "multi_mcq", "multiselect"):
            if not isinstance(canonical_raw, list):
                canonical_raw = [canonical_raw]
            remapped_indices: List[int] = []
            for target_item in canonical_raw:
                target_item_norm = normalize_text_answer(str(target_item))
                for idx, opt in enumerate(options):
                    if normalize_text_answer(opt) == target_item_norm and idx not in remapped_indices:
                        remapped_indices.append(idx)
                        break

            if not remapped_indices:
                conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
                conn.commit()
                return None

            remapped_indices.sort()
            canonical_keys = [chr(65 + idx) for idx in remapped_indices]
            selected_texts = [options[idx] for idx in remapped_indices]
            remapped_answer = ",".join(canonical_keys)
            remapped_index = remapped_indices[0]
            remapped_text = ", ".join(selected_texts)
            permutation_indices = None
            ordered_texts = None

        elif norm_type in ("text", "code"):
            remapped_answer = str(canonical_raw)
            remapped_index = None
            remapped_text = remapped_answer
            permutation_indices = None
            ordered_texts = None

        else:
            conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'misses';")
            conn.commit()
            return None

        # Increment hit counters
        conn.execute("UPDATE solve_cache SET hit_count = hit_count + 1 WHERE cache_key = ?;", (key,))
        conn.execute("UPDATE cache_stats SET value = value + 1 WHERE metric = 'hits';")
        conn.commit()

        return {
            "status": "ok",
            "q_type": norm_type,
            "answer": remapped_answer,
            "selected_index": remapped_index,
            "selected_text": remapped_text,
            "selected_indices": remapped_indices if norm_type in ("multi", "multi_mcq", "multiselect") else None,
            "selected_texts": selected_texts if norm_type in ("multi", "multi_mcq", "multiselect") else None,
            "canonical_keys": canonical_keys if norm_type in ("multi", "multi_mcq", "multiselect") else None,
            "permutation_indices": permutation_indices,
            "ordered_texts": ordered_texts,
            "reason": row["reason"],
            "confidence_tier": row["confidence_tier"],
            "confidence_label": row["confidence_label"],
            "confidence_score": float(row["confidence_score"]),
            "auto_eligible": (
                row["confidence_tier"].startswith("HIGH_")
                or row["confidence_tier"] in (
                    "USER_VERIFIED_OVERRIDE",
                    "MEDIUM_TIEBREAKER_AGREE",
                    "MEDIUM_SEARXNG_GROUNDED",
                    "SINGLE_PRIMARY_PASSED",
                )
            ),
            "cache_hit": True,
            "models_called": [],
            "hit_count": row["hit_count"] + 1,
            "searxng_used": bool(row["confidence_tier"] == "MEDIUM_SEARXNG_GROUNDED" or ("searxng_used" in row.keys() and row["searxng_used"])),
            "search_sources": json.loads(row["search_sources"]) if ("search_sources" in row.keys() and row["search_sources"]) else [],
        }


def cache_solution(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    solver_res: Any,
    db_path: Optional[str] = None,
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
    image_data: Optional[str] = None,
    image_url: Optional[str] = None,
) -> bool:
    """
    Zero-Poison Rule:
    Writes to solve_cache ONLY if confidence_tier is high or medium.
    Never caches LOW_FALLBACK_RESCUE or UNCERTAIN_*.
    """
    init_db(db_path)
    tier = getattr(solver_res, "confidence_tier", "")
    status = getattr(solver_res, "status", "")

    if status.upper() != "OK" or not (
        tier.startswith("HIGH_")
        or tier in (
            "MEDIUM_TIEBREAKER_AGREE",
            "MEDIUM_SEARXNG_GROUNDED",
            "USER_VERIFIED_OVERRIDE",
            "SINGLE_PRIMARY_PASSED",
        )
    ):
        return False

    norm_type = q_type.strip().lower()

    if norm_type == "mcq":
        selected_text = getattr(solver_res, "selected_text", None)
        selected_index = getattr(solver_res, "selected_index", None)
        if selected_text:
            canonical_payload = selected_text
        elif selected_index is not None and 0 <= selected_index < len(options):
            canonical_payload = options[selected_index]
        else:
            return False

    elif norm_type in ("multi", "multi_mcq", "multiselect"):
        selected_texts = getattr(solver_res, "selected_texts", None)
        selected_indices = getattr(solver_res, "selected_indices", None)
        if selected_texts:
            canonical_payload = selected_texts
        elif selected_indices:
            canonical_payload = [options[i] for i in selected_indices if 0 <= i < len(options)]
        else:
            return False

    elif norm_type == "order":
        ordered_texts = getattr(solver_res, "ordered_texts", None)
        perm_indices = getattr(solver_res, "permutation_indices", None)
        if ordered_texts and len(ordered_texts) == len(options):
            canonical_payload = ordered_texts
        elif perm_indices and len(perm_indices) == len(options):
            canonical_payload = [options[i] for i in perm_indices]
        else:
            return False

    elif norm_type == "text":
        canon_key = getattr(solver_res, "canonical_key", "")
        if not canon_key:
            return False
        canonical_payload = canon_key

    elif norm_type == "code":
        code_ans = (
            getattr(solver_res, "answer", None)
            or getattr(solver_res, "selected_text", None)
            or getattr(solver_res, "raw_answer", None)
            or getattr(solver_res, "canonical_key", "")
        )
        if not code_ans:
            return False
        canonical_payload = code_ans

    else:
        return False

    key = compute_cache_key(
        subject, q_type, question, options,
        language=language,
        starter_code=starter_code,
        image_data=image_data,
        image_url=image_url,
    )
    if tier.startswith("HIGH_"):
        score = 1.0
        label = "high"
    elif tier == "MEDIUM_SEARXNG_GROUNDED":
        score = 0.75
        label = "medium"
    else:
        score = 0.67
        label = "medium"

    agreement = getattr(solver_res, "agreement_details", {}) or {}
    model_a = agreement.get("primary_a", {}).get("model", "")
    model_b = agreement.get("primary_b", {}).get("model", "")
    fallback_used = 1 if "fallback" in getattr(solver_res, "models_called", []) else 0
    searxng_used = 1 if getattr(solver_res, "searxng_used", False) else 0
    search_sources_json = json.dumps(getattr(solver_res, "search_sources", []) or [])

    with get_db(db_path) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO solve_cache (
                cache_key, subject, q_type, question, canonical_answer_json,
                reason, confidence_tier, confidence_label, confidence_score,
                model_a, model_b, fallback_used, hit_count, created_at,
                searxng_used, search_sources
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), ?, ?)
        """, (
            key,
            subject,
            norm_type,
            question,
            json.dumps(canonical_payload),
            getattr(solver_res, "reason", "") or "",
            tier,
            label,
            score,
            model_a,
            model_b,
            fallback_used,
            searxng_used,
            search_sources_json,
        ))
        conn.commit()

    return True


def record_wrong_answer(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    wrong_model_answer: str = "",
    correct_answer: Optional[Any] = None,
    confidence_tier_at_failure: str = "",
    notes: str = "",
    db_path: Optional[str] = None,
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
    image_data: Optional[str] = None,
    image_url: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Record a wrong answer report with order-invariant cache key.
    - If correct_answer is None/empty: Evicts any entry from solve_cache and logs to wrong_answers.
      Returns ("evicted_and_logged", cache_key).
    - If correct_answer is provided: Resolves to canonical text format, overrides solve_cache with
      confidence_tier = USER_VERIFIED_OVERRIDE, and logs to wrong_answers.
      Returns ("overridden_and_logged", cache_key).
    """
    init_db(db_path)
    key = compute_cache_key(
        subject, q_type, question, options,
        language=language,
        starter_code=starter_code,
        image_data=image_data,
        image_url=image_url,
    )
    norm_type = q_type.strip().lower()
    options_json = json.dumps(options or [])

    has_correction = False
    if correct_answer is not None:
        if isinstance(correct_answer, str) and correct_answer.strip():
            has_correction = True
        elif isinstance(correct_answer, list) and len(correct_answer) > 0:
            has_correction = True

    if not has_correction:
        # CASE A: Flagged wrong without correction -> EVICT from solve_cache
        with get_db(db_path) as conn:
            conn.execute("DELETE FROM solve_cache WHERE cache_key = ?;", (key,))
            conn.execute("""
                INSERT INTO wrong_answers (
                    cache_key, subject, q_type, question, options_json,
                    wrong_model_answer, correct_canonical_json, confidence_tier_at_failure,
                    notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(cache_key) DO UPDATE SET
                    subject = excluded.subject,
                    q_type = excluded.q_type,
                    question = excluded.question,
                    options_json = excluded.options_json,
                    wrong_model_answer = excluded.wrong_model_answer,
                    confidence_tier_at_failure = excluded.confidence_tier_at_failure,
                    notes = excluded.notes,
                    updated_at = datetime('now');
            """, (
                key, subject, norm_type, question, options_json,
                wrong_model_answer, confidence_tier_at_failure, notes
            ))
            conn.commit()
        return "evicted_and_logged", key

    # CASE B: Correction provided -> Resolve to canonical text format and OVERRIDE in solve_cache
    if norm_type == "mcq":
        try:
            norm_ans = normalize_mcq_answer(correct_answer, options)
            canonical_payload = norm_ans.selected_text
        except Exception:
            # Match directly against options if possible
            matched = None
            clean_cand = normalize_text_answer(str(correct_answer))
            for opt in options:
                if normalize_text_answer(opt) == clean_cand:
                    matched = opt
                    break
            canonical_payload = matched if matched is not None else str(correct_answer).strip()

    elif norm_type == "order":
        try:
            norm_ans = normalize_order_answer(correct_answer, options)
            canonical_payload = norm_ans.ordered_texts
        except Exception:
            if isinstance(correct_answer, list):
                canonical_payload = [str(x).strip() for x in correct_answer]
            else:
                canonical_payload = [str(correct_answer).strip()]

    elif norm_type in ("text", "code"):
        canonical_payload = str(correct_answer).strip()

    else:
        canonical_payload = str(correct_answer).strip()

    canonical_json = json.dumps(canonical_payload)

    with get_db(db_path) as conn:
        # 1. Upsert into wrong_answers
        conn.execute("""
            INSERT INTO wrong_answers (
                cache_key, subject, q_type, question, options_json,
                wrong_model_answer, correct_canonical_json, confidence_tier_at_failure,
                notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(cache_key) DO UPDATE SET
                subject = excluded.subject,
                q_type = excluded.q_type,
                question = excluded.question,
                options_json = excluded.options_json,
                wrong_model_answer = excluded.wrong_model_answer,
                correct_canonical_json = excluded.correct_canonical_json,
                confidence_tier_at_failure = excluded.confidence_tier_at_failure,
                notes = excluded.notes,
                updated_at = datetime('now');
        """, (
            key, subject, norm_type, question, options_json,
            wrong_model_answer, canonical_json, confidence_tier_at_failure, notes
        ))

        # 2. Upsert into solve_cache with USER_VERIFIED_OVERRIDE
        conn.execute("""
            INSERT OR REPLACE INTO solve_cache (
                cache_key, subject, q_type, question, canonical_answer_json,
                reason, confidence_tier, confidence_label, confidence_score,
                model_a, model_b, fallback_used, hit_count, created_at,
                searxng_used, search_sources
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), 0, '[]')
        """, (
            key,
            subject,
            norm_type,
            question,
            canonical_json,
            notes or "User-verified correction",
            "USER_VERIFIED_OVERRIDE",
            "high",
            1.0,
            "user",
            "user",
            0,
        ))
        conn.commit()

    return "overridden_and_logged", key


def get_wrong_answers(only_with_correction: bool = False, db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Retrieve logged wrong answers with optional filter for corrected items."""
    init_db(db_path)
    with get_db(db_path) as conn:
        query = "SELECT * FROM wrong_answers"
        if only_with_correction:
            query += " WHERE correct_canonical_json IS NOT NULL AND TRIM(correct_canonical_json) != ''"
        query += " ORDER BY id DESC"
        rows = conn.execute(query).fetchall()
        results = []
        for r in rows:
            results.append({
                "id": r["id"],
                "cache_key": r["cache_key"],
                "subject": r["subject"],
                "q_type": r["q_type"],
                "question": r["question"],
                "options": json.loads(r["options_json"]) if r["options_json"] else [],
                "options_json": r["options_json"] or "[]",
                "wrong_model_answer": r["wrong_model_answer"],
                "correct_canonical": json.loads(r["correct_canonical_json"]) if r["correct_canonical_json"] else None,
                "correct_canonical_json": r["correct_canonical_json"],
                "confidence_tier_at_failure": r["confidence_tier_at_failure"],
                "notes": r["notes"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            })
        return results


def get_cache_stats(db_path: Optional[str] = None) -> dict:
    """Retrieve cache entry counts, hits, misses, hit rate, and wrong answer metrics."""
    init_db(db_path)
    with get_db(db_path) as conn:
        count_row = conn.execute("SELECT COUNT(*) AS total FROM solve_cache").fetchone()
        total_entries = count_row["total"] if count_row else 0

        hits_row = conn.execute("SELECT value FROM cache_stats WHERE metric = 'hits'").fetchone()
        hits = hits_row["value"] if hits_row else 0

        misses_row = conn.execute("SELECT value FROM cache_stats WHERE metric = 'misses'").fetchone()
        misses = misses_row["value"] if misses_row else 0

        wrong_row = conn.execute("SELECT COUNT(*) AS total FROM wrong_answers").fetchone()
        wrong_count = wrong_row["total"] if wrong_row else 0

        override_row = conn.execute(
            "SELECT COUNT(*) AS total FROM solve_cache WHERE confidence_tier = 'USER_VERIFIED_OVERRIDE'"
        ).fetchone()
        override_count = override_row["total"] if override_row else 0

        total_requests = hits + misses
        hit_rate = (hits / total_requests * 100.0) if total_requests > 0 else 0.0

        return {
            "cache_entries": total_entries,
            "total_hits": hits,
            "total_misses": misses,
            "total_requests": total_requests,
            "hit_rate_pct": round(hit_rate, 2),
            "wrong_answers_count": wrong_count,
            "user_overrides_count": override_count,
        }


def clear_cache(db_path: Optional[str] = None) -> None:
    """Clear all cache entries and reset statistics (useful for tests)."""
    init_db(db_path)
    with get_db(db_path) as conn:
        conn.execute("DELETE FROM solve_cache;")
        conn.execute("UPDATE cache_stats SET value = 0 WHERE metric IN ('hits', 'misses');")
        conn.commit()
