from ingest.field_mapping import match_standard_field, check_required_fields, map_headers
from ingest.models import FieldMapping, SheetKind


def test_fa_list_synonyms():
    assert match_standard_field("卡片编码", SheetKind.FA_LIST) == "asset_id"
    assert match_standard_field("资产净值", SheetKind.FA_LIST) == "net_value"
    assert match_standard_field("使用年限(月)", SheetKind.FA_LIST) == "useful_life_months"


def test_disposal_blocks_document_number():
    assert match_standard_field("单据编号", SheetKind.DISPOSAL_LIST) is None


def test_fa_list_semantic_required_identity_only_name():
    mapped = [
        FieldMapping("asset_name", "资产名称", 1),
        FieldMapping("original_value", "原值", 2),
        FieldMapping("accumulated_depreciation", "累计折旧", 3),
        FieldMapping("net_value", "净值", 4),
    ]
    missing_req, missing_rec = check_required_fields(mapped, SheetKind.FA_LIST)
    assert "asset_id|asset_name" not in missing_req
    assert "original_value" not in missing_req


def test_fa_list_missing_core():
    mapped = [FieldMapping("asset_id", "编号", 1)]
    missing_req, _ = check_required_fields(mapped, SheetKind.FA_LIST)
    assert "original_value" in missing_req
    assert "net_value" in missing_req
