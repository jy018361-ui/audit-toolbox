"""
文件选择和匹配列配置合并界面
"""
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError, as_completed
import os
import re
import threading
import webbrowser
from urllib.parse import quote
import pandas as pd
from file_handler import FileHandler
from utils.helpers import get_column_matches, detect_encoding
from config import SUPPORTED_EXCEL_FORMATS, SUPPORTED_CSV_FORMATS, PREVIEW_ROWS
from launcher.llm_client import AUTO_APPLY_CONFIDENCE, LLMMatchKeyReview, generate_combined_fa_list_assistance, review_fa_list_field_mappings, review_match_key_columns, suggest_field_mappings
from launcher.llm_settings import is_llm_enabled, load_llm_settings
from launcher.ui_theme import (
    ERROR,
    MUTED_TEXT,
    PRIMARY,
    apply_app_theme,
    center_on_parent,
    fit_window_to_screen,
)


LLM_MAPPING_BATCH_TIMEOUT_SECONDS = 45


def build_unique_key_profile(df, columns, *, sample_limit=5):
    """Return duplicate/blank statistics for a single or composite match key."""
    columns = [str(col) for col in (columns or []) if str(col).strip()]
    profile = {
        "columns": columns,
        "row_count": 0,
        "valid_count": 0,
        "blank_count": 0,
        "blank_rate": 0.0,
        "unique_count": 0,
        "duplicate_key_count": 0,
        "duplicate_row_count": 0,
        "unique_rate": 0.0,
        "is_unique": False,
        "duplicate_examples": [],
        "missing_columns": [],
    }
    if df is None:
        return profile
    profile["row_count"] = int(len(df))
    if not columns:
        profile["missing_columns"] = []
        return profile
    missing = [col for col in columns if col not in df.columns]
    profile["missing_columns"] = missing
    if missing:
        return profile

    keys = df[columns].apply(
        lambda row: " | ".join(_normalize_key_part(value) for value in row),
        axis=1,
    )
    blank_mask = keys.eq("") | keys.str.replace(" | ", "", regex=False).eq("")
    valid = keys[~blank_mask]
    counts = valid.value_counts(dropna=False)
    dup_counts = counts[counts > 1]
    valid_count = int(len(valid))
    duplicate_row_count = int(dup_counts.sum()) if not dup_counts.empty else 0
    profile.update(
        {
            "valid_count": valid_count,
            "blank_count": int(blank_mask.sum()),
            "blank_rate": round(float(blank_mask.mean()), 4) if len(keys) else 0.0,
            "unique_count": int(counts.shape[0]),
            "duplicate_key_count": int(dup_counts.shape[0]),
            "duplicate_row_count": duplicate_row_count,
            "unique_rate": round(float(counts.shape[0] / valid_count), 4) if valid_count else 0.0,
            "is_unique": bool(profile["row_count"] > 0 and int(blank_mask.sum()) == 0 and duplicate_row_count == 0),
            "duplicate_examples": [
                {"key": str(key)[:120], "count": int(count)}
                for key, count in dup_counts.head(sample_limit).items()
            ],
        }
    )
    return profile


MATCH_KEY_CANDIDATE_GROUPS = (
    ("date", ("日期", "时间", "入账", "资本化", "开始", "启用", "取得", "购置", "转固", "date", "time", "capital", "start", "acquir")),
    ("sub_no", ("次级", "明细", "子编号", "附属", "组件", "行号", "序号", "顺序", "项次", "line", "row", "serial", "seq", "sub")),
    ("card", ("卡片", "卡号", "资产卡", "card")),
)


def _series_id_like_score(series):
    """按列的数据形态判断它是否像资产编码，跟列名无关。

    通过的列必须满足：低空值率、高唯一率、平均长度合理、值形态像编码（字母+数字+短连字符）、
    含数字、不是 yyyy-mm-dd 日期。返回 None 表示这列不像 ID。

    设计目的：当列名被改坏（如 资产编码 → 资产类型）但单元格里还是 1100000 这类编号时，
    让 LLM 仍能从候选池里看到它。
    """
    try:
        total = int(len(series))
    except Exception:
        return None
    if total == 0:
        return None
    try:
        non_blank = series.dropna()
        non_blank = non_blank[non_blank.astype(str).str.strip().ne('')]
    except Exception:
        return None
    non_blank_count = int(len(non_blank))
    if non_blank_count == 0:
        return None
    blank_rate = 1 - non_blank_count / total
    if blank_rate > 0.05:
        return None
    try:
        str_values = non_blank.astype(str).str.strip()
    except Exception:
        return None
    unique_rate = int(str_values.nunique()) / non_blank_count
    if unique_rate < 0.95:
        return None
    avg_len = float(str_values.str.len().mean())
    if avg_len < 4 or avg_len > 24:
        return None
    try:
        code_like_ratio = float(str_values.str.match(r'^[A-Za-z0-9][A-Za-z0-9\-_]{2,30}$').mean())
    except Exception:
        return None
    if code_like_ratio < 0.85:
        return None
    try:
        has_digit_ratio = float(str_values.str.contains(r'\d', regex=True).mean())
    except Exception:
        has_digit_ratio = 0.0
    if has_digit_ratio < 0.8:
        return None
    try:
        date_like_ratio = float(str_values.str.match(r'^\d{4}-\d{1,2}-\d{1,2}$').mean())
    except Exception:
        date_like_ratio = 0.0
    if date_like_ratio > 0.3:
        return None
    return unique_rate * 0.7 + (1 - blank_rate) * 0.15 + (1 - date_like_ratio) * 0.05 + min(1.0, has_digit_ratio) * 0.1


def _data_driven_id_candidates(df, columns, exclude_set, *, top_k=4, max_scan_columns=120):
    """扫描列数据，挑出形态最像资产编码的 top_k 列，不看列名。"""
    if df is None:
        return []
    scored = []
    for col in list(columns or [])[:max_scan_columns]:
        if col in exclude_set:
            continue
        try:
            series = df[col]
        except Exception:
            continue
        score = _series_id_like_score(series)
        if score is None:
            continue
        scored.append((score, col))
    scored.sort(reverse=True)
    return [col for _, col in scored[:top_k]]


def _normalize_id_token(value):
    """统一去掉浮点整数的 .0 尾巴：'1100000.0' -> '1100000'，让跨文件值比对稳定。

    pandas 读 Excel 整数列经常误判为 float，转 str 后变 '1100000.0'，会让两侧
    ID 比对（取值重合、种子形态判定）全部错位。这里在所有"取 ID 字符串"的
    入口统一规范化。
    """
    s = str(value).strip()
    if s.endswith('.0'):
        body = s[:-2]
        if body and (body[0] in '-+0123456789') and body.lstrip('-+').isdigit():
            return body
    return s


def _id_series(df, col):
    """读取列并按 _normalize_id_token 规范化，返回去空非空 str Series。"""
    s = df[col].dropna().astype(str).str.strip()
    s = s[s != '']
    return s.map(_normalize_id_token)


def _reference_id_values(df, col, *, sample_cap=10000):
    """从一侧已确认的 ID 列里取出唯一值集合（已规范化去 .0），作为另一侧的"对照值池"。

    sample_cap 设得足够大（10000），避免在万级资产卡片场景下采样太少导致
    跨文件 overlap 失真。极大表（10w+）下集合操作仍可承受。
    """
    if df is None:
        return []
    try:
        s = _id_series(df, col)
        return list(s.unique())[:sample_cap]
    except Exception:
        return []


def _cross_overlap_id_candidates(df, columns, reference_values, exclude_set, *,
                                  top_k=4, min_overlap_rate=0.5, max_scan_columns=120):
    """跨文件取值重合识别：用另一侧的 ID 取值池在本侧搜匹配列。

    解决"本侧 ID 列因子资产/层次结构而含重复（无法通过严格唯一率筛选），但取值跟另一侧
    的真 ID 列完全是同一批编号"的场景。

    返回的列：唯一取值与 reference_values 重合率 ≥ min_overlap_rate，且形态像编码
    （避免名称列恰好同名命中）。
    """
    if df is None or not reference_values:
        return []
    ref_set = {_normalize_id_token(v) for v in reference_values}
    scored = []
    for col in list(columns or [])[:max_scan_columns]:
        if col in exclude_set:
            continue
        try:
            series = _id_series(df, col)
            uniques = set(series.unique())
        except Exception:
            continue
        if not uniques:
            continue
        overlap = uniques & ref_set
        if not overlap:
            continue
        # 用"小者作分母"判定重合率：双向覆盖任一方向达标即认。
        # 避免本侧含少量杂数据、或 ref 受 sample_cap 截断时把真匹配拒掉。
        denom = max(1, min(len(uniques), len(ref_set)))
        overlap_rate = len(overlap) / denom
        if overlap_rate < min_overlap_rate:
            continue
        try:
            code_like = float(series.str.match(r'^[A-Za-z0-9][A-Za-z0-9\-_]{2,30}$').mean())
        except Exception:
            code_like = 0.0
        if code_like < 0.5:
            continue
        scored.append((overlap_rate * 0.7 + code_like * 0.3, col))
    scored.sort(reverse=True)
    return [col for _, col in scored[:top_k]]


def _seed_column_if_id_like(df, column, *, min_unique_values=50):
    """种子质量过滤：仅当列本身"看着像编码"时才返回列名作为种子。

    用于 _build_data_driven_id_pairs 的兜底分支：避免拿全常量列（如 "1" 列全是
    H201）当种子去对面找重合 —— 那样会把对面也是全常量的列误捞回来。

    判定门槛刻意宽松：唯一值数 >= 50（一般审计场景资产编号都远超此数）。
    """
    if df is None or column is None:
        return None
    column = str(column)
    if column not in df.columns:
        return None
    try:
        series = _id_series(df, column)
        if series.nunique() < min_unique_values:
            return None
        code_like = float(series.str.match(r'^[A-Za-z0-9][A-Za-z0-9\-_]{2,30}$').mean())
        if code_like < 0.5:
            return None
        return column
    except Exception:
        return None


def _build_data_driven_id_pairs(df1, df2, current1, current2, cols1, cols2, *, max_pairs=4):
    """两侧 data-driven ID 候选配对。

    对每对配对的 (c1, c2)，产出两种候选键（两种都加进 LLM 视野，让它二选一）：
      - 单列纯净候选 [c1] vs [c2]：永远生成、永远两边对称。即便 current 两边长度不一致
        也能给出此候选，让 LLM 有机会通过采纳此候选把匹配键重置为干净的单列 ID。
      - 保留 helpers 的复合候选 [c1, *helpers1] vs [c2, *helpers2]：仅在两边 helpers
        数量一致时生成，避免在自动追加名称后 LLM 因"候选信息更少"而拒绝替换。
    """
    if df1 is None or df2 is None:
        return []

    # 第一阶段：各自独立的严格识别（唯一率 ≥ 95% + 形态像编码）
    strict1 = _data_driven_id_candidates(df1, cols1, exclude_set=set())
    strict2 = _data_driven_id_candidates(df2, cols2, exclude_set=set())

    # 第二阶段：跨文件取值重合补强 —— 用一侧的"种子 ID"值集合去另一侧搜匹配列，
    # 捕获"形态像编码、取值跟对面一致、但本侧因子资产而含重复"的列。
    ref_for_file1 = []
    for c2 in strict2:
        ref_for_file1.extend(_reference_id_values(df2, c2))
    cross1 = _cross_overlap_id_candidates(df1, cols1, ref_for_file1, exclude_set=set(strict1)) if ref_for_file1 else []

    ref_for_file2 = []
    for c1 in strict1:
        ref_for_file2.extend(_reference_id_values(df1, c1))
    cross2 = _cross_overlap_id_candidates(df2, cols2, ref_for_file2, exclude_set=set(strict2)) if ref_for_file2 else []

    # 第三阶段（兜底种子）：当严格管道两侧都空、跨文件检测也启动不了时，
    # 退而求其次：用当前匹配键的第一列作种子。前提是该列本身"看着像编码"
    # （唯一值数 >= 50，避免拿全常量/几乎全常量列污染候选池）。
    if not strict1 and not strict2 and not cross1 and not cross2:
        seed1 = _seed_column_if_id_like(df1, (current1 or [None])[0])
        seed2 = _seed_column_if_id_like(df2, (current2 or [None])[0])
        if seed1:
            ref_from_current1 = _reference_id_values(df1, seed1)
            if ref_from_current1:
                cross2 = _cross_overlap_id_candidates(df2, cols2, ref_from_current1, exclude_set=set())
        if seed2:
            ref_from_current2 = _reference_id_values(df2, seed2)
            if ref_from_current2:
                cross1 = _cross_overlap_id_candidates(df1, cols1, ref_from_current2, exclude_set=set())
        # 反哺：若兜底用 seed1 找到了 file2 候选，把 seed1 自身也补进 cands1（让它成对）。
        if seed1 and cross2 and seed1 not in (strict1 + cross1):
            cross1 = list(cross1) + [seed1]
        if seed2 and cross1 and seed2 not in (strict2 + cross2):
            cross2 = list(cross2) + [seed2]

    cands1 = strict1 + cross1
    cands2 = strict2 + cross2
    if not cands1 or not cands2:
        return []

    current1 = [str(c) for c in (current1 or [])]
    current2 = [str(c) for c in (current2 or [])]
    helpers1 = current1[1:]
    helpers2 = current2[1:]
    current_key = (tuple(current1), tuple(current2))

    def _candidates_for(c1, c2):
        results = []
        single1, single2 = [c1], [c2]
        if (tuple(single1), tuple(single2)) != current_key:
            results.append((single1, single2))
        if helpers1 and helpers2 and len(helpers1) == len(helpers2):
            composite1 = [c1] + [h for h in helpers1 if h != c1]
            composite2 = [c2] + [h for h in helpers2 if h != c2]
            if len(composite1) == len(composite2) and (tuple(composite1), tuple(composite2)) != current_key:
                results.append((composite1, composite2))
        return results

    out = []
    used2 = set()
    norms2 = {}
    for c in cands2:
        norms2.setdefault(_normalize_candidate_header(c), c)

    def _append_pair(c1, c2):
        for pair in _candidates_for(c1, c2):
            out.append(pair)
            if len(out) >= max_pairs:
                return True
        return False

    for c1 in cands1:
        c2 = norms2.get(_normalize_candidate_header(c1))
        if c2 and c2 not in used2:
            used2.add(c2)
            if _append_pair(c1, c2):
                return out

    for c1 in cands1:
        if any(c1 == p[0][0] for p in out):
            continue
        for c2 in cands2:
            if c2 in used2:
                continue
            used2.add(c2)
            if _append_pair(c1, c2):
                return out
            break
        if len(out) >= max_pairs:
            break

    return out


def build_match_key_candidate_profiles(df1, df2, current1, current2, *, cols1=None, cols2=None, max_candidates=12, per_group_limit=4):
    """Build paired composite-key profiles by appending semantic candidate columns."""
    current1 = [str(col) for col in (current1 or []) if str(col).strip()]
    current2 = [str(col) for col in (current2 or []) if str(col).strip()]
    if df1 is None or df2 is None or not current1 or not current2:
        return []

    cols1 = [str(col) for col in (cols1 or list(getattr(df1, "columns", [])))]
    cols2 = [str(col) for col in (cols2 or list(getattr(df2, "columns", [])))]
    current1_set = set(current1)
    current2_set = set(current2)
    out = []
    seen = set()

    paired_swap = _build_paired_id_swap_candidate(
        df1, df2, current1, current2, cols1, cols2
    )
    if paired_swap is not None:
        key = (tuple(paired_swap["file1_columns"]), tuple(paired_swap["file2_columns"]))
        seen.add(key)
        out.append(paired_swap)

    for group_name, keywords in MATCH_KEY_CANDIDATE_GROUPS:
        side1 = _semantic_candidate_columns(cols1, current1_set, keywords)
        side2 = _semantic_candidate_columns(cols2, current2_set, keywords)
        group_count = 0
        for col1 in side1:
            for col2 in side2:
                candidate1 = current1 + [col1]
                candidate2 = current2 + [col2]
                key = (tuple(candidate1), tuple(candidate2))
                if key in seen:
                    continue
                seen.add(key)
                file1_profile = build_unique_key_profile(df1, candidate1)
                file2_profile = build_unique_key_profile(df2, candidate2)
                out.append(
                    {
                        "group": group_name,
                        "file1_columns": candidate1,
                        "file2_columns": candidate2,
                        "file1": file1_profile,
                        "file2": file2_profile,
                    }
                )
                group_count += 1
                if len(out) >= max_candidates or group_count >= per_group_limit:
                    break
            if len(out) >= max_candidates or group_count >= per_group_limit:
                break
        if len(out) >= max_candidates:
            break

    # 数据驱动 ID 候选：扫描列内容判断"哪一列像编码"，不看表头。
    # 解决表头被改坏（资产编码 → 资产类型）但数据形态仍是编号的情况。
    if len(out) < max_candidates:
        for candidate1, candidate2 in _build_data_driven_id_pairs(df1, df2, current1, current2, cols1, cols2):
            key = (tuple(candidate1), tuple(candidate2))
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "group": "data_driven_id",
                    "file1_columns": candidate1,
                    "file2_columns": candidate2,
                    "file1": build_unique_key_profile(df1, candidate1),
                    "file2": build_unique_key_profile(df2, candidate2),
                }
            )
            if len(out) >= max_candidates:
                break
    return out


def filter_match_key_candidates_by_forbidden(candidate_profiles, forbidden_columns):
    """Drop any candidate whose file1_columns/file2_columns intersect forbidden_columns.

    forbidden_columns has shape {"file1": [...], "file2": [...]}. Candidates with
    any business-attribute column that's been flagged as forbidden are removed
    wholesale (we cannot just trim columns - that would break the paired
    composite key contract).
    """
    if not candidate_profiles:
        return []
    fb1 = set(str(c) for c in (forbidden_columns or {}).get("file1") or [])
    fb2 = set(str(c) for c in (forbidden_columns or {}).get("file2") or [])
    if not fb1 and not fb2:
        return list(candidate_profiles)
    kept = []
    for candidate in candidate_profiles:
        if not isinstance(candidate, dict):
            continue
        cols1 = [str(c) for c in (candidate.get("file1_columns") or [])]
        cols2 = [str(c) for c in (candidate.get("file2_columns") or [])]
        if any(c in fb1 for c in cols1):
            continue
        if any(c in fb2 for c in cols2):
            continue
        kept.append(candidate)
    return kept


def sanitize_llm_match_review_against_forbidden(review, forbidden_columns):
    """Front-end safety net: scrub LLM-suggested match-key columns that violate
    forbidden_columns, even if the LLM ignored the instruction.

    Returns the (possibly modified) review object and a boolean indicating
    whether any column was scrubbed.

    If after scrubbing the two sides no longer have equal length or become
    empty, the suggestion is wiped entirely and the review is downgraded so the
    UI shows a "model had a suggestion but it was filtered out" message instead
    of an apply-able replacement.
    """
    if review is None:
        return review, False
    fb1 = set(str(c) for c in (forbidden_columns or {}).get("file1") or [])
    fb2 = set(str(c) for c in (forbidden_columns or {}).get("file2") or [])
    if not fb1 and not fb2:
        return review, False

    def _get(name, default=None):
        if isinstance(review, dict):
            return review.get(name, default)
        return getattr(review, name, default)

    def _set(name, value):
        if isinstance(review, dict):
            review[name] = value
        else:
            setattr(review, name, value)

    def _coerce_list(value):
        if isinstance(value, str):
            return [value] if value.strip() else []
        if not isinstance(value, (list, tuple)):
            return []
        return [str(item) for item in value if str(item).strip()]

    suggested1 = _coerce_list(_get("suggested_file1_columns"))
    suggested2 = _coerce_list(_get("suggested_file2_columns"))
    if not suggested1 and not suggested2:
        return review, False

    scrubbed1 = [c for c in suggested1 if c not in fb1]
    scrubbed2 = [c for c in suggested2 if c not in fb2]
    changed = (scrubbed1 != suggested1) or (scrubbed2 != suggested2)
    if not changed:
        return review, False

    if not scrubbed1 or not scrubbed2 or len(scrubbed1) != len(scrubbed2):
        # Suggestion would be unsafe to apply - clear it and downgrade to a
        # plain advisory keep.
        _set("suggested_file1_columns", [])
        _set("suggested_file2_columns", [])
        _set("action", "keep")
        reasons = _get("reasons") or []
        if not isinstance(reasons, list):
            reasons = [reasons] if reasons else []
        reasons = list(reasons) + [
            "模型有匹配键建议，但其中包含已映射的业务字段（折旧/原值/类别等），脚本已过滤；建议保持当前匹配键。"
        ]
        _set("reasons", reasons)
        return review, True

    _set("suggested_file1_columns", scrubbed1)
    _set("suggested_file2_columns", scrubbed2)
    return review, True


def _build_paired_id_swap_candidate(df1, df2, current1, current2, cols1, cols2):
    """Suggest replacing the primary ID column when the two sides currently
    point at different conceptual IDs (e.g. file1=资产编码, file2=卡片编码) but
    a same-name ID column exists on both sides. Returns a candidate dict whose
    file1/file2 primary key uses the shared column on both sides — the LLM can
    then copy it verbatim to repair the mismatch.
    """
    if not current1 or not current2:
        return None
    head1, head2 = current1[0], current2[0]
    if score_fa_match_id_column(head1) is None or score_fa_match_id_column(head2) is None:
        return None
    if _normalize_candidate_header(head1) == _normalize_candidate_header(head2):
        return None
    paired1, paired2 = pick_paired_fa_match_id_columns(cols1, cols2)
    if not paired1 or not paired2:
        return None
    if _normalize_candidate_header(paired1) != _normalize_candidate_header(paired2):
        return None
    if paired1 == head1 and paired2 == head2:
        return None
    candidate1 = [paired1] + [col for col in current1[1:] if col != paired1]
    candidate2 = [paired2] + [col for col in current2[1:] if col != paired2]
    return {
        "group": "paired_primary_id",
        "file1_columns": candidate1,
        "file2_columns": candidate2,
        "file1": build_unique_key_profile(df1, candidate1),
        "file2": build_unique_key_profile(df2, candidate2),
    }


def _semantic_candidate_columns(columns, excluded, keywords, limit=6):
    scored = []
    for index, col in enumerate(columns or []):
        text = str(col).strip()
        if not text or text in excluded:
            continue
        normalized = _normalize_candidate_header(text)
        hits = [kw for kw in keywords if _normalize_candidate_header(kw) in normalized]
        if not hits:
            continue
        best_pos = min(normalized.find(_normalize_candidate_header(kw)) for kw in hits)
        scored.append((-len(hits), best_pos, index, text))
    scored.sort()
    return [item[3] for item in scored[:limit]]


def _normalize_candidate_header(value):
    return "".join(ch for ch in str(value or "").lower() if not ch.isspace() and ch not in "_-()/（）[]【】")


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
    "公司代码",
    "公司编码",
    "公司编号",
    "公司名称",
    "公司",
    "资产分类",
    "固定资产分类",
    "资产类别",
    "固定资产类别",
    "资产大类",
    "类别",
    "分类",
    "资产描述",
    "固定资产描述",
    "资产名称",
    "固定资产名称",
    "名称",
    "描述",
}

FA_MATCH_ID_FORBIDDEN_CONTAINS = (
    "公司",
    "分类",
    "类别",
    "大类",
    "描述",
    "名称",
    "原值",
    "折旧",
    "净值",
    "金额",
    "日期",
    "时间",
    "年限",
    "寿命",
)


