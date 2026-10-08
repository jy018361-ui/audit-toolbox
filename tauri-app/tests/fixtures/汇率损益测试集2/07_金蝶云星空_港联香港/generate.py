# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 07 金蝶云星空版式：港联供应链（香港）有限公司（干净账）。

- 本位币 HKD；外币 USD / CNY；期间 2026-01-01 至 2026-06-30。
- 香港贸易物流公司：美元客户应收（美国航线）、内地供应商人民币采购、
  美元资本投入、美元→港币结汇；「币别」列、净额+借贷方向列（中文净额形态）。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 6603.02）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_HKDFUNC, r2, run_all     # noqa: E402
import renderers                                      # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "港联供应链（香港）有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "HKD", RATES_HKDFUNC)

    A = book.add
    A("1002.01", "银行存款-汇丰港币户", "1002", 1)
    A("1002.02", "银行存款-汇丰美元户", "1002", 1)
    A("1002.03", "银行存款-中银人民币户", "1002", 1)
    A("1122.01", "应收账款-美元客户", "1122", 1)
    A("1122.02", "应收账款-本地客户", "1122", 1)
    A("1405", "库存商品", None, 1, monetary=False)
    A("2202.01", "应付账款-内地供应商(人民币)", "2202", -1)
    A("2202.02", "应付账款-本地供应商", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-利得税", "2221", -1)
    A("4001.01", "实收资本-港币", "4001", -1, monetary=False)
    A("4001.02", "实收资本-美元", "4001", -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-美元航线", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-本地及人民币", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-港口费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.02", "管理费用-办公租金", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "HKD", 3500000.00)
    book.set_open("1002.02", "USD", 180000.00)
    book.set_open("1002.03", "CNY", 400000.00)
    book.set_open("1122.01", "USD", 95000.00)
    book.set_open("1122.02", "HKD", 260000.00)
    book.set_open("1405", "HKD", 1200000.00)
    book.set_open("2202.01", "CNY", -450000.00)
    book.set_open("2202.02", "HKD", -180000.00)
    book.set_open("2221.01", "HKD", -120000.00)
    book.set_open("4001.01", "HKD", -5000000.00)
    book.set_open("4104", "HKD", r2(-sum(v[1] for v in book._bal.values())))

    # 1月美元资本投入（外币投入资本：货币资金与实收资本同汇率，不产生折算差额）
    book.post(book.day(1, 8), "记", "收到美元资本投入", [
        ("1002.02", "USD", 100000.00, 0.0),
        ("4001.02", "USD", 0.0, 100000.00),
    ])

    pending_ar = {"1122.01": [("USD", 95000.00, None, 0)]}
    pending_ap = {"2202.01": [("CNY", 450000.00, None, 0)],
                  "2202.02": [("HKD", 180000.00, None, 0)]}
    bank_of = {"HKD": "1002.01", "USD": "1002.02", "CNY": "1002.03"}

    sell_plan = {2: (60000.00, 7.8120), 4: (60000.00, 7.8180), 6: (70000.00, 7.8250)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 美元航线收入（次月收）与本地收入（当月收）
        book.invoice(d(5), "记", "美国航线货运代理收入开票", "1122.01", "6001.01", "USD", 52000.00)
        pending_ar["1122.01"].append(("USD", 52000.00, None, m))
        book.invoice(d(6), "记", "本地仓储服务收入开票", "1122.02", "6001.02", "HKD", 180000.00)
        book.post(d(19), "收", "收本地客户服务费", [
            ("1002.01", "HKD", 180000.00, 0.0),
            ("1122.02", "HKD", 0.0, 180000.00),
        ])

        # 收美元货款（上月及期初整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美国客户运费", "1122.01", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]

        # 采购：内地供应商（人民币，次月付）与本地供应商（港币，次月付）
        cny_buy = 280000.00
        buy_hkd = r2(cny_buy * book.book_rate("CNY", d(7)))
        book.post(d(7), "记", "内地供应商采购仓储耗材", [
            ("1405", "HKD", buy_hkd, 0.0),
            ("2202.01", "CNY", 0.0, cny_buy),
        ])
        pending_ap["2202.01"].append(("CNY", cny_buy, None, m))
        book.post(d(8), "记", "本地港口服务采购", [
            ("6601.01", "HKD", 85000.00, 0.0),
            ("2202.02", "HKD", 0.0, 85000.00),
        ])
        pending_ap["2202.02"].append(("HKD", 85000.00, None, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.01", "2202.02"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s供应商款项" % ("内地" if ccy == "CNY" else "本地"),
                            ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 人民币直接收付业务（内地客户与分包商，无挂账）
        book.post(d(11), "收", "内地客户人民币仓储费收入", [
            ("1002.03", "CNY", 60000.00, 0.0),
            ("6001.02", "CNY", 0.0, 60000.00),
        ])
        book.post(d(12), "付", "支付内地物流分包费", [
            ("6401", "CNY", 42000.00, 0.0),
            ("1002.03", "CNY", 0.0, 42000.00),
        ])
        book.post(d(27), "付", "港币账户管理费", [
            ("6603.01", "HKD", 350.00, 0.0),
            ("1002.01", "HKD", 0.0, 350.00),
        ])

        # 工资、租金、手续费
        book.post(d(20), "记", "计提本月工资强积金", [
            ("6602.01", "HKD", 210000.00, 0.0),
            ("2211", "HKD", 0.0, 210000.00),
        ])
        book.post(d(25), "付", "发放上月工资强积金", [
            ("2211", "HKD", 210000.00, 0.0),
            ("1002.01", "HKD", 0.0, 210000.00),
        ])
        book.post(d(23), "付", "支付办公租金", [
            ("6602.02", "HKD", 68000.00, 0.0),
            ("1002.01", "HKD", 0.0, 68000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 220.00, 0.0),
            ("1002.02", "USD", 0.0, 220.00),
        ])

        # 季度利得税预提（3/6月）
        if m in (3, 6):
            book.post(d(30), "记", "预提本季度利得税", [
                ("2221.01", "HKD", 0.0, 88000.00),
                (PROFIT, "HKD", 88000.00, 0.0),
            ])

        # 美元结汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇兑港币", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)

        # 成本、月末
        book.post(d(28), "记", "结转本月销售成本", [
            ("6401", "HKD", 240000.00, 0.0),
            ("1405", "HKD", 0.0, 240000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.kcloud(book, OUT_DIR, "金蝶云星空")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
