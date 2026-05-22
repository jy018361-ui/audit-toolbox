from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class SheetKind(str, Enum):
    FA_LIST = "fa_list"
    ADDITION_LIST = "addition_list"
    DISPOSAL_LIST = "disposal_list"
    DEPRECIATION_TOD = "depreciation_tod"
    DEPRECIATION_TOD_SAMPLE = "depreciation_tod_sample"
    LEAD = "lead"
    ROLLFORWARD = "rollforward"
    SUMMARY = "summary"
    SAP = "sap"
    DEPRECIATION_POLICY = "depreciation_policy"
    UNCLASSIFIED = "unclassified"
    SKIP = "skip"


@dataclass
class FieldMapping:
    standard_field: str
    source_header: str
    column_index: int


@dataclass
class SheetClassification:
    sheet_name: str
    kind: SheetKind
    confidence: float
    name_score: float
    content_score: float
    name_hint: str | None = None
    header_row: int | None = None
    mapped_fields: list[FieldMapping] = field(default_factory=list)
    missing_required: list[str] = field(default_factory=list)
    missing_recommended: list[str] = field(default_factory=list)
    unmapped_headers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


@dataclass
class WorkbookDiagnostic:
    path: str
    sheets: list[SheetClassification] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "errors": self.errors,
            "sheets": [
                {
                    "sheet_name": s.sheet_name,
                    "kind": s.kind.value,
                    "confidence": s.confidence,
                    "name_score": s.name_score,
                    "content_score": s.content_score,
                    "name_hint": s.name_hint,
                    "header_row": s.header_row,
                    "mapped_fields": [
                        {
                            "standard_field": m.standard_field,
                            "source_header": m.source_header,
                            "column_index": m.column_index,
                        }
                        for m in s.mapped_fields
                    ],
                    "missing_required": s.missing_required,
                    "missing_recommended": s.missing_recommended,
                    "unmapped_headers": s.unmapped_headers[:20],
                    "notes": s.notes,
                }
                for s in self.sheets
            ],
        }
