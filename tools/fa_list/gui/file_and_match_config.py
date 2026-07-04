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
from launcher.llm_client import AUTO_APPLY_CONFIDENCE, LLMMatchKeyReview, generate_combined_fa_list_assistance, review_fa_list_field_mappings, review_match_key_columns, review_supplement_match_key_columns, suggest_field_mappings
from launcher.llm_settings import is_llm_enabled, load_llm_settings
from launcher.ui_theme import (
    BG,
    BORDER,
    ERROR,
    MUTED_TEXT,
    PRIMARY,
    PRIMARY_DARK,
    SUCCESS,
    apply_app_theme,
    center_on_parent,
    fit_window_to_screen,
)


LLM_MAPPING_BATCH_TIMEOUT_SECONDS = 45
LLM_STATUS_BG = "#fffdf8"
LLM_STATUS_BORDER = "#d9cebf"
LLM_STATUS_IDLE_BG = "#efe7db"
LLM_STATUS_RUNNING_BG = "#e6f2f3"
LLM_STATUS_DONE_BG = "#e9f4ef"
LLM_STATUS_ERROR_BG = "#f7e7e2"
ROW_STATUS_OK = SUCCESS
ROW_STATUS_PENDING = MUTED_TEXT
ROW_STATUS_REVIEW = "#9b5d33"
TREE_ODD_ROW = "#fbf7f0"
TREE_EVEN_ROW = "#ffffff"
TOP_PANEL_HEIGHT = 172


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


def build_supplement_match_key_review_decision(review, *, cols1, cols2, current1, current2, min_confidence=0.55):
    """Normalize one-sided supplement ID review into a UI decision."""
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
    changed1 = bool(suggested1) and suggested1 != current1
    changed2 = bool(suggested2) and suggested2 != current2
    has_suggestion = bool(suggested1 or suggested2)
    has_change = changed1 or changed2
    has_review_warning = action == "review" and bool(reasons)
    can_apply = action in {"replace", "review"} and confidence >= min_confidence and has_change
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


