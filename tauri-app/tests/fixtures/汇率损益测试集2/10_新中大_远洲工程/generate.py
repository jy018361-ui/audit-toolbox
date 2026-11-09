# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 10 新中大版式：远洲海外工程有限公司（干净账）。

- 本位币 CNY；外币 USD / EUR；期间 2026-01-01 至 2026-06-30。
- 海外工程承包商：美元工程进度款应收（隔月整笔收）、美元项目保证金（其他应收款）、
  欧洲分包商应付（隔月整笔付）、结汇/购汇；TB 为期初/期末借贷分列余额式。
- 干净账：每月末按月末牌价全额重估、已实现汇兑损益完整入账（科目 6603.02）。
- 生成: python generate.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "远洲海外工程有限公司"

FX_PL = "6603.02"
PROFIT = "4103"


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "EUR")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行欧元户", "1002", 1)
    A("1122.01", "应收账款-美元工程进度款", "1122", 1)
    A("1122.02", "应收账款-国内咨询费", "1122", 1)
    A("1221.01", "其他应收款-美元项目保证金", "1221", 1)
    A("1601", "固定资产-施工设备", None, 1, monetary=False)
    A("1602", "累计折旧", None, -1, monetary=False)
    A("1605", "工程施工", None, 1, monetary=False)
    A("2202.01", "应付账款-欧洲分包商(欧元)", "2202", -1)
    A("2202.02", "应付账款-国内劳务分包", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-应交增值税", "2221", -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-海外工程(美元)", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-国内咨询服务", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-差旅费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.02", "管理费用-办公费", "6602", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.01", "财务费用-手续费", "6603", 1, monetary=False)

    book.set_open("1002.01", "CNY", 4100000.00)
    book.set_open("1002.02", "USD", 260000.00)
    book.set_open("1002.03", "EUR", 60000.00)
    book.set_open("1122.01", "USD", 240000.00)
    book.set_open("1122.02", "CNY", 380000.00)
    book.set_open("1221.01", "USD", 150000.00)
    book.set_open("1601", "CNY", 1850000.00)
    book.set_open("1602", "CNY", -400000.00)
    book.set_open("1605", "CNY", 5200000.00)
    book.set_open("2202.01", "EUR", -140000.00)
    book.set_open("2202.02", "CNY", -560000.00)
    book.set_open("2211", "CNY", -210000.00)
    book.set_open("2221.01", "CNY", -35000.00)
    book.set_open("4001", "CNY", -8000000.00)
    book.set_open("4104", "CNY", r2(-sum(v[1] for v in book._bal.values())))

    pending_ar = {"1122.01": [("USD", 240000.00, None, 0)],
                  "1122.02": [("CNY", 380000.00, 1.0, 0)]}
    pending_ap = {"2202.01": [("EUR", 140000.00, None, 0)],
                  "2202.02": [("CNY", 560000.00, 1.0, 0)]}
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "EUR": "1002.03"}

    # 3月收到退还的美元项目保证金 80,000
    book.post(book.day(3, 18), "收", "收到退还项目保证金", [
        ("1002.02", "USD", 80000.00, 0.0),
        ("1221.01", "USD", 0.0, 80000.00),
    ])

    sell_plan = {2: (70000.00, 7.1205), 4: (75000.00, 7.1365), 6: (80000.00, 7.1720)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # 工程进度款开票（隔月整笔收）与国内咨询收入
        book.invoice(d(5), "转", "中东项目部工程进度款开票", "1122.01", "6001.01", "USD", 130000.00)
        pending_ar["1122.01"].append(("USD", 130000.00, None, m))
        book.invoice(d(8), "转", "国内工程咨询服务开票", "1122.02", "6001.02", "CNY", 150000.00)
        pending_ar["1122.02"].append(("CNY", 150000.00, None, m))

        # 收款（上月及期初整票收回）
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元工程进度款", "1122.01", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.post(d(12), "收", "收国内咨询费", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.02", "CNY", 0.0, amt),
            ])
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]

        # 成本：欧洲分包计提（欧元，隔月付）、国内劳务分包计提与支付
        eur_sub = 55000.00
        eur_cny = r2(eur_sub * book.book_rate("EUR", d(6)))
        book.post(d(6), "转", "计提欧洲分包工程款", [
            ("6401", "CNY", eur_cny, 0.0),
            ("2202.01", "EUR", 0.0, eur_sub),
        ])
        pending_ap["2202.01"].append(("EUR", eur_sub, None, m))
        book.post(d(7), "转", "计提国内劳务分包成本", [
            ("6401", "CNY", 185000.00, 0.0),
            ("2202.02", "CNY", 0.0, 185000.00),
        ])
        pending_ap["2202.02"].append(("CNY", 185000.00, 1.0, m))

        # 付款（上月及期初整票支付）
        for ap_key in ("2202.01", "2202.02"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s分包款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # 工程物资采购（挂账次月付）与项目当地费用
        book.post(d(9), "转", "工程物资采购入库", [
            ("1605", "CNY", 95000.00, 0.0),
            ("2202.02", "CNY", 0.0, 95000.00),
        ])
        pending_ap["2202.02"].append(("CNY", 95000.00, 1.0, m))
        book.post(d(13), "付", "支付项目当地采购费用", [
            ("6401", "CNY", 46000.00, 0.0),
            ("1002.01", "CNY", 0.0, 46000.00),
        ])
        book.post(d(15), "转", "计提工程设备摊销", [
            ("6401", "CNY", 58000.00, 0.0),
            ("1605", "CNY", 0.0, 58000.00),
        ])
        book.post(d(16), "转", "计提施工设备折旧", [
            ("6401", "CNY", 28000.00, 0.0),
            ("1602", "CNY", 0.0, 28000.00),
        ])

        # 工资与费用
        book.post(d(20), "转", "计提本月工资社保", [
            ("6602.01", "CNY", 210000.00, 0.0),
            ("2211", "CNY", 0.0, 210000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 210000.00, 0.0),
            ("1002.01", "CNY", 0.0, 210000.00),
        ])
        book.post(d(24), "付", "支付项目差旅及办公费", [
            ("6601.01", "CNY", 52000.00, 0.0),
            ("6602.02", "CNY", 26000.00, 0.0),
            ("1002.01", "CNY", 0.0, 78000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.01", "USD", 300.00, 0.0),
            ("1002.02", "USD", 0.0, 300.00),
        ])
        book.post(d(27), "付", "缴纳增值税及附加", [
            ("2221.01", "CNY", 35000.00 / 6, 0.0),
            ("1002.01", "CNY", 0.0, 35000.00 / 6),
        ])

        # 结汇 / 购汇
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)
        if m == 3:
            book.fx_buy(d(14), "付", "购汇支付欧元分包头寸", "1002.03", "1002.01", "EUR", 20000.00)

        # 月末
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.xzd(book, OUT_DIR, "新中大")
    run_all(book, exp, FX_PL, [], PROFIT)


if __name__ == "__main__":
    main()
