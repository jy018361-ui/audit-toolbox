# -*- coding: utf-8 -*-
"""
汇率损益测试集2 之 01 用友U8版式：晟微电子（苏州）有限公司（干净账）。

- 本位币 CNY；外币 USD / EUR；期间 2026-01-01 至 2026-06-30。
- 干净账：外币货币性项目每月末按月末牌价全额重估、已实现汇兑损益完整入账，
  预期审计工具测算差异为 0。
- 生成: python generate.py （重新生成两份 xlsx 并跑全部自检，任一失败退出码非 0）
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))

from core import Book, RATES_CNY, r2, run_all          # noqa: E402
import renderers                                       # noqa: E402

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ENTITY = "晟微电子（苏州）有限公司"
CCY_NAME = {"CNY": "人民币", "USD": "美元", "EUR": "欧元"}

FX_PL = "6603.02"
PROFIT = "4103"
PL = ["6001.01", "6001.02", "6001.03", "6401", "6601.01",
      "6602.01", "6602.02", "6602.03", "6603.01", "6603.02", "6603.03"]


def build():
    book = Book(ENTITY, "CNY", {c: RATES_CNY[c] for c in ("USD", "EUR")})

    A = book.add
    A("1002.01", "银行存款-工行人民币户", "1002", 1)
    A("1002.02", "银行存款-中行美元户", "1002", 1)
    A("1002.03", "银行存款-中行欧元户", "1002", 1)
    A("1122.01", "应收账款-国内客户", "1122", 1)
    A("1122.02", "应收账款-美元客户", "1122", 1)
    A("1122.03", "应收账款-欧元客户", "1122", 1)
    A("1123.01", "其他应收款-应收出口退税", "1123", 1)
    A("1403", "原材料", None, 1, monetary=False)
    A("1405", "库存商品", None, 1, monetary=False)
    A("1601", "固定资产", None, 1, monetary=False)
    A("1602", "累计折旧", None, -1, monetary=False)
    A("2202.01", "应付账款-国内供应商", "2202", -1)
    A("2202.02", "应付账款-美元供应商", "2202", -1)
    A("2202.03", "应付账款-欧元供应商", "2202", -1)
    A("2211", "应付职工薪酬", None, -1)
    A("2221.01", "应交税费-销项税额", "2221", -1)
    A("2221.02", "应交税费-进项税额", "2221", 1)
    A("2221.03", "应交税费-未交增值税", "2221", -1)
    A("2501", "长期借款-股东借款(美元)", None, -1)
    A("4001", "实收资本", None, -1, monetary=False)
    A(PROFIT, "本年利润", None, -1, monetary=False)
    A("4104", "利润分配-未分配利润", None, -1, monetary=False)
    A("6001.01", "主营业务收入-出口(美元)", "6001", -1, monetary=False)
    A("6001.02", "主营业务收入-出口(欧元)", "6001", -1, monetary=False)
    A("6001.03", "主营业务收入-国内销售", "6001", -1, monetary=False)
    A("6401", "主营业务成本", None, 1, monetary=False)
    A("6601.01", "销售费用-运输费", "6601", 1, monetary=False)
    A("6602.01", "管理费用-办公水电费", "6602", 1, monetary=False)
    A("6602.02", "管理费用-职工薪酬", "6602", 1, monetary=False)
    A("6602.03", "管理费用-折旧费", "6602", 1, monetary=False)
    A("6603.01", "财务费用-利息支出", "6603", 1, monetary=False)
    A(FX_PL, "财务费用-汇兑损益", "6603", 1, monetary=False)
    A("6603.03", "财务费用-手续费(美元户)", "6603", 1, monetary=False)

    # 期初（2026-01-01，余额带符号借正贷负；未分配利润为轧平项）
    book.set_open("1002.01", "CNY", 3500000.00)
    book.set_open("1002.02", "USD", 200000.00)
    book.set_open("1002.03", "EUR", 150000.00)
    book.set_open("1122.01", "CNY", 860000.00)
    book.set_open("1122.02", "USD", 320000.00)
    book.set_open("1122.03", "EUR", 100000.00)
    book.set_open("1123.01", "CNY", 195000.00)
    book.set_open("1403", "CNY", 2800000.00)
    book.set_open("1405", "CNY", 1600000.00)
    book.set_open("1601", "CNY", 6500000.00)
    book.set_open("1602", "CNY", -1300000.00)
    book.set_open("2202.01", "CNY", -750000.00)
    book.set_open("2202.02", "USD", -180000.00)
    book.set_open("2221.03", "CNY", -13000.00)
    book.set_open("4001", "CNY", -8000000.00)
    # 未分配利润 = 轧平项（按本位币期初余额轧平，原币与本位币两口径同时平）
    plug = r2(-sum(v[1] for v in book._bal.values()))
    book.set_open("4104", "CNY", plug)

    # 应收/应付台账：(ccy, amount, inv_rate, inv_month)；期初项 inv_month=0，次月整票结清
    pending_ar = {
        "1122.02": [("USD", 320000.00, book.opening_rate("USD"), 0)],
        "1122.03": [("EUR", 100000.00, book.opening_rate("EUR"), 0)],
        "1122.01": [("CNY", 860000.00, 1.0, 0)],
    }
    pending_ap = {
        "2202.02": [("USD", 180000.00, book.opening_rate("USD"), 0)],
        "2202.01": [("CNY", 750000.00, 1.0, 0)],
        "2202.03": [],
    }
    bank_of = {"CNY": "1002.01", "USD": "1002.02", "EUR": "1002.03"}

    # 一次性：美元股东借款 / 出口退税 / 欧元设备进口（次月付清）
    loan_rate = book.book_rate("USD", book.day(1, 3))
    book.loan_receive(book.day(1, 3), "收", "收到股东美元借款", "2501", "1002.02", "USD", 500000.00)
    book.post(book.day(1, 6), "收", "收到出口退税", [
        ("1002.01", "CNY", 195000.00, 0.0),
        ("1123.01", "CNY", 0.0, 195000.00),
    ])
    eq_rate = book.book_rate("EUR", book.day(2, 10))
    book.post(book.day(2, 10), "转", "进口五轴加工中心(欧元)", [
        ("1601", "EUR", 200000.00, 0.0),
        ("2202.03", "EUR", 0.0, 200000.00),
    ])
    pending_ap["2202.03"].append(("EUR", 200000.00, eq_rate, 2))

    sell_plan = {2: (60000.00, 7.1210), 4: (60000.00, 7.1340), 6: (60000.00, 7.1710)}

    for m in range(1, 7):
        def d(day, m=m):
            return book.day(m, day)

        # ── 出口/国内开票 ──
        book.invoice(d(5), "转", "美元出口销售开票-北美客户A", "1122.02", "6001.01", "USD", 80000.00)
        book.invoice(d(5), "转", "美元出口销售开票-北美客户B", "1122.02", "6001.01", "USD", 45000.00)
        book.invoice(d(6), "转", "欧元出口销售开票-德国客户", "1122.03", "6001.02", "EUR", 40000.00)
        pending_ar["1122.02"] += [
            ("USD", 80000.00, book.book_rate("USD", d(5)), m),
            ("USD", 45000.00, book.book_rate("USD", d(5)), m),
        ]
        pending_ar["1122.03"].append(("EUR", 40000.00, book.book_rate("EUR", d(6)), m))
        book.post(d(8), "转", "国内销售开票(含13%销项税)", [
            ("1122.01", "CNY", 339000.00, 0.0),
            ("6001.03", "CNY", 0.0, 300000.00),
            ("2221.01", "CNY", 0.0, 39000.00),
        ])
        pending_ar["1122.01"].append(("CNY", 339000.00, 1.0, m))

        # ── 收款：上月及期初应收整票收回 ──
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.02"] if x[3] < m]:
            book.collect_ar(d(10), "收", "收美元出口货款", "1122.02", "1002.02", "USD", amt, FX_PL)
        pending_ar["1122.02"] = [x for x in pending_ar["1122.02"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.03"] if x[3] < m]:
            book.collect_ar(d(12), "收", "收欧元出口货款", "1122.03", "1002.03", "EUR", amt, FX_PL)
        pending_ar["1122.03"] = [x for x in pending_ar["1122.03"] if x[3] >= m]
        for (ccy, amt, rate, im) in [x for x in pending_ar["1122.01"] if x[3] < m]:
            book.post(d(15), "收", "收国内货款", [
                ("1002.01", "CNY", amt, 0.0),
                ("1122.01", "CNY", 0.0, amt),
            ])
        pending_ar["1122.01"] = [x for x in pending_ar["1122.01"] if x[3] >= m]

        # ── 采购 ──
        usd_mat = 60000.00
        mat_cny = r2(usd_mat * book.book_rate("USD", d(6)))
        book.post(d(6), "转", "进口美元原材料", [
            ("1403", "CNY", mat_cny, 0.0),
            ("2202.02", "USD", 0.0, usd_mat),
        ])
        pending_ap["2202.02"].append(("USD", usd_mat, book.book_rate("USD", d(6)), m))
        book.post(d(7), "转", "国内采购原材料(含13%进项)", [
            ("1403", "CNY", 200000.00, 0.0),
            ("2221.02", "CNY", 26000.00, 0.0),
            ("2202.01", "CNY", 0.0, 226000.00),
        ])
        pending_ap["2202.01"].append(("CNY", 226000.00, 1.0, m))

        # ── 付款：上月及期初应付整票支付 ──
        for ap_key in ("2202.02", "2202.01", "2202.03"):
            for (ccy, amt, rate, im) in [x for x in pending_ap[ap_key] if x[3] < m]:
                book.pay_ap(d(18), "付", "付%s供应商货款" % ccy, ap_key, bank_of[ccy], ccy, amt, FX_PL)
            pending_ap[ap_key] = [x for x in pending_ap[ap_key] if x[3] >= m]

        # ── 工资、折旧、费用 ──
        book.post(d(20), "转", "计提本月工资社保", [
            ("6602.02", "CNY", 250000.00, 0.0),
            ("2211", "CNY", 0.0, 250000.00),
        ])
        book.post(d(25), "付", "发放上月工资", [
            ("2211", "CNY", 250000.00, 0.0),
            ("1002.01", "CNY", 0.0, 250000.00),
        ])
        book.post(d(22), "转", "计提折旧", [
            ("6602.03", "CNY", 40000.00, 0.0),
            ("1602", "CNY", 0.0, 40000.00),
        ])
        book.post(d(24), "付", "支付办公水电费", [
            ("6602.01", "CNY", 60000.00, 0.0),
            ("1002.01", "CNY", 0.0, 60000.00),
        ])
        book.post(d(26), "付", "美元户银行手续费", [
            ("6603.03", "USD", 300.00, 0.0),
            ("1002.02", "USD", 0.0, 300.00),
        ])

        # ── 增值税 ──
        book.post(d(27), "转", "增值税进销结转", [
            ("2221.01", "CNY", 39000.00, 0.0),
            ("2221.02", "CNY", 0.0, 26000.00),
            ("2221.03", "CNY", 0.0, 13000.00),
        ])
        book.post(d(28), "付", "缴纳上月增值税", [
            ("2221.03", "CNY", 13000.00, 0.0),
            ("1002.01", "CNY", 0.0, 13000.00),
        ])

        # ── 结汇 / 利息 / 还本 ──
        if m in sell_plan:
            amt, px = sell_plan[m]
            book.fx_sell(d(21), "付", "美元结汇", "1002.02", "1002.01", "USD", amt, r2(amt * px), FX_PL)
        if m == 3:
            book.post(d(20), "付", "支付美元借款利息", [
                ("6603.01", "USD", 2500.00, 0.0),
                ("1002.02", "USD", 0.0, 2500.00),
            ])
        if m == 6:
            book.loan_repay(d(28), "付", "归还美元股东借款本金", "2501", "1002.02",
                            "USD", 200000.00, FX_PL)

        # ── 成本、月末 ──
        book.post(d(28), "转", "结转本月销售成本", [
            ("6401", "CNY", 1050000.00, 0.0),
            ("1405", "CNY", 0.0, 1050000.00),
        ])
        book.revalue(m, FX_PL, vtype="记")

    return book


def main():
    book = build()
    exp = renderers.u8(book, OUT_DIR, "用友U8", cmap=CCY_NAME)
    run_all(book, exp, FX_PL, PL, PROFIT)


if __name__ == "__main__":
    main()
