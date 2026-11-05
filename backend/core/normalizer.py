"""Answer normalization, synthetic indexing, canonicalization, and grading."""

from __future__ import annotations

import ast
import difflib
import hashlib
import json
import re
import textwrap
import unicodedata
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field


SYNTHETIC_LABELS = ("A", "B", "C", "D", "E", "F")
ORDER_SYNTHETIC_LABELS = ("A", "B", "C", "D", "E", "F")
EXTENDED_SYNTHETIC_LABELS = tuple(chr(65 + i) for i in range(26))


class NormalizationError(ValueError):
    """Raised when an LLM answer cannot be normalized into a valid canonical form."""
    pass


class NormalizedAnswer(BaseModel):
    """Zero-DOM-Mutation ready canonical solver output."""
    canonical_key: str
    selected_index: Optional[int] = None
    selected_text: Optional[str] = None
    selected_indices: Optional[List[int]] = None
    selected_texts: Optional[List[str]] = None
    canonical_keys: Optional[List[str]] = None
    clean_code: Optional[str] = None
    permutation_indices: Optional[List[int]] = None
    ordered_texts: Optional[List[str]] = None
    raw_answer: Any = None


def parse_options(options_raw: Union[str, List[str], Dict[str, str], None]) -> List[str]:
    """
    Parse options from a JSON string, list of strings, or legacy dict.
    Returns a list of raw option strings in their visual order.
    """
    if options_raw is None:
        return []
    if isinstance(options_raw, list):
        return [str(opt).strip() for opt in options_raw]
    if isinstance(options_raw, dict):
        # Legacy dict format {"A": "...", "B": "..."} -> sort by key
        return [str(options_raw[k]).strip() for k in sorted(options_raw.keys())]
    if isinstance(options_raw, str):
        trimmed = options_raw.strip()
        if not trimmed or trimmed in ("[]", "{}"):
            return []
        try:
            parsed = json.loads(trimmed)
            return parse_options(parsed)
        except Exception:
            return []
    return []


def normalize_text_answer(text: str) -> str:
    """
    Deterministic text normalization:
    - Unicode NFKC normalization
    - Lowercase
    - Strip whitespace and surrounding quotes
    - Strip leading English articles ('a ', 'an ', 'the ')
    - Strip trailing punctuation (., ;:!?)
    - Collapse multiple whitespace to single space
    - Normalize numeric strings ('1,000' -> '1000', '10.0' -> '10')
    - Canonicalize boolean shorthand ('t'/'true' -> 'true', 'f'/'false' -> 'false')
    """
    if not text:
        return ""

    # Unicode NFKC
    s = unicodedata.normalize("NFKC", str(text))
    s = s.lower().strip()

    # Strip markdown code fences and backticks
    s = re.sub(r"^```[a-zA-Z]*\n?|```$", "", s).strip()
    s = re.sub(r"^`+|`+$", "", s).strip()

    # Strip surrounding quotes if wrapped around other content
    if len(s) >= 2 and (
        (s.startswith('"') and s.endswith('"')) or
        (s.startswith("'") and s.endswith("'")) or
        (s.startswith("`") and s.endswith("`")) or
        (s.startswith("“") and s.endswith("”")) or
        (s.startswith("‘") and s.endswith("’"))
    ):
        inner = s[1:-1].strip()
        if inner:
            s = inner
    s = re.sub(r"^`+|`+$", "", s).strip()

    # Strip leading English articles ONLY when followed by a multi-letter word (prose)
    # Never strip standalone letters ('A', 'a') or math/code expressions ('a - b', 'a : b', 'a = b', 'p(a)')
    s = re.sub(r"^(?:a|an)\s+(?=[a-z]{2,}\b)", "", s)
    s = re.sub(r"^the\s+(?=[a-z]{2,}\b)", "", s)

    # Strip trailing punctuation ONLY for prose words (e.g. 'cat!' -> 'cat', 'apple.' -> 'apple')
    # NEVER strip trailing punctuation when:
    # 1. String is symbol-only (e.g. '#', '//', '/* */', '--', '==', '!=', '!', '?', ':')
    # 2. Punctuation is part of an operator (e.g. '!=', '!==', '<=', '>=')
    if re.search(r"[a-z0-9]", s):
        # Only strip trailing [.,;:!?]+ if preceded by an alphanumeric character AND not part of operator symbols
        s = re.sub(r"(?<=[a-z0-9])(?<![!<>=&|~/%*#_@^+-])[.,;:!?]+$", "", s).strip()

    # Collapse multiple internal whitespace (preserving single space)
    s = re.sub(r"\s+", " ", s).strip()

    # Canonicalize booleans
    if s in ("t", "true"):
        return "true"
    if s in ("f", "false"):
        return "false"

    # Normalize numbers (e.g. '1,000' -> '1000', '10.0' -> '10')
    # Match numbers with commas like 1,000 or 1,234,567
    num_match = re.match(r"^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$", s)
    if num_match:
        s = s.replace(",", "")

    # Match float ending in .0, .00 etc. e.g. '1000.0' -> '1000'
    float_zero_match = re.match(r"^(-?\d+)\.0+$", s)
    if float_zero_match:
        s = float_zero_match.group(1)

    return s