def is_forbidden_fa_match_key_column(column):
    """Return True when a column is not suitable as the primary FA match ID."""
    normalized = _normalize_candidate_header(column)
    if not normalized:
        return True
    forbidden_exact = {_normalize_candidate_header(item) for item in FA_MATCH_ID_FORBIDDEN_EXACT}
    if normalized in forbidden_exact:
        return True
    return any(_normalize_candidate_header(item) in normalized for item in FA_MATCH_ID_FORBIDDEN_CONTAINS)


def score_fa_match_id_column(column):
    """Score how strongly a column name looks like an asset unique code/id."""
    normalized = _normalize_candidate_header(column)
    if not normalized or is_forbidden_fa_match_key_column(column):
        return None

    for exact, score in FA_MATCH_ID_EXACT_PRIORITY:
        if normalized == _normalize_candidate_header(exact):
            return score

    contains_rules = (
        ("固定资产编号", 900),
        ("固定资产编码", 890),
        ("资产卡片编号", 880),
        ("资产卡片编码", 870),
        ("资产编号", 860),
        ("资产编码", 850),
        ("卡片编号", 830),
        ("卡片编码", 820),
        ("卡片号", 810),
    )
    for keyword, score in contains_rules:
        if _normalize_candidate_header(keyword) in normalized:
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


def pick_fa_match_id_column(columns):
    """Pick the best primary FA match ID column from a column list."""
    scored = []
    for index, column in enumerate(columns or []):
        score = score_fa_match_id_column(column)
        if score is not None:
            scored.append((-score, index, column))
    if not scored:
        return None
    scored.sort()
    return scored[0][2]


def _scored_fa_match_id_columns(columns):
    """Return [(score, index, column, normalized_name)] for all ID-like columns."""
    out = []
    for index, column in enumerate(columns or []):
        score = score_fa_match_id_column(column)
        if score is None:
            continue
        out.append((score, index, column, _normalize_candidate_header(column)))
    return out


def pick_paired_fa_match_id_columns(cols1, cols2):
    """Pick paired primary ID columns with strict symmetry guarantee.

    严格成对返回：要么两侧都找到 ID 列，要么两侧都返回 None。
    避免单侧成功（例如 file1 用户改名为英文 'coding'、file2 仍是 '资产编码'）
    污染下游自动选列流程，产生 1 vs N 不等长状态。

    优先策略：若两侧存在同名（normalized）ID 列，选共享名（如双方都用'卡片编码'）；
    否则各自独立挑选最高分 ID 列。
    """
    scored1 = _scored_fa_match_id_columns(cols1)
    scored2 = _scored_fa_match_id_columns(cols2)
    if not scored1 or not scored2:
        # 任一侧没有 scored ID 列时严格双 None，避免下游产生不等长。
        return None, None

    norms2 = {entry[3]: entry for entry in scored2}
    paired = []
    for score1, index1, col1, norm1 in scored1:
        match = norms2.get(norm1)
        if match is None:
            continue
        score2, index2, col2, _ = match
        paired.append((-(score1 + score2), index1, index2, col1, col2))
    if paired:
        paired.sort()
        _, _, _, best1, best2 = paired[0]
        return best1, best2

    fallback1 = pick_fa_match_id_column(cols1)
    fallback2 = pick_fa_match_id_column(cols2)
    if fallback1 and fallback2:
        return fallback1, fallback2
    return None, None


