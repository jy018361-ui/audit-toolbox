"""Tests for the forbidden-columns guard that keeps already-mapped business
attribute fields (depreciation, original value, dates, category, etc.) out of
LLM-suggested match keys.

Covers:
- forbidden_columns is correctly threaded into the LLM payload
- candidate_profiles entries that include a forbidden column are dropped pre-flight
- asset-name role is exempted (it stays available as an auxiliary key)
- front-end sanitizer scrubs/downgrades LLM responses that violate the rules
"""

import json
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

import launcher.llm_client as llm_client
from gui.file_and_match_config import (
    filter_match_key_candidates_by_forbidden,
    sanitize_llm_match_review_against_forbidden,
)


class ReviewMatchKeyForbiddenPayloadTests(unittest.TestCase):
    def test_script_forbidden_columns_are_not_threaded_into_blind_payload(self):
        captured = {}

        def fake_chat(settings, messages, **kwargs):
            captured["messages"] = messages
            return json.dumps({
                "match_key": {
                    "file1": ["file1_col_1"],
                    "file2": ["file2_col_1"],
                    "confidence": 0.9,
                    "reason": "独立判断一致",
                }
            }, ensure_ascii=False)

        files = [
            {"file_side": "file1", "headers": ["资产编码", "原值", "累计折旧"], "samples": {"资产编码": ["1100000"]}},
            {"file_side": "file2", "headers": ["资产编码", "原值", "累计折旧"], "samples": {"资产编码": ["1100000"]}},
        ]
        forbidden = {"file1": ["原值", "累计折旧"], "file2": ["原值", "累计折旧"]}

        with patch.object(llm_client, "_chat_completion", side_effect=fake_chat):
            llm_client.review_match_key_columns(
                {"base_url": "x", "model": "y", "api_key": "z"},
                tool_name="FA List",
                files=files,
                current_match={"file1": ["资产编码"], "file2": ["资产编码"]},
                local_profile={"script": "must not be sent"},
                candidate_profiles=[{"script": "must not be sent"}],
                forbidden_columns=forbidden,
            )

        user_msg = next(m for m in captured["messages"] if m["role"] == "user")
        payload = json.loads(user_msg["content"])
        self.assertIn("blind_files", payload)
        self.assertNotIn("forbidden_columns", payload)
        self.assertNotIn("current_match", payload)
        self.assertNotIn("local_profile", payload)
        self.assertNotIn("candidate_profiles", payload)

class FilterCandidatesByForbiddenTests(unittest.TestCase):
    def _candidate(self, group, cols1, cols2):
        return {
            "group": group,
            "file1_columns": cols1,
            "file2_columns": cols2,
            "file1": {},
            "file2": {},
        }

    def test_drops_candidates_with_forbidden_columns(self):
        candidates = [
            self._candidate("a", ["资产编码", "入账开始日期"], ["资产编码", "资本化日期"]),
            self._candidate("b", ["资产编码", "次级编码"], ["资产编码", "卡片号"]),
        ]
        forbidden = {
            "file1": ["入账开始日期"],
            "file2": ["资本化日期"],
        }
        kept = filter_match_key_candidates_by_forbidden(candidates, forbidden)
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["group"], "b")

    def test_asset_name_not_in_forbidden_so_candidate_survives(self):
        # 资产名称属于例外：构造 forbidden 时 GUI 不会把 name 字段加入，
        # 所以含资产名称的候选不应被过滤。
        candidates = [
            self._candidate("a", ["资产编码", "固定资产名称"], ["资产编码", "资产描述"]),
        ]
        # 只禁折旧等业务字段，没有把资产名称加进来。
        forbidden = {"file1": ["累计折旧"], "file2": ["累计折旧"]}
        kept = filter_match_key_candidates_by_forbidden(candidates, forbidden)
        self.assertEqual(len(kept), 1)

    def test_empty_forbidden_returns_all(self):
        candidates = [self._candidate("a", ["x"], ["x"])]
        kept = filter_match_key_candidates_by_forbidden(candidates, {"file1": [], "file2": []})
        self.assertEqual(len(kept), 1)


class SanitizeReviewAgainstForbiddenTests(unittest.TestCase):
    def test_unbalanced_after_scrub_downgrades_to_keep(self):
        # User reproduces: file1=[资产名称, 入账日期], file2=[资产编码, 资产描述, 资本化日期]
        review = {
            "status": "warning",
            "confidence": 0.7,
            "action": "replace",
            "reasons": [],
            "suggested_file1_columns": ["固定资产名称", "入账开始日期"],
            "suggested_file2_columns": ["资产编码", "资产描述", "资本化日期"],
            "suggestion_reason": "",
        }
        forbidden = {
            "file1": ["入账开始日期"],
            "file2": ["资本化日期"],
        }
        scrubbed_review, changed = sanitize_llm_match_review_against_forbidden(review, forbidden)
        self.assertTrue(changed)
        # After scrub: file1 -> [资产名称]=1 col; file2 -> [资产编码,资产描述]=2 cols
        # lengths unequal => wipe + keep.
        self.assertEqual(scrubbed_review["suggested_file1_columns"], [])
        self.assertEqual(scrubbed_review["suggested_file2_columns"], [])
        self.assertEqual(scrubbed_review["action"], "keep")
        self.assertTrue(any("已映射的业务字段" in r for r in scrubbed_review["reasons"]))

    def test_balanced_after_scrub_keeps_clean_suggestion(self):
        review = {
            "status": "warning",
            "confidence": 0.8,
            "action": "replace",
            "reasons": [],
            "suggested_file1_columns": ["资产编码", "入账开始日期"],
            "suggested_file2_columns": ["资产编码", "资本化日期"],
            "suggestion_reason": "",
        }
        forbidden = {
            "file1": ["入账开始日期"],
            "file2": ["资本化日期"],
        }
        scrubbed_review, changed = sanitize_llm_match_review_against_forbidden(review, forbidden)
        self.assertTrue(changed)
        self.assertEqual(scrubbed_review["suggested_file1_columns"], ["资产编码"])
        self.assertEqual(scrubbed_review["suggested_file2_columns"], ["资产编码"])
        self.assertEqual(scrubbed_review["action"], "replace")

    def test_no_forbidden_overlap_is_no_op(self):
        review = {
            "status": "warning",
            "confidence": 0.8,
            "action": "replace",
            "reasons": [],
            "suggested_file1_columns": ["资产编码"],
            "suggested_file2_columns": ["资产编码"],
            "suggestion_reason": "",
        }
        forbidden = {"file1": ["原值"], "file2": ["原值"]}
        scrubbed_review, changed = sanitize_llm_match_review_against_forbidden(review, forbidden)
        self.assertFalse(changed)
        self.assertEqual(scrubbed_review["suggested_file1_columns"], ["资产编码"])


if __name__ == "__main__":
    unittest.main()
