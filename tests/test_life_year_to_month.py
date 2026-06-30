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
from sheet_generator import SheetGenerator


class LifeYearToMonthTests(unittest.TestCase):
    def test_plan_use_year_column_is_year_unit(self):
        exp = Exporter()
        df = pd.DataFrame({"计划使用年": [3, 5, 10, 20]})

        self.assertTrue(exp._source_life_year_mode(df, "计划使用年"))

    def test_display_suffix_column_maps_back_to_source(self):
        exp = Exporter()
        df = pd.DataFrame({"计划使用年": [3, 5, 10, 20]})

        self.assertTrue(exp._source_life_year_mode(df, "计划使用年_期末"))

    def test_ambiguous_typical_year_values_convert(self):
        exp = Exporter()
        df = pd.DataFrame({"使用寿命": [3, 5, 10, 20]})

        self.assertTrue(exp._source_life_year_mode(df, "使用寿命"))

    def test_month_column_does_not_convert(self):
        exp = Exporter()
        df = pd.DataFrame({"使用寿命(月)": [12, 24, 36]})

        self.assertFalse(exp._source_life_year_mode(df, "使用寿命(月)"))

    def test_sheet_generator_recognizes_plan_use_year(self):
        gen = SheetGenerator()
        unit, _warning = gen._life_unit_decision("计划使用年", pd.Series([3, 5, 10]))

        self.assertEqual(unit, "year")


if __name__ == "__main__":
    unittest.main()
