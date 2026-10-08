# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 09 鼎捷E10版式：台崧精密电子（东莞）有限公司（干净账）。

- 本位币 CNY；外币 USD / EUR；期间 2026-01-01 至 2026-06-30。
- 台资电子制造：美元出口与回款、欧元SMT贴片设备进口（非货币性）、
  关联方美元往来（其他应收款拆出与收回）、结汇/购汇。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 6603.02）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "台崧精密电子（东莞）有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "EUR")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行欧元户", "1002", 1)
    A("1122.01", "应收账款-美元客户", "1122", 1)
    A("1122.02", "应收账款-国内客户", "1122", 1)
    A("1231.01", "其他应收款-关联方往来(美元)", "1231", 1)
    A("1403", "原材料", None, 1, monetary=False)
    A("1405", "库存商品", None, 1, monetary=False)
    A("1601", "固定资产", None, 1, monetary=False)
    A("1602", "累计折旧", None, -1, monetary=False)
    A("2202.01", "应付账款-国内供应商", "2202", -1)
    A("2202.02", "应付账款-美元供应商", "2202", -1)
    A("2202.03", "应付账款-欧元设备商", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-销项税额", "2221", -1)
    A("2221.02", "应交税费-进项税额", "2221", 1)
    A("2221.03", "应交税费-未交增值税", "2221", -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-出口(美元)", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-国内销售", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-运输费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.02", "管理费用-办公费", "6602", 1, monetary=False)
    A("6602.03", "管理费用-折旧费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 3800000.00)
    book.set_open("1002.02", "USD", 230000.00)
    book.set_open("1002.03", "EUR", 90000.00)
    book.set_open("1122.01", "USD", 180000.00)
    book.set_open("1122.02", "CNY", 620000.00)
    book.set_open("1403", "CNY", 2900000.00)
    book.set_open("1405", "CNY", 1700000.00)
    book.set_open("1601", "CNY", 6900000.00)
    book.set_open("1602", "CNY", -1560000.00)
    book.set_open("2202.01", "CNY", -720000.00)
    book.set_open("2202.02", "USD", -160000.00)
    book.set_open("2221.03", "CNY", -16000.00)
    book.set_open("4001", "CNY", -9000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.01": [("USD", 180000.00, None, 0)],
                  "1122.02": [("CNY", 620000.00, 1.0, 0)]}
    pending_ap = {"2202.01": [("CNY", 720000.00, 1.0, 0)],
                  "2202.02": [("USD", 160000.00, None, 0)],
                  "2202.03": []}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "EUR": "1002.03"}

    # 2月拆借关联方美元往来 120,000，5月全额收回；3月进口欧元SMT设备（次月付清）
    book.post(book.day(2, 6), "付", "拆借关联方美元往来", [
        ("1231.01", "USD", 120000.00, 0.0),
        ("1002.02", "USD", 0.0, 120000.00),
    ])
    book.post(book.day(3, 11), "转", "进口欧元SMT贴片设备", [
        ("1601", "EUR", 150000.00, 0.0),
        ("2202.03", "EUR", 0.0, 150000.00),
    ])
    pending_ap["2202.03"].append(("EUR", 150000.00, None, 3))

    sell_plan = {2: (55000.00, 7.1195), 4: (60000.00, 7.1350), 6: (65000.00, 7.1700)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 出口与国内销售
        book.invoice(d(5), "转", "美元出口销售开票-北美ODM客户", "1122.01", "6001.01", "USD", 88000.00)
        pending_ar["1122.01"].append(("USD", 88000.00, None, m))
        book.post(d(8), "转", "国内销售开票(含13%销项税)", [
            ("1122.02", "CNY", 361600.00, 0.0),
            ("6001.02", "CNY", 0.0, 320000.00),
            ("2221.01", "CNY", 0.0, 41600.00),
        ])
        pending_ar["1122.02"].append(("CNY", 361600.00, 1.0, m))

        # 收款（上月及期初整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元出口货款", "1122.01", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.post(d(12), "收", "收国内货款", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.02", "CNY", 0.0, amt),
            ])
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]
        if m == 5:
            book.collect_ar(d(20), "收", "收回关联方美元往来款", "1231.01", "1002.02", "USD", 120000.00, FX_PL)

        # 采购：美元电子料 + 国内辅料
        usd_mat = 65000.00
        mat_cny = r2(usd_mat * book.book_rate("USD", d(6)))
        book.post(d(6), "转", "进口美元电子物料", [
            ("1403", "CNY", mat_cny, 0.0),
            ("2202.02", "USD", 0.0, usd_mat),
        ])
        pending_ap["2202.02"].append(("USD", usd_mat, None, m))
        book.post(d(7), "转", "国内采购辅料(含13%进项)", [
            ("1403", "CNY", 140000.00, 0.0),
            ("2221.02", "CNY", 18200.00, 0.0),
            ("2202.01", "CNY", 0.0, 158200.00),
        ])
        pending_ap["2202.01"].append(("CNY", 158200.00, 1.0, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.02", "2202.01", "2202.03"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s货款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 工资、折旧、费用
        book.post(d(20), "转", "计提本月工资社保(含台干薪资)", [
            ("6602.01", "CNY", 295000.00, 0.0),
            ("2211", "CNY", 0.0, 295000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 295000.00, 0.0),
            ("1002.01", "CNY", 0.0, 295000.00),
        ])
        book.post(d(22), "转", "计提折旧", [
            ("6602.03", "CNY", 62000.00, 0.0),
            ("1602", "CNY", 0.0, 62000.00),
        ])
        book.post(d(24), "付", "支付办公及运输费", [
            ("6602.02", "CNY", 38000.00, 0.0),
            ("6601.01", "CNY", 33000.00, 0.0),
            ("1002.01", "CNY", 0.0, 71000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 240.00, 0.0),
            ("1002.02", "USD", 0.0, 240.00),
        ])

        # 增值税
        book.post(d(27), "转", "增值税进销结转", [
            ("2221.01", "CNY", 41600.00, 0.0),
            ("2221.02", "CNY", 0.0, 18200.00),
            ("2221.03", "CNY", 0.0, 23400.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 16000.00 if m == 1 else 23400.00, 0.0),
            ("1002.01", "CNY", 0.0, 16000.00 if m == 1 else 23400.00),
        ])

        # 结汇 / 购汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)
        if m == 4:
            book.fx_buy(d(14), "付", "购汇补充美元头寸", "1002.02", "1002.01", "USD", 25000.00)

        # 成本、月末
        book.post(d(28), "转", "结转本月销售成本", [
            ("6401", "CNY", 910000.00, 0.0),
            ("1405", "CNY", 0.0, 910000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.e10(book, OUT_DIR, "鼎捷E10")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
