# -*- coding: utf-8 -*-
"""
汇率损益测试集2 共享渲染器：同一记账模型按各 ERP 导出版式写出 TB/JE 两个 xlsx。

每个渲染器返回 dict(tb_path, je_path, tb_header_keys, je_header_keys, date_header,
ccy_values, tb_amount_headers, je_amount_headers, tb_net_mode, expect_tb_rows, expect_je_rows)
供 core.run_file_checks 使用。表头均按引擎别名表（ledger_mapping.rs）设计，可自动映射。
"""
from __future__ import annotations

import os
from datetime import date

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

MONEY = "#,##0.00"
RATE_FMT = "0.00000"
DATE_CN = "yyyy-mm-dd"
BOLD = Font(bold=True)


def _ordered_entries(book):
    return sorted(book.entries, key=lambda e: (e["date"], e["vno"]))


def _direction(value):
    if value > 0.004:
        return "借"
    if value < -0.004:
        return "贷"
    return "平"


def _ccy_disp(ccy, cmap):
    return cmap.get(ccy, ccy) if cmap else ccy


def _money(ws, r, c, v):
    cell = ws.cell(row=r, column=c)
    if v is None or (isinstance(v, float) and abs(v) < 0.005):
        cell.value = None
    else:
        cell.value = round(float(v), 2)
        cell.number_format = MONEY


def _txt(ws, r, c, v, center=False):
    cell = ws.cell(row=r, column=c)
    cell.value = v
    if center:
        cell.alignment = Alignment(horizontal="center")


def _date(ws, r, c, d, fmt=DATE_CN):
    cell = ws.cell(row=r, column=c)
    cell.value = d
    cell.number_format = fmt


def _headers(ws, row, headers):
    for i, h in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=i, value=h)
        cell.font = BOLD
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _widths(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _title(ws, lines, ncols):
    for r, text in enumerate(lines, start=1):
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=ncols)
        cell = ws.cell(row=r, column=1, value=text)
        cell.font = Font(bold=True, size=13 if r == 1 else 10)
        cell.alignment = Alignment(horizontal="center")


def _tb_rows(book):
    return list(book.roll_tb().values())


# ────────────────────────────── 01 用友 U8 ──────────────────────────────

