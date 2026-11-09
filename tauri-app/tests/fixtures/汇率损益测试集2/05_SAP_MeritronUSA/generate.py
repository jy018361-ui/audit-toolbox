# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 05 SAP版式：Meritron USA Inc.（美国销售子公司，干净账）。

- 本位币 USD；外币 EUR；期间 2026-01-01 至 2026-06-30（期间 001-006）。
- 美国销售子公司：欧元区客户出口销售与回款、本土销售、母公司美元关联采购、
  欧元→美元结汇、美元购汇；英文表头（FBL3N/FAGLLB03），业务摘要中文。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 660302）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_EURUSD, r2, run_all        # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "Meritron USA Inc."

FX_PL = "660302"
PROFIT = "410301"


def build():
    book = Book(ENTITY, "USD", RATES_EURUSD)

    A = book.add
    A("100101", "Bank-Chase Operating", None, 1)
    A("100102", "Bank-EUR Account", None, 1)
    A("112201", "AR-Domestic Customers", None, 1)
    A("112202", "AR-EUR Customers", None, 1)
    A("140501", "Inventory", None, 1, monetary=False)
    A("160101", "Fixed Assets", None, 1, monetary=False)
    A("160201", "Accum. Depreciation", None, -1, monetary=False)
    A("113101", "Prepaid Insurance", None, 1, monetary=False)
    A("123101", "Employee Advances", None, 1)
    A("203001", "AP-Parent Company", None, -1)
    A("203002", "AP-Domestic Vendors", None, -1)
    A("220201", "Accrued Payroll", None, -1)
    A("400101", "Paid-in Capital", None, -1, monetary=False)
    A(PROFIT, "Retained Earnings", None, -1, monetary=False)
    A("600101", "Revenue-EUR Sales", None, -1, monetary=False)
    A("600102", "Revenue-Domestic Sales", None, -1, monetary=False)
    A("640101", "COGS", None, 1, monetary=False)
    A("660201", "Payroll Expense", None, 1, monetary=False)
    A("660202", "Rent & Office Expense", None, 1, monetary=False)
    A("660203", "Depreciation Expense", None, 1, monetary=False)
    A("660301", "Interest & Bank Fees", None, 1, monetary=False)
    A(FX_PL, "FX Gain/Loss", None, 1, monetary=False)

    book.set_open("100101", "USD", 450000.00)
    book.set_open("100102", "EUR", 120000.00)
    book.set_open("112201", "USD", 310000.00)
    book.set_open("112202", "EUR", 80000.00)
    book.set_open("113101", "USD", 12000.00)
    book.set_open("140501", "USD", 520000.00)
    book.set_open("160101", "USD", 380000.00)
    book.set_open("160201", "USD", -90000.00)
    book.set_open("203001", "USD", -260000.00)
    book.set_open("203002", "USD", -70000.00)
    book.set_open("400101", "USD", -1000000.00)
    book.set_open(PROFIT, "USD", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"112202": [("EUR", 80000.00, None, 0)],
                  "112201": [("USD", 310000.00, None, 0)]}
    pending_ap = {"203001": [("USD", 260000.00, None, 0)],
                  "203002": [("USD", 70000.00, None, 0)]}
    bank_of = {"USD": "100101", "EUR": "100102"}

    sell_plan = {2: (40000.00, 1.1038), 5: (50000.00, 1.1085)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 欧元区销售与本土销售
        book.invoice(d(5), "DR", "欧元区客户销售开票-德法渠道", "112202", "600101", "EUR", 60000.00)
        pending_ar["112202"].append(("EUR", 60000.00, None, m))
        book.invoice(d(6), "DR", "本土客户销售开票", "112201", "600102", "USD", 95000.00)
        pending_ar["112201"].append(("USD", 95000.00, None, m))

        # 收款（上月整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["112202"] if x[3] < m]:
            book.collect_ar(d(10), "DZ", "收欧元客户货款", "112202", "100102", "EUR", amt, FX_PL)
        pending_ar["112202"] = [x for x in pending_ar["112202"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["112201"] if x[3] < m]:
            book.collect_ar(d(12), "DZ", "收本土客户货款", "112201", "100101", "USD", amt, FX_PL)
        pending_ar["112201"] = [x for x in pending_ar["112201"] if x[3] >= m]

        # 母公司关联采购（美元）与本地费用采购
        book.post(d(7), "KR", "母公司关联采购入库", [
            ("140501", "USD", 70000.00, 0.0),
            ("203001", "USD", 0.0, 70000.00),
        ])
        pending_ap["203001"].append(("USD", 70000.00, None, m))
        book.post(d(8), "KR", "本地服务采购", [
            ("660202", "USD", 12000.00, 0.0),
            ("203002", "USD", 0.0, 12000.00),
        ])
        pending_ap["203002"].append(("USD", 12000.00, None, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("203001", "203002"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "KZ", "付%s采购款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 物流费与母公司特许权使用费
        book.post(d(9), "KR", "计提跨境物流费", [
            ("660202", "USD", 9000.00, 0.0),
            ("203002", "USD", 0.0, 9000.00),
        ])
        pending_ap["203002"].append(("USD", 9000.00, None, m))
        book.post(d(23), "SA", "计提母公司特许权使用费", [
            ("660202", "USD", 7000.00, 0.0),
            ("203001", "USD", 0.0, 7000.00),
        ])
        pending_ap["203001"].append(("USD", 7000.00, None, m))

        book.post(d(6), "SA", "摊销本月保险费", [
            ("660202", "USD", 2000.00, 0.0),
            ("113101", "USD", 0.0, 2000.00),
        ])
        if m == 2:
            book.post(d(13), "SA", "员工备用金借款", [
                ("123101", "USD", 3000.00, 0.0),
                ("100101", "USD", 0.0, 3000.00),
            ])
        if m == 5:
            book.post(d(13), "SA", "员工备用金报销归还", [
                ("660202", "USD", 1800.00, 0.0),
                ("100101", "USD", 1200.00, 0.0),
                ("123101", "USD", 0.0, 3000.00),
            ])

        # 工资、租金、折旧、手续费
        book.post(d(20), "SA", "计提本月工资", [
            ("660201", "USD", 85000.00, 0.0),
            ("220201", "USD", 0.0, 85000.00),
        ])
        book.post(d(25), "KZ", "发放上月工资", [
            ("220201", "USD", 85000.00, 0.0),
            ("100101", "USD", 0.0, 85000.00),
        ])
        book.post(d(22), "SA", "计提折旧", [
            ("660203", "USD", 6000.00, 0.0),
            ("160201", "USD", 0.0, 6000.00),
        ])
        book.post(d(24), "KZ", "支付租金水电", [
            ("660202", "USD", 15000.00, 0.0),
            ("100101", "USD", 0.0, 15000.00),
        ])
        book.post(d(26), "KZ", "欧元户银行手续费", [
            ("660301", "EUR", 150.00, 0.0),
            ("100102", "EUR", 0.0, 150.00),
        ])

        # 欧元结汇 / 美元购汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "SA", "欧元结汇兑美元", "100102", "100101", "EUR", amt, r2(amt * px), FX_PL)
        if m == 4:
            book.fx_buy(d(14), "SA", "购汇补充欧元头寸", "100102", "100101", "EUR", 20000.00)

        # 成本、月末
        book.post(d(28), "SA", "结转本月销售成本", [
            ("640101", "USD", 110000.00, 0.0),
            ("140501", "USD", 0.0, 110000.00),
        ])
        book.revalue(m, FX_PL, vtype="SA", summary_fmt="期末外币货币性项目重估(FAGL_FCV)")

    return book


def main():
    book = build()
    exp = renderers.sap(book, OUT_DIR, "SAP", "MUS")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
