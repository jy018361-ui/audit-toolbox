import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


import launcher.llm_client as llm_client


class KanzhangMappingCheckTests(unittest.TestCase):
    def _patch_chat(self, response, captured):
        original = llm_client._chat_completion

        def fake_chat(settings, messages, **kwargs):
            captured["payload"] = llm_client.json.loads(messages[1]["content"])
            captured["task_name"] = kwargs.get("task_name")
            return llm_client.json.dumps(response, ensure_ascii=False)

        llm_client._chat_completion = fake_chat
        self.addCleanup(lambda: setattr(llm_client, "_chat_completion", original))

    def test_check_can_fill_text_summary_column(self):
        captured = {}
        self._patch_chat(
            {
                "fills": [
                    {
                        "role": "role_summary",
                        "suggested_column": "文本",
                        "confidence": 0.88,
                        "reason": "文本列样例为凭证说明，更符合摘要字段。",
                    }
                ],
                "reviews": [],
            },
            captured,
        )

        result = llm_client.check_kanzhang_field_mappings(
            {"api_key": "test"},
            role_definitions=[
                {"role": "role_id", "label": "唯一识别码"},
                {"role": "role_acc", "label": "科目名称"},
                {"role": "role_summary", "label": "凭证摘要"},
            ],
            files=[
                {
                    "file_side": "main",
                    "headers": ["凭证号", "科目名称", "文本"],
                    "samples": {
                        "凭证号": ["10001", "10002"],
                        "科目名称": ["银行存款", "主营业务收入"],
                        "文本": ["收到客户货款", "支付办公室租金", "计提本月工资"],
                    },
                }
            ],
            current_mapping={"role_id": ["凭证号"], "role_acc": ["科目名称"], "role_summary": []},
        )

        self.assertEqual(captured["task_name"], "kanzhang_mapping_check")
        payload = captured["payload"]
        self.assertIn({"role": "role_summary", "label": "凭证摘要", "file_side": "main"}, payload["missing_roles"])
        self.assertEqual(payload["files"][0]["samples"]["文本"][:3], ["收到客户货款", "支付办公室租金", "计提本月工资"])
        self.assertEqual(len(result.fills), 1)
        self.assertEqual(result.fills[0].role, "role_summary")
        self.assertEqual(result.fills[0].suggested_column, "文本")

    def test_check_returns_review_replace_suggestion(self):
        captured = {}
        self._patch_chat(
            {
                "fills": [],
                "reviews": [
                    {
                        "role": "role_summary",
                        "current_column": "科目名称",
                        "suggested_column": "文本",
                        "confidence": 0.91,
                        "reason": "当前列是会计科目；文本列为凭证业务说明，更符合摘要。",
                    }
                ],
            },
            captured,
        )

        result = llm_client.check_kanzhang_field_mappings(
            {"api_key": "test"},
            role_definitions=[
                {"role": "role_acc", "label": "科目名称"},
                {"role": "role_summary", "label": "凭证摘要"},
            ],
            files=[
                {
                    "file_side": "main",
                    "headers": ["科目名称", "文本"],
                    "samples": {"科目名称": ["银行存款"], "文本": ["收到客户货款"]},
                }
            ],
            current_mapping={"role_acc": ["科目名称"], "role_summary": ["科目名称"]},
        )

        self.assertEqual(len(result.reviews), 1)
        review = result.reviews[0]
        self.assertEqual(review.role, "role_summary")
        self.assertEqual(review.current_mapping, {"main": "科目名称"})
        self.assertEqual(review.suggested_mapping, {"main": "文本"})
        self.assertIn("会计科目", review.reason)

    def test_scheme_a_filters_borrow_credit_fills(self):
        captured = {}
        self._patch_chat(
            {
                "scheme": "A",
                "scheme_reason": "只有金额列和方向列，应按方案A处理。",
                "fills": [
                    {"role": "role_amt", "suggested_column": "金额", "confidence": 0.9, "reason": "金额列为发生额。"},
                    {"role": "role_dir", "suggested_column": "方向", "confidence": 0.86, "reason": "方向列区分借贷。"},
                    {"role": "role_dr", "suggested_column": "金额", "confidence": 0.82, "reason": "不应采纳。"},
                    {"role": "role_cr", "suggested_column": "金额", "confidence": 0.82, "reason": "不应采纳。"},
                ],
                "reviews": [],
            },
            captured,
        )

        result = llm_client.check_kanzhang_field_mappings(
            {"api_key": "test"},
            role_definitions=[
                {"role": "role_amt", "label": "方案A-金额列"},
                {"role": "role_dir", "label": "方案A-方向列"},
                {"role": "role_dr", "label": "方案B-借方金额"},
                {"role": "role_cr", "label": "方案B-贷方金额"},
            ],
            files=[
                {
                    "file_side": "main",
                    "headers": ["方向", "金额"],
                    "samples": {"方向": ["借", "贷"], "金额": ["100.00", "100.00"]},
                }
            ],
            current_mapping={"role_amt": [], "role_dir": [], "role_dr": [], "role_cr": []},
        )

        self.assertEqual(result.scheme, "A")
        self.assertEqual({item.role for item in result.fills}, {"role_amt", "role_dir"})

    def test_scheme_b_same_column_is_not_accepted(self):
        captured = {}
        self._patch_chat(
            {
                "scheme": "B",
                "scheme_reason": "模型误判为借贷分列。",
                "fills": [
                    {"role": "role_dr", "suggested_column": "金额", "confidence": 0.9, "reason": "借方金额。"},
                    {"role": "role_cr", "suggested_column": "金额", "confidence": 0.9, "reason": "贷方金额。"},
                ],
                "reviews": [],
            },
            captured,
        )

        result = llm_client.check_kanzhang_field_mappings(
            {"api_key": "test"},
            role_definitions=[
                {"role": "role_dr", "label": "方案B-借方金额"},
                {"role": "role_cr", "label": "方案B-贷方金额"},
                {"role": "role_amt", "label": "方案A-金额列"},
            ],
            files=[
                {
                    "file_side": "main",
                    "headers": ["方向", "金额"],
                    "samples": {"方向": ["借", "贷"], "金额": ["100.00", "100.00"]},
                }
            ],
            current_mapping={"role_dr": [], "role_cr": [], "role_amt": []},
        )

        self.assertEqual(result.scheme, "A")
        self.assertEqual(result.fills, [])
        self.assertIn("同一列", result.scheme_reason)


if __name__ == "__main__":
    unittest.main()
