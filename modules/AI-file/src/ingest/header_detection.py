from __future__ import annotations

from typing import Any

from ingest.field_mapping import map_headers, match_standard_field
from ingest.models import SheetKind


def scan_rows_for_headers(
    rows: list[tuple[Any, ...]],
    max_rows: int = 100,
    max_cols: int = 100,
    sheet_kind: SheetKind | None = None,
) -> tuple[int | None, list[tuple[int, str]], list[str]]:
    """
    在前 N 行中找表头候选行。
    返回 (header_row_1based, header_cells, unmapped).
    """
    best_row: int | None = None
    best_count = 0
    best_cells: list[tuple[int, str]] = []
    best_unmapped: list[str] = []

    limit = min(len(rows), max_rows)
    for r_idx in range(limit):
        row = rows[r_idx]
        if row is None:
            continue
        cells: list[tuple[int, str]] = []
        for c_idx, val in enumerate(row[:max_cols], start=1):
            if val is None or not str(val).strip():
                continue
            cells.append((c_idx, str(val).strip()))
        if not cells:
            continue
        mapped, unmapped = map_headers(cells, sheet_kind)
        if len(mapped) > best_count:
            best_count = len(mapped)
            best_row = r_idx + 1
            best_cells = cells
            best_unmapped = unmapped

    if best_row is None:
        return None, [], []
    _, unmapped = map_headers(best_cells, sheet_kind)
    return best_row, best_cells, unmapped


def count_signature_fields(
    header_cells: list[tuple[int, str]],
    signature: set[str],
    sheet_kind: SheetKind | None = None,
) -> int:
    present = set()
    for _, text in header_cells:
        f = match_standard_field(text, sheet_kind)
        if f:
            present.add(f)
    return len(signature & present)
