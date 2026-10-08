# -*- coding: utf-8 -*-
"""
Oracle EBS 总账导出风格 - 汇率损益测试数据集（生成 + 自检一体）
================================================================

场景：一个账套（AOLAN GROUP PRIMARY LEDGER）内两家法人主体，本位币不同：
  - SZ01 澳岚电子科技（深圳）有限公司：本位币 CNY，外币 USD / EUR / JPY / HKD
  - US01 Aolan Precision USA Inc.：本位币 USD，外币 EUR

会计期间：2026-01-01 至 2026-06-30
记账汇率（对 CNY）：USD=7.12  EUR=7.83  JPY=0.0482  HKD=0.91
  US01 的 EUR 记账汇率（EUR/USD 交叉）= 1.10
期末汇率（2026-06-30，对 CNY）：USD=7.18  EUR=7.90  JPY=0.0495  HKD=0.915
  US01 期末 EUR/USD = 1.12

本位币金额 = round(原币金额 x 记账汇率, 2)，除预埋点 2 外全表一致。

预埋测试点（详见 README.md）：
  1. 多主体本位币混合：币种列 CNY/USD/EUR/JPY/HKD 多值并存，
     SZ01 的本位币行 Currency Code=CNY，US01 的本位币行=USD。
  2. 跨主体汇率不一致：Batch "US01 PAYMENTS 202606" + JE Name "AP-EUR-SETTLE"
     的第 1-2 行，EUR 5000 折算用了 1.02（应为 1.10），差异 400.00 USD。
     该点只破坏隐含折算汇率，不破坏凭证借贷平衡与 TB 滚动勾稽。

运行：python generate.py
输出：Oracle_科目余额表.xlsx、Oracle_总账凭证明细.xlsx（与本脚本同目录）
控制台输出为纯文本（无 emoji），适配 Windows GBK 控制台。
"""

import sys
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass

OUT_DIR = Path(__file__).resolve().parent
TB_PATH = OUT_DIR / "Oracle_科目余额表.xlsx"
JE_PATH = OUT_DIR / "Oracle_总账凭证明细.xlsx"

# ---------------------------------------------------------------- 基础设定
LEDGER_NAME = "AOLAN GROUP PRIMARY LEDGER"
COMPANY_NAME = {"SZ01": "澳岚电子科技（深圳）有限公司", "US01": "Aolan Precision USA Inc."}
CC_SEG = {"SZ01": "01", "US01": "02"}
FUNCTIONAL = {"SZ01": "CNY", "US01": "USD"}

BOOK_RATE = {  # 记账汇率（原币 -> 该主体本位币）
    "SZ01": {"CNY": 1.00, "USD": 7.12, "EUR": 7.83, "JPY": 0.0482, "HKD": 0.91},
    "US01": {"USD": 1.00, "EUR": 1.10},
}
END_RATE = {  # 2026-06-30 期末重估汇率
    "SZ01": {"CNY": 1.00, "USD": 7.18, "EUR": 7.90, "JPY": 0.0495, "HKD": 0.915},
    "US01": {"USD": 1.00, "EUR": 1.12},
}

ACCOUNTS = {
    "10010": "库存现金",
    "11010": "银行存款",
    "11220": "应收票据",
    "11310": "应收利息",
    "12010": "应收账款",
    "13010": "其他应收款",
    "14010": "库存商品",
    "15010": "长期股权投资",
    "16010": "固定资产",
    "17010": "累计折旧",
    "21010": "应付账款",
    "22010": "应付职工薪酬",
    "22210": "其他应付款",
    "24010": "应交税费",
    "25010": "长期借款",
    "30010": "实收资本",
    "34010": "未分配利润",
    "40010": "主营业务收入",
    "41010": "其他业务收入",
    "50010": "主营业务成本",
    "51010": "税金及附加",
    "60010": "销售费用",
    "61010": "管理费用",
    "65010": "财务费用-手续费",
    "65011": "财务费用-汇兑损益",
}
# 货币性项目（现金/往来/借款），期末按期末汇率重估；存货、固定资产等不重估
MONETARY_ACCOUNTS = {"11010", "12010", "13010", "21010", "25010"}

EQUITY_PAID_IN = {"SZ01": 4000000.00, "US01": 200000.00}

