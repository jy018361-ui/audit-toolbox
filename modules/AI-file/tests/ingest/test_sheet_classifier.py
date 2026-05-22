from ingest.sheet_classifier import score_by_name
from ingest.models import SheetKind


def test_name_variants_fa_list():
    k, s, _ = score_by_name("K.01.1a FA list")
    assert k == SheetKind.FA_LIST
    assert s >= 0.8

    k2, _, _ = score_by_name("FA list-24")
    assert k2 == SheetKind.FA_LIST


def test_name_addition_list():
    k, s, _ = score_by_name("K.02.1b 新增清单")
    assert k == SheetKind.ADDITION_LIST
    assert s >= 0.8


def test_skip_internal():
    k, _, _ = score_by_name("DS_INTERNAL_DOCUMENT_STORAGE")
    assert k == SheetKind.SKIP