def u8(book, out_dir, prefix, cmap=None):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_序时账.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目编码", "科目名称", "币种", "期初余额(原币)", "期初余额(本位币)",
             "本期发生借方(原币)", "本期发生贷方(原币)", "本期发生借方(本位币)", "本期发生贷方(本位币)",
             "期末余额(原币)", "期末余额(本位币)", "方向"]
    _title(ws, [book.entity + " 科目余额表",
                "期间: 2026-01 至 2026-06    记账本位币: 人民币    单位: 元"], len(heads))
    _headers(ws, 3, heads)
    r = 4
    rows = _tb_rows(book)
    for row in rows:
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, _ccy_disp(row["ccy"], cmap), True)
        _money(ws, r, 4, abs(row["open_o"]))
        _money(ws, r, 5, abs(row["open_f"]))
        _money(ws, r, 6, row["dr_o"])
        _money(ws, r, 7, row["cr_o"])
        _money(ws, r, 8, row["dr_f"])
        _money(ws, r, 9, row["cr_f"])
        _money(ws, r, 10, abs(row["close_o"]))
        _money(ws, r, 11, abs(row["close_f"]))
        _txt(ws, r, 12, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [10, 26, 8, 14, 14, 14, 14, 14, 14, 14, 14, 6])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "序时账"
    heads = ["日期", "凭证字号", "摘要", "科目编码", "科目名称", "币种", "汇率",
             "借方原币", "贷方原币", "借方本位币", "贷方本位币", "余额方向", "余额"]
    _title(ws, [book.entity + " 序时账（明细账）",
                "期间: 2026-01-01 至 2026-06-30    单位: 元"], len(heads))
    _headers(ws, 3, heads)
    r = 4
    running = {}
    for e in _ordered_entries(book):
        key = (e["acct"], e["ccy"])
        running[key] = round(running.get(key, 0.0) + e["dr_f"] - e["cr_f"], 2)
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, e["vno"].replace("-", "-"), True)
        _txt(ws, r, 3, e["summary"])
        _txt(ws, r, 4, e["acct"], True)
        _txt(ws, r, 5, e["name"])
        _txt(ws, r, 6, _ccy_disp(e["ccy"], cmap), True)
        if e["rate"]:
            c = ws.cell(row=r, column=7, value=e["rate"])
            c.number_format = RATE_FMT
        _money(ws, r, 8, e["dr_o"])
        _money(ws, r, 9, e["cr_o"])
        _money(ws, r, 10, e["dr_f"])
        _money(ws, r, 11, e["cr_f"])
        _txt(ws, r, 12, _direction(running[key]), True)
        _money(ws, r, 13, abs(running[key]))
        r += 1
    _widths(ws, [11, 10, 30, 10, 24, 8, 8, 13, 13, 13, 13, 8, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编码", "币种", "期初余额", "期末余额"],
        "je_header_keys": ["日期", "凭证字号", "币种", "借方原币", "借方本位币"],
        "date_header": "日期",
        "ccy_values": sorted({_ccy_disp(c, cmap) for c in [book.functional] + book.foreign_ccys()}),
        "tb_amount_headers": ["期初余额(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["借方原币", "借方本位币"],
        "func_check_cols": [("借方本位币", "dr"), ("贷方本位币", "cr")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 02 用友 NC ──────────────────────────────

def nc(book, out_dir, prefix, aux_of=None):
    aux_of = aux_of or {}
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_凭证明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["年度", "会计期间", "科目编码", "科目名称", "辅助核算", "币种",
             "期初余额(原币)", "期初余额(本位币)",
             "本年累计借方(原币)", "本年累计贷方(原币)", "本年累计借方(本位币)", "本年累计贷方(本位币)",
             "期末余额(原币)", "期末余额(本位币)"]
    _title(ws, ["%s 总账科目余额表" % book.entity,
                "年度: 2026    期间: 01 月 - 06 月    本位币: %s    金额单位: 元" % book.functional], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, 2026, True)
        _txt(ws, r, 2, "01-06", True)
        _txt(ws, r, 3, row["acct"], True)
        _txt(ws, r, 4, row["name"])
        _txt(ws, r, 5, aux_of.get(row["acct"], None))
        _txt(ws, r, 6, row["ccy"], True)
        _money(ws, r, 7, row["open_o"])
        _money(ws, r, 8, row["open_f"])
        _money(ws, r, 9, row["dr_o"])
        _money(ws, r, 10, row["cr_o"])
        _money(ws, r, 11, row["dr_f"])
        _money(ws, r, 12, row["cr_f"])
        _money(ws, r, 13, row["close_o"])
        _money(ws, r, 14, row["close_f"])
        r += 1
    _widths(ws, [7, 9, 11, 26, 14, 7, 13, 13, 13, 13, 13, 13, 13, 13])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "凭证明细"
    heads = ["记账日期", "业务日期", "凭证类别", "凭证号", "摘要", "科目编码", "科目名称",
             "辅助核算", "币种", "借方原币", "贷方原币", "借方本位币", "贷方本位币"]
    _title(ws, ["%s 总账凭证明细" % book.entity,
                "查询期间: 2026-01-01 至 2026-06-30"], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for e in _ordered_entries(book):
        vtype, n = e["vno"].split("-")
        _date(ws, r, 1, e["date"])
        _date(ws, r, 2, e["date"])
        _txt(ws, r, 3, vtype, True)
        cell = ws.cell(row=r, column=4, value="%04d" % int(n))
        cell.alignment = Alignment(horizontal="center")
        _txt(ws, r, 5, e["summary"])
        _txt(ws, r, 6, e["acct"], True)
        _txt(ws, r, 7, e["name"])
        _txt(ws, r, 8, aux_of.get(e["acct"], None))
        _txt(ws, r, 9, e["ccy"], True)
        _money(ws, r, 10, e["dr_o"])
        _money(ws, r, 11, e["cr_o"])
        _money(ws, r, 12, e["dr_f"])
        _money(ws, r, 13, e["cr_f"])
        r += 1
    _widths(ws, [11, 11, 9, 8, 30, 11, 24, 14, 7, 13, 13, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编码", "币种", "期初余额(原币)", "期末余额(本位币)"],
        "je_header_keys": ["记账日期", "凭证号", "币种", "借方原币", "借方本位币"],
        "date_header": "记账日期",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["本年累计借方(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["借方原币", "借方本位币"],
        "func_check_cols": [("借方本位币", "dr"), ("贷方本位币", "cr")],
        "tb_net_mode": "signed",
    }


# ────────────────────────────── 03 金蝶 K/3（两行复合表头） ──────────────────────────────

def k3(book, out_dir, prefix, cmap=None):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_序时账.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    _title(ws, ["科目余额表",
                "单位: %s    期间: 2026年第1期 - 第6期    币别: 人民币" % book.entity], 14)
    # 第 3-4 行复合表头：1科目编码 2科目名称 3币种 | 期初余额(4-5) 本期发生(6-9) 期末余额(10-11) | 12方向
    def _center(cell):
        cell.font = BOLD
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for col in (1, 2, 3, 12):
        name = {1: "科目编码", 2: "科目名称", 3: "币种", 12: "方向"}[col]
        ws.merge_cells(start_row=3, start_column=col, end_row=4, end_column=col)
        _center(ws.cell(row=3, column=col, value=name))
    for (name, c1, c2) in [("期初余额", 4, 5), ("本期发生", 6, 9), ("期末余额", 10, 11)]:
        ws.merge_cells(start_row=3, start_column=c1, end_row=3, end_column=c2)
        _center(ws.cell(row=3, column=c1, value=name))
    subs = {4: "原币金额", 5: "本位币金额", 6: "借方原币金额", 7: "贷方原币金额",
            8: "借方本位币金额", 9: "贷方本位币金额", 10: "原币金额", 11: "本位币金额"}
    for col, name in subs.items():
        _center(ws.cell(row=4, column=col, value=name))
    # 列布局: 1科目编码 2科目名称 3币种 4期初原币 5期初本位币 6借原币 7贷原币 8借本位币 9贷本位币 10末原币 11末本位币
    r = 5
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, _ccy_disp(row["ccy"], cmap), True)
        _money(ws, r, 4, abs(row["open_o"]))
        _money(ws, r, 5, abs(row["open_f"]))
        _money(ws, r, 6, row["dr_o"])
        _money(ws, r, 7, row["cr_o"])
        _money(ws, r, 8, row["dr_f"])
        _money(ws, r, 9, row["cr_f"])
        _money(ws, r, 10, abs(row["close_o"]))
        _money(ws, r, 11, abs(row["close_f"]))
        _txt(ws, r, 12, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [10, 26, 8, 12, 12, 12, 12, 12, 12, 12, 12, 6])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "序时账"
    heads = ["日期", "凭证字", "凭证号", "摘要", "科目编码", "科目名称", "币种",
             "借方(原币)", "贷方(原币)", "借方(本位币)", "贷方(本位币)", "余额(原币)", "余额(本位币)"]
    _title(ws, ["序时账", "单位: %s    期间: 2026-01-01 至 2026-06-30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    running = {}
    for e in _ordered_entries(book):
        vtype, n = e["vno"].split("-")
        key = (e["acct"], e["ccy"])
        prev = running.get(key, (0.0, 0.0))
        running[key] = (round(prev[0] + e["dr_o"] - e["cr_o"], 2), round(prev[1] + e["dr_f"] - e["cr_f"], 2))
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, vtype, True)
        cell = ws.cell(row=r, column=3, value=int(n))
        cell.alignment = Alignment(horizontal="center")
        _txt(ws, r, 4, e["summary"])
        _txt(ws, r, 5, e["acct"], True)
        _txt(ws, r, 6, e["name"])
        _txt(ws, r, 7, _ccy_disp(e["ccy"], cmap), True)
        _money(ws, r, 8, e["dr_o"])
        _money(ws, r, 9, e["cr_o"])
        _money(ws, r, 10, e["dr_f"])
        _money(ws, r, 11, e["cr_f"])
        _money(ws, r, 12, running[key][0])
        _money(ws, r, 13, running[key][1])
        r += 1
    _widths(ws, [11, 7, 7, 30, 10, 24, 8, 12, 12, 12, 12, 12, 12])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编码", "币种", "原币金额", "本位币金额"],
        "je_header_keys": ["日期", "凭证号", "币种", "借方(原币)", "借方(本位币)"],
        "date_header": "日期",
        "ccy_values": sorted({_ccy_disp(c, cmap) for c in [book.functional] + book.foreign_ccys()}),
        "tb_amount_headers": ["原币金额", "本位币金额"],
        "je_amount_headers": ["借方(原币)", "借方(本位币)"],
        "func_check_cols": [("借方(本位币)", "dr"), ("贷方(本位币)", "cr")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 04 金蝶 KIS 专业版 ──────────────────────────────

def kis(book, out_dir, prefix):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_账簿明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目编码", "科目名称", "币种", "期初余额(原币)", "期初余额(本位币)",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额",
             "期末余额(原币)", "期末余额(本位币)", "方向"]
    _title(ws, ["科目余额表",
                "单位: %s    期间: 2026年1月至6月    币种: 综合本位币报表" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, row["ccy"], True)
        _money(ws, r, 4, abs(row["open_o"]))
        _money(ws, r, 5, abs(row["open_f"]))
        _money(ws, r, 6, row["dr_o"])
        _money(ws, r, 7, row["cr_o"])
        _money(ws, r, 8, row["dr_f"])
        _money(ws, r, 9, row["cr_f"])
        _money(ws, r, 10, abs(row["close_o"]))
        _money(ws, r, 11, abs(row["close_f"]))
        _txt(ws, r, 12, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [10, 26, 8, 13, 13, 13, 13, 13, 13, 13, 13, 6])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "账簿明细"
    heads = ["日期", "凭证字", "凭证号", "摘要", "科目编码", "科目名称", "币种", "汇率",
             "借方金额(本位币)", "贷方金额(本位币)", "借方原币", "贷方原币"]
    _title(ws, ["账簿明细表", "单位: %s    期间: 2026-01-01 至 2026-06-30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for e in _ordered_entries(book):
        vtype, n = e["vno"].split("-")
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, vtype, True)
        cell = ws.cell(row=r, column=3, value="%03d" % int(n))
        cell.alignment = Alignment(horizontal="center")
        _txt(ws, r, 4, e["summary"])
        _txt(ws, r, 5, e["acct"], True)
        _txt(ws, r, 6, e["name"])
        _txt(ws, r, 7, e["ccy"], True)
        if e["rate"]:
            c = ws.cell(row=r, column=8, value=e["rate"])
            c.number_format = RATE_FMT
        _money(ws, r, 9, e["dr_f"])
        _money(ws, r, 10, e["cr_f"])
        _money(ws, r, 11, e["dr_o"])
        _money(ws, r, 12, e["cr_o"])
        r += 1
    _widths(ws, [11, 7, 8, 30, 10, 24, 8, 9, 13, 13, 12, 12])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编码", "币种", "期初余额(原币)", "期末余额(本位币)"],
        "je_header_keys": ["日期", "凭证号", "币种", "借方原币", "借方金额"],
        "date_header": "日期",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["期初余额(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["借方金额(本位币)", "借方原币"],
        "func_check_cols": [("借方金额(本位币)", "dr"), ("贷方金额(本位币)", "cr")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 05 SAP（英文表头 + 中文别名，本位币 USD） ──────────────────────────────

def sap(book, out_dir, prefix, company_code):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_凭证明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "GL Balances"
    heads = ["Company Code", "G/L Account", "Account Name", "Currency", "Period",
             "Opening Balance (Doc. Curr.) 期初原币余额",
             "Debit (Doc. Curr.) 原币借方发生额", "Credit (Doc. Curr.) 原币贷方发生额",
             "Balance (Doc. Curr.) 期末原币余额",
             "Opening Balance (Local Curr.) 期初本位币余额",
             "Debit (Local Curr.) 本年累计借方发生额", "Credit (Local Curr.) 本年累计贷方发生额",
             "Balance (Local Curr.) 期末本位币余额"]
    _title(ws, ["G/L Account Balances (FAGLLB03)",
                "Company Code %s    Period 001/2026 - 006/2026    Local Currency: %s" % (company_code, book.functional)], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, company_code, True)
        _txt(ws, r, 2, row["acct"], True)
        _txt(ws, r, 3, row["name"])
        _txt(ws, r, 4, row["ccy"], True)
        _txt(ws, r, 5, "001-006", True)
        _money(ws, r, 6, row["open_o"])
        _money(ws, r, 7, row["dr_o"])
        _money(ws, r, 8, row["cr_o"])
        _money(ws, r, 9, row["close_o"])
        _money(ws, r, 10, row["open_f"])
        _money(ws, r, 11, row["dr_f"])
        _money(ws, r, 12, row["cr_f"])
        _money(ws, r, 13, row["close_f"])
        r += 1
    _widths(ws, [10, 10, 30, 9, 9, 15, 15, 15, 15, 15, 15, 15, 15])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "Line Items"
    heads = ["Company Code", "Document No.", "Document Type", "Posting Date", "Period",
             "Reference", "Text", "Currency",
             "Amount in Doc. Curr. 原币金额", "Dr/Cr",
             "Amount in Local Curr. 本位币金额", "User Name"]
    _title(ws, ["G/L Account Line Items (FBL3N)",
                "Company Code %s    01.01.2026 - 30.06.2026    Local Currency: %s" % (company_code, book.functional)], len(heads))
    _headers(ws, 3, heads)
    docno_seq = {}
    r = 4
    for e in _ordered_entries(book):
        if e["vno"] not in docno_seq:
            docno_seq[e["vno"]] = 5100000000 + len(docno_seq) + 1
        vtype = e["vno"].split("-")[0]
        net_o = round(e["dr_o"] - e["cr_o"], 2)
        net_f = round(e["dr_f"] - e["cr_f"], 2)
        dr = net_o if abs(net_o) >= 0.005 else net_f
        _txt(ws, r, 1, company_code, True)
        _txt(ws, r, 2, str(docno_seq[e["vno"]]), True)
        _txt(ws, r, 3, vtype, True)
        _date(ws, r, 4, e["date"], "DD.MM.YYYY")
        _txt(ws, r, 5, "%03d/2026" % e["date"].month, True)
        _txt(ws, r, 6, None)
        _txt(ws, r, 7, e["summary"])
        _txt(ws, r, 8, e["ccy"] if e["ccy"] != book.functional else None, True)
        _money(ws, r, 9, abs(net_o) if e["ccy"] != book.functional else None)
        _txt(ws, r, 10, "S" if dr > 0 else "H", True)
        _money(ws, r, 11, abs(net_f))
        _txt(ws, r, 12, "AUDIT01", True)
        r += 1
    _widths(ws, [10, 13, 9, 11, 9, 12, 32, 9, 15, 6, 16, 10])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["G/L Account", "Currency", "期初原币余额", "期末本位币余额"],
        "je_header_keys": ["Document No.", "Posting Date", "Currency", "原币金额", "本位币金额"],
        "date_header": "Posting Date",
        "ccy_values": book.foreign_ccys(),  # 本位币行币种留空（只标外币形态）
        "tb_amount_headers": ["期初原币余额", "期末本位币余额"],
        "je_amount_headers": ["原币金额", "本位币金额"],
        "func_check_cols": [("Amount in Local Curr", "absnet")],
        "tb_net_mode": "signed",
    }


# ────────────────────────────── 06 Oracle EBS（本位币 EUR） ──────────────────────────────

def oracle(book, out_dir, prefix, ledger, company_code):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_总账凭证明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "Trial Balance"
    heads = ["Company", "Account", "Account Name", "Currency",
             "Begin Balance (Entered)", "Begin Balance (Accounted)",
             "Period Net Dr (Entered)", "Period Net Cr (Entered)",
             "Period Net Dr (Accounted)", "Period Net Cr (Accounted)",
             "End Balance (Entered)", "End Balance (Accounted)"]
    _title(ws, ["Trial Balance 01-JAN-2026 - 30-JUN-2026",
                "Ledger: %s    Company: %s    Currency: %s" % (ledger, company_code, book.functional)], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, company_code, True)
        _txt(ws, r, 2, row["acct"], True)
        _txt(ws, r, 3, row["name"])
        _txt(ws, r, 4, row["ccy"], True)
        _money(ws, r, 5, row["open_o"])
        _money(ws, r, 6, row["open_f"])
        _money(ws, r, 7, row["dr_o"])
        _money(ws, r, 8, row["cr_o"])
        _money(ws, r, 9, row["dr_f"])
        _money(ws, r, 10, row["cr_f"])
        _money(ws, r, 11, row["close_o"])
        _money(ws, r, 12, row["close_f"])
        r += 1
    _widths(ws, [9, 11, 30, 9, 14, 14, 14, 14, 14, 14, 14, 14])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "GL Journals"
    heads = ["JE Batch", "JE Name", "Document No", "Effective Date", "Period",
             "Category", "Account", "Account Name", "Currency",
             "Entered Dr", "Entered Cr", "Accounted Dr", "Accounted Cr"]
    _title(ws, ["General Ledger Journals",
                "Ledger: %s    01-JAN-2026 - 30-JUN-2026" % ledger], len(heads))
    _headers(ws, 3, heads)
    batch_map = {}
    r = 4
    for e in _ordered_entries(book):
        if e["vno"] not in batch_map:
            batch_map[e["vno"]] = len(batch_map) + 1
        seq = batch_map[e["vno"]]
        months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN"]
        _txt(ws, r, 1, "BATCH %03d" % ((seq - 1) // 3 + 1), True)
        _txt(ws, r, 2, "JE %04d" % seq, True)
        _txt(ws, r, 3, "%05d" % seq, True)
        _date(ws, r, 4, e["date"], "dd-mmm-yyyy")
        _txt(ws, r, 5, "%s-26" % months[e["date"].month - 1], True)
        _txt(ws, r, 6, e["vno"].split("-")[0], True)
        _txt(ws, r, 7, e["acct"], True)
        _txt(ws, r, 8, e["name"])
        _txt(ws, r, 9, e["ccy"], True)
        _money(ws, r, 10, e["dr_o"])
        _money(ws, r, 11, e["cr_o"])
        _money(ws, r, 12, e["dr_f"])
        _money(ws, r, 13, e["cr_f"])
        r += 1
    _widths(ws, [11, 10, 9, 12, 8, 9, 11, 28, 8, 13, 13, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["Account", "Currency", "Begin Balance (Entered)", "End Balance (Accounted)"],
        "je_header_keys": ["Document No", "Effective Date", "Currency", "Entered Dr", "Accounted Dr"],
        "date_header": "Effective Date",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["Begin Balance (Entered)", "End Balance (Accounted)"],
        "je_amount_headers": ["Entered Dr", "Accounted Dr"],
        "func_check_cols": [("Accounted Dr", "dr"), ("Accounted Cr", "cr")],
        "tb_net_mode": "signed",
    }


# ────────────────────────────── 07 金蝶云星空（净额 + 方向，本位币 HKD） ──────────────────────────────

def kcloud(book, out_dir, prefix):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_凭证明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目编码", "科目名称", "核算维度", "币别",
             "期初余额(原币)", "期初余额(本位币)",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额",
             "期末余额(原币)", "期末余额(本位币)", "期末方向"]
    _title(ws, ["科目余额表",
                "核算组织: %s    期间: 2026年第1期 至 第6期    本位币: %s" % (book.entity, book.functional)], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, None)
        _txt(ws, r, 4, row["ccy"], True)
        _money(ws, r, 5, abs(row["open_o"]))
        _money(ws, r, 6, abs(row["open_f"]))
        _money(ws, r, 7, row["dr_o"])
        _money(ws, r, 8, row["cr_o"])
        _money(ws, r, 9, row["dr_f"])
        _money(ws, r, 10, row["cr_f"])
        _money(ws, r, 11, abs(row["close_o"]))
        _money(ws, r, 12, abs(row["close_f"]))
        _txt(ws, r, 13, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [10, 26, 10, 7, 13, 13, 12, 12, 12, 12, 13, 13, 8])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "凭证明细"
    heads = ["日期", "凭证字号", "摘要", "科目编码", "科目名称", "核算维度", "币别", "汇率",
             "借贷方向", "原币金额", "本位币金额"]
    _title(ws, ["记账凭证明细", "核算组织: %s    期间: 2026-01-01 至 2026-06-30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for e in _ordered_entries(book):
        net_o = round(e["dr_o"] - e["cr_o"], 2)
        net_f = round(e["dr_f"] - e["cr_f"], 2)
        side = "借" if (net_o if abs(net_o) >= 0.005 else net_f) > 0 else "贷"
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, e["vno"], True)
        _txt(ws, r, 3, e["summary"])
        _txt(ws, r, 4, e["acct"], True)
        _txt(ws, r, 5, e["name"])
        _txt(ws, r, 6, None)
        _txt(ws, r, 7, e["ccy"], True)
        if e["rate"]:
            c = ws.cell(row=r, column=8, value=e["rate"])
            c.number_format = RATE_FMT
        _txt(ws, r, 9, side, True)
        _money(ws, r, 10, abs(net_o) if e["ccy"] != book.functional else None)
        _money(ws, r, 11, abs(net_f))
        r += 1
    _widths(ws, [11, 10, 30, 10, 24, 10, 7, 9, 8, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编码", "币别", "期初余额(原币)", "期末余额(本位币)"],
        "je_header_keys": ["日期", "凭证字号", "币别", "原币金额", "本位币金额"],
        "date_header": "日期",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["期初余额(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["原币金额", "本位币金额"],
        "func_check_cols": [("本位币金额", "absnet")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 08 浪潮 GS（JE 币种只标外币） ──────────────────────────────

def inspur(book, out_dir, prefix):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_序时账.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目代码", "科目名称", "币种", "期初余额(原币)", "期初余额(本位币)",
             "借方发生额(原币)", "贷方发生额(原币)", "借方发生额(本位币)", "贷方发生额(本位币)",
             "期末余额(原币)", "期末余额(本位币)", "期末方向"]
    _title(ws, ["%s 科目余额表" % book.entity,
                "账套年度: 2026    期间: 1月至6月累计    本位币: %s" % book.functional], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, row["ccy"], True)
        _money(ws, r, 4, abs(row["open_o"]))
        _money(ws, r, 5, abs(row["open_f"]))
        _money(ws, r, 6, row["dr_o"])
        _money(ws, r, 7, row["cr_o"])
        _money(ws, r, 8, row["dr_f"])
        _money(ws, r, 9, row["cr_f"])
        _money(ws, r, 10, abs(row["close_o"]))
        _money(ws, r, 11, abs(row["close_f"]))
        _txt(ws, r, 12, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [10, 26, 8, 13, 13, 13, 13, 13, 13, 13, 13, 8])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "序时账"
    heads = ["凭证日期", "凭证号", "凭证类型", "摘要", "科目代码", "科目名称", "币种", "汇率",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额"]
    _title(ws, ["序时账（记账凭证）",
                "单位: %s    2026-01-01 至 2026-06-30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for e in _ordered_entries(book):
        vtype, n = e["vno"].split("-")
        _date(ws, r, 1, e["date"])
        cell = ws.cell(row=r, column=2, value="记%04d" % int(n))
        cell.alignment = Alignment(horizontal="center")
        _txt(ws, r, 3, vtype, True)
        _txt(ws, r, 4, e["summary"])
        _txt(ws, r, 5, e["acct"], True)
        _txt(ws, r, 6, e["name"])
        _txt(ws, r, 7, e["ccy"] if e["ccy"] != book.functional else None, True)
        if e["rate"]:
            c = ws.cell(row=r, column=8, value=e["rate"])
            c.number_format = RATE_FMT
        _money(ws, r, 9, e["dr_o"])
        _money(ws, r, 10, e["cr_o"])
        _money(ws, r, 11, e["dr_f"])
        _money(ws, r, 12, e["cr_f"])
        r += 1
    _widths(ws, [11, 9, 9, 30, 10, 24, 8, 9, 13, 13, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目代码", "币种", "期初余额(原币)", "期末余额(本位币)"],
        "je_header_keys": ["凭证日期", "凭证号", "币种", "借方原币金额", "借方本位币金额"],
        "date_header": "凭证日期",
        "ccy_values": book.foreign_ccys(),  # 本位币行留空
        "tb_amount_headers": ["期初余额(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["借方原币金额", "借方本位币金额"],
        "func_check_cols": [("借方本位币金额", "dr"), ("贷方本位币金额", "cr")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 09 鼎捷 E10 ──────────────────────────────

def e10(book, out_dir, prefix):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_会计凭证明细.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目编号", "科目名称", "币种", "期初余额(原币)", "期初余额(本位币)",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额",
             "期末余额(原币)", "期末余额(本位币)", "余额方向"]
    _title(ws, ["科目余额表",
                "运营中心: %s    期间: 2026/01/01 - 2026/06/30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, row["ccy"], True)
        _money(ws, r, 4, abs(row["open_o"]))
        _money(ws, r, 5, abs(row["open_f"]))
        _money(ws, r, 6, row["dr_o"])
        _money(ws, r, 7, row["cr_o"])
        _money(ws, r, 8, row["dr_f"])
        _money(ws, r, 9, row["cr_f"])
        _money(ws, r, 10, abs(row["close_o"]))
        _money(ws, r, 11, abs(row["close_f"]))
        _txt(ws, r, 12, _direction(row["close_o"]), True)
        r += 1
    _widths(ws, [11, 26, 8, 13, 13, 13, 13, 13, 13, 13, 13, 8])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "会计凭证明细"
    heads = ["记账日期", "凭证编号", "凭证种类", "摘要", "科目编号", "科目名称", "币种", "汇率",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额"]
    _title(ws, ["会计凭证明细表", "运营中心: %s    2026/01/01 - 2026/06/30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    vno_seq = {}
    r = 4
    for e in _ordered_entries(book):
        if e["vno"] not in vno_seq:
            vno_seq[e["vno"]] = len(vno_seq) + 1
        seq = vno_seq[e["vno"]]
        vtype = e["vno"].split("-")[0]
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, "GL-2026%02d-%04d" % (e["date"].month, seq), True)
        _txt(ws, r, 3, vtype, True)
        _txt(ws, r, 4, e["summary"])
        _txt(ws, r, 5, e["acct"], True)
        _txt(ws, r, 6, e["name"])
        _txt(ws, r, 7, e["ccy"], True)
        if e["rate"]:
            c = ws.cell(row=r, column=8, value=e["rate"])
            c.number_format = RATE_FMT
        _money(ws, r, 9, e["dr_o"])
        _money(ws, r, 10, e["cr_o"])
        _money(ws, r, 11, e["dr_f"])
        _money(ws, r, 12, e["cr_f"])
        r += 1
    _widths(ws, [11, 15, 9, 30, 11, 24, 8, 9, 13, 13, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目编号", "币种", "期初余额(原币)", "期末余额(本位币)"],
        "je_header_keys": ["记账日期", "凭证编号", "币种", "借方原币金额", "借方本位币金额"],
        "date_header": "记账日期",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["期初余额(原币)", "期末余额(本位币)"],
        "je_amount_headers": ["借方原币金额", "借方本位币金额"],
        "func_check_cols": [("借方本位币金额", "dr"), ("贷方本位币金额", "cr")],
        "tb_net_mode": "direction",
    }


# ────────────────────────────── 10 新中大（余额借贷分列） ──────────────────────────────

def xzd(book, out_dir, prefix):
    tb_path = os.path.join(out_dir, prefix + "_科目余额表.xlsx")
    je_path = os.path.join(out_dir, prefix + "_记账凭证序时账.xlsx")

    wb = Workbook()
    ws = wb.active
    ws.title = "科目余额表"
    heads = ["科目代码", "科目名称", "币种",
             "期初借方(原币)", "期初贷方(原币)", "期初借方(本位币)", "期初贷方(本位币)",
             "借方发生额(原币)", "贷方发生额(原币)", "借方发生额(本位币)", "贷方发生额(本位币)",
             "期末借方(原币)", "期末贷方(原币)", "期末借方(本位币)", "期末贷方(本位币)"]
    _title(ws, ["%s 科目余额表" % book.entity,
                "会计年度: 2026    期间: 第 1 期 至 第 6 期    单位: 元"], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for row in _tb_rows(book):
        _txt(ws, r, 1, row["acct"], True)
        _txt(ws, r, 2, row["name"])
        _txt(ws, r, 3, row["ccy"], True)
        _money(ws, r, 4, row["open_o"] if row["open_o"] > 0 else None)
        _money(ws, r, 5, -row["open_o"] if row["open_o"] < 0 else None)
        _money(ws, r, 6, row["open_f"] if row["open_f"] > 0 else None)
        _money(ws, r, 7, -row["open_f"] if row["open_f"] < 0 else None)
        _money(ws, r, 8, row["dr_o"])
        _money(ws, r, 9, row["cr_o"])
        _money(ws, r, 10, row["dr_f"])
        _money(ws, r, 11, row["cr_f"])
        _money(ws, r, 12, row["close_o"] if row["close_o"] > 0 else None)
        _money(ws, r, 13, -row["close_o"] if row["close_o"] < 0 else None)
        _money(ws, r, 14, row["close_f"] if row["close_f"] > 0 else None)
        _money(ws, r, 15, -row["close_f"] if row["close_f"] < 0 else None)
        r += 1
    _widths(ws, [10, 26, 8, 12, 12, 12, 12, 13, 13, 13, 13, 12, 12, 12, 12])
    wb.save(tb_path)

    wb = Workbook()
    ws = wb.active
    ws.title = "记账凭证序时账"
    heads = ["日期", "凭证号", "摘要", "科目代码", "科目名称", "币种", "汇率",
             "借方原币金额", "贷方原币金额", "借方本位币金额", "贷方本位币金额"]
    _title(ws, ["记账凭证序时账", "单位: %s    2026-01-01 至 2026-06-30" % book.entity], len(heads))
    _headers(ws, 3, heads)
    r = 4
    for e in _ordered_entries(book):
        vtype, n = e["vno"].split("-")
        _date(ws, r, 1, e["date"])
        _txt(ws, r, 2, "%s-%s" % (vtype, n), True)
        _txt(ws, r, 3, e["summary"])
        _txt(ws, r, 4, e["acct"], True)
        _txt(ws, r, 5, e["name"])
        _txt(ws, r, 6, e["ccy"], True)
        if e["rate"]:
            c = ws.cell(row=r, column=7, value=e["rate"])
            c.number_format = RATE_FMT
        _money(ws, r, 8, e["dr_o"])
        _money(ws, r, 9, e["cr_o"])
        _money(ws, r, 10, e["dr_f"])
        _money(ws, r, 11, e["cr_f"])
        r += 1
    _widths(ws, [11, 9, 30, 10, 24, 8, 9, 13, 13, 13, 13])
    wb.save(je_path)

    return {
        "tb_path": tb_path, "je_path": je_path,
        "tb_header_keys": ["科目代码", "币种", "期初借方(原币)", "期末借方(本位币)"],
        "je_header_keys": ["日期", "凭证号", "币种", "借方原币金额", "借方本位币金额"],
        "date_header": "日期",
        "ccy_values": [book.functional] + book.foreign_ccys(),
        "tb_amount_headers": ["期初借方(原币)", "期末借方(本位币)"],
        "je_amount_headers": ["借方原币金额", "借方本位币金额"],
        "func_check_cols": [("借方本位币金额", "dr"), ("贷方本位币金额", "cr")],
        "tb_net_mode": "split",
    }
