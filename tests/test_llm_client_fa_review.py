import unittest
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

import launcher.llm_client as llm_client
from launcher.llm_client import LLMMatchKeyReview
from gui.file_and_match_config import FileAndMatchConfig


class IndependentFAListLLMTests(unittest.TestCase):
    def _patch_chat(self, response, captured):
        original = llm_client._chat_completion

        def fake_chat(settings, messages, **kwargs):
            captured["payload"] = llm_client.json.loads(messages[1]["content"])
            captured["task_name"] = kwargs.get("task_name")
            return llm_client.json.dumps(response, ensure_ascii=False)

        llm_client._chat_completion = fake_chat
        self.addCleanup(lambda: setattr(llm_client, "_chat_completion", original))

    def test_combined_prompt_is_blind_and_compares_afterward(self):
        captured = {}
        self._patch_chat(
            {
                "roles": [
                    {
                        "role": "category",
                        "file1": "file1_col_1",
                        "file2": "file2_col_2",
                        "confidence": 0.91,
                        "reason": "当前列为代码",
                    }
                ]
            },
            captured,
        )
        files = [
            {
                "file_side": "file1",
                "headers": ["固定资产类别"],
                "samples": {"固定资产类别": ["房屋及建筑物", "机器设备"]},
                "column_profiles": {
                    "固定资产类别": {"unique_count": 2, "cjk_short_name_ratio": 1.0, "looks_like_code_ratio": 0.0}
                },
            },
            {
                "file_side": "file2",
                "headers": ["资产分类", "资产类别"],
                "samples": {"资产分类": ["Y110", "Y120"], "资产类别": ["房屋及建筑物", "机器设备"]},
                "column_profiles": {
                    "资产分类": {"unique_count": 2, "cjk_short_name_ratio": 0.0, "looks_like_code_ratio": 1.0},
                    "资产类别": {"unique_count": 2, "cjk_short_name_ratio": 1.0, "looks_like_code_ratio": 0.0},
                },
            },
        ]

        result = llm_client.generate_combined_fa_list_assistance(
            {"api_key": "test"},
            tool_name="FA List",
            role_definitions=[],
            files=files,
            current_mapping={"category": {"file1": "固定资产类别", "file2": "资产分类"}},
            current_match={"file1": ["固定资产编号"], "file2": ["资产编号"]},
            local_profile={"script": "must not be sent"},
            candidate_profiles=[{"script": "must not be sent"}],
            include_match_review=False,
        )

        self.assertEqual(result.fa_review[0].role, "category")
        self.assertEqual(result.fa_review[0].suggested_mapping, {"file2": "资产类别"})
        payload = captured["payload"]
        self.assertIn("blind_files", payload)
        self.assertNotIn("current_mapping", payload)
        self.assertNotIn("current_match", payload)
        self.assertNotIn("candidate_profiles", payload)
        self.assertNotIn("local_profile", payload)
        payload_text = llm_client.json.dumps(payload, ensure_ascii=False)
        self.assertIn("file2_col_2", payload_text)
        self.assertIn("房屋及建筑物", payload_text)
        self.assertIn("资产类别", payload_text)

    def test_haili_02_shape_returns_category_name_and_match_key_corrections(self):
        captured = {}
        self._patch_chat(
            {
                "roles": [
                    {
                        "role": "category",
                        "file1": "file1_col_1",
                        "file2": "file2_col_3",
                        "confidence": 0.92,
                        "reason": "短类名一致",
                    },
                    {
                        "role": "name",
                        "file1": "file1_col_3",
                        "file2": "file2_col_5",
                        "confidence": 0.9,
                        "reason": "长描述一致",
                    },
                ],
                "match_key": {
                    "file1": ["file1_col_2", "file1_col_3"],
                    "file2": ["file2_col_4", "file2_col_5"],
                    "confidence": 0.88,
                    "reason": "编码加名称更稳定",
                },
            },
            captured,
        )
        files = [
            {
                "file_side": "file1",
                "headers": ["固定资产类", "coding", "固定资产名称"],
                "samples": {
                    "固定资产类": ["房屋及建筑物", "房屋及建筑物"],
                    "coding": ["1100000", "1100001"],
                    "固定资产名称": ["舒乐300T高速冲基础", "南昌海立实验室冷量台"],
                },
                "column_profiles": {
                    "固定资产类": {"unique_count": 10, "cjk_short_name_ratio": 1.0, "long_text_ratio": 0.0},
                    "coding": {"unique_count": 10319, "looks_like_code_ratio": 1.0},
                    "固定资产名称": {"unique_count": 4941, "long_text_ratio": 1.0},
                },
            },
            {
                "file_side": "file2",
                "headers": ["1", "资产分类", "资产描述", "资产描述.1", "资产类型描述"],
                "samples": {
                    "1": ["H201", "H201"],
                    "资产分类": ["Y110", "Y120"],
                    "资产描述": ["房屋及建筑物", "机器设备"],
                    "资产描述.1": ["1100000", "1100001"],
                    "资产类型描述": ["舒乐300T高速冲基础", "南昌海立实验室冷量台"],
                },
                "column_profiles": {
                    "1": {"unique_count": 1, "looks_like_code_ratio": 1.0},
                    "资产分类": {"unique_count": 10, "looks_like_code_ratio": 1.0},
                    "资产描述": {"unique_count": 10, "cjk_short_name_ratio": 1.0, "long_text_ratio": 0.0},
                    "资产描述.1": {"unique_count": 10319, "looks_like_code_ratio": 1.0},
                    "资产类型描述": {"unique_count": 4941, "long_text_ratio": 1.0},
                },
            },
        ]

        result = llm_client.generate_combined_fa_list_assistance(
            {"api_key": "test"},
            tool_name="FA List",
            role_definitions=[],
            files=files,
            current_mapping={
                "category": {"file1": "固定资产类", "file2": "资产分类"},
                "name": {"file1": "固定资产名称", "file2": "资产描述"},
            },
            current_match={"file1": ["coding", "固定资产名称"], "file2": ["1", "资产类型描述"]},
            local_profile={"script": "must not be sent"},
            candidate_profiles=[{"script": "must not be sent"}],
            include_match_review=True,
        )

        reviews = {item.role: item for item in result.fa_review}
        self.assertEqual(reviews["category"].suggested_mapping, {"file2": "资产描述"})
        self.assertEqual(reviews["name"].suggested_mapping, {"file2": "资产类型描述"})
        self.assertEqual(result.match_review.action, "replace")
        self.assertEqual(result.match_review.suggested_file1_columns, ["coding", "固定资产名称"])
        self.assertEqual(result.match_review.suggested_file2_columns, ["资产描述.1", "资产类型描述"])
        self.assertNotIn("current_match", captured["payload"])
        self.assertNotIn("candidate_profiles", captured["payload"])

    def test_review_match_key_columns_does_not_send_local_risk_inputs(self):
        captured = {}
        self._patch_chat(
            {
                "match_key": {
                    "file1": ["file1_col_1"],
                    "file2": ["file2_col_1"],
                    "confidence": 0.8,
                    "reason": "独立判断一致",
                }
            },
            captured,
        )
        review = llm_client.review_match_key_columns(
            {"api_key": "test"},
            tool_name="FA List",
            files=[
                {"file_side": "file1", "headers": ["编码"], "samples": {"编码": ["1100000"]}},
                {"file_side": "file2", "headers": ["资产描述.1"], "samples": {"资产描述.1": ["1100000"]}},
            ],
            current_match={"file1": ["编码"], "file2": ["资产描述.1"]},
            local_profile={"duplicate_row_count": 999},
            candidate_profiles=[{"file1_columns": ["脚本候选"]}],
        )

        self.assertEqual(review.action, "keep")
        self.assertNotIn("local_profile", captured["payload"])
        self.assertNotIn("candidate_profiles", captured["payload"])


    def test_code_review_keeps_existing_auxiliary_name_column(self):
        captured = {}
        self._patch_chat(
            {
                "match_key": {
                    "file1": ["file1_col_1"],
                    "file2": ["file2_col_1"],
                    "confidence": 0.86,
                    "reason": "?????",
                }
            },
            captured,
        )
        review = llm_client.review_match_key_columns(
            {"api_key": "test"},
            tool_name="FA List",
            files=[
                {
                    "file_side": "file1",
                    "headers": ["??", "??????"],
                    "samples": {"??": ["1100000"], "??????": ["??300T?????"]},
                },
                {
                    "file_side": "file2",
                    "headers": ["????.1", "??????"],
                    "samples": {"????.1": ["1100000"], "??????": ["??300T?????"]},
                },
            ],
            current_match={"file1": ["??", "??????"], "file2": ["????.1", "??????"]},
            local_profile={"script": "must not be sent"},
            candidate_profiles=[{"script": "must not be sent"}],
        )

        self.assertEqual(review.action, "keep")
        self.assertEqual(review.suggested_file1_columns, ["??", "??????"])
        self.assertEqual(review.suggested_file2_columns, ["????.1", "??????"])
        payload_text = llm_client.json.dumps(captured["payload"], ensure_ascii=False)
        self.assertIn("code columns only", payload_text)
        self.assertIn("do not judge, add, remove, or replace that auxiliary name part", payload_text)

    def test_keep_match_review_is_not_replaced_by_local_fallback_warning(self):
        dummy = type("Dummy", (), {})()
        dummy.match_columns1 = ["编码"]
        dummy.match_columns2 = ["资产描述.1"]
        review = LLMMatchKeyReview(
            status="ok",
            confidence=0.8,
            action="keep",
            reasons=[],
            suggested_file1_columns=["编码"],
            suggested_file2_columns=["资产描述.1"],
            suggestion_reason="独立判断一致",
        )

        shown = FileAndMatchConfig._handle_llm_match_key_review(
            dummy,
            review,
            ["编码"],
            ["资产描述.1"],
            match_profile={
                "file1": {"duplicate_row_count": 100},
                "file2": {"duplicate_row_count": 100},
            },
        )

        self.assertFalse(shown)


if __name__ == "__main__":
    unittest.main()