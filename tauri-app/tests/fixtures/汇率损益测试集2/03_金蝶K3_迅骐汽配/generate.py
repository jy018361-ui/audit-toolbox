# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 03 金蝶K/3版式：迅骐汽车零部件（台州）有限公司（干净账）。

- 本位币 CNY；外币 USD / JPY；期间 2026-01-01 至 2026-06-30。
- 汽配出口制造：美元出口与回款、日元设备进口与分期付汇、国内主机厂销售
  （应收票据收付）、结汇/购汇。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "迅骐汽车零部件（台州）有限公司"
CCY_NAME = {"CNY": "人民币", "USD": "美元", "JPY": "日元"}

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "JPY")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行日元户", "1002", 1)
    A("1122.01", "应收账款-国内主机厂", "1122", 1)
    A("1122.02", "应收账款-美元客户", "1122", 1)
    A("1121", "应收票据", None, 1)
    A("1403", "原材料", None, 1, monetary=False)
    A("1405", "库存商品", None, 1, monetary=False)
    A("1601", "固定资产", None, 1, monetary=False)
    A("1602", "累计折旧", None, -1, monetary=False)
    A("2202.01", "应付账款-国内供应商", "2202", -1)
    A("2202.02", "应付账款-美元供应商", "2202", -1)
    A("2202.03", "应付账款-日元供应商", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-销项税额", "2221", -1)
    A("2221.02", "应交税费-进项税额", "2221", 1)
    A("2221.03", "应交税费-未交增值税", "2221", -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-出口(美元)", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-国内主机厂", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-运输费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-办公费", "6602", 1, monetary=False)
    A("6602.02", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.03", "管理费用-折旧费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 4200000.00)
    book.set_open("1002.02", "USD", 260000.00)
    book.set_open("1002.03", "JPY", 3000000.00)
    book.set_open("1122.01", "CNY", 980000.00)
    book.set_open("1122.02", "USD", 210000.00)
    book.set_open("1121", "CNY", 350000.00)
    book.set_open("1403", "CNY", 3100000.00)
    book.set_open("1405", "CNY", 1900000.00)
    book.set_open("1601", "CNY", 7600000.00)
    book.set_open("1602", "CNY", -1750000.00)
    book.set_open("2202.01", "CNY", -830000.00)
    book.set_open("2202.02", "USD", -140000.00)
    book.set_open("2221.03", "CNY", -18000.00)
    book.set_open("4001", "CNY", -10000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.02": [("USD", 210000.00, book.opening_rate("USD"), 0)],
                  "1122.01": [("CNY", 980000.00, 1.0, 0)]}
    pending_ap = {"2202.02": [("USD", 140000.00, book.opening_rate("USD"), 0)],
                  "2202.01": [("CNY", 830000.00, 1.0, 0)],
                  "2202.03": []}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "JPY": "1002.03"}

    # 1月进口日元数控磨床（非货币性），2/4月分两期各付一半
    book.post(book.day(1, 9), "转", "进口日元数控磨床", [
        ("1601", "JPY", 12000000.00, 0.0),
        ("2202.03", "JPY", 0.0, 12000000.00),
    ])
    pending_ap["2202.03"] += [("JPY", 6000000.00, None, 1), ("JPY", 6000000.00, None, 3)]

    sell_plan = {1: (50000.00, 7.1040), 3: (60000.00, 7.1410), 5: (70000.00, 7.1610)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 出口与国内销售
        book.invoice(d(5), "转", "美元出口销售开票-北美售后市场", "1122.02", "6001.01", "USD", 95000.00)
        pending_ar["1122.02"].append(("USD", 95000.00, None, m))
        book.post(d(8), "转", "国内主机厂销售开票(含13%销项税)", [
            ("1122.01", "CNY", 386400.00, 0.0),
            ("6001.02", "CNY", 0.0, 342000.00),
            ("2221.01", "CNY", 0.0, 44400.00),
        ])
        pending_ar["1122.01"].append(("CNY", 386400.00, 1.0, m))

        # 收款（上月整票收回）；1月另收商业承兑汇票
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元出口货款", "1122.02", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.post(d(12), "收", "收国内主机厂货款", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.01", "CNY", 0.0, amt),
            ])
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]
        if m == 1:
            book.post(d(14), "收", "收到商业承兑汇票", [
                ("1121", "CNY", 350000.00, 0.0),
                ("1122.01", "CNY", 0.0, 350000.00),
            ])
        if m == 4:
            book.post(d(15), "收", "应收票据到期托收", [
                ("1002.01", "CNY", 350000.00, 0.0),
                ("1121", "CNY", 0.0, 350000.00),
            ])

        # 采购：美元冲压钢卷 + 国内辅料
        usd_mat = 70000.00
        mat_cny = r2(usd_mat * book.book_rate("USD", d(6)))
        book.post(d(6), "转", "进口美元冲压钢卷", [
            ("1403", "CNY", mat_cny, 0.0),
            ("2202.02", "USD", 0.0, usd_mat),
        ])
        pending_ap["2202.02"].append(("USD", usd_mat, None, m))
        book.post(d(7), "转", "国内采购辅料(含13%进项)", [
            ("1403", "CNY", 150000.00, 0.0),
            ("2221.02", "CNY", 19500.00, 0.0),
            ("2202.01", "CNY", 0.0, 169500.00),
        ])
        pending_ap["2202.01"].append(("CNY", 169500.00, 1.0, m))

        # 付款（上月及期初整票支付；日元设备分期按期支付）
        for ap_key in ("2202.02", "2202.01", "2202.03"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s设备/货款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 工资、折旧、费用
        book.post(d(20), "转", "计提本月工资社保", [
            ("6602.02", "CNY", 310000.00, 0.0),
            ("2211", "CNY", 0.0, 310000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 310000.00, 0.0),
            ("1002.01", "CNY", 0.0, 310000.00),
        ])
        book.post(d(22), "转", "计提折旧", [
            ("6602.03", "CNY", 58000.00, 0.0),
            ("1602", "CNY", 0.0, 58000.00),
        ])
        book.post(d(24), "付", "支付办公及运输费", [
            ("6602.01", "CNY", 42000.00, 0.0),
            ("6601.01", "CNY", 35000.00, 0.0),
            ("1002.01", "CNY", 0.0, 77000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 280.00, 0.0),
            ("1002.02", "USD", 0.0, 280.00),
        ])

        # 增值税
        book.post(d(27), "转", "增值税进销结转", [
            ("2221.01", "CNY", 44400.00, 0.0),
            ("2221.02", "CNY", 0.0, 19500.00),
            ("2221.03", "CNY", 0.0, 24900.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 18000.00 if m == 1 else 24900.00, 0.0),
            ("1002.01", "CNY", 0.0, 18000.00 if m == 1 else 24900.00),
        ])

        # 结汇 / 购汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)
        if m == 2:
            book.fx_buy(d(13), "付", "购汇支付日元头寸", "1002.03", "1002.01", "JPY", 2000000.00)

        # 成本、月末
        book.post(d(28), "转", "结转本月销售成本", [
            ("6401", "CNY", 980000.00, 0.0),
            ("1405", "CNY", 0.0, 980000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.k3(book, OUT_DIR, "金蝶K3", cmap=CCY_NAME)
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