# 期初原币余额（2026-01-01，借方为正、贷方为负；本位币行 entered=accounted）
BEGIN_ENTERED = {
    # ---- SZ01（本位币 CNY）----
    ("SZ01", "10010", "CNY"): 50000.00,
    ("SZ01", "11010", "CNY"): 800000.00,
    ("SZ01", "11010", "USD"): 100000.00,
    ("SZ01", "11010", "EUR"): 40000.00,
    ("SZ01", "11010", "HKD"): 100000.00,
    ("SZ01", "11220", "CNY"): 150000.00,
    ("SZ01", "11310", "CNY"): 8000.00,
    ("SZ01", "12010", "CNY"): 300000.00,
    ("SZ01", "12010", "USD"): 150000.00,
    ("SZ01", "12010", "EUR"): 40000.00,
    ("SZ01", "12010", "HKD"): 30000.00,
    ("SZ01", "13010", "CNY"): 20000.00,
    ("SZ01", "13010", "USD"): 5000.00,
    ("SZ01", "14010", "CNY"): 400000.00,
    ("SZ01", "14010", "USD"): 20000.00,
    ("SZ01", "14010", "EUR"): 10000.00,
    ("SZ01", "15010", "CNY"): 500000.00,
    ("SZ01", "16010", "CNY"): 3000000.00,
    ("SZ01", "16010", "USD"): 30000.00,
    ("SZ01", "16010", "JPY"): 8000000.00,
    ("SZ01", "17010", "CNY"): -800000.00,
    ("SZ01", "21010", "CNY"): -250000.00,
    ("SZ01", "21010", "USD"): -40000.00,
    ("SZ01", "21010", "EUR"): -60000.00,
    ("SZ01", "21010", "HKD"): -100000.00,
    ("SZ01", "22010", "CNY"): -90000.00,
    ("SZ01", "22210", "CNY"): -45000.00,
    ("SZ01", "24010", "CNY"): -120000.00,
    # ---- US01（本位币 USD）----
    ("US01", "10010", "USD"): 5000.00,
    ("US01", "11010", "USD"): 150000.00,
    ("US01", "11010", "EUR"): 20000.00,
    ("US01", "12010", "USD"): 120000.00,
    ("US01", "12010", "EUR"): 5000.00,
    ("US01", "13010", "USD"): 3000.00,
    ("US01", "13010", "EUR"): 1000.00,
    ("US01", "14010", "USD"): 60000.00,
    ("US01", "16010", "USD"): 250000.00,
    ("US01", "17010", "USD"): -60000.00,
    ("US01", "21010", "USD"): -80000.00,
    ("US01", "21010", "EUR"): -30000.00,
    ("US01", "22010", "USD"): -10000.00,
    ("US01", "24010", "USD"): -8000.00,
    ("US01", "25010", "USD"): -100000.00,
}


