# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 06 Oracle EBS版式：Lindenwerk GmbH（德国制造子公司，干净账）。

- 本位币 EUR；外币 USD / CNY；期间 2026-01-01 至 2026-06-30。
- 德国制造子公司（中资集团）：美元区客户销售与回款、美国芯片美元采购、
  母公司人民币往来资金支持（1月收到、6月归还）、美元→欧元结汇；
  英文表头（GL Journals/Trial Balance），业务摘要中文。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 66030）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_EURFUNC, r2, run_all      # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "Lindenwerk GmbH"

FX_PL = "66030"
PROFIT = "41040"


def build():
    book = Book(ENTITY, "EUR", RATES_EURFUNC)

    A = book.add
    A("10010", "Bank-Commerzbank EUR", None, 1)
    A("10020", "Bank-USD Account", None, 1)
    A("10030", "Bank-CNY Account", None, 1)
    A("11010", "Inventory", None, 1, monetary=False)
    A("12010", "AR-US Customers", None, 1)
    A("12510", "AR-EUR Customers", None, 1)
    A("15010", "Fixed Assets", None, 1, monetary=False)
    A("15910", "Accum. Depreciation", None, -1, monetary=False)
    A("20010", "AP-USD Vendors", None, -1)
    A("20020", "AP-EUR Vendors", None, -1)
    A("21010", "Group Payable-CNY Parent", None, -1)
    A("22010", "Accrued Payroll", None, -1)
    A("40010", "Paid-in Capital", None, -1, monetary=False)
    A(PROFIT, "Retained Earnings", None, -1, monetary=False)
    A("60010", "Revenue-US Sales", None, -1, monetary=False)
    A("60020", "Revenue-EUR Sales", None, -1, monetary=False)
    A("64010", "COGS", None, 1, monetary=False)
    A("66010", "Payroll Expense", None, 1, monetary=False)
    A("66020", "Rent & Utilities", None, 1, monetary=False)
    A("66021", "Depreciation Expense", None, 1, monetary=False)
    A("66022", "Travel Expense", None, 1, monetary=False)
    A("66025", "Bank Charges", None, 1, monetary=False)
    A(FX_PL, "FX Gain/Loss", None, 1, monetary=False)

    book.set_open("10010", "EUR", 900000.00)
    book.set_open("10020", "USD", 150000.00)
    book.set_open("10030", "CNY", 300000.00)
    book.set_open("11010", "EUR", 680000.00)
    book.set_open("12010", "USD", 120000.00)
    book.set_open("15010", "EUR", 2400000.00)
    book.set_open("15910", "EUR", -520000.00)
    book.set_open("20010", "USD", -95000.00)
    book.set_open("21010", "CNY", -400000.00)
    book.set_open("40010", "EUR", -2000000.00)
    book.set_open(PROFIT, "EUR", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"12010": [("USD", 120000.00, None, 0)]}
    pending_ap = {"20010": [("USD", 95000.00, None, 0)], "20020": []}

    # 母公司人民币资金支持：1月收到 500,000，6月全额归还
    book.loan_receive(book.day(1, 15), "JE", "收到母公司人民币资金支持", "21010", "10030", "CNY", 500000.00)
    sell_plan = {3: (50000.00, 0.9035), 6: (60000.00, 0.8990)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 销售：美元区（赊销次月收）与本土（当月收）
        book.invoice(d(5), "JE", "美国客户销售开票", "12010", "60010", "USD", 85000.00)
        pending_ar["12010"].append(("USD", 85000.00, None, m))
        book.invoice(d(6), "JE", "本土客户销售开票", "12510", "60020", "EUR", 95000.00)
        book.post(d(19), "JE", "收本土客户货款", [
            ("10010", "EUR", 95000.00, 0.0),
            ("12510", "EUR", 0.0, 95000.00),
        ])

        # 收美元货款（上月及期初整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["12010"] if x[3] < m]:
            book.collect_ar(d(10), "JE", "收美国客户货款", "12010", "10020", "USD", amt, FX_PL)
        pending_ar["12010"] = [x for x in pending_ar["12010"] if x[3] >= m]

        # 采购：美国芯片（美元，次月付）与本地服务（欧元，次月付）
        book.post(d(7), "JE", "美国芯片采购入库", [
            ("11010", "EUR", r2(60000.00 * book.book_rate("USD", d(7))), 0.0),
            ("20010", "USD", 0.0, 60000.00),
        ])
        pending_ap["20010"].append(("USD", 60000.00, None, m))
        book.post(d(9), "JE", "本地咨询服务采购", [
            ("66020", "EUR", 8000.00, 0.0),
            ("20020", "EUR", 0.0, 8000.00),
        ])
        pending_ap["20020"].append(("EUR", 8000.00, None, m))

        # 付款（上月及期初整票支付）
        for (ccy, amt, rate, im) in [x for x in pending_ap["20010"] if x[3] < m]:
            book.pay_ap(d(18), "JE", "付美国供应商货款", "20010", "10020", "USD", amt, FX_PL)
        pending_ap["20010"] = [x for x in pending_ap["20010"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ap["20020"] if x[3] < m]:
            book.pay_ap(d(18), "JE", "付本地服务商款项", "20020", "10010", "EUR", amt, FX_PL)
        pending_ap["20020"] = [x for x in pending_ap["20020"] if x[3] >= m]

        # 工资、折旧、租金、差旅、手续费
        book.post(d(20), "JE", "计提本月工资", [
            ("66010", "EUR", 110000.00, 0.0),
            ("22010", "EUR", 0.0, 110000.00),
        ])
        book.post(d(25), "JE", "发放上月工资", [
            ("22010", "EUR", 110000.00, 0.0),
            ("10010", "EUR", 0.0, 110000.00),
        ])
        book.post(d(22), "JE", "计提折旧", [
            ("66021", "EUR", 18000.00, 0.0),
            ("15910", "EUR", 0.0, 18000.00),
        ])
        book.post(d(23), "JE", "支付租金水电", [
            ("66020", "EUR", 26000.00, 0.0),
            ("10010", "EUR", 0.0, 26000.00),
        ])
        book.post(d(24), "JE", "员工差旅费报销", [
            ("66022", "EUR", 6500.00, 0.0),
            ("10010", "EUR", 0.0, 6500.00),
        ])
        book.post(d(26), "JE", "美元户银行手续费", [
            ("66025", "USD", 180.00, 0.0),
            ("10020", "USD", 0.0, 180.00),
        ])
        book.post(d(27), "JE", "欧元账户管理费", [
            ("66025", "EUR", 120.00, 0.0),
            ("10010", "EUR", 0.0, 120.00),
        ])

        # 6月归还母公司人民币资金支持（整笔，月末重估前）
        if m == 6:
            book.loan_repay(d(27), "JE", "归还母公司人民币资金支持", "21010", "10030", "CNY", 500000.00, FX_PL)

        # 美元结汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "JE", "美元结汇兑欧元", "10020", "10010", "USD", amt, r2(amt * px), FX_PL)

        # 成本、月末
        book.post(d(28), "JE", "结转本月销售成本", [
            ("64010", "EUR", 128000.00, 0.0),
            ("11010", "EUR", 0.0, 128000.00),
        ])
        book.revalue(m, FX_PL, vtype="JE", summary_fmt="期末外币货币性项目重估")

    return book


def main():
    book = build()
    exp = renderers.oracle(book, OUT_DIR, "Oracle", "LINDENWERK", "LW01")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
