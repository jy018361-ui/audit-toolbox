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

from exporter import Exporter  # noqa: E402


class ExporterFile2TemplateCalculatedFieldsTests(unittest.TestCase):
    def test_file2_template_added_row_gets_calculated_fields(self):
        exporter = Exporter()
        merged_df = pd.DataFrame(
            {
                "匹配列": ["K1"],
                "数据来源": ["两文件都有"],
                "原值_文件1": [1000.0],
                "原值_文件2": [1000.0],
                "累计折旧_文件1": [100.0],
                "累计折旧_文件2": [100.0],
                "原值变动": [0.0],
                "原值变动类型": ["原值不变"],
                "累计折旧变动": [0.0],
                "累计折旧变动类型": ["累计折旧不变"],
            }
        )
        source_file2_df = pd.DataFrame(
            {
                "资产编码": ["K1", "K1"],
                "原值": [1000.0, 250.0],
                "累计折旧": [100.0, 25.0],
            }
        )
        summary_config = {
            "source_file2_df": source_file2_df,
            "source_match_cols2_raw": ["资产编码"],
            "source_original_value_col2_raw": "原值",
            "source_depreciation_col2_raw": "累计折旧",
            "original_value_col1": "原值_文件1",
            "original_value_col2": "原值_文件2",
            "depreciation_col1": "累计折旧_文件1",
            "depreciation_col2": "累计折旧_文件2",
        }

        out, _fa, _add, _disp = exporter._enhance_duplicate_display(
            merged_df,
            fa_df=None,
            add_df=None,
            disp_df=None,
            summary_config=summary_config,
        )

        self.assertEqual(len(out), 2)
        added = out.iloc[1]
        self.assertEqual(added["数据来源"], "仅文件2")
        self.assertEqual(added["原值变动"], -250.0)
        self.assertEqual(added["原值变动类型"], "原值增加")
        self.assertEqual(added["累计折旧变动"], -25.0)
        self.assertEqual(added["累计折旧变动类型"], "累计折旧增加")


if __name__ == "__main__":
    unittest.main()