def r2(x):
    """四舍五入到分（ROUND_HALF_UP，避免 Python 默认银行家舍入）。"""
    return float(Decimal(str(float(x))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def cc(company, acct):
    """Code Combination：公司段.科目段.成本中心.产品.未来段"""
    return "%s.%s.0000.0000.0000" % (CC_SEG[company], acct)


def plug_equity():
    """用未分配利润轧平各主体期初试算平衡（期初借贷合计必须为零）。"""
    for comp in ("SZ01", "US01"):
        fc = FUNCTIONAL[comp]
        total = 0.0
        for (c, _a, cur), v in BEGIN_ENTERED.items():
            if c == comp:
                total += r2(v * BOOK_RATE[comp][cur])
        BEGIN_ENTERED[(comp, "30010", fc)] = r2(-EQUITY_PAID_IN[comp])
        BEGIN_ENTERED[(comp, "34010", fc)] = r2(-(total - EQUITY_PAID_IN[comp]))


# ---------------------------------------------------------------- 凭证定义
JOURNALS = []


def add_journal(company, batch, je_name, description, category, je_date, line_specs, rate=None):
    """line_specs: (科目, 币种, 原币金额, 'D'/'C', 行摘要[, 本位币金额])。
    rate 可整单覆盖折算汇率；本位币金额缺省按汇率重算（重估分录按期末汇率直接给出）。"""
    lines = []
    for spec in line_specs:
        acct, cur, amt, dc, ldesc = spec[:5]
        entered = r2(amt)
        if len(spec) > 5 and spec[5] is not None:
            accounted = r2(spec[5])
        else:
            rr = rate if rate is not None else BOOK_RATE[company][cur]
            accounted = r2(entered * rr)
        lines.append({"acct": acct, "cur": cur, "dc": dc, "entered": entered,
                      "accounted": accounted, "desc": ldesc})
    JOURNALS.append({"company": company, "batch": batch, "je": je_name,
                     "desc": description, "cat": category, "date": je_date,
                     "rate": rate, "lines": lines})


def build_monthly():
    """2026 年 1-6 月两家主体的月度循环业务分录。"""
    for m in range(1, 7):
        mm = "%02d" % m
        d_purch = date(2026, m, 15)
        d_sales = date(2026, m, 10)
        d_recv = date(2026, m, 18)
        d_pay = date(2026, m, 20)
        d_payroll = date(2026, m, 27)
        d_close = date(2026, m, 28)

        # ================= SZ01（本位币 CNY）=================
        usd_inv = r2(40000 + 1500 * m)      # 出口销售-美元
        eur_inv = r2(12000 + 800 * m)       # 出口销售-欧元
        cny_inv = r2(200000 + 10000 * m)    # 内销
        add_journal("SZ01", "SZ01 SALES 2026" + mm, "SALES-FOREIGN",
                    "Foreign currency export sales", "Sales Invoice", d_sales, [
            ("12010", "USD", usd_inv, "D", "出口销售开票(美元)"),
            ("12010", "EUR", eur_inv, "D", "出口销售开票(欧元)"),
            ("40010", "USD", usd_inv, "C", "出口销售收入(美元)"),
            ("40010", "EUR", eur_inv, "C", "出口销售收入(欧元)"),
        ])
        add_journal("SZ01", "SZ01 SALES 2026" + mm, "SALES-DOM",
                    "Domestic sales (CNY)", "Sales Invoice", d_sales, [
            ("12010", "CNY", cny_inv, "D", "内销开票"),
            ("40010", "CNY", cny_inv, "C", "内销收入"),
        ])
        add_journal("SZ01", "SZ01 RECEIPTS 2026" + mm, "RECEIPT-USD",
                    "USD customer receipts", "Receipt", d_recv, [
            ("11010", "USD", 35000, "D", "收美元货款"),
            ("12010", "USD", 35000, "C", "核销应收账款(美元)"),
        ])
        add_journal("SZ01", "SZ01 RECEIPTS 2026" + mm, "RECEIPT-EUR",
                    "EUR customer receipts", "Receipt", d_recv, [
            ("11010", "EUR", 9000, "D", "收欧元货款"),
            ("12010", "EUR", 9000, "C", "核销应收账款(欧元)"),
        ])
        add_journal("SZ01", "SZ01 PAYMENTS 2026" + mm, "PAY-AP-EUR",
                    "EUR supplier payment", "Payment", d_pay, [
            ("21010", "EUR", 5000, "D", "支付欧元货款"),
            ("11010", "EUR", 5000, "C", "欧元账户付款"),
        ])
        add_journal("SZ01", "SZ01 PAYMENTS 2026" + mm, "PAY-HKD",
                    "HKD supplier payment", "Payment", d_pay, [
            ("21010", "HKD", 5000, "D", "支付港币货款"),
            ("11010", "HKD", 5000, "C", "港币账户付款"),
        ])
        add_journal("SZ01", "SZ01 PAYMENTS 2026" + mm, "PAYROLL",
                    "Monthly payroll", "Payroll", d_payroll, [
            ("61010", "CNY", r2(70000 + 2000 * m), "D", "计提管理人员工资"),
            ("60010", "CNY", 35000, "D", "计提销售人员工资"),
            ("11010", "CNY", r2(105000 + 2000 * m), "C", "银行代发工资"),
        ])
        add_journal("SZ01", "SZ01 PAYMENTS 2026" + mm, "BANK-FEE",
                    "Bank charges", "Payment", d_pay, [
            ("65010", "CNY", 800, "D", "银行手续费"),
            ("11010", "CNY", 800, "C", "银行扣费"),
        ])
        add_journal("SZ01", "SZ01 PURCH 2026" + mm, "PURCH-JPY",
                    "JPY material purchase", "Purchase Invoice", d_purch, [
            ("50010", "JPY", r2(1500000 + 100000 * m), "D", "日元采购入库"),
            ("21010", "JPY", r2(1500000 + 100000 * m), "C", "应付日元货款"),
        ])
        add_journal("SZ01", "SZ01 PURCH 2026" + mm, "COGS-DOM",
                    "Domestic COGS recognition", "Manual", d_close, [
            ("50010", "CNY", r2(90000 + 3000 * m), "D", "结转内销成本"),
            ("14010", "CNY", r2(90000 + 3000 * m), "C", "库存商品出库"),
        ])
        add_journal("SZ01", "SZ01 PURCH 2026" + mm, "TAX-ACCRUAL",
                    "Tax and surcharges accrual", "Manual", d_close, [
            ("51010", "CNY", 8000, "D", "计提税金及附加"),
            ("24010", "CNY", 8000, "C", "应交税费"),
        ])

        # ================= US01（本位币 USD）=================
        eur_inv_us = r2(3000 + 200 * m)
        usd_inv_us = r2(80000 + 5000 * m)
        recv_us = r2(70000 + 3000 * m)
        add_journal("US01", "US01 SALES 2026" + mm, "SALES-EUR",
                    "Sales to European customers (EUR)", "Sales Invoice", d_sales, [
            ("12010", "EUR", eur_inv_us, "D", "对欧洲客户销售开票(欧元)"),
            ("40010", "EUR", eur_inv_us, "C", "欧元销售收入"),
        ])
        add_journal("US01", "US01 SALES 2026" + mm, "SALES-DOM",
                    "Domestic sales (USD)", "Sales Invoice", d_sales, [
            ("12010", "USD", usd_inv_us, "D", "本土销售开票(美元)"),
            ("40010", "USD", usd_inv_us, "C", "本土销售收入"),
        ])
        add_journal("US01", "US01 RECEIPTS 2026" + mm, "RECEIPT-USD",
                    "USD customer receipts", "Receipt", d_recv, [
            ("11010", "USD", recv_us, "D", "收美元货款"),
            ("12010", "USD", recv_us, "C", "核销应收账款(美元)"),
        ])
        add_journal("US01", "US01 PAYMENTS 2026" + mm, "PAY-AP-EUR",
                    "EUR supplier payment", "Payment", d_pay, [
            ("21010", "EUR", 1200, "D", "支付欧元货款"),
            ("11010", "EUR", 1200, "C", "欧元账户付款"),
        ])
        add_journal("US01", "US01 PAYMENTS 2026" + mm, "PAY-AP-USD",
                    "USD supplier payment", "Payment", d_pay, [
            ("21010", "USD", 35000, "D", "支付美元货款"),
            ("11010", "USD", 35000, "C", "美元账户付款"),
        ])
        add_journal("US01", "US01 PAYMENTS 2026" + mm, "PAYROLL",
                    "Monthly payroll", "Payroll", d_payroll, [
            ("61010", "USD", 25000, "D", "计提管理人员工资"),
            ("60010", "USD", 15000, "D", "计提销售人员工资"),
            ("11010", "USD", 40000, "C", "银行代发工资"),
        ])
        add_journal("US01", "US01 PAYMENTS 2026" + mm, "BANK-FEE",
                    "Bank charges", "Payment", d_pay, [
            ("65010", "USD", 150, "D", "银行手续费"),
            ("11010", "USD", 150, "C", "银行扣费"),
        ])
        add_journal("US01", "US01 PURCH 2026" + mm, "PURCH-COGS",
                    "Material purchase", "Purchase Invoice", d_purch, [
            ("50010", "USD", 40000, "D", "采购入库"),
            ("21010", "USD", 40000, "C", "应付货款"),
        ])


def build_oneoffs():
    """SZ01 一次性业务：美元借款、进口设备、还款、利息收入。"""
    add_journal("SZ01", "SZ01 MISC 202601", "USD-LOAN-DRAW",
                "USD loan drawdown", "Manual", date(2026, 1, 8), [
        ("11010", "USD", 200000, "D", "取得美元借款"),
        ("25010", "USD", 200000, "C", "长期借款入账"),
    ])
    add_journal("SZ01", "SZ01 MISC 202603", "USD-LOAN-REPAY",
                "USD loan repayment", "Manual", date(2026, 3, 22), [
        ("25010", "USD", 50000, "D", "归还美元借款本金"),
        ("11010", "USD", 50000, "C", "美元账户还款"),
    ])
    add_journal("SZ01", "SZ01 CAPEX 202602", "CAPEX-EQUIP",
                "Import equipment purchase (EUR)", "Purchase Invoice", date(2026, 2, 12), [
        ("16010", "EUR", 50000, "D", "进口设备入账(欧元)"),
        ("21010", "EUR", 50000, "C", "应付欧元设备款"),
    ])
    add_journal("SZ01", "SZ01 MISC 202605", "OTH-INCOME",
                "Bank interest income", "Miscellaneous", date(2026, 5, 31), [
        ("11010", "CNY", 15000, "D", "收到银行利息"),
        ("41010", "CNY", 15000, "C", "利息收入"),
    ])


def build_planted():
    """预埋点 2：US01 的欧元结算凭证折算汇率错误（1.02，应为 1.10）。"""
    add_journal("US01", "US01 PAYMENTS 202606", "AP-EUR-SETTLE",
                "EUR supplier settlement", "Payment", date(2026, 6, 24), [
        ("21010", "EUR", 5000, "D", "欧元货款结算"),
        ("11010", "EUR", 5000, "C", "欧元账户付款"),
    ], rate=1.02)


def build_reval(company, batch, je_name, je_date):
    """按 2026-06-30 期末汇率对货币性外币项目重估，净损益计入 65011。"""
    bal_e, bal_a = {}, {}
    for (comp, acct, cur), v in BEGIN_ENTERED.items():
        if comp != company:
            continue
        bal_e[(acct, cur)] = bal_e.get((acct, cur), 0.0) + v
        bal_a[(acct, cur)] = bal_a.get((acct, cur), 0.0) + r2(v * BOOK_RATE[comp][cur])
    for j in JOURNALS:
        if j["company"] != company:
            continue
        for ln in j["lines"]:
            key = (ln["acct"], ln["cur"])
            se = ln["entered"] if ln["dc"] == "D" else -ln["entered"]
            sa = ln["accounted"] if ln["dc"] == "D" else -ln["accounted"]
            bal_e[key] = bal_e.get(key, 0.0) + se
            bal_a[key] = bal_a.get(key, 0.0) + sa

    lines, net = [], 0.0
    fc = FUNCTIONAL[company]
    for (acct, cur) in sorted(bal_e.keys()):
        if cur == fc or acct not in MONETARY_ACCOUNTS:
            continue
        e, a = bal_e[(acct, cur)], bal_a[(acct, cur)]
        if abs(e) < 0.005 and abs(a) < 0.005:
            continue
        adj = r2(e * END_RATE[company][cur]) - r2(a)   # 应调整为（借方为正）
        if abs(adj) < 0.01:
            continue
        f = r2(abs(adj) / END_RATE[company][cur])       # 反推原币调整额
        if f < 0.01:
            continue
        posted = r2(f * END_RATE[company][cur])
        if adj > 0:
            lines.append((acct, cur, f, "D",
                          "期末汇率重估-" + ACCOUNTS[acct] + "(" + cur + ")", posted))
            net += posted
        else:
            lines.append((acct, cur, f, "C",
                          "期末汇率重估-" + ACCOUNTS[acct] + "(" + cur + ")", posted))
            net -= posted
    if not lines:
        return 0.0
    net = r2(net)
    if net >= 0:
        lines.append(("65011", fc, abs(net), "C", "外币余额重估净收益"))
    else:
        lines.append(("65011", fc, abs(net), "D", "外币余额重估净损失"))
    add_journal(company, batch, je_name, "Month-end FX revaluation",
                "Exchange Rate Gain/Loss", je_date, lines)
    return net


# ---------------------------------------------------------------- TB 汇总
def aggregate_tb():
    """TB = 期初 + JE 净发生；行为 公司 x 科目 x 币种。"""
    pn = {}
    for j in JOURNALS:
        for ln in j["lines"]:
            k = (j["company"], ln["acct"], ln["cur"])
            d = pn.setdefault(k, {"ed": 0.0, "ec": 0.0, "ad": 0.0, "ac": 0.0})
            if ln["dc"] == "D":
                d["ed"] += ln["entered"]
                d["ad"] += ln["accounted"]
            else:
                d["ec"] += ln["entered"]
                d["ac"] += ln["accounted"]
    rows = []
    for (comp, acct, cur) in sorted(set(pn) | set(BEGIN_ENTERED)):
        p = pn.get((comp, acct, cur), {"ed": 0.0, "ec": 0.0, "ad": 0.0, "ac": 0.0})
        be = BEGIN_ENTERED.get((comp, acct, cur), 0.0)
        ba = r2(be * BOOK_RATE[comp][cur])
        rows.append({
            "company": comp, "acct": acct, "cur": cur,
            "ed": r2(p["ed"]), "ec": r2(p["ec"]), "ad": r2(p["ad"]), "ac": r2(p["ac"]),
            "be": r2(be), "ba": ba,
            "ee": r2(be + p["ed"] - p["ec"]), "ea": r2(ba + p["ad"] - p["ac"]),
        })
    order = {"CNY": 0, "USD": 1, "EUR": 2, "HKD": 3, "JPY": 4}
    rows.sort(key=lambda r: (r["company"], r["acct"], order.get(r["cur"], 9)))
    return rows


# ---------------------------------------------------------------- Excel 输出
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="DCE6F1")
TITLE_FONT = Font(bold=True, size=12)
HEAD_FONT = Font(bold=True, size=10)
AMT_FMT = "#,##0.00"
DATE_FMT = "yyyy-mm-dd"

TB_HEADERS = ["Company", "Code Combination", "Account Description", "Currency Code",
              "Period Net (Entered Dr)", "Period Net (Entered Cr)",
              "Period Net (Accounted Dr)", "Period Net (Accounted Cr)",
              "Begin Balance (Entered)", "Begin Balance (Accounted)",
              "End Balance (Entered)", "End Balance (Accounted)"]

JE_HEADERS = ["Ledger Name", "Company", "JE Batch Name", "JE Name", "Journal Description",
              "Effective Date", "GL Date", "Journal Category", "Line Number",
              "Code Combination", "Account Description", "Currency Code",
              "Entered Debit", "Entered Credit", "Accounted Debit", "Accounted Credit",
              "Line Description"]


def write_tb(rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "Trial Balance"
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(TB_HEADERS))
    t = ws.cell(row=1, column=1, value="Trial Balance 01-JAN-2026 - 30-JUN-2026")
    t.font = TITLE_FONT
    t.alignment = Alignment(horizontal="left", vertical="center")
    for col, h in enumerate(TB_HEADERS, 1):
        c = ws.cell(row=2, column=col, value=h)
        c.font = HEAD_FONT
        c.fill = HEAD_FILL
        c.border = BORDER
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for i, r in enumerate(rows):
        row = 3 + i
        vals = [r["company"], cc(r["company"], r["acct"]), ACCOUNTS[r["acct"]], r["cur"],
                r["ed"] or None, r["ec"] or None, r["ad"] or None, r["ac"] or None,
                r["be"], r["ba"], r["ee"], r["ea"]]
        for col, v in enumerate(vals, 1):
            c = ws.cell(row=row, column=col, value=v)
            c.border = BORDER
            if col >= 5:
                c.number_format = AMT_FMT
                if col <= 8 and v is None:
                    c.value = None
    widths = [10, 24, 16, 12] + [16] * 8
    for col, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(col)].width = w
    ws.freeze_panes = "A3"
    ws.auto_filter.ref = "A2:%s%d" % (get_column_letter(len(TB_HEADERS)), 2 + len(rows))
    wb.save(TB_PATH)


