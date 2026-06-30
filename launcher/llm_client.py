"""OpenAI-compatible LLM helpers for audit toolbox mapping suggestions."""
from __future__ import annotations

import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


AUTO_APPLY_CONFIDENCE = 0.8
FA_LIST_FAST_TIMEOUT = 12


def _fast_llm_settings(settings: dict[str, Any], timeout: int = FA_LIST_FAST_TIMEOUT) -> dict[str, Any]:
    fast = dict(settings or {})
    try:
        current = float(fast.get("timeout") or timeout)
    except (TypeError, ValueError):
        current = timeout
    fast["timeout"] = max(5, min(timeout, current))
    fast["_disable_empty_retry"] = True
    return fast


def _text_shape_profile(values: Any, *, unique_count: int | None = None, non_empty_count: int | None = None) -> dict[str, Any]:
    if not isinstance(values, list):
        values = [values] if values not in (None, "") else []
    texts = [str(value).strip() for value in values if str(value).strip()]
    lengths = [len(text) for text in texts]
    count = non_empty_count if non_empty_count is not None else len(texts)
    unique = unique_count if unique_count is not None else len(set(texts))
    code_like = sum(1 for text in texts if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-\/]{0,11}", text))
    cjk_short = sum(1 for text in texts if re.search(r"[\u4e00-\u9fff]", text) and len(text) <= 15)
    long_text = sum(1 for text in texts if len(text) > 15)
    denom = len(texts) or 1
    return {
        "non_empty_count": count,
        "unique_count": unique,
        "avg_text_len": round(sum(lengths) / len(lengths), 1) if lengths else 0,
        "max_text_len": max(lengths) if lengths else 0,
        "looks_like_code_ratio": round(code_like / denom, 2),
        "cjk_short_name_ratio": round(cjk_short / denom, 2),
        "long_text_ratio": round(long_text / denom, 2),
    }


def _compact_column_profiles(headers: list[str], raw_samples: dict[str, Any], raw_profiles: dict[str, Any], *, max_columns: int) -> dict[str, Any]:
    profiles: dict[str, Any] = {}
    for header in headers[:max_columns]:
        existing = raw_profiles.get(header)
        if isinstance(existing, dict):
            allowed = {
                "non_empty_count",
                "unique_count",
                "avg_text_len",
                "max_text_len",
                "looks_like_code_ratio",
                "cjk_short_name_ratio",
                "long_text_ratio",
            }
            profiles[header] = {key: existing.get(key) for key in allowed if key in existing}
        else:
            profiles[header] = _text_shape_profile(raw_samples.get(header, []))
    return profiles


def _compact_llm_files(
    files: list[dict[str, Any]],
    *,
    max_headers: int = 48,
    sample_columns: int = 24,
    sample_values: int = 1,
    sample_chars: int = 40,
) -> list[dict[str, Any]]:
    compact = []
    for file_info in files or []:
        headers = [str(header) for header in (file_info.get("headers") or [])][:max_headers]
        raw_samples = file_info.get("samples") if isinstance(file_info.get("samples"), dict) else {}
        raw_profiles = file_info.get("column_profiles") if isinstance(file_info.get("column_profiles"), dict) else {}
        samples = {}
        for header in headers[:sample_columns]:
            values = raw_samples.get(header, [])
            if isinstance(values, list):
                samples[header] = [str(value)[:sample_chars] for value in values[:sample_values]]
            elif values:
                samples[header] = [str(values)[:sample_chars]]
        compact.append(
            {
                "file_side": file_info.get("file_side", ""),
                "headers": headers,
                "samples": samples,
                "column_profiles": _compact_column_profiles(headers, raw_samples, raw_profiles, max_columns=sample_columns),
            }
        )
    return compact


def _unmapped_role_requests(role_definitions: list[dict[str, Any]], current_mapping: dict[str, Any]) -> list[dict[str, str]]:
    labels = {
        str(item.get("role") or "").strip(): str(item.get("label") or item.get("description") or item.get("role") or "").strip()
        for item in role_definitions or []
    }
    requests = []
    for role, mapping in (current_mapping or {}).items():
        if role == "match" or not isinstance(mapping, dict):
            continue
        for side in ("file1", "file2", "main"):
            if side in mapping and not str(mapping.get(side) or "").strip():
                requests.append({"role": str(role), "label": labels.get(str(role), str(role)), "file_side": side})
    return requests


@dataclass
class LLMSuggestion:
    role: str
    file_side: str
    suggested_column: str
    confidence: float
    action: str
    reason: str
    review_warning: str
    issue_field: str = ""
    current_mapping: dict[str, Any] | None = None
    suggested_mapping: dict[str, Any] | None = None
    auto_apply: bool = False
    issue_type: str = ""


@dataclass
class LLMMatchKeyReview:
    status: str
    confidence: float
    action: str
    reasons: list[str]
    suggested_file1_columns: list[str]
    suggested_file2_columns: list[str]
    suggestion_reason: str


@dataclass
class LLMCombinedFAListResult:
    suggestions: list[LLMSuggestion]
    fa_review: list[LLMSuggestion]
    match_review: LLMMatchKeyReview | None
    repair_used: bool = False


@dataclass
class LLMKanzhangMappingResult:
    fills: list[LLMSuggestion]
    reviews: list[LLMSuggestion]
    scheme: str = ""
    scheme_reason: str = ""


class LLMClientError(RuntimeError):
    """Raised when the configured LLM endpoint cannot return valid suggestions."""


def test_connection(settings: dict[str, Any]) -> tuple[bool, str]:
    try:
        content = _chat_completion(
            settings,
            [
                {"role": "system", "content": "Return JSON only."},
                {"role": "user", "content": '{"ping":"ok"}'},
            ],
            max_tokens=24,
            json_response=True,
            task_name="connection_test",
        )
        _extract_json(content)
        return True, "连接成功。"
    except Exception as exc:
        return False, f"连接失败：{exc}"