def parse_math_numeric_value(val: Any) -> Optional[float]:
    """Parse numeric, fraction (a/b), percentage, or LaTeX frac value from a string."""
    if val is None:
        return None
    s = str(val).strip()
    # Strip decorative prefix if present e.g. "Option D: 2/36" -> "2/36", preserving negative numbers on "Option B: -2"
    s = re.sub(r"^(?:option|choice)?\s*[\(\[]?[A-Fa-f][\)\]]?(?:[\.\:\)]|\s+-(?!\s*-?\d)|\s+)\s*", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"^-\s+(\d)", r"-\1", s)
    if not s:
        return None
    # LaTeX frac e.g. \frac{1}{18} or \dfrac{2}{36} or -\frac{1}{2}
    frac_match = re.search(r"(-?)\s*\\d?frac\{([^{}]+)\}\{([^{}]+)\}", s)
    if frac_match:
        try:
            sign = -1.0 if frac_match.group(1) == "-" else 1.0
            num = float(frac_match.group(2).strip())
            den = float(frac_match.group(3).strip())
            if den != 0:
                return sign * (num / den)
        except Exception:
            pass
    # Standard fraction a/b: e.g. 1/18, 2/36, -1/6
    std_frac = re.search(r"^\s*([+-]?\d+(?:\.\d+)?)\s*/\s*([+-]?\d+(?:\.\d+)?)\s*$", s)
    if std_frac:
        try:
            num = float(std_frac.group(1))
            den = float(std_frac.group(2))
            if den != 0:
                return num / den
        except Exception:
            pass
    # Percentage e.g. 50% -> 0.5
    pct_match = re.search(r"^\s*([+-]?\d+(?:\.\d+)?)\s*%\s*$", s)
    if pct_match:
        try:
            return float(pct_match.group(1)) / 100.0
        except Exception:
            pass
    # Float / Integer e.g. 0.0556, 1260
    float_match = re.search(r"^\s*([+-]?\d+(?:\.\d+)?)\s*$", s)
    if float_match:
        try:
            return float(float_match.group(1))
        except Exception:
            pass
    return None


def normalize_complexity_expr(text: Any) -> Optional[str]:
    """
    Normalizes Big-O and computational complexity expressions to a canonical ASCII representation.
    - Strips markdown code wrappers / backticks, surrounding quotes, and option prefixes ('Option B:', '(B)', etc.).
    - Converts Unicode superscripts to caret notation ('⁰'->'^0', '¹'->'^1', '²'->'^2', '³'->'^3', '⁴'->'^4', '⁵'->'^5', 'ⁿ'->'^n').
    - Converts exponent notation '**' to '^' ('O(n ** 3)' -> 'O(n^3)').
    - Strips all whitespace and multiplication symbols ('*', '⋅', '×').
    - Standardizes log expressions (log(N) -> logN).
    - Preserves base and exponent order strictly so O(N^2) ('o(n^2)') and O(2^N) ('o(2^n)') never match!
    Returns canonical lowercase string like 'o(n^3)', 'o(nlogn)', 'o(n^2)', 'o(n)', 'o(1)', or None if not a complexity expr.
    """
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None

    # Strip code block fences and surrounding backticks / quotes
    s = re.sub(r"^```[a-zA-Z]*\n?|```$", "", s).strip()
    s = re.sub(r"^`+|`+$", "", s).strip().strip("'\"“”‘’")

    # Strip option prefix e.g. "Option B: `O(N^3)`" -> "`O(N^3)`"
    s = re.sub(r"^(?:option|choice)?\s*[\(\[]?[A-Fa-f][\)\]]?[\.\:\-\s]+", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"^`+|`+$", "", s).strip().strip("'\"“”‘’")

    # Fast validation: must contain 'O(' or 'O[' or 'O ' or 'O1' or 'ON' or complexity terms
    if not re.search(r"\b[oO]\s*[\(\[]|[oO]\s*[0-9nN]|(?:big\s*[-_]?o|theta|omega|complexity)\b", s, flags=re.IGNORECASE):
        if not re.search(r"^[nN0-9]\s*[\^]|(?:log\s*[nN]|[nN]\s*log)", s, flags=re.IGNORECASE):
            return None

    comp_extract = re.search(r"\b([oO]\s*[\(\[][^\(\)\[\]]+[\)\]]|[oO]\s*[0-9nN\^]+)\b", s)
    if comp_extract:
        s = comp_extract.group(1)

    # Unicode superscripts
    superscripts = {
        '⁰': '^0', '¹': '^1', '²': '^2', '³': '^3', '⁴': '^4',
        '⁵': '^5', '⁶': '^6', '⁷': '^7', '⁸': '^8', '⁹': '^9',
        'ⁿ': '^n', 'ᴹ': '^m', 'ᵐ': '^m', 'ᴷ': '^k', 'ᵏ': '^k'
    }
    for sup, rep in superscripts.items():
        s = s.replace(sup, rep)

    # Replace power operator ** with ^
    s = s.replace("**", "^")

    # Normalize log(N) -> logN
    s = re.sub(r"log\s*\(\s*([a-zA-Z0-9\^]+)\s*\)", r"log\1", s, flags=re.IGNORECASE)

    # Lowercase and strip multiplication and whitespace
    s = s.lower().replace("*", "").replace("⋅", "").replace("×", "")
    s = re.sub(r"\s+", "", s)

    # Standardize bracket styles
    s = re.sub(r"^o\[", "o(", s)
    if s.startswith("o(") and s.endswith("]"):
        s = s[:-1] + ")"
    if re.match(r"^o[n0-9]", s):
        s = f"o({s[1:]})"
    elif re.match(r"^[n0-9]\^|^[n0-9]log|^log", s):
        s = f"o({s})"

    return s


