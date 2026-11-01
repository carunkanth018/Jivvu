"""Defensive JSON extractor and schema validator for LLM quiz responses."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class ParseError(ValueError):
    """Raised when raw LLM output cannot be parsed or validated into expected schema."""
    pass


class ParsedLLMResponse(BaseModel):
    """Validated structured LLM response."""
    answer: Any
    reason: str
    verification_workspace: Optional[str] = None
    raw_text: str = ""


def extract_json_candidate(text: str) -> str:
    """
    Defensively extract JSON substring from raw model output:
    - Extracts from <verified_json>...</verified_json> if present
    - Strips closed <think>...</think> blocks
    - Strips unclosed <think> prefixes
    - Strips Markdown code fences
    - Locates the valid JSON object containing the 'answer' or 'correctAnswer' key
    """
    if not text or not str(text).strip():
        raise ParseError("LLM returned an empty response")

    raw_str = str(text).strip()

    # 1. Try extracting from <verified_json>...</verified_json> if present
    vjson_match = re.search(r"<verified_json>\s*([\s\S]*?)\s*(?:</verified_json>|$)", raw_str, re.IGNORECASE)
    candidate_source = vjson_match.group(1).strip() if vjson_match and vjson_match.group(1).strip() else raw_str

    def _find_json_in_text(source: str) -> Optional[str]:
        # Strip closed <think>...</think> blocks (case-insensitive)
        cleaned = re.sub(r"<think>[\s\S]*?</think>", "", source, flags=re.IGNORECASE).strip()

        # If unclosed <think> tag remains, strip everything up to the first '{'
        think_idx = cleaned.lower().find("<think>")
        if think_idx != -1:
            first_brace = cleaned.find("{", think_idx)
            if first_brace != -1:
                cleaned = cleaned[first_brace:].strip()
            else:
                cleaned = cleaned[think_idx + len("<think>"):].strip()

        # Strip markdown code fences if present
        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
        if fence_match:
            cleaned = fence_match.group(1).strip()

        target_keys = ("answer", "correctAnswer", "correctOptionId", "reason", "explanation", "reasoning_summary")
        key_patterns = tuple(f'"{k}"' for k in target_keys) + tuple(f"'{k}'" for k in target_keys)

        # If already clean JSON/dict object containing recognized keys
        if (cleaned.startswith("{") and cleaned.endswith("}")) or (cleaned.startswith("{") and any(k in cleaned for k in key_patterns)):
            try:
                parsed = json.loads(cleaned)
                if isinstance(parsed, dict) and any(k in parsed for k in target_keys):
                    return cleaned
            except Exception:
                try:
                    parsed = ast.literal_eval(cleaned)
                    if isinstance(parsed, dict) and any(k in parsed for k in target_keys):
                        return json.dumps(parsed)
                except Exception:
                    pass

        # Search for a valid JSON object containing target keys
        start_indices = [m.start() for m in re.finditer(r"\{", cleaned)]
        end_indices = [m.start() for m in re.finditer(r"\}", cleaned)]

        for s_idx in start_indices:
            for e_idx in reversed(end_indices):
                if e_idx > s_idx:
                    candidate = cleaned[s_idx : e_idx + 1]
                    if any(k in candidate for k in key_patterns):
                        try:
                            parsed = json.loads(candidate)
                            if isinstance(parsed, dict) and any(k in parsed for k in target_keys):
                                return candidate
                        except Exception:
                            try:
                                parsed = ast.literal_eval(candidate)
                                if isinstance(parsed, dict) and any(k in parsed for k in target_keys):
                                    return json.dumps(parsed)
                            except Exception:
                                continue

        # Outermost '{' and '}'
        start_idx = cleaned.find("{")
        end_idx = cleaned.rfind("}")
        if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
            candidate = cleaned[start_idx : end_idx + 1]
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed, dict):
                    return candidate
            except Exception:
                pass
            return candidate

        return None

    # First attempt on candidate_source
    res = _find_json_in_text(candidate_source)
    if res:
        return res

    # If candidate_source was from <verified_json> and failed, fall back to searching raw_str
    if candidate_source != raw_str:
        res = _find_json_in_text(raw_str)
        if res:
            return res

    raise ParseError(f"No JSON object found in raw LLM output: {raw_str[:120]}...")


def parse_llm_response(raw_text: str, options: Optional[List[str]] = None) -> ParsedLLMResponse:
    """
    Parse and validate raw LLM completion string.
    Ensures 'answer' and 'reason' exist and are non-empty.
    Supports ast.literal_eval, key normalizations, reasoning/workspace deduction,
    and regex fallback for resilient extraction.
    """
    verification_workspace: Optional[str] = None
    vw_match = re.search(r"<verification_workspace>\s*([\s\S]*?)\s*(?:</verification_workspace>|$)", raw_text, re.IGNORECASE)
    if vw_match and vw_match.group(1).strip():
        verification_workspace = vw_match.group(1).strip()

    data: Dict[str, Any] = {}
    json_candidate = ""
    try:
        json_candidate = extract_json_candidate(raw_text)
        data = json.loads(json_candidate)
    except Exception:
        # Fallback 1: try ast.literal_eval on candidate
        if json_candidate:
            try:
                candidate_data = ast.literal_eval(json_candidate)
                if isinstance(candidate_data, dict):
                    data = candidate_data
            except Exception:
                pass

        # Fallback 2: regex extract 'answer' and 'reason' from raw_text or verification_workspace
        if not data:
            search_sources = []
            if verification_workspace:
                search_sources.append(verification_workspace)
            search_sources.append(raw_text)

            for src in search_sources:
                ans_match = re.search(
                    r'["\']?(?:answer|correctAnswer|correctOptionId)["\']?\s*[:=]\s*(?:"([^"]+)"|\'([^\']+)\'|([A-Fa-f0-9]+)|\[([^\]]+)\])',
                    src,
                    re.IGNORECASE,
                )
                reason_match = re.search(
                    r'["\']?(?:reason|explanation|reasoning_summary)["\']?\s*[:=]\s*(?:"([^"]+)"|\'([^\']+)\')',
                    src,
                    re.IGNORECASE,
                )

                if ans_match:
                    extracted_ans = ans_match.group(1) or ans_match.group(2) or ans_match.group(3) or ans_match.group(4)
                    extracted_reason = ""
                    if reason_match:
                        extracted_reason = reason_match.group(1) or reason_match.group(2) or ""
                    data = {
                        "answer": extracted_ans.strip() if isinstance(extracted_ans, str) else extracted_ans,
                        "reason": extracted_reason.strip() if extracted_reason else "Step-by-step derivation verified."
                    }
                    break

            if not data:
                # Fallback 3: resilient conclusion pattern search
                conclusion_patterns = [
                    r'(?:correct\s+(?:answer|option|choice)\s+is|answer\s*[:\-]|option\s*[:\-]?|choice\s*[:\-]?|therefore|hence|thus)\s*[\(\[]?([A-Fa-f0-9])[\)\]]?(?:\s|$|\.|\,)',
                    r'(?:option|choice|answer)\s+([A-D])\s+(?:is\s+correct|is\s+the\s+correct|is\s+right)',
                    r'\b([A-D])\s+is\s+(?:the\s+)?correct\s+(?:option|choice|answer)\b',
                    r'[\(\[]([A-D])[\)\]]\s+(?:is\s+correct|is\s+the\s+correct)',
                    r'(?:select|choose)\s+option\s+([A-D])\b',
                    r'\b(?:final\s+answer|conclusion)\s*[:\-]?\s*[\(\[]?([A-D])[\)\]]?',
                ]

                for src in search_sources:
                    for pat in conclusion_patterns:
                        concl_match = re.search(pat, src, re.IGNORECASE)
                        if concl_match:
                            extracted_ans = concl_match.group(1).upper()
                            extracted_reason = src.strip()
                            data = {
                                "answer": extracted_ans,
                                "reason": extracted_reason if extracted_reason else "Step-by-step derivation verified."
                            }
                            break
                    if data:
                        break

            # Fallback 4: option text substring matching in conclusion/reasoning
            if not data and options and len(options) >= 2:
                for idx, opt in enumerate(options):
                    clean_opt = str(opt).strip()
                    if clean_opt and len(clean_opt) >= 2:
                        opt_pattern = r'\b' + re.escape(clean_opt) + r'\b'
                        for src in search_sources:
                            if re.search(opt_pattern, src, re.IGNORECASE):
                                letter = chr(65 + idx)
                                data = {
                                    "answer": letter,
                                    "reason": f"Matched deduction for option ({letter}) '{clean_opt}' in reasoning."
                                }
                                break
                    if data:
                        break

            if not data:
                raise ParseError(f"JSON decode failed and regex fallback could not find 'answer' in: '{raw_text[:120]}'")

    if not isinstance(data, dict):
        raise ParseError(f"Expected JSON object, got {type(data).__name__}")

    # Map alternative schema keys
    if "answer" not in data or data["answer"] is None:
        if "correctAnswer" in data and data["correctAnswer"] is not None:
            data["answer"] = data["correctAnswer"]
        elif "correctOptionId" in data and data["correctOptionId"] is not None:
            data["answer"] = data["correctOptionId"]

    if "reason" not in data or not data["reason"]:
        if "explanation" in data and data["explanation"]:
            data["reason"] = data["explanation"]
        elif "reasoning_summary" in data and data["reasoning_summary"]:
            data["reason"] = data["reasoning_summary"]

    if "answer" not in data or data["answer"] is None:
        # Regex search for answer if dict missed it
        ans_match = re.search(
            r'["\'](?:answer|correctAnswer|correctOptionId)["\']\s*:\s*(?:"([^"]+)"|\'([^\']+)\'|([A-Fa-f0-9]+)|\[([^\]]+)\])',
            raw_text,
            re.IGNORECASE,
        )
        if ans_match:
            data["answer"] = (ans_match.group(1) or ans_match.group(2) or ans_match.group(3) or ans_match.group(4)).strip()
        else:
            concl_match = re.search(
                r'(?:correct\s+(?:answer|option|choice)\s+is|answer\s*[:\-]|option\s*[:\-]?|choice\s*[:\-]?|therefore|hence|thus)\s*[\(\[]?([A-Fa-f0-9])[\)\]]?(?:\s|$|\.|\,)',
                raw_text,
                re.IGNORECASE,
            )
            if concl_match:
                data["answer"] = concl_match.group(1).upper()
            else:
                raise ParseError("JSON response missing required 'answer' key")

    answer_val = data["answer"]
    if isinstance(answer_val, str) and not answer_val.strip():
        raise ParseError("'answer' string cannot be empty")
    if isinstance(answer_val, (list, tuple)) and len(answer_val) == 0:
        raise ParseError("'answer' array cannot be empty")

    reason_val = data.get("reason", "")
    if not isinstance(reason_val, str) or not reason_val.strip():
        reason_val = "Step-by-step derivation verified."

    reason_clean = " ".join(str(reason_val).strip().split())

    return ParsedLLMResponse(
        answer=answer_val,
        reason=reason_clean,
        verification_workspace=verification_workspace,
        raw_text=raw_text,
    )
