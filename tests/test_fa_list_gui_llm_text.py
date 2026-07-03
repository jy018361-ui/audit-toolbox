import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import tkinter as tk


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "fa_list"))
sys.path.insert(0, str(ROOT))

from tools.fa_list.gui.file_and_match_config import FileAndMatchConfig, build_fa_mapping_review_dialog_text, build_supplement_match_key_review_decision, _sanitize_match_review_reasons
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

        self.assertIn("当前选择", text)
        self.assertIn("文件2：本月折旧", text)
        self.assertIn("复核发现", text)
        self.assertIn("建议选择", text)
        self.assertIn("文件2：累计折旧", text)
        self.assertNotIn("原因系", text)
        self.assertNotIn("当前列是本月折旧", text)

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

        self.assertFalse(method_row.visible)
        self.assertFalse(date_row.visible)

        widget.addition_method_col2_var.set("新增方式")
        widget._update_optional_addition_rows_visibility()

        self.assertTrue(method_row.visible)
        self.assertTrue(date_row.visible)

    def test_normal_mode_addition_date_falls_back_only_for_file2(self):
        widget = object.__new__(FileAndMatchConfig)
        root = tk.Tcl()
        widget.mode = "normal"
        widget.addition_method_col1_var = tk.StringVar(master=root, value="资产来源")
        widget.addition_date_col1_var = tk.StringVar(master=root, value="")
        widget.date_col1_var = tk.StringVar(master=root, value="资本化日期")
        widget.addition_method_col2_var = tk.StringVar(master=root, value="新增方式")
        widget.addition_date_col2_var = tk.StringVar(master=root, value="")
        widget.date_col2_var = tk.StringVar(master=root, value="入账日期")
        widget.addition_date_col1_combo = None
        widget.addition_date_col2_combo = None

        changed = widget._fallback_addition_date_to_entry_date(
            ["资产来源", "资本化日期"],
            ["新增方式", "入账日期"],
        )

        self.assertTrue(changed)
        self.assertEqual(widget.addition_date_col1_var.get(), "")
        self.assertEqual(widget.addition_date_col2_var.get(), "入账日期")

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

    def _make_widget_with_mapping_vars(self, root):
        widget = object.__new__(FileAndMatchConfig)
        widget.mode = "normal"
        for name in (
            "original_value_col1_var", "original_value_col2_var",
            "depreciation_col1_var", "depreciation_col2_var",
            "category_col1_var", "category_col2_var",
            "name_col1_var", "name_col2_var",
            "date_col1_var", "date_col2_var",
            "life_col1_var", "life_col2_var",
            "residual_col1_var", "residual_col2_var",
            "current_year_dep_col1_var", "current_year_dep_col2_var",
            "addition_method_col1_var", "addition_method_col2_var",
            "addition_date_col1_var", "addition_date_col2_var",
            "disposal_method_col1_var", "disposal_method_col2_var",
            "disposal_date_col1_var", "disposal_date_col2_var",
            "disposal_orig_col1_var", "disposal_orig_col2_var",
            "disposal_dep_col1_var", "disposal_dep_col2_var",
        ):
            setattr(widget, name, tk.StringVar(master=root, value=""))
        for name in (
            "orig_col1_combo", "orig_col2_combo", "dep_col1_combo", "dep_col2_combo",
            "category_col1_combo", "category_col2_combo", "name_col1_combo", "name_col2_combo",
            "date_col1_combo", "date_col2_combo", "life_col1_combo", "life_col2_combo",
            "residual_col1_combo", "residual_col2_combo", "current_year_dep_col1_combo", "current_year_dep_col2_combo",
            "addition_method_col1_combo", "addition_method_col2_combo", "addition_date_col1_combo", "addition_date_col2_combo",
            "disposal_method_col1_combo", "disposal_method_col2_combo", "disposal_date_col1_combo", "disposal_date_col2_combo",
            "disposal_orig_col1_combo", "disposal_orig_col2_combo", "disposal_dep_col1_combo", "disposal_dep_col2_combo",
        ):
            setattr(widget, name, None)
        return widget

    def test_normal_mode_llm_targets_and_current_mapping_exclude_file1_addition_fields(self):
        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        widget.match_columns1 = ["asset_code"]
        widget.match_columns2 = ["card_code"]
        widget.addition_method_col1_var.set("old_method")
        widget.addition_date_col1_var.set("old_date")
        widget.addition_method_col2_var.set("change_type")
        widget.addition_date_col2_var.set("change_date")

        targets = widget._llm_role_targets()
        current = widget._current_llm_mapping()

        self.assertEqual([2], sorted(targets["addition_method"].keys()))
        self.assertEqual([2], sorted(targets["addition_date"].keys()))
        self.assertNotIn("file1", current["addition_method"])
        self.assertNotIn("file1", current["addition_date"])
        self.assertEqual("change_type", current["addition_method"]["file2"])
        self.assertEqual("change_date", current["addition_date"]["file2"])

    def test_normal_mode_addition_date_fallback_ignores_file1_even_when_method_exists(self):
        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        widget.addition_method_col1_var.set("old_method")
        widget.date_col1_var.set("old_entry_date")
        widget.addition_method_col2_var.set("new_method")
        widget.date_col2_var.set("new_entry_date")

        changed = widget._fallback_addition_date_to_entry_date(["old_method", "old_entry_date"], ["new_method", "new_entry_date"])

        self.assertTrue(changed)
        self.assertEqual("", widget.addition_date_col1_var.get())
        self.assertEqual("new_entry_date", widget.addition_date_col2_var.get())

    def test_normal_mode_file1_addition_controls_disabled_file2_controls_enabled(self):
        class RowStub:
            def __init__(self):
                self.visible = False
            def pack(self, *args, **kwargs):
                self.visible = True
            def pack_forget(self):
                self.visible = False

        class ComboStub:
            def __init__(self):
                self.value = None
                self.state = None
            def set(self, value):
                self.value = value
            def configure(self, **kwargs):
                if "state" in kwargs:
                    self.state = kwargs["state"]

        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        method_row = RowStub()
        date_row = RowStub()
        method_combo1 = ComboStub()
        method_combo2 = ComboStub()
        date_combo1 = ComboStub()
        date_combo2 = ComboStub()
        widget.mapping_row_frames = {"addition_method": method_row, "addition_date": date_row}
        widget.mapping_row_controls = {
            "addition_method": {"combo1": method_combo1, "combo2": method_combo2},
            "addition_date": {"combo1": date_combo1, "combo2": date_combo2},
        }
        widget.depreciation_param_frame = object()
        widget.addition_method_col1_var.set("old_method")
        widget.addition_method_col2_var.set("change_type")

        widget._update_optional_addition_rows_visibility()

        self.assertTrue(method_row.visible)
        self.assertTrue(date_row.visible)
        self.assertEqual("", widget.addition_method_col1_var.get())
        self.assertEqual("disabled", method_combo1.state)
        self.assertEqual("disabled", date_combo1.state)
        self.assertEqual("readonly", method_combo2.state)
        self.assertEqual("readonly", date_combo2.state)

    def test_normal_mode_file2_change_method_is_auto_mapped_as_addition_method(self):
        class ComboStub:
            def __init__(self):
                self.values = []
                self.current_index = None
                self.value = ""
                self.state = None
            def __setitem__(self, key, value):
                if key == "values":
                    self.values = list(value)
            def current(self, index):
                self.current_index = index
            def set(self, value):
                self.value = value
            def configure(self, **kwargs):
                if "state" in kwargs:
                    self.state = kwargs["state"]

        class ListboxStub:
            def __init__(self):
                self.items = []
            def delete(self, *args):
                self.items = []
            def insert(self, index, value):
                self.items.append(value)
            def selection_clear(self, *args):
                pass
            def selection_set(self, *args):
                pass

        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        combo_names = [
            "orig_col1_combo", "orig_col2_combo", "dep_col1_combo", "dep_col2_combo",
            "category_col1_combo", "category_col2_combo", "name_col1_combo", "name_col2_combo",
            "date_col1_combo", "date_col2_combo", "life_col1_combo", "life_col2_combo",
            "residual_col1_combo", "residual_col2_combo", "current_year_dep_col1_combo", "current_year_dep_col2_combo",
            "addition_method_col1_combo", "addition_method_col2_combo", "addition_date_col1_combo", "addition_date_col2_combo",
            "disposal_method_col1_combo", "disposal_method_col2_combo", "disposal_date_col1_combo", "disposal_date_col2_combo",
            "disposal_orig_col1_combo", "disposal_orig_col2_combo", "disposal_dep_col1_combo", "disposal_dep_col2_combo",
        ]
        for name in combo_names:
            setattr(widget, name, ComboStub())
        widget.match_col1_listbox = ListboxStub()
        widget.match_col2_listbox = ListboxStub()
        widget._update_selected_match_columns = lambda file_index: None
        widget._update_optional_addition_rows_visibility = lambda: None
        widget._fallback_addition_date_to_entry_date = lambda cols1, cols2: False
        widget._append_mapped_name_to_auto_match_columns = lambda cols1, cols2: None
        widget._queue_llm_mapping_assist = lambda force=False: None
        widget._clear_normal_file1_addition_mappings = FileAndMatchConfig._clear_normal_file1_addition_mappings.__get__(widget, FileAndMatchConfig)
        widget.file_handler = type(
            "HandlerStub",
            (),
            {
                "file1_df": pd.DataFrame({"asset_code": ["A1"], "asset_name": ["Old"]}),
                "file2_df": pd.DataFrame({"card_code": ["A1"], "asset_name": ["New"], "变动方式": ["购入"], "变动日期": ["2025/01/01"]}),
                "get_file1_columns": lambda self: ["asset_code", "asset_name"],
                "get_file2_columns": lambda self: ["card_code", "asset_name", "变动方式", "变动日期"],
            },
        )()

        widget._update_match_columns(trigger_llm=False)

        self.assertEqual("", widget.addition_method_col1_var.get())
        self.assertEqual("变动方式", widget.addition_method_col2_var.get())
        self.assertEqual("变动日期", widget.addition_date_col2_var.get())

    def test_match_review_reason_sanitizer_hides_technical_diagnostics(self):
        text = "；".join(
            _sanitize_match_review_reasons(
                [
                    "file1_col_1 header 资产编号, samples numeric codes, looks_like_code_ratio=1; file2_col_4 header 卡片编码, profile samples",
                ]
            )
        )

        self.assertIn("当前匹配列口径不一致", text)
        for token in ("file1_col", "header", "samples", "looks_like_code_ratio", "profile"):
            self.assertNotIn(token, text)

    def test_normal_mode_next_config_outputs_none_for_file1_addition_fields(self):
        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        widget.file1_path_var = tk.StringVar(master=root, value="old.csv")
        widget.file2_path_var = tk.StringVar(master=root, value="new.csv")
        widget.file1_sheet_var = tk.StringVar(master=root, value="")
        widget.file2_sheet_var = tk.StringVar(master=root, value="")
        widget.balance_sheet_date_var = tk.StringVar(master=root, value="2025/12/31")
        widget.match_columns1 = ["asset_code"]
        widget.match_columns2 = ["card_code"]
        widget.addition_method_col1_var.set("old_method")
        widget.addition_date_col1_var.set("old_date")
        widget.addition_method_col2_var.set("change_type")
        widget.addition_date_col2_var.set("change_date")
        widget.file_handler = type(
            "HandlerStub",
            (),
            {
                "file1_df": pd.DataFrame({"asset_code": ["A1"], "old_method": ["legacy"], "old_date": ["2024/01/01"]}),
                "file2_df": pd.DataFrame({"card_code": ["A1"], "change_type": ["购入"], "change_date": ["2025/01/01"]}),
                "get_file1_columns": lambda self: ["asset_code", "old_method", "old_date"],
                "get_file2_columns": lambda self: ["card_code", "change_type", "change_date"],
            },
        )()
        widget.file1_header_row = 0
        widget.file2_header_row = 0
        captured = {}
        widget.on_complete = lambda config: captured.update(config)
        widget._show_next_step_warning = lambda message: self.fail(message)

        with patch("tools.fa_list.gui.file_and_match_config.is_llm_enabled", return_value=False):
            widget._on_next()

        self.assertIsNone(captured["addition_method_col1"])
        self.assertIsNone(captured["addition_date_col1"])
        self.assertEqual("change_type", captured["addition_method_col2"])
        self.assertEqual("change_date", captured["addition_date_col2"])

    def test_normal_mode_next_ignores_addition_date_without_method(self):
        root = tk.Tcl()
        widget = self._make_widget_with_mapping_vars(root)
        widget.file1_path_var = tk.StringVar(master=root, value="old.csv")
        widget.file2_path_var = tk.StringVar(master=root, value="new.csv")
        widget.file1_sheet_var = tk.StringVar(master=root, value="")
        widget.file2_sheet_var = tk.StringVar(master=root, value="")
        widget.balance_sheet_date_var = tk.StringVar(master=root, value="2025/12/31")
        widget.match_columns1 = ["asset_code"]
        widget.match_columns2 = ["card_code"]
        widget.addition_method_col2_var.set("")
        widget.addition_date_col2_var.set("capitalized_date")
        widget.file_handler = type(
            "HandlerStub",
            (),
            {
                "file1_df": pd.DataFrame({"asset_code": ["A1"]}),
                "file2_df": pd.DataFrame({"card_code": ["A1"], "capitalized_date": ["2025/01/01"]}),
                "get_file1_columns": lambda self: ["asset_code"],
                "get_file2_columns": lambda self: ["card_code", "capitalized_date"],
            },
        )()
        widget.file1_header_row = 0
        widget.file2_header_row = 0
        captured = {}
        widget.on_complete = lambda config: captured.update(config)
        widget._show_next_step_warning = lambda message: self.fail(message)

        with patch("tools.fa_list.gui.file_and_match_config.is_llm_enabled", return_value=False):
            widget._on_next()

        self.assertIsNone(captured["addition_method_col2"])
        self.assertIsNone(captured["addition_date_col2"])


if __name__ == "__main__":
    unittest.main()
