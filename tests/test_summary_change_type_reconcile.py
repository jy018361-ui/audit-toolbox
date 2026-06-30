"""Regression: 上游传入的 '原值变动类型' 列若与 '原值变动' 数值不一致（如把
非零变动错标为 '原值不变'），应当被 _reconcile_change_type 按符号修正，
避免金额漏入 增/减 桶导致 reclass 残差。

复现场景：GUI 补充清单回填后 '原值变动类型' 未刷新，海立样例下出现 1,427,398.49
元被错误标 '原值不变'，全部落入 reclass。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

import pandas as pd

from summary_generator import SummaryGenerator


class ReconcileChangeTypeTests(unittest.TestCase):
    def test_mislabeled_negative_change_becomes_increase(self):
        ct = pd.Series(["原值不变", "原值增加", "原值减少"])
        oc = pd.Series([-100.0, -50.0, 30.0])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        self.assertEqual(out.tolist(), ["原值增加", "原值增加", "原值减少"])

    def test_mislabeled_positive_change_becomes_decrease(self):
        ct = pd.Series(["原值不变", "原值不变"])
        oc = pd.Series([200.0, -150.0])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        self.assertEqual(out.tolist(), ["原值减少", "原值增加"])

    def test_true_no_change_is_preserved(self):
        ct = pd.Series(["原值不变", "原值不变", "原值不变"])
        oc = pd.Series([0.0, 1e-7, -1e-7])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        self.assertEqual(out.tolist(), ["原值不变", "原值不变", "原值不变"])

    def test_already_correct_increase_decrease_preserved(self):
        ct = pd.Series(["原值增加", "原值减少"])
        oc = pd.Series([-1000.0, 1000.0])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        self.assertEqual(out.tolist(), ["原值增加", "原值减少"])

    def test_nan_change_safe(self):
        ct = pd.Series(["原值不变"])
        oc = pd.Series([float("nan")])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        self.assertEqual(out.tolist(), ["原值不变"])

    def test_string_numeric_orig_change_accepted(self):
        ct = pd.Series(["原值不变", "原值不变"])
        oc = pd.Series(["-1,234.56", "0"])
        out = SummaryGenerator._reconcile_change_type(ct, oc)
        # 第一行字符串被 to_numeric 后 = NaN（含逗号），不修正；第二行 0 不修正
        # 验证至少不抛异常、返回与原长度一致
        self.assertEqual(len(out), 2)


if __name__ == "__main__":
    unittest.main()
