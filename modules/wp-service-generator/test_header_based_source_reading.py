import unittest
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook

import format_wp_workbook as formatter
from generate_wp_project_workbook import (
    DEFAULT_SER_CONFIG,
    apply_order_adjustments,
    collect_service_orders,
    fill_service_sheet,
    find_section_list_file,
    find_service_order_file,
    find_my_orders_file,
    load_order_adjustments,
    map_sections_to_template,
    normalize_order_number,
    normalize_section_name,
    prepare_template,
)


SHUFFLED_HEADERS = [
    "WP FIC*",
    "相关订单",
    "Booking Period End-年审",
    "Service Type",
    "WP服务单编号",
    "Outlook Hours",
    "Audit EIC",
    "Engagement Name",
    "Booking Period Start-预审",
    "底稿任务数量",
    "Audit Report Date",
    "Booking Period End-预审",
    "Booking Period Start-年审",
]


SHUFFLED_VALUES = [
    "fic.user",
    "TEST-ORDER-001",
    "2027-04-30",
    "Audit/Working paper/WP审计底稿COE服务",
    "TEST-WP-001",
    123.45,
    "audit.eic",
    "AUD2026-12 Header Order Test",
    "2026-10-01",
    2,
    "2027-03-31",
    "2026-10-31",
    "2027-01-01",
]


def add_source_sheet(workbook, title):
    sheet = workbook.create_sheet(title)
    sheet.append(SHUFFLED_HEADERS)
    if title == "AUD2026":
        sheet.append(SHUFFLED_VALUES)
    return sheet


