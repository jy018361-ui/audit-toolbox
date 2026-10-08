# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 08 浪潮GS版式：津港国际物流有限公司（干净账）。

- 本位币 CNY；外币 USD / HKD / JPY；期间 2026-01-01 至 2026-06-30。
- 国际货代公司：美元海运费应收（次月收）、港币码头费与日元日本段费用应付
  （次月付）、结汇/购汇；序时账币种列「只标外币」（人民币行留空）。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 6603.02）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "津港国际物流有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "HKD", "JPY")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行港币户", "1002", 1)
    A("1002.04", "银行存款-中行日元户", "1002", 1)
    A("1122.01", "应收账款-美元客户运费", "1122", 1)
    A("1122.02", "应收账款-国内客户", "1122", 1)
    A("1231.01", "其他应收款-代垫关税", "1231", 1)
    A("2202.01", "应付账款-港币码头公司", "2202", -1)
    A("2202.02", "应付账款-日元日本段船公司", "2202", -1)
    A("2202.03", "应付账款-国内车行", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-销项税额(6%)", "2221", -1)
    A("2221.02", "应交税费-进项税额", "2221", 1)
    A("2221.03", "应交税费-未交增值税", "2221", -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-美元航线运费", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-国内物流", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-港口费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.02", "管理费用-办公费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 2600000.00)
    book.set_open("1002.02", "USD", 150000.00)
    book.set_open("1002.03", "HKD", 200000.00)
    book.set_open("1002.04", "JPY", 2500000.00)
    book.set_open("1122.01", "USD", 110000.00)
    book.set_open("1122.02", "CNY", 430000.00)
    book.set_open("1231.01", "CNY", 96000.00)
    book.set_open("2202.01", "HKD", -130000.00)
    book.set_open("2202.02", "JPY", -2200000.00)
    book.set_open("2202.03", "CNY", -260000.00)
    book.set_open("2221.03", "CNY", -11000.00)
    book.set_open("4001", "CNY", -5000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.01": [("USD", 110000.00, None, 0)],
                  "1122.02": [("CNY", 430000.00, 1.0, 0)]}
    pending_ap = {"2202.01": [("HKD", 130000.00, None, 0)],
                  "2202.02": [("JPY", 2200000.00, None, 0)],
                  "2202.03": [("CNY", 260000.00, 1.0, 0)]}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "HKD": "1002.03", "JPY": "1002.04"}

    # 2月代垫关税收回；5月购汇补充日元头寸
    book.post(book.day(2, 20), "收", "收回代垫关税", [
        ("1002.01", "CNY", 96000.00, 0.0),
        ("1231.01", "CNY", 0.0, 96000.00),
    ])
    book.fx_buy(book.day(5, 13), "付", "购汇补充日元头寸", "1002.04", "1002.01", "JPY", 1000000.00)

    sell_plan = {1: (40000.00, 7.1045), 3: (45000.00, 7.1430), 5: (50000.00, 7.1630)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 美元航线运费开票（次月收）与国内物流开票（次月收，6%销项）
        book.invoice(d(5), "记", "美国线海运费开票-货主A", "1122.01", "6001.01", "USD", 46000.00)
        pending_ar["1122.01"].append(("USD", 46000.00, None, m))
        book.post(d(8), "记", "国内物流服务开票(含6%销项税)", [
            ("1122.02", "CNY", 212000.00, 0.0),
            ("6001.02", "CNY", 0.0, 200000.00),
            ("2221.01", "CNY", 0.0, 12000.00),
        ])
        pending_ar["1122.02"].append(("CNY", 212000.00, 1.0, m))

        # 收款（上月及期初整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元海运费", "1122.01", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.post(d(12), "收", "收国内客户运费", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.02", "CNY", 0.0, amt),
            ])
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]

        # 费用采购：港币码头费（次月付）、日元日本段（次月付）、国内车行（次月付）
        hkd_fee = 75000.00
        hkd_cny = r2(hkd_fee * book.book_rate("HKD", d(6)))
        book.post(d(6), "记", "计提港币码头作业费", [
            ("6601.01", "CNY", hkd_cny, 0.0),
            ("2202.01", "HKD", 0.0, hkd_fee),
        ])
        pending_ap["2202.01"].append(("HKD", hkd_fee, None, m))
        jpy_fee = 1600000.00
        jpy_cny = r2(jpy_fee * book.book_rate("JPY", d(7)))
        book.post(d(7), "记", "计提日元日本段运输费", [
            ("6401", "CNY", jpy_cny, 0.0),
            ("2202.02", "JPY", 0.0, jpy_fee),
        ])
        pending_ap["2202.02"].append(("JPY", jpy_fee, None, m))
        book.post(d(9), "记", "计提国内拖车费(含9%进项)", [
            ("6401", "CNY", 60000.00, 0.0),
            ("2221.02", "CNY", 5400.00, 0.0),
            ("2202.03", "CNY", 0.0, 65400.00),
        ])
        pending_ap["2202.03"].append(("CNY", 65400.00, 1.0, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.01", "2202.02", "2202.03"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s费用" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 工资与办公
        book.post(d(20), "记", "计提本月工资社保", [
            ("6602.01", "CNY", 165000.00, 0.0),
            ("2211", "CNY", 0.0, 165000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 165000.00, 0.0),
            ("1002.01", "CNY", 0.0, 165000.00),
        ])
        book.post(d(24), "付", "支付办公费", [
            ("6602.02", "CNY", 28000.00, 0.0),
            ("1002.01", "CNY", 0.0, 28000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 210.00, 0.0),
            ("1002.02", "USD", 0.0, 210.00),
        ])

        # 增值税（6% / 9% 简化合并结转）
        book.post(d(27), "记", "增值税进销结转", [
            ("2221.01", "CNY", 12000.00, 0.0),
            ("2221.02", "CNY", 0.0, 5400.00),
            ("2221.03", "CNY", 0.0, 6600.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 11000.00 if m == 1 else 6600.00, 0.0),
            ("1002.01", "CNY", 0.0, 11000.00 if m == 1 else 6600.00),
        ])

        # 结汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)

        # 成本补充、月末
        book.post(d(28), "记", "计提本月舱位租赁成本", [
            ("6401", "CNY", 128000.00, 0.0),
            ("2202.03", "CNY", 0.0, 128000.00),
        ])
        pending_ap["2202.03"].append(("CNY", 128000.00, 1.0, m))
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.inspur(book, OUT_DIR, "浪潮GS")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