def _sanitize_match_review_reasons(reasons):
    """Keep match-ID review prompts business-facing instead of exposing diagnostics."""
    cleaned = []
    technical_patterns = (
        "file1_col_",
        "file2_col_",
        "header",
        "samples",
        "sample",
        "profile",
        "looks_like_code_ratio",
        "anonymous",
        "col_",
    )
    for reason in reasons or []:
        text = str(reason or "").strip()
        if not text:
            continue
        lowered = text.lower()
        if any(pattern in lowered for pattern in technical_patterns):
            if "code" in lowered or "asset" in lowered or "编码" in text or "卡片" in text:
                cleaned.append("当前匹配列口径不一致，建议两边统一为同一类资产编码或卡片编码")
            else:
                cleaned.append("当前匹配列可能不是同一业务口径，建议按资产唯一标识重新复核")
            continue
        cleaned.append(_localize_llm_reason(text))

    cleaned = [text for text in dict.fromkeys(cleaned) if text]
    if cleaned:
        return cleaned[:3]
    return ["当前匹配列需要人工复核，建议两边统一为同一类资产编码或卡片编码"]


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
    """Build a concise user-facing FA mapping review prompt."""
    decision = decision or {}
    label = decision.get("label") or decision.get("role") or "\u5b57\u6bb5"
    current = decision.get("current_mapping") or {}
    suggested = decision.get("suggested_mapping") or {}
    apply_mapping = decision.get("apply_mapping") or {}
    target_mapping = apply_mapping if decision.get("can_apply") and apply_mapping else suggested

    def _side_lines(mapping):
        lines = []
        for side_key, side_label in (("file1", "\u6587\u4ef61"), ("file2", "\u6587\u4ef62")):
            if side_key in mapping:
                lines.append(f"{side_label}\uff1a{mapping.get(side_key) or '\u672a\u9009\u62e9'}")
        return lines

    current_lines = _side_lines(current) or ["\u672a\u9009\u62e9"]
    suggested_lines = _side_lines(target_mapping) or ["\u65e0\u660e\u786e\u5efa\u8bae"]
    finding = f"{label}\u7684\u5f53\u524d\u6620\u5c04\u53ef\u80fd\u4e0e\u5b57\u6bb5\u7528\u9014\u4e0d\u4e00\u81f4\uff0c\u5efa\u8bae\u590d\u6838\u540e\u518d\u7ee7\u7eed\u3002"
    body = (
        f"{label}\u5b57\u6bb5\u6620\u5c04\u5efa\u8bae\n\n"
        "\u5f53\u524d\u9009\u62e9\n"
        + "\n".join(current_lines)
        + "\n\n\u590d\u6838\u53d1\u73b0\n"
        + finding
        + "\n\n\u5efa\u8bae\u9009\u62e9\n"
        + "\n".join(suggested_lines)
    )
    if decision.get("can_apply") and apply_mapping:
        return body + "\n\n\u91c7\u7eb3\u540e\u4f1a\u81ea\u52a8\u4fee\u6539\u5bf9\u5e94\u4e0b\u62c9\u6846\uff1b\u4e0d\u91c7\u7eb3\u5219\u4fdd\u6301\u5f53\u524d\u8bbe\u7f6e\u3002"
    return body + "\n\n\u8fd9\u6761\u63d0\u793a\u4e0d\u4f1a\u81ea\u52a8\u4fee\u6539\u8bbe\u7f6e\uff0c\u8bf7\u6309\u4e1a\u52a1\u53e3\u5f84\u590d\u6838\u3002"


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
    OPTIONAL_ADDITION_ROLES = (
        "addition_method",
        "addition_date",
    )
    SUPPLEMENT_ONLY_LLM_ROLES = {
        "disposal_method",
        "disposal_date",
        "disposal_orig",
        "disposal_dep",
    }

    """文件选择和匹配列配置合并组件"""
    
    def __init__(
        self,
        parent,
        file_handler: FileHandler,
        on_complete=None,
        status_callback=None,
        mode="normal",
        on_back=None,
        on_skip=None,
        supplement_reference_match_columns1=None,
        supplement_reference_match_columns2=None,
        supplement_prefill_config=None,
    ):
        super().__init__(parent, padding="10")
        self.file_handler = file_handler
        self.on_complete = on_complete
        self.status_callback = status_callback
        self.mode = mode
        self.on_back = on_back
        self.on_skip = on_skip
        self.supplement_reference_match_columns1 = list(supplement_reference_match_columns1 or [])
        self.supplement_reference_match_columns2 = list(supplement_reference_match_columns2 or [])
        self.supplement_prefill_config = dict(supplement_prefill_config or {})
        self._llm_mapping_running = False
        self._llm_mapping_assist_scheduled = False
        self._llm_mapping_assist_job = None
        self._last_llm_match_review_signature = None
        self._llm_generation = 0
        self._llm_rerun_after_current = False
        self._llm_mapping_passed = False
        self._llm_mapping_bypassed = False
        # 已经向用户弹过的 LLM 风险提示签名集合，避免重复跳出同样的弹窗。
        # 在文件/工作表变更时（_update_match_columns）清空。
        self._llm_shown_match_review_keys = set()
        self._llm_shown_fa_review_keys = set()
        self._llm_status_spin_job = None
        self._llm_status_spin_index = 0
        self._llm_status_text = ""
        self._llm_status_animating = False
        self._llm_status_mode = ""
        self._llm_review_row_roles = set()
        self._llm_last_detail_text = ""
        self._llm_detail_sections_current = []
        self.llm_status_badge_var = tk.StringVar(value="待复核")
        self.llm_status_message_var = tk.StringVar(value="选择文件并确认匹配列后，系统会进行字段复核。")
        self.llm_status_icon_var = tk.StringVar(value="")
        self.llm_status_var = tk.StringVar(value="")
        self.loading_message_var = tk.StringVar(value="")
        self._loading_mask_depth = 0
        
        # 文件路径变量
        self.file1_path_var = tk.StringVar()
        self.file2_path_var = tk.StringVar()
        self.file1_path_display_var = tk.StringVar()
        self.file2_path_display_var = tk.StringVar()
        self.file1_sheet_var = tk.StringVar()
        self.file2_sheet_var = tk.StringVar()
        
        # 匹配列变量（改为列表支持多选）
        self.match_columns1 = []  # 文件1的匹配列列表
        self.match_columns2 = []  # 文件2的匹配列列表
        self._match_columns_auto_default = False
        
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
        if self.mode == "supplement" and self.supplement_prefill_config:
            self._apply_supplement_prefill_config()
    
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

    def _role_available_in_current_mode(self, role):
        if self.mode == "supplement":
            return role == "match" or role in self.OPTIONAL_ADDITION_ROLES or role in self.SUPPLEMENT_ONLY_LLM_ROLES
        return role not in self.SUPPLEMENT_ONLY_LLM_ROLES

    def _supplement_role_allowed_side(self, role, file_index):
        if self.mode != "supplement":
            if role in {"addition_method", "addition_date"}:
                return file_index == 2
            return role not in self.SUPPLEMENT_ONLY_LLM_ROLES
        if role in {"addition_method", "addition_date"}:
            return file_index == 1
        if role in {"disposal_method", "disposal_date", "disposal_orig", "disposal_dep"}:
            return file_index == 2
        return False

    def _is_file_loaded(self, file_index):
        return self.file_handler.file1_df is not None if file_index == 1 else self.file_handler.file2_df is not None

    def _clear_disallowed_supplement_mappings(self):
        if not hasattr(self, "mapping_row_controls"):
            return
        for role, sides in self._llm_role_targets(include_disallowed=True).items():
            for file_index, entry in sides.items():
                if self._supplement_role_allowed_side(role, file_index):
                    continue
                var = entry.get("var")
                combo = entry.get("combo")
                if var is not None:
                    var.set("")
                if combo is not None:
                    combo.set("")

    def _clear_normal_file1_addition_mappings(self):
        if getattr(self, "mode", "normal") == "supplement":
            return
        for var_name, combo_name in (
            ("addition_method_col1_var", "addition_method_col1_combo"),
            ("addition_date_col1_var", "addition_date_col1_combo"),
        ):
            var = getattr(self, var_name, None)
            combo = getattr(self, combo_name, None)
            if var is not None:
                var.set("")
            if combo is not None:
                try:
                    combo.set("")
                    combo.configure(state="disabled")
                except tk.TclError:
                    pass

    def _has_optional_addition_mapping(self):
        var = getattr(self, "addition_method_col2_var", None)
        try:
            value = var.get() if var is not None else ""
        except Exception:
            value = ""
        return bool(value and value != "[不映射]")

    def _update_optional_addition_rows_visibility(self):
        if getattr(self, "mode", "normal") == "supplement":
            return
        if not hasattr(self, "mapping_row_frames"):
            return
        show = self._has_optional_addition_mapping()
        for row_type in self.OPTIONAL_ADDITION_ROLES:
            row_widget = self.mapping_row_frames.get(row_type)
            if row_widget is None:
                continue
            if show:
                row_widget.pack(fill=tk.X, pady=2, padx=5, before=self.depreciation_param_frame)
                ctrls = self.mapping_row_controls.get(row_type, {})
                combo1 = ctrls.get("combo1")
                combo2 = ctrls.get("combo2")
                if combo1 is not None:
                    combo1.set("")
                    combo1.configure(state="disabled")
                if combo2 is not None:
                    combo2.configure(state="readonly")
            else:
                row_widget.pack_forget()
        self._clear_normal_file1_addition_mappings()
        self._update_mapping_row_status()

    def _fallback_addition_date_to_entry_date(self, cols1=None, cols2=None):
        """When addition date is absent, reuse entry/start date for sides with addition method."""
        if getattr(self, "mode", "normal") == "supplement":
            return False
        changed = False

        def _apply(side, method_var, add_date_var, entry_date_var, add_date_combo, cols):
            method = (method_var.get() or "").strip()
            add_date = (add_date_var.get() or "").strip()
            entry_date = (entry_date_var.get() or "").strip()
            if not method or method == "[不映射]" or add_date or not entry_date or entry_date == "[不映射]":
                return False
            add_date_var.set(entry_date)
            if add_date_combo is not None:
                try:
                    if entry_date in (cols or []):
                        add_date_combo.current(1 + list(cols).index(entry_date))
                    else:
                        add_date_combo.set(entry_date)
                except tk.TclError:
                    add_date_combo.set(entry_date)
            return True

        changed |= _apply(
            2,
            self.addition_method_col2_var,
            self.addition_date_col2_var,
            self.date_col2_var,
            getattr(self, "addition_date_col2_combo", None),
            cols2 or [],
        )
        return changed

    def _visible_excel_sheets(self, file_path, sheets):
        sheets = list(sheets or [])
        if not sheets:
            return sheets
        _, ext = os.path.splitext(file_path or "")
        ext = str(ext).lower()
        try:
            if ext in {".xlsx", ".xlsm"}:
                from openpyxl import load_workbook
                wb = load_workbook(file_path, read_only=True, data_only=True)
                try:
                    visible = [ws.title for ws in wb.worksheets if getattr(ws, "sheet_state", "visible") == "visible"]
                finally:
                    wb.close()
                return [name for name in sheets if name in visible] or sheets
            if ext == ".xls":
                import xlrd
                book = xlrd.open_workbook(file_path, on_demand=True)
                try:
                    visible = []
                    for index, name in enumerate(book.sheet_names()):
                        visibility = getattr(book.sheet_by_index(index), "visibility", 0)
                        if visibility == 0:
                            visible.append(name)
                finally:
                    book.release_resources()
                return [name for name in sheets if name in visible] or sheets
        except Exception:
            return sheets
        return sheets

    def _set_mapping_value_from_prefill(self, var, combo, value, columns):
        value = str(value or "").strip()
        if not value:
            return
        var.set(value)
        try:
            if combo is not None:
                if value in columns:
                    combo.current(1 + columns.index(value))
                else:
                    combo.set(value)
        except Exception:
            pass

    def _apply_supplement_prefill_config(self):
        """Prefill the supplement addition side from optional step-1 addition mappings."""
        prefill = dict(self.supplement_prefill_config or {})
        file_path = str(prefill.get("path") or "").strip()
        if not file_path or not os.path.exists(file_path):
            return

        def _source_column_name(value):
            text = str(value or "").strip()
            return text.replace("_文件1", "").replace("_文件2", "")

        sheet_name = prefill.get("sheet") or None
        header_row = int(prefill.get("header_row") or 0)
        header_0based = None if header_row == 0 else header_row + 1

        self.file1_path_var.set(file_path)
        self._sync_file_path_display(1)
        self.file1_sheet_var.set(sheet_name or "")

        success, _, sheets = self.file_handler.get_excel_sheets(file_path)
        if success and sheets:
            sheets = self._visible_excel_sheets(file_path, sheets)
            self.file1_sheet_combo["values"] = sheets
            if not sheet_name and len(sheets) == 1:
                sheet_name = sheets[0]
                self.file1_sheet_var.set(sheet_name)
            elif sheet_name and sheet_name not in sheets:
                self.file1_sheet_combo["values"] = [sheet_name] + [s for s in sheets if s != sheet_name]
        elif sheet_name:
            self.file1_sheet_combo["values"] = [sheet_name]

        success, error_msg = self.file_handler.set_file1(file_path, sheet_name, header_0based)
        if not success:
            if self.status_callback:
                self.status_callback(f"新增清单预填失败：{error_msg}")
            return
        self._sync_sheet_combo_display(1, fallback_to_first=True)

        if self.status_callback:
            self.status_callback("已从第一步预填新增清单")

        self._update_file_labels()
        self._update_file1_preview()
        self._update_match_columns(trigger_llm=True)

        cols1 = [
            str(col).replace("_文件1", "").replace("_文件2", "")
            if "_文件1" in str(col) or "_文件2" in str(col)
            else str(col)
            for col in list(self.file_handler.get_file1_columns())
        ]
        match_columns = [
            col
            for col in (_source_column_name(col) for col in (prefill.get("match_columns") or []))
            if col in cols1
        ]
        if match_columns:
            self._apply_supplement_match_key_columns(match_columns, None, cols1, [])

        self._set_mapping_value_from_prefill(
            self.addition_method_col1_var,
            self.addition_method_col1_combo,
            _source_column_name(prefill.get("addition_method_col")),
            cols1,
        )
        self._set_mapping_value_from_prefill(
            self.addition_date_col1_var,
            self.addition_date_col1_combo,
            _source_column_name(prefill.get("addition_date_col")),
            cols1,
        )

    def _reset_llm_state_for_new_input(self):
        self._llm_generation += 1
        self._llm_mapping_passed = False
        self._llm_mapping_bypassed = False
        if self._llm_mapping_running:
            self._llm_rerun_after_current = True
        self._last_llm_match_review_signature = None
        self._llm_shown_match_review_keys = set()
        self._llm_shown_fa_review_keys = set()
        self._llm_review_row_roles = set()
        self._llm_last_detail_text = ""
        self._llm_detail_sections_current = []
        self._update_llm_detail_button()
        self._update_mapping_row_status()
        if self._llm_mapping_assist_job is not None:
            try:
                self.after_cancel(self._llm_mapping_assist_job)
            except Exception:
                pass
            self._llm_mapping_assist_job = None
        self._llm_mapping_assist_scheduled = False
        self._update_llm_action_buttons()
        self._update_llm_detail_button()
        self._update_next_button_state()

    def _manual_run_llm_mapping_assist(self):
        self._reset_llm_state_for_new_input()
        self._llm_mapping_bypassed = False
        self._queue_llm_mapping_assist(force=True)

    def _stop_llm_mapping_assist(self):
        self._llm_generation += 1
        self._llm_mapping_passed = False
        self._llm_mapping_bypassed = True
        self._llm_mapping_running = False
        self._llm_rerun_after_current = False
        if self._llm_mapping_assist_job is not None:
            try:
                self.after_cancel(self._llm_mapping_assist_job)
            except Exception:
                pass
            self._llm_mapping_assist_job = None
        self._llm_mapping_assist_scheduled = False
        self._set_llm_mapping_status("大模型复核已停止。你可以继续下一步，或重新复核后再继续。", foreground=ERROR, mode="stopped")
        self._log_llm_mapping_event("stopped_by_user")

    def _update_llm_action_buttons(self):
        if hasattr(self, "llm_run_button"):
            try:
                state = tk.DISABLED if self._llm_mapping_running or self._llm_mapping_assist_scheduled else tk.NORMAL
                self.llm_run_button.configure(state=state)
            except tk.TclError:
                pass
        if hasattr(self, "llm_stop_button"):
            try:
                state = tk.NORMAL if self._llm_mapping_running or self._llm_mapping_assist_scheduled else tk.DISABLED
                self.llm_stop_button.configure(state=state)
            except tk.TclError:
                pass

    def _update_next_button_state(self):
        if not hasattr(self, "next_button"):
            return
        try:
            locked = bool(is_llm_enabled() and not self._llm_mapping_passed and not self._llm_mapping_bypassed)
            self.next_button.configure(state=tk.DISABLED if locked else tk.NORMAL)
        except Exception:
            self.next_button.configure(state=tk.NORMAL)

    def _compact_path_for_display(self, path, max_len=58):
        path = str(path or "").strip()
        if not path:
            return ""
        name = os.path.basename(path) or path
        if len(name) <= max_len:
            return name
        return name[: max_len - 3] + "..."

    def _sync_file_path_display(self, file_num):
        if file_num == 1:
            self.file1_path_display_var.set(self._compact_path_for_display(self.file1_path_var.get()))
        else:
            self.file2_path_display_var.set(self._compact_path_for_display(self.file2_path_var.get()))

    def _sync_file_path_from_display(self, file_num):
        display_var = self.file1_path_display_var if file_num == 1 else self.file2_path_display_var
        path_var = self.file1_path_var if file_num == 1 else self.file2_path_var
        typed = display_var.get().strip()
        current = path_var.get().strip()
        if typed and typed != self._compact_path_for_display(current):
            path_var.set(typed)

    def _handler_sheet_matches_current_path(self, file_num):
        current_path = self.file1_path_var.get() if file_num == 1 else self.file2_path_var.get()
        handler_path = getattr(self.file_handler, f"file{file_num}_path", None)
        current_path = os.path.abspath(str(current_path or "").strip()) if current_path else ""
        handler_path = os.path.abspath(str(handler_path or "").strip()) if handler_path else ""
        return bool(current_path and handler_path and current_path == handler_path)

    def _clear_handler_sheet(self, file_num):
        try:
            setattr(self.file_handler, f"file{file_num}_sheet", None)
        except Exception:
            pass

    def _sync_sheet_combo_display(self, file_num, fallback_to_first=False):
        var = self.file1_sheet_var if file_num == 1 else self.file2_sheet_var
        combo = getattr(self, f"file{file_num}_sheet_combo", None)
        handler_value = (
            getattr(self.file_handler, f"file{file_num}_sheet", None)
            if self._handler_sheet_matches_current_path(file_num)
            else None
        )
        if combo is None:
            return
        try:
            values = list(combo.cget("values") or [])
        except tk.TclError:
            values = []
        current = str(var.get() or "").strip()
        try:
            combo_value = str(combo.get() or "").strip()
        except Exception:
            combo_value = ""
        value = current or str(handler_value or "").strip() or combo_value
        if not value and fallback_to_first and values:
            value = str(values[0])
        if not value:
            return
        if value not in values:
            try:
                combo["values"] = [value] + [item for item in values if item != value]
            except tk.TclError:
                pass
        try:
            var.set(value)
            combo.set(value)
            combo.selection_clear()
        except tk.TclError:
            pass
        if fallback_to_first and not str(handler_value or "").strip():
            try:
                setattr(self.file_handler, f"file{file_num}_sheet", value)
            except Exception:
                pass

    def _sync_all_sheet_combo_displays(self, fallback_to_first=False):
        self._sync_sheet_combo_display(1, fallback_to_first=fallback_to_first)
        self._sync_sheet_combo_display(2, fallback_to_first=fallback_to_first)

    def _decorate_preview_tree(self, tree):
        try:
            tree.tag_configure("odd", background=TREE_ODD_ROW)
            tree.tag_configure("even", background=TREE_EVEN_ROW)
        except tk.TclError:
            pass

    def _update_mapping_row_status(self, row_type=None):
        if not hasattr(self, "mapping_row_controls"):
            return
        target_rows = [row_type] if row_type else list(self.mapping_row_controls.keys())
        for current_type in target_rows:
            ctrls = self.mapping_row_controls.get(current_type) or {}
            status_label = ctrls.get("status")
            if status_label is None:
                continue
            combo1 = ctrls.get("combo1")
            combo2 = ctrls.get("combo2")
            values = []
            for combo in (combo1, combo2):
                try:
                    values.append(str(combo.get() or "").strip())
                except Exception:
                    values.append("")
            states = []
            for combo in (combo1, combo2):
                try:
                    states.append(str(combo.cget("state") or ""))
                except Exception:
                    states.append("")
            if current_type in getattr(self, "_llm_review_row_roles", set()):
                text, color = "复核建议", ROW_STATUS_REVIEW
            elif any(value and value != "[不映射]" for value in values):
                text, color = "OK", ROW_STATUS_OK
            else:
                text, color = "待选", ROW_STATUS_PENDING
            try:
                status_label.configure(text=text, foreground=color)
            except tk.TclError:
                pass

    def _compact_llm_status_for_ui(self, message, mode):
        message = str(message or "").strip()
        if not message:
            return "LLM复核：待复核"
        if mode in {"queued", "running"}:
            return "LLM复核：正在处理，请稍候"
        if mode == "stopped":
            return "LLM复核：已停止 · 可继续或重新复核"
        if mode == "done":
            applied_match = re.search(r"已补充\s*(\d+)\s*项", message)
            review_match = re.search(r"复核提示\s*(\d+)\s*项", message)
            applied = applied_match.group(1) if applied_match else "0"
            reviews = review_match.group(1) if review_match else "0"
            return f"LLM复核：已完成 · 已补充 {applied} 项 · 复核提示 {reviews} 项"
        if mode == "error":
            if "已停止" in message:
                return "LLM复核：已停止 · 可继续或重新复核"
            if "未返回可用复核结果" in message:
                return "LLM复核：未返回结果 · 请重新复核"
            return "LLM复核：未完成 · 请查看提示并重新复核"
        return message if len(message) <= 80 else message[:77] + "..."

    def _llm_status_visuals(self, mode, show_warning=False):
        if mode in {"queued", "running"}:
            return {
                "badge": "复核中",
                "message": "正在复核字段映射和匹配列，请稍候。",
                "surface": LLM_STATUS_RUNNING_BG,
                "badge_bg": PRIMARY,
                "badge_fg": "#ffffff",
                "accent": PRIMARY,
                "fg": PRIMARY_DARK,
            }
        if mode == "done":
            return {
                "badge": "已完成",
                "message": "复核完成，可查看明细或继续下一步。",
                "surface": LLM_STATUS_DONE_BG,
                "badge_bg": SUCCESS,
                "badge_fg": "#ffffff",
                "accent": SUCCESS,
                "fg": PRIMARY_DARK,
            }
        if mode == "stopped":
            return {
                "badge": "已停止",
                "message": "已停止大模型复核，可继续下一步或重新复核。",
                "surface": LLM_STATUS_IDLE_BG,
                "badge_bg": MUTED_TEXT,
                "badge_fg": "#ffffff",
                "accent": MUTED_TEXT,
                "fg": PRIMARY_DARK,
            }
        if mode == "error" or show_warning:
            return {
                "badge": "需处理",
                "message": "复核未完成，请按提示重新复核。",
                "surface": LLM_STATUS_ERROR_BG,
                "badge_bg": ERROR,
                "badge_fg": "#ffffff",
                "accent": ERROR,
                "fg": ERROR,
            }
        return {
            "badge": "待复核",
            "message": "选择文件并确认匹配列后，系统会进行字段复核。",
            "surface": LLM_STATUS_BG,
            "badge_bg": LLM_STATUS_IDLE_BG,
            "badge_fg": PRIMARY_DARK,
            "accent": PRIMARY,
            "fg": PRIMARY_DARK,
        }

    def _apply_llm_status_visuals(self, mode, display_message=""):
        visuals = self._llm_status_visuals(mode)
        message = display_message or visuals["message"]
        if mode == "done" and display_message:
            message = display_message.replace("LLM复核：", "", 1)
        elif mode == "error" and display_message:
            message = display_message.replace("LLM复核：", "", 1)
        elif mode in {"queued", "running"}:
            message = visuals["message"]
        try:
            self.llm_status_badge_var.set(visuals["badge"])
            self.llm_status_message_var.set(message)
            self.llm_status_frame.configure(bg=BG)
            self.llm_status_inner.configure(bg=BG)
            self.llm_status_surface_frame.configure(bg=visuals["surface"])
            self.llm_status_accent.configure(bg=visuals["accent"])
            self.llm_status_badge_label.configure(bg=visuals["badge_bg"], fg=visuals["badge_fg"])
            self.llm_status_icon_label.configure(bg=visuals["surface"], fg=visuals["accent"])
            self.llm_status_label.configure(bg=visuals["surface"], fg=visuals["fg"])
        except (AttributeError, tk.TclError):
            pass

    def _update_llm_detail_button(self):
        if not hasattr(self, "llm_detail_button"):
            return
        try:
            self.llm_detail_button.configure(state=tk.NORMAL if self._llm_last_detail_text else tk.DISABLED)
        except tk.TclError:
            pass

    def _append_llm_detail_section(self, title, body):
        title = str(title or "").strip()
        body = str(body or "").strip()
        if not title and not body:
            return
        sections = getattr(self, "_llm_detail_sections_current", None)
        if sections is None:
            sections = []
            self._llm_detail_sections_current = sections
        if title and body:
            sections.append(f"{title}\n{body}")
        else:
            sections.append(title or body)

    def _format_llm_suggestion_detail(self, item, outcome):
        role = self._llm_role_display_label(getattr(item, "role", ""))
        side = "文件1" if getattr(item, "file_side", "") == "file1" else "文件2"
        return (
            f"字段：{role}\n"
            f"文件：{side}\n"
            f"建议列：{getattr(item, 'suggested_column', '') or '无'}\n"
            f"动作：{getattr(item, 'action', '') or '无'}\n"
            f"置信度：{getattr(item, 'confidence', '')}\n"
            f"原因：{getattr(item, 'reason', '') or '无'}\n"
            f"复核提示：{getattr(item, 'review_warning', '') or '无'}\n"
            f"处理结果：{outcome}"
        )

    def _show_llm_detail_dialog(self):
        detail = str(getattr(self, "_llm_last_detail_text", "") or "").strip()
        if not detail:
            messagebox.showinfo("LLM 复核明细", "暂无本轮复核明细。")
            return
        win = tk.Toplevel(self.winfo_toplevel())
        win.title("LLM 复核明细")
        apply_app_theme(win)
        fit_window_to_screen(win, 620, 420, min_width=520, min_height=320)
        win.transient(self.winfo_toplevel())
        frame = ttk.Frame(win, padding=12)
        frame.pack(fill=tk.BOTH, expand=True)
        text = tk.Text(frame, wrap=tk.WORD, height=14, relief=tk.FLAT, padx=8, pady=8)
        text.insert("1.0", detail)
        text.configure(state=tk.DISABLED)
        text.pack(fill=tk.BOTH, expand=True)
        button_frame = ttk.Frame(frame)
        button_frame.pack(fill=tk.X, pady=(10, 0))
        ttk.Button(button_frame, text="关闭", command=win.destroy, width=10).pack(side=tk.RIGHT)
        center_on_parent(win, self.winfo_toplevel())

    def _clear_treeview(self, tree):
        if tree is None:
            return
        try:
            tree.delete(*tree.get_children())
            tree["columns"] = ()
        except tk.TclError:
            pass

    def _show_loading_mask(self, message):
        self._loading_mask_depth += 1
        self.loading_message_var.set(message or "正在处理，请稍候...")
        try:
            self.configure(cursor="watch")
        except tk.TclError:
            pass
        if not hasattr(self, "loading_mask_frame"):
            return
        try:
            if hasattr(self, "loading_progress"):
                self.loading_progress.start(12)
            self.loading_mask_frame.place(x=0, y=0, relwidth=1.0, relheight=1.0)
            self.loading_mask_frame.lift()
            self.update_idletasks()
        except tk.TclError:
            pass

    def _hide_loading_mask(self):
        self._loading_mask_depth = max(0, self._loading_mask_depth - 1)
        if self._loading_mask_depth:
            return
        try:
            if hasattr(self, "loading_progress"):
                self.loading_progress.stop()
            if hasattr(self, "loading_mask_frame"):
                self.loading_mask_frame.place_forget()
            self.configure(cursor="")
            self.update_idletasks()
        except tk.TclError:
            pass

    def _clear_mapping_for_file(self, file_num):
        targets = self._llm_role_targets(include_disallowed=True) if hasattr(self, "mapping_row_controls") else {}
        for sides in targets.values():
            entry = sides.get(file_num)
            if not entry:
                continue
            var = entry.get("var")
            combo = entry.get("combo")
            if var is not None:
                var.set("")
            if combo is not None:
                try:
                    combo.set("")
                    combo["values"] = ["[不映射]"]
                except tk.TclError:
                    pass

    def _clear_supplement_file(self, file_num):
        if self.mode != "supplement":
            return
        self._reset_llm_state_for_new_input()
        if file_num == 1:
            self.file1_path_var.set("")
            self.file1_path_display_var.set("")
            self.file1_sheet_var.set("")
            self.file1_sheet_combo["values"] = []
            self.file1_header_row = 0
            self.file_handler.file1_path = None
            self.file_handler.file1_sheet = None
            self.file_handler.file1_df = None
            self.match_columns1 = []
            self.match_col1_listbox.delete(0, tk.END)
            self._update_selected_match_columns(1)
            self._clear_treeview(getattr(self, "file1_tree", None))
        else:
            self.file2_path_var.set("")
            self.file2_path_display_var.set("")
            self.file2_sheet_var.set("")
            self.file2_sheet_combo["values"] = []
            self.file2_header_row = 0
            self.file_handler.file2_path = None
            self.file_handler.file2_sheet = None
            self.file_handler.file2_df = None
            self.match_columns2 = []
            self.match_col2_listbox.delete(0, tk.END)
            self._update_selected_match_columns(2)
            self._clear_treeview(getattr(self, "file2_tree", None))
        self._clear_mapping_for_file(file_num)
        self._clear_disallowed_supplement_mappings()
        self._update_file_labels()
        self._set_llm_mapping_status("已清除对应补充清单，请重新复核后再继续。", foreground=ERROR, mode="error")

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

        self.llm_status_frame = tk.Frame(
            self,
            bg=BG,
            highlightthickness=0,
            bd=0,
        )
        self.llm_status_inner = tk.Frame(
            self.llm_status_frame,
            bg=BG,
            padx=10,
            pady=4,
        )
        self.llm_status_inner.pack(fill=tk.X)
        self.llm_status_surface_frame = tk.Frame(self.llm_status_inner, bg=LLM_STATUS_BG)
        self.llm_status_accent = tk.Frame(self.llm_status_surface_frame, bg=PRIMARY, width=4)
        self.llm_status_accent.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 10))
        self.llm_status_badge_label = tk.Label(
            self.llm_status_surface_frame,
            textvariable=self.llm_status_badge_var,
            font=("Arial", 9, "bold"),
            fg=PRIMARY_DARK,
            bg=LLM_STATUS_IDLE_BG,
            padx=10,
            pady=3,
        )
        self.llm_status_badge_label.pack(side=tk.LEFT, padx=(0, 10))
        self.llm_status_icon_label = tk.Label(
            self.llm_status_surface_frame,
            textvariable=self.llm_status_icon_var,
            font=("Arial", 10, "bold"),
            foreground=PRIMARY,
            bg=LLM_STATUS_BG,
            width=5,
        )
        self.llm_status_icon_label.pack(side=tk.LEFT, padx=(0, 2))
        self.llm_status_label = tk.Label(
            self.llm_status_surface_frame,
            textvariable=self.llm_status_message_var,
            font=("Arial", 10, "bold"),
            foreground=PRIMARY_DARK,
            bg=LLM_STATUS_BG,
            anchor=tk.W,
            justify=tk.LEFT,
        )
        self.llm_status_label.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.llm_status_frame.pack(fill=tk.X, pady=(0, 8))
        self._apply_llm_status_visuals("")
        
        # 【重要】按钮区域必须先pack，使用side=BOTTOM，这样它会固定在底部
        button_frame = ttk.Frame(self, padding=(10, 8))
        button_frame.pack(side=tk.BOTTOM, fill=tk.X, pady=(6, 0))
        bottom_action_row = ttk.Frame(button_frame)
        bottom_action_row.pack(fill=tk.X)
        self.llm_actions_frame = ttk.Frame(bottom_action_row)
        self.llm_actions_frame.pack(side=tk.LEFT)
        self.llm_stop_button = ttk.Button(
            self.llm_actions_frame,
            text="\u505c\u6b62\u590d\u6838",
            command=self._stop_llm_mapping_assist,
            width=8,
            state=tk.DISABLED,
            style="ToolbandDanger.TButton",
        )
        self.llm_detail_button = ttk.Button(
            self.llm_actions_frame,
            text="查看明细",
            command=self._show_llm_detail_dialog,
            width=8,
            state=tk.DISABLED,
            style="Toolband.TButton",
        )
        self.llm_run_button = ttk.Button(
            self.llm_actions_frame,
            text="\u91cd\u65b0\u590d\u6838",
            command=self._manual_run_llm_mapping_assist,
            width=9,
            style="ToolbandPrimary.TButton",
        )
        self.llm_stop_button.pack(side=tk.LEFT, padx=(0, 6))
        self.llm_detail_button.pack(side=tk.LEFT, padx=(0, 10))
        self.llm_run_button.pack(side=tk.LEFT)
        
        self.next_button = ttk.Button(
            bottom_action_row,
            text="下一步：应用补充映射 >>" if self.mode == "supplement" else "下一步：执行合并 >>",
            command=self._on_next,
            width=25
        )
        self.next_button.pack(side=tk.RIGHT, pady=2)

        if is_supplement_mode:
            if callable(self.on_back):
                ttk.Button(
                    bottom_action_row,
                    text="<< 返回上一步",
                    command=self.on_back,
                    width=12
                ).pack(side=tk.RIGHT, padx=(0, 8), pady=2)
            if callable(self.on_skip):
                ttk.Button(
                    bottom_action_row,
                    text="无补充清单，跳过",
                    command=self.on_skip,
                    width=16
                ).pack(side=tk.RIGHT, padx=(0, 8), pady=2)
        
        def _open_mailto(subject: str, body: str):
            to = "John.SX.Yan@cn.ey.com;melody.bt.liu@cn.ey.com;april.yl.wang@cn.ey.com"
            url = f"mailto:{to}?subject={quote(subject, safe='')}&body={quote(body, safe='')}"
            try:
                webbrowser.open(url)
            except Exception:
                pass
        
        links_frame = ttk.Frame(bottom_action_row)
        links_frame.pack(side=tk.RIGHT, padx=(0, 12))
        
        lbl_like = ttk.Label(links_frame, text="认可", cursor="hand2", style="Link.TLabel")
        lbl_like.pack(side=tk.LEFT, padx=(0, 14))
        lbl_like.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 点赞反馈", "整体使用体验良好，点赞！"))
        
        lbl_suggest = ttk.Label(links_frame, text="建议", cursor="hand2", style="Link.TLabel")
        lbl_suggest.pack(side=tk.LEFT)
        lbl_suggest.bind("<Button-1>", lambda e: _open_mailto("FA List匹配工具 - 功能建议", "我的建议如下："))

        self.bottom_status_label = ttk.Label(
            button_frame,
            textvariable=self.llm_status_var,
            foreground=MUTED_TEXT,
            wraplength=1200,
            justify=tk.LEFT,
        )
        self.bottom_status_label.pack(fill=tk.X, pady=(8, 0))
        
        # 主容器：左右列使用固定比例分配，避免导入后被长路径或预览表格撑宽。
        main_container = ttk.Frame(self)
        self.main_container = main_container
        main_container.pack(fill=tk.BOTH, expand=True, pady=(0, 5))

        left_container = ttk.Frame(main_container)
        right_container = ttk.Frame(main_container)
        self.loading_mask_frame = tk.Frame(main_container, bg=BG, highlightthickness=1, highlightbackground=BORDER)
        loading_card = tk.Frame(self.loading_mask_frame, bg=LLM_STATUS_RUNNING_BG, padx=18, pady=14)
        loading_card.place(relx=0.5, rely=0.45, anchor=tk.CENTER)
        tk.Label(
            loading_card,
            textvariable=self.loading_message_var,
            bg=LLM_STATUS_RUNNING_BG,
            fg=PRIMARY_DARK,
            font=("Arial", 10, "bold"),
        ).pack(pady=(0, 8))
        self.loading_progress = ttk.Progressbar(loading_card, mode="indeterminate", length=260)
        self.loading_progress.pack()

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
            if hasattr(self, "llm_status_surface_frame"):
                try:
                    self.llm_status_inner.update_idletasks()
                    inner_width = self.llm_status_inner.winfo_width()
                    surface_width = max(1, min(inner_width, left_width))
                    self.llm_status_surface_frame.place(
                        x=0,
                        y=0,
                        relheight=1.0,
                        width=surface_width,
                    )
                except tk.TclError:
                    pass

        main_container.bind("<Configure>", _layout_main_columns)

        left_container.columnconfigure(0, weight=1)
        left_container.rowconfigure(0, weight=0, minsize=TOP_PANEL_HEIGHT)
        left_container.rowconfigure(1, weight=1, minsize=260)
        right_container.columnconfigure(0, weight=1)
        right_container.rowconfigure(0, weight=0, minsize=TOP_PANEL_HEIGHT)
        right_container.rowconfigure(1, weight=1, minsize=260)
        
        # ==================== 左上：文件选择区域 ====================
        file_frame = ttk.LabelFrame(left_container, text="文件选择", padding="5")
        file_frame.place(x=5, y=0, relwidth=1.0, width=-7, height=TOP_PANEL_HEIGHT - 2)
        file_frame.columnconfigure(0, weight=1)
        
        # 添加提示信息
        tip_label = ttk.Label(
            file_frame,
            text="提示：文件1导入新增清单，文件2导入处置清单；匹配列请选择唯一识别码" if is_supplement_mode else "提示：文件1导入年初清单，文件2导入年末清单，顺序别反了",
            font=("Arial", 8),
            foreground=ERROR
        )
        tip_label.grid(row=0, column=0, sticky="w", pady=(0, 1))
        
        # 文件1
        file1_frame = ttk.Frame(file_frame)
        file1_frame.grid(row=1, column=0, sticky="ew", pady=2)
        file1_frame.columnconfigure(1, weight=1, minsize=120)
        file1_frame.columnconfigure(4, weight=0, minsize=170)
        
        self.file1_label = ttk.Label(file1_frame, text="新增清单:" if is_supplement_mode else "文件1:", width=8)
        self.file1_label.grid(row=0, column=0, sticky="w", padx=(0, 2))
        file1_entry = ttk.Entry(file1_frame, textvariable=self.file1_path_display_var, width=10)
        file1_entry.grid(row=0, column=1, sticky="ew", padx=2)
        file1_entry.bind("<KeyRelease>", lambda e: (self._sync_file_path_from_display(1), self._reset_llm_state_for_new_input()))
        file1_entry.bind("<FocusOut>", lambda e: (self._sync_file_path_from_display(1), self._sync_file_path_display(1), self._reset_llm_state_for_new_input()))
        file1_browse_btn = ttk.Button(file1_frame, text="浏览...", command=self._select_file1, width=6)
        file1_browse_btn._compact_width = True
        file1_browse_btn.grid(row=0, column=2, sticky="w", padx=2)
        ttk.Label(file1_frame, text="表:", width=3).grid(row=0, column=3, sticky="e", padx=(4, 1))
        self.file1_sheet_combo = ttk.Combobox(file1_frame, textvariable=self.file1_sheet_var, state="readonly", width=18)
        self.file1_sheet_combo.grid(row=0, column=4, sticky="ew", padx=(1, 0))
        if is_supplement_mode:
            file1_clear_btn = ttk.Button(file1_frame, text="清除", command=lambda: self._clear_supplement_file(1), width=5)
            file1_clear_btn.grid(row=0, column=5, sticky="w", padx=(4, 0))
        self.file1_sheet_combo.bind('<<ComboboxSelected>>', lambda e: (self._reset_llm_state_for_new_input(), self._load_file1()))
        self.file1_sheet_combo.bind("<FocusIn>", lambda e: self._sync_sheet_combo_display(1), add="+")
        self.file1_sheet_combo.bind("<FocusOut>", lambda e: self._sync_sheet_combo_display(1), add="+")
        self.file1_sheet_combo.bind("<Configure>", lambda e: self._sync_sheet_combo_display(1), add="+")
        
        # 文件2
        file2_frame = ttk.Frame(file_frame)
        file2_frame.grid(row=2, column=0, sticky="ew", pady=2)
        file2_frame.columnconfigure(1, weight=1, minsize=120)
        file2_frame.columnconfigure(4, weight=0, minsize=170)
        
        self.file2_label = ttk.Label(file2_frame, text="处置清单:" if is_supplement_mode else "文件2:", width=8)
        self.file2_label.grid(row=0, column=0, sticky="w", padx=(0, 2))
        file2_entry = ttk.Entry(file2_frame, textvariable=self.file2_path_display_var, width=10)
        file2_entry.grid(row=0, column=1, sticky="ew", padx=2)
        file2_entry.bind("<KeyRelease>", lambda e: (self._sync_file_path_from_display(2), self._reset_llm_state_for_new_input()))
        file2_entry.bind("<FocusOut>", lambda e: (self._sync_file_path_from_display(2), self._sync_file_path_display(2), self._reset_llm_state_for_new_input()))
        file2_browse_btn = ttk.Button(file2_frame, text="浏览...", command=self._select_file2, width=6)
        file2_browse_btn._compact_width = True
        file2_browse_btn.grid(row=0, column=2, sticky="w", padx=2)
        ttk.Label(file2_frame, text="表:", width=3).grid(row=0, column=3, sticky="e", padx=(4, 1))
        self.file2_sheet_combo = ttk.Combobox(file2_frame, textvariable=self.file2_sheet_var, state="readonly", width=18)
        self.file2_sheet_combo.grid(row=0, column=4, sticky="ew", padx=(1, 0))
        if is_supplement_mode:
            file2_clear_btn = ttk.Button(file2_frame, text="清除", command=lambda: self._clear_supplement_file(2), width=5)
            file2_clear_btn.grid(row=0, column=5, sticky="w", padx=(4, 0))
        self.file2_sheet_combo.bind('<<ComboboxSelected>>', lambda e: (self._reset_llm_state_for_new_input(), self._load_file2()))
        self.file2_sheet_combo.bind("<FocusIn>", lambda e: self._sync_sheet_combo_display(2), add="+")
        self.file2_sheet_combo.bind("<FocusOut>", lambda e: self._sync_sheet_combo_display(2), add="+")
        self.file2_sheet_combo.bind("<Configure>", lambda e: self._sync_sheet_combo_display(2), add="+")
        
        # ==================== 右上：匹配列配置区域 ====================
        match_frame = ttk.LabelFrame(right_container, text="匹配列配置（按ctrl可多选）", padding="5")
        match_frame.place(x=2, y=0, relwidth=1.0, width=-7, height=TOP_PANEL_HEIGHT - 2)
        match_frame.columnconfigure(0, weight=1)

        match_tip_label = ttk.Label(
            match_frame,
            text="提示：文件1和文件2的匹配列数量需一致",
            font=("Arial", 8),
            foreground=MUTED_TEXT,
        )
        match_tip_label.grid(row=0, column=0, sticky="w", pady=(0, 1))

        match_col_frame = ttk.Frame(match_frame)
        match_col_frame.grid(row=1, column=0, sticky="nsew")
        match_col_frame.columnconfigure(0, weight=1)
        
        # 文件1匹配列
        file1_match_frame = ttk.Frame(match_col_frame)
        file1_match_frame.pack(fill=tk.X, pady=2)
        ttk.Label(file1_match_frame, text="文件1:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col1_button = ttk.Button(file1_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 1), width=12)
        self.match_col1_button.pack(side=tk.LEFT, padx=2)
        def update_button1_text():
            if self.match_columns1:
                self.match_col1_button.config(text=f"已选{len(self.match_columns1)}列 ▼")
            else:
                self.match_col1_button.config(text="选择匹配列...")
        self._update_match_col1_button = update_button1_text
        self.match_col1_selected_label = ttk.Label(file1_match_frame, text="已选择: 无", foreground=PRIMARY, justify=tk.LEFT, font=("Arial", 8))
        self.match_col1_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col1_listbox = tk.Listbox(file1_match_frame, height=0)
        self.match_col1_listbox.pack_forget()
        
        # 文件2匹配列
        file2_match_frame = ttk.Frame(match_col_frame)
        file2_match_frame.pack(fill=tk.X, pady=2)
        ttk.Label(file2_match_frame, text="文件2:", width=6).pack(side=tk.LEFT, padx=2)
        self.match_col2_button = ttk.Button(file2_match_frame, text="选择匹配列...", command=lambda: self._show_column_picker_dialog('match', 2), width=12)
        self.match_col2_button.pack(side=tk.LEFT, padx=2)
        def update_button2_text():
            if self.match_columns2:
                self.match_col2_button.config(text=f"已选{len(self.match_columns2)}列 ▼")
            else:
                self.match_col2_button.config(text="选择匹配列...")
        self._update_match_col2_button = update_button2_text
        self.match_col2_selected_label = ttk.Label(file2_match_frame, text="已选择: 无", foreground=PRIMARY, justify=tk.LEFT, font=("Arial", 8))
        self.match_col2_selected_label.pack(side=tk.LEFT, padx=2)
        self.match_col2_listbox = tk.Listbox(file2_match_frame, height=0)
        self.match_col2_listbox.pack_forget()
        
        # ==================== 左下：文件预览区域 ====================
        preview_frame = ttk.LabelFrame(left_container, text="文件预览（底部滚动条或 Shift+滚轮 可左右滑动）", padding="5")
        preview_frame.place(x=5, y=TOP_PANEL_HEIGHT + 2, relwidth=1.0, width=-7, relheight=1.0, height=-(TOP_PANEL_HEIGHT + 2))
        
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
        self._decorate_preview_tree(self.file1_tree)
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
        self._decorate_preview_tree(self.file2_tree)
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
        mapping_frame.place(x=2, y=TOP_PANEL_HEIGHT + 2, relwidth=1.0, width=-7, relheight=1.0, height=-(TOP_PANEL_HEIGHT + 2))

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
        MAPPING_LABEL_WIDTH = 14
        STATUS_WIDTH = 8
        
        def create_mapping_row(parent, label_text, var1, var2, col_type):
            row_frame = ttk.Frame(parent)
            row_frame.pack(fill=tk.X, pady=2, padx=5)
            label_widget = ttk.Label(row_frame, text=label_text, width=MAPPING_LABEL_WIDTH)
            label_widget.grid(row=0, column=0, sticky="w", padx=(0, 5))
            combo1 = ttk.Combobox(row_frame, textvariable=var1, state="readonly", width=COMBO_WIDTH)
            combo1.grid(row=0, column=1, sticky="w", padx=(0, 10))
            combo1.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 1))
            combo1.bind('<<ComboboxSelected>>', lambda e, ct=col_type: (self._reset_llm_state_for_new_input(), self._update_mapping_row_status(ct)))
            combo2 = ttk.Combobox(row_frame, textvariable=var2, state="readonly", width=COMBO_WIDTH)
            combo2.grid(row=0, column=2, sticky="w", padx=(0, 5))
            combo2.bind('<Button-3>', lambda e, ct=col_type: self._show_column_selection_menu(e, ct, 2))
            combo2.bind('<<ComboboxSelected>>', lambda e, ct=col_type: (self._reset_llm_state_for_new_input(), self._update_mapping_row_status(ct)))
            status_label = ttk.Label(row_frame, text="待选", width=STATUS_WIDTH, foreground=ROW_STATUS_PENDING)
            status_label.grid(row=0, column=3, sticky="w", padx=(6, 0))
            try:
                var1.trace_add("write", lambda *args, ct=col_type: self._update_mapping_row_status(ct))
                var2.trace_add("write", lambda *args, ct=col_type: self._update_mapping_row_status(ct))
            except Exception:
                pass
            self.mapping_row_frames[col_type] = row_frame
            self.mapping_row_controls[col_type] = {"label": label_widget, "combo1": combo1, "combo2": combo2, "status": status_label}
            return combo1, combo2
        
        # 标题行
        header_frame = ttk.Frame(mapping_inner)
        header_frame.pack(fill=tk.X, pady=2, padx=5)
        ttk.Label(header_frame, text="映射字段", width=MAPPING_LABEL_WIDTH, font=("Arial", 9, "bold")).grid(row=0, column=0, sticky="w", padx=(0, 5))
        self.mapping_file1_label = ttk.Label(header_frame, text="新增清单" if is_supplement_mode else "期初", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file1_label.grid(row=0, column=1, sticky="ew", padx=(0, 10))
        self.mapping_file2_label = ttk.Label(header_frame, text="处置清单" if is_supplement_mode else "期末", width=COMBO_WIDTH, font=("Arial", 9, "bold"))
        self.mapping_file2_label.grid(row=0, column=2, sticky="ew", padx=(0, 5))
        ttk.Label(header_frame, text="状态", width=STATUS_WIDTH, font=("Arial", 9, "bold"), foreground=PRIMARY_DARK).grid(row=0, column=3, sticky="w", padx=(6, 0))
        
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
            hide_rows = {'disposal_method', 'disposal_date', 'disposal_orig', 'disposal_dep'}
            for row_type in hide_rows:
                row_widget = self.mapping_row_frames.get(row_type)
                if row_widget is not None:
                    row_widget.pack_forget()
            self._update_optional_addition_rows_visibility()
            self.current_year_dep_col1_var.set("")
            self.current_year_dep_col1_combo.set("")
            self.current_year_dep_col1_combo.configure(state="disabled")
        self._update_mapping_row_status()
        
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
        self._update_next_button_state()
        self._update_llm_action_buttons()
    
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
            self._reset_llm_state_for_new_input()
            self.file1_sheet_var.set("")
            self._clear_handler_sheet(1)
            self.file1_path_var.set(file_path)
            self._sync_file_path_display(1)
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
            self._reset_llm_state_for_new_input()
            self.file2_sheet_var.set("")
            self._clear_handler_sheet(2)
            self.file2_path_var.set(file_path)
            self._sync_file_path_display(2)
            # 确保变量已更新后再更新标签
            self.update_idletasks()  # 确保Tkinter变量已更新
            self._update_file_labels()
            self._load_file2_sheets(file_path)
            # 不立即加载，等待用户选择sheet
    
    def _load_file1_sheets(self, file_path: str):
        """加载文件1的工作表列表"""
        file_name = os.path.basename(file_path)
        self._show_loading_mask(f"正在识别 {file_name} 的工作表...")
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
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
                    self.after(0, lambda: (progress_window.destroy(), self._hide_loading_mask(), self._load_file1()))
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: self._hide_loading_mask())
                self.after(0, lambda msg=error_msg: messagebox.showerror("错误", f"获取工作表列表失败:\n{msg}"))
        
        threading.Thread(target=get_sheets_task, daemon=True).start()
    
    def _on_sheets_loaded(self, file_num, success, error_msg, sheets, progress_window):
        """工作表列表加载完成回调"""
        try:
            progress_window.destroy()
        except tk.TclError:
            pass
        
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._on_sheets_loaded.entry", message="sheets loaded callback", data={"file_num": file_num, "success": success, "sheets_count": len(sheets) if sheets else 0, "sheets": sheets[:5] if sheets else []})
        # #endregion
        
        if success and sheets:
            file_path = self.file1_path_var.get() if file_num == 1 else self.file2_path_var.get()
            sheets = self._visible_excel_sheets(file_path, sheets)

        if file_num == 1:
            if success and sheets:
                self.file1_sheet_combo['values'] = sheets
                self._sync_sheet_combo_display(1, fallback_to_first=False)
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
                    self._sync_sheet_combo_display(1)
                    self._load_file1()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file1()
        else:
            if success and sheets:
                self.file2_sheet_combo['values'] = sheets
                self._sync_sheet_combo_display(2, fallback_to_first=False)
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
                    self._sync_sheet_combo_display(2)
                    self._load_file2()
            else:
                # CSV文件没有工作表选择框，直接加载
                self._load_file2()
        self._hide_loading_mask()
    
    def _load_file2_sheets(self, file_path: str):
        """加载文件2的工作表列表"""
        file_name = os.path.basename(file_path)
        self._show_loading_mask(f"正在识别 {file_name} 的工作表...")
        # 显示进度提示弹窗
        progress_window = tk.Toplevel(self.winfo_toplevel())
        progress_window.title("处理中")
        apply_app_theme(progress_window)
        fit_window_to_screen(progress_window, 300, 120)
        progress_window.transient(self.winfo_toplevel())
        progress_window.grab_set()
        progress_window.resizable(False, False)
        center_on_parent(progress_window, self.winfo_toplevel())
        
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
                    self.after(0, lambda: (progress_window.destroy(), self._hide_loading_mask(), self._load_file2()))
            except Exception as e:
                error_msg = str(e)
                self.after(0, lambda: progress_window.destroy())
                self.after(0, lambda: self._hide_loading_mask())
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
        
        self._sync_sheet_combo_display(1, fallback_to_first=False)
        file_display_name = self._get_file_display_name(1)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            self._sync_sheet_combo_display(1, fallback_to_first=False)
            sheet_name = self.file1_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file1.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        self._show_loading_mask(f"正在读取 {file_display_name}...")
        
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
        
        self._sync_sheet_combo_display(1, fallback_to_first=True)
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
        try:
            progress_window.destroy()
        except tk.TclError:
            pass
        try:
            if success:
                self.loading_message_var.set(f"正在更新 {file_display_name} 的预览和映射...")
                self._sync_sheet_combo_display(1, fallback_to_first=True)
                # #region agent log
                try:
                    from debug_logger import _write as _dbg
                except Exception:
                    _dbg = lambda **kw: None
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.success", message="file1 loaded", data={"rows": len(self.file_handler.file1_df) if self.file_handler.file1_df is not None else 0, "cols": len(self.file_handler.file1_df.columns) if self.file_handler.file1_df is not None else 0, "columns": list(self.file_handler.file1_df.columns)[:5] if self.file_handler.file1_df is not None else [], "first_row_sample": list(self.file_handler.file1_df.iloc[0, :5]) if self.file_handler.file1_df is not None and len(self.file_handler.file1_df) > 0 else []})
                # #endregion
                header_warning = None
                if self.file_handler.file1_df is not None and len(self.file_handler.file1_df.columns) > 0:
                    first_col_name = str(self.file_handler.file1_df.columns[0])
                    looks_like_data = (
                        ',' in first_col_name or
                        (len(first_col_name) > 0 and first_col_name[0].isdigit()) or
                        len(first_col_name) > 50
                    )
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file1_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                    if looks_like_data:
                        header_warning = f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。"
                if self.status_callback:
                    self.status_callback(f"{file_display_name}读取完成")
                self._update_file_labels()
                self._update_file1_preview()
                self._update_match_columns(trigger_llm=True)
                self._sync_sheet_combo_display(1, fallback_to_first=True)
                if header_warning:
                    messagebox.showwarning("提示", header_warning)
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
        finally:
            self._hide_loading_mask()
    
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
        
        self._sync_sheet_combo_display(2, fallback_to_first=False)
        file_display_name = self._get_file_display_name(2)
        
        # 检查Excel文件是否已选择sheet
        _, ext = os.path.splitext(file_path)
        ext = str(ext).lower() if ext else ''
        if ext in ['.xlsx', '.xls']:
            self._sync_sheet_combo_display(2, fallback_to_first=False)
            sheet_name = self.file2_sheet_var.get()
            if not sheet_name:
                # #region agent log
                _dbg(sessionId="debug", runId="run1", hypothesisId="H7", location="file_and_match_config._load_file2.no_sheet", message="no sheet selected for excel file", data={"file_path": file_path})
                # #endregion
                messagebox.showwarning("提示", f"请为{file_display_name}选择工作表")
                return
        self._show_loading_mask(f"正在读取 {file_display_name}...")
        
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
        
        self._sync_sheet_combo_display(2, fallback_to_first=True)
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
        try:
            progress_window.destroy()
        except tk.TclError:
            pass
        try:
            if success:
                self.loading_message_var.set(f"正在更新 {file_display_name} 的预览和映射...")
                self._sync_sheet_combo_display(2, fallback_to_first=True)
                # #region agent log
                try:
                    from debug_logger import _write as _dbg
                except Exception:
                    _dbg = lambda **kw: None
                _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.success", message="file2 loaded", data={"rows": len(self.file_handler.file2_df) if self.file_handler.file2_df is not None else 0, "cols": len(self.file_handler.file2_df.columns) if self.file_handler.file2_df is not None else 0, "columns": list(self.file_handler.file2_df.columns)[:5] if self.file_handler.file2_df is not None else [], "first_row_sample": list(self.file_handler.file2_df.iloc[0, :5]) if self.file_handler.file2_df is not None and len(self.file_handler.file2_df) > 0 else []})
                # #endregion
                header_warning = None
                if self.file_handler.file2_df is not None and len(self.file_handler.file2_df.columns) > 0:
                    first_col_name = str(self.file_handler.file2_df.columns[0])
                    looks_like_data = (
                        ',' in first_col_name or
                        (len(first_col_name) > 0 and first_col_name[0].isdigit()) or
                        len(first_col_name) > 50
                    )
                    _dbg(sessionId="debug", runId="run1", hypothesisId="H8", location="file_and_match_config._on_file2_loaded.header_check", message="checking if header looks like data", data={"first_col_name": first_col_name, "looks_like_data": looks_like_data})
                    if looks_like_data:
                        header_warning = f"{file_display_name}的标题行可能识别不正确。\n如果列名显示为数据值，请在预览区域右键点击正确的标题行，选择\"设本行为标题行\"。"
                if self.status_callback:
                    self.status_callback(f"{file_display_name}读取完成")
                self._update_file_labels()
                self._update_file2_preview()
                self._update_match_columns(trigger_llm=True)
                self._sync_sheet_combo_display(2, fallback_to_first=True)
                if header_warning:
                    messagebox.showwarning("提示", header_warning)
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
        finally:
            self._hide_loading_mask()
    
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
            self.file1_tree.insert('', tk.END, values=values, tags=("even" if j % 2 == 0 else "odd",))
    
    def _update_file_labels(self):
        """更新所有文件标签显示为"原始文件 & sheet名称"格式"""
        if hasattr(self, "file1_sheet_combo") and hasattr(self, "file2_sheet_combo"):
            self._sync_all_sheet_combo_displays(fallback_to_first=False)
        # #region agent log
        try:
            from debug_logger import _write as _dbg
        except Exception:
            _dbg = lambda **kw: None
        # #endregion
        
        if hasattr(self, "file1_path_display_var"):
            self._sync_file_path_display(1)
        if hasattr(self, "file2_path_display_var"):
            self._sync_file_path_display(2)
        if hasattr(self, "file1_sheet_combo"):
            self._sync_sheet_combo_display(1)
        if hasattr(self, "file2_sheet_combo"):
            self._sync_sheet_combo_display(2)
        file1_name = self._get_file_display_name(1)
        file2_name = self._get_file_display_name(2)
        # #region agent log
        _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.entry", message="updating file labels", data={"file1_name": file1_name, "file2_name": file2_name, "file1_path": self.file1_path_var.get(), "file1_sheet": self.file1_sheet_var.get(), "file2_path": self.file2_path_var.get(), "file2_sheet": self.file2_sheet_var.get()})
        # #endregion
        
        # 更新文件选择区域的标签
        if hasattr(self, 'file1_label'):
            file1_label_text = "新增清单:" if self.mode == "supplement" else "文件1:"
            self.file1_label.config(text=file1_label_text)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file1_label", message="updated file1 label", data={"text": file1_label_text})
            # #endregion
        if hasattr(self, 'file2_label'):
            file2_label_text = "处置清单:" if self.mode == "supplement" else "文件2:"
            self.file2_label.config(text=file2_label_text)
            # #region agent log
            _dbg(sessionId="debug", runId="run1", hypothesisId="H2", location="file_and_match_config._update_file_labels.file2_label", message="updated file2 label", data={"text": file2_label_text})
            # #endregion
        
        # 更新匹配列配置区域的标签
        if hasattr(self, 'match_file1_label'):
            self.match_file1_label.config(text=f"{file1_name}:")
        if hasattr(self, 'match_file2_label'):
            self.match_file2_label.config(text=f"{file2_name}:")
        
        # 更新字段映射配置区域的标签
        if hasattr(self, 'mapping_file1_label'):
            self.mapping_file1_label.config(text="新增清单" if self.mode == "supplement" else "期初")
        if hasattr(self, 'mapping_file2_label'):
            self.mapping_file2_label.config(text="处置清单" if self.mode == "supplement" else "期末")
        
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
            self.file2_tree.insert('', tk.END, values=values, tags=("even" if j % 2 == 0 else "odd",))
    
    def _update_match_columns(self, *, trigger_llm=False):
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

        if self.mode == "supplement":
            self._auto_map_supplement_match_columns(cols1, cols2)
        else:
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

        addition_method_exact = ['新增方式', '增加方式', '取得方式', '资产来源', '新增来源']
        addition_method_contain = ['新增方式', '增加方式', '取得方式', '新增来源', '增加来源']
        addition_date_exact = ['新增时间', '新增日期', '增加时间', '增加日期', '取得日期', '购置日期']
        addition_date_contain = ['新增时间', '新增日期', '增加时间', '增加日期', '取得时间', '取得日期', '购置时间', '购置日期']
        file2_addition_method_exact = addition_method_exact + ['变动方式', '变动类型', '增减方式', '增减类型', '增减类别']
        file2_addition_method_contain = addition_method_contain + ['新增', '增加', '取得', '购置', '来源', '方式', '途径', '变动方式', '变动类型', '增减方式']
        file2_addition_date_exact = addition_date_exact + ['资本化日期', '入账日期', '开始使用日期', '开始使用时间', '变动时间', '变动日期']
        file2_addition_date_contain = addition_date_contain + ['新增', '增加', '取得', '购置', '资本化', '入账', '开始使用', '变动时间', '变动日期', '日期', '时间', '时点']

        if self.mode == "supplement":
            supplement_addition_method_contain = addition_method_contain + ['来源', '方式', '途径']
            supplement_addition_date_exact = addition_date_exact + ['日期', '时间', '时点']
            supplement_addition_date_contain = addition_date_contain + ['新增', '增加', '时间', '日期', '时点']

            disposal_method_exact = ['处置方式', '减少方式', '报废方式', '出售方式']
            disposal_method_contain = ['处置方式', '减少方式', '报废', '出售', '转出', '方式']
            disposal_date_exact = ['处置时间', '减少时间', '处置日期', '日期', '时间', '时点']
            disposal_date_contain = ['处置', '减少', '时间', '日期', '时点']
            disposal_orig_exact = ['处置原值', '减少原值', '原值减少', '处置成本']
            disposal_orig_contain = ['处置原值', '减少原值', '原值减少', '原值']
            disposal_dep_exact = ['处置折旧', '减少折旧', '累计折旧处置', '累计折旧减少', '累计折旧']
            disposal_dep_contain = ['处置折旧', '减少折旧', '折旧减少', '累计折旧减少', '累计折旧处置']

            add_method_col1 = auto_map_column(cols1, addition_method_exact, supplement_addition_method_contain)
            add_date_col1 = auto_map_column(cols1, supplement_addition_date_exact, supplement_addition_date_contain)
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
            self._clear_disallowed_supplement_mappings()
            if trigger_llm:
                self._queue_llm_mapping_assist(force=True)
            return

        self._clear_normal_file1_addition_mappings()
        add_method_col2 = auto_map_column(cols2, file2_addition_method_exact, file2_addition_method_contain)
        add_date_col2 = auto_map_column(cols2, file2_addition_date_exact, file2_addition_date_contain)

        if add_method_col2:
            self.addition_method_col2_var.set(add_method_col2)
            if add_method_col2 in cols2:
                self.addition_method_col2_combo.current(_mapping_combo_index(add_method_col2, cols2))
        if add_date_col2:
            self.addition_date_col2_var.set(add_date_col2)
            if add_date_col2 in cols2:
                self.addition_date_col2_combo.current(_mapping_combo_index(add_date_col2, cols2))
        self._update_optional_addition_rows_visibility()

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
        self._fallback_addition_date_to_entry_date(cols1, cols2)
        self._update_optional_addition_rows_visibility()
        
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
        self._clear_disallowed_supplement_mappings()
        if trigger_llm:
            self._queue_llm_mapping_assist(force=True)

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
                if len(display_text) > 90:
                    display_text = display_text[:87] + "..."
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
                if len(display_text) > 90:
                    display_text = display_text[:87] + "..."
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

    def _reference_match_columns_for_supplement_file(self, file_index):
        if file_index == 1:
            return list(self.supplement_reference_match_columns1 or [])
        return list(self.supplement_reference_match_columns2 or [])

    @staticmethod
    def _reference_col_is_code_like(column):
        normalized = _normalize_candidate_header(column)
        if score_fa_match_id_column(column) is not None:
            return True
        return any(token in normalized for token in ("coding", "assetcode", "code", "assetid", "id", "编码", "编号", "卡片号"))

    @staticmethod
    def _reference_col_is_name_like(column):
        normalized = _normalize_candidate_header(column)
        return any(token in normalized for token in ("资产名称", "固定资产名称", "名称", "资产描述", "固定资产描述", "描述", "assetname", "name", "description", "desc"))

    def _pick_supplement_column_for_reference(self, reference_col, columns, df, used_columns):
        available = [col for col in (columns or []) if col not in used_columns]
        if not available:
            return None

        ref_norm = _normalize_candidate_header(reference_col)
        for col in available:
            if _normalize_candidate_header(col) == ref_norm:
                return col

        if self._reference_col_is_code_like(reference_col):
            scored = []
            for index, col in enumerate(available):
                score = score_fa_match_id_column(col)
                if score is not None:
                    scored.append((-score, index, col))
            if scored:
                scored.sort()
                return scored[0][2]

        if self._reference_col_is_name_like(reference_col):
            picked = pick_fa_name_column(available, df=df, exclude_cols=list(used_columns))
            if picked and picked not in used_columns:
                return picked

        for col in available:
            col_norm = _normalize_candidate_header(col)
            if ref_norm and (ref_norm in col_norm or col_norm in ref_norm):
                return col
        return None

    def _auto_map_supplement_match_columns(self, cols1, cols2):
        """Map supplement IDs by the first-step match-key口径, even when only one side is loaded."""
        changed = False

        def apply_side(file_index, columns, df):
            refs = self._reference_match_columns_for_supplement_file(file_index)
            if not columns:
                return False
            selected = []
            used = set()
            for ref in refs:
                picked = self._pick_supplement_column_for_reference(ref, columns, df, used)
                if not picked and self._reference_col_is_code_like(ref):
                    picked = pick_fa_match_id_column([col for col in columns if col not in used])
                if not picked and self._reference_col_is_name_like(ref):
                    picked = pick_fa_name_column(columns, df=df, exclude_cols=list(used))
                if picked:
                    selected.append(picked)
                    used.add(picked)
            if not selected:
                fallback_code = pick_fa_match_id_column(columns)
                if fallback_code:
                    selected.append(fallback_code)
                    used.add(fallback_code)
                fallback_name = pick_fa_name_column(columns, df=df, exclude_cols=list(used))
                if fallback_name:
                    selected.append(fallback_name)
                    used.add(fallback_name)
            if not selected:
                return False
            if file_index == 1:
                self.match_columns1 = selected
            else:
                self.match_columns2 = selected
            return True

        if apply_side(1, cols1, self.file_handler.file1_df):
            changed = True
        if apply_side(2, cols2, self.file_handler.file2_df):
            changed = True
        if changed:
            self._match_columns_auto_default = True
            self._sync_auto_match_column_selection(cols1, cols2)
        return changed

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

    def _queue_llm_mapping_assist(self, *, force=False):
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
        has_required_files = (has_file1 and has_file2) if self.mode != "supplement" else (has_file1 or has_file2)
        if not has_required_files:
            self._log_llm_mapping_event(
                "queue_skipped",
                reason="missing_dataframe",
                has_file1=has_file1,
                has_file2=has_file2,
            )
            return
        self._llm_mapping_assist_scheduled = True
        self._llm_mapping_passed = False
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
            has_file1 = self.file_handler.file1_df is not None
            has_file2 = self.file_handler.file2_df is not None
            has_required_files = (has_file1 and has_file2) if self.mode != "supplement" else (has_file1 or has_file2)
            if not has_required_files:
                self._log_llm_mapping_event(
                    "start_skipped",
                    reason="missing_dataframe",
                    has_file1=self.file_handler.file1_df is not None,
                    has_file2=self.file_handler.file2_df is not None,
                )
                self._set_llm_mapping_status("")
                return
            cols1 = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
            cols2 = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
            has_required_columns = bool(cols1 and cols2) if self.mode != "supplement" else bool(cols1 or cols2)
            if not has_required_columns:
                self._log_llm_mapping_event(
                    "start_skipped",
                    reason="missing_columns",
                    cols1_count=len(cols1),
                    cols2_count=len(cols2),
                )
                self._set_llm_mapping_status("")
                return
            generation = self._llm_generation
            repaired_match = self._repair_auto_match_columns(cols1, cols2) if cols1 and cols2 else False
            if repaired_match:
                self._log_llm_mapping_event(
                    "auto_match_repaired_before_llm",
                    file1=list(self.match_columns1 or []),
                    file2=list(self.match_columns2 or []),
                )
            self._llm_mapping_running = True
            self._llm_mapping_passed = False
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
                "samples1": self._llm_column_samples(self.file_handler.file1_df) if self.file_handler.file1_df is not None else {},
                "samples2": self._llm_column_samples(self.file_handler.file2_df) if self.file_handler.file2_df is not None else {},
                "profiles1": self._llm_column_profiles(self.file_handler.file1_df) if self.file_handler.file1_df is not None else {},
                "profiles2": self._llm_column_profiles(self.file_handler.file2_df) if self.file_handler.file2_df is not None else {},
                "current": self._current_llm_mapping(),
                "match_profile": match_profile,
                "candidate_profiles": candidate_profiles,
                "candidate_profiles_all": candidate_profiles_all,
                "forbidden_columns": forbidden_initial,
                "mode": self.mode,
                "supplement_reference_match": {
                    "file1": list(self.supplement_reference_match_columns1 or []),
                    "file2": list(self.supplement_reference_match_columns2 or []),
                },
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
            self._llm_mapping_passed = False
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
            supplement_match_review = None
            supplement_match_review_error = None
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
                files = []
                if payload["cols1"]:
                    files.append({
                        "file_side": "file1",
                        "headers": [str(c) for c in payload["cols1"]],
                        "samples": payload["samples1"],
                        "column_profiles": payload["profiles1"],
                    })
                if payload["cols2"]:
                    files.append({
                        "file_side": "file2",
                        "headers": [str(c) for c in payload["cols2"]],
                        "samples": payload["samples2"],
                        "column_profiles": payload["profiles2"],
                    })
                supplement_ref = payload.get("supplement_reference_match") or {}
                supplement_ref_text = (
                    f"补充清单模式下，match 必须沿用第一步匹配ID口径："
                    f"file1参考 {' + '.join(supplement_ref.get('file1') or []) or '无'}；"
                    f"file2参考 {' + '.join(supplement_ref.get('file2') or []) or '无'}。"
                    "若第一步为 资产编码 + 名称，补充清单也应找等价的 编码 + 名称；不要自行降级为单列或改用流水号/期间/型号。"
                ) if self.mode == "supplement" else ""
                mapping_instructions = (
                    "file1通常为期初或新增清单，file2通常为期末或处置清单。"
                    "只对未映射字段使用 action=fill；已映射字段仅 action=review/keep。"
                    "普通模式下，addition_method/addition_date 只服务 file2 期末清单，file1 不需要新增方式/新增时间，禁止为 file1 输出这两个字段。"
                    "普通模式下，file2 若存在变动方式/变动类型/增减方式且样例体现购入、购置、新增、增加、在建工程转入、转固、调入等新增来源，应作为 addition_method 候选；新增时间可参考新增时间、增加时间、取得日期、购置日期、资本化日期、入账日期、开始使用日期、变动时间、变动日期等列。"
                    "补充清单模式下，file1优先新增方式/新增时间，file2优先处置方式/处置时间/处置原值/处置折旧。"
                    f"{supplement_ref_text}"
                )
                review_instructions = (
                    "先脱离自动预映射结论，依据 headers、samples、column_profiles 独立判断各列实际业务角色，再复核已自动预映射字段是否明显错列或两期口径不一致。"
                    "例如资产大类与资产类型描述、原值与原值减少、累计折旧与本年折旧混用。"
                    "不要再提示使用寿命的年/月单位差异，也不要再提示残值率/残值的口径差异——脚本已分别按 ×12 与 残值/原值 自动校正。"
                    "特别注意列名暗示和脚本初判都可能与实际数据形态冲突：列名和 current_mapping 只作参考，样例值和 column_profiles 优先。"
                    "请把 category、name、code/id、date、value、depreciation 等字段作为一组联动复核；若多列发生错位或互换，应分别返回每个受影响字段的 field_review，而不是只修一个字段。"
                    "depreciation/累计折旧必须是累计数；凡表头或样例语义为本月折旧、本期折旧、本年折旧、当年折旧、计提折旧、月折旧的列，都属于 current_year_dep/本年折旧口径，禁止建议映射到 depreciation/累计折旧。"
                    "current_year_dep/本年折旧只表示年度或本年至今折旧，例如本年折旧、当年折旧、本年至今折旧、年折旧额；禁止建议映射到本月折旧、当月折旧、月折旧，若只有月折旧列则保持不映射或不建议替换。"
                    "普通模式下 addition_method/addition_date 只复核 file2，不复核也不建议 file1；file2 的变动方式/变动类型/变动日期可结合样例判断是否为新增来源和新增时间。"
                    "category/资产类别是资产种类名称或描述，可以是中文或英文文本；不是资产类代码、分类编码、SAP代码、数字短码或其他编码值。"
                    "判断 category 时先确认样例值是描述性资产种类文本，再把短文本、低 unique_count 作为辅助证据；短且唯一值少的 010/030/Y110/A12 这类编码列仍然禁止作为 category。"
                    "如果 category 当前列的样例像代码/编号或长资产描述，应 flag wrong_column；若两侧 category 数据形态不一致，应 flag cross_period_inconsistent。"
                    "category 与 name 在同一文件侧不能共用同一列；若 category 建议改到 name 当前列，必须同步复核 name 并建议长描述/高唯一值列。"
                    "如建议修正，suggested_mapping 只返回需要修正的一侧或两侧。"
                )
                match_instructions = (
                    "文件1和文件2的匹配列数量必须一致；可建议多列组合。"
                    "如果当前列有空值、重复较多，或两边一个是编号一个是名称，应提示用户。"
                )
                match_review_enabled = bool(self.mode != "supplement" and payload["cols1"] and payload["cols2"] and signature and signature != self._last_llm_match_review_signature)
                supplement_match_review_enabled = bool(self.mode == "supplement" and (payload["cols1"] or payload["cols2"]))

                def run_supplement_match_review():
                    if not supplement_match_review_enabled:
                        return None
                    return review_supplement_match_key_columns(
                        settings,
                        tool_name="FA List",
                        files=files,
                        current_match=payload["current"].get("match", {}),
                        reference_match=payload.get("supplement_reference_match") or {},
                        extra_instructions="只判断补充清单匹配ID是否完整对齐第一步ID口径。",
                    )

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
                    try:
                        supplement_match_review = run_supplement_match_review()
                    except Exception as exc:
                        supplement_match_review_error = str(exc)
                        self._log_llm_mapping_event("supplement_match_review_failed", error=str(exc))
                    self._log_llm_mapping_event(
                        "combined_task_done",
                        suggestions_count=len(suggestions or []),
                        fa_review_count=len(fa_review or []),
                        has_match_review=match_review is not None,
                        has_supplement_match_review=supplement_match_review is not None,
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
                        supplement_match_review,
                        supplement_match_review_error,
                        generation,
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
                try:
                    supplement_match_review = run_supplement_match_review()
                except Exception as exc:
                    supplement_match_review_error = str(exc)
                    self._log_llm_mapping_event("supplement_match_review_failed", error=str(exc))
            except Exception as exc:
                mapping_error = str(exc)
                self._log_llm_mapping_event("worker_failed", error=str(exc))
            self._log_llm_mapping_event(
                "worker_finished",
                suggestions_count=len(suggestions or []),
                fa_review_count=len(fa_review or []),
                has_match_review=match_review is not None,
                has_supplement_match_review=supplement_match_review is not None,
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
                supplement_match_review,
                supplement_match_review_error,
                generation,
            ))

        self._log_llm_mapping_event("worker_thread_starting")
        threading.Thread(target=worker, daemon=True).start()

    def _safe_apply_llm_mapping_suggestions(self, *args, **kwargs):
        try:
            self._apply_llm_mapping_suggestions(*args, **kwargs)
        except Exception as exc:
            self._log_llm_mapping_event("apply_failed", error=str(exc))
            self._finish_llm_mapping(f"大模型辅助判断未能完成：{exc}", show_warning=True, passed=False)

    def _llm_role_display_label(self, role):
        labels = self._llm_role_label_map()
        text = labels.get(role) or role or "字段"
        return str(text).split("/")[0].strip() or str(text)

    def _llm_side_role_display_label(self, role, side):
        side_text = "文件1" if side == "file1" else "文件2" if side == "file2" else ""
        role_text = self._llm_role_display_label(role)
        return f"{side_text}{role_text}" if side_text else role_text

    @staticmethod
    def _summarize_labels(labels, limit=4):
        out = []
        seen = set()
        for label in labels or []:
            text = str(label or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            out.append(text)
        if not out:
            return "无"
        if len(out) > limit:
            return "、".join(out[:limit]) + f"等{len(out)}项"
        return "、".join(out)

    def _apply_llm_mapping_suggestions(self, suggestions, cols1, cols2, match_review=None, match_signature=None, match_review_error=None, fa_review=None, fa_review_error=None, review_current_mapping=None, mapping_error=None, match_profile=None, supplement_match_review=None, supplement_match_review_error=None, generation=None):
        if generation is not None and generation != self._llm_generation:
            self._llm_mapping_running = False
            self._llm_mapping_passed = False
            self._update_llm_action_buttons()
            self._update_next_button_state()
            if self._llm_rerun_after_current:
                self._llm_rerun_after_current = False
                self._queue_llm_mapping_assist(force=True)
            return
        # 每次大模型跑完都重新评估弹窗——只在“当前这一批返回”内防止同一条建议被
        # 重复展示，不要把上一次的指纹带过来，否则用户重新选文件后即使 LLM 又给出
        # 同样的提示，弹窗也会被吞掉。
        self._llm_shown_match_review_keys = set()
        self._llm_shown_fa_review_keys = set()
        self._llm_fill_labels_current = []
        self._llm_review_labels_current = []
        self._llm_detail_sections_current = []
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
                self._append_llm_detail_section("字段建议（跳过）", self._format_llm_suggestion_detail(item, "列不存在或文件侧无效"))
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
                    self._llm_fill_labels_current.append(self._llm_side_role_display_label(item.role, side))
                    self._append_llm_detail_section("字段建议（已自动补充）", self._format_llm_suggestion_detail(item, "已写入下拉框"))
                else:
                    skipped += 1
                    self._append_llm_detail_section("字段建议（跳过）", self._format_llm_suggestion_detail(item, "写入下拉框失败"))
                    self._log_llm_mapping_event(
                        "suggestion_skipped",
                        reason="fill_failed",
                        role=getattr(item, "role", ""),
                        side=side,
                        column=col,
                    )
            elif item.action == "review":
                reviews += 1
                self._append_llm_detail_section("字段建议（需人工复核）", self._format_llm_suggestion_detail(item, "未自动采纳"))
            else:
                skipped += 1
                self._append_llm_detail_section("字段建议（跳过）", self._format_llm_suggestion_detail(item, "未满足自动补充条件"))
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
        if supplement_match_review is not None:
            if self._handle_llm_supplement_match_key_review(supplement_match_review, cols1, cols2):
                reviews += 1
        reviews += self._handle_llm_fa_mapping_review(fa_review, cols1, cols2, review_current_mapping)
        errors = _dedupe_messages([msg for msg in (mapping_error, fa_review_error, match_review_error, supplement_match_review_error) if msg])
        if errors and applied == 0 and reviews == 0:
            if all(_is_llm_empty_response_error(msg) for msg in errors):
                self._finish_llm_mapping("大模型未返回可用复核结果。请重新复核成功后再继续。", show_warning=True, passed=False)
                return
            self._finish_llm_mapping("大模型辅助判断未能完成：" + "；".join(errors), show_warning=True, passed=False)
            return
        suffix_parts = format_llm_error_parts(
            [
                ("字段建议", mapping_error),
                ("字段口径复核", fa_review_error),
                ("匹配列复核", match_review_error),
                ("补充ID复核", supplement_match_review_error),
            ]
        )
        suffix = (" " + "；".join(suffix_parts)) if suffix_parts else ""
        self._log_llm_mapping_event(
            "apply_finished",
            applied=applied,
            reviews=reviews,
            skipped=skipped,
            errors=[msg for msg in (mapping_error, fa_review_error, match_review_error, supplement_match_review_error) if msg],
        )
        fill_summary = self._summarize_labels(self._llm_fill_labels_current)
        review_summary = self._summarize_labels(self._llm_review_labels_current)
        detail_lines = [
            "当前选择",
            f"已补充：{applied} 项（{fill_summary}）",
            f"复核提示：{reviews} 项（{review_summary}）",
        ]
        if skipped:
            detail_lines.append(f"未自动采纳：{skipped} 项")
        if suffix_parts:
            detail_lines.extend(["", "复核发现", *suffix_parts])
        else:
            detail_lines.extend(["", "复核发现", "未发现需要额外说明的问题。"])
        full_sections = list(getattr(self, "_llm_detail_sections_current", []) or [])
        if full_sections:
            detail_lines.extend(["", "本轮完整提示与复核项", *full_sections])
        detail_lines.extend(["", "建议选择", "如字段行显示“复核建议”，请按弹窗建议确认是否采纳；其余 OK 项可继续使用当前选择。"])
        self._llm_last_detail_text = "\n".join(detail_lines)
        self._update_llm_detail_button()
        self._finish_llm_mapping(
            f"大模型辅助判断完成：已补充 {applied} 项（{fill_summary}），复核提示 {reviews} 项（{review_summary}）。{suffix}",
            passed=not bool(errors),
        )

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
            role = decision.get("role")
            if role:
                self._llm_review_row_roles.add(role)
            if hasattr(self, "_llm_review_labels_current"):
                self._llm_review_labels_current.append(decision.get("label") or self._llm_role_display_label(decision.get("role")))
            message = build_fa_mapping_review_dialog_text(decision)
            title = f"LLM 字段映射复核（{index}/{total}）"
            self._append_llm_detail_section(title, message)
            if decision.get("can_apply") and decision.get("apply_mapping"):
                if ask_apply_llm_suggestion(self, title, message):
                    for side, col in (decision.get("apply_mapping") or {}).items():
                        self._replace_llm_role(decision["role"], side, col, cols1, cols2)
            else:
                messagebox.showinfo(title, message)
        self._update_mapping_row_status()
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
        if hasattr(self, "_llm_review_labels_current"):
            self._llm_review_labels_current.append("匹配ID")
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
        current_text = f"文件1：{' + '.join(self.match_columns1 or ['未选择'])}\n文件2：{' + '.join(self.match_columns2 or ['未选择'])}"
        suggestion = f"文件1：{' + '.join(decision['suggested_file1_columns']) or '无明确建议'}\n文件2：{' + '.join(decision['suggested_file2_columns']) or '无明确建议'}"
        finding = "当前匹配ID需要复核，建议确认两边是否使用同一类资产唯一识别字段。"
        if decision.get("can_apply"):
            finding = "当前匹配ID可能与更合适的资产唯一识别字段不一致，可直接采纳建议调整。"
        if decision.get("can_apply"):
            message = (
                "当前选择\n"
                f"{current_text}\n\n"
                "复核发现\n"
                f"{finding}\n\n"
                "建议选择\n"
                f"{suggestion}\n\n"
                "采纳后会自动修正匹配列；不采纳则保持当前设置。"
            )
            self._append_llm_detail_section("LLM 匹配列复核", message)
            if ask_apply_llm_suggestion(self, "LLM 匹配列复核", message):
                self._apply_match_key_columns(decision["suggested_file1_columns"], decision["suggested_file2_columns"], cols1, cols2)
        else:
            message = (
                "当前选择\n"
                f"{current_text}\n\n"
                "复核发现\n"
                f"{finding}\n\n"
                "建议选择\n"
                f"{suggestion}"
            )
            self._append_llm_detail_section("LLM 匹配列复核", message)
            messagebox.showinfo(
                "LLM 匹配列复核",
                message,
            )
        return True

    def _handle_llm_supplement_match_key_review(self, review, cols1, cols2):
        decision = build_supplement_match_key_review_decision(
            review,
            cols1=cols1,
            cols2=cols2,
            current1=self.match_columns1,
            current2=self.match_columns2,
        )
        if not decision.get("show"):
            return False
        if hasattr(self, "_llm_review_labels_current"):
            self._llm_review_labels_current.append("补充ID")
        sig = (
            tuple(self.match_columns1 or []),
            tuple(self.match_columns2 or []),
            tuple(decision.get("suggested_file1_columns") or []),
            tuple(decision.get("suggested_file2_columns") or []),
            bool(decision.get("can_apply")),
            "supplement",
        )
        shown_keys = getattr(self, "_llm_shown_match_review_keys", None)
        if shown_keys is None:
            shown_keys = set()
            self._llm_shown_match_review_keys = shown_keys
        if sig in shown_keys:
            self._log_llm_mapping_event("supplement_match_review_dedup_skipped")
            return False
        shown_keys.add(sig)

        current_parts = []
        suggestion_parts = []
        if cols1:
            current_parts.append(f"文件1：{' + '.join(self.match_columns1 or ['未选择'])}")
            suggestion_parts.append(f"文件1：{' + '.join(decision['suggested_file1_columns']) or '无明确建议'}")
        if cols2:
            current_parts.append(f"文件2：{' + '.join(self.match_columns2 or ['未选择'])}")
            suggestion_parts.append(f"文件2：{' + '.join(decision['suggested_file2_columns']) or '无明确建议'}")
        current_text = "\n".join(current_parts) or "未选择"
        suggestion = "\n".join(suggestion_parts) or "无明确建议"
        finding = "补充清单匹配ID需要与第一步匹配ID保持同一口径。"
        if decision.get("can_apply"):
            message = (
                "当前选择\n"
                f"{current_text}\n\n"
                "复核发现\n"
                f"{finding}\n\n"
                "建议选择\n"
                f"{suggestion}\n\n"
                "采纳后会自动修正对应补充清单的匹配列；不采纳则保持当前设置。"
            )
            self._append_llm_detail_section("LLM 补充清单ID复核", message)
            if ask_apply_llm_suggestion(self, "LLM 补充清单ID复核", message):
                self._apply_supplement_match_key_columns(
                    decision["suggested_file1_columns"],
                    decision["suggested_file2_columns"],
                    cols1,
                    cols2,
                )
        else:
            message = (
                "当前选择\n"
                f"{current_text}\n\n"
                "复核发现\n"
                f"{finding}\n\n"
                "建议选择\n"
                f"{suggestion}"
            )
            self._append_llm_detail_section("LLM 补充清单ID复核", message)
            messagebox.showinfo(
                "LLM 补充清单ID复核",
                message,
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

    def _apply_supplement_match_key_columns(self, columns1, columns2, cols1, cols2):
        changed = False
        if columns1:
            if any(col not in cols1 for col in columns1):
                return False
            self.match_col1_listbox.selection_clear(0, tk.END)
            for col in columns1:
                self.match_col1_listbox.selection_set(cols1.index(col))
            self.match_columns1 = list(columns1)
            self._update_selected_match_columns(1)
            changed = True
        if columns2:
            if any(col not in cols2 for col in columns2):
                return False
            self.match_col2_listbox.selection_clear(0, tk.END)
            for col in columns2:
                self.match_col2_listbox.selection_set(cols2.index(col))
            self.match_columns2 = list(columns2)
            self._update_selected_match_columns(2)
            changed = True
        if changed:
            self._match_columns_auto_default = False
        return changed

    def _current_match_key_profile(self):
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        match1 = [self._find_actual_column_name(col, cols1_raw, '_文件1') for col in (self.match_columns1 or [])]
        match2 = [self._find_actual_column_name(col, cols2_raw, '_文件2') for col in (self.match_columns2 or [])]
        return {
            "file1": build_unique_key_profile(self.file_handler.file1_df, match1) if self.file_handler.file1_df is not None else {},
            "file2": build_unique_key_profile(self.file_handler.file2_df, match2) if self.file_handler.file2_df is not None else {},
        }

    def _current_match_key_candidate_profiles(self):
        cols1_raw = list(self.file_handler.get_file1_columns()) if self.file_handler.file1_df is not None else []
        cols2_raw = list(self.file_handler.get_file2_columns()) if self.file_handler.file2_df is not None else []
        if self.file_handler.file1_df is None or self.file_handler.file2_df is None:
            return []
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

    def _finish_llm_mapping(self, message, show_warning=False, passed=None):
        self._llm_mapping_running = False
        self._llm_mapping_passed = bool(passed if passed is not None else not show_warning)
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
        display_message = self._compact_llm_status_for_ui(message, mode)
        self.llm_status_var.set(display_message)
        self._apply_llm_status_visuals(mode, display_message)
        if message:
            self._llm_status_animating = mode in {"queued", "running"}
            self.llm_status_icon_var.set(icon or self._llm_status_icon())
            if not self.llm_status_frame.winfo_ismapped():
                self.llm_status_frame.pack(fill=tk.X, pady=(0, 8), after=self.info_label)
            if self._llm_status_animating:
                self._animate_llm_status_icon()
        else:
            self._llm_status_animating = False
            self._llm_status_mode = ""
            self.llm_status_icon_var.set("")
            self._apply_llm_status_visuals("", display_message)
            if not self.llm_status_frame.winfo_ismapped():
                self.llm_status_frame.pack(fill=tk.X, pady=(0, 8), after=self.info_label)
        self._update_llm_action_buttons()
        self._update_next_button_state()

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
        if not self._supplement_role_allowed_side(role, file_index):
            return False
        entry = target.get(file_index)
        cols = cols1 if file_index == 1 else cols2
        if not entry or col not in cols:
            return False
        previous_value = entry["var"].get() if entry.get("var") is not None else ""
        if entry.get("var") is not None:
            entry["var"].set(col)
        combo = entry.get("combo")
        if combo is not None:
            try:
                combo.current(1 + cols.index(col))
            except tk.TclError:
                combo.set(col)
        if role == "name":
            if previous_value and previous_value != col:
                if side == "file1":
                    self.match_columns1 = [item for item in (self.match_columns1 or []) if item != previous_value]
                else:
                    self.match_columns2 = [item for item in (self.match_columns2 or []) if item != previous_value]
            self._append_mapped_name_to_auto_match_columns(cols1, cols2)
        if role in self.OPTIONAL_ADDITION_ROLES:
            self._fallback_addition_date_to_entry_date(cols1, cols2)
            self._update_optional_addition_rows_visibility()
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
        if not self._supplement_role_allowed_side(role, file_index):
            return False
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
        if role in self.OPTIONAL_ADDITION_ROLES:
            self._fallback_addition_date_to_entry_date(cols1, cols2)
            self._update_optional_addition_rows_visibility()
        return True

    def _llm_role_targets(self, include_disallowed=False):
        targets = {
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
        if include_disallowed:
            return targets
        filtered = {}
        for role, sides in targets.items():
            if not self._role_available_in_current_mode(role):
                continue
            allowed = {
                file_index: entry
                for file_index, entry in sides.items()
                if self._supplement_role_allowed_side(role, file_index)
            }
            if allowed:
                filtered[role] = allowed
        return filtered

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
        return [
            {"role": role, "label": label, "description": label}
            for role, label in base
            if self._role_available_in_current_mode(role)
        ]

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
        apply_app_theme(dialog)
        fit_window_to_screen(dialog, 460, 420, min_width=420, min_height=360)
        dialog.transient(self.winfo_toplevel())
        dialog.grab_set()
        dialog.columnconfigure(0, weight=1)
        dialog.rowconfigure(1, weight=1)
        
        ttk.Label(dialog, text="请选择列:", font=("Arial", 10)).grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 6))
        
        list_frame = ttk.Frame(dialog)
        list_frame.grid(row=1, column=0, sticky="nsew", padx=12, pady=(0, 8))
        list_frame.columnconfigure(0, weight=1)
        list_frame.rowconfigure(0, weight=1)
        
        # 匹配列支持多选，其他列单选
        selectmode = tk.EXTENDED if col_type == 'match' else tk.SINGLE
        listbox = tk.Listbox(list_frame, height=10, selectmode=selectmode)
        listbox.grid(row=0, column=0, sticky="nsew")
        
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=listbox.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
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
        
        def on_ok():
            selection = listbox.curselection()
            if selection:
                self._reset_llm_state_for_new_input()
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
        
        action_frame = ttk.Frame(dialog)
        action_frame.grid(row=2, column=0, sticky="ew", padx=12, pady=(0, 12))
        ttk.Separator(action_frame, orient=tk.HORIZONTAL).pack(fill=tk.X, pady=(0, 8))
        button_frame = ttk.Frame(action_frame)
        button_frame.pack(side=tk.RIGHT)
        confirm_button = ttk.Button(button_frame, text="确认选择", command=on_ok, width=12)
        confirm_button.pack(side=tk.LEFT, padx=(0, 8))
        ttk.Button(button_frame, text="取消", command=on_cancel, width=10).pack(side=tk.LEFT)
        
        listbox.bind('<Double-Button-1>', lambda e: on_ok())
        dialog.bind('<Return>', lambda e: on_ok())
        dialog.bind('<Escape>', lambda e: on_cancel())
        listbox.focus_set()
        center_on_parent(dialog, self.winfo_toplevel())
    
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
            self._sync_sheet_combo_display(1, fallback_to_first=True)
            file_path = self.file1_path_var.get()
            sheet_name = self.file1_sheet_var.get() if self.file1_sheet_var.get() else None
            # 获取当前使用的header（如果之前设置过）
            current_header = getattr(self, 'file1_header_row', 0)
            current_df = self.file_handler.file1_df  # 获取当前DataFrame
            self.file1_header_row = row_index
        else:
            self._sync_sheet_combo_display(2, fallback_to_first=True)
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
        self._reset_llm_state_for_new_input()
        self._sync_sheet_combo_display(file_num, fallback_to_first=True)
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
        self._sync_all_sheet_combo_displays(fallback_to_first=True)
        
        # 验证文件是否已选择
        file1_display_name = self._get_file_display_name(1)
        file2_display_name = self._get_file_display_name(2)
        is_supplement_mode = (self.mode == "supplement")
        file1_path = (self.file1_path_var.get() or "").strip()
        file2_path = (self.file2_path_var.get() or "").strip()
        has_file1_input = bool(file1_path)
        has_file2_input = bool(file2_path)

        if is_supplement_mode:
            if not has_file1_input and not has_file2_input:
                self._show_next_step_warning("\u8bf7\u81f3\u5c11\u9009\u62e9\u5e76\u52a0\u8f7d\u4e00\u4efd\u65b0\u589e\u6e05\u5355\u6216\u5904\u7f6e\u6e05\u5355\u3002")
                return
        else:
            if not has_file1_input:
                self._show_next_step_warning("\u8bf7\u5148\u5728\u5de6\u4fa7\u201c\u6587\u4ef61\u201d\u533a\u57df\u9009\u62e9\u5e76\u52a0\u8f7d\u539f\u59cb\u6587\u4ef6\u3002")
                return
            if not has_file2_input:
                self._show_next_step_warning("\u8bf7\u5148\u5728\u5de6\u4fa7\u201c\u6587\u4ef62\u201d\u533a\u57df\u9009\u62e9\u5e76\u52a0\u8f7d\u5bf9\u6bd4\u6587\u4ef6\u3002")
                return

        def _require_sheet(path, sheet_var, display_name):
            _, ext = os.path.splitext(path)
            ext = str(ext).lower() if ext else ''
            if ext in ['.xlsx', '.xls'] and not sheet_var.get():
                self._show_next_step_warning(f"\u8bf7\u5148\u4e3a\u201c{display_name}\u201d\u9009\u62e9\u5de5\u4f5c\u8868\uff0c\u518d\u7ee7\u7eed\u3002")
                return False
            return True

        if has_file1_input and not _require_sheet(file1_path, self.file1_sheet_var, file1_display_name):
            return
        if has_file2_input and not _require_sheet(file2_path, self.file2_sheet_var, file2_display_name):
            return

        has_file1_df = self.file_handler.file1_df is not None
        has_file2_df = self.file_handler.file2_df is not None
        if has_file1_input and not has_file1_df:
            self._show_next_step_warning(f"\u201c{file1_display_name}\u201d\u5c1a\u672a\u52a0\u8f7d\u5b8c\u6210\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u6587\u4ef6\u6216\u5de5\u4f5c\u8868\u3002")
            return
        if has_file2_input and not has_file2_df:
            self._show_next_step_warning(f"\u201c{file2_display_name}\u201d\u5c1a\u672a\u52a0\u8f7d\u5b8c\u6210\uff0c\u8bf7\u91cd\u65b0\u9009\u62e9\u6587\u4ef6\u6216\u5de5\u4f5c\u8868\u3002")
            return
        if is_supplement_mode and not has_file1_df and not has_file2_df:
            self._show_next_step_warning("\u8bf7\u81f3\u5c11\u52a0\u8f7d\u4e00\u4efd\u65b0\u589e\u6e05\u5355\u6216\u5904\u7f6e\u6e05\u5355\u3002")
            return

        match_cols1 = self.match_columns1.copy() if (has_file1_df and self.match_columns1) else []
        match_cols2 = self.match_columns2.copy() if (has_file2_df and self.match_columns2) else []

        if has_file1_df and not match_cols1:
            self._show_next_step_warning(f"\u8bf7\u5728\u201c{file1_display_name}\u201d\u7684\u5339\u914d\u5217\u533a\u57df\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u5339\u914d\u5217\u3002")
            return
        if has_file2_df and not match_cols2:
            self._show_next_step_warning(f"\u8bf7\u5728\u201c{file2_display_name}\u201d\u7684\u5339\u914d\u5217\u533a\u57df\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u5339\u914d\u5217\u3002")
            return
        if has_file1_df and has_file2_df and len(match_cols1) != len(match_cols2):
            self._show_next_step_warning(
                f"\u6587\u4ef61\u548c\u6587\u4ef62\u7684\u5339\u914d\u5217\u6570\u91cf\u5fc5\u987b\u76f8\u540c\u3002\n\n"
                f"\u5f53\u524d\uff1a\u6587\u4ef61\u5df2\u9009 {len(match_cols1)} \u5217\uff0c\u6587\u4ef62\u5df2\u9009 {len(match_cols2)} \u5217\u3002"
            )
            return
        if (
            is_llm_enabled()
            and not getattr(self, "_llm_mapping_passed", False)
            and not getattr(self, "_llm_mapping_bypassed", False)
        ):
            if self._llm_mapping_running or self._llm_mapping_assist_scheduled:
                self._show_next_step_warning("大模型正在复核当前配置，请等待复核成功完成后再继续。")
            else:
                self._show_next_step_warning("当前配置尚未完成大模型复核，或上次复核失败/已停止。请点击“重新复核”，成功完成后再继续。")
            self._update_next_button_state()
            return

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
        
        addition_method_col2 = self._get_mapped_col(self.addition_method_col2_var.get(), cols2_raw, '_文件2')
        addition_date_col2 = self._get_mapped_col(self.addition_date_col2_var.get(), cols2_raw, '_文件2') if addition_method_col2 else None

        # 准备配置（使用实际的列名，列表格式）
        config = {
            'file1_path': self.file1_path_var.get().strip(),
            'file2_path': self.file2_path_var.get().strip(),
            'file1_sheet': self.file1_sheet_var.get().strip(),
            'file2_sheet': self.file2_sheet_var.get().strip(),
            'file1_header_row': self.file1_header_row,
            'file2_header_row': self.file2_header_row,
            'match_column1': match_cols1_actual,  # 改为列表
            'match_column2': match_cols2_actual,  # 改为列表
            'data_type1': 'auto',
            'data_type2': 'auto',
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
            'addition_method_col1': None if self.mode != "supplement" else self._get_mapped_col(self.addition_method_col1_var.get(), cols1_raw, '_文件1'),
            'addition_method_col2': addition_method_col2,
            'addition_date_col1': None if self.mode != "supplement" else self._get_mapped_col(self.addition_date_col1_var.get(), cols1_raw, '_文件1'),
            'addition_date_col2': addition_date_col2,
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

