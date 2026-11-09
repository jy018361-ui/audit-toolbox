# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 02 用友NC版式：桦霖化工（宁波）有限公司（干净账）。

- 本位币 CNY；外币 USD / JPY / HKD；期间 2026-01-01 至 2026-06-30。
- 化工集团子公司：美元出口与大宗原料进口、日元备件采购、港币物流费、
  关联方美元往来、结汇/购汇。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "桦霖化工（宁波）有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "JPY", "HKD")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行日元户", "1002", 1)
    A("1002.04", "银行存款-中行港币户", "1002", 1)
    A("1122.01", "应收账款-国内客户", "1122", 1)
    A("1122.02", "应收账款-美元客户", "1122", 1)
    A("1231.01", "其他应收款-美元关联往来", "1231", 1)
    A("1403", "原材料", None, 1, monetary=False)
    A("1405", "库存商品", None, 1, monetary=False)
    A("1601", "固定资产", None, 1, monetary=False)
    A("1602", "累计折旧", None, -1, monetary=False)
    A("2202.01", "应付账款-国内供应商", "2202", -1)
    A("2202.02", "应付账款-美元供应商", "2202", -1)
    A("2202.03", "应付账款-日元供应商", "2202", -1)
    A("2231.01", "其他应付款-港币物流费", "2231", -1)
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
    A("6601.01", "销售费用-港币海运费", "6601", 1, monetary=False)
    A("6601.02", "销售费用-运输费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-办公费", "6602", 1, monetary=False)
    A("6602.02", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.03", "管理费用-折旧费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 6200000.00)
    book.set_open("1002.02", "USD", 300000.00)
    book.set_open("1002.03", "JPY", 5000000.00)
    book.set_open("1002.04", "HKD", 400000.00)
    book.set_open("1122.01", "CNY", 1200000.00)
    book.set_open("1122.02", "USD", 250000.00)
    book.set_open("1403", "CNY", 4500000.00)
    book.set_open("1405", "CNY", 2600000.00)
    book.set_open("1601", "CNY", 9800000.00)
    book.set_open("1602", "CNY", -2100000.00)
    book.set_open("2202.01", "CNY", -980000.00)
    book.set_open("2202.02", "USD", -150000.00)
    book.set_open("2202.03", "JPY", -3000000.00)
    book.set_open("2221.03", "CNY", -21000.00)
    book.set_open("4001", "CNY", -12000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.02": [("USD", 250000.00, book.opening_rate("USD"), 0)],
                  "1122.01": [("CNY", 1200000.00, 1.0, 0)]}
    pending_ap = {"2202.02": [("USD", 150000.00, book.opening_rate("USD"), 0)],
                  "2202.01": [("CNY", 980000.00, 1.0, 0)],
                  "2202.03": [("JPY", 3000000.00, book.opening_rate("JPY"), 0)],
                  "2231.01": []}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "JPY": "1002.03", "HKD": "1002.04"}

    # 关联方美元往来：2月拆出、5月全额收回（其他应收款整笔释放）
    rel_rate = book.book_rate("USD", book.day(2, 7))
    book.post(book.day(2, 7), "付", "拆借关联方美元往来", [
        ("1231.01", "USD", 100000.00, 0.0),
        ("1002.02", "USD", 0.0, 100000.00),
    ])
    # 3月购汇补充美元头寸（按当日记账汇率成交，无汇兑损益）
    book.fx_buy(book.day(3, 14), "付", "购汇补充美元头寸", "1002.02", "1002.01", "USD", 30000.00)
    # 4月日元设备备件到库（非货币性）
    jpy_rate_eq = book.book_rate("JPY", book.day(4, 9))
    book.post(book.day(4, 9), "转", "进口日元检修备件", [
        ("1601", "JPY", 8000000.00, 0.0),
        ("2202.03", "JPY", 0.0, 8000000.00),
    ])
    pending_ap["2202.03"].append(("JPY", 8000000.00, jpy_rate_eq, 4))

    sell_plan = {2: (80000.00, 7.1200), 5: (90000.00, 7.1500)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 出口开票与国内销售
        book.invoice(d(5), "转", "美元出口销售开票-海外客户A", "1122.02", "6001.01", "USD", 120000.00)
        pending_ar["1122.02"].append(("USD", 120000.00, book.book_rate("USD", d(5)), m))
        book.post(d(8), "转", "国内销售开票(含13%销项税)", [
            ("1122.01", "CNY", 452000.00, 0.0),
            ("6001.02", "CNY", 0.0, 400000.00),
            ("2221.01", "CNY", 0.0, 52000.00),
        ])
        pending_ar["1122.01"].append(("CNY", 452000.00, 1.0, m))

        # 收款（上月整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元出口货款", "1122.02", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.post(d(12), "收", "收国内货款", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.01", "CNY", 0.0, amt),
            ])
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]

        # 大宗原料进口（美元）与国内采购
        usd_mat = 90000.00
        mat_cny = r2(usd_mat * book.book_rate("USD", d(6)))
        book.post(d(6), "转", "进口美元大宗原料", [
            ("1403", "CNY", mat_cny, 0.0),
            ("2202.02", "USD", 0.0, usd_mat),
        ])
        pending_ap["2202.02"].append(("USD", usd_mat, book.book_rate("USD", d(6)), m))
        book.post(d(7), "转", "国内采购包装材料(含13%进项)", [
            ("1403", "CNY", 160000.00, 0.0),
            ("2221.02", "CNY", 20800.00, 0.0),
            ("2202.01", "CNY", 0.0, 180800.00),
        ])
        pending_ap["2202.01"].append(("CNY", 180800.00, 1.0, m))

        # 日元备件采购（小额，当月支付）
        jpy_amt = 1500000.00
        jpy_cny = r2(jpy_amt * book.book_rate("JPY", d(9)))
        book.post(d(9), "转", "采购日元备件", [
            ("1403", "CNY", jpy_cny, 0.0),
            ("2202.03", "JPY", 0.0, jpy_amt),
        ])
        pending_ap["2202.03"].append(("JPY", jpy_amt, book.book_rate("JPY", d(9)), m))

        # 港币海运费计提（次月支付）
        hkd_fee = 120000.00
        book.post(d(11), "转", "计提港币海运费", [
            ("6601.01", "HKD", hkd_fee, 0.0),
            ("2231.01", "HKD", 0.0, hkd_fee),
        ])
        pending_ap["2231.01"].append(("HKD", hkd_fee, book.book_rate("HKD", d(11)), m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.02", "2202.01", "2202.03", "2231.01"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s款项" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 关联往来收回
        if m == 5:
            book.collect_ar(d(20), "收", "收回关联方美元往来款", "1231.01", "1002.02",
                            "USD", 100000.00, FX_PL)

        # 工资、折旧、费用
        book.post(d(20), "转", "计提本月工资社保", [
            ("6602.02", "CNY", 380000.00, 0.0),
            ("2211", "CNY", 0.0, 380000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 380000.00, 0.0),
            ("1002.01", "CNY", 0.0, 380000.00),
        ])
        book.post(d(22), "转", "计提折旧", [
            ("6602.03", "CNY", 65000.00, 0.0),
            ("1602", "CNY", 0.0, 65000.00),
        ])
        book.post(d(24), "付", "支付办公费及人民币运输费", [
            ("6602.01", "CNY", 45000.00, 0.0),
            ("6601.02", "CNY", 38000.00, 0.0),
            ("1002.01", "CNY", 0.0, 83000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 260.00, 0.0),
            ("1002.02", "USD", 0.0, 260.00),
        ])

        # 增值税
        book.post(d(27), "转", "增值税进销结转", [
            ("2221.01", "CNY", 52000.00, 0.0),
            ("2221.02", "CNY", 0.0, 20800.00),
            ("2221.03", "CNY", 0.0, 31200.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 21000.00 if m == 1 else 31200.00, 0.0),
            ("1002.01", "CNY", 0.0, 21000.00 if m == 1 else 31200.00),
        ])

        # 结汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)

        # 成本、月末
        book.post(d(28), "转", "结转本月销售成本", [
            ("6401", "CNY", 1250000.00, 0.0),
            ("1405", "CNY", 0.0, 1250000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    aux = {"1122.02": "海外客户A", "2202.02": "环球化学", "2202.03": "东瀛商事",
           "2231.01": "香港中远物流", "1231.01": "集团财务公司"}
    exp = renderers.nc(book, OUT_DIR, "用友NC", aux_of=aux)
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
