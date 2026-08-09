import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
FA_LIST_ROOT = ROOT / "tools" / "fa_list"
if str(FA_LIST_ROOT) not in sys.path:
    sys.path.insert(0, str(FA_LIST_ROOT))

from tools.fa_list.gui.main_window import MainWindow


class RepeatSupplementRunTests(unittest.TestCase):
    @staticmethod
    def _main_data(asset_id):
        return pd.DataFrame(
            {
                "资产编号_文件1": [asset_id],
                "资产编号_文件2": [asset_id],
                "资产类别_文件2": ["机器设备"],
                "原值变动类型": ["原值增加"],
                "原值变动": [-100.0],
            }
        )

    @staticmethod
    def _supplement_data(asset_id, method):
        return pd.DataFrame(
            {
                "资产编号": [asset_id],
                "新增方式": [method],
            }
        )

    @staticmethod
    def _config():
        return {
            "match_column1": ["资产编号"],
            "match_column2": [],
            "addition_method_col1": "新增方式",
            "addition_date_col1": None,
        }

    def test_same_window_two_complete_runs_use_second_addition_method(self):
        """模拟窗口不关闭，连续完成两轮主清单+补充清单回填。"""
        window = object.__new__(MainWindow)
        window.match_columns1 = ["资产编号"]
        window.match_columns2 = ["资产编号"]
        window.field_mapping_config = {"category_col2": "资产类别"}
        window.supp_file_handler = SimpleNamespace(
            file1_df=self._supplement_data("FA-001", "外购"),
            file2_df=None,
        )
        window.merged_df = self._main_data("FA-001")
        window.unmatched_add_df = None
        window.unmatched_disp_df = None

        invalidated_steps = []
        window._invalidate_step_widget = invalidated_steps.append
        window.update_status = lambda _message: None
        window._prompt_and_export_all_columns = lambda: None

        window._on_supplement_configured(self._config())
        self.assertEqual(
            window.merged_df.loc[0, "新增方式_辅助_文件2"],
            "外购",
        )

        # 不关闭窗口，换成第二轮主清单和补充清单。
        window.merged_df = self._main_data("FA-002")
        window.field_mapping_config = {"category_col2": "资产类别"}
        window.supp_file_handler.file1_df = self._supplement_data("FA-002", "在建工程转固")

        window._on_supplement_configured(self._config())
        self.assertEqual(
            window.merged_df.loc[0, "新增方式_辅助_文件2"],
            "在建工程转固",
        )
        self.assertEqual(invalidated_steps, [1, 1])

    def test_reapplying_supplement_removes_previous_auxiliary_result(self):
        """即使直接重复补充步骤，也不得继续引用上一轮的辅助映射。"""
        window = object.__new__(MainWindow)
        window.match_columns1 = ["资产编号"]
        window.match_columns2 = ["资产编号"]
        window.field_mapping_config = {
            "category_col2": "资产类别",
            "addition_method_col2": "新增方式_辅助",
        }
        window.merged_df = self._main_data("FA-002")
        window.merged_df["新增方式_辅助_文件2"] = "上一轮旧值"
        window.supp_file_handler = SimpleNamespace(
            file1_df=self._supplement_data("FA-002", "融资租赁"),
            file2_df=None,
        )
        window.unmatched_add_df = None
        window.unmatched_disp_df = None

        window._apply_supplement_data(self._config())

        self.assertEqual(
            window.merged_df.loc[0, "新增方式_辅助_文件2"],
            "融资租赁",
        )
        self.assertEqual(
            window.field_mapping_config["addition_method_col2"],
            "新增方式_辅助",
        )


if __name__ == "__main__":
    unittest.main()