def write_je():
    wb = Workbook()
    ws = wb.active
    ws.title = "GL Journals"
    for col, h in enumerate(JE_HEADERS, 1):
        c = ws.cell(row=1, column=col, value=h)
        c.font = HEAD_FONT
        c.fill = HEAD_FILL
        c.border = BORDER
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ordered = sorted(JOURNALS, key=lambda j: (j["company"], j["date"], j["batch"], j["je"]))
    row = 2
    lineno_width = max(len(j["je"]) for j in JOURNALS)
    for j in ordered:
        for no, ln in enumerate(j["lines"], 1):
            vals = [LEDGER_NAME, j["company"], j["batch"], j["je"], j["desc"],
                    j["date"], j["date"], j["cat"], no,
                    cc(j["company"], ln["acct"]), ACCOUNTS[ln["acct"]], ln["cur"],
                    ln["entered"] if ln["dc"] == "D" else None,
                    ln["entered"] if ln["dc"] == "C" else None,
                    ln["accounted"] if ln["dc"] == "D" else None,
                    ln["accounted"] if ln["dc"] == "C" else None,
                    ln["desc"]]
            for col, v in enumerate(vals, 1):
                c = ws.cell(row=row, column=col, value=v)
                c.border = BORDER
                if col in (6, 7):
                    c.number_format = DATE_FMT
                elif col in (13, 14, 15, 16):
                    c.number_format = AMT_FMT
                elif col == 9:
                    c.number_format = "0"
            row += 1
    widths = [30, 10, 22, 16, 32, 13, 13, 22, 10, 24, 18, 12, 15, 15, 15, 15, 28]
    for col, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(col)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:%s%d" % (get_column_letter(len(JE_HEADERS)), row - 1)
    wb.save(JE_PATH)
    return row - 2