def normalize_code_snippet(text: str) -> str:
    """
    Normalizes multi-line and single-line code snippets for robust option matching:
    - Strips markdown code fences and backticks.
    - Strips standalone language badge prefixes (SQL, JAVASCRIPT, JS, PYTHON, HTML, etc.).
    - Strips line number prefixes per line (e.g. '1 ', '2: ', '3 | ').
    - Normalizes quotes and spacing.
    - Collapses internal whitespace to single space.
    """
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", str(text)).strip()
    # Strip fences & backticks
    s = re.sub(r"^```[a-zA-Z0-9_\-]*\n?|```$", "", s).strip()
    s = re.sub(r"^`+|`+$", "", s).strip()

    # Strip standalone badge header lines (e.g. "SQL\n", "JAVASCRIPT\n")
    lines = s.split("\n")
    cleaned_lines = []
    badge_pattern = re.compile(r"^(?:JAVASCRIPT|JS|SQL|PYTHON|PY|HTML|CSS|JAVA|C\+\+|CPP|JSON|BASH|SH|COPY|COPIED)$", re.IGNORECASE)
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if badge_pattern.match(stripped):
            continue
        # Strip leading line numbers (e.g. "1 ", "1: ", "1 | ", "1.")
        stripped = re.sub(r"^\s*\d{1,4}\s*[:\|\.]?\s+", "", stripped)
        cleaned_lines.append(stripped)

    reconstructed = " ".join(cleaned_lines) if cleaned_lines else s
    # Strip leading badge word if single line (e.g. "SQL SELECT ...")
    reconstructed = re.sub(r"^(?:JAVASCRIPT|JS|SQL|PYTHON|PY|HTML|CSS|JAVA|C\+\+|CPP|JSON|BASH|SH)\s+", "", reconstructed, flags=re.IGNORECASE)
    # Strip decorative option letter prefixes if any e.g. "A. SELECT ...", preserving negative numbers
    reconstructed = re.sub(r"^[A-P](?:[\.\:\)]|\s+-(?!\s*-?\d)|\s+)\s*", "", reconstructed, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", reconstructed).lower().strip()


def snap_to_closest_option(candidate: str, options: List[str], min_similarity: float = 0.45) -> Optional[int]:
    """
    Deterministic Token-Overlap & SequenceMatcher Snap-to-Option fallback.
    Used when exact letter, text match, code-snippet match, and numeric equivalence all fail.
    Tokenizes both candidate and options, computes SequenceMatcher ratio and token overlap,
    and returns the best option index if unique and score >= min_similarity.
    """
    if not candidate or not options:
        return None

    cand_str = str(candidate).strip()
    cand_stripped = re.sub(r"^(?:option|choice)?\s*\(?\[?[A-Pa-p0-9]\)?\]?[\.\:\)]?\s*", "", cand_str, flags=re.IGNORECASE).strip()
    cand_norm = normalize_text_answer(cand_stripped if cand_stripped else cand_str)
    if not cand_norm:
        return None

    cand_tokens = set(re.findall(r"\w+", cand_norm))
    cand_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\b", cand_str))

    best_idx: Optional[int] = None
    best_score = -1.0
    second_best_score = -1.0

    for i, opt in enumerate(options):
        opt_str = str(opt).strip()
        opt_stripped = re.sub(r"^(?:option|choice)?\s*\(?\[?[A-Pa-p0-9]\)?\]?[\.\:\)]?\s*", "", opt_str, flags=re.IGNORECASE).strip()
        opt_norm = normalize_text_answer(opt_stripped if opt_stripped else opt_str)
        if not opt_norm:
            continue

        seq_ratio = difflib.SequenceMatcher(None, cand_norm, opt_norm).ratio()

        opt_tokens = set(re.findall(r"\w+", opt_norm))
        if cand_tokens and opt_tokens:
            intersection = cand_tokens & opt_tokens
            union = cand_tokens | opt_tokens
            jaccard = len(intersection) / len(union) if union else 0.0
            overlap_ratio = len(intersection) / min(len(cand_tokens), len(opt_tokens))
        else:
            jaccard = 0.0
            overlap_ratio = 0.0

        opt_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\b", opt_str))
        number_match = bool(cand_numbers and cand_numbers == opt_numbers)

        score = max(seq_ratio, overlap_ratio * 0.9, jaccard)
        if number_match and overlap_ratio >= 0.5:
            score = max(score, 0.85)

        if score > best_score:
            second_best_score = best_score
            best_score = score
            best_idx = i
        elif score > second_best_score:
            second_best_score = score

    if best_idx is not None and best_score >= min_similarity:
        if (best_score - second_best_score >= 0.04) or (best_score >= 0.65):
            return best_idx

    return None


def normalize_mcq_answer(raw_answer: Any, options: List[str]) -> NormalizedAnswer:
    """
    Normalize an MCQ answer against a list of 2-16 options.
    Accepts synthetic letter ('A', 'B', etc.), prefixed letter ('Option D: 2/36', 'B) 1/6'),
    full option text, or mathematically equivalent numeric/fraction values ('1/18' for '2/36').
    Returns NormalizedAnswer with canonical_key ('B'), selected_index (1), selected_text.
    """
    num_options = len(options)
    if num_options < 2 or num_options > 16:
        raise NormalizationError(f"MCQ requires between 2 and 16 options, got {num_options}")

    valid_letters = list(EXTENDED_SYNTHETIC_LABELS[:num_options])

    # Convert raw_answer to string
    raw_str = str(raw_answer).strip()
    if not raw_str:
        raise NormalizationError(f"Empty MCQ answer cannot be normalized with options {valid_letters}")

    # Step 1: Standalone Single-Character Synthetic Label
    # If raw_answer.strip() is a single ASCII letter in A..F (or a..f) whose index 0..5 is < len(options),
    # ALWAYS resolve it directly as that synthetic label. This guarantees that if options are ['B', 'C', 'A', 'D']
    # and the LLM returns 'A', it reliably resolves to option index 0 (synthetic label 'A'),
    # and is NEVER hijacked by option text 'A' at index 2!
    clean_raw = re.sub(r"^`+|`+$", "", raw_str).strip().strip("'\"“”‘’")
    if len(clean_raw) == 1 and clean_raw.upper() in valid_letters:
        cand = clean_raw.upper()
        idx = ord(cand) - 65
        return NormalizedAnswer(
            canonical_key=cand,
            selected_index=idx,
            selected_text=options[idx],
            raw_answer=raw_answer,
        )

    # Step 2: Multi-Character Exact Option Text Match
    # If len(raw_answer.strip()) > 1, check if normalize_text_answer(raw_answer) (or stripped raw_answer)
    # exactly matches one of the options BEFORE attempting prefix-based label extraction.
    # This guarantees 'A - B' matches option 'A - B', while 'A' remains synthetic label A.
    if len(raw_str) > 1:
        norm_raw = normalize_text_answer(raw_str)
        for i, opt in enumerate(options):
            if opt.strip() == raw_str or normalize_text_answer(opt) == norm_raw:
                letter = chr(65 + i)
                return NormalizedAnswer(
                    canonical_key=letter,
                    selected_index=i,
                    selected_text=options[i],
                    raw_answer=raw_answer,
                )

        # Step 2b: Code-Aware Normalization Match (for SQL, JavaScript, Python code snippets)
        code_raw = normalize_code_snippet(raw_str)
        if code_raw and len(code_raw) >= 4:
            for i, opt in enumerate(options):
                if normalize_code_snippet(opt) == code_raw:
                    letter = chr(65 + i)
                    return NormalizedAnswer(
                        canonical_key=letter,
                        selected_index=i,
                        selected_text=options[i],
                        raw_answer=raw_answer,
                    )

    # Step 3: Explicit Label Prefix Extraction & Fallback
    # Check common prefixes: "Option A", "Option D: 2/36", "Choice B", "B) 1/6", "B. Mitochondrion", "(C)", "[A]"
    wrapped_match = re.match(r"^(?:option|choice)?\s*\(?\[?([A-Pa-p])\)?\]?[\.\:\)]?$", clean_raw, re.IGNORECASE)
    if wrapped_match:
        cand = wrapped_match.group(1).upper()
        if cand in valid_letters:
            idx = ord(cand) - 65
            return NormalizedAnswer(
                canonical_key=cand,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    prefix_match = re.match(r"^(?:option|choice)?\s*(?:\(?([A-Pa-p])(?:[\.\)\:]|\s+-(?!\s*-?\d)|\s+)\s*|\(([A-Pa-p])\)\s*|\[([A-Pa-p])\]\s*)(.*)$", clean_raw, re.IGNORECASE)
    if prefix_match:
        cand = (prefix_match.group(1) or prefix_match.group(2) or prefix_match.group(3)).upper()
        if cand in valid_letters:
            idx = ord(cand) - 65
            return NormalizedAnswer(
                canonical_key=cand,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Numeric option prefixes: "Option 1", "Choice 2", "1", "(2)"
    num_opt_match = re.match(r"^(?:option|choice)?\s*\(?\[?([1-9]|1[0-6])\)?\]?[\.\:\)]?$", raw_str, re.IGNORECASE)
    if num_opt_match:
        cand_num = int(num_opt_match.group(1))
        # Only treat as 1-based index if that digit is NOT an exact match for one of the options
        if 1 <= cand_num <= num_options and not any(cand_num == int(o.strip()) for o in options if o.strip().isdigit()):
            idx = cand_num - 1
            cand_letter = chr(65 + idx)
            return NormalizedAnswer(
                canonical_key=cand_letter,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Loose single letter match if isolated by word boundaries (e.g. "The answer is B")
    loose_match = re.search(r"\b([A-Pa-p])\b", raw_str)
    if loose_match:
        cand = loose_match.group(1).upper()
        if cand in valid_letters:
            idx = ord(cand) - 65
            return NormalizedAnswer(
                canonical_key=cand,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Step 4: Substring match if unambiguous
    norm_raw = normalize_text_answer(raw_str)
    matches = [
        i for i, opt in enumerate(options)
        if norm_raw and (norm_raw in normalize_text_answer(opt) or normalize_text_answer(opt) in norm_raw)
    ]
    if len(matches) == 1:
        idx = matches[0]
        letter = chr(65 + idx)
        return NormalizedAnswer(
            canonical_key=letter,
            selected_index=idx,
            selected_text=options[idx],
            raw_answer=raw_answer,
        )

    # Step 5: Mathematical / Numeric Equivalence Fallback for MCQ
    # If the LLM returned a fraction, decimal, or reduced fraction (e.g. "1/18" or "0.0556" when option is "2/36")
    val_ans = parse_math_numeric_value(raw_str)
    if val_ans is not None:
        num_matches = []
        for i, opt in enumerate(options):
            val_opt = parse_math_numeric_value(opt)
            if val_opt is not None:
                if abs(val_ans - val_opt) < 1e-6:
                    num_matches.append(i)
                elif val_opt != 0 and abs((val_ans - val_opt) / val_opt) < 1e-4:
                    num_matches.append(i)
        if len(num_matches) == 1:
            idx = num_matches[0]
            letter = chr(65 + idx)
            return NormalizedAnswer(
                canonical_key=letter,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Step 6: Complexity Expression Equivalence Fallback for Big-O / Algorithm questions
    # Handles `O(N^3)`, O(n³), O(n ** 3), `O(NlogN)`, O(N log N), O(N*log(N)), Option B: `O(N^3)`, etc.
    comp_ans = normalize_complexity_expr(raw_str)
    if comp_ans is not None:
        comp_matches = [
            i for i, opt in enumerate(options)
            if normalize_complexity_expr(opt) == comp_ans
        ]
        if len(comp_matches) == 1:
            idx = comp_matches[0]
            letter = chr(65 + idx)
            return NormalizedAnswer(
                canonical_key=letter,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Step 7: Deterministic Token-Overlap & SequenceMatcher Snap-to-Option Fallback
    snap_idx = snap_to_closest_option(raw_str, options)
    if snap_idx is not None:
        letter = chr(65 + snap_idx)
        return NormalizedAnswer(
            canonical_key=letter,
            selected_index=snap_idx,
            selected_text=options[snap_idx],
            raw_answer=raw_answer,
        )

    raise NormalizationError(
        f"Unable to normalize MCQ answer '{raw_answer}' with valid options {valid_letters}"
    )


def normalize_order_answer(raw_answer: Any, options: List[str]) -> NormalizedAnswer:
    """
    Normalize an ordering answer against unlabelled text blocks.
    Validates that the sequence is a complete, duplicate-free permutation of all available option letters.
    Supports:
    - Lists or tuples of letters: ['B', 'D', 'A', 'C', 'E']
    - Lists or tuples of 1-based integers ([2, 4, 1, 3, 5]) or 0-based integers ([1, 3, 0, 2, 4])
    - Strings of letters separated by arrows, commas, dashes, gt, spaces: 'B -> D -> A -> C -> E', 'B > D > A > C > E', '1. B, 2. D, 3. A, 4. C, 5. E'
    - Strings of integers: '2, 4, 1, 3, 5', '2 -> 4 -> 1 -> 3 -> 5'
    - Lists or delimited strings of full option texts matching options.
    Produces canonical_key ('B,D,A,C,E'), permutation_indices ([1, 3, 0, 2, 4]), and ordered_texts.
    """
    num_options = len(options)
    if num_options < 2 or num_options > 16:
        raise NormalizationError(f"Ordering requires between 2 and 16 options, got {num_options}")

    expected_letters = list(EXTENDED_SYNTHETIC_LABELS[:num_options])
    expected_set = set(expected_letters)

    letters: List[str] = []

    # Case 1: raw_answer is a list/tuple
    if isinstance(raw_answer, (list, tuple)):
        # 1A: Check if list contains letters ['B', 'D', 'A', 'C', 'E']
        is_all_letters = all(
            isinstance(x, str) and x.strip().upper() in expected_set
            for x in raw_answer
        )
        if is_all_letters and len(raw_answer) == num_options:
            letters = [str(x).strip().upper() for x in raw_answer]

        # 1B: Check if list contains integers e.g. [2, 4, 1, 3, 5] (1-based) or [1, 3, 0, 2, 4] (0-based)
        elif all((isinstance(x, int) or (isinstance(x, str) and str(x).strip().isdigit())) for x in raw_answer) and len(raw_answer) == num_options:
            int_vals = [int(x) for x in raw_answer]
            if set(int_vals) == set(range(1, num_options + 1)):
                letters = [chr(65 + x - 1) for x in int_vals]
            elif set(int_vals) == set(range(num_options)):
                letters = [chr(65 + x) for x in int_vals]

        # 1C: Check if list contains full option strings
        if not letters:
            mapped_indices: List[int] = []
            used_indices = set()
            for item in raw_answer:
                item_norm = normalize_text_answer(str(item))
                found_idx = None
                for idx, opt in enumerate(options):
                    if idx not in used_indices and normalize_text_answer(opt) == item_norm:
                        found_idx = idx
                        break
                if found_idx is None:
                    cand = [
                        idx for idx, opt in enumerate(options)
                        if idx not in used_indices and item_norm and (item_norm in normalize_text_answer(opt) or normalize_text_answer(opt) in item_norm)
                    ]
                    if len(cand) == 1:
                        found_idx = cand[0]

                if found_idx is not None and found_idx not in used_indices:
                    used_indices.add(found_idx)
                    mapped_indices.append(found_idx)
                else:
                    break

            if len(mapped_indices) == num_options:
                letters = [chr(65 + i) for i in mapped_indices]

    # Case 2: raw_answer is a string
    elif isinstance(raw_answer, str):
        trimmed = raw_answer.strip()
        # Check if JSON array string
        if (trimmed.startswith("[") and trimmed.endswith("]")) or (trimmed.startswith("(") and trimmed.endswith(")")):
            try:
                parsed = json.loads(trimmed.replace("'", '"'))
                return normalize_order_answer(parsed, options)
            except Exception:
                pass

        # 2A: Numbered list with letters: e.g. "1. B, 2. D, 3. A, 4. C, 5. E" or "Step 1: B, Step 2: D..."
        numbered_matches = re.findall(r"(?:(?:step\s*\d+|\d+)[\.\:\-\s]+)?\b([A-Pa-p])\b", trimmed, re.I)
        if len(numbered_matches) == num_options and set(c.upper() for c in numbered_matches) == expected_set:
            letters = [c.upper() for c in numbered_matches]

        # 2B: Letter sequence separated by arrows/dashes/spaces/commas e.g. "B -> D -> A -> C -> E", "B > D > A > C > E", "B - D - A - C - E"
        if not letters:
            extracted_letters = re.findall(r"\b([A-Pa-p])\b", trimmed)
            if len(extracted_letters) == num_options and set(c.upper() for c in extracted_letters) == expected_set:
                letters = [c.upper() for c in extracted_letters]

        # 2C: Contiguous letter string e.g. "BDACE"
        if not letters and len(trimmed) == num_options and trimmed.isalpha():
            extracted_letters = [c.upper() for c in trimmed]
            if set(extracted_letters) == expected_set:
                letters = extracted_letters

        # 2D: Integer sequence e.g. "2, 4, 1, 3, 5", "2 -> 4 -> 1 -> 3 -> 5", "2 - 4 - 1 - 3 - 5"
        if not letters:
            nums = [int(n) for n in re.findall(r"\b\d+\b", trimmed)]
            if len(nums) == num_options:
                if set(nums) == set(range(1, num_options + 1)):
                    letters = [chr(65 + n - 1) for n in nums]
                elif set(nums) == set(range(num_options)):
                    letters = [chr(65 + n) for n in nums]

    # Validate permutation
    if len(letters) != num_options:
        raise NormalizationError(
            f"Ordering answer must contain exactly {num_options} elements, got {len(letters)} from '{raw_answer}'"
        )

    if set(letters) != expected_set:
        raise NormalizationError(
            f"Ordering answer {letters} is not a valid permutation of {expected_letters}"
        )

    if len(letters) != len(set(letters)):
        raise NormalizationError(
            f"Ordering answer {letters} contains duplicates"
        )

    canonical_key = ",".join(letters)
    permutation_indices = [ord(c) - 65 for c in letters]
    ordered_texts = [options[i] for i in permutation_indices]

    return NormalizedAnswer(
        canonical_key=canonical_key,
        permutation_indices=permutation_indices,
        ordered_texts=ordered_texts,
        raw_answer=raw_answer,
    )


def check_balanced_brackets(code: str) -> bool:
    """Check that parentheses, brackets, and braces are balanced in code outside string/comment literals."""
    stack = []
    pairs = {')': '(', '}': '{', ']': '['}
    in_single_quote = False
    in_double_quote = False
    in_line_comment = False
    in_block_comment = False
    i = 0
    n = len(code)
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ''

        if in_line_comment:
            if c == '\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if c == '*' and nxt == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_single_quote:
            if c == '\\':
                i += 2
                continue
            if c == "'":
                in_single_quote = False
            i += 1
            continue

        if in_double_quote:
            if c == '\\':
                i += 2
                continue
            if c == '"':
                in_double_quote = False
            i += 1
            continue

        if c == '/' and nxt == '/':
            in_line_comment = True
            i += 2
            continue
        if c == '/' and nxt == '*':
            in_block_comment = True
            i += 2
            continue
        if c == "'":
            in_single_quote = True
            i += 1
            continue
        if c == '"':
            in_double_quote = True
            i += 1
            continue

        if c in '({[':
            stack.append(c)
        elif c in ')}]':
            if not stack or stack[-1] != pairs[c]:
                return False
            stack.pop()

        i += 1

    return len(stack) == 0 and not in_single_quote and not in_double_quote and not in_block_comment


def extract_starter_signatures(starter_code: str) -> List[str]:
    """Extract required class/function/type identifiers from starter code (ignoring comments)."""
    if not starter_code:
        return []
    # Strip block comments /* ... */ to ignore folded harness definitions like struct Node
    no_block = re.sub(r"/\*[\s\S]*?\*/", "", starter_code)
    signatures = []
    for line in no_block.splitlines():
        line = re.sub(r"//.*$", "", line)
        line = re.sub(r"#.*$", "", line).strip()
        if not line:
            continue
        # Python def or class
        py_match = re.search(r"^(?:def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)", line)
        if py_match:
            signatures.append(py_match.group(1))
            continue
        # C++/Java class, struct, or interface
        cpp_class = re.search(r"^(?:class|struct|interface)\s+([a-zA-Z_][a-zA-Z0-9_]*)", line)
        if cpp_class:
            signatures.append(cpp_class.group(1))
            continue
        # C++/Java function signature (e.g. Node* buildTree( or int maxProfit( or Solution()
        func_match = re.search(r"(?:[a-zA-Z0-9_]+[*&]?\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", line)
        if func_match:
            cand = func_match.group(1)
            if cand not in ("if", "while", "for", "switch", "catch", "return"):
                signatures.append(cand)
    return signatures


def normalize_code_answer(
    raw_answer: Any,
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
) -> NormalizedAnswer:
    """
    Normalize programming code solution:
    - Unpacks raw JSON or dict if structured {"reason": "...", "answer": "..."}
    - Strips markdown code fences (```python ... ```)
    - Normalizes line endings to \n and trims line trailing whitespace
    - Header Comment Preservation / Splice Guard: preserves leading /* ... */ or // ... from starter_code
    - Validates syntax (ast.parse for Python, balanced brackets for C++/Java/JS)
    - Enforces starter code signatures preservation
    - Generates deterministic canonical_key (AST-unparsed hash for Python, stripped whitespace hash for others)
    """
    if raw_answer is None:
        raise NormalizationError("Code answer cannot be empty")

    code_text = ""
    if isinstance(raw_answer, dict):
        code_text = str(raw_answer.get("answer") or "")
    elif isinstance(raw_answer, str):
        trimmed = raw_answer.strip()
        if trimmed.startswith("{") and trimmed.endswith("}"):
            try:
                parsed = json.loads(trimmed)
                if isinstance(parsed, dict) and "answer" in parsed:
                    code_text = str(parsed["answer"])
                else:
                    code_text = raw_answer
            except Exception:
                code_text = raw_answer
        else:
            code_text = raw_answer
    else:
        code_text = str(raw_answer)

    # Normalize line endings
    code_text = code_text.replace("\r\n", "\n").replace("\r", "\n")

    # Strip markdown code fences if present
    fence_match = re.search(r"```(?:[a-zA-Z0-9_+\-]+)?\n?([\s\S]*?)```", code_text)
    if fence_match:
        code_text = fence_match.group(1)
    else:
        # Also handle partial or bare fences e.g. leading ```python or trailing ```
        code_text = re.sub(r"^\s*```[a-zA-Z0-9_+\-]*\n?", "", code_text)
        code_text = re.sub(r"\n?\s*```\s*$", "", code_text)

    # Dedent uniformly across all lines before line trimming
    code_text = textwrap.dedent(code_text)

    lines = [line.rstrip() for line in code_text.split("\n")]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()

    clean_code = "\n".join(lines).strip()
    clean_code = textwrap.dedent(clean_code)
    if not clean_code:
        raise NormalizationError("Code answer cannot be empty")

    lang = (language or "python").lower().strip()
    if lang in ("py", "python3"):
        lang = "python"
    elif lang in ("c++", "c"):
        lang = "cpp"
    elif lang in ("js",):
        lang = "javascript"
    elif lang in ("ts",):
        lang = "typescript"

    # Header Comment Preservation / Splice Guard
    leading_header_comment = ""
    if starter_code:
        m_block = re.match(r"^(\s*/\*[\s\S]*?\*/\s*)", starter_code)
        if m_block:
            leading_header_comment = m_block.group(1).rstrip()
        else:
            m_lines = re.match(r"^((?:\s*(?://|#)[^\n]*\n?)+)", starter_code)
            if m_lines:
                leading_header_comment = m_lines.group(1).rstrip()

    final_clean_code = clean_code
    if leading_header_comment:
        has_leading = (clean_code.startswith("/*") or clean_code.startswith("//") or clean_code.startswith("#"))
        if not has_leading:
            if lang == "python" and leading_header_comment.startswith("/*"):
                pass
            else:
                final_clean_code = f"{leading_header_comment}\n{clean_code}"

    canonical_key = ""

    if lang == "python":
        tree = None
        code_for_ast = re.sub(r"/\*[\s\S]*?\*/", "", clean_code)
        try:
            tree = ast.parse(code_for_ast)
        except IndentationError:
            try:
                code_for_ast = textwrap.dedent(code_for_ast)
                tree = ast.parse(code_for_ast)
            except Exception as e:
                raise NormalizationError(f"Python code syntax error: {e}")
        except SyntaxError as e:
            raise NormalizationError(f"Python code syntax error: {e}")

        # Preserve starter signatures if provided
        if starter_code:
            expected_sigs = extract_starter_signatures(starter_code)
            found_defs = {
                node.name for node in ast.walk(tree)
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            }
            for sig in expected_sigs:
                if sig not in found_defs:
                    raise NormalizationError(f"Required starter signature '{sig}' is missing from solution")

        # Canonicalize via ast.unparse (Python 3.9+)
        try:
            unparsed = ast.unparse(tree)
        except Exception:
            unparsed = clean_code
        canonical_key = f"py:{hashlib.sha256(unparsed.encode('utf-8')).hexdigest()}"

    else:
        # C++, Java, JS, etc.
        if not check_balanced_brackets(clean_code):
            raise NormalizationError(f"Unbalanced braces, brackets, or parentheses in {lang} code")

        if starter_code:
            expected_sigs = extract_starter_signatures(starter_code)
            for sig in expected_sigs:
                if not re.search(rf"\b{re.escape(sig)}\b", clean_code):
                    raise NormalizationError(f"Required starter signature '{sig}' is missing from solution")

        # Strip line and block comments for canonical key
        no_line_comments = re.sub(r"//.*$", "", clean_code, flags=re.MULTILINE)
        no_comments = re.sub(r"/\*[\s\S]*?\*/", "", no_line_comments)
        ws_canonical = re.sub(r"\s+", " ", no_comments).strip()
        canonical_key = f"{lang}:{hashlib.sha256(ws_canonical.encode('utf-8')).hexdigest()}"

    return NormalizedAnswer(
        canonical_key=canonical_key,
        selected_text=final_clean_code,
        clean_code=final_clean_code,
        raw_answer=final_clean_code,
    )


def normalize_multi_mcq_answer(raw_answer: Any, options: List[str]) -> NormalizedAnswer:
    """
    Normalize multiple-choice questions with several correct answers (multi-select / checkboxes).
    Extracts all targeted options, validates each against valid options, and returns
    canonical_key formatted as comma-separated letters e.g. 'A,D', sorted selected_indices e.g. [0, 3],
    and selected_texts.
    """
    if not options or len(options) < 2:
        raise NormalizationError(f"Multi-select MCQ requires at least 2 options, got {len(options) if options else 0}")

    num_options = len(options)
    valid_letters = [chr(65 + i) for i in range(num_options)]
    matched_indices = set()

    items = []
    if isinstance(raw_answer, (list, tuple)):
        items = [str(x).strip() for x in raw_answer if str(x).strip()]
    elif isinstance(raw_answer, str):
        raw_str = raw_answer.strip()
        if raw_str.startswith("[") and raw_str.endswith("]"):
            try:
                parsed = json.loads(raw_str)
                if isinstance(parsed, list):
                    items = [str(x).strip() for x in parsed if str(x).strip()]
            except Exception:
                pass
        if not items:
            parts = re.split(r"[\,\;\&]|\band\b", raw_str, flags=re.IGNORECASE)
            items = [p.strip() for p in parts if p.strip()]
    else:
        items = [str(raw_answer).strip()]

    for item in items:
        item_str = item.strip()
        # 1. Single letter match: "A", "(A)", "Option A", "[A]"
        letter_m = re.match(r"^(?:option|choice)?\s*\(?\[?([A-Pa-p])\)?\]?[\.\:\)]?$", item_str, re.IGNORECASE)
        if letter_m:
            l_cand = letter_m.group(1).upper()
            if l_cand in valid_letters:
                matched_indices.add(ord(l_cand) - 65)
                continue

        # 2. Text match against options (direct or with leading "B: " / "Option B: " stripped)
        norm_item = normalize_text_answer(item_str)
        found = False
        for idx, opt in enumerate(options):
            if opt.strip() == item_str or normalize_text_answer(opt) == norm_item:
                matched_indices.add(idx)
                found = True
                break
        if found:
            continue

        # 2b. Prefix + text match: e.g. "B: top = 0", "G) arr[0] = 10", "Option H - arr[0] = 10"
        pref_m = re.match(
            r"^(?:option|choice)?\s*(?:\(?([A-Pa-p])[\.\)\:]\s*|\(([A-Pa-p])\)\s*|\[([A-Pa-p])\]\s*)(.+)$",
            item_str,
            re.IGNORECASE,
        )
        if pref_m:
            l_cand = (pref_m.group(1) or pref_m.group(2) or pref_m.group(3)).upper()
            rest_text = pref_m.group(4).strip()
            norm_rest = normalize_text_answer(rest_text)
            for idx, opt in enumerate(options):
                if opt.strip() == rest_text or normalize_text_answer(opt) == norm_rest:
                    matched_indices.add(idx)
                    found = True
                    break
            if not found and l_cand in valid_letters:
                matched_indices.add(ord(l_cand) - 65)
                found = True
            if found:
                continue

        # 3. Snap-to-option fallback for paraphrased/hallucinated item text
        snap_idx = snap_to_closest_option(item_str, options)
        if snap_idx is not None:
            matched_indices.add(snap_idx)
            continue

        # 4. Embedded letters in short label strings (e.g. "Options A and D are correct")
        # Never match letters followed by + or # (e.g. C++, C#) or lowercase article 'a'
        letters = re.findall(r"(?:(?:option|choice)s?\s+)?\b([A-P])\b(?![+#])", item_str)
        for l in letters:
            if l.upper() in valid_letters:
                matched_indices.add(ord(l.upper()) - 65)

    # Fallback: scan whole raw_answer string for letters
    if not matched_indices and isinstance(raw_answer, str):
        letters = re.findall(r"\b([A-Pa-p])\b", raw_answer)
        for l in letters:
            if l.upper() in valid_letters:
                matched_indices.add(ord(l.upper()) - 65)

    # Fallback: snap whole raw_answer
    if not matched_indices:
        snap_idx = snap_to_closest_option(str(raw_answer), options)
        if snap_idx is not None:
            matched_indices.add(snap_idx)

    if not matched_indices:
        raise NormalizationError(f"Could not extract any valid multi-select options from: {raw_answer!r}")

    valid_indices = [i for i in matched_indices if 0 <= i < len(options)]
    if not valid_indices:
        raise NormalizationError(f"Could not extract any valid multi-select options within bounds from: {raw_answer!r}")

    sorted_indices = sorted(list(set(valid_indices)))
    canonical_keys = [chr(65 + i) for i in sorted_indices]
    canonical_key = ",".join(canonical_keys)
    selected_texts = [options[i] for i in sorted_indices]

    return NormalizedAnswer(
        canonical_key=canonical_key,
        selected_index=sorted_indices[0],
        selected_text=", ".join(selected_texts),
        selected_indices=sorted_indices,
        selected_texts=selected_texts,
        canonical_keys=canonical_keys,
        raw_answer=raw_answer,
    )


def normalize_answer(
    q_type: str,
    raw_answer: Any,
    options: List[str],
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
) -> NormalizedAnswer:
    """Route normalization by quiz question type (mcq, multi, order, text, code)."""
    q_type_clean = q_type.strip().lower()

    if q_type_clean == "mcq":
        if not options or len(options) < 2:
            if language or starter_code or (isinstance(raw_answer, str) and ("def " in raw_answer or "class " in raw_answer or "int main" in raw_answer)):
                return normalize_code_answer(raw_answer, language=language, starter_code=starter_code)
            raw_str = str(raw_answer).strip() if raw_answer is not None else ""
            canon = normalize_text_answer(raw_str)
            return NormalizedAnswer(
                canonical_key=canon or raw_str or "A",
                selected_text=raw_str,
                raw_answer=raw_answer,
            )
        # Check if raw_answer is multi-select representation (e.g. 'A, D' or list)
        if isinstance(raw_answer, (list, tuple)) or (isinstance(raw_answer, str) and ("," in raw_answer or " and " in raw_answer.lower())):
            try:
                multi_res = normalize_multi_mcq_answer(raw_answer, options)
                if multi_res.selected_indices and len(multi_res.selected_indices) > 1:
                    return multi_res
            except Exception:
                pass
        return normalize_mcq_answer(raw_answer, options)
    elif q_type_clean in ("multi", "multi_mcq", "multiselect"):
        return normalize_multi_mcq_answer(raw_answer, options)
    elif q_type_clean == "order":
        try:
            return normalize_order_answer(raw_answer, options)
        except NormalizationError as order_err:
            # Resilient fallback: if the model returned a single option or letter (e.g. 'D' or option text)
            # because the question was an MCQ misclassified as ordering, rescue via MCQ normalization
            if options and len(options) >= 2:
                try:
                    return normalize_mcq_answer(raw_answer, options)
                except Exception:
                    pass
            raise order_err
    elif q_type_clean == "text":
        raw_val = str(raw_answer) if raw_answer is not None else ""
        canon = normalize_text_answer(raw_val)
        if not canon:
            raise NormalizationError("Free-text answer cannot be empty")
        comp = normalize_complexity_expr(raw_val)
        return NormalizedAnswer(
            canonical_key=comp or canon,
            selected_text=canon,
            raw_answer=raw_answer,
        )
    elif q_type_clean == "code":
        return normalize_code_answer(raw_answer, language=language, starter_code=starter_code)
    else:
        raise NormalizationError(f"Unsupported question type: '{q_type}'")


def grade_answer(
    predicted: NormalizedAnswer,
    expected_raw: str,
    q_type: str,
    options: List[str],
    language: Optional[str] = None,
    starter_code: Optional[str] = None,
) -> bool:
    """
    Grade predicted answer against ground-truth expected_answer.
    Handles flexible expected formats:
    - mcq: synthetic letter ('B') or full option text ('Mitochondrion')
    - order: comma-separated synthetic letters ('C,A,D,B') or JSON array of target ordered texts
    - text: pipe-separated acceptable synonyms ('Au|gold')
    - code: canonical AST/token hash comparison
    """
    q_type_clean = q_type.strip().lower()
    exp_str = str(expected_raw).strip()

    if q_type_clean in ("multi", "multi_mcq", "multiselect"):
        try:
            norm_exp = normalize_multi_mcq_answer(expected_raw, options)
            return set(predicted.canonical_keys or predicted.canonical_key.split(",")) == set(norm_exp.canonical_keys or norm_exp.canonical_key.split(","))
        except Exception:
            exp_keys = set(re.findall(r"[A-Fa-f]", exp_str.upper()))
            pred_keys = set(predicted.canonical_keys or predicted.canonical_key.split(","))
            return exp_keys == pred_keys

    elif q_type_clean == "mcq":
        # Check synthetic letter directly
        if len(exp_str) == 1 and exp_str.upper() == predicted.canonical_key.upper():
            return True
        # Check against full option text
        exp_norm = normalize_text_answer(exp_str)
        if predicted.selected_text and normalize_text_answer(predicted.selected_text) == exp_norm:
            return True
        # Check complexity expression equivalence
        exp_comp = normalize_complexity_expr(exp_str)
        if exp_comp:
            if predicted.selected_text and normalize_complexity_expr(predicted.selected_text) == exp_comp:
                return True
        # Check if exp_str is the text of the selected option index
        if predicted.selected_index is not None and 0 <= predicted.selected_index < len(options):
            if normalize_text_answer(options[predicted.selected_index]) == exp_norm:
                return True
            if exp_comp and normalize_complexity_expr(options[predicted.selected_index]) == exp_comp:
                return True
        return False

    elif q_type_clean == "order":
        # exp_str could be 'C,A,D,B' or JSON array of target texts
        if exp_str.startswith("[") and exp_str.endswith("]"):
            try:
                norm_exp = normalize_order_answer(json.loads(exp_str), options)
                return predicted.canonical_key == norm_exp.canonical_key
            except Exception:
                pass

        # Normalize letters from expected string
        exp_letters = [c.upper() for c in re.findall(r"[A-Za-z]", exp_str)]
        exp_canonical = ",".join(exp_letters)
        return predicted.canonical_key == exp_canonical

    elif q_type_clean == "text":
        # Support pipe-separated synonyms e.g. 'Au|gold'
        synonyms = [normalize_text_answer(syn) for syn in exp_str.split("|")]
        pred_norm = predicted.canonical_key
        if pred_norm in synonyms:
            return True
        exp_comp = normalize_complexity_expr(exp_str)
        if exp_comp:
            pred_comp = normalize_complexity_expr(predicted.selected_text or predicted.canonical_key)
            if pred_comp == exp_comp:
                return True
        return False

    elif q_type_clean == "code":
        try:
            norm_exp = normalize_code_answer(exp_str, language=language, starter_code=starter_code)
            return predicted.canonical_key == norm_exp.canonical_key
        except Exception:
            return normalize_text_answer(str(predicted.selected_text or "")) == normalize_text_answer(exp_str)

    return False

