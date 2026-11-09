# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 04 金蝶KIS专业版式式：汇隆进出口贸易有限公司（干净账）。

- 本位币 CNY；外币 USD / HKD；期间 2026-01-01 至 2026-06-30。
- 小微进出口贸易商：美元出口收汇结汇频繁（隔月结汇）、港币供应商付款、
  信用证保证金存退。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "汇隆进出口贸易有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "HKD")})

    A = book.add
    A("1002.01", "银行存款-人民币户", "1002", 1)
    A("1002.02", "银行存款-美元户", "1002", 1)
    A("1002.03", "银行存款-港币户", "1002", 1)
    A("1012.01", "其他货币资金-信用证保证金", "1012", 1)
    A("1122.01", "应收账款-美元客户", "1122", 1)
    A("1122.02", "应收账款-国内客户", "1122", 1)
    A("1405", "库存商品", None, 1, monetary=False)
    A("2202.01", "应付账款-港币供应商", "2202", -1)
    A("2202.02", "应付账款-国内供应商", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-销项税额", "2221", -1)
    A("2221.02", "应交税费-进项税额", "2221", 1)
    A("2221.03", "应交税费-未交增值税", "2221", -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-出口(美元)", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-国内贸易", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-运输费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.02", "管理费用-办公费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 1800000.00)
    book.set_open("1002.02", "USD", 120000.00)
    book.set_open("1002.03", "HKD", 250000.00)
    book.set_open("1122.01", "USD", 90000.00)
    book.set_open("1122.02", "CNY", 260000.00)
    book.set_open("1405", "CNY", 1100000.00)
    book.set_open("2202.01", "HKD", -160000.00)
    book.set_open("2202.02", "CNY", -340000.00)
    book.set_open("2221.03", "CNY", -8000.00)
    book.set_open("4001", "CNY", -3000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.01": [("USD", 90000.00, None, 0)],
                  "1122.02": [("CNY", 260000.00, 1.0, 0)]}
    pending_ap = {"2202.01": [("HKD", 160000.00, None, 0)],
                  "2202.02": [("CNY", 340000.00, 1.0, 0)]}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "HKD": "1002.03"}

    # 1月存入信用证保证金（人民币），6月退回
    book.post(book.day(1, 8), "付", "存入信用证保证金", [
        ("1012.01", "CNY", 200000.00, 0.0),
        ("1002.01", "CNY", 0.0, 200000.00),
    ])
    book.post(book.day(6, 15), "收", "信用证保证金退回", [
        ("1002.01", "CNY", 200000.00, 0.0),
        ("1012.01", "CNY", 0.0, 200000.00),
    ])

    sell_plan = {1: (40000.00, 7.1040), 3: (45000.00, 7.1400), 5: (50000.00, 7.1600)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 出口与国内贸易
        book.invoice(d(5), "记", "美元出口销售开票", "1122.01", "6001.01", "USD", 55000.00)
        pending_ar["1122.01"].append(("USD", 55000.00, None, m))
        book.post(d(8), "记", "国内贸易销售(含13%销项税)", [
            ("1122.02", "CNY", 169500.00, 0.0),
            ("6001.02", "CNY", 0.0, 150000.00),
            ("2221.01", "CNY", 0.0, 19500.00),
        ])
        pending_ar["1122.02"].append(("CNY", 169500.00, 1.0, m))

        # 收款（上月整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元出口货款", "1122.01", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.post(d(12), "收", "收国内货款", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.02", "CNY", 0.0, amt),
            ])
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]

        # 采购：港币供应商 + 国内供应商
        hkd_buy = 80000.00
        hkd_cny = r2(hkd_buy * book.book_rate("HKD", d(6)))
        book.post(d(6), "记", "港币采购库存商品", [
            ("1405", "CNY", hkd_cny, 0.0),
            ("2202.01", "HKD", 0.0, hkd_buy),
        ])
        pending_ap["2202.01"].append(("HKD", hkd_buy, None, m))
        book.post(d(7), "记", "国内采购(含13%进项)", [
            ("1405", "CNY", 120000.00, 0.0),
            ("2221.02", "CNY", 15600.00, 0.0),
            ("2202.02", "CNY", 0.0, 135600.00),
        ])
        pending_ap["2202.02"].append(("CNY", 135600.00, 1.0, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.01", "2202.02"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s货款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 工资与费用
        book.post(d(20), "记", "计提本月工资", [
            ("6602.01", "CNY", 96000.00, 0.0),
            ("2211", "CNY", 0.0, 96000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 96000.00, 0.0),
            ("1002.01", "CNY", 0.0, 96000.00),
        ])
        book.post(d(24), "付", "支付办公及运输费", [
            ("6602.02", "CNY", 22000.00, 0.0),
            ("6601.01", "CNY", 18000.00, 0.0),
            ("1002.01", "CNY", 0.0, 40000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 120.00, 0.0),
            ("1002.02", "USD", 0.0, 120.00),
        ])

        book.post(d(27), "付", "人民币账户汇款手续费", [
            ("6603.01", "CNY", 450.00, 0.0),
            ("1002.01", "CNY", 0.0, 450.00),
        ])
        if m == 3:
            book.post(d(16), "付", "支付春季展会费用", [
                ("6601.01", "CNY", 38000.00, 0.0),
                ("1002.01", "CNY", 0.0, 38000.00),
            ])
        if m == 6:
            book.post(d(17), "付", "支付年度审计费", [
                ("6602.02", "CNY", 25000.00, 0.0),
                ("1002.01", "CNY", 0.0, 25000.00),
            ])

        # 增值税
        book.post(d(27), "记", "增值税进销结转", [
            ("2221.01", "CNY", 19500.00, 0.0),
            ("2221.02", "CNY", 0.0, 15600.00),
            ("2221.03", "CNY", 0.0, 3900.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 8000.00 if m == 1 else 3900.00, 0.0),
            ("1002.01", "CNY", 0.0, 8000.00 if m == 1 else 3900.00),
        ])

        # 结汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)

        # 成本、月末
        book.post(d(28), "记", "结转本月销售成本", [
            ("6401", "CNY", 320000.00, 0.0),
            ("1405", "CNY", 0.0, 320000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.kis(book, OUT_DIR, "金蝶KIS")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
