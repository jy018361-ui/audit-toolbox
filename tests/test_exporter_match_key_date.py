"""Regression: _format_match_component 必须把日期格式化为 'YYYY-MM-DD'，
与 merge_engine 的匹配键格式保持一致。否则 GUI 导出会把每张 file2 卡片
追加一份空行（数据来源=NaN），把 9.58M 期末原值 leak 到 reclass 残差。
"""
import sys
import unittest
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

import pandas as pd

from exporter import Exporter


class FormatMatchComponentDateTests(unittest.TestCase):
    def test_pd_timestamp_formats_as_iso_date(self):
        # 2025-06-12 00:00:00 应当变成 '2025-06-12'，而不是 '2025-06-12 00:00:00'
        ts = pd.Timestamp("2025-06-12")
        self.assertEqual(Exporter._format_match_component(ts), "2025-06-12")

    def test_datetime_with_time_truncates_to_date(self):
        dt = datetime(2025, 6, 12, 8, 30, 15)
        self.assertEqual(Exporter._format_match_component(dt), "2025-06-12")

    def test_date_object_formats_as_iso(self):
        d = date(2025, 6, 12)
        self.assertEqual(Exporter._format_match_component(d), "2025-06-12")

    def test_string_passthrough(self):
        self.assertEqual(Exporter._format_match_component("1100090"), "1100090")
        self.assertEqual(Exporter._format_match_component("消声室"), "消声室")

    def test_float_integer_passthrough(self):
        self.assertEqual(Exporter._format_match_component(1100090.0), "1100090")

    def test_string_datetime_formats_as_iso_date(self):
        self.assertEqual(Exporter._format_match_component("2025-06-12 00:00:00"), "2025-06-12")
        self.assertEqual(Exporter._format_match_component("2025/6/12 8:30:15"), "2025-06-12")

    def test_existing_composite_key_formats_each_component(self):
        key = Exporter._format_match_key_value("1100090.0 | 消声室 | 2025-06-12 00:00:00")
        self.assertEqual(key, "1100090 | 消声室 | 2025-06-12")

    def test_nan_returns_empty(self):
        self.assertEqual(Exporter._format_match_component(float("nan")), "")
        self.assertEqual(Exporter._format_match_component(None), "")

    def test_build_match_key_from_row_with_date(self):
        # 复现海立场景：1100090 | 消声室 | 2025-06-12
        row = {
            "资产编码": 1100090,
            "资产描述": "消声室",
            "资本化日期": pd.Timestamp("2025-06-12"),
        }
        exporter = Exporter()
        key = exporter._build_match_key_from_row(row, ["资产编码", "资产描述", "资本化日期"])
        self.assertEqual(key, "1100090 | 消声室 | 2025-06-12")
        # 反例：旧实现会产出 '... | 2025-06-12 00:00:00'，与 merge_engine 不一致
        self.assertNotIn("00:00:00", key)

    def test_build_match_key_series_with_existing_composite_key(self):
        exporter = Exporter()
        df = pd.DataFrame({"匹配列": ["1100090.0 | 消声室 | 2025-06-12 00:00:00"]})
        key = exporter._build_match_key_series_from_cols(df, ["匹配列"]).iloc[0]
        self.assertEqual(key, "1100090 | 消声室 | 2025-06-12")

    def test_template_map_and_expand_rows_share_key_format(self):
        exporter = Exporter()
        source = pd.DataFrame(
            {
                "资产编码": [1100090.0],
                "资产描述": ["消声室"],
                "资本化日期": ["2025-06-12 00:00:00"],
                "原值": [100],
            }
        )
        template_map = exporter._build_template_map_from_source(
            source,
            ["资产编码", "资产描述", "资本化日期"],
            {"原值": "原值"},
        )
        self.assertIn("1100090 | 消声室 | 2025-06-12", template_map)

        existing = pd.DataFrame({"匹配列": ["1100090 | 消声室 | 2025-06-12"], "原值": [""]})
        expanded = exporter._expand_rows_for_template_cardinality(existing, "匹配列", template_map)
        self.assertEqual(len(expanded), 1)


if __name__ == "__main__":
    unittest.main()