def build_match_key_review_decision(review, *, cols1, cols2, current1, current2, min_confidence=0.55):
    """Normalize an LLM match-key review into a testable UI decision."""
    if review is None:
        return {"show": False, "can_apply": False, "reasons": [], "suggested_file1_columns": [], "suggested_file2_columns": []}

    def _get(name, default=None):
        if isinstance(review, dict):
            return review.get(name, default)
        return getattr(review, name, default)

    def _list(value):
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            return []
        return [str(item).strip() for item in value if str(item).strip()]

    try:
        confidence = float(_get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    status = str(_get("status", "warning") or "warning").lower()
    action = str(_get("action", "review") or "review").lower()
    suggested1 = [col for col in _list(_get("suggested_file1_columns")) if col in set(cols1 or [])]
    suggested2 = [col for col in _list(_get("suggested_file2_columns")) if col in set(cols2 or [])]
    reasons = [_localize_llm_reason(reason) for reason in _list(_get("reasons"))]
    suggestion_reason = str(_get("suggestion_reason", "") or "").strip()
    if suggestion_reason:
        reasons.append(_localize_llm_reason(suggestion_reason))
    current1 = [str(col) for col in (current1 or [])]
    current2 = [str(col) for col in (current2 or [])]
    has_suggestion = bool(suggested1 and suggested2)
    has_change = has_suggestion and (suggested1 != current1 or suggested2 != current2)
    has_review_warning = action == "review" and bool(reasons)
    can_apply = (
        action in {"replace", "review"}
        and confidence >= min_confidence
        and len(suggested1) == len(suggested2)
        and bool(suggested1)
        and has_change
    )
    show = status in {"warning", "bad"} and confidence >= min_confidence and (has_change or not has_suggestion or has_review_warning)
    return {
        "show": show,
        "can_apply": can_apply,
        "has_change": has_change,
        "status": status,
        "action": action,
        "confidence": max(0.0, min(1.0, confidence)),
        "reasons": reasons[:6],
        "suggested_file1_columns": suggested1,
        "suggested_file2_columns": suggested2,
    }


def build_local_match_key_review(profile, *, current1, current2):
    """Build a deterministic review warning from local key uniqueness stats."""
    if not isinstance(profile, dict):
        return None

    def side_reasons(side_label, side_profile):
        if not isinstance(side_profile, dict):
            return []
        row_count = int(side_profile.get("row_count") or 0)
        duplicate_row_count = int(side_profile.get("duplicate_row_count") or 0)
        duplicate_key_count = int(side_profile.get("duplicate_key_count") or 0)
        blank_count = int(side_profile.get("blank_count") or 0)
        reasons = []
        if row_count and duplicate_row_count:
            examples = side_profile.get("duplicate_examples") or []
            example_text = ""
            if examples:
                first = examples[0]
                example_text = f"，例如 {first.get('key')} 出现 {first.get('count')} 次"
            reasons.append(
                f"{side_label}当前匹配列存在重复键：{duplicate_key_count} 个重复 ID，涉及 {duplicate_row_count} 行{example_text}"
            )
        if row_count and blank_count:
            reasons.append(f"{side_label}当前匹配列存在空值：{blank_count} 行")
        return reasons

    reasons = []
    reasons.extend(side_reasons("文件1", profile.get("file1")))
    reasons.extend(side_reasons("文件2", profile.get("file2")))
    if not reasons:
        return None
    reasons.append("本地唯一性画像显示当前匹配键不是一行一资产，需复核是否应增加次级编号等组合键")
    return {
        "status": "bad",
        "confidence": 1.0,
        "action": "review",
        "reasons": reasons,
        "suggested_file1_columns": [],
        "suggested_file2_columns": [],
        "suggestion_reason": "",
    }


def _localize_llm_reason(text):
    """Convert common English LLM match-review reasons into Chinese UI text."""
    raw = str(text or "").strip()
    if not raw:
        return ""
    lowered = raw.lower()
    translations = []
    if any(k in lowered for k in ("high duplicate", "duplicate rate", "duplicate rates", "not unique")):
        translations.append("当前匹配列重复率较高，唯一性不足")
    if "blank" in lowered or "empty" in lowered:
        translations.append("当前匹配列存在空值")
    if "one-to-many" in lowered or "many-to-one" in lowered:
        translations.append("可能导致一对多或多对一匹配错误")
    if "same asset code" in lowered or "multiple rows" in lowered:
        translations.append("样例显示同一资产编码对应多行记录")
    if "combination" in lowered and ("improve uniqueness" in lowered or "may improve" in lowered):
        translations.append("建议使用组合键以提高唯一性")
    if "asset code" in lowered and "capitalization date" in lowered:
        translations.append("资产编码与资本化日期的组合可能更适合作为匹配列")
    if translations:
        return "；".join(dict.fromkeys(translations))
    return raw


def _fa_review_decision_signature(decision):
    """与 _handle_llm_fa_mapping_review 共享的去重签名，确保相同建议不会重复弹窗。"""
    decision = decision or {}
    current = decision.get("current_mapping") or {}
    suggested = decision.get("suggested_mapping") or {}
    return (
        str(decision.get("role") or ""),
        str(decision.get("issue_type") or ""),
        str(current.get("file1") or ""),
        str(current.get("file2") or ""),
        str(suggested.get("file1") or ""),
        str(suggested.get("file2") or ""),
        bool(decision.get("can_apply")),
    )


def build_fa_mapping_review_decisions(review_items, *, cols1, cols2, current_mapping, role_labels=None, min_confidence=0.55):
    """Normalize FA mapping review suggestions into testable UI decisions."""
    headers = {"file1": set(cols1 or []), "file2": set(cols2 or [])}
    role_labels = role_labels or {}
    current_mapping = current_mapping or {}

    def _get(item, name, default=None):
        if isinstance(item, dict):
            return item.get(name, default)
        return getattr(item, name, default)

    def _side_mapping(value):
        if not isinstance(value, dict):
            return {}
        out = {}
        for side in ("file1", "file2"):
            raw = value.get(side)
            if isinstance(raw, (list, tuple, set)):
                raw = next((part for part in raw if str(part).strip()), "")
            text = str(raw or "").strip()
            if text:
                out[side] = text
        return out

    decisions = []
    for item in review_items or []:
        role = str(_get(item, "issue_field") or _get(item, "role") or "").strip()
        if not role:
            continue
        try:
            confidence = float(_get(item, "confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        if confidence < min_confidence:
            continue

        current = _side_mapping(_get(item, "current_mapping")) or _side_mapping(current_mapping.get(role))
        raw_suggested = _side_mapping(_get(item, "suggested_mapping"))
        suggested = {
            side: col
            for side, col in raw_suggested.items()
            if col in headers.get(side, set())
        }
        reason = str(_get(item, "reason") or _get(item, "review_warning") or "").strip()
        if not suggested and not reason:
            continue

        changes = {
            side: col
            for side, col in suggested.items()
            if current.get(side) != col
        }
        has_change = bool(changes)
        if suggested and not has_change:
            continue
        if not suggested and not reason:
            continue
        can_apply = bool(changes)
        decisions.append(
            {
                "show": True,
                "can_apply": can_apply,
                "has_change": has_change,
                "role": role,
                "label": role_labels.get(role, role),
                "confidence": confidence,
                "issue_type": str(_get(item, "issue_type") or "").strip(),
                "current_mapping": current,
                "suggested_mapping": suggested,
                "apply_mapping": changes if can_apply else {},
                "reason": reason,
            }
        )
    return decisions


def build_fa_mapping_review_dialog_text(decision):
    """Build a user-facing, single-suggestion FA mapping review prompt."""
    decision = decision or {}
    label = decision.get("label") or decision.get("role") or "字段"
    role = decision.get("role") or ""
    issue_type = decision.get("issue_type") or ""
    current = decision.get("current_mapping") or {}
    suggested = decision.get("suggested_mapping") or {}
    apply_mapping = decision.get("apply_mapping") or {}
    raw_reason = str(decision.get("reason") or "").strip()

    def _fmt_mapping(mapping):
        parts = []
        if mapping.get("file1"):
            parts.append(f"文件1：{mapping['file1']}")
        if mapping.get("file2"):
            parts.append(f"文件2：{mapping['file2']}")
        return "；".join(parts) if parts else "未选择"

    def _fmt_apply(mapping):
        parts = []
        if mapping.get("file1"):
            parts.append(f"文件1的“{label}”改为“{mapping['file1']}”")
        if mapping.get("file2"):
            parts.append(f"文件2的“{label}”改为“{mapping['file2']}”")
        return "；".join(parts) if parts else "这条建议没有可自动修改的下拉框，请手动核对。"

    issue_hints = {
        "wrong_column": "当前列名看起来不像这个字段，可能把相近名称的列选进来了。",
        "cross_period_inconsistent": "两边选的列口径可能不一致，后续比较时容易把不同含义的数据放在一起算。",
        "unit_mismatch": "两边选的列单位可能不一致，建议再看一眼。",
        "ambiguous": "当前列名比较接近，但含义不够明确，建议再看一眼。",
    }
    role_hints = {
        "original_value": "原值应对应资产入账原值，不应混用处置原值、原值减少或净值。",
        "depreciation": "累计折旧应对应累计数，不应混用本年折旧、本期折旧或处置折旧。",
        "category": "资产类别应对应分类/大类口径，不应混用资产描述或型号规格。",
        "current_year_dep": "本年折旧应对应当年/本期折旧额，不应混用累计折旧。",
        "disposal_orig": "处置原值应对应减少或处置资产的原值。",
        "disposal_dep": "处置折旧应对应减少或处置资产带走的累计折旧。",
    }
    reason_parts = []
    if raw_reason:
        reason_parts.append(raw_reason)
    if issue_type in issue_hints:
        reason_parts.append(issue_hints[issue_type])
    if role in role_hints:
        reason_parts.append(role_hints[role])
    if not reason_parts:
        reason_parts.append("LLM 根据列名和样例判断，当前映射可能和这个字段的含义不完全一致。")

    can_apply = bool(decision.get("can_apply") and apply_mapping)
    has_change = bool(decision.get("has_change"))
    if can_apply:
        action_line = _fmt_apply(apply_mapping)
        return (
            f"LLM 发现“{label}”可能需要调整。\n\n"
            f"当前选了什么：\n{_fmt_mapping(current)}\n\n"
            f"为什么可能不对：\n" + "；".join(reason_parts) + "\n\n"
            f"建议改成什么：\n{_fmt_mapping(suggested)}\n\n"
            f"采纳后会改哪里：\n{action_line}\n\n"
            "请选择是否采纳建议。采纳后会自动修改对应下拉框；不采纳则保持当前设置。"
        )

    if has_change:
        reference = f"\n\n复核参考：\n{_fmt_mapping(suggested)}"
    else:
        reference = "\n\nLLM 返回的参考列和当前选择一致，当前没有可自动修改的内容。"
    return (
        f"LLM 提示“{label}”建议人工复核。\n\n"
        f"当前选了什么：\n{_fmt_mapping(current)}\n\n"
        f"为什么需要看一眼：\n" + "；".join(reason_parts) +
        f"{reference}\n\n"
        "这条提示不会自动修改设置，请按业务口径复核。"
    )


def _normalize_llm_error_message(message):
    text = str(message or "").strip().strip("；;。 ")
    if not text:
        return ""
    if "未在 chat message.content 中返回正文" in text or "模型返回内容为空" in text or "模型连续返回空内容" in text:
        return "模型返回内容为空，已尝试关闭 JSON 模式并重试；请稍后重试或检查当前模型配置。"
    return text


def _is_llm_empty_response_error(message):
    text = str(message or "")
    return (
        "未在 chat message.content 中返回正文" in text
        or "模型返回内容为空" in text
        or "模型连续返回空内容" in text
        or "未返回工具可读取的正文" in text
    )


def dedupe_llm_error_messages(messages):
    out = []
    seen = set()
    for message in messages or []:
        text = _normalize_llm_error_message(message)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def format_llm_error_parts(parts):
    grouped = []
    index_by_message = {}
    for label, message in parts or []:
        text = _normalize_llm_error_message(message)
        if not text:
            continue
        if text in index_by_message:
            grouped[index_by_message[text]][0].append(label)
        else:
            index_by_message[text] = len(grouped)
            grouped.append(([label], text))
    return [f"{'、'.join(labels)}未完成：{message}" for labels, message in grouped]


def ask_apply_llm_suggestion(parent, title, message):
    """Ask whether to apply an LLM suggestion using plain-language buttons."""
    root = parent.winfo_toplevel() if parent is not None and hasattr(parent, "winfo_toplevel") else None
    if root is None:
        return messagebox.askyesno(title, message)

    result = {"apply": False}
    dialog = tk.Toplevel(root)
    dialog.title(title)
    dialog.transient(root)
    dialog.resizable(False, False)

    frame = ttk.Frame(dialog, padding=(18, 16, 18, 14))
    frame.pack(fill=tk.BOTH, expand=True)
    ttk.Label(frame, text=message, justify=tk.LEFT, wraplength=560).pack(fill=tk.BOTH, expand=True)

    buttons = ttk.Frame(frame)
    buttons.pack(fill=tk.X, pady=(14, 0))

    def choose(value):
        result["apply"] = value
        dialog.destroy()

    ttk.Button(buttons, text="不采纳", command=lambda: choose(False), width=12).pack(side=tk.RIGHT)
    ttk.Button(buttons, text="采纳", command=lambda: choose(True), width=12).pack(side=tk.RIGHT, padx=(0, 8))
    dialog.protocol("WM_DELETE_WINDOW", lambda: choose(False))

    try:
        dialog.grab_set()
        dialog.update_idletasks()
        center_on_parent(dialog, root)
        dialog.wait_window()
    finally:
        try:
            dialog.grab_release()
        except tk.TclError:
            pass
    return result["apply"]


def find_fa_life_column(cols):
    """Pick the best FA useful-life column, avoiding residual value fields."""
    blocked_keywords = ['残值', '原值', '折旧', '减值', '净值', '金额', '价值', '成本', '税额', '账面']
    preferred_keywords = ['使用寿命', '使用寿命(月)', '使用寿命（月）', '预计使用期间数', '使用期间数']
    secondary_keywords = ['预计寿命', '使用年限', '折旧年期', '计划使用年', '计划使用年限', '预计使用年', '预计使用年限']
    fallback_keywords = ['寿命', '年限', '期间数', '使用月份']

    def allowed(col):
        text = str(col)
        return '剩余' not in text and not any(keyword in text for keyword in blocked_keywords)

    for keyword_group in (preferred_keywords, secondary_keywords):
        for col in cols:
            if allowed(col) and str(col) in keyword_group:
                return col

    for keyword_group in (preferred_keywords, secondary_keywords, fallback_keywords):
        for col in cols:
            if allowed(col) and any(keyword in str(col) for keyword in keyword_group):
                return col

    return None


# 资产类别自动映射用关键字。脚本只做通用模式匹配 + 样例值正则嗅探，不写
# 针对具体列名的黑名单——区分"类别名称"列（如 '资产类型描述'，值像 '房屋及建筑物'）
# 与"分类代码"列（如 '资产分类'，值像 'Y110'）的判断全部交给样例值正则。
# 若启发式仍误选，依赖 LLM 复核层抓住并弹窗征求用户采纳。
CATEGORY_NAME_EXACT = ['资产类别', '资产大类', '固定资产类别', '资产类型描述', '资产类型', '类别', '大类']
CATEGORY_NAME_CONTAIN = ['种类', '分类', '资产类型']
CATEGORY_NUMERIC_BLACKLIST = ['原值', '累计折旧', '成本', '净值', '残值', '减值', '折旧', '金额', '价值']
# 短英数字代码形态：可选字母前缀 + 可选分隔符 + 必须含数字 + 末尾允许字母数字/分隔符。
# 覆盖 'Y110' / 'A12-3' / '12345' / 'AB-12' 等 SAP 风格类别代码，拒绝中文与纯字母英文名。
_CATEGORY_CODE_VALUE_PATTERN = re.compile(r'^[A-Za-z]{0,4}[-_.]?\d+[A-Za-z0-9\-_./]*$')


def _is_category_numeric_field(col_str):
    return any(kw in col_str for kw in CATEGORY_NUMERIC_BLACKLIST)


def category_values_look_like_codes(values, *, threshold=0.5):
    """正则判断：列的样例值是否多数像短英数字代码（如 'Y110' / 'A12-3'）。

    这是脚本区分"类别名称列"与"分类代码列"的核心信号——头部名称可能歧义
    （如 '资产分类' 既可能存中文类型名也可能存 SAP 代码），但值形态不会骗人。
    """
    if not values:
        return False
    code_like = 0
    total = 0
    for raw in values:
        text = str(raw).strip()
        if not text:
            continue
        total += 1
        if len(text) <= 12 and _CATEGORY_CODE_VALUE_PATTERN.match(text):
            code_like += 1
    if total == 0:
        return False
    return code_like / total >= threshold


def _category_sample_values(df, col, *, limit=8):
    if df is None or col is None:
        return []
    try:
        if col not in df.columns:
            return []
        return [
            str(v).strip()
            for v in df[col].dropna().astype(str).head(limit).tolist()
            if str(v).strip()
        ]
    except Exception:
        return []


def pick_fa_category_column(cols, *, df=None):
    """挑选资产类别列。

    策略：
    1. 精确匹配 CATEGORY_NAME_EXACT
    2. 包含匹配 CATEGORY_NAME_EXACT + CATEGORY_NAME_CONTAIN（含 '分类' 等通用关键字）

    无论是哪一步命中，若 df 可用，都对样例值跑 ``category_values_look_like_codes``：
    样例像短代码就跳过该候选，继续往下找；不像就接受。

    df 缺失时按头部正则结果接受（启发式不再细判），由 LLM 复核层兜底，让模型
    判断"列名虽含 类别 但值是代码"的情形，并通过 ``ask_apply_llm_suggestion``
    弹窗征求用户采纳。
    """
    cols = [str(c) for c in (cols or [])]

    def _value_sniff_says_code(col):
        if df is None:
            return False
        return category_values_look_like_codes(_category_sample_values(df, col))

    if df is not None:
        scored = []
        for idx, col in enumerate(cols):
            if _is_category_numeric_field(col) or _value_sniff_says_code(col):
                continue
            strong_header_match = (
                col in CATEGORY_NAME_EXACT
                or any(kw in col for kw in CATEGORY_NAME_EXACT + CATEGORY_NAME_CONTAIN)
            )
            ambiguous_description = "资产描述" in col and not strong_header_match
            header_match = strong_header_match or ambiguous_description
            if not header_match:
                continue
            values = _category_sample_values(df, col, limit=500)
            if not values:
                continue
            cjk_short_ratio = sum(1 for v in values if re.search(r"[\u4e00-\u9fff]", v) and len(v) <= 15) / len(values)
            long_ratio = sum(1 for v in values if len(v) > 15) / len(values)
            code_ratio = sum(1 for v in values if len(v) <= 12 and _CATEGORY_CODE_VALUE_PATTERN.match(v)) / len(values)
            unique_count = len(set(values))
            if code_ratio >= 0.5:
                continue
            if ambiguous_description:
                category_terms = ("房屋", "建筑", "机器设备", "办公设备", "电子设备", "运输工具", "车辆", "仪器", "量具", "夹具", "模具", "公用配套", "其他设备")
                term_ratio = sum(1 for v in values if any(term in v for term in category_terms)) / len(values)
                has_long_description_peer = False
                for peer in cols:
                    if peer == col or "描述" not in peer:
                        continue
                    peer_values = _category_sample_values(df, peer, limit=100)
                    if peer_values and sum(1 for v in peer_values if len(v) > 15) / len(peer_values) >= 0.5:
                        has_long_description_peer = True
                        break
                if term_ratio < 0.5 and not has_long_description_peer:
                    continue
            header_score = 0
            if col in ("资产类别", "固定资产类别", "资产大类", "类别", "大类"):
                header_score += 45
            elif "类别" in col or "大类" in col:
                header_score += 35
            elif "类型" in col or "分类" in col:
                header_score += 25
            elif "描述" in col:
                header_score += 12
            shape_score = cjk_short_ratio * 70 - long_ratio * 70 - min(unique_count, 200) * 0.15
            scored.append((header_score + shape_score, -idx, col))
        if scored:
            scored.sort(reverse=True)
            return scored[0][2]

    # 1) 精确匹配。命中后再用样例值嗅探确认；像代码列就跳过。
    for col in cols:
        if col in CATEGORY_NAME_EXACT and not _is_category_numeric_field(col):
            if _value_sniff_says_code(col):
                continue
            return col

    # 2) 包含匹配。把 CATEGORY_NAME_EXACT 也并入关键字集合，
    #    支持 '资产分类描述' 这类组合命名。
    for col in cols:
        if _is_category_numeric_field(col):
            continue
        matched = any(kw in col for kw in CATEGORY_NAME_EXACT + CATEGORY_NAME_CONTAIN)
        if not matched:
            continue
        if _value_sniff_says_code(col):
            continue
        return col
    return None


def pick_fa_name_column(cols, *, df=None, exclude_cols=None):
    """挑选固定资产名称列，优先使用数据形态区分短类别名与长资产描述。"""
    cols = [str(c) for c in (cols or [])]
    exclude = {str(c) for c in (exclude_cols or []) if str(c).strip()}
    exact_keywords = ("固定资产名称", "资产名称", "名称", "资产描述", "资产类型描述")
    contain_keywords = ("名称", "描述", "资产名", "类型描述")

    def _sample(col, limit=500):
        if df is None or col not in getattr(df, "columns", []):
            return []
        try:
            series = df[col].dropna().astype(str).map(lambda v: v.strip())
            return [v for v in series.head(limit).tolist() if v]
        except Exception:
            return []

    def _score(col):
        text = str(col)
        if text in exclude or _is_category_numeric_field(text):
            return None
        if not any(kw in text for kw in exact_keywords + contain_keywords):
            return None
        values = _sample(text)
        header_score = 0
        if text in ("固定资产名称", "资产名称", "名称"):
            header_score += 45
        elif text in ("资产类型描述", "固定资产描述", "资产描述"):
            header_score += 25
        elif "名称" in text:
            header_score += 25
        elif "描述" in text:
            header_score += 18
        if df is None or not values:
            return header_score
        code_ratio = sum(1 for v in values if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-/]{0,11}", v)) / len(values)
        if code_ratio >= 0.6:
            return None
        avg_len = sum(len(v) for v in values) / len(values)
        long_ratio = sum(1 for v in values if len(v) > 15) / len(values)
        unique_count = len(set(values))
        unique_ratio = unique_count / len(values)
        cjk_short_ratio = sum(1 for v in values if re.search(r"[\u4e00-\u9fff]", v) and len(v) <= 15) / len(values)
        shape_score = min(avg_len, 40) * 1.5 + long_ratio * 45 + unique_ratio * 20
        if cjk_short_ratio >= 0.8 and unique_count <= 50 and long_ratio < 0.2:
            shape_score -= 45
        return header_score + shape_score

    scored = []
    for idx, col in enumerate(cols):
        score = _score(col)
        if score is not None:
            scored.append((score, -idx, col))
    if not scored:
        return None
    scored.sort(reverse=True)
    return scored[0][2]


def _dedupe_messages(messages):
    return dedupe_llm_error_messages(messages)


def _normalize_key_part(value):
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        head = text[:-2]
        if head.replace("-", "", 1).isdigit():
            return head
    return " ".join(text.split())


class FileAndMatchConfig(ttk.Frame):
    """文件选择和匹配列配置合并组件"""
    
    def __init__(
        self,
        parent,
        file_handler: FileHandler,
        on_complete=None,
        status_callback=None,
        mode="normal",
        on_back=None,
        on_skip=None
    ):
        super().__init__(parent, padding="10")
        self.file_handler = file_handler
        self.on_complete = on_complete
        self.status_callback = status_callback
        self.mode = mode
        self.on_back = on_back
        self.on_skip = on_skip
        self._llm_mapping_running = False
        self._llm_mapping_assist_scheduled = False
        self._llm_mapping_assist_job = None
        self._last_llm_match_review_signature = None
        # 已经向用户弹过的 LLM 风险提示签名集合，避免重复跳出同样的弹窗。
        # 在文件/工作表变更时（_update_match_columns）清空。
        self._llm_shown_match_review_keys = set()
        self._llm_shown_fa_review_keys = set()
        self._llm_status_spin_job = None
        self._llm_status_spin_index = 0
        self._llm_status_text = ""
        self._llm_status_animating = False
        self._llm_status_mode = ""
        self.llm_status_icon_var = tk.StringVar(value="")
        self.llm_status_var = tk.StringVar(value="")
        
        # 文件路径变量
        self.file1_path_var = tk.StringVar()
        self.file2_path_var = tk.StringVar()
        self.file1_sheet_var = tk.StringVar()
        self.file2_sheet_var = tk.StringVar()
        
        # 匹配列变量（改为列表支持多选）
        self.match_columns1 = []  # 文件1的匹配列列表
        self.match_columns2 = []  # 文件2的匹配列列表
        self._match_columns_auto_default = False
        self.data_type1_var = tk.StringVar(value="auto")
        self.data_type2_var = tk.StringVar(value="auto")
        
        # 原值列变量
        self.original_value_col1_var = tk.StringVar()
        self.original_value_col2_var = tk.StringVar()
        
        # 累计折旧列变量
        self.depreciation_col1_var = tk.StringVar()
        self.depreciation_col2_var = tk.StringVar()
        
        # 新增字段映射变量
        self.category_col1_var = tk.StringVar()  # 资产类别列（文件1）
        self.category_col2_var = tk.StringVar()  # 资产类别列（文件2）
        self.name_col1_var = tk.StringVar()  # 固定资产名称列（文件1）
        self.name_col2_var = tk.StringVar()  # 固定资产名称列（文件2）
        self.date_col1_var = tk.StringVar()  # 入账开始日期列（文件1）
        self.date_col2_var = tk.StringVar()  # 入账开始日期列（文件2）
        self.life_col1_var = tk.StringVar()  # 使用寿命列（文件1）
        self.life_col2_var = tk.StringVar()  # 使用寿命列（文件2）
        self.residual_col1_var = tk.StringVar()  # 残值率列（文件1）
        self.residual_col2_var = tk.StringVar()  # 残值率列（文件2）
        self.current_year_dep_col1_var = tk.StringVar()  # 本年折旧列（文件1）
        self.current_year_dep_col2_var = tk.StringVar()  # 本年折旧列（文件2）
        self.balance_sheet_date_var = tk.StringVar(value="2025/12/31")  # 折旧测算资产负债表日
        self.addition_method_col1_var = tk.StringVar()  # 新增方式（文件1）
        self.addition_method_col2_var = tk.StringVar()  # 新增方式（文件2）
        self.addition_date_col1_var = tk.StringVar()  # 新增时间（文件1）
        self.addition_date_col2_var = tk.StringVar()  # 新增时间（文件2）
        self.disposal_method_col1_var = tk.StringVar()  # 处置方式（文件1）
        self.disposal_method_col2_var = tk.StringVar()  # 处置方式（文件2）
        self.disposal_date_col1_var = tk.StringVar()  # 处置时间（文件1）
        self.disposal_date_col2_var = tk.StringVar()  # 处置时间（文件2）
        self.disposal_orig_col1_var = tk.StringVar()  # 处置原值（文件1）
        self.disposal_orig_col2_var = tk.StringVar()  # 处置原值（文件2）
        self.disposal_dep_col1_var = tk.StringVar()  # 处置折旧（文件1）
        self.disposal_dep_col2_var = tk.StringVar()  # 处置折旧（文件2）
        
        # 标题行索引（用于处理首行为空的情况）
        self.file1_header_row = 0
        self.file2_header_row = 0
        
        self._create_widgets()
    
    def _get_file_display_name(self, file_num):
        """获取文件显示名称：原始文件 & sheet名称"""
        if file_num == 1:
            path = self.file1_path_var.get()
            sheet = self.file1_sheet_var.get()
        else:
            path = self.file2_path_var.get()
            sheet = self.file2_sheet_var.get()
        
        if not path:
            # 如果没有路径，返回默认名称（但应该避免这种情况）
            return f"原始文件{file_num}"
        
        # 获取文件名（不含路径）
        import os
        file_name = os.path.basename(path)
        
        # 如果有sheet，显示"文件名 & sheet名称"；如果没有sheet（CSV文件），只显示文件名
        if sheet:
            return f"{file_name} & {sheet}"
        else:
            # CSV文件没有sheet，只显示文件名
            return file_name

    @staticmethod
    def _shorten_for_ui(text: str, max_len: int = 16) -> str:
        """将较长文本截断为适合标签显示的短文本，避免挤压布局。"""
        if text is None:
            return ""
        text = str(text).strip()
        if len(text) <= max_len:
            return text
        return text[: max_len - 2] + ".."
    
    def _create_widgets(self):
        """创建界面组件"""
        is_supplement_mode = self.mode == "supplement"
        # 说明文字
        self.info_label = ttk.Label(
            self,
            text="如有新增清单/处置清单，请选择文件并配置映射；没有补充清单可直接跳过。"
            if is_supplement_mode
            else "选择文件并配置匹配列（右键预览表格任意行可设为标题行）",
            font=("Arial", 10)
        )
        self.info_label.pack(pady=(0, 10))

        self.llm_status_frame = ttk.Frame(self)
        self.llm_status_icon_label = ttk.Label(
            self.llm_status_frame,
            textvariable=self.llm_status_icon_var,
            font=("Arial", 12, "bold"),
            foreground=ERROR,
            width=5,
        )
        self.llm_status_icon_label.pack(side=tk.LEFT, padx=(0, 2))
        self.llm_status_label = ttk.Label(
            self.llm_status_frame,
            textvariable=self.llm_status_var,
            font=("Arial", 10, "bold"),
            foreground=ERROR,
            wraplength=900,
            justify=tk.LEFT,
        )
        self.llm_status_label.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.llm_status_frame.pack(fill=tk.X, pady=(0, 8))
        self.llm_status_frame.pack_forget()
        
        # 【重要】按钮区域必须先pack，使用side=BOTTOM，这样它会固定在底部
        button_frame = ttk.Frame(self)
        button_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=10)
        
        next_btn = ttk.Button(
            button_frame,
            text="下一步：应用补充映射 >>" if self.mode == "supplement" else "下一步：执行合并 >>",
            command=self._on_next,
            width=25
        )
        next_btn.pack(side=tk.LEFT, pady=5)

        if is_supplement_mode:
            if callable(self.on_back):
                ttk.Button(
                    button_frame,
                    text="<< 返回上一步",
                    command=self.on_back,
                    width=12
                ).pack(side=tk.LEFT, padx=(8, 0), pady=5)
            if callable(self.on_skip):
                ttk.Button(
                    button_frame,
                    text="无补充清单，跳过",
                    command=self.on_skip,
                    width=16
                ).pack(side=tk.LEFT, padx=(8, 0), pady=5)
        
        def _open_mailto(subject: str, body: str):
            to = "John.SX.Yan@cn.ey.com;melody.bt.liu@cn.ey.com;april.yl.wang@cn.ey.com"
            url = f"mailto:{to}?subject={quote(subject, safe='')}&body={quote(body, safe='')}"
            try:
                webbrowser.open(url)
            except Exception:
                pass
        
        links_frame = ttk.Frame(button_frame)
        links_frame.pack(side=tk.RIGHT, padx=(8, 0))
        
        lbl_like = ttk.Label(links_frame, text="认可", cursor="hand2", style="Link.TLabel")
        lbl_like.pack(side=tk.LEFT, padx=(0, 14))
        lbl_like.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 点赞反馈", "整体使用体验良好，点赞！"))
        
        lbl_suggest = ttk.Label(links_frame, text="建议", cursor="hand2", style="Link.TLabel")
        lbl_suggest.pack(side=tk.LEFT)
        lbl_suggest.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 功能建议", "我的建议如下："))
        
        # 主容器：左右列使用固定比例分配，避免导入后被长路径或预览表格撑宽。
        main_container = ttk.Frame(self)
        main_container.pack(fill=tk.BOTH, expand=True, pady=(0, 5))

        left_container = ttk.Frame(main_container)
        right_container = ttk.Frame(main_container)

        def _layout_main_columns(event=None):
            total_width = main_container.winfo_width()
            total_height = main_container.winfo_height()
            if total_width <= 1 or total_height <= 1:
                return
            # 优先保证左侧文件路径、浏览按钮和工作表下拉框都可见；右侧映射区自带滚动条。
            left_min = 560 if total_width >= 1180 else (500 if total_width >= 1000 else 430)
            desired_right = min(740, max(500, int(total_width * 0.44)))
            right_width = min(desired_right, max(360, total_width - left_min - 8))
            if total_width < 1180:
                right_width = min(max(460, int(total_width * 0.46)), max(340, total_width - left_min - 8))
            left_width = max(1, total_width - right_width - 8)
            left_container.place(x=0, y=0, width=left_width, height=total_height)
            right_container.place(x=left_width + 8, y=0, width=right_width, height=total_height)

        main_container.bind("<Configure>", _layout_main_columns)

        left_container.columnconfigure(0, weight=1)
        left_container.rowconfigure(0, weight=0, minsize=100)
        left_container.rowconfigure(1, weight=1, minsize=300)
        right_container.columnconfigure(0, weight=1)
        right_container.rowconfigure(0, weight=0, minsize=130)
        right_container.rowconfigure(1, weight=1, minsize=300)
        
        # ==================== 左上：文件选择区域 ====================
        file_frame = ttk.LabelFrame(left_container, text="文件选择", padding="5")
        file_frame.grid_propagate(False)  # 锁定区域大小（必须在grid之前设置，避免初始布局受子控件影响）
        file_frame.grid(row=0, column=0, sticky="nsew", padx=(5, 2), pady=(0, 2))
        
        # 添加提示信息
        tip_label = ttk.Label(
            file_frame,
            text="提示：文件1导入新增清单，文件2导入处置清单；匹配列请选择唯一识别码" if is_supplement_mode else "提示：文件1导入年初清单，文件2导入年末清单，顺序别反了",
            font=("Arial", 8),
            foreground=ERROR
        )
        tip_label.pack(pady=(0, 3), anchor=tk.W)
        
        # 文件1
        file1_frame = ttk.Frame(file_frame)
        file1_frame.pack(fill=tk.X, pady=2)
        file1_frame.columnconfigure(1, weight=1, minsize=60)
        
        self.file1_label = ttk.Label(file1_frame, text="新增清单:" if is_supplement_mode else "文件1:", width=6)
        self.file1_label.grid(row=0, column=0, sticky="w", padx=(0, 2))
        file1_entry = ttk.Entry(file1_frame, textvariable=self.file1_path_var, width=10)
        file1_entry.grid(row=0, column=1, sticky="ew", padx=2)
        file1_browse_btn = ttk.Button(file1_frame, text="浏览...", command=self._select_file1, width=6)
        file1_browse_btn._compact_width = True
        file1_browse_btn.grid(row=0, column=2, sticky="ew", padx=2)
        ttk.Label(file1_frame, text="表:", width=3).grid(row=0, column=3, sticky="e", padx=(4, 1))
        self.file1_sheet_combo = ttk.Combobox(file1_frame, textvariable=self.file1_sheet_var, state="readonly", width=8)
        self.file1_sheet_combo.grid(row=0, column=4, sticky="ew", padx=(1, 0))
        self.file1_sheet_combo.bind('<<ComboboxSelected>>', lambda e: self._load_file1())
        
        # 文件2
        file2_frame = ttk.Frame(file_frame)
        file2_frame.pack(fill=tk.X, pady=2)
        file2_frame.columnconfigure(1, weight=1, minsize=60)
        
        self.file2_label = ttk.Label(file2_frame, text="处置清单:" if is_supplement_mode else "文件2:", width=6)
        self.file2_label.grid(row=0, column=0, sticky="w", padx=(0, 2))
        file2_entry = ttk.Entry(file2_frame, textvariable=self.file2_path_var, width=10)
        file2_entry.grid(row=0, column=1, sticky="ew", padx=2)
        file2_browse_btn = ttk.Button(file2_frame, text="浏览...", command=self._select_file2, width=6)
        file2_browse_btn._compact_width = True
        file2_browse_btn.grid(row=0, column=2, sticky="ew", padx=2)
        ttk.Label(file2_frame, text="表:", width=3).grid(row=0, column=3, sticky="e", padx=(4, 1))
        self.file2_sheet_combo = ttk.Combobox(file2_frame, textvariable=self.file2_sheet_var, state="readonly", width=8)
        self.file2_sheet_combo.grid(row=0, column=4, sticky="ew", padx=(1, 0))
        self.file2_sheet_combo.bind('<<ComboboxSelected>>', lambda e: self._load_file2())
        
        # ==================== 右上：匹配列配置区域 ====================
        match_frame = ttk.LabelFrame(right_container, text="匹配列配置（按ctrl可多选）", padding="5")
        match_frame.grid_propagate(False)  # 锁定区域大小（必须在grid之前设置，避免初始布局受子控件影响）
        match_frame.grid(row=0, column=0, sticky="nsew", padx=(2, 5), pady=(0, 2))
        
        match_col_frame = ttk.Frame(match_frame)
        match_col_frame.pack(fill=tk.BOTH, expand=True, pady=2)
        
        # 文件1匹配列
        file1_match_frame = ttk.Frame(match_col_frame)
        file1_match_frame.pack(fill=tk.X, pady=1)
        ttk.Label(file1_match_frame, text="文件1:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col1_button = ttk.Button(file1_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 1), width=12)
        self.match_col1_button.pack(side=tk.LEFT, padx=2)
        def update_button1_text():
            if self.match_columns1:
                self.match_col1_button.config(text=f"已选{len(self.match_columns1)}列 ▼")
            else:
                self.match_col1_button.config(text="选择匹配列...")
        self._update_match_col1_button = update_button1_text
        self.match_col1_selected_label = ttk.Label(file1_match_frame, text="已选择: 无", foreground=PRIMARY, wraplength=180, justify=tk.LEFT, font=("Arial", 8))
        self.match_col1_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col1_listbox = tk.Listbox(file1_match_frame, height=0)
        self.match_col1_listbox.pack_forget()
        
        # 文件2匹配列
        file2_match_frame = ttk.Frame(match_col_frame)
        file2_match_frame.pack(fill=tk.X, pady=1)
        ttk.Label(file2_match_frame, text="文件2:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col2_button = ttk.Button(file2_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 2), width=12)
        self.match_col2_button.pack(side=tk.LEFT, padx=2)
        def update_button2_text():
            if self.match_columns2:
                self.match_col2_button.config(text=f"已选{len(self.match_columns2)}列 ▼")
            else:
                self.match_col2_button.config(text="选择匹配列...")
        self._update_match_col2_button = update_button2_text
        self.match_col2_selected_label = ttk.Label(file2_match_frame, text="已选择: 无", foreground=PRIMARY, wraplength=180, justify=tk.LEFT, font=("Arial", 8))
        self.match_col2_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col2_listbox = tk.Listbox(file2_match_frame, height=0)
        self.match_col2_listbox.pack_forget()
        
        # 数据类型
        data_type_frame = ttk.Frame(match_frame)
        data_type_frame.pack(fill=tk.X, pady=2)
        ttk.Label(data_type_frame, text="数据类型:", width=8).pack(side=tk.LEFT, padx=2)
        ttk.Combobox(data_type_frame, textvariable=self.data_type1_var, values=["auto", "text", "number", "date"], state="readonly", width=8).pack(side=tk.LEFT, padx=2)
        ttk.Label(data_type_frame, text="文件2:", width=6).pack(side=tk.LEFT, padx=2)
        ttk.Combobox(data_type_frame, textvariable=self.data_type2_var, values=["auto", "text", "number", "date"], state="readonly", width=8).pack(side=tk.LEFT, padx=2)
        
        # ==================== 左下：文件预览区域 ====================
        preview_frame = ttk.LabelFrame(left_container, text="文件预览（底部滚动条或 Shift+滚轮 可左右滑动）", padding="5")
        preview_frame.grid_propagate(False)  # 锁定区域大小（必须在grid之前设置，避免初始布局受子控件影响）
        preview_frame.grid(row=1, column=0, sticky="nsew", padx=(5, 2), pady=(2, 0))
        
        self.preview_notebook = ttk.Notebook(preview_frame)
        self.preview_notebook.pack(fill=tk.BOTH, expand=True)
        
        # 文件1预览（先 pack 底部横向滚动条，再 pack 表格区，这样横向条才能可见）
        file1_preview_frame = ttk.Frame(self.preview_notebook)
        self.file1_preview_tab_text = "新增清单" if is_supplement_mode else "原始文件1"
        self.preview_notebook.add(file1_preview_frame, text=self.file1_preview_tab_text)
        file1_h_scroll = ttk.Scrollbar(file1_preview_frame, orient=tk.HORIZONTAL)
        file1_h_scroll.pack(side=tk.BOTTOM, fill=tk.X, pady=(2, 0))
        file1_table_frame = ttk.Frame(file1_preview_frame)
        file1_table_frame.pack(fill=tk.BOTH, expand=True)
        self.file1_tree = ttk.Treeview(file1_table_frame, height=15, show='headings')
        self.file1_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.file1_tree.configure(selectmode='extended')
        file1_v_scroll = ttk.Scrollbar(file1_table_frame, orient=tk.VERTICAL, command=self.file1_tree.yview)
        file1_v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.file1_tree.configure(yscrollcommand=file1_v_scroll.set)
        file1_h_scroll.config(command=self.file1_tree.xview)
        self.file1_tree.configure(xscrollcommand=file1_h_scroll.set)
        
        # 文件2预览（同样先 pack 底部横向滚动条）
        file2_preview_frame = ttk.Frame(self.preview_notebook)
        self.file2_preview_tab_text = "处置清单" if is_supplement_mode else "原始文件2"
        self.preview_notebook.add(file2_preview_frame, text=self.file2_preview_tab_text)
        file2_h_scroll = ttk.Scrollbar(file2_preview_frame, orient=tk.HORIZONTAL)
        file2_h_scroll.pack(side=tk.BOTTOM, fill=tk.X, pady=(2, 0))
        file2_table_frame = ttk.Frame(file2_preview_frame)
        file2_table_frame.pack(fill=tk.BOTH, expand=True)
        self.file2_tree = ttk.Treeview(file2_table_frame, height=15, show='headings')
        self.file2_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.file2_tree.configure(selectmode='extended')
        file2_v_scroll = ttk.Scrollbar(file2_table_frame, orient=tk.VERTICAL, command=self.file2_tree.yview)
        file2_v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.file2_tree.configure(yscrollcommand=file2_v_scroll.set)
        file2_h_scroll.config(command=self.file2_tree.xview)
        self.file2_tree.configure(xscrollcommand=file2_h_scroll.set)
        
        # 绑定右键菜单到预览表格
        self.file1_tree.bind('<Button-3>', lambda e: self._show_header_row_menu(e, 1))
        self.file2_tree.bind('<Button-3>', lambda e: self._show_header_row_menu(e, 2))
        
        # 绑定 Shift+滚轮 为横向滚动，便于列多时左右查看
        def _on_shift_wheel_hscroll(tree, event):
            try:
                delta = int(-1 * (event.delta / 120)) if hasattr(event, 'delta') else 0
                if delta != 0:
                    tree.xview_scroll(delta, 'units')
                    return 'break'
            except Exception:
                pass
        self.file1_tree.bind('<Shift-MouseWheel>', lambda e: _on_shift_wheel_hscroll(self.file1_tree, e))
        self.file2_tree.bind('<Shift-MouseWheel>', lambda e: _on_shift_wheel_hscroll(self.file2_tree, e))
        
        # ==================== 右下：字段映射配置区域 ====================
        mapping_frame = ttk.LabelFrame(right_container, text="字段映射配置（自动预映射，可手动调整）", padding="5")
        mapping_frame.grid_propagate(False)  # 锁定区域大小（必须在grid之前设置，避免初始布局受子控件影响）
        mapping_frame.grid(row=1, column=0, sticky="nsew", padx=(2, 5), pady=(2, 0))

        # 取 ttk 主题的 Frame 背景色，保证 canvas 与 ttk 控件视觉一致
        # （Toplevel 与 Tk 根窗口共享同一 Tcl 解释器，但 canvas 默认背景在不同宿主下
        #   渲染上下文有差异，显式指定可消除差异并避免 Combobox 退化为按钮外观）
        _style = ttk.Style()
        _canvas_bg = _style.lookup('TFrame', 'background') or 'SystemButtonFace'

        mapping_canvas = tk.Canvas(
            mapping_frame,
            bg=_canvas_bg,
            highlightthickness=0,
            bd=0,
        )
        mapping_hscrollbar = ttk.Scrollbar(mapping_frame, orient=tk.HORIZONTAL, command=mapping_canvas.xview)
        mapping_scrollbar = ttk.Scrollbar(mapping_frame, orient=tk.VERTICAL, command=mapping_canvas.yview)
        mapping_canvas.configure(xscrollcommand=mapping_hscrollbar.set, yscrollcommand=mapping_scrollbar.set)
        mapping_hscrollbar.pack(side=tk.BOTTOM, fill=tk.X)
        mapping_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        mapping_canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        mapping_inner = ttk.Frame(mapping_canvas)
        _mapping_window = mapping_canvas.create_window((0, 0), window=mapping_inner, anchor='nw')

        def _update_mapping_scrollregion(event=None, canvas=mapping_canvas, win_id=_mapping_window):
            required_width = mapping_inner.winfo_reqwidth()
            canvas_width = canvas.winfo_width()
            canvas.itemconfig(win_id, width=max(required_width, canvas_width))
            canvas.configure(scrollregion=canvas.bbox("all"))

        def _on_canvas_resize(event, canvas=mapping_canvas, win_id=_mapping_window):
            required_width = mapping_inner.winfo_reqwidth()
            canvas.itemconfig(win_id, width=max(required_width, event.width))
            canvas.configure(scrollregion=canvas.bbox("all"))

        mapping_canvas.bind('<Configure>', _on_canvas_resize)
        mapping_inner.bind('<Configure>', _update_mapping_scrollregion)
        mapping_canvas.bind('<Shift-MouseWheel>', lambda e: mapping_canvas.xview_scroll(int(-1 * (e.delta / 120)), "units"))
        self.mapping_row_frames = {}
        self.mapping_row_controls = {}
        
        # 固定宽度的下拉框
        COMBO_WIDTH = 15
        
        def create_mapping_row(parent, label_text, var1, var2, col_type):
            row_frame = ttk.Frame(parent)
            row_frame.pack(fill=tk.X, pady=2, padx=5)
            label_widget = ttk.Label(row_frame, text=label_text, width=14)
            label_widget.pack(side=tk.LEFT, padx=(0, 5))
            combo1 = ttk.Combobox(row_frame, textvariable=var1, state="readonly", width=COMBO_WIDTH)
            combo1.pack(side=tk.LEFT, padx=(0, 10))
            combo1.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 1))
            combo2 = ttk.Combobox(row_frame, textvariable=var2, state="readonly", width=COMBO_WIDTH)
            combo2.pack(side=tk.LEFT, padx=(0, 5))
            combo2.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 2))
            self.mapping_row_frames[col_type] = row_frame
            self.mapping_row_controls[col_type] = {"label": label_widget, "combo1": combo1, "combo2": combo2}
            return combo1, combo2
        
        # 标题行
        header_frame = ttk.Frame(mapping_inner)
        header_frame.pack(fill=tk.X, pady=2, padx=5)
        ttk.Label(header_frame, text="映射字段", width=14, font=("Arial", 9, "bold")).pack(side=tk.LEFT, padx=(0, 5))
        self.mapping_file1_label = ttk.Label(header_frame, text="新增清单" if is_supplement_mode else "原始文件1", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file1_label.pack(side=tk.LEFT, padx=(0, 10))
        self.mapping_file2_label = ttk.Label(header_frame, text="处置清单" if is_supplement_mode else "原始文件2", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file2_label.pack(side=tk.LEFT, padx=(0, 5))
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        
        self.category_col1_combo, self.category_col2_combo = create_mapping_row(mapping_inner, "资产类别:", self.category_col1_var, self.category_col2_var, 'category')
        self.name_col1_combo, self.name_col2_combo = create_mapping_row(mapping_inner, "固定资产名称:", self.name_col1_var, self.name_col2_var, 'name')
        self.date_col1_combo, self.date_col2_combo = create_mapping_row(mapping_inner, "入账开始日期:", self.date_col1_var, self.date_col2_var, 'date')
        self.life_col1_combo, self.life_col2_combo = create_mapping_row(mapping_inner, "使用寿命(月):", self.life_col1_var, self.life_col2_var, 'life')
        self.residual_col1_combo, self.residual_col2_combo = create_mapping_row(mapping_inner, "残值率:", self.residual_col1_var, self.residual_col2_var, 'residual')
        self.current_year_dep_col1_combo, self.current_year_dep_col2_combo = create_mapping_row(mapping_inner, "本年折旧:", self.current_year_dep_col1_var, self.current_year_dep_col2_var, 'current_year_dep')
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        
        self.orig_col1_combo, self.orig_col2_combo = create_mapping_row(mapping_inner, "原值:", self.original_value_col1_var, self.original_value_col2_var, 'original_value')
        self.dep_col1_combo, self.dep_col2_combo = create_mapping_row(mapping_inner, "累计折旧:", self.depreciation_col1_var, self.depreciation_col2_var, 'depreciation')
        self.addition_method_col1_combo, self.addition_method_col2_combo = create_mapping_row(mapping_inner, "新增方式:", self.addition_method_col1_var, self.addition_method_col2_var, 'addition_method')
        self.addition_date_col1_combo, self.addition_date_col2_combo = create_mapping_row(mapping_inner, "新增时间:", self.addition_date_col1_var, self.addition_date_col2_var, 'addition_date')
        self.disposal_method_col1_combo, self.disposal_method_col2_combo = create_mapping_row(mapping_inner, "处置方式:", self.disposal_method_col1_var, self.disposal_method_col2_var, 'disposal_method')
        self.disposal_date_col1_combo, self.disposal_date_col2_combo = create_mapping_row(mapping_inner, "处置时间:", self.disposal_date_col1_var, self.disposal_date_col2_var, 'disposal_date')
        self.disposal_orig_col1_combo, self.disposal_orig_col2_combo = create_mapping_row(mapping_inner, "处置原值:", self.disposal_orig_col1_var, self.disposal_orig_col2_var, 'disposal_orig')
        self.disposal_dep_col1_combo, self.disposal_dep_col2_combo = create_mapping_row(mapping_inner, "处置折旧:", self.disposal_dep_col1_var, self.disposal_dep_col2_var, 'disposal_dep')
        
        ttk.Separator(mapping_inner, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=3)
        self.depreciation_param_frame = ttk.Frame(mapping_inner)
        self.depreciation_param_frame.pack(fill=tk.X, pady=2, padx=5)
        ttk.Label(self.depreciation_param_frame, text="资产负债表日:", width=14).pack(side=tk.LEFT, padx=(0, 5))
        self.balance_sheet_date_entry = ttk.Entry(self.depreciation_param_frame, textvariable=self.balance_sheet_date_var, width=15)
        self.balance_sheet_date_entry.pack(side=tk.LEFT, padx=(0, 8))
        ttk.Label(self.depreciation_param_frame, text="用于导出折旧测算公式，格式 YYYY/MM/DD", font=("Arial", 8), foreground=MUTED_TEXT).pack(side=tk.LEFT)

        if is_supplement_mode:
            file1_allowed = {'addition_method', 'addition_date'}
            file2_allowed = {'disposal_method', 'disposal_date', 'disposal_orig', 'disposal_dep'}
            visible_rows = file1_allowed | file2_allowed
            for row_type, row_widget in self.mapping_row_frames.items():
                if row_type not in visible_rows:
                    row_widget.pack_forget()
                    continue
                ctrls = self.mapping_row_controls.get(row_type, {})
                combo1 = ctrls.get("combo1")
                combo2 = ctrls.get("combo2")
                if combo1 is not None:
                    if row_type in file1_allowed:
                        combo1.configure(state="readonly")
                    else:
                        combo1.set("")
                        combo1.configure(state="disabled")
                if combo2 is not None:
                    if row_type in file2_allowed:
                        combo2.configure(state="readonly")
                    else:
                        combo2.set("")
                        combo2.configure(state="disabled")
            self.depreciation_param_frame.pack_forget()
        else:
            hide_rows = {'addition_method', 'addition_date', 'disposal_method', 'disposal_date', 'disposal_orig', 'disposal_dep'}
            for row_type in hide_rows:
                row_widget = self.mapping_row_frames.get(row_type)
                if row_widget is not None:
                    row_widget.pack_forget()
            self.current_year_dep_col1_var.set("")
            self.current_year_dep_col1_combo.set("")
            self.current_year_dep_col1_combo.configure(state="disabled")
        
        mapping_inner.update_idletasks()
        mapping_canvas.configure(scrollregion=mapping_canvas.bbox('all'))

        # 当内部 Frame 尺寸变化时更新 scrollregion
        def _update_scrollregion(event):
            _update_mapping_scrollregion(event)
        mapping_inner.bind('<Configure>', _update_scrollregion)
        
        def on_mousewheel(event):
            mapping_canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
            return "break"
        mapping_canvas.bind("<MouseWheel>", on_mousewheel)
    
    def _select_file1(self):
        """选择原始文件1"""
        file_path = filedialog.askopenfilename(
            title="选择文件",
            filetypes=[
                ("所有支持格式", "*.xlsx *.xls *.csv"),
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file1_path_var.set(file_path)
            # 确保变量已更新后再更新标签
            self.update_idletasks()  # 确保Tkinter变量已更新
            self._update_file_labels()
            self._load_file1_sheets(file_path)
            # 不立即加载，等待用户选择sheet
    
    def _select_file2(self):
        """选择原始文件2"""
        file_path = filedialog.askopenfilename(
            title="选择文件",
            filetypes=[
                ("所有支持格式", "*.xlsx *.xls *.csv"),
                ("Excel文件", "*.xlsx *.xls"),
                ("CSV文件", "*.csv"),
                ("所有文件", "*.*")
            ]
        )
        
        if file_path:
            self.file2_path_var.set(file_path)
            # 确保变量已更新后再更新标签
            self.update_idletasks()  # 确保Tkinter变量已更新
            self._update_file_labels()
            self._load_file2_sheets(file_path)
            # 不立即加载，等待用户选择sheet
    
    def _load_file1_sheets(self, file_path: str):
        """加载文件1的工作表列表"""
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
        file_name = os.path.basename(file_path)
        ttk.Label(progress_window, text=f"正在识别{file_name}格式，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中获取工作表列表
        def get_sheets_task():
            try:
                if ext in ['.xlsx', '.xls']:
                    if self.status_callback:
                        self.after(0, lambda: self.status_callback(f"正在识别{file_name}格式，请稍候..."))
                    success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
                    self.after(0, lambda: self._on_sheets_loaded(1, success, error_msg, sheets, progress_window))
                else:
                    # CSV文件，直接加载
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: self._load_file1())
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda msg=error_msg: messagebox.showerror("错误", f"获取工作表列表失败:\n{msg}"))
        
        threading.Thread(target=get_sheets_task, daemon=True).start()
    
    def _on_sheets_loaded(self, file_num, success, error_msg, sheets, progress_window):
        """工作表列表加载完成回调"""
        progress_window.destroy()
        
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._on_sheets_loaded.entry", message="sheets loaded callback", data={"file_num": file_num, "success": success, "sheets_count": len(sheets) if sheets else 0, "sheets": sheets[:5] if sheets else []})
        # #endregion
        
        if file_num == 1:
            if success and sheets:
                self.file1_sheet_combo['values'] = sheets
                # 工作表选择框已经在file1_frame中，不需要单独pack
                # 更新标签显示（即使还没选择sheet，也显示文件名）
                self._update_file_labels()
                # 提示用户选择sheet
                file_display_name = self._get_file_display_name(1)
                if len(sheets) > 1:
                    messagebox.showinfo("提示", f"请为{file_display_name}选择工作表（当前有{len(sheets)}个工作表）")
                else:
                    # 如果只有一个sheet，自动选择并加载
                    self.file1_sheet_var.set(sheets[0])
                    self._load_file1()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file1()
        else:
            if success and sheets:
                self.file2_sheet_combo['values'] = sheets
                # 工作表选择框已经在file2_frame中，不需要单独pack
                # 更新标签显示（即使还没选择sheet，也显示文件名）
                self._update_file_labels()
                # 提示用户选择sheet
                file_display_name = self._get_file_display_name(2)
                if len(sheets) > 1:
                    messagebox.showinfo("提示", f"请为{file_display_name}选择工作表（当前有{len(sheets)}个工作表）")
                else:
                    # 如果只有一个sheet，自动选择并加载
                    self.file2_sheet_var.set(sheets[0])
                    self._load_file2()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file2()
    
    def _load_file2_sheets(self, file_path: str):
        """加载文件2的工作表列表"""
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
        file_name = os.path.basename(file_path)
        ttk.Label(progress_window, text=f"正在识别{file_name}格式，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中获取工作表列表
        def get_sheets_task():
            try:
                if ext in ['.xlsx', '.xls']:
                    if self.status_callback:
                        self.after(0, lambda: self.status_callback(f"正在识别{file_name}格式，请稍候..."))
                    success, error_msg, sheets = self.file_handler.get_excel_sheets(file_path)
                    self.after(0, lambda: self._on_sheets_loaded(2, success, error_msg, sheets, progress_window))
                else:
                    # CSV文件，直接加载
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: self._load_file2())
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda msg=error_msg: messagebox.showerror("错误", f"获取工作表列表失败:\n{msg}"))
        
        threading.Thread(target=get_sheets_task, daemon=True).start()
    
    def _load_file1(self):
        """加载文件1"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        file_path = self.file1_path_var.get()
        if not file_path:
            return
        
        file_display_name = self._get_file_display_name(1)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            sheet_name = self.file1_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file1.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
        ttk.Label(progress_window, text=f"正在读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在读取{file_display_name}，请稍候...")
        
        sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
        # 使用file1_header_row作为header参数
        # file1_header_row初始值为0，表示使用默认第一行作为标题行（header=None）
        # 如果用户通过右键设置了标题行，file1_header_row会是预览中的行索引（0-based数据行）
        # 需要转换为文件的0-based行索引：header_0based = row_index + 1
        header_row = getattr(self, 'file1_header_row', 0)
        # 如果header_row为0，使用None（pandas默认第一行作为标题行）
        # 如果header_row > 0，说明用户设置了标题行，需要转换为文件的0-based索引
        header_0based = None if header_row == 0 else (header_row + 1)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._load_file1.entry", message="loading file1", data={"file_path": file_path, "sheet_name": sheet_name, "header_row": header_row, "header_0based": header_0based})
        # #endregion
        
        # 在后台线程中加载文件
        def load_task():
            try:
                success, error_msg = self.file_handler.set_file1(file_path, sheet_name, header_0based)
                self.after(0, lambda: self._on_file1_loaded(success, error_msg, file_display_name, progress_window))
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda msg=error_msg: self._on_file1_loaded(False, msg, file_display_name, progress_window))
        
        threading.Thread(target=load_task, daemon=True).start()
    
    def _on_file1_loaded(self, success, error_msg, file_display_name, progress_window):
        """文件1加载完成回调"""
        progress_window.destroy()
        
        if success:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.success", message="file1 loaded", data={"rows": len(self.file_handler.file1_df) if self.file_handler.file1_df is not None else 0, "cols": len(self.file_handler.file1_df.columns) if self.file_handler.file1_df is not None else 0, "columns": list(self.file_handler.file1_df.columns)[:5] if self.file_handler.file1_df is not None else [], "first_row_sample": list(self.file_handler.file1_df.iloc[0, :5]) if self.file_handler.file1_df is not None and len(self.file_handler.file1_df) > 0 else []})
            # #endregion
            
            # 检查标题行识别是否正确（如果列名看起来像数据值，可能需要调整）
            if self.file_handler.file1_df is not None and len(self.file_handler.file1_df.columns) > 0:
                first_col_name = str(self.file_handler.file1_df.columns[0])
                # 如果列名看起来像数据值（包含逗号、数字、日期格式等），可能是标题行识别错误
                looks_like_data = (
                    ',' in first_col_name or  # 包含逗号（如"固定资产,电子设备"）
                    (len(first_col_name) > 0 and first_col_name[0].isdigit()) or  # 以数字开头
                    len(first_col_name) > 50  # 列名过长
                )
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                # #endregion
                if looks_like_data:
                    # 提示用户可能需要设置标题行
                    messagebox.showwarning("提示", f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。")
            
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取完成")
            # 立即更新标签，确保sheet变量已设置
            self._update_file_labels()
            self._update_file1_preview()
            self._update_match_columns()
        else:
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取失败")
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._on_file1_loaded.failed", message="file1 load failed", data={"error": error_msg})
            # #endregion
            messagebox.showerror("错误", f"加载{file_display_name}失败:\n{error_msg}")
    
    def _load_file2(self):
        """加载文件2"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        #endregion
        
        file_path = self.file2_path_var.get()
        if not file_path:
            return
        
        file_display_name = self._get_file_display_name(2)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            sheet_name = self.file2_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file2.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
        ttk.Label(progress_window, text=f"正在读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在读取{file_display_name}，请稍候...")
        
        sheet_name = self.file2_sheet_var.get() if self.file2_sheet_var.get() else None
        # 使用file2_header_row作为header参数
        # file2_header_row初始值为0，表示使用默认第一行作为标题行（header=None）
        # 如果用户通过右键设置了标题行，file2_header_row会是预览中的行索引（0-based数据行）
        # 需要转换为文件的0-based行索引：header_0based = row_index + 1
        header_row = getattr(self, 'file2_header_row', 0)
        # 如果header_row为0，使用None（pandas默认第一行作为标题行）
        # 如果header_row > 0，说明用户设置了标题行，需要转换为文件的0-based索引
        header_0based = None if header_row == 0 else (header_row + 1)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._load_file2.entry", message="loading file2", data={"file_path": file_path, "sheet_name": sheet_name, "header_row": header_row, "header_0based": header_0based})
        # #endregion
        
        # 在后台线程中加载文件
        def load_task():
            try:
                success, error_msg = self.file_handler.set_file2(file_path, sheet_name, header_0based)
                self.after(0, lambda: self._on_file2_loaded(success, error_msg, file_display_name, progress_window))
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda msg=error_msg: self._on_file2_loaded(False, msg, file_display_name, progress_window))
        
        threading.Thread(target=load_task, daemon=True).start()
    
    def _on_file2_loaded(self, success, error_msg, file_display_name, progress_window):
        """文件2加载完成回调"""
        progress_window.destroy()
        
        if success:
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.success", message="file2 loaded", data={"rows": len(self.file_handler.file2_df) if self.file_handler.file2_df is not None else 0, "cols": len(self.file_handler.file2_df.columns) if self.file_handler.file2_df is not None else 0, "columns": list(self.file_handler.file2_df.columns)[:5] if self.file_handler.file2_df is not None else [], "first_row_sample": list(self.file_handler.file2_df.iloc[0, :5]) if self.file_handler.file2_df is not None and len(self.file_handler.file2_df) > 0 else []})
            # #endregion
            
            # 检查标题行识别是否正确（如果列名看起来像数据值，可能需要调整）
            if self.file_handler.file2_df is not None and len(self.file_handler.file2_df.columns) > 0:
                first_col_name = str(self.file_handler.file2_df.columns[0])
                # 如果列名看起来像数据值（包含逗号、数字、日期格式等），可能是标题行识别错误
                looks_like_data = (
                    ',' in first_col_name or  # 包含逗号（如"固定资产,电子设备"）
                    (len(first_col_name) > 0 and first_col_name[0].isdigit()) or  # 以数字开头
                    len(first_col_name) > 50  # 列名过长
                )
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                # #endregion
                if looks_like_data:
                    # 提示用户可能需要设置标题行
                    messagebox.showwarning("提示", f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。")
            
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取完成")
            # 立即更新标签，确保sheet变量已设置
            self._update_file_labels()
            self._update_file2_preview()
            self._update_match_columns()
        else:
            if self.status_callback:
                self.status_callback(f"{file_display_name}读取失败")
            # #region agent log
            try:
                from debug_logger import _write as _dbg
            except Exception:
                _dbg = lambda **kw: None
            _dbg(sessionId="debug", runId="run1", hypothesisId="H3", location="file_and_match_config._on_file2_loaded.failed", message="file2 load failed", data={"error": error_msg})
            # #endregion
            messagebox.showerror("错误", f"加载{file_display_name}失败:\n{error_msg}")
    
    def _update_file1_preview(self):
        """更新文件1预览"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.entry", message="updating file1 preview", data={"file1_df_is_none": self.file_handler.file1_df is None})
        # #endregion
        
        if self.file_handler.file1_df is None:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.no_df", message="file1_df is None, returning")
            # #endregion
            return
        
        # 清除现有数据
        for item in self.file1_tree.get_children():
            self.file1_tree.delete(item)
        
        preview_df = self.file_handler.get_file1_preview(PREVIEW_ROWS)
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.preview_df", message="got preview_df", data={"preview_df_is_none": preview_df is None, "preview_df_empty": preview_df.empty if preview_df is not None else None, "preview_rows": len(preview_df) if preview_df is not None else 0, "preview_cols": len(preview_df.columns) if preview_df is not None else 0})
        # #endregion
        
        if preview_df is None or preview_df.empty:
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H4", location="file_and_match_config._update_file1_preview.empty_df", message="preview_df is None or empty, returning")
            # #endregion
            return
        
        # 配置列
        columns = list(preview_df.columns)
        col_ids = [f"c{i}" for i in range(len(columns))]
        self.file1_tree['columns'] = col_ids
        self.file1_tree['show'] = 'headings'
        
        for i, col in enumerate(columns):
            cid = col_ids[i]
            self.file1_tree.heading(cid, text=str(col))
            vals = [len(str(val)) for val in preview_df.iloc[:, i].head(10) if pd.notna(val)]
            max_len = max([len(str(col))] + vals) if vals else len(str(col))
            col_width = min(max(max_len * 9 + 28, 110), 240)
            self.file1_tree.column(cid, width=col_width, minwidth=90, stretch=False)
        
        # 插入数据
        for j in range(len(preview_df)):
            values = []
            for i in range(len(columns)):
                val = preview_df.iloc[j, i]
                if pd.isna(val):
                    values.append('')
                else:
                    # 整数形式的浮点数（如 1100000.0）显示为整数，不显示 .0
                    if isinstance(val, float) and val == int(val):
                        val_str = str(int(val))
                    else:
                        val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
            self.file1_tree.insert('', tk.END, values=values)
    
    def _update_file_labels(self):
        """更新所有文件标签显示为"原始文件 & sheet名称"格式"""
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        file1_name = self._get_file_display_name(1)
        file2_name = self._get_file_display_name(2)
        # UI标签使用短名，避免长文件名撑开布局挤压右侧配置区
        file1_name_short = self._shorten_for_ui(file1_name, max_len=10)
        file2_name_short = self._shorten_for_ui(file2_name, max_len=10)
        file1_mapping_short = self._shorten_for_ui(file1_name, max_len=12)
        file2_mapping_short = self._shorten_for_ui(file2_name, max_len=12)
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.entry", message="updating file labels", data={"file1_name": file1_name, "file2_name": file2_name, "file1_path": self.file1_path_var.get(), "file1_sheet": self.file1_sheet_var.get(), "file2_path": self.file2_path_var.get(), "file2_sheet": self.file2_sheet_var.get()})
        # #endregion
        
        # 更新文件选择区域的标签
        if hasattr(self, 'file1_label'):
            self.file1_label.config(text=f"{file1_name_short}:")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_label", message="updated file1 label", data={"text": f"{file1_name_short}:"})
            # #endregion
        if hasattr(self, 'file2_label'):
            self.file2_label.config(text=f"{file2_name_short}:")
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_label", message="updated file2 label", data={"text": f"{file2_name_short}:"})
            # #endregion
        
        # 更新匹配列配置区域的标签
        if hasattr(self, 'match_file1_label'):
            self.match_file1_label.config(text=f"{file1_name}:")
        if hasattr(self, 'match_file2_label'):
            self.match_file2_label.config(text=f"{file2_name}:")
        
        # 更新数据类型区域的标签
        if hasattr(self, 'data_type_file2_label'):
            self.data_type_file2_label.config(text=f"{file2_name}:")
        
        # 更新字段映射配置区域的标签
        if hasattr(self, 'mapping_file1_label'):
            self.mapping_file1_label.config(text=file1_mapping_short)
        if hasattr(self, 'mapping_file2_label'):
            self.mapping_file2_label.config(text=file2_mapping_short)
        
        # 更新预览标签页（截断过长文本，防止标签页撑开布局）
        if hasattr(self, 'preview_notebook'):
            tab_max_len = 22
            f1_tab = file1_name if len(file1_name) <= tab_max_len else file1_name[:tab_max_len - 2] + ".."
            f2_tab = file2_name if len(file2_name) <= tab_max_len else file2_name[:tab_max_len - 2] + ".."
            try:
                # 更新文件1预览标签页（索引0）
                self.preview_notebook.tab(0, text=f1_tab)
                self.file1_preview_tab_text = f1_tab
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_tab", message="updated file1 tab", data={"text": f1_tab})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_tab_error", message="error updating file1 tab", data={"error": str(e)})
                # #endregion
                pass
            try:
                # 更新文件2预览标签页（索引1）
                self.preview_notebook.tab(1, text=f2_tab)
                self.file2_preview_tab_text = f2_tab
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_tab", message="updated file2 tab", data={"text": f2_tab})
                # #endregion
            except Exception as e:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_tab_error", message="error updating file2 tab", data={"error": str(e)})
                # #endregion
                pass
    
    def _update_file2_preview(self):
        """更新文件2预览"""
        if self.file_handler.file2_df is None:
            return
        
        # 清除现有数据
        for item in self.file2_tree.get_children():
            self.file2_tree.delete(item)
        
        preview_df = self.file_handler.get_file2_preview(PREVIEW_ROWS)
        if preview_df is None or preview_df.empty:
            return
        
        # 配置列
        columns = list(preview_df.columns)
        col_ids = [f"c{i}" for i in range(len(columns))]
        self.file2_tree['columns'] = col_ids
        self.file2_tree['show'] = 'headings'
        
        for i, col in enumerate(columns):
            cid = col_ids[i]
            self.file2_tree.heading(cid, text=str(col))
            vals = [len(str(val)) for val in preview_df.iloc[:, i].head(10) if pd.notna(val)]
            max_len = max([len(str(col))] + vals) if vals else len(str(col))
            col_width = min(max(max_len * 9 + 28, 110), 240)
            self.file2_tree.column(cid, width=col_width, minwidth=90, stretch=False)
        
        # 插入数据
        for j in range(len(preview_df)):
            values = []
            for i in range(len(columns)):
                val = preview_df.iloc[j, i]
                if pd.isna(val):
                    values.append('')
                else:
                    # 整数形式的浮点数（如 1100000.0）显示为整数，不显示 .0
                    if isinstance(val, float) and val == int(val):
                        val_str = str(int(val))
                    else:
                        val_str = str(val)
                    if len(val_str) > 50:
                        val_str = val_str[:47] + '...'
                    values.append(val_str)
            self.file2_tree.insert('', tk.END, values=values)
    
    def _update_match_columns(self):
        """更新匹配列下拉框并自动预映射"""
        # 分别获取文件1、文件2的列，确保下拉框来源正确
        # 使用 list() 创建独立副本，避免共享引用
        if self.file_handler.file1_df is not None:
            cols1_raw = list(self.file_handler.get_file1_columns())
        else:
            cols1_raw = []

        if self.file_handler.file2_df is not None:
            cols2_raw = list(self.file_handler.get_file2_columns())
        else:
            cols2_raw = []
        
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.raw_cols", message="got raw columns", data={"cols1_count": len(cols1_raw), "cols2_count": len(cols2_raw), "cols1_sample": cols1_raw[:5] if cols1_raw else [], "cols2_sample": cols2_raw[:5] if cols2_raw else []})
        # #endregion
        
        # 移除列名中的"_文件1"和"_文件2"后缀（如果存在），因为这是合并时添加的，不应该在文件选择阶段显示
        # 注意：这里的列名应该来自原始文件，不应该有后缀，但为了安全起见，还是移除
        cols1 = [str(col).replace('_文件1', '').replace('_文件2', '') if '_文件1' in str(col) or '_文件2' in str(col) else str(col) for col in cols1_raw]
        cols2 = [str(col).replace('_文件1', '').replace('_文件2', '') if '_文件1' in str(col) or '_文件2' in str(col) else str(col) for col in cols2_raw]
        
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.processed_cols", message="processed columns", data={"cols1_count": len(cols1), "cols2_count": len(cols2), "cols1_sample": cols1[:5] if cols1 else [], "cols2_sample": cols2[:5] if cols2 else []})
        # #endregion
        
        # 清空之前的配置，重新映射
        self.match_columns1 = []
        self.match_columns2 = []
        self._match_columns_auto_default = False
        self.original_value_col1_var.set('')
        self.original_value_col2_var.set('')
        self.depreciation_col1_var.set('')
        self.depreciation_col2_var.set('')
        self.category_col1_var.set('')
        self.category_col2_var.set('')
        self.name_col1_var.set('')
        self.name_col2_var.set('')
        self.date_col1_var.set('')
        self.date_col2_var.set('')
        self.life_col1_var.set('')
        self.life_col2_var.set('')
        self.residual_col1_var.set('')
        self.residual_col2_var.set('')
        self.current_year_dep_col1_var.set('')
        self.current_year_dep_col2_var.set('')
        self.addition_method_col1_var.set('')
        self.addition_method_col2_var.set('')
        self.addition_date_col1_var.set('')
        self.addition_date_col2_var.set('')
        self.disposal_method_col1_var.set('')
        self.disposal_method_col2_var.set('')
        self.disposal_date_col1_var.set('')
        self.disposal_date_col2_var.set('')
        self.disposal_orig_col1_var.set('')
        self.disposal_orig_col2_var.set('')
        self.disposal_dep_col1_var.set('')
        self.disposal_dep_col2_var.set('')
        
        # 匹配列：文件1用cols1，文件2用cols2（更新Listbox）
        self.match_col1_listbox.delete(0, tk.END)
        for col in cols1:
            self.match_col1_listbox.insert(tk.END, col)
        
        self.match_col2_listbox.delete(0, tk.END)
        for col in cols2:
            self.match_col2_listbox.insert(tk.END, col)
        
        # #region agent log
        # 注意：匹配列已改为按钮形式，不再使用combo，所以这里不再记录combo的值
        _dbg(sessionId="debug", runId="run1", hypothesisId="H6", location="file_and_match_config._update_match_columns.set_combo", message="set combo values", data={"cols1_count": len(cols1), "cols2_count": len(cols2)})
        # #endregion
        
        # 更新所有字段映射下拉框的值
        all_combos_1 = [self.orig_col1_combo, self.dep_col1_combo, self.category_col1_combo,
                        self.name_col1_combo, self.date_col1_combo, self.life_col1_combo, self.residual_col1_combo, self.current_year_dep_col1_combo,
                        self.addition_method_col1_combo, self.addition_date_col1_combo, self.disposal_method_col1_combo,
                        self.disposal_date_col1_combo, self.disposal_orig_col1_combo, self.disposal_dep_col1_combo]
        all_combos_2 = [self.orig_col2_combo, self.dep_col2_combo, self.category_col2_combo,
                        self.name_col2_combo, self.date_col2_combo, self.life_col2_combo, self.residual_col2_combo, self.current_year_dep_col2_combo,
                        self.addition_method_col2_combo, self.addition_date_col2_combo, self.disposal_method_col2_combo,
                        self.disposal_date_col2_combo, self.disposal_orig_col2_combo, self.disposal_dep_col2_combo]
        
        # 添加"[不映射]"选项到下拉框。映射列 combo 的索引：0=[不映射]，1..n=cols[0..n-1]
        # 确保cols1和cols2是列表且不为空
        cols1_list = list(cols1) if cols1 else []
        cols2_list = list(cols2) if cols2 else []
        
        for combo in all_combos_1:
            if combo:
                combo['values'] = ['[不映射]'] + cols1_list
        for combo in all_combos_2:
            if combo:
                combo['values'] = ['[不映射]'] + cols2_list
        
        def _mapping_combo_index(col, cols):
            """映射列 combo 中列名对应的索引（含[不映射]在第0位）"""
            if not col or col not in cols:
                return 0  # 默认选[不映射]
            return 1 + cols.index(col)
        
        # 自动预映射匹配列：先选语义最像资产唯一编号/编码的列，避免公司代码、资产描述等非ID列抢占第一匹配列。
        self.match_col1_listbox.selection_clear(0, tk.END)
        self.match_col2_listbox.selection_clear(0, tk.END)

        id_col1, id_col2 = pick_paired_fa_match_id_columns(cols1, cols2)

        if id_col1 and id_col2:
            self.match_col1_listbox.selection_set(cols1.index(id_col1))
            self.match_col2_listbox.selection_set(cols2.index(id_col2))
            self.match_columns1 = [id_col1]
            self.match_columns2 = [id_col2]
            self._update_selected_match_columns(1)
            self._update_selected_match_columns(2)
            if hasattr(self, '_update_match_col1_button'):
                self._update_match_col1_button()
            if hasattr(self, '_update_match_col2_button'):
                self._update_match_col2_button()
        elif cols1 and cols2:
            # 回退到原有匹配逻辑，但不把明显非ID的列当作第一匹配列。
            matches = get_column_matches(cols1, cols2)
            matches = [
                (col1, col2)
                for col1, col2 in matches
                if not is_forbidden_fa_match_key_column(col1)
                and not is_forbidden_fa_match_key_column(col2)
            ]
            if matches:
                col1, col2 = matches[0]
                if col1 in cols1:
                    idx1 = cols1.index(col1)
                    self.match_col1_listbox.selection_set(idx1)
                    self.match_columns1 = [col1]
                if col2 in cols2:
                    idx2 = cols2.index(col2)
                    self.match_col2_listbox.selection_set(idx2)
                    self.match_columns2 = [col2]
                self._update_selected_match_columns(1)
                self._update_selected_match_columns(2)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
                if hasattr(self, '_update_match_col2_button'):
                        self._update_match_col2_button()
            else:
                fallback1 = next((col for col in cols1 if not is_forbidden_fa_match_key_column(col)), None)
                fallback2 = next((col for col in cols2 if not is_forbidden_fa_match_key_column(col)), None)
                if fallback1 and fallback2:
                    self.match_col1_listbox.selection_set(cols1.index(fallback1))
                    self.match_col2_listbox.selection_set(cols2.index(fallback2))
                    self.match_columns1 = [fallback1]
                    self.match_columns2 = [fallback2]
                    self._update_selected_match_columns(1)
                    self._update_selected_match_columns(2)
                    if hasattr(self, '_update_match_col1_button'):
                        self._update_match_col1_button()
                    if hasattr(self, '_update_match_col2_button'):
                        self._update_match_col2_button()

        self._match_columns_auto_default = bool(self.match_columns1 or self.match_columns2)
        
        # 通用预映射函数：精确匹配优先，包含匹配次之
        def auto_map_column(cols, exact_keywords, contain_keywords=None):
            """
            自动映射列：
            1. 先尝试列名完全等于精确关键词
            2. 再尝试列名包含精确关键词
            3. 最后尝试列名包含模糊关键词
            """
            if contain_keywords is None:
                contain_keywords = []
            
            # 1. 精确匹配：列名完全等于关键词
            for col in cols:
                if str(col) in exact_keywords:
                    return col
            
            # 2. 包含匹配：列名包含精确关键词
            for col in cols:
                for kw in exact_keywords:
                    if kw in str(col):
                        return col
            
            # 3. 包含匹配：列名包含模糊关键词
            for col in cols:
                for kw in contain_keywords:
                    if kw in str(col):
                        return col
            
            return None

        if self.mode == "supplement":
            addition_method_exact = ['新增方式', '增加方式', '取得方式', '资产来源', '新增来源']
            addition_method_contain = ['新增方式', '增加方式', '取得方式', '来源', '方式', '途径']
            addition_date_exact = ['新增时间', '增加时间', '取得日期', '日期', '时间', '时点']
            addition_date_contain = ['新增', '增加', '时间', '日期', '时点']

            disposal_method_exact = ['处置方式', '减少方式', '报废方式', '出售方式']
            disposal_method_contain = ['处置方式', '减少方式', '报废', '出售', '转出', '方式']
            disposal_date_exact = ['处置时间', '减少时间', '处置日期', '日期', '时间', '时点']
            disposal_date_contain = ['处置', '减少', '时间', '日期', '时点']
            disposal_orig_exact = ['处置原值', '减少原值', '原值减少', '处置成本']
            disposal_orig_contain = ['处置原值', '减少原值', '原值减少', '原值']
            disposal_dep_exact = ['处置折旧', '减少折旧', '累计折旧处置', '累计折旧减少', '累计折旧']
            disposal_dep_contain = ['处置折旧', '减少折旧', '折旧减少', '累计折旧减少', '累计折旧处置']

            add_method_col1 = auto_map_column(cols1, addition_method_exact, addition_method_contain)
            add_date_col1 = auto_map_column(cols1, addition_date_exact, addition_date_contain)
            disp_method_col2 = auto_map_column(cols2, disposal_method_exact, disposal_method_contain)
            disp_date_col2 = auto_map_column(cols2, disposal_date_exact, disposal_date_contain)
            disp_orig_col2 = auto_map_column(cols2, disposal_orig_exact, disposal_orig_contain)
            disp_dep_col2 = auto_map_column(cols2, disposal_dep_exact, disposal_dep_contain)

            if add_method_col1:
                self.addition_method_col1_var.set(add_method_col1)
                if add_method_col1 in cols1:
                    self.addition_method_col1_combo.current(_mapping_combo_index(add_method_col1, cols1))
            if add_date_col1:
                self.addition_date_col1_var.set(add_date_col1)
                if add_date_col1 in cols1:
                    self.addition_date_col1_combo.current(_mapping_combo_index(add_date_col1, cols1))
            if disp_method_col2:
                self.disposal_method_col2_var.set(disp_method_col2)
                if disp_method_col2 in cols2:
                    self.disposal_method_col2_combo.current(_mapping_combo_index(disp_method_col2, cols2))
            if disp_date_col2:
                self.disposal_date_col2_var.set(disp_date_col2)
                if disp_date_col2 in cols2:
                    self.disposal_date_col2_combo.current(_mapping_combo_index(disp_date_col2, cols2))
            if disp_orig_col2:
                self.disposal_orig_col2_var.set(disp_orig_col2)
                if disp_orig_col2 in cols2:
                    self.disposal_orig_col2_combo.current(_mapping_combo_index(disp_orig_col2, cols2))
            if disp_dep_col2:
                self.disposal_dep_col2_var.set(disp_dep_col2)
                if disp_dep_col2 in cols2:
                    self.disposal_dep_col2_combo.current(_mapping_combo_index(disp_dep_col2, cols2))
            self._queue_llm_mapping_assist()
            return
        
        # 自动预映射原值列
        orig_exact = ['原值', '资产原值', '固定资产原值']
        orig_contain = ['成本', '入账价值']
        
        orig_col1 = auto_map_column(cols1, orig_exact, orig_contain)
        orig_col2 = auto_map_column(cols2, orig_exact, orig_contain)
        
        if orig_col1:
            self.original_value_col1_var.set(orig_col1)
            if orig_col1 in cols1:
                self.orig_col1_combo.current(_mapping_combo_index(orig_col1, cols1))
        if orig_col2:
            self.original_value_col2_var.set(orig_col2)
            if orig_col2 in cols2:
                self.orig_col2_combo.current(_mapping_combo_index(orig_col2, cols2))
        
        # 自动预映射累计折旧列
        # 精确匹配关键词
        dep_exact = ['累计折旧', '年末累计折旧', '期末累计折旧']
        # 包含匹配关键词（只匹配"累计折旧"，不单独匹配"折旧"）
        dep_contain = ['累计折旧']
        
        dep_col1 = auto_map_column(cols1, dep_exact, dep_contain)
        dep_col2 = auto_map_column(cols2, dep_exact, dep_contain)
        
        if dep_col1:
            self.depreciation_col1_var.set(dep_col1)
            if dep_col1 in cols1:
                self.dep_col1_combo.current(_mapping_combo_index(dep_col1, cols1))
        if dep_col2:
            self.depreciation_col2_var.set(dep_col2)
            if dep_col2 in cols2:
                self.dep_col2_combo.current(_mapping_combo_index(dep_col2, cols2))
        
        # 自动预映射资产类别列：只选"类别名称"列，跳过"分类代码"列（如 '资产分类'，
        # 取值像 'Y110'）。pick_fa_category_column 会用样例值嗅探拒绝代码列；
        # 如果某侧没有合适的名称列，保持空——避免与另一侧口径不一致。
        df1_for_category = self.file_handler.file1_df if self.file_handler.file1_df is not None else None
        df2_for_category = self.file_handler.file2_df if self.file_handler.file2_df is not None else None
        category_col1 = pick_fa_category_column(cols1, df=df1_for_category)
        category_col2 = pick_fa_category_column(cols2, df=df2_for_category)

        if category_col1:
            self.category_col1_var.set(category_col1)
            if category_col1 in cols1:
                self.category_col1_combo.current(_mapping_combo_index(category_col1, cols1))
        if category_col2:
            self.category_col2_var.set(category_col2)
            if category_col2 in cols2:
                self.category_col2_combo.current(_mapping_combo_index(category_col2, cols2))
        
        # 自动预映射固定资产名称列
        name_col1 = pick_fa_name_column(cols1, df=self.file_handler.file1_df, exclude_cols=[category_col1])
        name_col2 = pick_fa_name_column(cols2, df=self.file_handler.file2_df, exclude_cols=[category_col2])
        
        if name_col1:
            self.name_col1_var.set(name_col1)
            if name_col1 in cols1:
                self.name_col1_combo.current(_mapping_combo_index(name_col1, cols1))
        if name_col2:
            self.name_col2_var.set(name_col2)
            if name_col2 in cols2:
                self.name_col2_combo.current(_mapping_combo_index(name_col2, cols2))

        self._append_mapped_name_to_auto_match_columns(cols1, cols2)
        
        # 自动预映射入账开始日期列
        # 精确匹配关键词（优先）
        date_exact_keywords = ['入账日期', '开始日期', '购置日期', '取得日期', '启用日期', '资本化日期']
        # 包含匹配关键词（次优先）
        date_contain_keywords = ['日期', '时间']
        
        # 先尝试精确匹配
        date_cols1 = [col for col in cols1 if str(col) in date_exact_keywords]
        date_cols2 = [col for col in cols2 if str(col) in date_exact_keywords]
        # 如果精确匹配失败，尝试包含匹配（精确关键词）
        if not date_cols1:
            date_cols1 = [col for col in cols1 if any(kw in str(col) for kw in date_exact_keywords)]
        if not date_cols2:
            date_cols2 = [col for col in cols2 if any(kw in str(col) for kw in date_exact_keywords)]
        # 如果还是没有，尝试包含匹配（模糊关键词）
        if not date_cols1:
            date_cols1 = [col for col in cols1 if any(kw in str(col) for kw in date_contain_keywords)]
        if not date_cols2:
            date_cols2 = [col for col in cols2 if any(kw in str(col) for kw in date_contain_keywords)]
        
        if date_cols1:
            self.date_col1_var.set(date_cols1[0])
            if date_cols1[0] in cols1:
                self.date_col1_combo.current(_mapping_combo_index(date_cols1[0], cols1))
        if date_cols2:
            self.date_col2_var.set(date_cols2[0])
            if date_cols2[0] in cols2:
                self.date_col2_combo.current(_mapping_combo_index(date_cols2[0], cols2))
        
        # 自动预映射使用寿命列
        life_col1 = find_fa_life_column(cols1)
        life_col2 = find_fa_life_column(cols2)
        
        if life_col1:
            self.life_col1_var.set(life_col1)
            if life_col1 in cols1:
                self.life_col1_combo.current(_mapping_combo_index(life_col1, cols1))
        if life_col2:
            self.life_col2_var.set(life_col2)
            if life_col2 in cols2:
                self.life_col2_combo.current(_mapping_combo_index(life_col2, cols2))
        
        # 自动预映射残值率列
        residual_exact = ['残值率', '预计残值率', '净残值率']
        residual_contain = ['残值']
        
        residual_col1 = auto_map_column(cols1, residual_exact, residual_contain)
        residual_col2 = auto_map_column(cols2, residual_exact, residual_contain)
        
        if residual_col1:
            self.residual_col1_var.set(residual_col1)
            if residual_col1 in cols1:
                self.residual_col1_combo.current(_mapping_combo_index(residual_col1, cols1))
        if residual_col2:
            self.residual_col2_var.set(residual_col2)
            if residual_col2 in cols2:
                self.residual_col2_combo.current(_mapping_combo_index(residual_col2, cols2))

        current_year_dep_exact = ['本年折旧', '年折旧额', '本期折旧']
        current_year_dep_contain = ['本年折旧']

        current_year_dep_col2 = auto_map_column(cols2, current_year_dep_exact, current_year_dep_contain)

        self.current_year_dep_col1_var.set("")
        self.current_year_dep_col1_combo.set("")
        self.current_year_dep_col1_combo.configure(state="disabled")
        if current_year_dep_col2:
            self.current_year_dep_col2_var.set(current_year_dep_col2)
            if current_year_dep_col2 in cols2:
                self.current_year_dep_col2_combo.current(_mapping_combo_index(current_year_dep_col2, cols2))
        self._queue_llm_mapping_assist()

    def _mapped_name_columns_for_match(self, cols1, cols2):
        """Return mapped asset-name columns only when both mapped values exist in their files."""
        name_col1 = self.name_col1_var.get()
        name_col2 = self.name_col2_var.get()
        if not name_col1 or not name_col2 or name_col1 == '[不映射]' or name_col2 == '[不映射]':
            return None, None
        if name_col1 not in cols1 or name_col2 not in cols2:
            return None, None
        return name_col1, name_col2

    def _append_mapped_name_to_auto_match_columns(self, cols1, cols2):
        """Synchronize mapped asset-name columns into match keys.

        只要两侧名称列都已映射且存在，就确保匹配键为"ID + 当前名称列"口径。
        若旧的自动匹配键里残留了类别列（如 file2 的 资产描述），先移除，再追加
        当前名称列（如 资产类型描述），避免类别列和名称列错位后继续污染匹配键。
        """
        name_col1, name_col2 = self._mapped_name_columns_for_match(cols1, cols2)
        if not name_col1 or not name_col2:
            return False

        current1 = [col for col in (self.match_columns1 or []) if col in cols1]
        current2 = [col for col in (self.match_columns2 or []) if col in cols2]
        category_col1 = self.category_col1_var.get()
        category_col2 = self.category_col2_var.get()

        new1 = [col for col in current1 if col != category_col1]
        new2 = [col for col in current2 if col != category_col2]
        if name_col1 not in new1:
            new1.append(name_col1)
        if name_col2 not in new2:
            new2.append(name_col2)

        if new1 == current1 and new2 == current2:
            return False
        if len(new1) != len(new2):
            return False

        self.match_columns1 = new1
        self.match_columns2 = new2
        self._sync_auto_match_column_selection(cols1, cols2)
        return True

    def _ensure_code_column_in_auto_match_columns(self, cols1, cols2):
        """Keep the original code/id column in automatic match defaults."""
        if not getattr(self, "_match_columns_auto_default", False):
            return False

        changed = False
        code1, code2 = pick_paired_fa_match_id_columns(cols1, cols2)
        if code1 and code1 not in self.match_columns1:
            self.match_columns1 = [code1] + [col for col in self.match_columns1 if col != code1]
            changed = True
        if code2 and code2 not in self.match_columns2:
            self.match_columns2 = [code2] + [col for col in self.match_columns2 if col != code2]
            changed = True
        if changed:
            self._sync_auto_match_column_selection(cols1, cols2)
        return changed

    def _repair_auto_match_columns(self, cols1, cols2):
        """Normalize automatic match keys.

        主键规范仍受 _match_columns_auto_default 保护（避免覆盖用户手动选择）；
        名称列追加是独立链路、无前置条件，由 _append_mapped_name_to_auto_match_columns
        处理，主键识别不出来也照样追加。
        """
        changed = False

        if getattr(self, "_match_columns_auto_default", False):
            code1, code2 = pick_paired_fa_match_id_columns(cols1, cols2)
            # pick_paired 现已严格成对返回（要么 (X,Y) 要么 (None,None)），
            # 不会出现一侧 None 一侧成功的情况，无需 elif 单侧追加。
            if code1 and code2:
                current1 = [col for col in (self.match_columns1 or []) if col in cols1]
                current2 = [col for col in (self.match_columns2 or []) if col in cols2]
                new1 = [code1] + [col for col in current1 if col != code1]
                new2 = [code2] + [col for col in current2 if col != code2]
                if new1 != current1 or new2 != current2:
                    self.match_columns1 = new1
                    self.match_columns2 = new2
                    self._sync_auto_match_column_selection(cols1, cols2)
                    changed = True

        if self._append_mapped_name_to_auto_match_columns(cols1, cols2):
            changed = True

        return changed

    def _sync_auto_match_column_selection(self, cols1, cols2):
        """Sync automatic match column lists back to the hidden listboxes and labels."""
        self.match_columns1 = self._ordered_auto_match_columns([
            col for col in (self.match_columns1 or []) if col in cols1
        ])
        self.match_columns2 = self._ordered_auto_match_columns([
            col for col in (self.match_columns2 or []) if col in cols2
        ])
        self.match_col1_listbox.selection_clear(0, tk.END)
        for col in self.match_columns1:
            if col in cols1:
                self.match_col1_listbox.selection_set(cols1.index(col))
        self.match_col2_listbox.selection_clear(0, tk.END)
        for col in self.match_columns2:
            if col in cols2:
                self.match_col2_listbox.selection_set(cols2.index(col))
        self._update_selected_match_columns(1)
        self._update_selected_match_columns(2)
    
    def _update_selected_match_columns(self, file_num):
        """更新已选匹配列的显示"""
        if file_num == 1:
            # 从Listbox读取选择（即使隐藏了，数据仍然存储在其中）
            selected_indices = self.match_col1_listbox.curselection()
            if selected_indices:
                self.match_columns1 = [self.match_col1_listbox.get(i) for i in selected_indices]
                if getattr(self, "_match_columns_auto_default", False):
                    self.match_columns1 = self._ordered_auto_match_columns(self.match_columns1)
            # 如果match_columns1已设置，优先使用它
            if self.match_columns1:
                display_text = " + ".join(self.match_columns1)
                # 如果文本太长，截断并添加省略号
                if len(display_text) > 50:
                    display_text = display_text[:47] + "..."
                self.match_col1_selected_label.config(text=f"已选择: {display_text}", foreground=PRIMARY)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
            else:
                self.match_col1_selected_label.config(text="已选择: 无", foreground=MUTED_TEXT)
                # 更新按钮文本
                if hasattr(self, '_update_match_col1_button'):
                    self._update_match_col1_button()
        else:
            selected_indices = self.match_col2_listbox.curselection()
            if selected_indices:
                self.match_columns2 = [self.match_col2_listbox.get(i) for i in selected_indices]
                if getattr(self, "_match_columns_auto_default", False):
                    self.match_columns2 = self._ordered_auto_match_columns(self.match_columns2)
            if self.match_columns2:
                display_text = " + ".join(self.match_columns2)
                # 如果文本太长，截断并添加省略号
                if len(display_text) > 50:
                    display_text = display_text[:47] + "..."
                self.match_col2_selected_label.config(text=f"已选择: {display_text}", foreground=PRIMARY)
                # 更新按钮文本
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()
            else:
                self.match_col2_selected_label.config(text="已选择: 无", foreground=MUTED_TEXT)
                # 更新按钮文本
                if hasattr(self, '_update_match_col2_button'):
                    self._update_match_col2_button()

    def _ordered_auto_match_columns(self, columns):
        """Keep automatic match keys ordered as primary ID first, then appended helpers."""
        id_columns = [
            col
            for _, _, col in sorted(
                (
                    (-score_fa_match_id_column(col), index, col)
                    for index, col in enumerate(columns)
                    if score_fa_match_id_column(col) is not None
                )
            )
        ]
        helper_columns = [col for col in columns if score_fa_match_id_column(col) is None]
        return id_columns + helper_columns

    def _log_llm_mapping_event(self, event, **data):
        try:
            from debug_logger import _write as _dbg
            _dbg(
                sessionId="debug",
                runId="run1",
                hypothesisId="LLM",
                location=f"file_and_match_config.llm_mapping.{event}",
                message=event,
                data=data,
            )
        except Exception:
            pass

    def _queue_llm_mapping_assist(self):
        if (
            self._llm_mapping_assist_scheduled
            and not self._llm_mapping_running
            and self._llm_mapping_assist_job is None
        ):
            self._log_llm_mapping_event("queue_stale_schedule_reset")
            self._llm_mapping_assist_scheduled = False
        if self._llm_mapping_assist_scheduled or self._llm_mapping_running:
            self._log_llm_mapping_event(
                "queue_skipped",
                reason="already_scheduled_or_running",
                scheduled=bool(self._llm_mapping_assist_scheduled),
                running=bool(self._llm_mapping_running),
            )
            return
        if not is_llm_enabled():
            self._log_llm_mapping_event("queue_skipped", reason="llm_disabled")
            return
        has_file1 = self.file_handler.file1_df is not None
        has_file2 = self.file_handler.file2_df is not None
        if not has_file1 or not has_file2:
            self._log_llm_mapping_event(
                "queue_skipped",
                reason="missing_dataframe",
                has_file1=has_file1,
                has_file2=has_file2,
            )
            return
        self._llm_mapping_assist_scheduled = True
        self._log_llm_mapping_event("queued")
        self._llm_mapping_assist_job = self.after(50, self._start_llm_mapping_assist)
        self._set_llm_mapping_status("正在启动大模型辅助判断...", foreground=ERROR, mode="running")

    def _start_llm_mapping_assist(self):
        self._llm_mapping_assist_scheduled = False
        self._llm_mapping_assist_job = None
        try:
            self._log_llm_mapping_event(
                "start_entered",
                running=bool(self._llm_mapping_running),
                enabled=bool(is_llm_enabled()),
                has_file1=self.file_handler.file1_df is not None,
                has_file2=self.file_handler.file2_df is not None,
            )
            if self._llm_mapping_running:
                self._log_llm_mapping_event("start_skipped", reason="already_running")
                return
            if not is_llm_enabled():
                self._log_llm_mapping_event("start_skipped", reason="llm_disabled")
                self._set_llm_mapping_status("")
                return
            if self.file_handler.file1_df is None or self.file_handler.file2_df is None:
                self._log_llm_mapping_event(
                    "start_skipped",
                    reason="missing_dataframe",
                    has_file1=self.file_handler.file1_df is not None,
                    has_file2=self.file_handler.file2_df is not None,
                )
                self._set_llm_mapping_status("")
                return
            cols1 = list(self.file_handler.get_file1_columns())
            cols2 = list(self.file_handler.get_file2_columns())
            if not cols1 or not cols2:
                self._log_llm_mapping_event(
                    "start_skipped",
                    reason="missing_columns",
                    cols1_count=len(cols1),
                    cols2_count=len(cols2),
                )
                self._set_llm_mapping_status("")
                return
            repaired_match = self._repair_auto_match_columns(cols1, cols2)
            if repaired_match:
                self._log_llm_mapping_event(
                    "auto_match_repaired_before_llm",
                    file1=list(self.match_columns1 or []),
                    file2=list(self.match_columns2 or []),
                )
            self._llm_mapping_running = True
            self._set_llm_mapping_status("大模型辅助判断中，正在复核字段映射和匹配列，请稍候...", foreground=ERROR, mode="running")

            match_profile = self._current_match_key_profile()
            candidate_profiles_all = self._current_match_key_candidate_profiles()
            # 收集已映射的业务属性字段作为匹配键禁列（资产名称除外，匹配列自身除外）。
            forbidden_initial = self._collect_forbidden_match_key_columns()
            candidate_profiles = filter_match_key_candidates_by_forbidden(
                candidate_profiles_all, forbidden_initial
            )
            payload = {
                "cols1": cols1,
                "cols2": cols2,
                "samples1": self._llm_column_samples(self.file_handler.file1_df),
                "samples2": self._llm_column_samples(self.file_handler.file2_df),
                "profiles1": self._llm_column_profiles(self.file_handler.file1_df),
                "profiles2": self._llm_column_profiles(self.file_handler.file2_df),
                "current": self._current_llm_mapping(),
                "match_profile": match_profile,
                "candidate_profiles": candidate_profiles,
                "candidate_profiles_all": candidate_profiles_all,
                "forbidden_columns": forbidden_initial,
                "mode": self.mode,
            }
            signature = self._match_review_signature(payload["current"].get("match"), payload["match_profile"])
            self._log_llm_mapping_event(
                "payload_ready",
                cols1_count=len(cols1),
                cols2_count=len(cols2),
                match_candidate_count=len(candidate_profiles),
                match_review_enabled=bool(signature and signature != self._last_llm_match_review_signature),
            )
        except Exception as exc:
            self._llm_mapping_assist_scheduled = False
            self._llm_mapping_running = False
            message = f"大模型辅助判断启动失败：{exc}"
            self._log_llm_mapping_event("start_failed", error=str(exc))
            self._set_llm_mapping_status(message, foreground=ERROR, mode="error")
            return

        def worker():
            suggestions = []
            fa_review = []
            fa_review_error = None
            match_review = None
            match_review_error = None
            mapping_error = None
            try:
                self._log_llm_mapping_event("worker_started")
                self.after(0, lambda: self._set_llm_mapping_status("正在向大模型发送请求...", foreground=ERROR, mode="running"))
                settings = load_llm_settings()
                self._log_llm_mapping_event(
                    "settings_loaded",
                    base_url=bool(settings.get("base_url")) if isinstance(settings, dict) else bool(getattr(settings, "base_url", "")),
                    model=bool(settings.get("model")) if isinstance(settings, dict) else bool(getattr(settings, "model", "")),
                    api_key=bool(settings.get("api_key")) if isinstance(settings, dict) else bool(getattr(settings, "api_key", "")),
                )
                role_definitions = self._llm_role_definitions()
                files = [
                    {
                        "file_side": "file1",
                        "headers": [str(c) for c in payload["cols1"]],
                        "samples": payload["samples1"],
                        "column_profiles": payload["profiles1"],
                    },
                    {
                        "file_side": "file2",
                        "headers": [str(c) for c in payload["cols2"]],
                        "samples": payload["samples2"],
                        "column_profiles": payload["profiles2"],
                    },
                ]
                mapping_instructions = (
                    "file1通常为期初或新增清单，file2通常为期末或处置清单。"
                    "只对未映射字段使用 action=fill；已映射字段仅 action=review/keep。"
                    "补充清单模式下，file1优先新增方式/新增时间，file2优先处置方式/处置时间/处置原值/处置折旧。"
                )
                review_instructions = (
                    "先脱离自动预映射结论，依据 headers、samples、column_profiles 独立判断各列实际业务角色，再复核已自动预映射字段是否明显错列或两期口径不一致。"
                    "例如资产大类与资产类型描述、原值与原值减少、累计折旧与本年折旧混用。"
                    "不要再提示使用寿命的年/月单位差异，也不要再提示残值率/残值的口径差异——脚本已分别按 ×12 与 残值/原值 自动校正。"
                    "特别注意列名暗示和脚本初判都可能与实际数据形态冲突：列名和 current_mapping 只作参考，样例值和 column_profiles 优先。"
                    "请把 category、name、code/id、date、value、depreciation 等字段作为一组联动复核；若多列发生错位或互换，应分别返回每个受影响字段的 field_review，而不是只修一个字段。"
                    "category 应是短中文类别名且 unique_count 通常较少；name 应是具体资产名称/型号/规格等长描述，通常更长或 unique_count 明显更多；短英数字值通常是代码/编号。"
                    "如果 category 当前列的样例像代码/编号或长资产描述，应 flag wrong_column；若两侧 category 数据形态不一致，应 flag cross_period_inconsistent。"
                    "category 与 name 在同一文件侧不能共用同一列；若 category 建议改到 name 当前列，必须同步复核 name 并建议长描述/高唯一值列。"
                    "如建议修正，suggested_mapping 只返回需要修正的一侧或两侧。"
                )
                match_instructions = (
                    "文件1和文件2的匹配列数量必须一致；可建议多列组合。"
                    "如果当前列有空值、重复较多，或两边一个是编号一个是名称，应提示用户。"
                )
                match_review_enabled = bool(signature and signature != self._last_llm_match_review_signature)
                try:
                    self._log_llm_mapping_event("combined_task_submitted", include_match_review=match_review_enabled)
                    combined = generate_combined_fa_list_assistance(
                        settings,
                        tool_name="FA List",
                        role_definitions=role_definitions,
                        files=files,
                        current_mapping=payload["current"],
                        current_match=payload["current"].get("match", {}),
                        local_profile=payload["match_profile"],
                        candidate_profiles=payload["candidate_profiles"],
                        include_match_review=match_review_enabled,
                        mapping_extra_instructions=mapping_instructions,
                        review_extra_instructions=review_instructions,
                        match_extra_instructions=match_instructions,
                        forbidden_columns=payload["forbidden_columns"],
                    )
                    suggestions = combined.suggestions
                    fa_review = combined.fa_review
                    match_review = combined.match_review
                    self._log_llm_mapping_event(
                        "combined_task_done",
                        suggestions_count=len(suggestions or []),
                        fa_review_count=len(fa_review or []),
                        has_match_review=match_review is not None,
                        repair_used=combined.repair_used,
                    )
                    # 把 match_review 实际内容也记下来，便于排查 LLM 推不推、推什么。
                    if match_review is not None:
                        mr = match_review
                        self._log_llm_mapping_event(
                            "combined_match_review_detail",
                            status=str(getattr(mr, "status", "")),
                            action=str(getattr(mr, "action", "")),
                            confidence=float(getattr(mr, "confidence", 0) or 0),
                            suggested_file1=list(getattr(mr, "suggested_file1_columns", []) or []),
                            suggested_file2=list(getattr(mr, "suggested_file2_columns", []) or []),
                            reasons=list(getattr(mr, "reasons", []) or [])[:4],
                            suggestion_reason=str(getattr(mr, "suggestion_reason", "") or "")[:200],
                            candidate_count_input=len(payload.get("candidate_profiles") or []),
                        )
                    self._log_llm_mapping_event(
                        "worker_finished",
                        suggestions_count=len(suggestions or []),
                        fa_review_count=len(fa_review or []),
                        has_match_review=match_review is not None,
                        errors=[],
                    )
                    self.after(0, lambda: self._safe_apply_llm_mapping_suggestions(
                        suggestions,
                        payload["cols1"],
                        payload["cols2"],
                        match_review,
                        signature,
                        match_review_error,
                        fa_review,
                        fa_review_error,
                        payload["current"],
                        mapping_error,
                        payload["match_profile"],
                    ))
                    return
                except Exception as exc:
                    self._log_llm_mapping_event("combined_task_failed_fallback_parallel", error=str(exc))
                # Two-phase时序：第一波并发 mapping + fa_review；拿到结果后再单发 match_review，
                # 此时可以把 mapping LLM 推荐填补的列追加进 forbidden_columns 并据此过滤候选池。
                tasks = {}
                executor = ThreadPoolExecutor(max_workers=2)
                try:
                    tasks[executor.submit(
                        suggest_field_mappings,
                        settings,
                        tool_name="FA List",
                        role_definitions=role_definitions,
                        files=files,
                        current_mapping=payload["current"],
                        extra_instructions=mapping_instructions,
                    )] = "mapping"
                    tasks[executor.submit(
                        review_fa_list_field_mappings,
                        settings,
                        role_definitions=role_definitions,
                        files=files,
                        current_mapping=payload["current"],
                        extra_instructions=review_instructions,
                    )] = "fa_review"
                    self._log_llm_mapping_event("tasks_submitted", tasks=list(tasks.values()))

                    try:
                        completed = as_completed(tasks, timeout=LLM_MAPPING_BATCH_TIMEOUT_SECONDS)
                        for future in completed:
                            task_name = tasks[future]
                            try:
                                result = future.result()
                            except Exception as exc:
                                self._log_llm_mapping_event("task_failed", task=task_name, error=str(exc))
                                if task_name == "mapping":
                                    mapping_error = str(exc)
                                elif task_name == "fa_review":
                                    fa_review_error = str(exc)
                                continue
                            result_count = len(result) if isinstance(result, list) else (1 if result is not None else 0)
                            self._log_llm_mapping_event("task_done", task=task_name, result_count=result_count)
                            if task_name == "mapping":
                                suggestions = result
                            elif task_name == "fa_review":
                                fa_review = result
                    except FuturesTimeoutError:
                        unfinished = [name for future, name in tasks.items() if not future.done()]
                        for future in tasks:
                            if not future.done():
                                future.cancel()
                        timeout_msg = f"LLM 请求超过 {LLM_MAPPING_BATCH_TIMEOUT_SECONDS} 秒未完成，已跳过未返回的辅助判断。"
                        self._log_llm_mapping_event("tasks_timeout", timeout_seconds=LLM_MAPPING_BATCH_TIMEOUT_SECONDS, unfinished=unfinished)
                        if "mapping" in unfinished:
                            mapping_error = timeout_msg
                        if "fa_review" in unfinished:
                            fa_review_error = timeout_msg
                finally:
                    executor.shutdown(wait=False, cancel_futures=True)

                # 第二波：根据 mapping LLM 的填补建议刷新 forbidden_columns，再发 match_review。
                if match_review_enabled:
                    extras = {}
                    for sug in (suggestions or []):
                        try:
                            role = getattr(sug, "role", "")
                            action = getattr(sug, "action", "")
                            side = getattr(sug, "file_side", "")
                            col = getattr(sug, "suggested_column", "")
                        except Exception:
                            continue
                        if not role or action != "fill" or side not in ("file1", "file2") or not col:
                            continue
                        extras.setdefault(role, {})[side] = col
                    forbidden_phase2 = self._collect_forbidden_match_key_columns(extra_mapping_suggestions=extras)
                    candidates_phase2 = filter_match_key_candidates_by_forbidden(
                        payload.get("candidate_profiles_all") or payload["candidate_profiles"],
                        forbidden_phase2,
                    )
                    self._log_llm_mapping_event(
                        "match_review_phase2_starting",
                        forbidden_file1_count=len(forbidden_phase2.get("file1", [])),
                        forbidden_file2_count=len(forbidden_phase2.get("file2", [])),
                        filtered_candidate_count=len(candidates_phase2),
                    )
                    try:
                        match_review = review_match_key_columns(
                            settings,
                            tool_name="FA List",
                            files=files,
                            current_match=payload["current"].get("match", {}),
                            local_profile=payload["match_profile"],
                            candidate_profiles=candidates_phase2,
                            extra_instructions=match_instructions,
                            forbidden_columns=forbidden_phase2,
                        )
                        self._log_llm_mapping_event("match_review_phase2_done")
                    except Exception as exc:
                        match_review_error = str(exc)
                        self._log_llm_mapping_event("match_review_phase2_failed", error=str(exc))
            except Exception as exc:
                mapping_error = str(exc)
                self._log_llm_mapping_event("worker_failed", error=str(exc))
            self._log_llm_mapping_event(
                "worker_finished",
                suggestions_count=len(suggestions or []),
                fa_review_count=len(fa_review or []),
                has_match_review=match_review is not None,
                errors=[msg for msg in (mapping_error, fa_review_error, match_review_error) if msg],
            )
            self.after(0, lambda: self._safe_apply_llm_mapping_suggestions(
                suggestions,
                payload["cols1"],
                payload["cols2"],
                match_review,
                signature,
                match_review_error,
                fa_review,
                fa_review_error,
                payload["current"],
                mapping_error,
                payload["match_profile"],
            ))

        self._log_llm_mapping_event("worker_thread_starting")
        threading.Thread(target=worker, daemon=True).start()

    def _safe_apply_llm_mapping_suggestions(self, *args, **kwargs):
        try:
            self._apply_llm_mapping_suggestions(*args, **kwargs)
        except Exception as exc:
            self._log_llm_mapping_event("apply_failed", error=str(exc))
            self._finish_llm_mapping(f"大模型辅助判断未能完成：{exc}", show_warning=True)

    def _apply_llm_mapping_suggestions(self, suggestions, cols1, cols2, match_review=None, match_signature=None, match_review_error=None, fa_review=None, fa_review_error=None, review_current_mapping=None, mapping_error=None, match_profile=None):
        # 每次大模型跑完都重新评估弹窗——只在“当前这一批返回”内防止同一条建议被
        # 重复展示，不要把上一次的指纹带过来，否则用户重新选文件后即使 LLM 又给出
        # 同样的提示，弹窗也会被吞掉。
        self._llm_shown_match_review_keys = set()
        self._llm_shown_fa_review_keys = set()
        review_current_mapping = review_current_mapping or self._current_llm_mapping()
        suggestions = list(suggestions or [])
        fa_review = list(fa_review or [])
        applied = 0
        reviews = 0
        skipped = 0
        headers = {"file1": set(cols1), "file2": set(cols2)}
        self._log_llm_mapping_event(
            "apply_started",
            suggestions_count=len(suggestions or []),
            has_match_review=match_review is not None,
            fa_review_count=len(fa_review or []),
        )
        for item in suggestions or []:
            side = item.file_side if item.file_side in ("file1", "file2") else ""
            col = item.suggested_column
            if not side or col not in headers.get(side, set()):
                skipped += 1
                self._log_llm_mapping_event(
                    "suggestion_skipped",
                    reason="column_not_found",
                    role=getattr(item, "role", ""),
                    side=side,
                    column=col,
                )
                continue
            if item.action == "fill" and item.confidence >= AUTO_APPLY_CONFIDENCE:
                if self._fill_llm_role(item.role, side, col, cols1, cols2):
                    applied += 1
                else:
                    skipped += 1
                    self._log_llm_mapping_event(
                        "suggestion_skipped",
                        reason="fill_failed",
                        role=getattr(item, "role", ""),
                        side=side,
                        column=col,
                    )
            elif item.action == "review":
                reviews += 1
            else:
                skipped += 1
                self._log_llm_mapping_event(
                    "suggestion_skipped",
                    reason="not_auto_apply",
                    role=getattr(item, "role", ""),
                    action=getattr(item, "action", ""),
                    confidence=getattr(item, "confidence", None),
                )
        # 在弹窗出现之前先把状态文案切换为“已完成”，避免用户看到弹窗时
        # 顶部仍显示“大模型辅助判断中…”而误以为模型还在跑。最终的统计文案
        # 由后面的 _finish_llm_mapping 再写一遍。
        self._llm_mapping_running = False
        self._set_llm_mapping_status(
            f"大模型辅助判断已完成，已补充 {applied} 项字段映射，正在整理复核建议...",
            foreground=PRIMARY,
            mode="done",
        )

        if match_review is not None:
            # 前端兜底清洗：即便 LLM 仍把已映射的业务字段塞进了建议，这里也会
            # 剔掉；如果剔后两侧列数不等或剔空，会降级为“保持当前匹配键”的提示。
            mapping_extras = {}
            for sug in (suggestions or []):
                role = getattr(sug, "role", "")
                action = getattr(sug, "action", "")
                side = getattr(sug, "file_side", "")
                col = getattr(sug, "suggested_column", "")
                if role and action == "fill" and side in ("file1", "file2") and col:
                    mapping_extras.setdefault(role, {})[side] = col
            forbidden_final = self._collect_forbidden_match_key_columns(extra_mapping_suggestions=mapping_extras)
            match_review, scrubbed = sanitize_llm_match_review_against_forbidden(match_review, forbidden_final)
            if scrubbed:
                self._log_llm_mapping_event(
                    "match_review_scrubbed_forbidden",
                    forbidden_file1_count=len(forbidden_final.get("file1", [])),
                    forbidden_file2_count=len(forbidden_final.get("file2", [])),
                )
            if self._handle_llm_match_key_review(match_review, cols1, cols2, match_profile=match_profile):
                reviews += 1
            self._last_llm_match_review_signature = match_signature
        reviews += self._handle_llm_fa_mapping_review(fa_review, cols1, cols2, review_current_mapping)
        errors = _dedupe_messages([msg for msg in (mapping_error, fa_review_error, match_review_error) if msg])
        if errors and applied == 0 and reviews == 0:
            if all(_is_llm_empty_response_error(msg) for msg in errors):
                self._finish_llm_mapping("大模型暂未返回可用建议，已跳过辅助判断；你仍可继续手动配置。", show_warning=False)
                return
            self._finish_llm_mapping("大模型辅助判断未能完成：" + "；".join(errors), show_warning=True)
            return
        suffix_parts = format_llm_error_parts(
            [
                ("字段建议", mapping_error),
                ("字段口径复核", fa_review_error),
                ("匹配列复核", match_review_error),
            ]
        )
        suffix = (" " + "；".join(suffix_parts)) if suffix_parts else ""
        self._log_llm_mapping_event(
            "apply_finished",
            applied=applied,
            reviews=reviews,
            skipped=skipped,
            errors=[msg for msg in (mapping_error, fa_review_error, match_review_error) if msg],
        )
        self._finish_llm_mapping(f"大模型辅助判断完成：已补充 {applied} 项字段映射，复核提示 {reviews} 项。{suffix}")

    def _handle_llm_fa_mapping_review(self, review_items, cols1, cols2, current_mapping):
        decisions = build_fa_mapping_review_decisions(
            review_items,
            cols1=cols1,
            cols2=cols2,
            current_mapping=current_mapping,
            role_labels=self._llm_role_label_map(),
        )
        if not decisions:
            return 0

        # 仅展示尚未向用户提示过的复核条目，避免相同建议反复弹窗。
        shown_keys = getattr(self, "_llm_shown_fa_review_keys", None)
        if shown_keys is None:
            shown_keys = set()
            self._llm_shown_fa_review_keys = shown_keys
        log_event = getattr(self, "_log_llm_mapping_event", lambda *a, **k: None)
        pending = []
        for decision in decisions:
            sig = _fa_review_decision_signature(decision)
            if sig in shown_keys:
                log_event("fa_review_dedup_skipped", role=decision.get("role"))
                continue
            pending.append((sig, decision))

        if not pending:
            return 0

        total = len(pending)
        for index, (sig, decision) in enumerate(pending, start=1):
            shown_keys.add(sig)
            message = build_fa_mapping_review_dialog_text(decision)
            title = f"LLM 字段映射复核（{index}/{total}）"
            if decision.get("can_apply") and decision.get("apply_mapping"):
                if ask_apply_llm_suggestion(self, title, message):
                    for side, col in (decision.get("apply_mapping") or {}).items():
                        self._replace_llm_role(decision["role"], side, col, cols1, cols2)
            else:
                messagebox.showinfo(title, message)
        return total


    def _handle_llm_match_key_review(self, review, cols1, cols2, match_profile=None):
        decision = build_match_key_review_decision(
            review,
            cols1=cols1,
            cols2=cols2,
            current1=self.match_columns1,
            current2=self.match_columns2,
        )
        if not decision.get("show"):
            if review is not None:
                return False
            local_review = build_local_match_key_review(
                match_profile,
                current1=self.match_columns1,
                current2=self.match_columns2,
            )
            decision = build_match_key_review_decision(
                local_review,
                cols1=cols1,
                cols2=cols2,
                current1=self.match_columns1,
                current2=self.match_columns2,
            )
        if not decision.get("show"):
            return False
        # 相同的匹配列 + 相同的建议组合只向用户提示一次，避免再次配置或点击下一步时
        # 反复跳出同样的风险弹窗。
        sig = (
            tuple(self.match_columns1 or []),
            tuple(self.match_columns2 or []),
            tuple(decision.get("suggested_file1_columns") or []),
            tuple(decision.get("suggested_file2_columns") or []),
            bool(decision.get("can_apply")),
        )
        shown_keys = getattr(self, "_llm_shown_match_review_keys", None)
        if shown_keys is None:
            shown_keys = set()
            self._llm_shown_match_review_keys = shown_keys
        if sig in shown_keys:
            log_event = getattr(self, "_log_llm_mapping_event", lambda *a, **k: None)
            log_event("match_review_dedup_skipped")
            return False
        shown_keys.add(sig)
        current_text = (
            f"文件1：{' + '.join(self.match_columns1 or ['未选择'])}\n"
            f"文件2：{' + '.join(self.match_columns2 or ['未选择'])}"
        )
        reasons = "\n".join(f"- {reason}" for reason in decision.get("reasons", []) if reason) or "- LLM 认为当前匹配列需要人工复核。"
        suggestion = (
            f"文件1：{' + '.join(decision['suggested_file1_columns']) or '无明确建议'}\n"
            f"文件2：{' + '.join(decision['suggested_file2_columns']) or '无明确建议'}"
        )
        if decision.get("can_apply"):
            message = (
                "LLM 提示当前唯一识别码可能不适合作为匹配列。\n\n"
                f"当前匹配列：\n{current_text}\n\n"
                f"原因：\n{reasons}\n\n"
                f"建议改为：\n{suggestion}\n\n"
                "请选择是否采纳建议。采纳后会自动修正匹配列；不采纳则保持当前设置。"
            )
            if ask_apply_llm_suggestion(self, "LLM 匹配列复核", message):
                self._apply_match_key_columns(decision["suggested_file1_columns"], decision["suggested_file2_columns"], cols1, cols2)
        else:
            messagebox.showinfo(
                "LLM 匹配列复核",
                "LLM 提示当前唯一识别码可能需要人工复核。\n\n"
                f"当前匹配列：\n{current_text}\n\n"
                f"原因：\n{reasons}\n\n"
                f"建议参考：\n{suggestion}",
            )
        return True

    def _apply_match_key_columns(self, columns1, columns2, cols1, cols2):
        if not columns1 or not columns2 or len(columns1) != len(columns2):
            return False
        if any(col not in cols1 for col in columns1) or any(col not in cols2 for col in columns2):
            return False
        self.match_col1_listbox.selection_clear(0, tk.END)
        self.match_col2_listbox.selection_clear(0, tk.END)
        for col in columns1:
            self.match_col1_listbox.selection_set(cols1.index(col))
        for col in columns2:
            self.match_col2_listbox.selection_set(cols2.index(col))
        self.match_columns1 = list(columns1)
        self.match_columns2 = list(columns2)
        self._update_selected_match_columns(1)
        self._update_selected_match_columns(2)
        self._match_columns_auto_default = False
        return True

    def _current_match_key_profile(self):
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        match1 = [self._find_actual_column_name(col, cols1_raw, '_文件1') for col in (self.match_columns1 or [])]
        match2 = [self._find_actual_column_name(col, cols2_raw, '_文件2') for col in (self.match_columns2 or [])]
        return {
            "file1": build_unique_key_profile(self.file_handler.file1_df, match1),
            "file2": build_unique_key_profile(self.file_handler.file2_df, match2),
        }

    def _current_match_key_candidate_profiles(self):
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        match1 = [self._find_actual_column_name(col, cols1_raw, '_鏂囦欢1') for col in (self.match_columns1 or [])]
        match2 = [self._find_actual_column_name(col, cols2_raw, '_鏂囦欢2') for col in (self.match_columns2 or [])]
        return build_match_key_candidate_profiles(
            self.file_handler.file1_df,
            self.file_handler.file2_df,
            match1,
            match2,
            cols1=cols1_raw,
            cols2=cols2_raw,
        )

    def _match_profile_has_local_risk(self, profile):
        if not isinstance(profile, dict):
            return False
        for side in ("file1", "file2"):
            side_profile = profile.get(side)
            if not isinstance(side_profile, dict):
                continue
            if int(side_profile.get("duplicate_row_count") or 0) > 0:
                return True
            if int(side_profile.get("blank_count") or 0) > 0:
                return True
        return False

    def _match_review_signature(self, current_match, profile):
        if not current_match:
            return None
        file1 = tuple(current_match.get("file1") or [])
        file2 = tuple(current_match.get("file2") or [])
        if not file1 or not file2:
            return None
        p1 = profile.get("file1", {}) if isinstance(profile, dict) else {}
        p2 = profile.get("file2", {}) if isinstance(profile, dict) else {}
        return (
            file1,
            file2,
            p1.get("row_count"),
            p1.get("blank_count"),
            p1.get("duplicate_row_count"),
            p2.get("row_count"),
            p2.get("blank_count"),
            p2.get("duplicate_row_count"),
        )

    def _finish_llm_mapping(self, message, show_warning=False):
        self._llm_mapping_running = False
        self._set_llm_mapping_status(
            message,
            foreground=ERROR if show_warning else PRIMARY,
            mode="error" if show_warning else "done",
        )

    def _set_llm_mapping_status(self, message, foreground=ERROR, *, running=False, icon="", mode=""):
        if message and self.status_callback:
            try:
                self.status_callback(message)
            except Exception as exc:
                self._log_llm_mapping_event("status_callback_failed", error=str(exc), message=message)
        if not hasattr(self, "llm_status_var") or not hasattr(self, "llm_status_frame"):
            return
        self._cancel_llm_status_spin()
        mode = mode or ("running" if running else "")
        self._llm_status_text = message
        self._llm_status_mode = mode
        self._llm_status_spin_index = 0
        self.llm_status_var.set(message)
        if message:
            self._llm_status_animating = mode in {"queued", "running"}
            self.llm_status_icon_var.set(icon or self._llm_status_icon())
            self.llm_status_icon_label.configure(foreground=foreground)
            self.llm_status_label.configure(foreground=foreground)
            if not self.llm_status_frame.winfo_ismapped():
                self.llm_status_frame.pack(fill=tk.X, pady=(0, 8), after=self.info_label)
            if self._llm_status_animating:
                self._animate_llm_status_icon()
        else:
            self._llm_status_animating = False
            self._llm_status_mode = ""
            self.llm_status_icon_var.set("")
            if self.llm_status_frame.winfo_ismapped():
                self.llm_status_frame.pack_forget()

    def _animate_llm_status_icon(self):
        if not self._llm_status_animating or not hasattr(self, "llm_status_icon_var"):
            self._llm_status_spin_job = None
            return
        self.llm_status_icon_var.set(self._llm_status_icon())
        self._llm_status_spin_index += 1
        self._llm_status_spin_job = self.after(180, self._animate_llm_status_icon)

    def _llm_status_icon(self):
        if self._llm_status_mode == "queued":
            frames = ("[.]", "[..]", "[...]")
            return frames[self._llm_status_spin_index % len(frames)]
        if self._llm_status_mode == "running":
            frames = ("|", "/", "-", "\\")
            return frames[self._llm_status_spin_index % len(frames)]
        if self._llm_status_mode == "done":
            return "[OK]"
        if self._llm_status_mode == "error":
            return "[X]"
        return ""

    def _cancel_llm_status_spin(self):
        self._llm_status_animating = False
        if self._llm_status_spin_job is not None:
            try:
                self.after_cancel(self._llm_status_spin_job)
            except tk.TclError:
                pass
            self._llm_status_spin_job = None

    def _replace_llm_role(self, role, side, col, cols1, cols2):
        target = self._llm_role_targets().get(role)
        if not target or side not in ("file1", "file2"):
            return False
        file_index = 1 if side == "file1" else 2
        entry = target.get(file_index)
        cols = cols1 if file_index == 1 else cols2
        if not entry or col not in cols:
            return False
        if entry.get("var") is not None:
            entry["var"].set(col)
        combo = entry.get("combo")
        if combo is not None:
            try:
                combo.current(1 + cols.index(col))
            except tk.TclError:
                combo.set(col)
        return True

    def _fill_llm_role(self, role, side, col, cols1, cols2):
        if role == "match":
            cols = cols1 if side == "file1" else cols2
            listbox = self.match_col1_listbox if side == "file1" else self.match_col2_listbox
            current = self.match_columns1 if side == "file1" else self.match_columns2
            if current or col not in cols:
                return False
            index = cols.index(col)
            listbox.selection_clear(0, tk.END)
            listbox.selection_set(index)
            if side == "file1":
                self.match_columns1 = [col]
                self._update_selected_match_columns(1)
            else:
                self.match_columns2 = [col]
                self._update_selected_match_columns(2)
            self._match_columns_auto_default = True
            self._append_mapped_name_to_auto_match_columns(cols1, cols2)
            return True
        target = self._llm_role_targets().get(role)
        if not target:
            return False
        file_index = 1 if side == "file1" else 2
        entry = target.get(file_index)
        if not entry:
            return False
        current = entry["var"].get() if entry.get("var") is not None else ""
        if current and current != "[不映射]":
            return False
        entry["var"].set(col)
        combo = entry.get("combo")
        cols = cols1 if file_index == 1 else cols2
        if combo is not None and col in cols:
            try:
                combo.current(1 + cols.index(col))
            except tk.TclError:
                combo.set(col)
        if role == "name":
            self._append_mapped_name_to_auto_match_columns(cols1, cols2)
        return True

    def _llm_role_targets(self):
        return {
            "original_value": {1: {"var": self.original_value_col1_var, "combo": self.orig_col1_combo}, 2: {"var": self.original_value_col2_var, "combo": self.orig_col2_combo}},
            "depreciation": {1: {"var": self.depreciation_col1_var, "combo": self.dep_col1_combo}, 2: {"var": self.depreciation_col2_var, "combo": self.dep_col2_combo}},
            "category": {1: {"var": self.category_col1_var, "combo": self.category_col1_combo}, 2: {"var": self.category_col2_var, "combo": self.category_col2_combo}},
            "name": {1: {"var": self.name_col1_var, "combo": self.name_col1_combo}, 2: {"var": self.name_col2_var, "combo": self.name_col2_combo}},
            "date": {1: {"var": self.date_col1_var, "combo": self.date_col1_combo}, 2: {"var": self.date_col2_var, "combo": self.date_col2_combo}},
            "life": {1: {"var": self.life_col1_var, "combo": self.life_col1_combo}, 2: {"var": self.life_col2_var, "combo": self.life_col2_combo}},
            "residual": {1: {"var": self.residual_col1_var, "combo": self.residual_col1_combo}, 2: {"var": self.residual_col2_var, "combo": self.residual_col2_combo}},
            "current_year_dep": {2: {"var": self.current_year_dep_col2_var, "combo": self.current_year_dep_col2_combo}},
            "addition_method": {1: {"var": self.addition_method_col1_var, "combo": self.addition_method_col1_combo}, 2: {"var": self.addition_method_col2_var, "combo": self.addition_method_col2_combo}},
            "addition_date": {1: {"var": self.addition_date_col1_var, "combo": self.addition_date_col1_combo}, 2: {"var": self.addition_date_col2_var, "combo": self.addition_date_col2_combo}},
            "disposal_method": {1: {"var": self.disposal_method_col1_var, "combo": self.disposal_method_col1_combo}, 2: {"var": self.disposal_method_col2_var, "combo": self.disposal_method_col2_combo}},
            "disposal_date": {1: {"var": self.disposal_date_col1_var, "combo": self.disposal_date_col1_combo}, 2: {"var": self.disposal_date_col2_var, "combo": self.disposal_date_col2_combo}},
            "disposal_orig": {1: {"var": self.disposal_orig_col1_var, "combo": self.disposal_orig_col1_combo}, 2: {"var": self.disposal_orig_col2_var, "combo": self.disposal_orig_col2_combo}},
            "disposal_dep": {1: {"var": self.disposal_dep_col1_var, "combo": self.disposal_dep_col1_combo}, 2: {"var": self.disposal_dep_col2_var, "combo": self.disposal_dep_col2_combo}},
        }

    def _llm_role_label_map(self):
        return {item["role"]: item.get("label") or item["role"] for item in self._llm_role_definitions()}

    def _current_llm_mapping(self):
        current = {
            "match": {"file1": list(self.match_columns1 or []), "file2": list(self.match_columns2 or [])},
        }
        for role, sides in self._llm_role_targets().items():
            current[role] = {}
            for file_index, entry in sides.items():
                value = entry["var"].get() if entry.get("var") is not None else ""
                current[role][f"file{file_index}"] = "" if value == "[不映射]" else value
        return current

    def _collect_forbidden_match_key_columns(self, extra_mapping_suggestions=None):
        """Gather actual column names that must NOT appear in match-key suggestions.

        Rules:
        - All currently-mapped business-attribute fields (category/life/residual/
          original_value/depreciation/current_year_dep/date/...) on either side
          are forbidden, because these fields change between opening and closing
          periods and using them as part of the match key would mis-pair the
          same card.
        - role='name' (asset name) is the documented exception - it does NOT go
          into the forbidden list, so it remains available as an auxiliary key.
        - role='match' (the match key itself) is excluded - the current key is
          not "forbidden", we just don't want to reinforce it as such.
        - extra_mapping_suggestions is an optional dict {role: {"file1": col, "file2": col}}
          that lets us additionally forbid columns the mapping LLM is about to
          fill in - those columns may become user-accepted mappings and would
          then clash with the match key.
        """
        forbidden = {"file1": set(), "file2": set()}
        excluded_roles = {"match", "name"}
        for role, sides in self._llm_role_targets().items():
            if role in excluded_roles:
                continue
            for file_index, entry in sides.items():
                var = entry.get("var") if isinstance(entry, dict) else None
                if var is None:
                    continue
                try:
                    value = var.get()
                except Exception:
                    value = ""
                if not value or value == "[不映射]":
                    continue
                side_key = f"file{file_index}"
                forbidden[side_key].add(str(value))
        if isinstance(extra_mapping_suggestions, dict):
            for role, sides in extra_mapping_suggestions.items():
                if role in excluded_roles:
                    continue
                if not isinstance(sides, dict):
                    continue
                for side_key in ("file1", "file2"):
                    val = sides.get(side_key)
                    if isinstance(val, str) and val.strip() and val != "[不映射]":
                        forbidden[side_key].add(val.strip())
        return {
            "file1": sorted(forbidden["file1"]),
            "file2": sorted(forbidden["file2"]),
        }

    def _llm_role_definitions(self):
        base = [
            ("match", "匹配列/固定资产编号/资产编码/卡片号"),
            ("original_value", "原值/资产原值/成本"),
            ("depreciation", "累计折旧"),
            ("category", "资产类别"),
            ("name", "固定资产名称"),
            ("date", "入账开始日期/取得日期/资本化日期"),
            ("life", "使用寿命(月)/使用年限"),
            ("residual", "残值率"),
            ("current_year_dep", "本年折旧"),
            ("addition_method", "新增方式"),
            ("addition_date", "新增时间"),
            ("disposal_method", "处置方式"),
            ("disposal_date", "处置时间"),
            ("disposal_orig", "处置原值/原值减少"),
            ("disposal_dep", "处置折旧/累计折旧减少"),
        ]
        return [{"role": role, "label": label, "description": label} for role, label in base]

    def _llm_column_samples(self, df):
        samples = {}
        try:
            for col in list(df.columns)[:80]:
                vals = []
                for val in df[col].dropna().astype(str).head(3).tolist():
                    text = val.strip()
                    if text:
                        vals.append(text[:60])
                samples[str(col)] = vals
        except Exception:
            pass
        return samples

    def _llm_column_profiles(self, df):
        profiles = {}
        try:
            import re
            for col in list(df.columns)[:80]:
                series = df[col].dropna().astype(str).map(lambda v: v.strip())
                series = series[series != ""]
                sample = series.head(200).tolist()
                lengths = [len(text) for text in sample]
                denom = len(sample) or 1
                code_like = sum(1 for text in sample if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.\-\/]{0,11}", text))
                cjk_short = sum(1 for text in sample if re.search(r"[\u4e00-\u9fff]", text) and len(text) <= 15)
                long_text = sum(1 for text in sample if len(text) > 15)
                profiles[str(col)] = {
                    "non_empty_count": int(series.size),
                    "unique_count": int(series.nunique(dropna=True)),
                    "avg_text_len": round(sum(lengths) / len(lengths), 1) if lengths else 0,
                    "max_text_len": max(lengths) if lengths else 0,
                    "looks_like_code_ratio": round(code_like / denom, 2),
                    "cjk_short_name_ratio": round(cjk_short / denom, 2),
                    "long_text_ratio": round(long_text / denom, 2),
                }
        except Exception:
            pass
        return profiles
    
    def _show_column_selection_menu(self, event, col_type, file_num):
        """显示列选择右键菜单"""
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="手动选择列", command=lambda: self._show_column_picker_dialog(col_type, file_num))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _show_column_picker_dialog(self, col_type, file_num):
        """显示列选择对话框。file_num=1 仅用文件1列，file_num=2 仅用文件2列。"""
        # 字段类型到变量和标题的映射
        field_config = {
            'match': ('匹配列', None),  # match类型不使用var，直接使用match_columns1/2
            'original_value': ('原值列', self.original_value_col1_var if file_num == 1 else self.original_value_col2_var),
            'depreciation': ('累计折旧列', self.depreciation_col1_var if file_num == 1 else self.depreciation_col2_var),
            'category': ('资产类别列', self.category_col1_var if file_num == 1 else self.category_col2_var),
            'name': ('固定资产名称列', self.name_col1_var if file_num == 1 else self.name_col2_var),
            'date': ('入账开始日期列', self.date_col1_var if file_num == 1 else self.date_col2_var),
            'life': ('使用寿命列', self.life_col1_var if file_num == 1 else self.life_col2_var),
            'residual': ('残值率列', self.residual_col1_var if file_num == 1 else self.residual_col2_var),
            'current_year_dep': ('本年折旧列', self.current_year_dep_col1_var if file_num == 1 else self.current_year_dep_col2_var),
            'addition_method': ('新增方式列', self.addition_method_col1_var if file_num == 1 else self.addition_method_col2_var),
            'addition_date': ('新增时间列', self.addition_date_col1_var if file_num == 1 else self.addition_date_col2_var),
            'disposal_method': ('处置方式列', self.disposal_method_col1_var if file_num == 1 else self.disposal_method_col2_var),
            'disposal_date': ('处置时间列', self.disposal_date_col1_var if file_num == 1 else self.disposal_date_col2_var),
            'disposal_orig': ('处置原值列', self.disposal_orig_col1_var if file_num == 1 else self.disposal_orig_col2_var),
            'disposal_dep': ('处置折旧列', self.disposal_dep_col1_var if file_num == 1 else self.disposal_dep_col2_var),
        }
        
        if file_num == 1:
            columns = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
            file_display_name = self._get_file_display_name(1)
        else:
            columns = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
            file_display_name = self._get_file_display_name(2)
        
        field_name, var = field_config.get(col_type, ('列', None))
        if var is None and col_type != 'match':  # match类型允许var为None
            return
        
        # 对于match类型，current_col不需要（使用match_columns1/2）
        # 对于其他类型，从var获取当前值
        current_col = None if col_type == 'match' else (var.get() if var else None)
        title = f"选择{file_display_name}的{field_name}"
        
        if not columns:
            messagebox.showwarning("警告", "没有可用的列")
            return
        
        # 创建对话框
        dialog = tk.Toplevel(self)
        dialog.title(title)
        dialog.geometry("400x300")
        dialog.transient(self.winfo_toplevel())
        dialog.grab_set()
        
        ttk.Label(dialog, text="请选择列:", font=("Arial", 10)).pack(pady=10)
        
        list_frame = ttk.Frame(dialog)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        # 匹配列支持多选，其他列单选
        selectmode = tk.EXTENDED if col_type == 'match' else tk.SINGLE
        listbox = tk.Listbox(list_frame, height=10, selectmode=selectmode)
        listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        listbox.configure(yscrollcommand=scrollbar.set)
        
        for col in columns:
            listbox.insert(tk.END, col)
            if col_type == 'match':
                # 匹配列：选中当前已选的列
                if file_num == 1 and col in self.match_columns1:
                    listbox.selection_set(tk.END)
                elif file_num == 2 and col in self.match_columns2:
                    listbox.selection_set(tk.END)
            else:
                # 其他列：选中当前值
                if col == current_col:
                    listbox.selection_set(tk.END)
        
        button_frame = ttk.Frame(dialog)
        button_frame.pack(pady=10)
        
        def on_ok():
            selection = listbox.curselection()
            if selection:
                if col_type == 'match':
                    # 匹配列支持多选
                    selected_cols = [listbox.get(i) for i in selection]
                    if file_num == 1:
                        # 更新Listbox选择（用于数据存储）
                        self.match_col1_listbox.selection_clear(0, tk.END)
                        for col in selected_cols:
                            if col in columns:
                                idx = columns.index(col)
                                self.match_col1_listbox.selection_set(idx)
                        # 直接更新已选列列表和显示
                        self.match_columns1 = selected_cols
                        self._match_columns_auto_default = False
                        self._update_selected_match_columns(1)
                    else:
                        self.match_col2_listbox.selection_clear(0, tk.END)
                        for col in selected_cols:
                            if col in columns:
                                idx = columns.index(col)
                                self.match_col2_listbox.selection_set(idx)
                        # 直接更新已选列列表和显示
                        self.match_columns2 = selected_cols
                        self._match_columns_auto_default = False
                        self._update_selected_match_columns(2)
                else:
                    # 其他列单选
                    selected_col = listbox.get(selection[0])
                    var.set(selected_col)
                    
                    # 更新对应的下拉框选中项
                    combo_map_1 = {
                        'original_value': self.orig_col1_combo,
                        'depreciation': self.dep_col1_combo,
                        'category': self.category_col1_combo,
                        'name': self.name_col1_combo,
                        'date': self.date_col1_combo,
                        'life': self.life_col1_combo,
                        'residual': self.residual_col1_combo,
                        'addition_method': self.addition_method_col1_combo,
                        'addition_date': self.addition_date_col1_combo,
                        'disposal_method': self.disposal_method_col1_combo,
                        'disposal_date': self.disposal_date_col1_combo,
                        'disposal_orig': self.disposal_orig_col1_combo,
                        'disposal_dep': self.disposal_dep_col1_combo,
                    }
                    combo_map_2 = {
                        'original_value': self.orig_col2_combo,
                        'depreciation': self.dep_col2_combo,
                        'category': self.category_col2_combo,
                        'name': self.name_col2_combo,
                        'date': self.date_col2_combo,
                        'life': self.life_col2_combo,
                        'residual': self.residual_col2_combo,
                        'addition_method': self.addition_method_col2_combo,
                        'addition_date': self.addition_date_col2_combo,
                        'disposal_method': self.disposal_method_col2_combo,
                        'disposal_date': self.disposal_date_col2_combo,
                        'disposal_orig': self.disposal_orig_col2_combo,
                        'disposal_dep': self.disposal_dep_col2_combo,
                    }
                    
                    combo = combo_map_1.get(col_type) if file_num == 1 else combo_map_2.get(col_type)
                    if combo and selected_col in columns:
                        idx = columns.index(selected_col)
                        combo.current(1 + idx)  # +1 因为索引0是[不映射]
                    elif combo:
                        # 如果selected_col不在columns中，尝试直接设置值
                        combo.set(selected_col)
                
                dialog.destroy()
            else:
                if col_type == 'match':
                    messagebox.showwarning("警告", "请至少选择一个列")
                else:
                    messagebox.showwarning("警告", "请选择一个列")
        
        def on_cancel():
            dialog.destroy()
        
        ttk.Button(button_frame, text="确定", command=on_ok, width=10).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="取消", command=on_cancel, width=10).pack(side=tk.LEFT, padx=5)
        
        listbox.bind('<Double-Button-1>', lambda e: on_ok())
    
    def _show_header_row_menu(self, event, file_num):
        """显示标题行选择菜单。支持在任意数据行右键，将该行设为标题行。"""
        tree = self.file1_tree if file_num == 1 else self.file2_tree
        region = tree.identify_region(event.x, event.y)
        # 允许在数据行（cell、tree）或列头（heading）右键；仅在空白区域不弹出
        if region not in ('cell', 'tree', 'heading'):
            return
        # 若点在列头，无法确定“行”，不弹出设为标题行
        if region == 'heading':
            return
        item = tree.identify_row(event.y)
        if not item:
            return
        children = tree.get_children()
        if item not in children:
            return
        row_index = children.index(item)
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="设本行为标题行", command=lambda: self._set_header_row(file_num, row_index))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()
    
    def _set_header_row(self, file_num, row_index):
        """
        将预览中第 row_index 行（0-based 数据行）设为文件的标题行。
        
        预览显示的是已经用某个header读取后的DataFrame数据行。
        预览中第0行对应文件中的第 (当前header + 1) 行（第一个数据行）。
        如果用户右键点击预览中的第row_index行，想把它设为标题行，那么：
        文件中的实际行索引 = 当前header + row_index + 1
        
        优化：如果新的标题行在已加载的DataFrame中，直接从DataFrame提取，避免重新读取文件。
        """
        if file_num == 1:
            file_path = self.file1_path_var.get()
            sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
            # 获取当前使用的header（如果之前设置过）
            current_header = getattr(self, 'file1_header_row', 0)
            current_df = self.file_handler.file1_df  # 获取当前DataFrame
            self.file1_header_row = row_index
        else:
            file_path = self.file2_path_var.get()
            sheet_name = self.file2_sheet_var.get() if self.file2_sheet_var.get() else None
            # 获取当前使用的header（如果之前设置过）
            current_header = getattr(self, 'file2_header_row', 0)
            current_df = self.file_handler.file2_df  # 获取当前DataFrame
            self.file2_header_row = row_index
        
        if not file_path:
            return
        
        # 计算文件中的实际行索引
        # 预览中第row_index行对应文件中的第 (current_header + row_index + 1) 行
        # 但current_header已经是文件中的行索引了，所以需要加上row_index
        # 如果current_header=0（使用第一行作为标题），预览第0行=文件第1行，预览第row_index行=文件第(row_index+1)行
        # 如果current_header=1（使用第二行作为标题），预览第0行=文件第2行，预览第row_index行=文件第(row_index+2)行
        # 所以：文件中的行索引 = current_header + row_index + 1
        # 但pandas的header参数是0-based，所以header_0based = current_header + row_index + 1
        header_0based = current_header + row_index + 1
        
        file_display_name = self._get_file_display_name(file_num)
        
        # 优化：如果新的标题行在已加载的DataFrame中，直接从DataFrame提取，避免重新读取文件
        if current_df is not None and row_index >= 0 and row_index < len(current_df):
            try:
                # 从DataFrame中提取新的标题行
                new_header_row = current_df.iloc[row_index]
                # 将标题行转换为列名（处理NaN值）
                new_columns = []
                for val in new_header_row:
                    if pd.isna(val):
                        new_columns.append('')
                    else:
                        new_columns.append(str(val).strip())
                
                # 创建新的DataFrame，使用新的列名
                new_df = current_df.copy()
                new_df.columns = new_columns
                
                # 删除标题行（因为它是标题，不是数据）
                new_df = new_df.drop(new_df.index[row_index]).reset_index(drop=True)
                
                # 更新DataFrame
                if file_num == 1:
                    self.file_handler.file1_df = new_df
                else:
                    self.file_handler.file2_df = new_df
                
                # 更新预览和预映射（不需要重新读取文件）
                self._on_header_row_set(file_num, file_display_name, header_0based)
                
                if self.status_callback:
                    self.status_callback(f"{file_display_name}标题行已更新")
                
                # 提示已在_on_header_row_set中显示，这里不再重复显示
                return
            except Exception as e:
                # 如果从DataFrame提取失败，回退到重新读取文件
                if self.status_callback:
                    self.status_callback(f"从DataFrame提取标题行失败，将重新读取文件: {str(e)}")
        
        # 如果无法从DataFrame提取，则重新读取文件
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
        ttk.Label(progress_window, text=f"正在重新读取{file_display_name}，请稍候...", font=("Arial", 10)).pack(pady=20)
        progress_var = tk.DoubleVar()
        progress_bar = ttk.Progressbar(progress_window, variable=progress_var, maximum=100, length=250, mode='indeterminate')
        progress_bar.pack(pady=10)
        progress_bar.start(10)
        
        if self.status_callback:
            self.status_callback(f"正在重新读取{file_display_name}，使用第{header_0based + 1}行作为标题行...")
        
        _, ext = os.path.splitext(file_path)
        # 确保ext是字符串（os.path.splitext应该返回字符串，但为安全起见）
        ext = str(ext).lower() if ext else ''
        
        # 在后台线程中重新读取文件
        def reload_task():
            try:
                if ext in SUPPORTED_EXCEL_FORMATS:
                    if ext == '.xls':
                        df = pd.read_excel(file_path, sheet_name=sheet_name, engine='xlrd', header=header_0based)
                    else:
                        df = pd.read_excel(file_path, sheet_name=sheet_name, engine='openpyxl', header=header_0based)
                elif ext in SUPPORTED_CSV_FORMATS:
                    encoding = detect_encoding(file_path)
                    encodings = [encoding, 'utf-8', 'gbk', 'gb2312', 'latin-1']
                    df = None
                    for enc in encodings:
                        try:
                            df = pd.read_csv(file_path, encoding=enc, header=header_0based, low_memory=False)
                            break
                        except (UnicodeDecodeError, Exception):
                            continue
                    if df is None:
                        raise Exception(f"无法读取CSV文件，尝试的编码: {', '.join(encodings)}")
                else:
                    self.after(0, lambda: progress_window.destroy())
                    self.after(0, lambda: messagebox.showerror("错误", "不支持的文件格式"))
                    return
                
                if file_num == 1:
                    self.file_handler.file1_df = df
                else:
                    self.file_handler.file2_df = df
                
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: self._on_header_row_set(file_num, file_display_name, header_0based))
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda msg=error_msg: messagebox.showerror("错误", f"重新读取文件失败:\n{msg}"))
        
        threading.Thread(target=reload_task, daemon=True).start()
    
    def _on_header_row_set(self, file_num, file_display_name, header_0based):
        """标题行设置完成回调"""
        if file_num == 1:
            self._update_file1_preview()
        else:
            self._update_file2_preview()
        
        # 更新文件标签
        self._update_file_labels()
        
        # 确保UI更新完成后再执行预映射
        self.update_idletasks()
        
        # 更新匹配列并执行预映射
        self._update_match_columns()
        
        # 再次确保UI更新
        self.update_idletasks()
        
        if self.status_callback:
            self.status_callback(f"{file_display_name}已重新读取")
        
        messagebox.showinfo("成功", f"已将第{header_0based + 1}行设置为标题行")
    
    def _find_actual_column_name(self, col_name, cols_raw, suffix):
        """查找实际的列名（可能带后缀）"""
        if not col_name or not cols_raw:
            return col_name
        # 如果列名在原始列名中，直接返回
        if col_name in cols_raw:
            return col_name
        # 尝试添加后缀查找
        col_name_with_suffix = f"{col_name}{suffix}"
        if col_name_with_suffix in cols_raw:
            return col_name_with_suffix
        # 尝试移除后缀后匹配
        for col in cols_raw:
            if str(col).replace(suffix, '') == col_name:
                return col
        # 如果都找不到，返回原始列名
        return col_name
    
    def _get_mapped_col(self, var_value, cols_raw, suffix):
        """获取映射的列名，如果选择"[不映射]"则返回None"""
        if not var_value or var_value == '[不映射]':
            return None
        return self._find_actual_column_name(var_value, cols_raw, suffix)

    def _show_next_step_warning(self, message: str) -> None:
        """下一步前置校验提示，统一给出可操作说明。"""
        messagebox.showwarning("无法进入下一步", message)
    
    def _on_next(self):
        """下一步按钮"""
        # 注意：这里不要无条件重载文件。
        # _load_file1/_load_file2 会触发 _update_match_columns，从而重置手工映射和多选匹配列。
        # 文件在“选择文件/切换工作表/设标题行”时已经加载，下一步只做校验与提交。
        
        # 验证文件是否已选择
        file1_display_name = self._get_file_display_name(1)
        file2_display_name = self._get_file_display_name(2)
        
        # 检查是否选择了文件路径
        file1_display_name = self._get_file_display_name(1)
        file2_display_name = self._get_file_display_name(2)
        
        if not self.file1_path_var.get():
            self._show_next_step_warning("请先在左侧“文件1”区域选择并加载原始文件。")
            return
        
        is_supplement_mode = (self.mode == "supplement")
        file2_path = (self.file2_path_var.get() or "").strip()
        require_file2 = (not is_supplement_mode) or bool(file2_path)
        if require_file2 and not file2_path:
            self._show_next_step_warning("请先在左侧“文件2”区域选择并加载对比文件。")
            return
        
        # 检查Excel文件是否选择了sheet
        _, ext1 = os.path.splitext(self.file1_path_var.get())
        ext1 = str(ext1).lower() if ext1 else ''
        if ext1 in ['.xlsx', '.xls'] and not self.file1_sheet_var.get():
            self._show_next_step_warning(f"请先为“{file1_display_name}”选择工作表，再继续。")
            return
        
        if require_file2:
            _, ext2 = os.path.splitext(file2_path)
            ext2 = str(ext2).lower() if ext2 else ''
            if ext2 in ['.xlsx', '.xls'] and not self.file2_sheet_var.get():
                self._show_next_step_warning(f"请先为“{file2_display_name}”选择工作表，再继续。")
                return
        
        if self.file_handler.file1_df is None:
            self._show_next_step_warning(f"“{file1_display_name}”尚未加载完成，请重新选择文件或工作表。")
            return
        
        if require_file2 and self.file_handler.file2_df is None:
            self._show_next_step_warning(f"“{file2_display_name}”尚未加载完成，请重新选择文件或工作表。")
            return
        
        # 获取选中的匹配列（列表格式）
        match_cols1 = self.match_columns1.copy() if self.match_columns1 else []
        match_cols2 = self.match_columns2.copy() if self.match_columns2 else []
        
        if not match_cols1:
            self._show_next_step_warning(f"请在“{file1_display_name}”的匹配列区域至少选择一个匹配列。")
            return
        
        if require_file2:
            if not match_cols2:
                self._show_next_step_warning(f"请在“{file2_display_name}”的匹配列区域至少选择一个匹配列。")
                return
            if len(match_cols1) != len(match_cols2):
                self._show_next_step_warning(
                    f"文件1和文件2的匹配列数量必须相同。\n\n"
                    f"当前：文件1已选 {len(match_cols1)} 列，文件2已选 {len(match_cols2)} 列。"
                )
                return
        
        # 如果列名中有"_文件1"或"_文件2"后缀，需要移除（因为这是合并时添加的，不应该在文件选择阶段存在）
        # 但如果DataFrame的列名确实有后缀，需要找到对应的原始列名
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        
        # 查找原始列名（可能带后缀）- 支持多列
        match_cols1_actual = []
        match_cols2_actual = []
        
        for match_col1 in match_cols1:
            match_col1_actual = match_col1
            if match_col1 not in cols1_raw:
                match_col1_with_suffix = f"{match_col1}_文件1"
                if match_col1_with_suffix in cols1_raw:
                    match_col1_actual = match_col1_with_suffix
                else:
                    # 尝试直接查找（可能列名本身就有后缀）
                    for col in cols1_raw:
                        if str(col).replace('_文件1', '') == match_col1:
                            match_col1_actual = col
                            break
            match_cols1_actual.append(match_col1_actual)
        
        for match_col2 in match_cols2:
            match_col2_actual = match_col2
            if match_col2 not in cols2_raw:
                match_col2_with_suffix = f"{match_col2}_文件2"
                if match_col2_with_suffix in cols2_raw:
                    match_col2_actual = match_col2_with_suffix
                else:
                    # 尝试直接查找（可能列名本身就有后缀）
                    for col in cols2_raw:
                        if str(col).replace('_文件2', '') == match_col2:
                            match_col2_actual = col
                            break
            match_cols2_actual.append(match_col2_actual)
        
        # 准备配置（使用实际的列名，列表格式）
        config = {
            'match_column1': match_cols1_actual,  # 改为列表
            'match_column2': match_cols2_actual,  # 改为列表
            'data_type1': self.data_type1_var.get(),
            'data_type2': self.data_type2_var.get(),
            'remove_spaces': False,
            'case_sensitive': True,
            'handle_duplicates': 'pivot',
            'original_value_col1': self._find_actual_column_name(self.original_value_col1_var.get(), cols1_raw, '_文件1') if self.original_value_col1_var.get() else None,
            'original_value_col2': self._find_actual_column_name(self.original_value_col2_var.get(), cols2_raw, '_文件2') if self.original_value_col2_var.get() else None,
            'depreciation_col1': self._find_actual_column_name(self.depreciation_col1_var.get(), cols1_raw, '_文件1') if self.depreciation_col1_var.get() else None,
            'depreciation_col2': self._find_actual_column_name(self.depreciation_col2_var.get(), cols2_raw, '_文件2') if self.depreciation_col2_var.get() else None,
            'file1_display_name': file1_display_name,
            'file2_display_name': file2_display_name,
            # 新增字段映射配置（处理"[不映射]"选项）
            'category_col1': self._get_mapped_col(self.category_col1_var.get(), cols1_raw, '_文件1'),
            'category_col2': self._get_mapped_col(self.category_col2_var.get(), cols2_raw, '_文件2'),
            'name_col1': self._get_mapped_col(self.name_col1_var.get(), cols1_raw, '_文件1'),
            'name_col2': self._get_mapped_col(self.name_col2_var.get(), cols2_raw, '_文件2'),
            'date_col1': self._get_mapped_col(self.date_col1_var.get(), cols1_raw, '_文件1'),
            'date_col2': self._get_mapped_col(self.date_col2_var.get(), cols2_raw, '_文件2'),
            'life_col1': self._get_mapped_col(self.life_col1_var.get(), cols1_raw, '_文件1'),
            'life_col2': self._get_mapped_col(self.life_col2_var.get(), cols2_raw, '_文件2'),
            'residual_col1': self._get_mapped_col(self.residual_col1_var.get(), cols1_raw, '_文件1'),
            'residual_col2': self._get_mapped_col(self.residual_col2_var.get(), cols2_raw, '_文件2'),
            'current_year_dep_col1': None,
            'current_year_dep_col2': self._get_mapped_col(self.current_year_dep_col2_var.get(), cols2_raw, '_文件2'),
            'balance_sheet_date': self.balance_sheet_date_var.get().strip() or "2025/12/31",
            'addition_method_col1': self._get_mapped_col(self.addition_method_col1_var.get(), cols1_raw, '_文件1'),
            'addition_method_col2': self._get_mapped_col(self.addition_method_col2_var.get(), cols2_raw, '_文件2'),
            'addition_date_col1': self._get_mapped_col(self.addition_date_col1_var.get(), cols1_raw, '_文件1'),
            'addition_date_col2': self._get_mapped_col(self.addition_date_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_method_col1': self._get_mapped_col(self.disposal_method_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_method_col2': self._get_mapped_col(self.disposal_method_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_date_col1': self._get_mapped_col(self.disposal_date_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_date_col2': self._get_mapped_col(self.disposal_date_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_orig_col1': self._get_mapped_col(self.disposal_orig_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_orig_col2': self._get_mapped_col(self.disposal_orig_col2_var.get(), cols2_raw, '_文件2'),
            'disposal_dep_col1': self._get_mapped_col(self.disposal_dep_col1_var.get(), cols1_raw, '_文件1'),
            'disposal_dep_col2': self._get_mapped_col(self.disposal_dep_col2_var.get(), cols2_raw, '_文件2'),
        }
        
        # 调用完成回调
        if self.on_complete:
            self.on_complete(config)