class HeaderBasedSourceReadingTests(unittest.TestCase):
    def test_unmatched_sections_are_merged_into_others(self):
        mapped = map_sections_to_template(
            {
                normalize_section_name("Others"): {
                    "entity": None,
                    "drafts": 1,
                    "budget": None,
                    "outlook": None,
                },
                normalize_section_name("底稿迁移服务"): {
                    "entity": 8,
                    "drafts": 8,
                    "budget": 12,
                    "outlook": 36,
                },
            },
            {normalize_section_name("Others"), normalize_section_name("FSO Pilot")},
        )

        others = mapped[normalize_section_name("Others")]
        self.assertEqual(others["entity"], 8)
        self.assertEqual(others["drafts"], 9)
        self.assertEqual(others["budget"], 12)
        self.assertEqual(others["outlook"], 36)

    def test_reference_hour_overrides_are_applied(self):
        workbook = Workbook()
        template = workbook.active
        template["H4"] = "参考时间/Entity"
        template["B5"] = "C_货币资金（除函证程序）"
        template["H5"] = 4.6
        template["B6"] = "C_货币资金_银行函证"
        template["H6"] = 12.5

        prepare_template(template)

        self.assertEqual(template["H5"].value, 3)
        self.assertEqual(template["H6"].value, 10)

    def test_calculation_uses_smart_auto_mode(self):
        workbook = Workbook()
        workbook.calculation = None

        formatter.configure_calculation(workbook)

        self.assertEqual(workbook.calculation.calcMode, "auto")
        self.assertFalse(workbook.calculation.fullCalcOnLoad)
        self.assertFalse(workbook.calculation.forceFullCalc)

    def test_input_files_are_found_by_keywords(self):
        folder = Path("test-inputs")
        service_order = folder / "8月导出的 WP 服务单 v2.xlsx"
        section_list = folder / "Client Section LIST final.xlsx"
        my_orders = folder / "FY26 我的订单.xlsx"
        files = [
            service_order,
            section_list,
            my_orders,
            folder / "FY27+WP服务单汇总.xlsx",
            folder / "~$临时 WP服务单.xlsx",
        ]
        with patch.object(Path, "iterdir", return_value=iter(files)), patch.object(
            Path, "is_file", return_value=True
        ):
            self.assertEqual(find_service_order_file(folder), service_order)
        with patch.object(Path, "iterdir", return_value=iter(files)), patch.object(
            Path, "is_file", return_value=True
        ):
            self.assertEqual(find_section_list_file(folder), section_list)
        with patch.object(Path, "iterdir", return_value=iter(files)), patch.object(
            Path, "is_file", return_value=True
        ):
            self.assertEqual(find_my_orders_file(folder), my_orders)

    def test_my_orders_are_read_by_headers_and_mapped_by_order_number(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "业务"
        sheet.append(["AI Hours", "订单编号", "说明", "CI Hours"])
        sheet.append([11, "Order47151072- 260902002", "test", 11.6])
        with patch(
            "generate_wp_project_workbook.load_workbook",
            return_value=workbook,
        ):
            adjustments = load_order_adjustments(Path("团队 我的订单 final.xlsx"))

        records = [
            {
                "related_order": "Order47151072- 260902002",
                "service_number": "TEST-WP-001",
                "ci_hours": None,
                "ai_hours": None,
                "order_adjustment_found": False,
            }
        ]
        result = apply_order_adjustments(records, adjustments)

        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["unmatched"], [])
        self.assertEqual(records[0]["ci_hours"], 11.6)
        self.assertEqual(records[0]["ai_hours"], 11)

    def test_multiple_keyword_matches_are_rejected(self):
        folder = Path("test-inputs")
        files = [folder / "WP服务单 A.xlsx", folder / "WP服务单 B.xlsx"]
        with patch.object(Path, "iterdir", return_value=iter(files)), patch.object(
            Path, "is_file", return_value=True
        ):
            with self.assertRaisesRegex(ValueError, "多个可能的WP服务单"):
                find_service_order_file(folder)

    def test_collect_service_orders_uses_headers_not_positions(self):
        workbook = Workbook()
        workbook.remove(workbook.active)
        add_source_sheet(workbook, "AUD2026")
        add_source_sheet(workbook, "IPO")

        records = collect_service_orders(workbook)

        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record["engagement_name"], "AUD2026-12 Header Order Test")
        self.assertEqual(record["service_number"], "TEST-WP-001")
        self.assertEqual(record["outlook_hours"], 123.45)
        self.assertEqual(record["related_order"], "TEST-ORDER-001")
        self.assertEqual(record["service_type"], "Audit/Working paper/WP审计底稿COE服务")

    def test_index_uses_headers_not_positions(self):
        workbook = Workbook()
        workbook.remove(workbook.active)
        add_source_sheet(workbook, "AUD2026")
        add_source_sheet(workbook, "IPO")
        service = workbook.create_sheet("AUD2026 Test")
        service["A2"] = "TEST-ORDER-001"
        service["B2"] = "TEST-WP-001"
        service["C2"] = 123.45
        service["D2"] = 11.6
        service["E2"] = 11
        service["I1"] = '=HYPERLINK("#\'AUD2026\'!A2","返回原表")'
        service["C5"] = 1

        formatter.create_index_sheet(workbook, [service])

        index = workbook["服务方案索引"]
        self.assertEqual(index["F8"].value, "fic.user")
        self.assertEqual(index["G8"].value, 11.6)
        self.assertEqual(index["H8"].value, 11)
        self.assertEqual(index["I8"].value, "='AUD2026 Test'!G2")
        self.assertEqual(index["J8"].value, 123.45)
        self.assertEqual(index["D8"].value, "TEST-WP-001")

    def test_service_sheet_shows_ser_roles_and_rate_headers(self):
        workbook = Workbook()
        service = workbook.active
        record = {
            "related_order": "TEST-ORDER-001",
            "service_number": "TEST-WP-001",
            "source_sheet": "AUD2026",
            "source_row": 2,
            "service_type": "Audit/Working paper",
            "task_count": 1,
            "audit_eic": "audit.eic",
            "report_date": "2027-03-31",
            "pre_start": "2026-10-01",
            "pre_end": "2026-10-31",
            "final_start": "2027-01-01",
            "final_end": "2027-04-30",
            "ci_hours": 11.6,
            "ai_hours": 11,
        }

        fill_service_sheet(service, record, {}, DEFAULT_SER_CONFIG)

        self.assertEqual(service["D57"].value, "bill rate")
        self.assertEqual(service["E57"].value, "上浮5%")
        self.assertEqual(
            [service.cell(row, 1).value for row in range(58, 62)],
            ["Manager", "Senior", "Staff", "Intern"],
        )
        self.assertEqual(
            [service.cell(row, 2).value for row in range(58, 62)],
            [0.08, 0.25, 0.58, 0.09],
        )
        self.assertEqual(
            service["E5"].value,
            '=IF(OR(C5="",H5=""),"",ROUND(C5*H5,2))',
        )
        self.assertEqual(
            service["G5"].value,
            '=IF(AND(F5="",E5=""),"",ROUND(IF(E5="",0,E5)+IFERROR(VALUE(F5),0),2))',
        )
        self.assertEqual(service["I1"].value, "返回源表")
        self.assertEqual(service["I1"].hyperlink.target, "#'AUD2026'!A2")
        self.assertEqual(service["C1"].value, "Section Outlook Hours")
        self.assertEqual(service["C2"].value, "=SUM(G5:G36)")
        self.assertEqual(service["D2"].value, 11.6)
        self.assertEqual(service["E2"].value, 11)
        self.assertEqual(
            service["F2"].value,
            '=ROUND((C2-IF(D2="",0,D2)-IF(E2="",0,E2))*0.1,2)',
        )
        self.assertEqual(
            service["G2"].value,
            '=ROUND(C2-IF(D2="",0,D2)-IF(E2="",0,E2)+F2,2)',
        )
        self.assertEqual(service["H2"].value, "=F62")

    def test_service_sheet_uses_source_outlook_for_flexible_sections(self):
        workbook = Workbook()
        service = workbook.active
        service["B36"] = "Others"
        record = {
            "related_order": "TEST-ORDER-001",
            "service_number": "TEST-WP-001",
            "source_sheet": "AUD2026",
            "source_row": 2,
            "service_type": "Audit/Working paper",
            "task_count": 1,
            "audit_eic": "audit.eic",
            "report_date": "2027-03-31",
            "pre_start": "2026-10-01",
            "pre_end": "2026-10-31",
            "final_start": "2027-01-01",
            "final_end": "2027-04-30",
            "ci_hours": None,
            "ai_hours": None,
        }
        section_details = {
            normalize_order_number("TEST-WP-001"): {
                normalize_section_name("底稿迁移服务"): {
                    "entity": 8,
                    "drafts": 8,
                    "budget": 12,
                    "outlook": 36,
                }
            }
        }

        fill_service_sheet(service, record, section_details, DEFAULT_SER_CONFIG)

        self.assertEqual(service["C36"].value, 8)
        self.assertEqual(service["D36"].value, 8)
        self.assertEqual(service["F36"].value, 12)
        self.assertEqual(service["G36"].value, 36)


if __name__ == "__main__":
    unittest.main()
