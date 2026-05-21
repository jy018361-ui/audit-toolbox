from __future__ import annotations

import re

from ingest.constants import (
    BLOCKED_ASSET_ID_HEADERS,
    FA_LIST_RECOMMENDED,
    FA_LIST_REQUIRED,
    FA_LIST_REQUIRED_IDENTITY,
    FIELD_SYNONYMS,
    REQUIRED_BY_KIND,
)
from ingest.models import FieldMapping, SheetKind


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", str(text).replace("\n", "").replace("\r", "")).lower()


def match_standard_field(
    cell_value: str,
    sheet_kind: SheetKind | None = None,
) -> str | None:
    """将表头单元格映射到标准字段名。"""
    raw = str(cell_value).strip()
    if not raw or len(raw) > 120:
        return None
    n = _norm(raw)

    if sheet_kind == SheetKind.DISPOSAL_LIST and raw in BLOCKED_ASSET_ID_HEADERS:
        return None
    if raw in BLOCKED_ASSET_ID_HEADERS and "单据" in raw:
        return None

    best: str | None = None
    best_len = 0
    for field, synonyms in FIELD_SYNONYMS.items():
        for syn in synonyms:
            ns = _norm(syn)
            if not ns:
                continue
            if ns in n or n in ns:
                if len(ns) > best_len:
                    best = field
                    best_len = len(ns)
    return best


def map_headers(
    header_cells: list[tuple[int, str]],
    sheet_kind: SheetKind | None = None,
) -> tuple[list[FieldMapping], list[str]]:
    """header_cells: (col_index, text). 返回映射列表与未映射表头。"""
    mapped: dict[str, FieldMapping] = {}
    unmapped: list[str] = []
    for col, text in header_cells:
        field = match_standard_field(text, sheet_kind)
        if field and field not in mapped:
            mapped[field] = FieldMapping(
                standard_field=field,
                source_header=text.strip(),
                column_index=col,
            )
        elif text.strip() and not field:
            if len(text.strip()) <= 80 and not text.strip().startswith("获取"):
                unmapped.append(text.strip())
    return list(mapped.values()), unmapped


def check_required_fields(
    mapped_fields: list[FieldMapping],
    sheet_kind: SheetKind,
) -> tuple[list[str], list[str]]:
    """返回 (missing_required, missing_recommended)。"""
    present = {m.standard_field for m in mapped_fields}
    missing_req: list[str] = []
    missing_rec: list[str] = []

    if sheet_kind == SheetKind.FA_LIST:
        if not (FA_LIST_REQUIRED_IDENTITY[0] in present or FA_LIST_REQUIRED_IDENTITY[1] in present):
            missing_req.append("asset_id|asset_name")
        for f in FA_LIST_REQUIRED:
            if f not in present:
                missing_req.append(f)
        for f in FA_LIST_RECOMMENDED:
            if f not in present:
                missing_rec.append(f)
        return missing_req, missing_rec

    required = REQUIRED_BY_KIND.get(sheet_kind, [])
    for f in required:
        if f not in present:
            missing_req.append(f)
    return missing_req, missing_rec
