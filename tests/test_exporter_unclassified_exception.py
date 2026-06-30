import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

from exporter import Exporter


class UnclassifiedEndRowsTests(unittest.TestCase):
    def test_end_amount_with_blank_source_goes_to_exception_backup(self):
        exporter = Exporter()
        df = pd.DataFrame(
            {
                "数据来源": ["仅文件2", None, ""],
                "资产类型描述_期末": ["机器设备", "机器设备", "办公设备"],
                "资产编码_期末": ["A1", "A2", "A3"],
                "资产描述_期末": ["正常新增", "异常新增", "零金额空来源"],
                "原值(期末)_期末": [100.0, 250.0, 0.0],
            }
        )

        cleaned = exporter._remove_unclassified_end_rows(
            df,
            {
                "original_value_col2": "原值(期末)_期末",
                "category_col2": "资产类型描述_期末",
                "match_col2": "资产编码_期末",
                "field_mapping": {"name_col2": "资产描述_期末"},
            },
        )

        self.assertEqual(len(cleaned), 2)
        self.assertEqual(len(exporter._exception_backup), 1)
        row = exporter._exception_backup[0]
        self.assertEqual(row["资产编码"], "A2")
        self.assertEqual(row["期末原值"], 250.0)
        self.assertIn("期末原值有金额", row["异常类型"])


if __name__ == "__main__":
    unittest.main()
