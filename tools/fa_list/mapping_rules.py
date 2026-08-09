"""Headless FA List column-mapping rules shared by non-GUI callers.

These rules mirror the effective Tkinter workflow in
``gui/file_and_match_config.py`` without importing Tkinter.
"""

from __future__ import annotations

import re
from typing import Any, Iterable


def normalize_header(value: Any) -> str:
    return "".join(
        ch
        for ch in str(value or "").lower()
        if not ch.isspace() and ch not in "_-()/（）[]【】"
    )


FA_MATCH_ID_EXACT_PRIORITY = (
    ("固定资产编号", 1000),
    ("固定资产编码", 990),
    ("资产卡片编号", 980),
    ("资产卡片编码", 970),
    ("资产编号", 960),
    ("资产编码", 950),
    ("卡片编号", 940),
    ("卡片编码", 930),
    ("卡片号", 920),
)
FA_MATCH_ID_FORBIDDEN_EXACT = {
    "公司代码", "公司编码", "公司编号", "公司名称", "公司",
    "资产分类", "固定资产分类", "资产类别", "固定资产类别",
    "资产大类", "类别", "分类", "资产描述", "固定资产描述",
    "资产名称", "固定资产名称", "名称", "描述",
}
FA_MATCH_ID_FORBIDDEN_CONTAINS = (
    "公司", "分类", "类别", "大类", "描述", "名称", "原值", "折旧",
    "净值", "金额", "日期", "时间", "年限", "寿命",
)


def is_forbidden_match_key(column: Any) -> bool:
    normalized = normalize_header(column)
    if not normalized:
        return True
    if normalized in {normalize_header(item) for item in FA_MATCH_ID_FORBIDDEN_EXACT}:
        return True
    return any(normalize_header(item) in normalized for item in FA_MATCH_ID_FORBIDDEN_CONTAINS)


def score_match_id(column: Any) -> int | None:
    normalized = normalize_header(column)
    if not normalized or is_forbidden_match_key(column):
        return None
    for exact, score in FA_MATCH_ID_EXACT_PRIORITY:
        if normalized == normalize_header(exact):
            return score
    for keyword, score in (
        ("固定资产编号", 900), ("固定资产编码", 890),
        ("资产卡片编号", 880), ("资产卡片编码", 870),
        ("资产编号", 860), ("资产编码", 850),
        ("卡片编号", 830), ("卡片编码", 820), ("卡片号", 810),
    ):
        if normalize_header(keyword) in normalized:
            return score
    has_asset_context = any(token in normalized for token in ("固定资产", "资产", "卡片"))
    has_id_token = any(token in normalized for token in ("编号", "编码", "代码", "号码", "号"))
    if has_asset_context and has_id_token:
        return 700
    if "编号" in normalized:
        return 300
    if "编码" in normalized:
        return 280
    return None


def pick_match_id(columns: Iterable[Any]) -> str | None:
    scored = []
    for index, column in enumerate(columns or []):
        score = score_match_id(column)
        if score is not None:
            scored.append((-score, index, str(column)))
    return sorted(scored)[0][2] if scored else None


def pick_paired_match_ids(cols1: Iterable[Any], cols2: Iterable[Any]) -> tuple[str | None, str | None]:
    def scored(columns: Iterable[Any]):
        out = []
        for index, column in enumerate(columns or []):
            score = score_match_id(column)
            if score is not None:
                out.append((score, index, str(column), normalize_header(column)))
        return out

    scored1, scored2 = scored(cols1), scored(cols2)
    if not scored1 or not scored2:
        return None, None
    norms2 = {entry[3]: entry for entry in scored2}
    paired = []
    for score1, index1, col1, norm1 in scored1:
        match = norms2.get(norm1)
        if match:
            score2, index2, col2, _ = match
            paired.append((-(score1 + score2), index1, index2, col1, col2))
    if paired:
        _, _, _, best1, best2 = sorted(paired)[0]
        return best1, best2
    return pick_match_id(cols1), pick_match_id(cols2)


CATEGORY_NAME_EXACT = (
    "资产类别", "资产大类", "固定资产类别", "资产类型描述", "资产类型", "类别", "大类",
)
CATEGORY_NAME_CONTAIN = ("种类", "分类", "资产类型")
CATEGORY_NUMERIC_BLACKLIST = ("原值", "累计折旧", "成本", "净值", "残值", "减值", "折旧", "金额", "价值")
_CATEGORY_CODE_VALUE_PATTERN = re.compile(r"^[A-Za-z]{0,4}[-_.]?\d+[A-Za-z0-9\-_./]*$")


def _sample_values(frame: Any, column: str, limit: int = 500) -> list[str]:
    if frame is None or column not in getattr(frame, "columns", []):
        return []
    try:
        values = frame[column].dropna().astype(str).map(lambda value: value.strip())
        return [value for value in values.head(limit).tolist() if value]
    except Exception:
        return []


def _category_values_look_like_codes(values: list[str], threshold: float = 0.5) -> bool:
    if not values:
        return False
    code_like = sum(
        1 for value in values
        if len(value) <= 12 and _CATEGORY_CODE_VALUE_PATTERN.match(value)
    )
    return code_like / len(values) >= threshold


