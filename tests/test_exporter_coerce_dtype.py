"""回归测试：_coerce_for_series_dtype 对数值列写入空串应转成 NaN 而非报错。

pandas 2.x 严格 dtype 校验下，把 '' 直接写进 float64 会抛 LossySetitemError。
这条 regression 复现用户在导出新增清单时遇到的崩溃。
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

import numpy as np
import pandas as pd

from exporter import Exporter


class CoerceForSeriesDtypeTests(unittest.TestCase):
    def test_empty_string_into_float_column_becomes_nan(self):
        s = pd.Series([1.0, 2.0, 3.0], dtype="float64")
        out = Exporter._coerce_for_series_dtype(s, "")
        self.assertTrue(np.isnan(out))

    def test_empty_string_into_int_column_becomes_nan(self):
        s = pd.Series([1, 2, 3], dtype="int64")
        out = Exporter._coerce_for_series_dtype(s, "")
        # numpy int 列接受 NaN 会被 pandas 自动放宽为 float；返回 nan 即可
        self.assertTrue(np.isnan(out))

    def test_empty_string_into_string_column_returns_pd_na(self):
        s = pd.Series(["a", "b", "c"], dtype="string")
        out = Exporter._coerce_for_series_dtype(s, "")
        # 字符串列对空串依然返回 ''（保留原行为）
        self.assertEqual(out, "")

    def test_none_into_float_column_becomes_nan(self):
        s = pd.Series([1.0, 2.0], dtype="float64")
        out = Exporter._coerce_for_series_dtype(s, None)
        self.assertTrue(np.isnan(out))

    def test_pd_na_into_float_column_becomes_nan(self):
        s = pd.Series([1.0, 2.0], dtype="float64")
        out = Exporter._coerce_for_series_dtype(s, pd.NA)
        self.assertTrue(np.isnan(out))

    def test_non_empty_value_into_float_column_passes_through(self):
        s = pd.Series([1.0, 2.0], dtype="float64")
        out = Exporter._coerce_for_series_dtype(s, 5.5)
        self.assertEqual(out, 5.5)

    def test_fill_display_fields_clears_float_column_without_error(self):
        """复现用户报错场景：副卡组的非首行需要把数值列清空。"""
        df = pd.DataFrame({
            "唯一识别码": ["A001", "A001", "A002", "A002", "A002"],
            "资产描述": ["x", "x", "y", "y", "y"],
            "原值增加": [100.0, 100.0, 200.0, 200.0, 200.0],
        })
        exporter = Exporter()
        out = exporter._fill_display_fields_by_duplicate_id(
            df, "唯一识别码", [], keep_first_only_cols=["原值增加"]
        )
        # 每个分组的首行保留原值，其余清空为 NaN
        self.assertEqual(out.loc[0, "原值增加"], 100.0)
        self.assertTrue(pd.isna(out.loc[1, "原值增加"]))
        self.assertEqual(out.loc[2, "原值增加"], 200.0)
        self.assertTrue(pd.isna(out.loc[3, "原值增加"]))
        self.assertTrue(pd.isna(out.loc[4, "原值增加"]))


if __name__ == "__main__":
    unittest.main()