def suggest_field_mappings(
    settings: dict[str, Any],
    *,
    tool_name: str,
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    extra_instructions: str = "",
) -> list[LLMSuggestion]:
    settings = _fast_llm_settings(settings)
    compact_files = _compact_llm_files(files, max_headers=96, sample_columns=20, sample_values=1)
    missing_roles = _unmapped_role_requests(role_definitions, current_mapping)
    payload = {
        "tool_name": tool_name,
        "task": "choose headers for currently unmapped required fields",
        "missing_roles": missing_roles,
        "files": compact_files,
        "rules": [
            "No reasoning. Decide directly from headers, samples, and current_mapping.",
            "Only suggest columns that exist in the supplied headers for the same file_side.",
            "Only evaluate roles listed in missing_roles.",
            "Use action='fill' when the target file_side has a semantically matching header.",
            "Do not return action='keep' or action='none' items; omit roles that look reasonable or have no safe suggestion.",
            "Inspect unmapped roles first; return a fill item when a header semantically matches an empty role.",
            "For useful life, year-based headers such as 计划使用�?预计使用年限/使用年限 are valid life candidates when month-based headers are absent.",
            "Return at most 5 suggestions, prioritizing high-confidence fill/review items.",
            "Keep reason and review_warning under 18 Chinese characters each.",
            "For audit work, prefer precision over coverage.",
        ],
        "extra_instructions": extra_instructions,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "No reasoning. Output one minified JSON object only. "
                "Only inspect missing_roles. "
                "Return at most 5 actionable fill/review items. "
                "Do not return keep/none items. Shape: "
                '{"suggestions":[{"role":"...","file_side":"file1|file2|main",'
                '"suggested_column":"existing header or empty","confidence":0.0,'
                '"action":"fill|review","reason":"short reason",'
                '"review_warning":"short warning or empty"}]}. '
                "If there is no useful suggestion, return {\"suggestions\":[]}."
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        content = _chat_completion(settings, messages, max_tokens=800, json_response=True, task_name="mapping")
        raw = _extract_json(content)
    except LLMClientError:
        raw = {"suggestions": []}
    suggestions = raw.get("suggestions", []) if isinstance(raw, dict) else []
    normalized = [_normalize_suggestion(item) for item in suggestions if isinstance(item, dict)]
    if not missing_roles:
        return normalized
    missing_keys = {(str(item.get("role")), str(item.get("file_side"))) for item in missing_roles}
    filled_keys = {
        (str(item.role), str(item.file_side))
        for item in normalized
        if item.action == "fill" and item.confidence >= AUTO_APPLY_CONFIDENCE
    }
    if missing_keys.issubset(filled_keys):
        return normalized
    retry = _retry_missing_role_mappings(
        settings,
        tool_name=tool_name,
        missing_roles=[item for item in missing_roles if (str(item.get("role")), str(item.get("file_side"))) not in filled_keys],
        files=compact_files,
        extra_instructions=extra_instructions,
    )
    retry_keys = {(str(item.role), str(item.file_side)) for item in retry}
    merged = retry + [
        item
        for item in normalized
        if (str(item.role), str(item.file_side)) not in retry_keys
    ]
    _promote_valid_missing_role_fills(merged, missing_roles=missing_roles, files=compact_files)
    return merged


def check_kanzhang_field_mappings(
    settings: dict[str, Any],
    *,
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    extra_instructions: str = "",
) -> LLMKanzhangMappingResult:
    """Fill missing kanzhang mappings and review existing script guesses in one call."""
    settings = _fast_llm_settings(settings)
    compact_files = _compact_llm_files(files, max_headers=120, sample_columns=80, sample_values=3, sample_chars=80)
    current_main_mapping = _coerce_kanzhang_current_mapping(current_mapping)
    missing_roles = [
        {
            "role": str(item.get("role") or "").strip(),
            "label": str(item.get("label") or item.get("description") or item.get("role") or "").strip(),
            "file_side": "main",
        }
        for item in role_definitions or []
        if str(item.get("role") or "").strip() and not current_main_mapping.get(str(item.get("role") or "").strip())
    ]
    mapped_roles = [
        {
            "role": str(item.get("role") or "").strip(),
            "label": str(item.get("label") or item.get("description") or item.get("role") or "").strip(),
            "file_side": "main",
            "current_columns": current_main_mapping.get(str(item.get("role") or "").strip(), []),
        }
        for item in role_definitions or []
        if str(item.get("role") or "").strip() and current_main_mapping.get(str(item.get("role") or "").strip())
    ]
    payload = {
        "tool_name": "看账工具",
        "task": "fill missing voucher field mappings and review existing script mappings",
        "roles": role_definitions,
        "missing_roles": missing_roles,
        "mapped_roles": mapped_roles,
        "files": compact_files,
        "current_mapping": current_main_mapping,
        "rules": [
            "先根据 current_mapping、headers 和 samples 判断金额方案：scheme='A' 表示单金额列+方向列；scheme='B' 表示独立借方金额列+独立贷方金额列。",
            "方案A和方案B互斥，必须只选择一个；后续 fills/reviews 只能服务于所选方案。",
            "如果只发现一列金额，并另有方向/借贷/借贷方向列，应判为 scheme='A'，补 role_amt 和 role_dir，不得补 role_dr/role_cr。",
            "如果发现独立借方金额列和独立贷方金额列，且两列不是同一列，才可判为 scheme='B'。",
            "scheme='B' 时 role_dr 与 role_cr 的 suggested_column/current_column 绝不能相同；如相同，应 review 为方案错误或改判 scheme='A'。",
            "一次完成两件事：fills 只补 missing_roles；reviews 只报告 mapped_roles 中明显异常的映射。",
            "suggested_column 和 current_column 必须是 headers 中存在的原文列名。",
            "fills 中只返回有明确语义匹配的缺失字段；没有把握就省略。",
            "reviews 中只返回异常项；正常映射不要返回。",
            "如果已映射列和建议列只是同义表头且样例形态一致，不要报异常。",
            "复核时同时看表头和 samples；摘要字段应优先识别凭证说明、行项目文本、文本、description 等长文本说明列。",
            "role_acc 是会计科目名称或科目描述，不要选凭证摘要、文本说明或金额列。",
            "role_summary 是凭证摘要/行项目文本/文本说明，不要选科目名称、编号、日期或金额列。",
            "金额、借方、贷方、方向字段高风险：只有当前列与样例明显不符时才 review。",
            "reason 必须用中文，说明当前列为什么异常、建议列为什么更合适，控制在 80 个中文字符以内。",
            "优先少量高质量结果；最多返回 6 个 fills 和 5 个 reviews。",
        ],
        "extra_instructions": extra_instructions,
        "output_shape": {
            "scheme": "A|B|unknown",
            "scheme_reason": "中文短原因",
            "fills": [
                {
                    "role": "role id",
                    "suggested_column": "existing header",
                    "confidence": 0.0,
                    "reason": "中文原因",
                }
            ],
            "reviews": [
                {
                    "role": "role id",
                    "current_column": "existing current header",
                    "suggested_column": "existing better header",
                    "confidence": 0.0,
                    "reason": "中文异常原因",
                }
            ],
        },
    }
    messages = [
        {
            "role": "system",
            "content": (
                "只输出一个压缩 JSON 对象，不要 Markdown，不要推理过程。"
                "结构必须是 {\"scheme\":\"A|B|unknown\",\"scheme_reason\":\"...\",\"fills\":[],\"reviews\":[]}。"
                "方案A和方案B互斥：A只用 role_amt/role_dir，B只用 role_dr/role_cr。"
                "fills 用于缺失字段补全，reviews 用于已映射字段异常复核。"
                "没有可补全或异常时返回空数组。"
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        content = _chat_completion(settings, messages, max_tokens=1200, json_response=True, task_name="kanzhang_mapping_check")
        raw = _extract_json(content)
    except LLMClientError:
        raw = {"fills": [], "reviews": []}
    return normalize_kanzhang_mapping_check(
        raw,
        files=compact_files,
        current_mapping=current_main_mapping,
        missing_roles=missing_roles,
    )


def _coerce_kanzhang_current_mapping(current_mapping: dict[str, Any]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for role, value in (current_mapping or {}).items():
        role_text = str(role or "").strip()
        if not role_text:
            continue
        if isinstance(value, list):
            columns = [str(item).strip() for item in value if str(item).strip()]
        elif isinstance(value, tuple) or isinstance(value, set):
            columns = [str(item).strip() for item in value if str(item).strip()]
        elif isinstance(value, dict):
            raw = value.get("main")
            if isinstance(raw, list):
                columns = [str(item).strip() for item in raw if str(item).strip()]
            else:
                text = str(raw or "").strip()
                columns = [text] if text else []
        else:
            text = str(value or "").strip()
            columns = [text] if text else []
        out[role_text] = list(dict.fromkeys(columns))
    return out


def normalize_kanzhang_mapping_check(
    raw: Any,
    *,
    files: list[dict[str, Any]],
    current_mapping: dict[str, list[str]],
    missing_roles: list[dict[str, str]],
    fill_min_confidence: float = 0.65,
    review_min_confidence: float = 0.7,
) -> LLMKanzhangMappingResult:
    headers = set()
    for file_info in files or []:
        if str(file_info.get("file_side") or "") not in {"", "main"}:
            continue
        headers.update(str(header) for header in (file_info.get("headers") or []))
    missing_set = {str(item.get("role") or "").strip() for item in missing_roles or []}

    fills: list[LLMSuggestion] = []
    reviews: list[LLMSuggestion] = []
    if not isinstance(raw, dict):
        return LLMKanzhangMappingResult(fills=fills, reviews=reviews)
    scheme = _normalize_kanzhang_scheme(raw.get("scheme"), current_mapping)
    scheme_reason = str(raw.get("scheme_reason") or raw.get("schemeReason") or "").strip()
    allowed_fill_roles = _kanzhang_scheme_allowed_roles(scheme)

    for item in raw.get("fills") or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        column = str(item.get("suggested_column") or item.get("column") or "").strip()
        confidence = _safe_confidence(item.get("confidence"))
        if (
            role not in missing_set
            or role not in allowed_fill_roles
            or column not in headers
            or confidence < fill_min_confidence
        ):
            continue
        fills.append(
            LLMSuggestion(
                role=role,
                file_side="main",
                suggested_column=column,
                confidence=confidence,
                action="fill",
                reason=str(item.get("reason") or "").strip(),
                review_warning="",
            )
        )
    fill_by_role = {item.role: item.suggested_column for item in fills}
    if scheme == "B" and fill_by_role.get("role_dr") and fill_by_role.get("role_dr") == fill_by_role.get("role_cr"):
        scheme = "A"
        same_col_reason = "借方金额和贷方金额建议为同一列，按单金额列方案处理。"
        scheme_reason = f"{scheme_reason}；{same_col_reason}" if scheme_reason else same_col_reason
        fills = [item for item in fills if item.role not in {"role_dr", "role_cr"}]

    seen_review_roles: set[str] = set()
    for item in raw.get("reviews") or raw.get("mapping_review") or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or item.get("issue_field") or "").strip()
        suggested = str(item.get("suggested_column") or "").strip()
        current = str(item.get("current_column") or "").strip()
        confidence = _safe_confidence(item.get("confidence"))
        reason = str(item.get("reason") or item.get("review_warning") or "").strip()
        current_columns = current_mapping.get(role) or []
        if not current and current_columns:
            current = current_columns[0]
        if (
            not role
            or role in seen_review_roles
            or role in missing_set
            or role not in current_mapping
            or role not in allowed_fill_roles
            or confidence < review_min_confidence
            or not reason
            or current not in headers
            or suggested not in headers
            or suggested == current
        ):
            continue
        reviews.append(
            LLMSuggestion(
                role=role,
                file_side="main",
                suggested_column=suggested,
                confidence=confidence,
                action="review",
                reason=reason,
                review_warning=reason,
                current_mapping={"main": current},
                suggested_mapping={"main": suggested},
                issue_field=role,
                issue_type=str(item.get("issue_type") or "wrong_column").strip(),
            )
        )
        seen_review_roles.add(role)
    return LLMKanzhangMappingResult(fills=fills[:6], reviews=reviews[:5], scheme=scheme, scheme_reason=scheme_reason)


def _normalize_kanzhang_scheme(value: Any, current_mapping: dict[str, list[str]]) -> str:
    text = str(value or "").strip().upper()
    if text in {"A", "SCHEME_A", "方案A"}:
        return "A"
    if text in {"B", "SCHEME_B", "方案B"}:
        dr_cols = current_mapping.get("role_dr") or []
        cr_cols = current_mapping.get("role_cr") or []
        if dr_cols and cr_cols and set(dr_cols) == set(cr_cols):
            return "A"
        return "B"
    has_amt = bool(current_mapping.get("role_amt"))
    has_dir = bool(current_mapping.get("role_dir"))
    dr_cols = current_mapping.get("role_dr") or []
    cr_cols = current_mapping.get("role_cr") or []
    if dr_cols and cr_cols and set(dr_cols) != set(cr_cols):
        return "B"
    if has_amt or has_dir or (dr_cols and cr_cols and set(dr_cols) == set(cr_cols)):
        return "A"
    return "unknown"


def _kanzhang_scheme_allowed_roles(scheme: str) -> set[str]:
    common = {"role_id", "role_acc", "role_entity", "role_date", "role_summary"}
    if scheme == "B":
        return common | {"role_dr", "role_cr"}
    if scheme == "A":
        return common | {"role_amt", "role_dir"}
    return common | {"role_amt", "role_dir", "role_dr", "role_cr"}


def _safe_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        confidence = 0.0
    return max(0.0, min(1.0, confidence))


def _promote_valid_missing_role_fills(
    suggestions: list[LLMSuggestion],
    *,
    missing_roles: list[dict[str, str]],
    files: list[dict[str, Any]],
) -> None:
    missing_keys = {(str(item.get("role")), str(item.get("file_side"))) for item in missing_roles or []}
    headers_by_side = _headers_by_file_side(files)
    for suggestion in suggestions or []:
        key = (str(suggestion.role), str(suggestion.file_side))
        if (
            key in missing_keys
            and suggestion.action in {"fill", "review"}
            and suggestion.file_side in headers_by_side
            and suggestion.suggested_column in headers_by_side[suggestion.file_side]
        ):
            suggestion.action = "fill"
            suggestion.confidence = max(suggestion.confidence, AUTO_APPLY_CONFIDENCE)


def _retry_missing_role_mappings(
    settings: dict[str, Any],
    *,
    tool_name: str,
    missing_roles: list[dict[str, str]],
    files: list[dict[str, Any]],
    extra_instructions: str = "",
) -> list[LLMSuggestion]:
    """Ask a smaller follow-up question when the first mapping JSON is unusable."""
    payload = {
        "tool_name": tool_name,
        "missing_roles": missing_roles[:6],
        "files": files,
        "candidates": _candidate_headers_for_missing_roles(missing_roles[:6], files),
        "instructions": [
            "只处�?missing_roles 中列出的空字段。",
            "优先�?candidates 中选择；candidates 已按表头语义做过预筛。",
            "从相�?file_side �?headers 里选择语义最接近的真实列名。",
            "只要存在语义相关表头，就返回最佳候选，不要因为单位需换算而返回空。",
            "使用寿命(�? 可由计划使用年、预计使用年、使用年限、耐用年限等表头判断。",
            "本年折旧可由当年折旧、本期折旧、本年计提折旧等表头判断。",
            "完全没有相关表头时才省略该字段。",
            "不要解释，不要输出推理过程。",
        ],
        "extra_instructions": extra_instructions,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "只输出一个最�?JSON 对象，不要推理，不要 Markdown。"
                "结构必须是："
                '{"suggestions":[{"role":"role id","file_side":"file1|file2|main",'
                '"suggested_column":"existing header","confidence":0.0,'
                '"action":"fill","reason":"中文短原。","review_warning":""}]}. '
                "suggested_column 必须是对�?headers 中存在的原文列名。"
                "如果有语义相关表头，必须返回最佳候选；只有完全没有相关表头时才返回 {\"suggestions\":[]}。"
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        content = _chat_completion(
            settings,
            messages,
            max_tokens=480,
            json_response=False,
            task_name="mapping_missing_retry",
        )
        raw = _extract_json(content)
    except LLMClientError:
        return []
    suggestions = raw.get("suggestions", []) if isinstance(raw, dict) else []
    if not suggestions:
        suggestions = _retry_missing_role_mapping_lines(
            settings,
            tool_name=tool_name,
            missing_roles=missing_roles,
            files=files,
            extra_instructions=extra_instructions,
        )
    headers_by_side = _headers_by_file_side(files)
    normalized = []
    for item in suggestions:
        if not isinstance(item, dict):
            continue
        suggestion = _normalize_suggestion(item)
        if (
            suggestion.action == "fill"
            and suggestion.file_side in headers_by_side
            and suggestion.suggested_column in headers_by_side[suggestion.file_side]
        ):
            suggestion.confidence = max(suggestion.confidence, AUTO_APPLY_CONFIDENCE)
        normalized.append(suggestion)
    if not normalized:
        line_suggestions = _retry_missing_role_mapping_lines(
            settings,
            tool_name=tool_name,
            missing_roles=missing_roles,
            files=files,
            extra_instructions=extra_instructions,
        )
        normalized = [_normalize_suggestion(item) for item in line_suggestions if isinstance(item, dict)]
        _promote_valid_missing_role_fills(normalized, missing_roles=missing_roles, files=files)
    if not normalized:
        normalized = _single_candidate_missing_role_fills(missing_roles=missing_roles, files=files)
    return normalized


def _retry_missing_role_mapping_lines(
    settings: dict[str, Any],
    *,
    tool_name: str,
    missing_roles: list[dict[str, str]],
    files: list[dict[str, Any]],
    extra_instructions: str = "",
) -> list[dict[str, Any]]:
    candidates = _candidate_headers_for_missing_roles(missing_roles[:6], files)
    if not candidates:
        return []
    payload = {
        "tool_name": tool_name,
        "missing_roles": missing_roles[:6],
        "candidates": candidates,
        "output": "每行输出 role|file_side|header|confidence，只能使用候�?header；没有候选才不输出该行。",
        "extra_instructions": extra_instructions,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "你只做固定资产字段匹配候选选择。不要推理。"
                "�?candidates 中为每个 missing role 选择最合适的 header。"
                "每行严格输出 role|file_side|header|confidence。不要输�?JSON。"
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        content = _chat_completion(settings, messages, max_tokens=220, json_response=False, task_name="mapping_candidate_retry")
    except LLMClientError:
        return []
    allowed = {
        (str(item.get("role")), str(item.get("file_side")), str(header))
        for item in candidates
        for header in item.get("headers", [])
    }
    out = []
    for line in str(content or "").splitlines():
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 3:
            continue
        role, side, header = parts[:3]
        if (role, side, header) not in allowed:
            continue
        try:
            confidence = float(parts[3]) if len(parts) > 3 else AUTO_APPLY_CONFIDENCE
        except ValueError:
            confidence = AUTO_APPLY_CONFIDENCE
        out.append(
            {
                "role": role,
                "file_side": side,
                "suggested_column": header,
                "confidence": max(confidence, AUTO_APPLY_CONFIDENCE),
                "action": "fill",
                "reason": "候选语义匹。",
                "review_warning": "",
            }
        )
    return out


def _candidate_headers_for_missing_roles(
    missing_roles: list[dict[str, str]],
    files: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    headers_by_side = _ordered_headers_by_file_side(files)
    keyword_map = {
        "life": ("寿命", "使用", "年限", "耐用", "计划使用", "预计使用"),
        "current_depr": ("本年折旧", "当年折旧", "本期折旧", "计提折旧", "月折旧"),
        "original_value": ("原值", "资产原值", "期末原值"),
        "depreciation": ("累计折旧", "折旧累计"),
        "salvage_rate": ("残值率", "净残值率", "残值"),
        "date": ("??", "??", "???", "??"),
        "name": ("名称", "描述"),
        "category": ("类别", "分类", "类型"),
    }
    out = []
    for role_request in missing_roles or []:
        role = str(role_request.get("role") or "").strip()
        side = str(role_request.get("file_side") or "").strip()
        label = str(role_request.get("label") or "").strip()
        headers = headers_by_side.get(side, [])
        keywords = list(keyword_map.get(role, ()))
        keywords.extend([part for part in re.split(r"[\s()/（）_-]+", label) if len(part) >= 2])
        candidates = [
            header
            for header in headers
            if any(keyword and keyword in header for keyword in keywords)
        ][:8]
        if candidates:
            out.append({"role": role, "file_side": side, "label": label, "headers": candidates})
    return out


def _single_candidate_missing_role_fills(
    *,
    missing_roles: list[dict[str, str]],
    files: list[dict[str, Any]],
) -> list[LLMSuggestion]:
    out = []
    for item in _candidate_headers_for_missing_roles(missing_roles, files):
        headers = item.get("headers") or []
        if len(headers) != 1:
            continue
        out.append(
            LLMSuggestion(
                role=str(item.get("role") or ""),
                file_side=str(item.get("file_side") or ""),
                suggested_column=str(headers[0]),
                confidence=AUTO_APPLY_CONFIDENCE,
                action="fill",
                reason="唯一候选匹。",
                review_warning="",
            )
        )
    return out


def _fallback_unmapped_field_suggestions(
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    existing: list[LLMSuggestion],
) -> list[LLMSuggestion]:
    headers_by_side = _ordered_headers_by_file_side(files)
    existing_keys = {
        (str(item.role), str(item.file_side))
        for item in existing or []
        if str(item.role)
        and str(item.file_side)
        and str(item.suggested_column).strip() in headers_by_side.get(str(item.file_side), [])
        and (
            (item.action == "fill" and item.confidence >= AUTO_APPLY_CONFIDENCE)
            or (item.action == "review" and item.confidence >= 0.55)
        )
    }
    out: list[LLMSuggestion] = []
    for role_request in _unmapped_role_requests(role_definitions, current_mapping):
        role = role_request.get("role")
        side = role_request.get("file_side")
        if (role, side) in existing_keys:
            continue
        if role == "life":
            column = _pick_useful_life_header(headers_by_side.get(side, []))
            if column:
                out.append(
                    LLMSuggestion(
                        role="life",
                        file_side=side,
                        suggested_column=column,
                        confidence=0.86,
                        action="fill",
                        reason="识别为使用寿命列",
                        review_warning="",
                    )
                )
    return out


def review_fa_list_field_mappings(
    settings: dict[str, Any],
    *,
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    role_definitions: list[dict[str, Any]] | None = None,
    extra_instructions: str = "",
) -> list[LLMSuggestion]:
    """Review FA List pre-mapped fields and return correction suggestions.

    The return type intentionally reuses LLMSuggestion so existing UI code that
    already understands suggest_field_mappings can consume action/confidence and
    newer UI code can read issue_field/current_mapping/suggested_mapping for
    one-click correction.
    """
    role_definitions = role_definitions or _default_fa_list_role_definitions()
    return _generate_independent_fa_list_assistance(
        settings,
        tool_name="FA List",
        files=files,
        current_mapping=current_mapping,
        current_match={},
        role_definitions=role_definitions,
        include_field_review=True,
        include_match_review=False,
    ).fa_review
    role_definitions = role_definitions or _default_fa_list_role_definitions()
    settings = _fast_llm_settings(settings)
    compact_files = _compact_llm_files(files, max_headers=48, sample_columns=32, sample_values=3)
    blind_field_view = _build_blind_field_view(compact_files, current_mapping)
    payload = {
        "tool_name": "FA List",
        "task": "independently infer fixed asset field roles from data shape, then review current mappings",
        "roles": role_definitions,
        "files": compact_files,
        "blind_field_files": blind_field_view["files"],
        "field_header_lookup": blind_field_view["header_lookup"],
        "current_mapping_blind": blind_field_view["current_mapping"],
        "current_mapping": current_mapping,
        "rules": [
            "No reasoning. For field review, first choose anonymous column ids from blind_field_files using samples and column_profiles only; translate ids back with field_header_lookup only after the blind choice is done.",
            "Do not decide from real header text or current_mapping first. current_mapping is only the script guess to compare after blind role classification.",
            "Only flag obvious mismatches supported by headers, samples, or column_profiles.",
            "Treat current_mapping as a script guess, not ground truth. Do not preserve it when the data shape points to a different role.",
            "Field roles are mutually constrained: category/name/code/date/life/value/depreciation should be checked as a group, not as isolated one-column checks.",
            "Compare file1 and file2 mapping口径: category vs type description, original value vs disposal/original decrease, accumulated depreciation vs current-year depreciation.",
            "Do NOT flag a 'years vs months' difference on the life/使用寿命 field �?the export script auto-converts year-based life columns to months (×12).",
            "Do NOT flag a '残值率 vs 残�? difference on the residual/残值率 field �?the export script auto-converts residual values (>100) to a rate via 残�?原�?",
            "Do NOT emit issue_type='unit_mismatch' for the life or residual roles for the same reason.",
            "字段复核必须以样例值和 column_profiles 为主，列名只作参考；当列名暗示、脚本初判与数据形态明显冲突时，优先相信数据形态并 flag issue_type='wrong_column'.",
            "category 应是短中文类别名：多数样例较短（通常 <=15 字）、中文类型名占比高、unique_count 通常较少；name 应是具体资产名称/型号/规格/地点等长描述，通常文本更长�?unique_count 明显更多。",
            "Before suggesting a category column, verify its column_profiles: reject columns with looks_like_code_ratio >= 0.5; prefer cjk_short_name_ratio high, long_text_ratio low, and unique_count low. If current category already matches that shape, do not suggest changing it.",
            "Before suggesting a name column, verify its column_profiles: reject columns that look like low-cardinality short category names (unique_count <= 50 and cjk_short_name_ratio >= 0.8). Prefer columns with high unique_count or longer asset-description text. If current name already matches that shape, do not suggest changing it.",
            "category �?name 在同一 file_side 不应映射到同一列。若当前相同，或 category 建议列正�?name 使用，必须同时复�?name 并建议一个长描述/高唯一值列；若无合�?name 列则留空并说明冲突。",
            "When several columns appear to form a swapped or shifted group, return one review issue per affected role so the user can apply a complete correction, not a partial single-field fix.",
            "短字母数字值（�?'Y110', 'A12-3', '1100000'）是代码/编号形态，不是 category 中文类别名；即使表头�?分类/类别，也应按 wrong_column �?cross_period_inconsistent 处理。",
            "Cross-period口径一致性：file1 �?file2 �?category 应同为类别名称口径。若一侧是短类别名，另一侧是代码/编号或长资产描述，flag issue_type='cross_period_inconsistent'，并�?suggested_mapping 中给出口径一致的建议；若该侧没有合适列，留空字符串。",
            "suggested_mapping values must be exact supplied headers for the same file_side, otherwise leave them empty.",
            "If you suggest a column, also provide suggested_mapping_ids with the anonymous ids from blind_field_files, e.g. {'file2':'file2_col_3'}.",
            "Set auto_apply true only when the correction is low-risk and confidence >= 0.8.",
            "Prefer fewer high-quality issues over broad speculation.",
            "Return at most 3 issues. If there is no obvious mismatch, return an empty mapping_review array.",
            "A review issue may have empty suggested_mapping when no better header exists.",
            "Keep reason under 24 Chinese characters.",
        ],
        "extra_instructions": extra_instructions,
        "output_shape": {
            "mapping_review": [
                {
                    "issue_field": "role id",
                    "issue_type": "wrong_column|cross_period_inconsistent|unit_mismatch|ambiguous",
                    "current_mapping": {"file1": "current header", "file2": "current header"},
                    "suggested_mapping": {"file1": "suggested header or empty", "file2": "suggested header or empty"},
                    "suggested_mapping_ids": {"file1": "anonymous id or empty", "file2": "anonymous id or empty"},
                    "confidence": 0.0,
                    "reason": "short reason",
                    "auto_apply": False,
                }
            ]
        },
    }
    messages = [
        {
            "role": "system",
            "content": (
                "No reasoning. Output one minified JSON object only. Shape: "
                '{"mapping_review":[{"issue_field":"...","issue_type":"...",'
                '"current_mapping":{"file1":"...","file2":"..."},'
                '"suggested_mapping":{"file1":"...","file2":"..."},'
                '"confidence":0.0,"reason":"...","auto_apply":false}]}. '
                "Return at most 3 issues. suggested_mapping may be empty when the issue is only a risk warning. "
                "If mappings look reasonable, return {\"mapping_review\":[]}."
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        # max_tokens 现仅用于日志（_chat_completion 已不再写�?HTTP 请求体）�?        # 模型按其上下文上限自由输出�?        content = _chat_completion(settings, messages, max_tokens=2500, json_response=True, task_name="fa_review")
        raw = _extract_json(content)
    except LLMClientError:
        raw = {"mapping_review": []}
    raw = _translate_blind_mapping_review_ids(raw, blind_field_view["header_lookup"])
    return normalize_fa_list_mapping_review(raw, files=files, current_mapping=current_mapping)


def normalize_fa_list_mapping_review(
    raw: Any,
    *,
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    min_confidence: float = 0.55,
) -> list[LLMSuggestion]:
    """Normalize and filter FA List mapping-review JSON.

    This is deliberately pure/testable: callers can feed mock LLM JSON and get
    validated LLMSuggestion objects without hitting a network endpoint.
    """
    if isinstance(raw, dict):
        items = raw.get("mapping_review")
        if items is None:
            items = raw.get("issues")
        if items is None:
            items = raw.get("suggestions")
    else:
        items = raw
    if not isinstance(items, list):
        return []

    headers_by_side = _headers_by_file_side(files)
    out: list[LLMSuggestion] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        issue_field = str(item.get("issue_field") or item.get("role") or item.get("issue") or item.get("field") or "").strip()
        if not issue_field:
            continue
        # ???????/???????????????????
        issue_type_raw = str(item.get("issue_type") or "").strip().lower()
        if issue_type_raw == "unit_mismatch" and issue_field in {"life", "residual", "residual_rate", "salvage_rate"}:
            continue
        try:
            confidence = float(item.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        if confidence < min_confidence:
            continue

        suggested_mapping = _coerce_side_mapping(item.get("suggested_mapping"))
        current_side_mapping = _coerce_side_mapping(item.get("current_mapping"))
        if not current_side_mapping:
            current_side_mapping = _coerce_side_mapping(current_mapping.get(issue_field))
        suggested_mapping = _filter_suggested_mapping_to_headers(suggested_mapping, headers_by_side)
        reason = str(item.get("reason") or item.get("review_warning") or item.get("detail") or "").strip()
        if not suggested_mapping and not reason:
            continue

        auto_apply = bool(item.get("auto_apply")) and confidence >= AUTO_APPLY_CONFIDENCE
        if auto_apply and len(suggested_mapping) != len(_coerce_side_mapping(item.get("suggested_mapping"))):
            auto_apply = False

        if suggested_mapping:
            primary_side, primary_col = next(iter(suggested_mapping.items()))
        elif current_side_mapping:
            primary_side, primary_col = next(iter(current_side_mapping.items()))
        else:
            primary_side, primary_col = "file1", ""
        issue_type = str(item.get("issue_type") or "").strip()
        out.append(
            LLMSuggestion(
                role=issue_field,
                file_side=primary_side,
                suggested_column=primary_col,
                confidence=confidence,
                action="review",
                reason=reason,
                review_warning=reason,
                issue_field=issue_field,
                current_mapping=current_side_mapping,
                suggested_mapping=suggested_mapping,
                auto_apply=auto_apply,
                issue_type=issue_type,
            )
        )
    return out



def _generate_independent_fa_list_assistance(
    settings: dict[str, Any],
    *,
    tool_name: str,
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    role_definitions: list[dict[str, Any]] | None = None,
    include_field_review: bool = True,
    include_match_review: bool = True,
) -> LLMCombinedFAListResult:
    """Ask the LLM to classify FA columns without seeing script guesses."""
    role_definitions = role_definitions or _default_fa_list_role_definitions()
    settings = _fast_llm_settings(settings, timeout=18)
    compact_files = _compact_llm_files(files, max_headers=96, sample_columns=80, sample_values=3)
    blind_view = _build_blind_field_view(compact_files, {})
    role_ids = [str(item.get("role") or "").strip() for item in role_definitions if str(item.get("role") or "").strip()]
    payload = {
        "tool_name": tool_name,
        "task": "independent fixed asset business-field classification and code-column review from headers, samples, and profiles only",
        "blind_files": blind_view["files"],
        "roles_to_classify": [role for role in role_ids if role != "match"],
        "need_code_column_review": bool(include_match_review),
        "rules": [
            "Do not infer from script mappings, current match keys, candidate profiles, or local uniqueness profiles; none are provided.",
            "Classify only from each anonymous column's header, samples, and column_profiles.",
            "Headers are useful clues, but values and column_profiles win when a header conflicts with the data shape.",
            "For each file, identify business fields independently. For ID review, identify only the primary asset code/number columns, not the full matching key.",
            "The application may append asset name/description as an auxiliary matching column; do not judge, add, remove, or replace that auxiliary name part.",
            "match_key in your output means code columns only. It may contain one or more code/number columns, but must not include asset name/description columns.",
            "category should be short low-cardinality type/category names, not code-like values.",
            "name should be concrete asset name/description, usually longer text or higher cardinality.",
            "asset codes/IDs are usually numeric or alphanumeric identifiers, not dates, amounts, rates, or category names.",
            "Return anonymous ids only; do not return headers in roles or match_key.",
        ],
        "output_shape": {
            "roles": [
                {"role": "category", "file1": "file1_col_1", "file2": "file2_col_1", "confidence": 0.0, "reason": "short Chinese reason"}
            ],
            "match_key": {
                "file1": ["file1_col_2"],
                "file2": ["file2_col_2"],
                "confidence": 0.0,
                "reason": "short Chinese reason",
            },
        },
    }
    messages = [
        {
            "role": "system",
            "content": (
                "Return one strict minified JSON object only. "
                "Use anonymous column ids from blind_files. Read headers/samples/profiles as evidence, but output ids only. "
                "For match_key, output only the primary asset code/number columns, not auxiliary name/description columns. "
                '{"roles":[{"role":"...","file1":"file1_col_1","file2":"file2_col_1","confidence":0.0,"reason":"..."}],'
                '"match_key":{"file1":["file1_col_2"],"file2":["file2_col_2"],"confidence":0.0,"reason":"..."}}'
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))},
    ]
    try:
        content = _chat_completion(settings, messages, max_tokens=1400, json_response=True, task_name="fa_independent_roles")
        raw = _extract_json(content)
    except LLMClientError:
        raw = {}
    return _independent_roles_to_combined_result(
        raw,
        files=files,
        header_lookup=blind_view["header_lookup"],
        current_mapping=current_mapping,
        current_match=current_match,
        role_definitions=role_definitions,
        include_field_review=include_field_review,
        include_match_review=include_match_review,
    )


def _independent_roles_to_combined_result(
    raw: Any,
    *,
    files: list[dict[str, Any]],
    header_lookup: dict[str, dict[str, str]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    role_definitions: list[dict[str, Any]],
    include_field_review: bool,
    include_match_review: bool,
) -> LLMCombinedFAListResult:
    role_labels = {
        str(item.get("role") or "").strip(): str(item.get("label") or item.get("description") or item.get("role") or "").strip()
        for item in role_definitions or []
    }
    role_choices = _extract_independent_role_choices(raw)
    suggestions: list[LLMSuggestion] = []
    review_items: list[dict[str, Any]] = []
    if include_field_review:
        for role, choice in role_choices.items():
            if role == "match" or role not in role_labels:
                continue
            confidence = _coerce_confidence(choice.get("confidence"), default=0.78)
            reason = str(choice.get("reason") or "独立判断不一致").strip()[:40]
            suggested_by_side: dict[str, str] = {}
            for side in ("file1", "file2"):
                col_id = str(choice.get(side) or "").strip()
                header = header_lookup.get(side, {}).get(col_id, "")
                if header:
                    suggested_by_side[side] = header
            current = _coerce_side_mapping(current_mapping.get(role))
            for side, suggested in suggested_by_side.items():
                if current.get(side):
                    continue
                suggestions.append(
                    LLMSuggestion(
                        role=role,
                        file_side=side,
                        suggested_column=suggested,
                        confidence=confidence,
                        action="fill",
                        reason=reason,
                        review_warning="",
                    )
                )
            changed = {
                side: suggested
                for side, suggested in suggested_by_side.items()
                if current.get(side) and current.get(side) != suggested
            }
            if changed:
                review_items.append(
                    {
                        "issue_field": role,
                        "issue_type": "wrong_column",
                        "current_mapping": current,
                        "suggested_mapping": changed,
                        "confidence": confidence,
                        "reason": reason,
                        "auto_apply": False,
                    }
                )
    fa_review = normalize_fa_list_mapping_review(
        {"mapping_review": review_items},
        files=files,
        current_mapping=current_mapping,
    )
    match_review = None
    if include_match_review:
        match_choice = _extract_independent_match_choice(raw)
        match_review = _independent_match_choice_to_review(
            match_choice,
            header_lookup=header_lookup,
            current_match=current_match,
        )
    return LLMCombinedFAListResult(
        suggestions=suggestions,
        fa_review=fa_review,
        match_review=match_review,
        repair_used=False,
    )


def _coerce_confidence(value: Any, *, default: float = 0.0) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        confidence = default
    return max(0.0, min(1.0, confidence))


def _extract_independent_role_choices(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    roles = raw.get("roles")
    if isinstance(roles, list):
        for item in roles:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role") or item.get("field") or "").strip()
            if role:
                out[role] = dict(item)
    fields = raw.get("fields")
    if isinstance(fields, dict):
        for side in ("file1", "file2"):
            side_fields = fields.get(side)
            if not isinstance(side_fields, dict):
                continue
            for role, col_id in side_fields.items():
                out.setdefault(str(role), {})[side] = str(col_id or "").strip()
    for side in ("file1", "file2"):
        side_obj = raw.get(side)
        if isinstance(side_obj, dict):
            side_fields = side_obj.get("fields") if isinstance(side_obj.get("fields"), dict) else side_obj
            for role, col_id in side_fields.items():
                if role in {"match", "match_key"}:
                    continue
                if isinstance(col_id, (str, int, float)):
                    out.setdefault(str(role), {})[side] = str(col_id).strip()
    return out


def _extract_independent_match_choice(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    match = raw.get("match_key") or raw.get("code_key") or raw.get("match_code") or raw.get("code_columns") or raw.get("match") or {}
    if isinstance(match, dict):
        return dict(match)
    return {}


def _id_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _independent_match_choice_to_review(
    match_choice: dict[str, Any],
    *,
    header_lookup: dict[str, dict[str, str]],
    current_match: dict[str, Any],
) -> LLMMatchKeyReview:
    confidence = _coerce_confidence(match_choice.get("confidence"), default=0.78)
    reason = str(match_choice.get("reason") or "???????").strip()
    code1 = [header_lookup.get("file1", {}).get(col_id, "") for col_id in _id_list(match_choice.get("file1"))]
    code2 = [header_lookup.get("file2", {}).get(col_id, "") for col_id in _id_list(match_choice.get("file2"))]
    code1 = [col for col in code1 if col]
    code2 = [col for col in code2 if col]
    current1 = [str(col).strip() for col in (current_match or {}).get("file1", []) if str(col).strip()] if isinstance(current_match, dict) else []
    current2 = [str(col).strip() for col in (current_match or {}).get("file2", []) if str(col).strip()] if isinstance(current_match, dict) else []
    has_suggestion = bool(code1 and code2 and len(code1) == len(code2))
    if not has_suggestion:
        return LLMMatchKeyReview(
            status="ok",
            confidence=0.0,
            action="keep",
            reasons=[],
            suggested_file1_columns=current1,
            suggested_file2_columns=current2,
            suggestion_reason="",
        )

    current_code1 = current1[: len(code1)]
    current_code2 = current2[: len(code2)]
    changed = current_code1 != code1 or current_code2 != code2
    suggested1 = code1 + current1[len(code1) :]
    suggested2 = code2 + current2[len(code2) :]
    return LLMMatchKeyReview(
        status="warning" if changed else "ok",
        confidence=confidence,
        action="replace" if changed else "keep",
        reasons=[reason] if reason else [],
        suggested_file1_columns=suggested1 if changed else current1,
        suggested_file2_columns=suggested2 if changed else current2,
        suggestion_reason=reason,
    )
def review_match_key_columns(
    settings: dict[str, Any],
    *,
    tool_name: str,
    files: list[dict[str, Any]],
    current_match: dict[str, Any],
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]] | None = None,
    extra_instructions: str = "",
    forbidden_columns: dict[str, list[str]] | None = None,
) -> LLMMatchKeyReview:
    result = _generate_independent_fa_list_assistance(
        settings,
        tool_name=tool_name,
        files=files,
        current_mapping={},
        current_match=current_match,
        role_definitions=_default_fa_list_role_definitions(),
        include_field_review=False,
        include_match_review=True,
    )
    if result.match_review is not None:
        return result.match_review
    return LLMMatchKeyReview(
        status="ok", confidence=0.0, action="keep", reasons=[],
        suggested_file1_columns=current_match.get("file1", []) if isinstance(current_match, dict) else [],
        suggested_file2_columns=current_match.get("file2", []) if isinstance(current_match, dict) else [],
        suggestion_reason="",
    )
    settings = _fast_llm_settings(settings)
    compact_files = _compact_llm_files(files, max_headers=48, sample_columns=12, sample_values=1)
    blind_match_view = _build_blind_match_view(compact_files, current_match)
    fb_raw = forbidden_columns or {}
    forbidden_normalized = {
        "file1": [str(c) for c in (fb_raw.get("file1") or []) if str(c).strip()],
        "file2": [str(c) for c in (fb_raw.get("file2") or []) if str(c).strip()],
    }
    payload = {
        "tool_name": tool_name,
        "blind_match_files": blind_match_view["files"],
        "match_header_lookup": blind_match_view["header_lookup"],
        "current_match_blind": blind_match_view["current_match"],
        "files": compact_files,
        "current_match": current_match,
        "local_profile": local_profile,
        "candidate_profiles": list(candidate_profiles or [])[:12],
        "forbidden_columns": forbidden_normalized,
        "rules": [
            "Primary rule: first infer the best match key columns from blind_match_files using only values under each anonymous column id and column_profiles.",
            "Do not decide from current_match, local_profile, candidate_profiles, forbidden_columns, or real header text first. These are script/reference data for comparison only after the blind choice is complete.",
            "After the blind choice, compare it with current_match_blind. If they match, return status='ok' and action='keep'. If they differ, return status='warning' or 'bad' and action='replace' or 'review'.",
            "Use match_header_lookup only to translate chosen anonymous ids back to suggested_file1_columns/suggested_file2_columns.",
            "Also return suggested_file1_ids and suggested_file2_ids with the anonymous ids you chose.",
            "candidate_profiles is only a script-generated reference; do not restrict your answer to candidate_profiles when blind_match_files point to a different better key.",
            "No reasoning. Decide directly from blind_match_files first, then compare against script/reference data.",
            "If local_profile shows duplicate or blank current keys, use it only after the blind choice to explain the mismatch.",
            "When the blind choice materially differs from current_match and appears more consistent by values, return status='warning' or 'bad', action='replace', and output the blind choice.",
            "Only return action='keep' when the independent blind choice matches the current key.",
            "candidate_profiles contains paired candidate composite keys built by script; it is reference data, not a restriction.",
            "Prefer suggested_file1_columns/suggested_file2_columns translated from suggested_file1_ids/suggested_file2_ids.",
            "When current keys have duplicates and blind_match_files indicate a better paired key, return status=warning or bad, action=replace.",
            "Do not copy placeholder text such as 中文原因 or 中文建议理由.",
            "用中文判�?current_match.file1 �?current_match.file2 是否适合作为唯一识别码。",
            "依据 local_profile 中的唯一率、空值率、重复样例、表头和样例值判断。",
            "status must be ok, warning, or bad.",
            "action must be keep, replace, or review.",
            "只能建议对应文件 headers 中真实存在的列。",
            "当单列不唯一时，可以建议多列组合键。",
            "优先选择稳定的资产编号、卡片编号、固定资产编号，或含义明确的组合键。",
            "如果一边是资产编号、一边是资产名称等明显错配，应提示。",
            "口径一致优先：如果 current_match.file1 �?current_match.file2 是不同概念的 ID 列（例如一边是资产编码、另一边是卡片编码），并且 candidate_profiles 中存在两边同�?ID 列的候选（如双方都用卡片编码），应返回 status=bad、action=replace，并照抄该候选的 file1_columns/file2_columns —�?即使当前两侧分别都唯一也要替换。",
            "主键合理性优先：评估 current_match 时不能只�?unique_rate；必须结合样例值检查主键列的数据形态。如果主键样例看起来是比率（0~1 的小数，�?0.05�?.1）、金额（带小数点的大数）、类别短词（如『房屋及建筑』）、日期（yyyy-mm-dd）等非编号语义，即使整体复合键凭辅助列已经唯一，也应判定主键不适合做唯一识别码。这种情况通常源于：脚本无法从表头识别真正�?ID 列（例如�?ID 列被改名为『资产类型』等无关名字），脚本被迫从其他列里挑了一个当主键。",
            "数据驱动候选优先：�?candidate_profiles 中存�?group='data_driven_id' 的候选，且当前主键的数据形态明显不像编号时（按上一条判断），应返回 status=bad、action=replace，并照抄该候选的 file1_columns/file2_columns —�?即使当前复合�?unique_rate 已经�?1.0 也要替换。理由写明『当前主键数据形态非编号』。",
            "禁列优先：suggested_file1_columns 中不能包�?forbidden_columns.file1 里列出的任何列名；suggested_file2_columns 同理。这些列已被脚本识别为期初期末会变化的业务属性字段（如折旧、原值、寿命、类别、日期等），放进匹配键会导致同一卡片在两期键值不一致而错配。如�?candidate_profiles 里有候选包�?forbidden_columns 中的列，跳过该候选改选其他；如果所有候选都不可用，返回 status=ok、action=keep。资产名称已被脚本作为例外排除在 forbidden_columns 之外，可以保留为辅助键。",
            "两侧列数必须相等：suggested_file1_columns �?suggested_file2_columns 的长度必须完全一致——这是后续多列组合键合并的硬性前提。如果禁列剔除后某一侧已不足以与另一侧配对，则放弃该建议、返�?status=ok、action=keep。",
            "副编码优先：在脚本已找到的主编码基础上，优先寻找『副编码、次级编码、上�?父级资产编码、子资产序号、原系统编码、卡片编号』等同样属于编号语义的列作为辅助键，列名常包含『编�?编号/序号/ID/Code/No/卡片号』字样，或数据形态为纯数字串、字母数字混合的短码。",
            "当存在编�?卡片�?ID列时，不要单独建议宽泛描述字段。",
            "reasons �?suggestion_reason 必须使用简短中文，不要输出英文。",
        ],
        "extra_instructions": extra_instructions,
    }
    messages = [
        {
            "role": "system",
            "content": (
                "你是固定资产卡片匹配列复核助手，帮助审计人员判断匹配列是否适合作为唯一识别码。"
                "只返回严�?JSON。除 status/action 等枚举值外，reasons �?suggestion_reason 必须使用简短中文，不要输出英文。"
                "JSON 结构�?"
                '{"status":"ok|warning|bad","confidence":0.0,"action":"keep|replace|review",'
                '"reasons":["中文原因"],"suggested_file1_columns":["existing header"],'
                '"suggested_file2_columns":["existing header"],"suggestion_reason":"中文建议理由"}'
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    try:
        content = _chat_completion(settings, messages, max_tokens=420, json_response=True, task_name="match_review")
        raw = _extract_json(content)
    except LLMClientError:
        raw = {
            "status": "ok",
            "confidence": 0.0,
            "action": "keep",
            "reasons": [],
            "suggested_file1_columns": current_match.get("file1", []) if isinstance(current_match, dict) else [],
            "suggested_file2_columns": current_match.get("file2", []) if isinstance(current_match, dict) else [],
            "suggestion_reason": "",
        }
    if not isinstance(raw, dict):
        raise LLMClientError("模型没有返回匹配列复核 JSON 对象。")
    raw = _translate_blind_match_review_ids(raw, blind_match_view["header_lookup"])
    review = _normalize_match_key_review(raw, files=files)
    if _match_review_needs_candidate_retry(review, local_profile, candidate_profiles):
        retry_review = _retry_match_candidate_choice(
            settings,
            current_match=current_match,
            local_profile=local_profile,
            candidate_profiles=candidate_profiles or [],
        )
        if retry_review is not None:
            review = retry_review
    return review


def generate_combined_fa_list_assistance(
    settings: dict[str, Any],
    *,
    tool_name: str,
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]] | None = None,
    include_match_review: bool = True,
    mapping_extra_instructions: str = "",
    review_extra_instructions: str = "",
    match_extra_instructions: str = "",
    forbidden_columns: dict[str, list[str]] | None = None,
) -> LLMCombinedFAListResult:
    """Run FA List mapping, field-review, and match-key review in one slim LLM call."""
    return _generate_independent_fa_list_assistance(
        settings,
        tool_name=tool_name,
        files=files,
        current_mapping=current_mapping,
        current_match=current_match,
        role_definitions=role_definitions,
        include_field_review=True,
        include_match_review=include_match_review,
    )
    combined_settings = dict(settings or {})
    try:
        configured_timeout = float(combined_settings.get("timeout") or 30)
    except (TypeError, ValueError):
        configured_timeout = 30
    combined_settings["timeout"] = max(60, configured_timeout)
    combined_settings["_disable_empty_retry"] = True

    compact_files = _compact_llm_files(files, max_headers=64, sample_columns=32, sample_values=2)
    slim_payload = _build_combined_fa_list_payload(
        tool_name=tool_name,
        role_definitions=role_definitions,
        files=compact_files,
        current_mapping=current_mapping,
        current_match=current_match,
        local_profile=local_profile,
        candidate_profiles=candidate_profiles or [],
        include_match_review=include_match_review,
        mapping_extra_instructions=mapping_extra_instructions,
        review_extra_instructions=review_extra_instructions,
        match_extra_instructions=match_extra_instructions,
        forbidden_columns=forbidden_columns,
    )
    messages = _combined_fa_list_messages(slim_payload)
    raw_text = ""
    repair_used = False
    try:
        raw_text = _chat_completion(
            combined_settings,
            messages,
            max_tokens=1600,
            json_response=True,
            task_name="fa_combined_assist",
        )
        raw = _extract_json(raw_text)
        return _normalize_combined_fa_list_result(
            raw,
            files=files,
            current_mapping=current_mapping,
            current_match=current_match,
            local_profile=local_profile,
            candidate_profiles=candidate_profiles or [],
            include_match_review=include_match_review,
            repair_used=repair_used,
        )
    except Exception as initial_exc:
        if not raw_text:
            raise LLMClientError(f"合并辅助判断失败：{initial_exc}") from initial_exc
        try:
            raw = _repair_combined_fa_list_json(combined_settings, raw_text)
            repair_used = True
            return _normalize_combined_fa_list_result(
                raw,
                files=files,
                current_mapping=current_mapping,
                current_match=current_match,
                local_profile=local_profile,
                candidate_profiles=candidate_profiles or [],
                include_match_review=include_match_review,
                repair_used=repair_used,
            )
        except Exception as repair_exc:
            raise LLMClientError(f"合并辅助判断失败：{initial_exc}；修复重试失败：{repair_exc}") from initial_exc


def _build_combined_fa_list_payload(
    *,
    tool_name: str,
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]],
    include_match_review: bool,
    mapping_extra_instructions: str,
    review_extra_instructions: str,
    match_extra_instructions: str,
    forbidden_columns: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    fb_raw = forbidden_columns or {}
    forbidden_normalized = {
        "file1": [str(c) for c in (fb_raw.get("file1") or []) if str(c).strip()],
        "file2": [str(c) for c in (fb_raw.get("file2") or []) if str(c).strip()],
    }
    slim_files = _slim_combined_files(files, current_mapping, current_match, candidate_profiles)
    blind_field_view = _build_blind_field_view(slim_files, current_mapping)
    blind_match_view = _build_blind_match_view(slim_files, current_match)
    return {
        "task": "Combined FA List LLM assistance",
        "subtasks": [
            "A mapping suggestions for unmapped roles only",
            "B independently infer field roles from data shape, then review current field mappings for wrong columns",
            "C review match key columns" if include_match_review else "C skipped because current match was already reviewed",
        ],
        "rules": [
            "Return strict JSON only. No markdown, no explanation.",
            "Never output null. Use empty arrays, empty strings, keep, or unknown_reason instead.",
            "Use exact supplied headers only. If no exact supplied header exists, use empty string or keep.",
            "Prefer precision over coverage. Small valid output is better than broad guesses.",
            "For field_review, use data.blind_field_files as the primary evidence. First choose anonymous column ids by samples/profiles only, then use data.field_header_lookup only to translate the chosen ids back to real headers.",
            "For field_review, do not decide from real header text or current_mapping first. Treat current_mapping as a script guess; it is only compared after the blind role choice is complete.",
            "Operationally: first classify relevant columns from blind_field_files, then compare the blind classification with current_mapping.",
            "In short: current_mapping as a script guess, not ground truth.",
            "Header names may be renamed, duplicated, or misleading；列名只作参考。When header meaning conflicts with values/profile, trust values/profile.",
            "Review fields as a group. If category/name/code/date/value roles are shifted or swapped, return separate field_review records for every affected role instead of a partial single-field fix.",
            "For category, prefer columns whose values are short Chinese category names with low unique_count. Reject code-like values and long/high-cardinality asset descriptions even if the header sounds category-like.",
            "Hard validation for field_review suggestions: a suggested category column must not have looks_like_code_ratio >= 0.5; a suggested name column must not have unique_count <= 50 with cjk_short_name_ratio >= 0.8. If current_mapping already satisfies these role-shape checks, omit field_review for that role.",
            "For category/name conflicts, never leave both roles mapped to the same column on the same file_side. If category should move to a column currently used by name, also return a field_review record for name pointing to the long/high-cardinality asset-description column.",
            "Do not flag life years vs months or residual value vs residual rate; the app converts those later.",
            "For match key review, use data.blind_match_files as the primary evidence. First infer the best match key from anonymous column values/profiles, then compare with data.current_match_blind and current_match.",
            "For match_review, current_match/local_profile/candidate_profiles are script/reference data only after the blind key choice; do not let them choose the key first.",
            "For match_review, also fill suggested_file1_ids/suggested_file2_ids when a suggested column exists. Use data.match_header_lookup only to translate ids back to real headers.",
            "禁列优先：match_review �?suggested_file1_columns/suggested_file2_columns 不能包含 data.forbidden_columns.file1/file2 中的任何列；这些列是脚本动态识别的会变动业务字段（折旧/原�?类别/寿命/日期等）。资产名称已被脚本作为例外排除，可保留为辅助键。",
            "两侧列数必须相等：match_review �?suggested_file1_columns �?suggested_file2_columns 的长度必须完全一致；如禁列剔除后无法等长，返�?status=ok、action=keep。",
            "数据驱动候选优先：�?candidate_profiles 中存�?group='data_driven_id' 的候选，只有�?current_match 未包含该候选的核心 ID 列、或 current_match 明显使用了非 ID 主列时，才返�?replace。若 current_match 已包含该数据驱动 ID 列，并额外包含合法的 name 辅助列且 duplicate_row_count/unique_rate 不差于单列候选，�?keep current_match，不要降级为单列。",
            "Return at most 2 mapping records, at most 3 field_review records, and exactly 1 match_review record when C is enabled.",
            "If a subtask has no issue, omit mapping/field_review records; for match_review return a keep record.",
            "Keep each reason under 18 Chinese characters.",
            "records must be a non-empty array.",
        ],
        "few_shot_output": {
            "records": [
                {
                    "task": "mapping",
                    "role": "current_year_dep",
                    "file_side": "file2",
                    "suggested_column": "本年折旧",
                    "confidence": 0.86,
                    "action": "fill",
                    "reason": "本年折旧误作累计折旧",
                    "review_warning": "",
                },
                {
                    "task": "field_review",
                    "issue_field": "category",
                    "issue_type": "wrong_column",
                    "current_file1": "固定资产类别",
                    "current_file2": "类别描述",
                    "suggested_file1": "",
                    "suggested_file2": "资产描述",
                    "confidence": 0.9,
                    "action": "review",
                    "reason": "当前列为长描述",
                    "auto_apply": False,
                },
                {
                    "task": "field_review",
                    "issue_field": "name",
                    "issue_type": "wrong_column",
                    "current_file1": "固定资产名称",
                    "current_file2": "资产描述",
                    "suggested_file1": "",
                    "suggested_file2": "项目说明",
                    "confidence": 0.88,
                    "action": "review",
                    "reason": "当前列为类别",
                    "auto_apply": False,
                },
                {
                    "task": "match_review",
                    "status": "ok",
                    "confidence": 0.82,
                    "action": "keep",
                    "reasons": ["当前编码列可匹配"],
                    "suggested_file1_columns": ["固定资产编码"],
                    "suggested_file2_columns": ["资产编码"],
                    "suggestion_reason": "继续使用当前匹配键",
                },
            ]
        },
        "data": {
            "tool_name": tool_name,
            "files": slim_files,
            "blind_field_files": blind_field_view["files"],
            "field_header_lookup": blind_field_view["header_lookup"],
            "blind_match_files": blind_match_view["files"],
            "match_header_lookup": blind_match_view["header_lookup"],
            "current_match_blind": blind_match_view["current_match"],
            "current_mapping_blind": blind_field_view["current_mapping"],
            "current_mapping": current_mapping,
            "current_match": current_match,
            "local_profile": _trim_combined_local_profile(local_profile),
            "candidate_profiles": [_trim_combined_candidate(item) for item in (candidate_profiles or [])[:5]],
            "missing_roles": _unmapped_role_requests(role_definitions, current_mapping),
            "include_match_review": include_match_review,
            "forbidden_columns": forbidden_normalized,
            "extra_instructions": {
                "mapping": mapping_extra_instructions,
                "field_review": review_extra_instructions,
                "match_review": match_extra_instructions,
            },
            "notes": [
                "files only include relevant columns, samples, and column_profiles; do not ask for omitted full headers.",
                "For mapping, only consider missing_roles. It is acceptable to return no mapping records.",
                "For field_review, perform blind role classification from blind_field_files before reading current_mapping or real headers. Use samples/column_profiles to distinguish short category names, code columns, long asset descriptions, dates, values, and depreciation fields.",
                "For every field_review record, also fill suggested_file1_id/suggested_file2_id when a suggested column exists. The id must come from blind_field_files for that same file_side.",
                "For match_review, perform blind match-key selection from blind_match_files before reading current_match, local_profile, candidate_profiles, forbidden_columns, or real headers.",
                "For match_review, include suggested_file1_ids/suggested_file2_ids from blind_match_files when a suggested key exists.",
            ],
        },
    }


def _combined_fa_list_messages(payload: dict[str, Any]) -> list[dict[str, str]]:
    system = (
        "Output one JSON object: {\"records\":[...]}. Each record is independent and flat. "
        "Use task='mapping' or task='field_review' or task='match_review'. "
        "No nested objects except reasons/suggested_file1_columns/suggested_file2_columns arrays. "
        "Never output null. Use Chinese for reasons. Return JSON only."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))},
    ]


def _slim_combined_files(
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    candidate_profiles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    needed_by_side: dict[str, set[str]] = {"file1": set(), "file2": set(), "main": set()}
    for mapping in (current_mapping or {}).values():
        if not isinstance(mapping, dict):
            continue
        for side in ("file1", "file2", "main"):
            raw = mapping.get(side)
            if isinstance(raw, (list, tuple, set)):
                needed_by_side[side].update(str(item).strip() for item in raw if str(item).strip())
            elif str(raw or "").strip():
                needed_by_side[side].add(str(raw).strip())
    for side, cols in (current_match or {}).items():
        if side in needed_by_side and isinstance(cols, list):
            needed_by_side[side].update(str(item).strip() for item in cols if str(item).strip())
    for candidate in candidate_profiles or []:
        if not isinstance(candidate, dict):
            continue
        for side, key in (("file1", "file1_columns"), ("file2", "file2_columns")):
            needed_by_side[side].update(str(item).strip() for item in candidate.get(key, []) if str(item).strip())

    category_hints = ("类别", "类型", "分类", "描述")
    business_hints = ("??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "ID")
    slim_files = []
    for file_info in files or []:
        side = str(file_info.get("file_side") or "").strip()
        headers = [str(header).strip() for header in (file_info.get("headers") or []) if str(header).strip()]
        picked: list[str] = []
        for header in headers:
            if (
                header in needed_by_side.get(side, set())
                or any(hint in header for hint in category_hints)
                or any(hint in header for hint in business_hints)
            ):
                picked.append(header)
            if len(picked) >= 28:
                break
        samples = file_info.get("samples") if isinstance(file_info.get("samples"), dict) else {}
        raw_profiles = file_info.get("column_profiles") if isinstance(file_info.get("column_profiles"), dict) else {}
        slim_files.append(
            {
                "file_side": side,
                "headers": picked,
                "samples": {header: list(samples.get(header, []))[:2] for header in picked[:18]},
                "column_profiles": _compact_column_profiles(picked, samples, raw_profiles, max_columns=18),
            }
        )
    return slim_files


def _build_blind_field_view(files: list[dict[str, Any]], current_mapping: dict[str, Any]) -> dict[str, Any]:
    """Build an independent column view for field-role review."""
    blind_files: list[dict[str, Any]] = []
    header_lookup: dict[str, dict[str, str]] = {}
    reverse_lookup: dict[str, dict[str, str]] = {}
    for file_info in files or []:
        side = str(file_info.get("file_side") or "").strip()
        headers = [str(header).strip() for header in (file_info.get("headers") or []) if str(header).strip()]
        samples = file_info.get("samples") if isinstance(file_info.get("samples"), dict) else {}
        profiles = file_info.get("column_profiles") if isinstance(file_info.get("column_profiles"), dict) else {}
        side_lookup: dict[str, str] = {}
        side_reverse: dict[str, str] = {}
        columns: list[dict[str, Any]] = []
        prefix = "file1" if side == "file1" else "file2" if side == "file2" else side or "file"
        for index, header in enumerate(headers, start=1):
            col_id = f"{prefix}_col_{index}"
            side_lookup[col_id] = header
            side_reverse[header] = col_id
            columns.append(
                {
                    "id": col_id,
                    "header": header,
                    "samples": list(samples.get(header, []))[:3],
                    "column_profiles": profiles.get(header, {}),
                }
            )
        if side:
            header_lookup[side] = side_lookup
            reverse_lookup[side] = side_reverse
        blind_files.append({"file_side": side, "columns": columns})

    blind_current: dict[str, dict[str, str]] = {}
    for role, mapping in (current_mapping or {}).items():
        if not isinstance(mapping, dict):
            continue
        role_map: dict[str, str] = {}
        for side in ("file1", "file2", "main"):
            header = str(mapping.get(side) or "").strip()
            if header:
                role_map[side] = reverse_lookup.get(side, {}).get(header, "")
        if role_map:
            blind_current[str(role)] = role_map

    return {"files": blind_files, "header_lookup": header_lookup, "current_mapping": blind_current}


def _translate_blind_mapping_review_ids(raw: Any, header_lookup: dict[str, dict[str, str]]) -> Any:
    """Prefer anonymous column ids over model-written header text when present."""
    if isinstance(raw, dict):
        items = raw.get("mapping_review")
        if items is None:
            items = raw.get("issues")
        if items is None:
            items = raw.get("suggestions")
    else:
        items = raw
    if not isinstance(items, list):
        return raw
    for item in items:
        if not isinstance(item, dict):
            continue
        ids = item.get("suggested_mapping_ids")
        if ids is None:
            ids = item.get("suggested_ids")
        if not isinstance(ids, dict):
            continue
        suggested = item.get("suggested_mapping")
        if not isinstance(suggested, dict):
            suggested = {}
        for side in ("file1", "file2", "main"):
            col_id = str(ids.get(side) or "").strip()
            if col_id:
                header = header_lookup.get(side, {}).get(col_id, "")
                if header:
                    suggested[side] = header
        item["suggested_mapping"] = suggested
    return raw



def _build_blind_match_view(files: list[dict[str, Any]], current_match: dict[str, Any]) -> dict[str, Any]:
    """Build an anonymized column view for independent match-key review."""
    blind_files: list[dict[str, Any]] = []
    header_lookup: dict[str, dict[str, str]] = {}
    reverse_lookup: dict[str, dict[str, str]] = {}
    for file_info in files or []:
        side = str(file_info.get("file_side") or "").strip()
        headers = [str(header).strip() for header in (file_info.get("headers") or []) if str(header).strip()]
        samples = file_info.get("samples") if isinstance(file_info.get("samples"), dict) else {}
        profiles = file_info.get("column_profiles") if isinstance(file_info.get("column_profiles"), dict) else {}
        side_lookup: dict[str, str] = {}
        side_reverse: dict[str, str] = {}
        columns: list[dict[str, Any]] = []
        prefix = "file1" if side == "file1" else "file2" if side == "file2" else side or "file"
        for index, header in enumerate(headers, start=1):
            col_id = f"{prefix}_col_{index}"
            side_lookup[col_id] = header
            side_reverse[header] = col_id
            columns.append(
                {
                    "id": col_id,
                    "header": header,
                    "samples": list(samples.get(header, []))[:3],
                    "column_profiles": profiles.get(header, {}),
                }
            )
        if side:
            header_lookup[side] = side_lookup
            reverse_lookup[side] = side_reverse
        blind_files.append({"file_side": side, "columns": columns})

    blind_current: dict[str, list[str]] = {}
    for side in ("file1", "file2"):
        ids = []
        current_cols = (current_match or {}).get(side, []) if isinstance(current_match, dict) else []
        for header in current_cols:
            col_id = reverse_lookup.get(side, {}).get(str(header).strip(), "")
            if col_id:
                ids.append(col_id)
        blind_current[side] = ids
    return {"files": blind_files, "header_lookup": header_lookup, "current_match": blind_current}


def _translate_blind_match_review_ids(raw: Any, header_lookup: dict[str, dict[str, str]]) -> Any:
    """Prefer anonymous match column ids over model-written header text when present."""
    if not isinstance(raw, dict):
        return raw

    def _ids_to_headers(side: str, value: Any) -> list[str]:
        if isinstance(value, str):
            ids = [value] if value.strip() else []
        elif isinstance(value, (list, tuple)):
            ids = [str(item).strip() for item in value if str(item).strip()]
        else:
            ids = []
        return [header_lookup.get(side, {}).get(col_id, "") for col_id in ids if header_lookup.get(side, {}).get(col_id, "")]

    file1_headers = _ids_to_headers("file1", raw.get("suggested_file1_ids") or raw.get("suggested_file1_col_ids"))
    file2_headers = _ids_to_headers("file2", raw.get("suggested_file2_ids") or raw.get("suggested_file2_col_ids"))
    if file1_headers:
        raw["suggested_file1_columns"] = file1_headers
    if file2_headers:
        raw["suggested_file2_columns"] = file2_headers
    return raw
def _trim_combined_local_profile(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        side: _trim_combined_profile(item)
        for side, item in (profile or {}).items()
        if side in {"file1", "file2"} and isinstance(item, dict)
    }


def _trim_combined_profile(profile: dict[str, Any]) -> dict[str, Any]:
    keep = {
        "columns",
        "row_count",
        "valid_count",
        "blank_count",
        "unique_count",
        "unique_rate",
        "duplicate_key_count",
        "duplicate_row_count",
        "duplicate_examples",
    }
    out = {key: profile.get(key) for key in keep if key in profile}
    if isinstance(out.get("duplicate_examples"), list):
        out["duplicate_examples"] = out["duplicate_examples"][:2]
    return out


def _trim_combined_candidate(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "group": item.get("group", ""),
        "file1_columns": item.get("file1_columns", []),
        "file2_columns": item.get("file2_columns", []),
        "file1_dup": (item.get("file1") or {}).get("duplicate_row_count", 0),
        "file2_dup": (item.get("file2") or {}).get("duplicate_row_count", 0),
        "file1_unique": (item.get("file1") or {}).get("unique_rate", 0),
        "file2_unique": (item.get("file2") or {}).get("unique_rate", 0),
    }


def _normalize_combined_fa_list_result(
    raw: Any,
    *,
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    current_match: dict[str, Any],
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]],
    include_match_review: bool,
    repair_used: bool,
) -> LLMCombinedFAListResult:
    if not isinstance(raw, dict):
        raise LLMClientError("合并辅助判断没有返回 JSON 对象。")
    if not _json_has_no_nulls(raw):
        raise LLMClientError("合并辅助判断返回了 null 字段。")
    records = raw.get("records")
    if not isinstance(records, list) or not records:
        raise LLMClientError("合并辅助判断 records 为空。")

    suggestion_items: list[dict[str, Any]] = []
    review_items: list[dict[str, Any]] = []
    match_item: dict[str, Any] | None = None
    slim_files_for_blind = _slim_combined_files(files, current_mapping, current_match, candidate_profiles)
    blind_lookup = _build_blind_field_view(
        slim_files_for_blind,
        current_mapping,
    ).get("header_lookup", {})
    blind_match_lookup = _build_blind_match_view(
        slim_files_for_blind,
        current_match,
    ).get("header_lookup", {})
    for item in records:
        if not isinstance(item, dict):
            continue
        task = str(item.get("task") or "").strip()
        if task == "mapping":
            suggestion_items.append(
                {
                    "role": item.get("role", ""),
                    "file_side": item.get("file_side", ""),
                    "suggested_column": item.get("suggested_column", ""),
                    "confidence": item.get("confidence", 0),
                    "action": item.get("action", ""),
                    "reason": item.get("reason", ""),
                    "review_warning": item.get("review_warning", ""),
                }
            )
        elif task == "field_review":
            suggested_file1 = str(item.get("suggested_file1") or "").strip()
            suggested_file2 = str(item.get("suggested_file2") or "").strip()
            suggested_file1_id = str(item.get("suggested_file1_id") or item.get("suggested_file1_col_id") or "").strip()
            suggested_file2_id = str(item.get("suggested_file2_id") or item.get("suggested_file2_col_id") or "").strip()
            if suggested_file1_id:
                suggested_file1 = blind_lookup.get("file1", {}).get(suggested_file1_id, suggested_file1)
            if suggested_file2_id:
                suggested_file2 = blind_lookup.get("file2", {}).get(suggested_file2_id, suggested_file2)
            review_items.append(
                {
                    "issue_field": item.get("issue_field", ""),
                    "issue_type": item.get("issue_type", ""),
                    "current_mapping": {"file1": item.get("current_file1", ""), "file2": item.get("current_file2", "")},
                    "suggested_mapping": {"file1": suggested_file1, "file2": suggested_file2},
                    "confidence": item.get("confidence", 0),
                    "reason": item.get("reason", ""),
                    "auto_apply": bool(item.get("auto_apply")),
                }
            )
        elif task == "match_review":
            match_item = item

    suggestions = [_normalize_suggestion(item) for item in suggestion_items]
    missing_roles = _unmapped_role_requests(_default_fa_list_role_definitions(), current_mapping)
    _promote_valid_missing_role_fills(suggestions, missing_roles=missing_roles, files=files)
    suggestions.extend(_fallback_unmapped_field_suggestions(_default_fa_list_role_definitions(), files, current_mapping, suggestions))
    fa_review = normalize_fa_list_mapping_review(
        {"mapping_review": review_items},
        files=files,
        current_mapping=current_mapping,
    )
    match_review = None
    if include_match_review:
        if not isinstance(match_item, dict):
            raise LLMClientError("合并辅助判断缺少 match_review 记录。")
        match_item = _translate_blind_match_review_ids(match_item, blind_match_lookup)
        match_review = _normalize_match_key_review(match_item, files=files)
        if _match_review_needs_candidate_retry(match_review, local_profile, candidate_profiles):
            retry_review = _retry_match_candidate_choice(
                {},
                current_match=current_match,
                local_profile=local_profile,
                candidate_profiles=candidate_profiles or [],
            )
            if retry_review is not None:
                match_review = retry_review
    return LLMCombinedFAListResult(
        suggestions=suggestions,
        fa_review=fa_review,
        match_review=match_review,
        repair_used=repair_used,
    )


def _json_has_no_nulls(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return all(_json_has_no_nulls(item) for item in value.values())
    if isinstance(value, list):
        return all(_json_has_no_nulls(item) for item in value)
    return True


def _repair_combined_fa_list_json(settings: dict[str, Any], raw_text: str) -> Any:
    repair_messages = [
        {
            "role": "system",
            "content": (
                "Convert the user's response into strict JSON only. Do not add facts. "
                "Never output null. Keep shape {\"records\":[...]}. "
                "If unusable, return {\"records\":[{\"task\":\"match_review\","
                "\"status\":\"warning\",\"confidence\":0,\"action\":\"review\","
                "\"reasons\":[\"unknown_reason\"],\"suggested_file1_columns\":[],"
                "\"suggested_file2_columns\":[],\"suggestion_reason\":\"unknown_reason\"}]}."
            ),
        },
        {"role": "user", "content": raw_text[:6000]},
    ]
    content = _chat_completion(settings, repair_messages, max_tokens=900, json_response=True, task_name="fa_combined_repair")
    return _extract_json(content)


def generate_suite_analysis(settings: dict[str, Any], *, tool_name: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Generate workbook analysis for exported audit suites."""
    messages = [
        {
            "role": "system",
            "content": (
                "你是审计工具箱中的套表分析助手。只基于用户提供的汇总、透视和候选异常数据写分析。"
                "不要编造未提供的数据，不要提出抽凭、查验合同、查看验收单等审计程序建议。"
                "???????????????????????? analysis_payload.candidates ????? JSON ???"
                "不得自行推断、补充或改写未在候选中列出的对方科目、金额、覆盖率或凭证号。"
                "???? JSON?????"
                '{"title":"...","sections":[{"heading":"...","points":["..."]}],'
                '"review_notes":["..."]}?'
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "tool_name": tool_name,
                    "analysis_payload": payload,
                    "output_rules": [
                        "使用中文，语气为审计底稿辅助说明。",
                        "只覆�?payload �?requested_scope 列出的分析范围。",
                        "每个 points 项控制在 80 个中文字符以内。",
                        "如候选数据为空，应说明未从已提供候选中发现该类提示。",
                        "科目发生额概览必须引�?analysis_payload.candidates.科目发生额概�?中的 total_debit_amount、total_credit_amount、total_net_amount；该金额为全部目标科目口径，不受Top 80%分析范围限制。",
                        "对方科目与凭证类型分析必须只引用 analysis_payload.candidates.对方科目与凭证类型合并分�?中的 JSON 数据。",
                        "Top 80%限制仅用于对方科目解释和月度趋势聚焦，不用于科目发生额概览金额。",
                        "对方科目分析的目标科目范围已按金额绝对值累计覆盖前80%筛选；不得分析未进�?target_account_scope.selected_accounts 的小额普通科目。",
                        "只用自然语言说明：目标科目借方发生额主要对应前几大哪些对方科目及金额；目标科目贷方发生额主要对应前几大哪些对方科目及金额。",
                        "借方/贷方两个方向均按 main_counterparties 中累计覆�?0%-120%的前几大科目说明；如有多项必须都写出，不要只写最大一项。",
                        "对方科目与凭证类型合并分析章节最多输出两到三点：借方主要对方、贷方主要对方；不要写小额科目排除说明。",
                        "金额较大时同时写亿元和万元，例如“约4.78亿元�?7,804.01万元）”，避免单位误读。",
                        "不要生成单独的对方科目组合章节。",
                        "不得自行推断未在 candidates 中列出的对方科目、金额或覆盖率。",
                        "如引用凭证号或唯一识别码，必须完整照抄 candidates 中的完整文本，不得用省略号、前后缀或简写。",
                        "月度波动趋势分析只引�?analysis_payload.candidates.透视分析月度波动趋势分析.items 中的TOP80项目；未进入items的其他费用或项目不要分析。",
                        "只描述发生额、组合、异常现象和可能关注原因，不写审计动作。",
                        "不要使用“建议核对、需核实、需确认、查验、抽查、检查、获取、追溯”等程序性表述。",
                        "review_notes 只保留通用辅助说明，不要使用“重点关注”等审计动作导向措辞。",
                        "结尾提醒：LLM 输出为辅助说明，需结合原始数据人工复核。",
                    ],
                },
                ensure_ascii=False,
            ),
        },
    ]
    content = _chat_completion(settings, messages, max_tokens=2200, json_response=True, task_name="suite_analysis")
    try:
        raw = _extract_suite_json_with_repair(settings, content)
    except LLMClientError as exc:
        raise LLMClientError(f"{exc} 原始返回摘要：{_content_excerpt(content)}") from exc
    if not isinstance(raw, dict):
        raise LLMClientError(f"模型没有返回分析 JSON 对象。原始返回摘要：{_content_excerpt(content)}")
    return _normalize_suite_analysis(raw)


def _chat_completion(
    settings: dict[str, Any],
    messages: list[dict[str, str]],
    max_tokens: int,
    *,
    json_response: bool = False,
    _empty_retry: bool = False,
    task_name: str = "",
) -> str:
    call_id = uuid.uuid4().hex[:10]
    started = time.perf_counter()
    base_url = str(settings.get("base_url") or "").strip().rstrip("/")
    api_key = str(settings.get("api_key") or "").strip()
    model = str(settings.get("model") or "").strip()
    timeout = float(settings.get("timeout") or 30)
    if not base_url or not api_key or not model:
        raise LLMClientError("请先填写 Base URL、模型和 API Key。")

    url = base_url
    if not url.endswith("/chat/completions"):
        url = f"{url}/chat/completions"

    # Do not send max_tokens: some reasoning models can spend the budget before emitting JSON.
    # The caller max_tokens value is kept for logging only.
    # DeepSeek thinking mode is disabled by default for structured JSON tasks.
    thinking_on = bool(settings.get("thinking_enabled"))
    request_body = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "thinking": {"type": "enabled" if thinking_on else "disabled"},
    }
    if json_response:
        request_body["response_format"] = {"type": "json_object"}
    _write_llm_log(
        "chat_start",
        call_id=call_id,
        base_url=_redact_base_url(base_url),
        model=model,
        timeout=timeout,
        max_tokens_param=max_tokens,
        task_name=task_name,
        json_response=json_response,
        empty_retry=_empty_retry,
        message_count=len(messages),
        input_chars=sum(len(str(item.get("content") or "")) for item in messages),
    )
    body = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        _write_llm_log(
            "chat_http_error",
            call_id=call_id,
            task_name=task_name,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            status=exc.code,
            detail=_content_excerpt(detail, 240),
        )
        if json_response and _looks_like_response_format_error(detail):
            return _chat_completion(settings, messages, max_tokens, json_response=False, task_name=task_name)
        raise LLMClientError(f"HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        _write_llm_log(
            "chat_url_error",
            call_id=call_id,
            task_name=task_name,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            reason=str(exc.reason),
        )
        raise LLMClientError(str(exc.reason)) from exc
    except (TimeoutError, socket.timeout) as exc:
        _write_llm_log(
            "chat_timeout",
            call_id=call_id,
            task_name=task_name,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
            timeout=timeout,
        )
        raise LLMClientError("请求超时。") from exc

    try:
        choice = data["choices"][0]
        message = choice.get("message") if isinstance(choice, dict) else None
        content = _extract_chat_message_text(choice, content_only=json_response).strip()
        finish_reason = str(choice.get("finish_reason") or "") if isinstance(choice, dict) else ""
        message_keys = sorted(str(k) for k in (message or {}).keys()) if isinstance(message, dict) else []
    except (KeyError, IndexError, TypeError) as exc:
        _write_llm_log(
            "chat_bad_response",
            call_id=call_id,
            task_name=task_name,
            elapsed_ms=int((time.perf_counter() - started) * 1000),
        )
        raise LLMClientError("模型响应格式不正确。") from exc
    _write_llm_log(
        "chat_done",
        call_id=call_id,
        task_name=task_name,
        elapsed_ms=int((time.perf_counter() - started) * 1000),
        json_response=json_response,
        empty_retry=_empty_retry,
        finish_reason=finish_reason,
        message_keys=message_keys,
        content_chars=len(content),
    )
    disable_empty_retry = bool(settings.get("_disable_empty_retry"))
    if not content and json_response and not disable_empty_retry:
        return _chat_completion(settings, messages, max_tokens, json_response=False, task_name=task_name)
    if not content and not _empty_retry and not disable_empty_retry:
        retry_messages = list(messages) + [
            {
                "role": "user",
                "content": (
                    "The previous response was empty. Return the requested final answer now. "
                    "If the task asks for JSON, return strict JSON only with no markdown or explanation."
                ),
            }
        ]
        return _chat_completion(settings, retry_messages, max_tokens, json_response=False, _empty_retry=True, task_name=task_name)
    if not content:
        detail = f"finish_reason={finish_reason or 'unknown'}"
        if message_keys:
            detail += f"，message字段={','.join(message_keys)}"
        raise LLMClientError(
            "模型服务已响应，但未�?chat message.content 中返回正文；"
            "已尝试关�?JSON 模式并重试仍为空。"
            f"这通常是模�?网关返回格式不兼容或当前模型不适合 JSON 对话输出，不�?API Key 错误。{detail}"
        )
    return content


def _write_llm_log(event: str, **payload: Any) -> None:
    try:
        path = _llm_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"event": event, "timestamp_ms": int(time.time() * 1000), **payload}
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as exc:
        try:
            from debug_logger import _write as _dbg
            _dbg(
                sessionId="debug",
                runId="run1",
                hypothesisId="LLM",
                location="llm_client._write_llm_log",
                message="llm log write failed",
                data={"event": event, "error": str(exc)},
            )
        except Exception:
            pass


def _llm_log_path() -> Path:
    base = os.environ.get("APPDATA")
    if base:
        return Path(base) / "AuditToolbox" / "llm_calls.jsonl"
    return Path.home() / ".audit_toolbox" / "llm_calls.jsonl"


def _redact_base_url(base_url: str) -> str:
    if not base_url:
        return ""
    return re.sub(r"(?<=://)[^/@]+@", "***@", base_url)


def _extract_chat_message_text(choice: dict[str, Any], *, content_only: bool = False) -> str:
    if not isinstance(choice, dict):
        return ""
    message = choice.get("message")
    if isinstance(message, dict):
        if content_only:
            return _content_value_to_text(message.get("content"))
        for key in ("content", "reasoning_content", "reasoning", "text"):
            text = _content_value_to_text(message.get(key))
            if text:
                return text
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            return json.dumps({"tool_calls": tool_calls}, ensure_ascii=False)
    return _content_value_to_text(choice.get("text"))


def _content_value_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "\n".join(part.strip() for part in parts if part and part.strip()).strip()
    if isinstance(value, dict):
        for key in ("text", "content", "output_text"):
            if isinstance(value.get(key), str):
                return value[key].strip()
    return ""


def _extract_json(content: str) -> Any:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError as exc:
                raise LLMClientError("模型没有返回可解析的 JSON。") from exc
        raise LLMClientError("模型没有返回可解析的 JSON。")


def _extract_json_with_repair(settings: dict[str, Any], content: str) -> Any:
    try:
        return _extract_json(content)
    except LLMClientError:
        repair_messages = [
            {
                "role": "system",
                "content": (
                    "Convert the user's mapping response into strict JSON only. "
                    "Keep only this shape: "
                    '{"suggestions":[{"role":"...","file_side":"file1|file2|main",'
                    '"suggested_column":"...","confidence":0.0,'
                    '"action":"fill|review","reason":"...","review_warning":"..."}]}. '
                    "Keep at most 8 actionable fill/review items. Do not explain."
                ),
            },
            {"role": "user", "content": content[:6000]},
        ]
        repaired = _chat_completion(settings, repair_messages, max_tokens=1600, json_response=True, task_name="mapping_repair")
        return _extract_json(repaired)


def _extract_suite_json_with_repair(settings: dict[str, Any], content: str) -> Any:
    try:
        return _extract_json(content)
    except LLMClientError as initial_exc:
        repair_messages = [
            {
                "role": "system",
                "content": (
                    "Convert the user's audit suite analysis response into strict JSON only. "
                    "Keep only this shape: "
                    '{"title":"...","sections":[{"heading":"...","points":["..."]}],'
                    '"review_notes":["..."]}. '
                    "sections must be an array. points and review_notes must be arrays of strings. "
                    "Do not add markdown, explanation, code fences, or any text outside JSON."
                ),
            },
            {"role": "user", "content": content[:8000]},
        ]
        try:
            repaired = _chat_completion(settings, repair_messages, max_tokens=1800, json_response=True, task_name="suite_analysis_repair")
            return _extract_json(repaired)
        except LLMClientError as repair_exc:
            raise LLMClientError(f"模型没有返回可解析的 JSON，修复重试也失败：{repair_exc}") from initial_exc


def _extract_fa_mapping_review_json_with_repair(settings: dict[str, Any], content: str) -> Any:
    try:
        return _extract_json(content)
    except LLMClientError:
        repair_messages = [
            {
                "role": "system",
                "content": (
                    "Convert the user's FA List mapping review response into strict JSON only. "
                    "Keep only this shape: "
                    '{"mapping_review":[{"issue_field":"...","issue_type":"...",'
                    '"current_mapping":{"file1":"...","file2":"..."},'
                    '"suggested_mapping":{"file1":"...","file2":"..."},'
                    '"confidence":0.0,"reason":"...","auto_apply":false}]}. '
                    "Keep at most 3 issues. If the response is incomplete or unusable, return {\"mapping_review\":[]}. "
                    "Do not explain."
                ),
            },
            {"role": "user", "content": content[:6000]},
        ]
        try:
            repaired = _chat_completion(settings, repair_messages, max_tokens=900, json_response=True, task_name="fa_review_repair")
            return _extract_json(repaired)
        except LLMClientError:
            return {"mapping_review": []}


def _extract_match_key_json_with_repair(settings: dict[str, Any], content: str) -> Any:
    try:
        return _extract_json(content)
    except LLMClientError as initial_exc:
        repair_messages = [
            {
                "role": "system",
                "content": (
                    "Convert the user's fixed asset matching-key review into strict JSON only. "
                    "Keep only this shape: "
                    '{"status":"ok|warning|bad","confidence":0.0,"action":"keep|replace|review",'
                    '"reasons":["..."],"suggested_file1_columns":["..."],'
                    '"suggested_file2_columns":["..."],"suggestion_reason":"..."}. '
                    "Do not add markdown or explanation."
                ),
            },
            {"role": "user", "content": content[:6000]},
        ]
        try:
            repaired = _chat_completion(settings, repair_messages, max_tokens=1100, json_response=True, task_name="match_review_repair")
            return _extract_json(repaired)
        except LLMClientError as repair_exc:
            raise LLMClientError(f"模型没有返回可解析的匹配列复�?JSON，修复重试也失败：{repair_exc}") from initial_exc


def _match_review_needs_candidate_retry(
    review: LLMMatchKeyReview,
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]] | None,
) -> bool:
    if not candidate_profiles:
        return False
    if review.action == "replace" and review.suggested_file1_columns and review.suggested_file2_columns:
        return False
    if _has_paired_primary_id_candidate(candidate_profiles):
        return True
    return _profile_has_key_risk(local_profile) and _best_improving_match_candidate(local_profile, candidate_profiles) is not None


def _has_paired_primary_id_candidate(candidate_profiles: list[dict[str, Any]] | None) -> bool:
    """True when builders surfaced a 'unify both sides on the same-name ID column' option.

    `build_match_key_candidate_profiles` tags such entries with group='paired_primary_id'.
    If one exists, the LLM should always replace �?even when both current keys are
    individually unique �?because file1 and file2 are pointing at different IDs.
    """
    for item in candidate_profiles or []:
        if isinstance(item, dict) and item.get("group") == "paired_primary_id":
            return True
    return False


def _profile_has_key_risk(profile: dict[str, Any]) -> bool:
    for side in ("file1", "file2"):
        item = profile.get(side, {}) if isinstance(profile, dict) else {}
        if int(item.get("duplicate_row_count") or 0) > 0 or int(item.get("blank_count") or 0) > 0:
            return True
    return False


def _retry_match_candidate_choice(
    settings: dict[str, Any],
    *,
    current_match: dict[str, Any],
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]],
) -> LLMMatchKeyReview | None:
    paired = next(
        (item for item in (candidate_profiles or []) if isinstance(item, dict) and item.get("group") == "paired_primary_id"),
        None,
    )
    if paired is not None:
        return LLMMatchKeyReview(
            status="bad",
            confidence=0.9,
            action="replace",
            reasons=["文件1与文件2当前匹配的是不同口径 ID 列；已改为两侧统一的同名 ID 列"],
            suggested_file1_columns=[str(col) for col in paired.get("file1_columns", []) if str(col).strip()],
            suggested_file2_columns=[str(col) for col in paired.get("file2_columns", []) if str(col).strip()],
            suggestion_reason="两侧统一为同名 ID 列以保持口径一致",
        )
    best = _best_improving_match_candidate(local_profile, candidate_profiles)
    if best is None:
        return None
    payload = {
        "current_match": current_match,
        "current_profile": local_profile,
        "candidate_profiles": [
            {
                "index": index,
                "file1_columns": item.get("file1_columns", []),
                "file2_columns": item.get("file2_columns", []),
                "file1_duplicate_rows": (item.get("file1") or {}).get("duplicate_row_count"),
                "file2_duplicate_rows": (item.get("file2") or {}).get("duplicate_row_count"),
                "file1_unique_rate": (item.get("file1") or {}).get("unique_rate"),
                "file2_unique_rate": (item.get("file2") or {}).get("unique_rate"),
            }
            for index, item in enumerate(candidate_profiles[:12])
        ],
        "output": "输出一个候选 index；如果不建议替换，输出 keep",
    }
    messages = [
        {
            "role": "system",
            "content": (
                "你只判断固定资产匹配列候选。不要解释。"
                "如果某候选相对 current_profile 明显减少重复行且不明显增加空值，输出该候选 index。"
                "否则只输出 keep。"
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    chosen = None
    try:
        content = _chat_completion(settings, messages, max_tokens=40, json_response=False, task_name="match_candidate_retry")
        match = re.search(r"\d+", str(content or ""))
        if match:
            index = int(match.group(0))
            if 0 <= index < len(candidate_profiles):
                chosen = candidate_profiles[index]
    except LLMClientError:
        chosen = None
    if chosen is None:
        chosen = best
    return LLMMatchKeyReview(
        status="warning",
        confidence=0.85,
        action="replace",
        reasons=["候选组合显著减少重复行"],
        suggested_file1_columns=[str(col) for col in chosen.get("file1_columns", []) if str(col).strip()],
        suggested_file2_columns=[str(col) for col in chosen.get("file2_columns", []) if str(col).strip()],
        suggestion_reason="候选组合唯一性更好",
    )


def _best_improving_match_candidate(
    local_profile: dict[str, Any],
    candidate_profiles: list[dict[str, Any]] | None,
) -> dict[str, Any] | None:
    if not candidate_profiles:
        return None
    current1 = local_profile.get("file1", {}) if isinstance(local_profile, dict) else {}
    current2 = local_profile.get("file2", {}) if isinstance(local_profile, dict) else {}
    current_dup1 = int(current1.get("duplicate_row_count") or 0)
    current_dup2 = int(current2.get("duplicate_row_count") or 0)
    current_blank1 = int(current1.get("blank_count") or 0)
    current_blank2 = int(current2.get("blank_count") or 0)
    best = None
    best_score = 0
    for item in candidate_profiles:
        p1 = item.get("file1") or {}
        p2 = item.get("file2") or {}
        dup1 = int(p1.get("duplicate_row_count") or 0)
        dup2 = int(p2.get("duplicate_row_count") or 0)
        blank1 = int(p1.get("blank_count") or 0)
        blank2 = int(p2.get("blank_count") or 0)
        if blank1 > current_blank1 + 5 or blank2 > current_blank2 + 5:
            continue
        if current_dup1 and dup1 >= current_dup1:
            continue
        if current_dup2 and dup2 >= current_dup2:
            continue
        score = max(0, current_dup1 - dup1) + max(0, current_dup2 - dup2)
        if score > best_score:
            best = item
            best_score = score
    return best if best_score > 0 else None


def _content_excerpt(content: str, limit: int = 420) -> str:
    text = re.sub(r"\s+", " ", str(content or "")).strip()
    if not text:
        return "空响应"
    return text[:limit] + ("..." if len(text) > limit else "")


def _looks_like_response_format_error(detail: str) -> bool:
    text = str(detail or "").lower()
    return "response_format" in text or "json_object" in text or "unsupported" in text


def _retry_compact_mapping(
    settings: dict[str, Any],
    *,
    tool_name: str,
    role_definitions: list[dict[str, Any]],
    files: list[dict[str, Any]],
    current_mapping: dict[str, Any],
    extra_instructions: str,
) -> Any:
    missing_roles = []
    for role_def in role_definitions:
        role = str(role_def.get("role") or "").strip()
        if role and not _mapping_role_has_value(current_mapping.get(role)):
            missing_roles.append(role_def)

    compact_files = []
    for file_info in files:
        samples = file_info.get("samples") if isinstance(file_info.get("samples"), dict) else {}
        compact_files.append(
            {
                "file_side": file_info.get("file_side", ""),
                "headers": file_info.get("headers", []),
                "samples": {
                    str(col): list(vals)[:3] if isinstance(vals, list) else vals
                    for col, vals in list(samples.items())[:40]
                },
            }
        )

    payload = {
        "tool_name": tool_name,
        "missing_roles_only": missing_roles,
        "files": compact_files,
        "current_mapping": current_mapping,
        "extra_instructions": extra_instructions,
        "output_shape": {
            "suggestions": [
                {
                    "role": "missing role id",
                    "file_side": "main|file1|file2",
                    "suggested_column": "one exact supplied header or empty",
                    "confidence": 0.0,
                    "action": "fill|none",
                    "reason": "short",
                    "review_warning": "",
                }
            ]
        },
    }
    messages = [
        {
            "role": "system",
            "content": (
                "You are retrying a failed spreadsheet field mapping response. "
                "Return one compact strict JSON object only. No markdown. No explanation. "
                "Only evaluate roles listed in missing_roles_only. "
                "suggested_column must exactly equal one supplied header, otherwise empty. "
                "Use action='fill' only when confident; otherwise action='none'."
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    content = _chat_completion(settings, messages, max_tokens=900, json_response=True, task_name="mapping_compact_retry")
    return _extract_json_with_repair(settings, content)


def _mapping_role_has_value(value: Any) -> bool:
    if isinstance(value, dict):
        return any(_mapping_role_has_value(item) for item in value.values())
    if isinstance(value, (list, tuple, set)):
        return any(str(item).strip() for item in value)
    return bool(str(value or "").strip())


def _default_fa_list_role_definitions() -> list[dict[str, str]]:
    roles = [
        ("match", "fixed asset id / card number"),
        ("original_value", "original value / asset cost"),
        ("depreciation", "accumulated depreciation"),
        ("category", "asset category"),
        ("name", "fixed asset name"),
        ("date", "capitalization or acquisition date"),
        ("life", "useful life in months or years"),
        ("residual", "residual rate"),
        ("current_year_dep", "current year depreciation"),
        ("addition_method", "addition method"),
        ("addition_date", "addition date"),
        ("disposal_method", "disposal method"),
        ("disposal_date", "disposal date"),
        ("disposal_orig", "disposal original value / original value decrease"),
        ("disposal_dep", "disposal depreciation / accumulated depreciation decrease"),
    ]
    return [{"role": role, "label": label, "description": label} for role, label in roles]


def _headers_by_file_side(files: list[dict[str, Any]]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for file_info in files:
        if not isinstance(file_info, dict):
            continue
        side = str(file_info.get("file_side") or "").strip()
        headers = file_info.get("headers")
        if not side or not isinstance(headers, list):
            continue
        out[side] = {str(header).strip() for header in headers if str(header).strip()}
    return out


def _ordered_headers_by_file_side(files: list[dict[str, Any]]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for file_info in files or []:
        if not isinstance(file_info, dict):
            continue
        side = str(file_info.get("file_side") or "").strip()
        headers = file_info.get("headers")
        if not side or not isinstance(headers, list):
            continue
        out[side] = [str(header).strip() for header in headers if str(header).strip()]
    return out


def _pick_useful_life_header(headers: list[str]) -> str:
    blocked = ("??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "??", "???")
    exact_groups = (
        ("使用寿命(月)", "使用寿命（月）", "使用寿命", "预计使用期间", "使用期间"),
        ("?????", "??????", "?????", "??????", "????", "????"),
    )
    contains_groups = (
        ("使用寿命", "预计寿命", "预计使用期间", "使用期间"),
        ("????", "????", "????", "????", "????"),
        ("寿命", "年限"),
    )

    def allowed(header: str) -> bool:
        return bool(header) and not any(keyword in header for keyword in blocked)

    for group in exact_groups:
        for header in headers or []:
            if allowed(header) and header in group:
                return header
    for group in contains_groups:
        for header in headers or []:
            if allowed(header) and any(keyword in header for keyword in group):
                return header
    return ""


def _coerce_side_mapping(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, str] = {}
    for side in ("file1", "file2", "main"):
        raw = value.get(side)
        if isinstance(raw, (list, tuple, set)):
            raw = next((item for item in raw if str(item).strip()), "")
        text = str(raw or "").strip()
        if text:
            out[side] = text
    return out


def _filter_suggested_mapping_to_headers(
    suggested_mapping: dict[str, str],
    headers_by_side: dict[str, set[str]],
) -> dict[str, str]:
    out: dict[str, str] = {}
    for side, col in suggested_mapping.items():
        if col and col in headers_by_side.get(side, set()):
            out[side] = col
    return out


def _normalize_suggestion(item: dict[str, Any]) -> LLMSuggestion:
    try:
        confidence = float(item.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    current_mapping = _coerce_side_mapping(item.get("current_mapping"))
    suggested_mapping = _coerce_side_mapping(item.get("suggested_mapping"))
    action = str(item.get("action") or "none").strip().lower()
    if action not in {"fill", "review", "keep", "none"}:
        action = "none"
    inferred_role = str(item.get("issue_field") or item.get("role") or item.get("mapped_to") or "").strip()
    inferred_side = str(item.get("file_side") or "").strip()
    suggested_column = str(item.get("suggested_column") or "").strip()
    if not suggested_column:
        for side in ("file1", "file2", "main"):
            value = str(item.get(f"{side}_header") or item.get(f"{side}_column") or "").strip()
            if value:
                suggested_column = value
                inferred_side = inferred_side or side
                break
    issue_field = inferred_role
    auto_apply = bool(item.get("auto_apply")) and confidence >= AUTO_APPLY_CONFIDENCE
    return LLMSuggestion(
        role=inferred_role,
        file_side=inferred_side,
        suggested_column=suggested_column,
        confidence=max(0.0, min(1.0, confidence)),
        action=action,
        reason=str(item.get("reason") or "").strip(),
        review_warning=str(item.get("review_warning") or "").strip(),
        issue_field=issue_field,
        current_mapping=current_mapping or None,
        suggested_mapping=suggested_mapping or None,
        auto_apply=auto_apply,
        issue_type=str(item.get("issue_type") or "").strip(),
    )


def _normalize_match_key_review(raw: dict[str, Any], *, files: list[dict[str, Any]]) -> LLMMatchKeyReview:
    try:
        confidence = float(raw.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    status = str(raw.get("status") or "warning").strip().lower()
    if status not in {"ok", "warning", "bad"}:
        status = "warning"
    action = str(raw.get("action") or "review").strip().lower()
    if action not in {"keep", "replace", "review"}:
        action = "review"

    def _string_list(value: Any) -> list[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    headers = _headers_by_file_side(files)
    suggested_file1 = [col for col in _string_list(raw.get("suggested_file1_columns")) if col in headers.get("file1", set())]
    suggested_file2 = [col for col in _string_list(raw.get("suggested_file2_columns")) if col in headers.get("file2", set())]
    if action == "replace" and (not suggested_file1 or not suggested_file2 or len(suggested_file1) != len(suggested_file2)):
        action = "review"
    reasons = [
        reason
        for reason in _string_list(raw.get("reasons"))[:6]
        if reason not in {"????", "??????", "..."}
    ]
    suggestion_reason = str(raw.get("suggestion_reason") or "").strip()
    if suggestion_reason in {"中文原因", "中文建议理由", "..."}:
        suggestion_reason = ""

    return LLMMatchKeyReview(
        status=status,
        confidence=max(0.0, min(1.0, confidence)),
        action=action,
        reasons=reasons,
        suggested_file1_columns=suggested_file1[:5],
        suggested_file2_columns=suggested_file2[:5],
        suggestion_reason=suggestion_reason,
    )


def _normalize_suite_analysis(raw: dict[str, Any]) -> dict[str, Any]:
    forbidden = (
        "抽凭",
        "查验合同",
        "查看验收。",
        "审计程序建议",
        "抽样建议",
        "建议核对",
        "建议检。",
        "建议获取",
        "建议追溯",
        "需核实",
        "需确认",
        "确认",
        "核实",
        "核对原始凭证",
        "检查原。",
        "获取合同",
        "查验",
        "抽查",
    )
    title = str(raw.get("title") or "LLM分析").strip()[:80] or "LLM分析"
    sections = []
    for section in raw.get("sections", []):
        if not isinstance(section, dict):
            continue
        heading = str(section.get("heading") or "").strip()[:80]
        points = [
            str(point).strip()
            for point in section.get("points", [])
            if str(point).strip() and not any(word in str(point) for word in forbidden)
        ][:8]
        if heading and points:
            sections.append({"heading": heading, "points": points})
    review_notes = [
        str(note).strip()
        for note in raw.get("review_notes", [])
        if str(note).strip() and not any(word in str(note) for word in forbidden)
    ][:8]
    if not sections:
        raise LLMClientError("模型返回的分析内容为空。")
    return {"title": title, "sections": sections, "review_notes": review_notes}