def pick_category(columns: Iterable[Any], frame: Any = None) -> str | None:
    cols = [str(value) for value in columns or []]
    if frame is not None:
        scored = []
        for index, column in enumerate(cols):
            if any(term in column for term in CATEGORY_NUMERIC_BLACKLIST):
                continue
            values = _sample_values(frame, column)
            if not values or _category_values_look_like_codes(values):
                continue
            strong = column in CATEGORY_NAME_EXACT or any(
                term in column for term in CATEGORY_NAME_EXACT + CATEGORY_NAME_CONTAIN
            )
            ambiguous_description = "资产描述" in column and not strong
            if not strong and not ambiguous_description:
                continue
            cjk_short_ratio = sum(
                1 for value in values if re.search(r"[\u4e00-\u9fff]", value) and len(value) <= 15
            ) / len(values)
            long_ratio = sum(1 for value in values if len(value) > 15) / len(values)
            unique_count = len(set(values))
            if ambiguous_description:
                category_terms = (
                    "房屋", "建筑", "机器设备", "办公设备", "电子设备", "运输工具",
                    "车辆", "仪器", "量具", "夹具", "模具", "公用配套", "其他设备",
                )
                term_ratio = sum(
                    1 for value in values if any(term in value for term in category_terms)
                ) / len(values)
                has_long_description_peer = any(
                    peer != column
                    and "描述" in peer
                    and (peer_values := _sample_values(frame, peer, 100))
                    and sum(1 for value in peer_values if len(value) > 15) / len(peer_values) >= 0.5
                    for peer in cols
                )
                if term_ratio < 0.5 and not has_long_description_peer:
                    continue
            if column in ("资产类别", "固定资产类别", "资产大类", "类别", "大类"):
                header_score = 45
            elif "类别" in column or "大类" in column:
                header_score = 35
            elif "类型" in column or "分类" in column:
                header_score = 25
            else:
                header_score = 12
            shape_score = cjk_short_ratio * 70 - long_ratio * 70 - min(unique_count, 200) * 0.15
            scored.append((header_score + shape_score, -index, column))
        if scored:
            return sorted(scored, reverse=True)[0][2]
    for column in cols:
        if (
            column in CATEGORY_NAME_EXACT
            and not any(term in column for term in CATEGORY_NUMERIC_BLACKLIST)
            and not _category_values_look_like_codes(_sample_values(frame, column))
        ):
            return column
    for column in cols:
        if any(term in column for term in CATEGORY_NUMERIC_BLACKLIST):
            continue
        if (
            any(term in column for term in CATEGORY_NAME_EXACT + CATEGORY_NAME_CONTAIN)
            and not _category_values_look_like_codes(_sample_values(frame, column))
        ):
            return column
    return None


def pick_name(columns: Iterable[Any], frame: Any = None, exclude: Iterable[Any] = ()) -> str | None:
    cols = [str(value) for value in columns or []]
    excluded = {str(value) for value in exclude if str(value).strip()}
    exact = ("固定资产名称", "资产名称", "名称", "资产描述", "资产类型描述")
    contained = ("名称", "描述", "资产名", "类型描述")
    scored = []
    for index, column in enumerate(cols):
        if column in excluded or any(term in column for term in CATEGORY_NUMERIC_BLACKLIST):
            continue
        if not any(term in column for term in exact + contained):
            continue
        if column in ("固定资产名称", "资产名称", "名称"):
            header_score = 45
        elif column in ("资产类型描述", "固定资产描述", "资产描述"):
            header_score = 25
        elif "名称" in column:
            header_score = 25
        else:
            header_score = 18
        values = _sample_values(frame, column)
        if not values:
            score = header_score
        else:
            code_ratio = sum(
                1 for value in values
                if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-/]{0,11}", value)
            ) / len(values)
            if code_ratio >= 0.6:
                continue
            average_length = sum(len(value) for value in values) / len(values)
            long_ratio = sum(1 for value in values if len(value) > 15) / len(values)
            unique_count = len(set(values))
            unique_ratio = unique_count / len(values)
            cjk_short_ratio = sum(
                1 for value in values
                if re.search(r"[\u4e00-\u9fff]", value) and len(value) <= 15
            ) / len(values)
            shape_score = min(average_length, 40) * 1.5 + long_ratio * 45 + unique_ratio * 20
            if cjk_short_ratio >= 0.8 and unique_count <= 50 and long_ratio < 0.2:
                shape_score -= 45
            score = header_score + shape_score
        scored.append((score, -index, column))
    return sorted(scored, reverse=True)[0][2] if scored else None


def pick_life(columns: Iterable[Any]) -> str | None:
    blocked = ("残值", "原值", "折旧", "减值", "净值", "金额", "价值", "成本", "税额", "账面")
    preferred = ("使用寿命", "使用寿命(月)", "使用寿命（月）", "预计使用期间数", "使用期间数")
    secondary = ("预计寿命", "使用年限", "折旧年期", "计划使用年", "计划使用年限", "预计使用年", "预计使用年限")
    fallback = ("寿命", "年限", "期间数", "使用月份")
    cols = [str(value) for value in columns or []]
    allowed = lambda value: "剩余" not in value and not any(term in value for term in blocked)
    for group in (preferred, secondary):
        for column in cols:
            if allowed(column) and column in group:
                return column
    for group in (preferred, secondary, fallback):
        for column in cols:
            if allowed(column) and any(term in column for term in group):
                return column
    return None

