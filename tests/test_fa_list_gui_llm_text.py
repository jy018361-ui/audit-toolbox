import sys
import unittest
from pathlib import Path

import pandas as pd
import tkinter as tk


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "fa_list"))
sys.path.insert(0, str(ROOT))

from tools.fa_list.gui.file_and_match_config import FileAndMatchConfig, build_fa_mapping_review_dialog_text, build_supplement_match_key_review_decision
from tools.fa_list.gui.main_window import MainWindow


class FAListLLMDialogTextTests(unittest.TestCase):
    def test_field_review_text_is_concise_and_actionable(self):
        text = build_fa_mapping_review_dialog_text(
            {
                "label": "累计折旧",
                "current_mapping": {"file2": "本月折旧"},
                "suggested_mapping": {"file2": "累计折旧"},
                "apply_mapping": {"file2": "累计折旧"},
                "can_apply": True,
                "reason": "当前列是本月折旧，不是累计数",
            }
        )

        self.assertIn("文件2 + [累计折旧]，建议由 本月折旧 调整为 累计折旧", text)
        self.assertIn("原因系：当前列是本月折旧，不是累计数", text)
        self.assertNotIn("当前选了什么", text)
        self.assertNotIn("建议改成什么", text)

    def test_normal_mode_llm_roles_exclude_supplement_fields(self):
        widget = object.__new__(FileAndMatchConfig)
        widget.mode = "normal"

        roles = {item["role"] for item in widget._llm_role_definitions()}

        self.assertIn("category", roles)
        self.assertIn("current_year_dep", roles)
        self.assertIn("addition_method", roles)
        self.assertIn("addition_date", roles)
        self.assertNotIn("disposal_method", roles)
        self.assertNotIn("disposal_date", roles)

    def test_supplement_mode_llm_roles_exclude_normal_fa_fields(self):
        widget = object.__new__(FileAndMatchConfig)
        widget.mode = "supplement"

        roles = {item["role"] for item in widget._llm_role_definitions()}

        self.assertIn("addition_method", roles)
        self.assertIn("disposal_method", roles)
        self.assertNotIn("category", roles)
        self.assertNotIn("current_year_dep", roles)

    def test_normal_mode_optional_addition_rows_show_only_after_mapping(self):
        class RowStub:
            def __init__(self):
                self.visible = True

            def pack(self, *args, **kwargs):
                self.visible = True

            def pack_forget(self):
                self.visible = False

        widget = object.__new__(FileAndMatchConfig)
        root = tk.Tcl()
        widget.mode = "normal"
        widget.addition_method_col1_var = tk.StringVar(master=root, value="")
        widget.addition_method_col2_var = tk.StringVar(master=root, value="")
        widget.addition_date_col1_var = tk.StringVar(master=root, value="")
        widget.addition_date_col2_var = tk.StringVar(master=root, value="")
        method_row = RowStub()
        date_row = RowStub()
        widget.mapping_row_frames = {
            "addition_method": method_row,
            "addition_date": date_row,
        }
        widget.mapping_row_controls = {
            "addition_method": {},
            "addition_date": {},
        }
        widget.depreciation_param_frame = object()

        widget._update_optional_addition_rows_visibility()

        self.assertFalse(method_row.visible)
        self.assertFalse(date_row.visible)

        widget.addition_date_col2_var.set("新增日期")
        widget._update_optional_addition_rows_visibility()

        self.assertTrue(method_row.visible)
        self.assertTrue(date_row.visible)

    def test_addition_date_falls_back_to_entry_date_when_method_exists(self):
        widget = object.__new__(FileAndMatchConfig)
        root = tk.Tcl()
        widget.mode = "normal"
        widget.addition_method_col1_var = tk.StringVar(master=root, value="资产来源")
        widget.addition_date_col1_var = tk.StringVar(master=root, value="")
        widget.date_col1_var = tk.StringVar(master=root, value="资本化日期")
        widget.addition_method_col2_var = tk.StringVar(master=root, value="")
        widget.addition_date_col2_var = tk.StringVar(master=root, value="")
        widget.date_col2_var = tk.StringVar(master=root, value="")
        widget.addition_date_col1_combo = None
        widget.addition_date_col2_combo = None

        changed = widget._fallback_addition_date_to_entry_date(["资产来源", "资本化日期"], [])

        self.assertTrue(changed)
        self.assertEqual(widget.addition_date_col1_var.get(), "资本化日期")

    def test_addition_date_does_not_fallback_without_method(self):
        widget = object.__new__(FileAndMatchConfig)
        root = tk.Tcl()
        widget.mode = "normal"
        widget.addition_method_col1_var = tk.StringVar(master=root, value="")
        widget.addition_date_col1_var = tk.StringVar(master=root, value="")
        widget.date_col1_var = tk.StringVar(master=root, value="资本化日期")
        widget.addition_method_col2_var = tk.StringVar(master=root, value="")
        widget.addition_date_col2_var = tk.StringVar(master=root, value="")
        widget.date_col2_var = tk.StringVar(master=root, value="")
        widget.addition_date_col1_combo = None
        widget.addition_date_col2_combo = None

        changed = widget._fallback_addition_date_to_entry_date(["资本化日期"], [])

        self.assertFalse(changed)
        self.assertEqual(widget.addition_date_col1_var.get(), "")

    def test_fill_summary_can_distinguish_file_sides(self):
        widget = object.__new__(FileAndMatchConfig)
        widget.mode = "supplement"

        labels = [
            widget._llm_side_role_display_label("addition_method", "file1"),
            widget._llm_side_role_display_label("addition_method", "file2"),
        ]

        self.assertEqual("文件1新增方式、文件2新增方式", widget._summarize_labels(labels))

    def test_supplement_id_columns_follow_first_step_id_shape(self):
        widget = object.__new__(FileAndMatchConfig)
        widget.mode = "supplement"
        df = pd.DataFrame(
            {
                "流水号": ["1", "2"],
                "编码": ["TMDN001", "TMDN002"],
                "名称": ["电脑A", "电脑B"],
            }
        )

        picked_code = widget._pick_supplement_column_for_reference(
            "资产编码", list(df.columns), df, set()
        )
        picked_name = widget._pick_supplement_column_for_reference(
            "固定资产名称", list(df.columns), df, {picked_code}
        )

        self.assertEqual("编码", picked_code)
        self.assertEqual("名称", picked_name)

    def test_auto_enter_addition_supplement_only_for_file2_only_rows(self):
        window = object.__new__(MainWindow)
        window.file2_display_name = "期末卡片"
        window.addition_supplement_prefill = {
            "source_side": 2,
            "addition_method_col": "资产来源",
            "addition_date_col": "资本化日期",
        }
        window.merged_df = pd.DataFrame({"数据来源": ["两文件都有", "仅期末卡片"]})

        self.assertTrue(window._should_auto_enter_addition_supplement())

        window.merged_df = pd.DataFrame({"数据来源": ["两文件都有", "仅文件1"]})
        self.assertFalse(window._should_auto_enter_addition_supplement())

        window.addition_supplement_prefill = {
            "source_side": 1,
            "addition_method_col": "资产来源",
            "addition_date_col": "资本化日期",
        }
        window.merged_df = pd.DataFrame({"数据来源": ["两文件都有", "仅期末卡片"]})
        self.assertFalse(window._should_auto_enter_addition_supplement())

    def test_supplement_match_review_can_apply_one_sided_id(self):
        decision = build_supplement_match_key_review_decision(
            {
                "status": "warning",
                "confidence": 0.9,
                "action": "replace",
                "reasons": ["缺少名称项"],
                "suggested_file2_columns": ["编码", "名称"],
            },
            cols1=[],
            cols2=["编码", "名称"],
            current1=[],
            current2=["编码"],
        )

        self.assertTrue(decision["show"])
        self.assertTrue(decision["can_apply"])
        self.assertEqual(decision["suggested_file2_columns"], ["编码", "名称"])

    def test_replacing_name_mapping_refreshes_match_id_name_part(self):
        widget = object.__new__(FileAndMatchConfig)
        root = tk.Tcl()
        widget.mode = "normal"
        widget.name_col1_var = tk.StringVar(master=root, value="固定资产名称")
        widget.name_col2_var = tk.StringVar(master=root, value="资产描述")
        widget.category_col1_var = tk.StringVar(master=root, value="")
        widget.category_col2_var = tk.StringVar(master=root, value="")
        widget.match_columns1 = ["资产编码", "固定资产名称"]
        widget.match_columns2 = ["资产描述.1", "资产描述"]
        widget.name_col1_combo = None
        widget.name_col2_combo = None
        widget.mapping_row_controls = {}
        widget._update_selected_match_columns = lambda file_index: None
        widget._llm_role_targets = lambda include_disallowed=False: {
            "name": {
                1: {"var": widget.name_col1_var, "combo": None},
                2: {"var": widget.name_col2_var, "combo": None},
            }
        }
        widget.match_col1_listbox = type(
            "ListboxStub",
            (),
            {"selection_clear": lambda *a, **k: None, "selection_set": lambda *a, **k: None},
        )()
        widget.match_col2_listbox = type(
            "ListboxStub",
            (),
            {"selection_clear": lambda *a, **k: None, "selection_set": lambda *a, **k: None},
        )()

        changed = widget._replace_llm_role(
            "name",
            "file2",
            "资产类型描述",
            ["资产编码", "固定资产名称"],
            ["资产描述.1", "资产描述", "资产类型描述"],
        )

        self.assertTrue(changed)
        self.assertEqual(widget.name_col2_var.get(), "资产类型描述")
        self.assertEqual(widget.match_columns2, ["资产描述.1", "资产类型描述"])


    def test_step1_addition_fields_build_step2_prefill_from_file2_first(self):
        main = object.__new__(MainWindow)
        main.match_columns1 = ["asset_code", "asset_name"]
        main.match_columns2 = ["code", "name"]
        main.file_handler = type(
            "HandlerStub",
            (),
            {
                "file1_path": "old.xlsx",
                "file2_path": "new.xlsx",
                "file1_sheet": "Old",
                "file2_sheet": "New",
            },
        )()

        prefill = main._build_addition_supplement_prefill(
            {
                "file1_path": "old.xlsx",
                "file2_path": "new.xlsx",
                "file1_sheet": "Old",
                "file2_sheet": "New",
                "addition_method_col1": "old_method",
                "addition_method_col2": "new_method",
                "addition_date_col2": "new_date",
            }
        )

        self.assertEqual(prefill["path"], "new.xlsx")
        self.assertEqual(prefill["sheet"], "New")
        self.assertEqual(prefill["match_columns"], ["code", "name"])
        self.assertEqual(prefill["addition_method_col"], "new_method")
        self.assertEqual(prefill["addition_date_col"], "new_date")

    def test_step1_without_addition_fields_does_not_prefill_step2(self):
        main = object.__new__(MainWindow)
        main.match_columns1 = ["asset_code", "asset_name"]
        main.match_columns2 = ["code", "name"]
        main.file_handler = type(
            "HandlerStub",
            (),
            {"file1_path": "old.xlsx", "file2_path": "new.xlsx", "file1_sheet": "Old", "file2_sheet": "New"},
        )()

        self.assertIsNone(main._build_addition_supplement_prefill({"file1_path": "old.xlsx"}))


if __name__ == "__main__":
    unittest.main()
