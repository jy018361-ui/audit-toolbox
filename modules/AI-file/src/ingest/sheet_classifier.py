from __future__ import annotations

import re

from ingest.constants import CONTENT_SIGNATURES, SKIP_SHEET_PREFIXES
from ingest.header_detection import count_signature_fields, scan_rows_for_headers
from ingest.models import SheetKind


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", "", name.strip().lower())


def score_by_name(sheet_name: str) -> tuple[SheetKind, float, str | None]:
    """根据工作表名称返回 (kind, score 0-1, hint)。"""
    n = _norm_name(sheet_name)
    raw = sheet_name.strip()

    for prefix in SKIP_SHEET_PREFIXES:
        if raw == prefix or raw.startswith(prefix):
            return SheetKind.SKIP, 1.0, "skip_prefix"

    if "skywindsettingsheet" in n:
        return SheetKind.SKIP, 1.0, "skywind"

    # 顺序：更具体的先匹配
    if "折旧政策" in raw or "k.03.3" in n:
        return SheetKind.DEPRECIATION_POLICY, 0.9, "name_k033"
    if ("k.03.2" in n or "折旧测试" in raw) and ("byitem" in n.replace(" ", "") or "by item" in raw.lower()):
        return SheetKind.DEPRECIATION_TOD, 0.92, "name_dep_tod_byitem"
    if "k.03.2" in n or ("折旧测试" in raw and "tod" in n):
        return SheetKind.DEPRECIATION_TOD_SAMPLE, 0.75, "name_dep_tod_sample"
    if "k.03.1" in n or (n.endswith("sap") or " sap" in n):
        return SheetKind.SAP, 0.88, "name_sap"
    if "新增清单" in raw or "k.02.1b" in n and "新增" in raw:
        return SheetKind.ADDITION_LIST, 0.9, "name_addition"
    if "处置清单" in raw:
        return SheetKind.DISPOSAL_LIST, 0.9, "name_disposal"
    if "fa list" in n or "固定资产清单" in raw or "资产清单" in raw:
        return SheetKind.FA_LIST, 0.88, "name_fa_list"
    if re.search(r"fa\s*list", raw, re.I) or "k.01.1" in n and "fa" in n:
        return SheetKind.FA_LIST, 0.85, "name_fa_list_variant"
    if "k.00" in n or "lead sheet" in n:
        return SheetKind.LEAD, 0.88, "name_lead"
    if "k.01" in n or ("agree" in n and "gl" in n):
        return SheetKind.ROLLFORWARD, 0.85, "name_rollforward"
    if "汇总" in raw:
        return SheetKind.SUMMARY, 0.8, "name_summary"

    return SheetKind.UNCLASSIFIED, 0.0, None


def score_by_content(
    rows: list,
    sheet_kind_hint: SheetKind | None = None,
) -> tuple[SheetKind, float, int | None, list]:
    """根据表头内容对各类型打分，返回最佳类型。"""
    best_kind = SheetKind.UNCLASSIFIED
    best_score = 0.0
    best_row: int | None = None
    best_cells: list = []

    kinds_to_try = list(CONTENT_SIGNATURES.keys())
    if sheet_kind_hint and sheet_kind_hint != SheetKind.UNCLASSIFIED:
        kinds_to_try = [sheet_kind_hint] + [k for k in kinds_to_try if k != sheet_kind_hint]

    for kind in kinds_to_try:
        sig = CONTENT_SIGNATURES.get(kind, set())
        if not sig:
            continue
        header_row, cells, _ = scan_rows_for_headers(rows, sheet_kind=kind)
        if not cells:
            continue
        hit = count_signature_fields(cells, sig, sheet_kind=kind)
        score = hit / max(len(sig), 1)
        if score > best_score:
            best_score = score
            best_kind = kind
            best_row = header_row
            best_cells = cells

    # by item 折旧表：字段更全则提升为 DEPRECIATION_TOD
    if best_kind in (SheetKind.DEPRECIATION_TOD, SheetKind.DEPRECIATION_TOD_SAMPLE):
        full_sig = CONTENT_SIGNATURES[SheetKind.DEPRECIATION_TOD]
        hit = count_signature_fields(best_cells, full_sig, SheetKind.DEPRECIATION_TOD)
        if hit >= 6:
            best_kind = SheetKind.DEPRECIATION_TOD
            best_score = max(best_score, 0.85)

    return best_kind, best_score, best_row, best_cells


def classify_sheet(
    sheet_name: str,
    rows: list,
) -> tuple[SheetKind, float, float, float, str | None, int | None]:
    """
    综合名称与内容分类。
    返回 (kind, confidence, name_score, content_score, name_hint, header_row).
    """
    name_kind, name_score, name_hint = score_by_name(sheet_name)
    if name_kind == SheetKind.SKIP:
        return name_kind, 1.0, name_score, 0.0, name_hint, None

    content_kind, content_score, header_row, _ = score_by_content(
        rows,
        sheet_kind_hint=name_kind if name_score >= 0.7 else None,
    )

    # 内容优先；名称一致时加分
    if content_score >= 0.45 and content_kind != SheetKind.UNCLASSIFIED:
        kind = content_kind
        confidence = min(0.95, 0.5 * content_score + 0.3 * name_score + 0.2)
        if name_kind == content_kind and name_score >= 0.7:
            confidence = min(0.98, confidence + 0.15)
        elif name_kind != content_kind and name_score >= 0.7:
            confidence = max(confidence, content_score * 0.9)
        return kind, confidence, name_score, content_score, name_hint, header_row

    if name_score >= 0.75 and name_kind != SheetKind.UNCLASSIFIED:
        header_row, _, _ = scan_rows_for_headers(rows, sheet_kind=name_kind)
        confidence = name_score * 0.85
        return name_kind, confidence, name_score, content_score, name_hint, header_row

    return SheetKind.UNCLASSIFIED, max(name_score, content_score) * 0.5, name_score, content_score, name_hint, header_row