# ---------------------------------------------------------------- 自检
def run_checks(tb_rows, je_row_count):
    results = []

    def record(name, ok, detail=""):
        results.append((name, ok, detail))

    # 1) 凭证按 Batch+JE Name 分组，各自本位币（Accounted）借贷平衡
    groups = {}
    for j in JOURNALS:
        groups.setdefault((j["batch"], j["je"]), []).append(j)
    assert len(groups) == len(JOURNALS), "存在 (Batch, JE Name) 重复的凭证定义"
    bad = []
    for (batch, je), js in groups.items():
        dr = r2(sum(ln["accounted"] for j in js for ln in j["lines"] if ln["dc"] == "D"))
        cr = r2(sum(ln["accounted"] for j in js for ln in j["lines"] if ln["dc"] == "C"))
        if abs(dr - cr) > 0.005:
            bad.append("%s / %s (Dr=%.2f Cr=%.2f)" % (batch, je, dr, cr))
    record("每张凭证(按 Batch+JE Name 分组)本位币借贷平衡",
           not bad, "%d 张凭证" % len(groups) + ("; 不平衡: " + "; ".join(bad) if bad else ""))

    # 2) TB 滚动勾稽：期末 = 期初 + 净发生（原币、本位币两个口径，全部行含预埋点）
    bad = []
    for r in tb_rows:
        if abs(r["ee"] - r2(r["be"] + r["ed"] - r["ec"])) > 0.005 or \
           abs(r["ea"] - r2(r["ba"] + r["ad"] - r["ac"])) > 0.005:
            bad.append("%s/%s/%s" % (r["company"], r["acct"], r["cur"]))
    record("TB 滚动勾稽(End=Begin+Period Net, 原币+本位币)",
           not bad, "%d/%d 行" % (len(tb_rows) - len(bad), len(tb_rows))
           + ("; 异常: " + ",".join(bad) if bad else " (含预埋点行, 预埋点仅汇率异常不破坏勾稽)"))

    # 3) 各主体 TB 期末试算平衡（Accounted 合计为零）
    bad = []
    for comp in ("SZ01", "US01"):
        s = r2(sum(r["ea"] for r in tb_rows if r["company"] == comp))
        if abs(s) > 0.01:
            bad.append("%s=%.2f" % (comp, s))
    record("各主体期末试算平衡(Sum End Balance Accounted = 0)", not bad,
           "; ".join(bad) if bad else "SZ01=0.00, US01=0.00")

    # 4) 读回文件：表头/列类型/非全空校验
    wb_tb = load_workbook(TB_PATH)
    ws_tb = wb_tb.active
    tb_head = [c.value for c in ws_tb[2]]
    ok = (tb_head == TB_HEADERS)
    cur_col = tb_head.index("Currency Code") + 1
    cur_vals = {ws_tb.cell(row=r, column=cur_col).value
                for r in range(3, 3 + len(tb_rows)) if ws_tb.cell(row=r, column=cur_col).value}
    amt_cols = [i + 1 for i, h in enumerate(tb_head) if "Entered" in h or "Accounted" in h]
    amt_nonempty = any(ws_tb.cell(row=r, column=c).value is not None
                       for r in range(3, 3 + len(tb_rows)) for c in amt_cols)
    amt_numeric = all(isinstance(ws_tb.cell(row=r, column=c).value, (int, float))
                      for r in range(3, 3 + len(tb_rows)) for c in amt_cols
                      if ws_tb.cell(row=r, column=c).value is not None)
    ok = ok and len(cur_vals) >= 3 and amt_nonempty and amt_numeric
    record("TB 读回校验(表头/币种列多值非空/金额列数值型)", ok,
           "表头 12 列, 币种值 %s, 金额列全部数值型" % "/".join(sorted(cur_vals)))

    wb_je = load_workbook(JE_PATH)
    ws_je = wb_je.active
    je_head = [c.value for c in ws_je[1]]
    ok = (je_head == JE_HEADERS)
    idx = {h: i + 1 for i, h in enumerate(je_head)}
    cur_vals_je, date_ok, amt_ok = set(), True, True
    for r in range(2, 2 + je_row_count):
        cur_vals_je.add(ws_je.cell(row=r, column=idx["Currency Code"]).value)
        for dh in ("Effective Date", "GL Date"):
            if not hasattr(ws_je.cell(row=r, column=idx[dh]).value, "strftime"):
                date_ok = False
        for pair in (("Entered Debit", "Entered Credit"), ("Accounted Debit", "Accounted Credit")):
            vals = [ws_je.cell(row=r, column=idx[p]).value for p in pair]
            if not any(v is not None for v in vals):
                amt_ok = False
            for v in vals:
                if v is not None and not isinstance(v, (int, float)):
                    amt_ok = False
    ok = ok and len(cur_vals_je) >= 3 and date_ok and amt_ok
    record("JE 读回校验(表头/币种列多值非空/日期为日期型/金额为数值型)", ok,
           "表头 17 列, 币种值 %s, 日期与金额类型全部正确" % "/".join(sorted(cur_vals_je)))

    # 5) 多主体本位币混合（预埋点 1）：两主体各自存在本位币行，且币种列多值
    sz_cny = any(r["company"] == "SZ01" and r["cur"] == "CNY" and
                 (abs(r["ed"]) > 0 or abs(r["ec"]) > 0) for r in tb_rows)
    us_usd = any(r["company"] == "US01" and r["cur"] == "USD" and
                 (abs(r["ed"]) > 0 or abs(r["ec"]) > 0) for r in tb_rows)
    record("预埋点1 多主体本位币混合(SZ01 本位币=CNY, US01 本位币=USD)",
           sz_cny and us_usd and len(cur_vals | cur_vals_je) >= 4,
           "全表币种: %s" % "/".join(sorted(cur_vals | cur_vals_je)))

    # 6) 预埋点 2：折算汇率 1.02 != 1.10
    planted = next(j for j in JOURNALS if j["batch"] == "US01 PAYMENTS 202606"
                   and j["je"] == "AP-EUR-SETTLE")
    implied = [round(ln["accounted"] / ln["entered"], 4) for ln in planted["lines"]]
    expect = 5000 * (BOOK_RATE["US01"]["EUR"] - 1.02)
    ok = all(abs(v - 1.02) < 0.001 for v in implied) and r2(expect) == 400.00
    record("预埋点2 跨主体汇率不一致(隐含汇率 1.02, 应为 1.10, 差异 400.00 USD)", ok,
           "Batch=%s / JE=%s / 行1-2, 隐含汇率 %s" % (planted["batch"], planted["je"],
                                                     "/".join("%.4f" % v for v in implied)))

    # 7) 凭证键：Batch+JE Name 唯一；JE Name 跨 Batch 重复（体现组合键必要性）
    names = [j["je"] for j in JOURNALS]
    dup_names = sorted(set(n for n in names if names.count(n) > 1))
    record("凭证键唯一性(Batch+JE Name 唯一, JE Name 跨 Batch 重复)", len(dup_names) >= 2,
           "%d 张凭证 / %d 个批次; 跨批次重复 JE Name %d 个(如 %s)"
           % (len(JOURNALS), len(set(j["batch"] for j in JOURNALS)), len(dup_names),
              ", ".join(dup_names[:4])))

    # 8) 规模区间
    record("数据规模(TB 60-90 行, JE 180-300 行)",
           60 <= len(tb_rows) <= 90 and 180 <= je_row_count <= 300,
           "TB %d 行(SZ01 %d / US01 %d), JE %d 行"
           % (len(tb_rows), sum(1 for r in tb_rows if r["company"] == "SZ01"),
              sum(1 for r in tb_rows if r["company"] == "US01"), je_row_count))
    return results


# ---------------------------------------------------------------- 主流程
def main():
    plug_equity()
    build_monthly()
    build_oneoffs()
    build_planted()
    sz_gain = build_reval("SZ01", "SZ01 REVAL 202606", "FXREVAL-0630", date(2026, 6, 30))
    us_gain = build_reval("US01", "US01 REVAL 202606", "FXREVAL-0630", date(2026, 6, 30))

    tb_rows = aggregate_tb()
    je_row_count = write_je()
    write_tb(tb_rows)

    print("=" * 68)
    print("Oracle EBS 风格 汇率损益测试数据集 生成完成")
    print("输出目录: %s" % OUT_DIR)
    print("-" * 68)
    print("写入 %s: %d 行" % (JE_PATH.name, je_row_count))
    print("写入 %s: %d 行" % (TB_PATH.name, len(tb_rows)))
    print("期末重估净损益: SZ01 %s%.2f CNY / US01 %s%.2f USD"
          % ("贷方(收益) " if sz_gain >= 0 else "借方(损失) ", abs(sz_gain),
             "贷方(收益) " if us_gain >= 0 else "借方(损失) ", abs(us_gain)))
    print("-" * 68)
    results = run_checks(tb_rows, je_row_count)
    passed = sum(1 for _n, ok, _d in results if ok)
    for i, (name, ok, detail) in enumerate(results, 1):
        print("自检 %d/%d %s: %s" % (i, len(results), "通过" if ok else "失败", name))
        print("        %s" % detail)
    print("-" * 68)
    if passed == len(results):
        print("全部自检通过 (%d/%d)" % (passed, len(results)))
        return 0
    print("自检存在失败项 (%d/%d 通过)，请检查" % (passed, len(results)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
